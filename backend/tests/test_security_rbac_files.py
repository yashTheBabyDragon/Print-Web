"""Security regression tests for RBAC escalation, job access control, uploads, ZIP bombs, path containment, and orca_cli_path."""

from __future__ import annotations

import io
import json
import zipfile
from pathlib import Path

import pytest
import trimesh
from fastapi.testclient import TestClient

from app import database, main
from app.config import settings
from app.models import (
    ClassEnrollment,
    DAWhitelist,
    JobStatus,
    OrcaProfile,
    PrintJob,
    Printer,
    TeacherClass,
    User,
)
from app.permissions import Permission
from app.routers import admin as admin_router
from app.services import fdm_monster
from app.services.drafts import delete_job_with_files
from app.services.profiles import (
    delete_profile_file,
    extract_orca_filament_entries,
    save_profile_file,
)
from app.services.prusaslicer import extract_prusaslicer_ini_entries
from app.services.slicer import OrcaSlicerCliAdapter, SlicerError, validate_orca_cli_path


@pytest.fixture()
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Isolated TestClient backed by a fresh temp SQLite DB and data dir."""
    test_data_dir = tmp_path / "data"
    test_db_path = test_data_dir / "test_security_rbac_files.db"

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


def _make_stl_bytes(extents=(20.0, 20.0, 20.0)) -> bytes:
    mesh = trimesh.creation.box(extents=list(extents))
    buf = io.BytesIO()
    mesh.export(buf, file_type="stl")
    return buf.getvalue()


def _upload_and_slice_job(client: TestClient, token: str, filename: str = "cube.stl") -> dict:
    printers = client.get("/api/printers", headers=_auth(token)).json()
    printer_id = printers[0]["id"]
    slot_id = printers[0]["slots"][0]["id"]

    up = client.post(
        "/api/jobs/upload",
        headers=_auth(token),
        files={"file": (filename, _make_stl_bytes(), "model/stl")},
        data={"printer_id": str(printer_id), "slot_id": str(slot_id)},
    )
    assert up.status_code == 201, up.text
    job = up.json()

    sl = client.post(
        f"/api/jobs/{job['id']}/slice?sync=true",
        headers=_auth(token),
        json={"printer_id": printer_id, "slot_id": slot_id},
    )
    assert sl.status_code == 200, sl.text
    return sl.json()


# ---------------------------------------------------------------------------
# 1. RBAC Delegation Ceiling, Privilege Escalation & Password Reset Revocation
# ---------------------------------------------------------------------------


def test_teacher_delegation_ceiling_and_self_escalation_blocked(client: TestClient):
    a_tok = _login(client, "admin", "admin123")["access_token"]

    # Admin creates a delegated teacher with account management permissions + slicer:use at rank 60
    r_del = client.post(
        "/api/admin/teachers",
        headers=_auth(a_tok),
        json={
            "identifier": "delegated@example.edu",
            "name": "Delegated Teacher",
            "password": "password123",
            "role": "teacher",
            "hierarchy_rank": 60,
            "permissions": [
                Permission.ACCOUNTS_VIEW.value,
                Permission.ACCOUNTS_CREATE_TECH.value,
                Permission.ACCOUNTS_CREATE_TEACHER.value,
                Permission.ACCOUNTS_EDIT_PERMISSIONS.value,
                Permission.ACCOUNTS_MANAGE_STATUS.value,
                Permission.ACCOUNTS_DELETE.value,
                Permission.SLICER_USE.value,
            ],
        },
    )
    assert r_del.status_code == 201, r_del.text
    delegated_id = r_del.json()["id"]

    # Admin creates a higher-privileged teacher (printers:create_delete, rank 75)
    r_hi = client.post(
        "/api/admin/teachers",
        headers=_auth(a_tok),
        json={
            "identifier": "highpriv@example.edu",
            "name": "High Priv Teacher",
            "password": "password123",
            "role": "teacher",
            "hierarchy_rank": 75,
            "permissions": [Permission.PRINTERS_CREATE_DELETE.value, Permission.SLICER_USE.value],
        },
    )
    assert r_hi.status_code == 201, r_hi.text
    high_id = r_hi.json()["id"]

    d_tok = _login(client, "delegated@example.edu", "password123")["access_token"]

    # 1) Cannot create a staff account with permissions caller does not hold (admin-only OR unheld printer perm)
    for perm_key in (Permission.SETTINGS_MANAGE.value, Permission.PRINTERS_EDIT.value):
        r_esc_create = client.post(
            "/api/admin/teachers",
            headers=_auth(d_tok),
            json={
                "identifier": "esc1@example.edu",
                "name": "Esc 1",
                "password": "password123",
                "role": "tech",
                "hierarchy_rank": 40,
                "permissions": [perm_key],
            },
        )
        assert r_esc_create.status_code == 403

    # 2) Cannot create an account with a preset containing unheld permissions
    r_esc_preset = client.post(
        "/api/admin/teachers",
        headers=_auth(d_tok),
        json={
            "identifier": "esc2@example.edu",
            "name": "Esc 2",
            "password": "password123",
            "preset": "lab_tech",
        },
    )
    assert r_esc_preset.status_code == 403

    # 3) Can create a junior teacher/tech with subset of caller's permissions and rank <= 60
    r_ok_create = client.post(
        "/api/admin/teachers",
        headers=_auth(d_tok),
        json={
            "identifier": "junior@example.edu",
            "name": "Junior Teacher",
            "password": "password123",
            "role": "teacher",
            "hierarchy_rank": 40,
            "permissions": [Permission.SLICER_USE.value],
        },
    )
    assert r_ok_create.status_code == 201, r_ok_create.text
    junior_id = r_ok_create.json()["id"]

    # 4) Cannot modify own permissions (manual, preset, or reset)
    for payload in (
        {"permissions": [Permission.SLICER_USE.value]},
        {"preset": "slicer_only"},
        {"reset_permissions": True},
    ):
        r_self = client.patch(
            f"/api/admin/teachers/{delegated_id}",
            headers=_auth(d_tok),
            json=payload,
        )
        assert r_self.status_code == 403

    # 5) Cannot grant permissions caller lacks via PATCH on junior teacher
    r_patch_esc = client.patch(
        f"/api/admin/teachers/{junior_id}",
        headers=_auth(d_tok),
        json={"permissions": [Permission.SLICER_USE.value, Permission.PRINTERS_CREATE_DELETE.value]},
    )
    assert r_patch_esc.status_code == 403

    # 6) Cannot reset password of or delete a teacher holding higher permissions
    assert client.post(
        f"/api/admin/teachers/{high_id}/reset-password",
        headers=_auth(d_tok),
        json={"new_password": "hacked123"},
    ).status_code == 403
    assert client.delete(
        f"/api/admin/teachers/{high_id}",
        headers=_auth(d_tok),
    ).status_code == 403

    # 7) Can reset password and delete junior teacher (subset of caller's permissions)
    assert client.post(
        f"/api/admin/teachers/{junior_id}/reset-password",
        headers=_auth(d_tok),
        json={"new_password": "newpass123"},
    ).status_code == 200
    assert client.delete(
        f"/api/admin/teachers/{junior_id}",
        headers=_auth(d_tok),
    ).status_code == 204


def test_password_reset_increments_token_version(client: TestClient):
    a_tok = _login(client, "admin", "admin123")["access_token"]

    # Login as teacher before reset
    t_login = _login(client, "m.tremblay@example.edu", "teacher123")
    t_old_tok = t_login["access_token"]
    teacher_id = t_login["user"]["id"]
    assert client.get("/api/auth/me", headers=_auth(t_old_tok)).status_code == 200

    with database.SessionLocal() as db:
        t_before = db.get(User, teacher_id)
        tv_before = getattr(t_before, "token_version", 0) or 0

    r_reset_t = client.post(
        f"/api/admin/teachers/{teacher_id}/reset-password",
        headers=_auth(a_tok),
        json={"new_password": "resetpwd1"},
    )
    assert r_reset_t.status_code == 200

    with database.SessionLocal() as db:
        t_after = db.get(User, teacher_id)
        assert t_after.token_version == tv_before + 1
    # Old teacher JWT must now be revoked
    assert client.get("/api/auth/me", headers=_auth(t_old_tok)).status_code == 401

    # Login as student before reset
    s_login = _login(client, "2345678", "student123")
    s_old_tok = s_login["access_token"]
    student_id = s_login["user"]["id"]
    assert client.get("/api/auth/me", headers=_auth(s_old_tok)).status_code == 200

    with database.SessionLocal() as db:
        s_before = db.get(User, student_id)
        stv_before = getattr(s_before, "token_version", 0) or 0

    r_reset_s = client.post(
        f"/api/admin/students/{student_id}/reset-password",
        headers=_auth(a_tok),
        json={"new_password": "resetpwd2"},
    )
    assert r_reset_s.status_code == 200

    with database.SessionLocal() as db:
        s_after = db.get(User, student_id)
        assert s_after.token_version == stv_before + 1
    # Old student JWT must now be revoked
    assert client.get("/api/auth/me", headers=_auth(s_old_tok)).status_code == 401


def test_approve_and_raise_requires_student_management_permission(client: TestClient):
    a_tok = _login(client, "admin", "admin123")["access_token"]
    s_tok = _login(client, "2345678", "student123")["access_token"]

    # Create a printer operator (has approvals:jobs_all, NO students:manage_* / students:adjust_quotas)
    r_lt = client.post(
        "/api/admin/teachers",
        headers=_auth(a_tok),
        json={
            "identifier": "labtech.sec@example.edu",
            "name": "Lab Tech Sec",
            "password": "password123",
            "preset": "printer_operator",
        },
    )
    assert r_lt.status_code == 201
    lt_tok = _login(client, "labtech.sec@example.edu", "password123")["access_token"]

    # Create a teacher with approvals:jobs_all + students:manage_own + students:adjust_quotas (not enrolled with student 2345678)
    r_t2 = client.post(
        "/api/admin/teachers",
        headers=_auth(a_tok),
        json={
            "identifier": "other.approver@example.edu",
            "name": "Other Approver",
            "password": "password123",
            "permissions": [
                Permission.APPROVALS_JOBS_ALL.value,
                Permission.STUDENTS_MANAGE_OWN.value,
                Permission.STUDENTS_ADJUST_QUOTAS.value,
            ],
        },
    )
    assert r_t2.status_code == 201
    t2_tok = _login(client, "other.approver@example.edu", "password123")["access_token"]

    # Student uploads, slices, and requests approval routed to m.tremblay
    t_login = _login(client, "m.tremblay@example.edu", "teacher123")
    t_tok = t_login["access_token"]
    tremblay_id = t_login["user"]["id"]

    job = _upload_and_slice_job(client, s_tok)
    req_resp = client.post(
        f"/api/jobs/{job['id']}/request-approval",
        headers=_auth(s_tok),
        json={"note": "Need more grams", "teacher_id": tremblay_id},
    )
    assert req_resp.status_code == 200, req_resp.text

    # Lab tech cannot approve_and_raise (lacks students:manage_*) -> 403
    r_lt_raise = client.post(
        f"/api/admin/approvals/{job['id']}/decision",
        headers=_auth(lt_tok),
        json={"decision": "approve_and_raise", "new_max_active_grams": 500.0},
    )
    assert r_lt_raise.status_code == 403

    # Other teacher with students:manage_own cannot approve_and_raise for a student not in their classes -> 403
    r_t2_raise = client.post(
        f"/api/admin/approvals/{job['id']}/decision",
        headers=_auth(t2_tok),
        json={"decision": "approve_and_raise", "new_max_active_grams": 500.0},
    )
    assert r_t2_raise.status_code == 403

    # Assigned teacher (m.tremblay, owns student 2345678's class + students:manage_own) CAN approve_and_raise
    r_ok = client.post(
        f"/api/admin/approvals/{job['id']}/decision",
        headers=_auth(t_tok),
        json={"decision": "approve_and_raise", "new_max_active_grams": 250.0},
    )
    assert r_ok.status_code == 200, r_ok.text


def test_account_request_decision_uses_classes_manage_all_permission(client: TestClient):
    a_tok = _login(client, "admin", "admin123")["access_token"]
    t_tok = _login(client, "m.tremblay@example.edu", "teacher123")["access_token"]

    # Create coordinator teacher (role='teacher', has classes:manage_all + students:manage_all)
    r_coord = client.post(
        "/api/admin/teachers",
        headers=_auth(a_tok),
        json={
            "identifier": "coord.sec@example.edu",
            "name": "Coordinator Sec",
            "password": "password123",
            "preset": "coordinator",
        },
    )
    assert r_coord.status_code == 201
    coord_tok = _login(client, "coord.sec@example.edu", "password123")["access_token"]

    # Find m.tremblay's class ID
    classes = client.get("/api/admin/classes", headers=_auth(t_tok)).json()
    tremblay_class_id = classes[0]["id"]
    tremblay_id = classes[0]["teacher_id"]

    # Unlisted student registers requesting m.tremblay
    r_reg = client.post(
        "/api/auth/register",
        json={
            "da": "8888881",
            "name": "Pending Student",
            "password": "password123",
            "teacher_id": tremblay_id,
        },
    )
    assert r_reg.status_code == 201, r_reg.text
    assert r_reg.json()["pending_approval"] is True

    reqs = client.get("/api/admin/account-requests", headers=_auth(coord_tok)).json()
    pending = next(r for r in reqs if r["da"] == "8888881")

    # Coordinator (role=='teacher', classes:manage_all) can approve into m.tremblay's class
    r_approve = client.post(
        f"/api/admin/account-requests/{pending['id']}/decision",
        headers=_auth(coord_tok),
        json={"decision": "approve", "class_id": tremblay_class_id},
    )
    assert r_approve.status_code == 200, r_approve.text
    assert r_approve.json()["approval_status"] == "approved"


def test_delete_legacy_whitelist_requires_classes_manage_all(client: TestClient):
    a_tok = _login(client, "admin", "admin123")["access_token"]
    t_tok = _login(client, "m.tremblay@example.edu", "teacher123")["access_token"]

    with database.SessionLocal() as db:
        db.add(DAWhitelist(da="7777771", suggested_name="Legacy Entry"))
        db.commit()

    # Teacher without classes:manage_all gets 404 and entry stays intact
    r_t = client.delete("/api/admin/whitelist/7777771", headers=_auth(t_tok))
    assert r_t.status_code == 404
    with database.SessionLocal() as db:
        assert db.get(DAWhitelist, "7777771") is not None

    # Admin (classes:manage_all) can delete legacy entry
    r_a = client.delete("/api/admin/whitelist/7777771", headers=_auth(a_tok))
    assert r_a.status_code == 204
    with database.SessionLocal() as db:
        assert db.get(DAWhitelist, "7777771") is None


def test_csv_import_bounds_enforced(client: TestClient):
    t_tok = _login(client, "m.tremblay@example.edu", "teacher123")["access_token"]
    classes = client.get("/api/admin/classes", headers=_auth(t_tok)).json()
    class_id = classes[0]["id"]

    csv_body = "\n".join(
        [
            "da,name,max_grams,max_minutes",
            "6000001,Valid Student,250,180",
            "6000002,Neg Grams,-10,180",
            "6000003,Zero Grams,0,180",
            "6000004,Huge Grams,9999,180",
            "6000005,NaN Grams,nan,180",
            "6000006,Inf Grams,inf,180",
            "6000007,Zero Mins,100,0",
            "6000008,Huge Mins,100,20000",
        ]
    ).encode("utf-8")

    r_cls = client.post(
        f"/api/admin/classes/{class_id}/import-csv",
        headers=_auth(t_tok),
        files={"file": ("roster.csv", csv_body, "text/csv")},
    )
    assert r_cls.status_code == 200, r_cls.text
    assert r_cls.json()["added"] == 1
    assert r_cls.json()["skipped"] == 7

    # Also test legacy /whitelist/csv with different DAs
    csv_body_2 = "\n".join(
        [
            "da,name,max_grams,max_minutes",
            "6100001,Valid Legacy,300,240",
            "6100002,Bad Inf,-inf,120",
            "6100003,Bad Mins,100,-5",
            "6100004,Over Max,5000.1,120",
        ]
    ).encode("utf-8")
    r_wl = client.post(
        "/api/admin/whitelist/csv",
        headers=_auth(t_tok),
        files={"file": ("wl.csv", csv_body_2, "text/csv")},
    )
    assert r_wl.status_code == 200, r_wl.text
    assert r_wl.json()["added"] == 1
    assert r_wl.json()["skipped"] == 3


# ---------------------------------------------------------------------------
# 2. Job Access Control & /dev-complete
# ---------------------------------------------------------------------------


def test_job_owner_vs_read_access_control(client: TestClient):
    a_tok = _login(client, "admin", "admin123")["access_token"]
    t_login = _login(client, "m.tremblay@example.edu", "teacher123")
    t_tok = t_login["access_token"]
    tremblay_id = t_login["user"]["id"]
    s_tok = _login(client, "2345678", "student123")["access_token"]

    # Create a lab_tech teacher (approvals:manage_all) and an unrelated teacher (approvals:manage_own)
    client.post(
        "/api/admin/teachers",
        headers=_auth(a_tok),
        json={
            "identifier": "lt.jobs@example.edu",
            "name": "Lab Tech Jobs",
            "password": "password123",
            "preset": "lab_tech",
        },
    )
    client.post(
        "/api/admin/teachers",
        headers=_auth(a_tok),
        json={
            "identifier": "other.jobs@example.edu",
            "name": "Other Teacher",
            "password": "password123",
        },
    )
    lt_tok = _login(client, "lt.jobs@example.edu", "password123")["access_token"]
    other_t_tok = _login(client, "other.jobs@example.edu", "password123")["access_token"]

    job = _upload_and_slice_job(client, s_tok)
    job_id = job["id"]

    # Admin & teacher MUST NOT be able to mutate student's job via owner-only routes
    for non_owner_tok in (a_tok, t_tok, lt_tok):
        assert client.post(f"/api/jobs/{job_id}/reorient", headers=_auth(non_owner_tok)).status_code == 403
        assert client.post(
            f"/api/jobs/{job_id}/slice",
            headers=_auth(non_owner_tok),
            json={"printer_id": job["printer_id"], "slot_id": job["slot_id"]},
        ).status_code == 403
        assert client.post(f"/api/jobs/{job_id}/submit", headers=_auth(non_owner_tok)).status_code == 403
        assert client.post(
            f"/api/jobs/{job_id}/request-approval",
            headers=_auth(non_owner_tok),
            json={"note": "hijack"},
        ).status_code == 403

    # Student requests approval (assigns job.teacher_id = m.tremblay)
    assert client.post(
        f"/api/jobs/{job_id}/request-approval",
        headers=_auth(s_tok),
        json={"note": "Please approve", "teacher_id": tremblay_id},
    ).status_code == 200

    # Read routes (/mesh, /stl, /gcode): owner, assigned teacher, admin, and lab_tech (approvals:manage_all) succeed
    for allowed_tok in (s_tok, t_tok, a_tok, lt_tok):
        assert client.get(f"/api/jobs/{job_id}/mesh", headers=_auth(allowed_tok)).status_code == 200
        assert client.get(f"/api/jobs/{job_id}/stl", headers=_auth(allowed_tok)).status_code == 200
        assert client.get(f"/api/jobs/{job_id}/gcode", headers=_auth(allowed_tok)).status_code == 200

    # Unassigned teacher without approvals:manage_all gets 403 on read & cancel
    assert client.get(f"/api/jobs/{job_id}/mesh", headers=_auth(other_t_tok)).status_code == 403
    assert client.get(f"/api/jobs/{job_id}/stl", headers=_auth(other_t_tok)).status_code == 403
    assert client.get(f"/api/jobs/{job_id}/gcode", headers=_auth(other_t_tok)).status_code == 403
    assert client.post(f"/api/jobs/{job_id}/cancel", headers=_auth(other_t_tok)).status_code == 403

    # Assigned teacher CAN cancel
    assert client.post(f"/api/jobs/{job_id}/cancel", headers=_auth(t_tok)).status_code == 200


def test_dev_complete_blocked_when_dev_seed_false(client: TestClient, monkeypatch: pytest.MonkeyPatch):
    s_tok = _login(client, "2345678", "student123")["access_token"]
    job = _upload_and_slice_job(client, s_tok)
    sub = client.post(f"/api/jobs/{job['id']}/submit", headers=_auth(s_tok))
    assert sub.status_code == 200, sub.text

    # Disable dev_seed -> 403 even though fdm_monster_mode == "mock"
    monkeypatch.setattr(settings, "dev_seed", False)
    r_blocked = client.post(f"/api/jobs/{job['id']}/dev-complete", headers=_auth(s_tok))
    assert r_blocked.status_code == 403
    assert r_blocked.json()["detail"]["code"] == "DEV_ENDPOINT_DISABLED"

    # Re-enable dev_seed -> 200
    monkeypatch.setattr(settings, "dev_seed", True)
    r_ok = client.post(f"/api/jobs/{job['id']}/dev-complete", headers=_auth(s_tok))
    assert r_ok.status_code == 200
    assert r_ok.json()["status"] == JobStatus.COMPLETED.value


# ---------------------------------------------------------------------------
# 3. orca_cli_path Allowlist, Bounded Uploads, ZIP Bombs & Path Containment
# ---------------------------------------------------------------------------


def test_orca_cli_path_allowlist_in_settings_and_adapter(client: TestClient):
    a_tok = _login(client, "admin", "admin123")["access_token"]

    for bad_path in (
        "/usr/bin/id",
        "/bin/sh",
        "cmd.exe",
        "C:\\Windows\\System32\\cmd.exe",
        "python",
        "/tmp/AppRun",  # AppRun without 'orca' in path
    ):
        r = client.patch(
            "/api/admin/settings",
            headers=_auth(a_tok),
            json={"orca_cli_path": bad_path},
        )
        assert r.status_code == 400, f"Expected 400 for {bad_path}, got {r.status_code}"
        assert r.json()["detail"]["code"] == "INVALID_SLICER_PATH"

        with pytest.raises(SlicerError):
            OrcaSlicerCliAdapter(cli_path=bad_path)

    for good_path in (
        "orca-slicer",
        "/usr/local/bin/orca-slicer-headless",
        "C:\\Program Files\\OrcaSlicer\\orca-slicer.exe",
        "/opt/OrcaSlicer/AppRun",
    ):
        r = client.patch(
            "/api/admin/settings",
            headers=_auth(a_tok),
            json={"orca_cli_path": good_path},
        )
        assert r.status_code == 200, f"Expected 200 for {good_path}, got {r.text}"
        assert validate_orca_cli_path(good_path) == good_path
        adapter = OrcaSlicerCliAdapter(cli_path=good_path)
        assert adapter.cli_path == good_path


def test_bounded_upload_reads_enforce_413(client: TestClient, monkeypatch: pytest.MonkeyPatch):
    a_tok = _login(client, "admin", "admin123")["access_token"]
    s_tok = _login(client, "2345678", "student123")["access_token"]

    # 1) STL upload exceeding max_upload_mb=1 -> 413
    r_set = client.patch("/api/admin/settings", headers=_auth(a_tok), json={"max_upload_mb": 1})
    assert r_set.status_code == 200
    printers = client.get("/api/printers", headers=_auth(s_tok)).json()
    oversized_stl = b"A" * (1024 * 1024 + 128)
    r_stl = client.post(
        "/api/jobs/upload",
        headers=_auth(s_tok),
        files={"file": ("big.stl", oversized_stl, "model/stl")},
        data={"printer_id": str(printers[0]["id"]), "slot_id": str(printers[0]["slots"][0]["id"])},
    )
    assert r_stl.status_code == 413
    assert r_stl.json()["detail"]["code"] == "FILE_TOO_LARGE"

    # 2) Admin CSV & profile upload routes enforce bounded limits (monkeypatch small cap for speed)
    monkeypatch.setattr(admin_router, "_CSV_UPLOAD_MAX_BYTES", 1024)
    monkeypatch.setattr(admin_router, "_PROFILE_UPLOAD_MAX_BYTES", 1024)

    big_csv = b"da,name\n" + (b"1234567,Test\n" * 200)
    assert client.post(
        "/api/admin/whitelist/csv",
        headers=_auth(a_tok),
        files={"file": ("wl.csv", big_csv, "text/csv")},
    ).status_code == 413

    classes = client.get("/api/admin/classes", headers=_auth(a_tok)).json()
    assert client.post(
        f"/api/admin/classes/{classes[0]['id']}/import-csv",
        headers=_auth(a_tok),
        files={"file": ("cls.csv", big_csv, "text/csv")},
    ).status_code == 413

    big_json = b'{"name": "' + (b"x" * 2048) + b'"}'
    assert client.post(
        "/api/admin/profiles",
        headers=_auth(a_tok),
        files={"file": ("p.json", big_json, "application/json")},
        data={"name": "Big", "kind": "filament"},
    ).status_code == 413

    assert client.post(
        "/api/admin/filaments/import-orca",
        headers=_auth(a_tok),
        files=[("files", ("p.json", big_json, "application/json"))],
    ).status_code == 413

    big_ini = b"layer_height = 0.2\n" + (b"# padding\n" * 200)
    assert client.post(
        "/api/admin/profiles/preview-prusaslicer",
        headers=_auth(a_tok),
        files=[("files", ("cfg.ini", big_ini, "text/plain"))],
    ).status_code == 413

    assert client.post(
        "/api/admin/profiles/import-prusaslicer",
        headers=_auth(a_tok),
        files=[("files", ("cfg.ini", big_ini, "text/plain"))],
    ).status_code == 413


def _make_zip_bytes(members: list[tuple[str, bytes]]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for name, data in members:
            zf.writestr(name, data)
    return buf.getvalue()


def test_zip_bomb_protection_orca_and_prusaslicer():
    # 1) Too many entries (> 200)
    too_many_json = _make_zip_bytes([(f"f{i}.json", b"{}") for i in range(205)])
    with pytest.raises(ValueError, match="entry count"):
        extract_orca_filament_entries("many.zip", too_many_json)

    too_many_ini = _make_zip_bytes([(f"f{i}.ini", b"a = 1\n") for i in range(205)])
    with pytest.raises(ValueError, match="entry count"):
        extract_prusaslicer_ini_entries("many.zip", too_many_ini)

    # 2) Single entry exceeding 2 MB uncompressed (highly compressible zip bomb)
    bomb_payload = b" " * (2 * 1024 * 1024 + 1024)
    big_entry_json = _make_zip_bytes([("bomb.json", bomb_payload)])
    with pytest.raises(ValueError, match="2 MB"):
        extract_orca_filament_entries("bomb.zip", big_entry_json)

    big_entry_ini = _make_zip_bytes([("bomb.ini", bomb_payload)])
    with pytest.raises(ValueError, match="2 MB"):
        extract_prusaslicer_ini_entries("bomb.zip", big_entry_ini)

    # 3) Cumulative uncompressed bytes exceeding 20 MB (12 entries x 1.9 MB = 22.8 MB)
    chunk = b" " * (1900 * 1024)
    cum_json = _make_zip_bytes([(f"c{i}.json", chunk) for i in range(12)])
    with pytest.raises(ValueError, match="20 MB"):
        extract_orca_filament_entries("cum.zip", cum_json)

    cum_ini = _make_zip_bytes([(f"c{i}.ini", chunk) for i in range(12)])
    with pytest.raises(ValueError, match="20 MB"):
        extract_prusaslicer_ini_entries("cum.zip", cum_ini)


def test_path_sanitization_and_containment(client: TestClient, tmp_path: Path):
    s_tok = _login(client, "2345678", "student123")["access_token"]

    # 1) save_profile_file strips dangerous characters (;, \r, \n, spaces, ../)
    saved = save_profile_file("../../evil;name\r\n.json", json.dumps({"type": "filament"}).encode())
    assert saved.resolve().is_relative_to(settings.profiles_dir.resolve())
    assert ";" not in saved.name
    assert "\r" not in saved.name
    assert "\n" not in saved.name
    assert ".." not in saved.name

    # 2) delete_profile_file refuses to unlink files outside profiles_dir
    outside_profile = tmp_path / "do_not_delete_profile.txt"
    outside_profile.write_text("keep me", encoding="utf-8")
    fake_profile = OrcaProfile(
        name="Evil",
        kind="filament",
        filename="evil.json",
        file_path=str(outside_profile),
    )
    delete_profile_file(fake_profile)
    assert outside_profile.exists()

    # 3) slice_job sanitizes filename & printer fdm_monster_id
    with database.SessionLocal() as db:
        printer = db.query(Printer).first()
        assert printer is not None
        orig_fdm_id = printer.fdm_monster_id
        printer.fdm_monster_id = "../../weird;id"
        db.commit()

    try:
        job = _upload_and_slice_job(client, s_tok, filename="my;bad name.stl")
        gcode_name = job["gcode_filename"]
        assert ";" not in gcode_name
        assert ".." not in gcode_name
        assert "/" not in gcode_name
        assert "\\" not in gcode_name
    finally:
        with database.SessionLocal() as db:
            printer = db.query(Printer).first()
            if printer is not None:
                printer.fdm_monster_id = orig_fdm_id
                db.commit()

    # 4) delete_job_with_files refuses to unlink files outside jobs_dir
    outside_job_file = tmp_path / "do_not_delete_job.stl"
    outside_job_file.write_text("keep me", encoding="utf-8")
    with database.SessionLocal() as db:
        job_row = db.get(PrintJob, job["id"])
        assert job_row is not None
        job_row.original_stl_path = str(outside_job_file)
        db.commit()
        delete_job_with_files(db, job_row, commit=True)

    assert outside_job_file.exists()


# ---------------------------------------------------------------------------
# 6. Discord Hierarchy, Admin-Only Settings Lock & Granular Printer/Filament Scopes
# ---------------------------------------------------------------------------


def test_settings_and_updates_strictly_admin_only_even_with_custom_json(client: TestClient):
    a_tok = _login(client, "admin", "admin123")["access_token"]
    r_create = client.post(
        "/api/admin/accounts",
        headers=_auth(a_tok),
        json={
            "identifier": "tech.lock@example.edu",
            "name": "Tech Lock",
            "password": "password123",
            "role": "tech",
            "hierarchy_rank": 90,
            "preset": "lab_tech",
        },
    )
    assert r_create.status_code == 201, r_create.text
    tech_id = r_create.json()["id"]

    # Attempting to assign settings:manage or updates:manage is rejected with 403 ADMIN_ONLY_PERMISSION
    for admin_perm in (Permission.SETTINGS_MANAGE.value, Permission.UPDATES_MANAGE.value):
        resp = client.patch(
            f"/api/admin/accounts/{tech_id}",
            headers=_auth(a_tok),
            json={"permissions": [Permission.SLICER_USE.value, admin_perm]},
        )
        assert resp.status_code == 403
        assert resp.json()["detail"]["code"] == "ADMIN_ONLY_PERMISSION"

    # Even if DB permissions_json were forcibly polluted, runtime strips admin-only permissions and rejects
    with database.SessionLocal() as db:
        u = db.get(User, tech_id)
        assert u is not None
        u.permissions_json = json.dumps(["settings:manage", "updates:manage", "printers:view"])
        db.commit()

    t_login = _login(client, "tech.lock@example.edu", "password123")
    t_tok = t_login["access_token"]
    assert "settings:manage" not in t_login["user"]["permissions"]
    assert "updates:manage" not in t_login["user"]["permissions"]
    assert client.get("/api/admin/settings", headers=_auth(t_tok)).status_code == 403
    assert client.patch(
        "/api/admin/settings", headers=_auth(t_tok), json={"default_max_active_grams": 999.0}
    ).status_code == 403
    assert client.get("/api/admin/system/update-status", headers=_auth(t_tok)).status_code == 403


def test_discord_hierarchy_rank_and_create_tech_vs_teacher_delegation(client: TestClient):
    a_tok = _login(client, "admin", "admin123")["access_token"]
    admin_row = next(u for u in client.get("/api/admin/accounts", headers=_auth(a_tok)).json() if u["role"] == "admin")
    assert admin_row["hierarchy_rank"] == 100
    assert admin_row["can_manage"] is False  # Protected even in listing

    # Admin creates Lead Teacher (rank 70) who can ONLY create Lab Techs (NOT Teachers) + edit/view printers
    r_lead = client.post(
        "/api/admin/accounts",
        headers=_auth(a_tok),
        json={
            "identifier": "lead.coord@example.edu",
            "name": "Lead Coord",
            "password": "password123",
            "role": "teacher",
            "hierarchy_rank": 70,
            "permissions": [
                Permission.SLICER_USE.value,
                Permission.ACCOUNTS_VIEW.value,
                Permission.ACCOUNTS_CREATE_TECH.value,
                Permission.ACCOUNTS_EDIT_PERMISSIONS.value,
                Permission.ACCOUNTS_MANAGE_STATUS.value,
                Permission.PRINTERS_VIEW.value,
                Permission.PRINTERS_MANAGE_SLOTS.value,
            ],
        },
    )
    assert r_lead.status_code == 201, r_lead.text
    lead_tok = _login(client, "lead.coord@example.edu", "password123")["access_token"]

    # Lead CAN create a Lab Tech at rank 50 with subset permissions
    r_tech = client.post(
        "/api/admin/accounts",
        headers=_auth(lead_tok),
        json={
            "identifier": "sub.tech@example.edu",
            "name": "Sub Tech",
            "password": "password123",
            "role": "tech",
            "hierarchy_rank": 50,
            "permissions": [Permission.SLICER_USE.value, Permission.PRINTERS_MANAGE_SLOTS.value],
        },
    )
    assert r_tech.status_code == 201, r_tech.text
    sub_tech_id = r_tech.json()["id"]

    # Lead CANNOT create a Teacher (lacks accounts:create_teacher)
    r_no_teacher = client.post(
        "/api/admin/accounts",
        headers=_auth(lead_tok),
        json={
            "identifier": "sub.teacher@example.edu",
            "name": "Sub Teacher",
            "password": "password123",
            "role": "teacher",
            "hierarchy_rank": 40,
            "permissions": [Permission.SLICER_USE.value],
        },
    )
    assert r_no_teacher.status_code == 403

    # Lead CANNOT create a Lab Tech at rank 75 (> Lead's rank 70)
    r_rank_esc = client.post(
        "/api/admin/accounts",
        headers=_auth(lead_tok),
        json={
            "identifier": "high.tech@example.edu",
            "name": "High Tech",
            "password": "password123",
            "role": "tech",
            "hierarchy_rank": 75,
            "permissions": [Permission.SLICER_USE.value],
        },
    )
    assert r_rank_esc.status_code == 403
    assert r_rank_esc.json()["detail"]["code"] == "RANK_EXCEEDED"

    # Lead CANNOT modify or delete Super Admin -> 403 ADMIN_PROTECTED
    assert (
        client.patch(
            f"/api/admin/accounts/{admin_row['id']}",
            headers=_auth(lead_tok),
            json={"is_active": False},
        ).status_code
        == 403
    )

    # Lead CAN edit Sub Tech's status/permissions within Lead's ceiling
    r_patch_tech = client.patch(
        f"/api/admin/accounts/{sub_tech_id}",
        headers=_auth(lead_tok),
        json={"is_active": False},
    )
    assert r_patch_tech.status_code == 200
    assert r_patch_tech.json()["is_active"] is False

    # Lead CANNOT delete Sub Tech (lacks accounts:delete) -> 403
    assert client.delete(f"/api/admin/accounts/{sub_tech_id}", headers=_auth(lead_tok)).status_code == 403


def test_granular_printer_filament_and_student_scopes(client: TestClient):
    a_tok = _login(client, "admin", "admin123")["access_token"]
    printers = client.get("/api/admin/printers", headers=_auth(a_tok)).json()
    filaments = client.get("/api/admin/filaments", headers=_auth(a_tok)).json()
    printer_id = printers[0]["id"]
    filament_id = filaments[0]["id"]

    # 1. Slots-only operator: CAN view printers & update slots, CANNOT edit/add/delete printers
    r_op = client.post(
        "/api/admin/accounts",
        headers=_auth(a_tok),
        json={
            "identifier": "slot.op@example.edu",
            "name": "Slot Op",
            "password": "password123",
            "role": "tech",
            "permissions": [Permission.PRINTERS_MANAGE_SLOTS.value, Permission.FILAMENTS_EDIT.value],
        },
    )
    assert r_op.status_code == 201
    op_tok = _login(client, "slot.op@example.edu", "password123")["access_token"]

    assert client.get("/api/admin/printers", headers=_auth(op_tok)).status_code == 200
    assert (
        client.put(
            f"/api/admin/printers/{printer_id}/slots/1",
            headers=_auth(op_tok),
            json={"filament_id": filament_id, "is_loaded": True},
        ).status_code
        == 200
    )
    assert (
        client.patch(
            f"/api/admin/printers/{printer_id}",
            headers=_auth(op_tok),
            json={"display_name": "Denied Edit"},
        ).status_code
        == 403
    )
    assert (
        client.post(
            "/api/admin/printers",
            headers=_auth(op_tok),
            json={
                "display_name": "Denied Create",
                "printer_type": "klipper",
                "bed_x_mm": 200,
                "bed_y_mm": 200,
                "bed_z_mm": 200,
                "mmu_slots_count": 1,
            },
        ).status_code
        == 403
    )

    # Same operator has filaments:edit ONLY: CAN patch filament, CANNOT create or delete
    assert (
        client.patch(
            f"/api/admin/filaments/{filament_id}",
            headers=_auth(op_tok),
            json={"color_hex": "#112233"},
        ).status_code
        == 200
    )
    assert (
        client.post(
            "/api/admin/filaments",
            headers=_auth(op_tok),
            json={"name": "Blocked PLA", "material": "PLA"},
        ).status_code
        == 403
    )
    assert (
        client.delete(f"/api/admin/filaments/{filament_id}", headers=_auth(op_tok)).status_code
        == 403
    )

    # 2. Full Lab Tech default role sees all classes, students, approvals, printers, filaments, profiles, but NOT settings
    r_full_tech = client.post(
        "/api/admin/accounts",
        headers=_auth(a_tok),
        json={
            "identifier": "full.tech@example.edu",
            "name": "Full Lab Tech",
            "password": "password123",
            "role": "tech",
        },
    )
    assert r_full_tech.status_code == 201
    ft_tok = _login(client, "full.tech@example.edu", "password123")["access_token"]
    assert len(client.get("/api/admin/classes", headers=_auth(ft_tok)).json()) >= 2
    assert client.get("/api/admin/students", headers=_auth(ft_tok)).status_code == 200
    assert client.get("/api/admin/approvals", headers=_auth(ft_tok)).status_code == 200
    assert client.get("/api/admin/printers", headers=_auth(ft_tok)).status_code == 200
    assert client.get("/api/admin/filaments", headers=_auth(ft_tok)).status_code == 200
    assert client.get("/api/admin/profiles", headers=_auth(ft_tok)).status_code == 200
    assert client.get("/api/admin/settings", headers=_auth(ft_tok)).status_code == 403

