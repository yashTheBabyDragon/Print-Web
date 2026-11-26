"""Comprehensive RBAC permission matrix and teacher/tech class-management tests."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import database, main
from app.config import settings
from app.permissions import ADMIN_ONLY_PERMISSION_KEYS, Permission, get_permissions_for_role
from app.services import fdm_monster


@pytest.fixture()
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Isolated TestClient backed by a fresh temp SQLite DB and data dir."""
    test_data_dir = tmp_path / "data"
    test_db_path = test_data_dir / "test_permissions.db"

    monkeypatch.setattr(settings, "data_dir", test_data_dir)
    monkeypatch.setattr(settings, "database_url", f"sqlite:///{test_db_path.as_posix()}")
    monkeypatch.setattr(settings, "dev_seed", True)
    monkeypatch.setattr(settings, "slicer_mode_override", "mock")

    test_engine = database._build_engine(settings.effective_database_url)
    test_session_local = database.sessionmaker(autocommit=False, autoflush=False, bind=test_engine)

    monkeypatch.setattr(database, "engine", test_engine)
    monkeypatch.setattr(database, "SessionLocal", test_session_local)
    monkeypatch.setattr(main, "SessionLocal", test_session_local)

    fdm_monster._MOCK_JOBS.clear()

    with TestClient(main.app) as tc:
        yield tc

    test_engine.dispose()


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _login(client: TestClient, identifier: str, password: str) -> dict:
    resp = client.post("/api/auth/login", json={"identifier": identifier, "password": password})
    assert resp.status_code == 200, resp.text
    return resp.json()


def test_auth_me_and_login_return_role_permissions(client: TestClient):
    student_login = _login(client, "2345678", "student123")
    teacher_login = _login(client, "m.tremblay@example.edu", "teacher123")
    admin_login = _login(client, "admin", "admin123")

    assert student_login["user"]["permissions"] == [Permission.SLICER_USE.value]
    assert student_login["user"]["hierarchy_rank"] == 0
    assert teacher_login["user"]["hierarchy_rank"] == 50
    assert set(teacher_login["user"]["permissions"]) == set(get_permissions_for_role("teacher"))
    assert admin_login["user"]["hierarchy_rank"] == 100
    assert set(admin_login["user"]["permissions"]) == {p.value for p in Permission}

    # Verify /api/auth/me returns identical permission lists
    for login_data in (student_login, teacher_login, admin_login):
        me = client.get("/api/auth/me", headers=_auth(login_data["access_token"]))
        assert me.status_code == 200
        assert me.json()["permissions"] == get_permissions_for_role(login_data["user"]["role"])


def test_rbac_matrix_admin_only_endpoints_blocked_for_teacher_and_student(client: TestClient):
    s_token = _login(client, "2345678", "student123")["access_token"]
    t_token = _login(client, "m.tremblay@example.edu", "teacher123")["access_token"]
    a_token = _login(client, "admin", "admin123")["access_token"]

    # Public /api/printers still works for student, teacher, and admin
    for tok in (s_token, t_token, a_token):
        assert client.get("/api/printers", headers=_auth(tok)).status_code == 200

    # Admin can read all admin resources
    printers = client.get("/api/admin/printers", headers=_auth(a_token))
    assert printers.status_code == 200
    printer_id = printers.json()[0]["id"]
    slot_id = printers.json()[0]["slots"][0]["id"]

    filaments = client.get("/api/admin/filaments", headers=_auth(a_token))
    assert filaments.status_code == 200
    filament_id = filaments.json()[0]["id"]

    profiles = client.get("/api/admin/profiles", headers=_auth(a_token))
    assert profiles.status_code == 200
    profile_id = profiles.json()[0]["id"]

    assert client.get("/api/admin/teachers", headers=_auth(a_token)).status_code == 200
    assert client.get("/api/admin/accounts", headers=_auth(a_token)).status_code == 200
    assert client.get("/api/admin/settings", headers=_auth(a_token)).status_code == 200
    assert client.get("/api/admin/filament-api/printers", headers=_auth(a_token)).status_code == 200

    permission_calls = [
        # Printers
        ("GET", "/api/admin/printers", None, Permission.PRINTERS_VIEW.value),
        ("POST", "/api/admin/printers/sync", None, Permission.PRINTERS_CREATE_DELETE.value),
        ("PATCH", f"/api/admin/printers/{printer_id}", {"display_name": "Hack"}, Permission.PRINTERS_EDIT.value),
        ("DELETE", f"/api/admin/printers/{printer_id}", None, Permission.PRINTERS_CREATE_DELETE.value),
        ("PUT", f"/api/admin/printers/{printer_id}/slots/1", {"filament_id": filament_id, "is_loaded": True}, Permission.PRINTERS_MANAGE_SLOTS.value),
        ("GET", "/api/admin/filament-api/printers", None, Permission.PRINTERS_VIEW.value),
        ("POST", "/api/admin/printers/sync-filaments", None, Permission.PRINTERS_MANAGE_SLOTS.value),
        # Filaments
        ("GET", "/api/admin/filaments", None, Permission.FILAMENTS_VIEW.value),
        ("POST", "/api/admin/filaments", {"name": "New PLA", "material": "PLA"}, Permission.FILAMENTS_CREATE_DELETE.value),
        ("PATCH", f"/api/admin/filaments/{filament_id}", {"name": "Edited"}, Permission.FILAMENTS_EDIT.value),
        ("DELETE", f"/api/admin/filaments/{filament_id}", None, Permission.FILAMENTS_CREATE_DELETE.value),
        # Profiles
        ("GET", "/api/admin/profiles", None, Permission.PROFILES_VIEW.value),
        ("DELETE", f"/api/admin/profiles/{profile_id}", None, Permission.PROFILES_MANAGE.value),
        ("POST", "/api/admin/profiles/test-slice", {"printer_id": printer_id, "slot_id": slot_id}, Permission.PRINTERS_EDIT.value),
        # Staff Accounts
        ("GET", "/api/admin/teachers", None, Permission.ACCOUNTS_VIEW.value),
        ("POST", "/api/admin/teachers", {"identifier": "new.t@example.edu", "name": "New T", "password": "secret"}, Permission.ACCOUNTS_CREATE_TECH.value),
    ]

    for tok in (t_token, s_token):
        for method, path, payload, expected_perm in permission_calls:
            resp = client.request(method, path, headers=_auth(tok), json=payload)
            assert resp.status_code == 403, f"{method} {path} returned {resp.status_code}: {resp.text}"
            detail = resp.json()["detail"]
            assert detail["code"] == "FORBIDDEN"
            assert detail["required_permission"] == expected_perm

    # Strict Super Admin endpoints return SUPER_ADMIN_REQUIRED
    for tok in (t_token, s_token):
        for method, path, payload in (
            ("GET", "/api/admin/settings", None),
            ("PATCH", "/api/admin/settings", {"default_max_active_grams": 250.0}),
            ("POST", "/api/admin/filament-api/test", {"url": "http://localhost:8000"}),
            ("GET", "/api/admin/system/update-status", None),
            ("POST", "/api/admin/system/update-trigger", {"target_version": "v1.1.0"}),
        ):
            resp = client.request(method, path, headers=_auth(tok), json=payload)
            assert resp.status_code == 403
            assert resp.json()["detail"]["code"] == "SUPER_ADMIN_REQUIRED"

    # Student also cannot access teacher/admin class, student, or approval routes
    for path, expected_perm in (
        ("/api/admin/classes", Permission.CLASSES_MANAGE_OWN),
        ("/api/admin/students", Permission.STUDENTS_MANAGE_OWN),
        ("/api/admin/account-requests", Permission.APPROVALS_ACCOUNTS_OWN),
        ("/api/admin/approvals", Permission.APPROVALS_JOBS_OWN),
    ):
        resp = client.get(path, headers=_auth(s_token))
        assert resp.status_code == 403
        assert resp.json()["detail"]["required_permission"] == expected_perm.value


def test_teacher_ownership_isolation(client: TestClient):
    t1_token = _login(client, "m.tremblay@example.edu", "teacher123")["access_token"]
    t2_token = _login(client, "s.gagnon@example.edu", "teacher123")["access_token"]

    t1_classes = client.get("/api/admin/classes", headers=_auth(t1_token)).json()
    t2_classes = client.get("/api/admin/classes", headers=_auth(t2_token)).json()
    assert len(t1_classes) >= 1
    assert len(t2_classes) >= 1
    t1_class_id = t1_classes[0]["id"]
    t2_class_id = t2_classes[0]["id"]

    # Teacher 1 cannot see Teacher 2's classes
    assert all(c["id"] != t2_class_id for c in t1_classes)

    # Teacher 1 cannot PATCH, DELETE, add, bulk-add, or transfer into Teacher 2's class
    assert client.patch(
        f"/api/admin/classes/{t2_class_id}",
        headers=_auth(t1_token),
        json={"name": "Hijacked"},
    ).status_code == 403

    assert client.delete(
        f"/api/admin/classes/{t2_class_id}",
        headers=_auth(t1_token),
    ).status_code == 403

    assert client.post(
        f"/api/admin/classes/{t2_class_id}/students",
        headers=_auth(t1_token),
        json={"da": "2499999", "suggested_name": "Nope"},
    ).status_code == 403

    assert client.post(
        f"/api/admin/classes/{t2_class_id}/students/bulk",
        headers=_auth(t1_token),
        json={"raw_text": "2499999, Nope"},
    ).status_code == 403

    assert client.post(
        f"/api/admin/classes/{t1_class_id}/transfer",
        headers=_auth(t1_token),
        json={"da": "2345678", "target_class_id": t2_class_id},
    ).status_code == 403


def test_teacher_class_crud_bulk_import_budget_and_transfer(client: TestClient):
    t_token = _login(client, "m.tremblay@example.edu", "teacher123")["access_token"]

    # 1. Create a class with default budget and description
    r_create = client.post(
        "/api/admin/classes",
        headers=_auth(t_token),
        json={
            "name": "3DP-300 — Prototypage",
            "code": "3DP-300",
            "description": "Laboratoire de prototypage rapide",
            "default_max_active_grams": 150.0,
            "default_max_print_minutes": 480,
        },
    )
    assert r_create.status_code == 201, r_create.text
    cls1 = r_create.json()
    assert cls1["name"] == "3DP-300 — Prototypage"
    assert cls1["description"] == "Laboratoire de prototypage rapide"
    assert cls1["default_max_active_grams"] == 150.0
    assert cls1["default_max_print_minutes"] == 480
    assert cls1["enrolled_count"] == 0
    assert cls1["registered_count"] == 0
    assert cls1["unclaimed_count"] == 0

    # Create a second class for transfer testing
    cls2 = client.post(
        "/api/admin/classes",
        headers=_auth(t_token),
        json={"name": "3DP-301 — Projet Synthèse", "code": "3DP-301"},
    ).json()

    # 2. Bulk-add students (with header, valid formats, duplicate, and invalid line)
    r_bulk = client.post(
        f"/api/admin/classes/{cls1['id']}/students/bulk",
        headers=_auth(t_token),
        json={
            "raw_text": (
                "da,name\n"
                "2345678, Étudiant Démo\n"
                "2410001, Alice Martin\n"
                "2410002; Bob Gagnon\n"
                "2410003 Charlie Tremblay\n"
                "2410001, Duplicate Alice\n"
                "not-a-da, Invalid Row\n"
            )
        },
    )
    assert r_bulk.status_code == 200, r_bulk.text
    bulk_res = r_bulk.json()
    assert bulk_res["added"] == 4
    assert bulk_res["skipped"] == 1
    assert bulk_res["invalid"] == 1
    assert bulk_res["invalid_lines"] == ["not-a-da, Invalid Row"]

    # 3. Verify GET /api/admin/classes returns enriched counts & enrollment student metadata
    classes = client.get("/api/admin/classes", headers=_auth(t_token)).json()
    loaded_cls1 = next(c for c in classes if c["id"] == cls1["id"])
    assert loaded_cls1["enrolled_count"] == 4
    assert loaded_cls1["registered_count"] == 1
    assert loaded_cls1["unclaimed_count"] == 3
    demo_enr = next(e for e in loaded_cls1["enrollments"] if e["da"] == "2345678")
    assert demo_enr["is_registered"] is True
    assert demo_enr["user_id"] is not None
    assert demo_enr["registered_name"] == "Étudiant Démo"
    alice_enr = next(e for e in loaded_cls1["enrollments"] if e["da"] == "2410001")
    assert alice_enr["max_active_grams_override"] == 150.0
    assert alice_enr["max_print_minutes_override"] == 480

    # 4. PATCH class: rename + update default budget + apply_budget_to_students=True
    r_patch = client.patch(
        f"/api/admin/classes/{cls1['id']}",
        headers=_auth(t_token),
        json={
            "name": "3DP-300 — Prototypage Avancé",
            "default_max_active_grams": 220.0,
            "default_max_print_minutes": 600,
            "apply_budget_to_students": True,
        },
    )
    assert r_patch.status_code == 200, r_patch.text
    patched = r_patch.json()
    assert patched["name"] == "3DP-300 — Prototypage Avancé"
    assert patched["default_max_active_grams"] == 220.0
    patched_demo = next(e for e in patched["enrollments"] if e["da"] == "2345678")
    assert patched_demo["effective_max_active_grams"] == 220.0
    assert patched_demo["effective_max_print_minutes"] == 600

    # 5. Transfer student from cls1 -> cls2
    r_transfer = client.post(
        f"/api/admin/classes/{cls1['id']}/transfer",
        headers=_auth(t_token),
        json={"da": "2410001", "target_class_id": cls2["id"], "remove_from_source": True},
    )
    assert r_transfer.status_code == 200, r_transfer.text
    assert r_transfer.json() == {
        "da": "2410001",
        "source_class_id": cls1["id"],
        "target_class_id": cls2["id"],
        "moved": True,
        "already_in_target": False,
    }

    classes_after = client.get("/api/admin/classes", headers=_auth(t_token)).json()
    c1_after = next(c for c in classes_after if c["id"] == cls1["id"])
    c2_after = next(c for c in classes_after if c["id"] == cls2["id"])
    assert all(e["da"] != "2410001" for e in c1_after["enrollments"])
    assert any(e["da"] == "2410001" for e in c2_after["enrollments"])

    # 6. Delete both test classes cleanly
    assert client.delete(f"/api/admin/classes/{cls1['id']}", headers=_auth(t_token)).status_code == 200
    assert client.delete(f"/api/admin/classes/{cls2['id']}", headers=_auth(t_token)).status_code == 200


def test_permission_catalog_presets_manual_overrides_and_reset(client: TestClient):
    a_token = _login(client, "admin", "admin123")["access_token"]
    t_login = _login(client, "m.tremblay@example.edu", "teacher123")
    t_token = t_login["access_token"]
    teacher_id = t_login["user"]["id"]

    # 1. Catalog endpoint: 200 for admin, 403 for standard teacher
    r_cat_teacher = client.get("/api/admin/permissions/catalog", headers=_auth(t_token))
    assert r_cat_teacher.status_code == 403

    r_cat = client.get("/api/admin/permissions/catalog", headers=_auth(a_token))
    assert r_cat.status_code == 200, r_cat.text
    catalog = r_cat.json()
    perm_keys = {item["key"] for item in catalog["permissions"]}
    assert perm_keys == {p.value for p in Permission}
    assert set(catalog["admin_only_permissions"]) == set(ADMIN_ONLY_PERMISSION_KEYS)
    preset_ids = {p["id"] for p in catalog["presets"]}
    assert {"teacher_default", "lab_tech", "printer_operator", "coordinator", "slicer_only"}.issubset(preset_ids)
    assert "full_admin" not in preset_ids
    assert catalog["role_defaults"]["student"] == ["slicer:use"]
    assert set(catalog["role_defaults"]["teacher"]) == set(get_permissions_for_role("teacher"))
    assert set(catalog["role_defaults"]["tech"]) == set(get_permissions_for_role("tech"))

    # 2. Apply 'printer_operator' preset -> grants printers:view/slots, filaments:edit, approvals:jobs_all; revokes classes
    r_preset = client.patch(
        f"/api/admin/teachers/{teacher_id}",
        headers=_auth(a_token),
        json={"preset": "printer_operator"},
    )
    assert r_preset.status_code == 200, r_preset.text
    updated_t = r_preset.json()
    assert updated_t["has_custom_permissions"] is True
    assert "printers:manage_slots" in updated_t["permissions"]
    assert "filaments:edit" in updated_t["permissions"]
    assert "classes:manage_own" not in updated_t["permissions"]

    assert client.get("/api/admin/printers", headers=_auth(t_token)).status_code == 200
    assert client.get("/api/admin/filaments", headers=_auth(t_token)).status_code == 200
    assert client.get("/api/admin/approvals", headers=_auth(t_token)).status_code == 200
    assert client.get("/api/admin/classes", headers=_auth(t_token)).status_code == 403
    assert client.get("/api/admin/students", headers=_auth(t_token)).status_code == 403
    assert client.get("/api/admin/settings", headers=_auth(t_token)).status_code == 403

    # /api/auth/me reflects custom permissions immediately
    me_custom = client.get("/api/auth/me", headers=_auth(t_token)).json()
    assert set(me_custom["permissions"]) == set(updated_t["permissions"])

    # 3. Manual toggle: only students:manage_own -> upload blocked (lacks slicer:use)
    r_manual = client.patch(
        f"/api/admin/teachers/{teacher_id}",
        headers=_auth(a_token),
        json={"permissions": ["students:manage_own"]},
    )
    assert r_manual.status_code == 200, r_manual.text
    assert r_manual.json()["permissions"] == ["students:manage_own"]
    assert client.get("/api/admin/students", headers=_auth(t_token)).status_code == 200
    assert client.get("/api/admin/classes", headers=_auth(t_token)).status_code == 403
    assert client.get("/api/admin/printers", headers=_auth(t_token)).status_code == 403
    printers = client.get("/api/printers", headers=_auth(t_token)).json()
    r_upload_blocked = client.post(
        "/api/jobs/upload",
        headers=_auth(t_token),
        files={"file": ("box.stl", b"solid x\nendsolid x\n", "model/stl")},
        data={"printer_id": str(printers[0]["id"]), "slot_id": str(printers[0]["slots"][0]["id"])},
    )
    assert r_upload_blocked.status_code == 403
    assert r_upload_blocked.json()["detail"]["required_permission"] == "slicer:use"

    # 4. Assigning Admin-only permission returns 403 ADMIN_ONLY_PERMISSION; invalid key/preset -> 400
    r_admin_only = client.patch(
        f"/api/admin/teachers/{teacher_id}",
        headers=_auth(a_token),
        json={"permissions": ["settings:manage"]},
    )
    assert r_admin_only.status_code == 403
    assert r_admin_only.json()["detail"]["code"] == "ADMIN_ONLY_PERMISSION"

    r_bad_perm = client.patch(
        f"/api/admin/teachers/{teacher_id}",
        headers=_auth(a_token),
        json={"permissions": ["nonexistent:perm"]},
    )
    assert r_bad_perm.status_code == 400
    assert r_bad_perm.json()["detail"]["code"] == "INVALID_PERMISSION"

    r_bad_preset = client.patch(
        f"/api/admin/teachers/{teacher_id}",
        headers=_auth(a_token),
        json={"preset": "not_a_preset"},
    )
    assert r_bad_preset.status_code == 400
    assert r_bad_preset.json()["detail"]["code"] == "INVALID_PRESET"

    # 5. Reset permissions -> restores role defaults
    r_reset = client.patch(
        f"/api/admin/teachers/{teacher_id}",
        headers=_auth(a_token),
        json={"reset_permissions": True},
    )
    assert r_reset.status_code == 200, r_reset.text
    assert r_reset.json()["has_custom_permissions"] is False
    assert set(r_reset.json()["permissions"]) == set(get_permissions_for_role(r_reset.json()["role"]))
