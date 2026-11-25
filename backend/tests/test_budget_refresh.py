"""Tests for manual max-gram budget refresh (single user, group, class, all students)."""

from __future__ import annotations

import io
from datetime import timedelta
from pathlib import Path

import pytest
import trimesh
from fastapi.testclient import TestClient

from app import database, main
from app.config import settings
from app.models import PrintJob, utcnow
from app.services import fdm_monster


@pytest.fixture()
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Isolated TestClient backed by a fresh temp SQLite DB and data dir."""
    test_data_dir = tmp_path / "data"
    test_db_path = test_data_dir / "test_budget_refresh.db"

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


def _make_stl_bytes(extents=(25.0, 25.0, 20.0)) -> bytes:
    mesh = trimesh.creation.box(extents=list(extents))
    buf = io.BytesIO()
    mesh.export(buf, file_type="stl")
    return buf.getvalue()


def _submit_job(client: TestClient, token: str, filename: str = "box.stl") -> dict:
    printers = client.get("/api/printers", headers=_auth(token)).json()
    p = printers[0]
    slot = p["slots"][0]
    up = client.post(
        "/api/jobs/upload",
        headers=_auth(token),
        files={"file": (filename, _make_stl_bytes(), "model/stl")},
        data={"printer_id": str(p["id"]), "slot_id": str(slot["id"])},
    )
    assert up.status_code == 201, up.text
    job_id = up.json()["id"]
    sl = client.post(
        f"/api/jobs/{job_id}/slice?sync=true",
        headers=_auth(token),
        json={
            "printer_id": p["id"],
            "slot_id": slot["id"],
            "pos_x_mm": 0.0,
            "pos_y_mm": 0.0,
            "quat_x": 0.0,
            "quat_y": 0.0,
            "quat_z": 0.0,
            "quat_w": 1.0,
            "scale": 1.0,
            "supports_enabled": False,
        },
    )
    assert sl.status_code == 200, sl.text
    sub = client.post(f"/api/jobs/{job_id}/submit", headers=_auth(token))
    assert sub.status_code == 200, sub.text
    return sub.json()


def test_single_user_refresh_clears_usage_preserves_history_and_counts_new_jobs(client: TestClient):
    s_login = _login(client, "2345678", "student123")
    s_token = s_login["access_token"]
    student_id = s_login["user"]["id"]
    a_token = _login(client, "admin", "admin123")["access_token"]

    # Submit a job -> active_grams_used > 0
    first_job = _submit_job(client, s_token, "first.stl")
    # Backdate first_job slightly so budget_reset_at is strictly after it
    with database.SessionLocal() as db:
        row = db.get(PrintJob, first_job["id"])
        assert row is not None
        row.created_at = utcnow() - timedelta(seconds=10)
        db.commit()

    me_before = client.get("/api/auth/me", headers=_auth(s_token)).json()
    assert me_before["active_grams_used"] > 0

    # Refresh single user's budget (keep max grams, reset usage)
    r_ref = client.post(
        "/api/admin/students/refresh-budget",
        headers=_auth(a_token),
        json={
            "scope": "users",
            "user_ids": [student_id],
            "reset_usage": True,
            "max_grams_mode": "keep",
        },
    )
    assert r_ref.status_code == 200, r_ref.text
    assert r_ref.json() == {"refreshed_count": 1, "user_ids": [student_id]}

    # Active usage is now 0 g, available_grams == effective_max_active_grams, and job is still in DB!
    me_after = client.get("/api/auth/me", headers=_auth(s_token)).json()
    assert me_after["active_grams_used"] == 0.0
    assert me_after["available_grams"] == me_after["effective_max_active_grams"]
    mine = client.get("/api/jobs/mine", headers=_auth(s_token)).json()["jobs"]
    assert any(j["id"] == first_job["id"] for j in mine)

    # New job submitted AFTER refresh counts toward active_grams_used
    second_job = _submit_job(client, s_token, "second.stl")
    me_after_second = client.get("/api/auth/me", headers=_auth(s_token)).json()
    assert me_after_second["active_grams_used"] == pytest.approx(second_job["estimated_grams"], abs=0.05)


def test_group_refresh_with_custom_grams_and_class_refresh_to_default(client: TestClient):
    a_token = _login(client, "admin", "admin123")["access_token"]
    t_token = _login(client, "m.tremblay@cgodin.qc.ca", "teacher123")["access_token"]

    # Register a second student (2333572 is pre-enrolled in Marc's class)
    r_reg = client.post(
        "/api/auth/register",
        json={"da": "2333572", "name": "Gabriel", "password": "pass123"},
    )
    assert r_reg.status_code == 201, r_reg.text
    stu2_id = r_reg.json()["user"]["id"]
    stu1_id = _login(client, "2345678", "student123")["user"]["id"]

    # Group refresh with custom max grams (180 g)
    r_group = client.post(
        "/api/admin/students/refresh-budget",
        headers=_auth(a_token),
        json={
            "scope": "users",
            "user_ids": [stu1_id, stu2_id],
            "reset_usage": True,
            "max_grams_mode": "custom",
            "custom_max_grams": 180.0,
        },
    )
    assert r_group.status_code == 200, r_group.text
    assert r_group.json()["refreshed_count"] == 2
    assert set(r_group.json()["user_ids"]) == {stu1_id, stu2_id}

    students = client.get("/api/admin/students", headers=_auth(a_token)).json()
    by_id = {s["id"]: s for s in students}
    assert by_id[stu1_id]["effective_max_active_grams"] == 180.0
    assert by_id[stu2_id]["effective_max_active_grams"] == 180.0

    # Set a class default budget (140 g) on Marc's first class, then refresh class to 'default'
    classes = client.get("/api/admin/classes", headers=_auth(t_token)).json()
    cls = classes[0]
    assert client.patch(
        f"/api/admin/classes/{cls['id']}",
        headers=_auth(t_token),
        json={"default_max_active_grams": 140.0},
    ).status_code == 200

    r_cls_ref = client.post(
        "/api/admin/students/refresh-budget",
        headers=_auth(t_token),
        json={
            "scope": "class",
            "class_id": cls["id"],
            "reset_usage": True,
            "max_grams_mode": "default",
        },
    )
    assert r_cls_ref.status_code == 200, r_cls_ref.text
    assert r_cls_ref.json()["refreshed_count"] == 2

    students_after_cls = {s["id"]: s for s in client.get("/api/admin/students", headers=_auth(a_token)).json()}
    assert students_after_cls[stu1_id]["effective_max_active_grams"] == 140.0
    assert students_after_cls[stu2_id]["effective_max_active_grams"] == 140.0


def test_all_students_refresh_admin_allowed_and_teacher_forbidden(client: TestClient):
    a_token = _login(client, "admin", "admin123")["access_token"]
    t_token = _login(client, "m.tremblay@cgodin.qc.ca", "teacher123")["access_token"]

    # Default teacher cannot refresh scope='all' -> 403
    r_teacher_all = client.post(
        "/api/admin/students/refresh-budget",
        headers=_auth(t_token),
        json={"scope": "all", "reset_usage": True, "max_grams_mode": "default"},
    )
    assert r_teacher_all.status_code == 403
    assert r_teacher_all.json()["detail"]["required_permission"] == "students:manage_all"

    # Admin can refresh scope='all' -> 200 and resets override to system default (100 g)
    r_admin_all = client.post(
        "/api/admin/students/refresh-budget",
        headers=_auth(a_token),
        json={"scope": "all", "reset_usage": True, "max_grams_mode": "default"},
    )
    assert r_admin_all.status_code == 200, r_admin_all.text
    assert r_admin_all.json()["refreshed_count"] >= 1
    for stu in client.get("/api/admin/students", headers=_auth(a_token)).json():
        assert stu["max_active_grams_override"] is None
        assert stu["effective_max_active_grams"] == 100.0
