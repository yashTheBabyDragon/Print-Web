"""Tests for draft lifecycle: single delete, clear all, logout cleanup, 24h TTL purge, and STL download."""

from __future__ import annotations

import io
from datetime import timedelta
from pathlib import Path

import pytest
import trimesh
from fastapi.testclient import TestClient

from app import database, main
from app.config import settings
from app.models import JobStatus, PrintJob, utcnow
from app.services import fdm_monster
from app.services.drafts import purge_expired_drafts


@pytest.fixture()
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Isolated TestClient backed by a fresh temp SQLite DB and data dir."""
    test_data_dir = tmp_path / "data"
    test_db_path = test_data_dir / "test_drafts.db"

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


def _auth_header(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _login(client: TestClient, da: str, password: str) -> dict:
    resp = client.post("/api/auth/login", json={"da": da, "password": password})
    assert resp.status_code == 200, resp.text
    return resp.json()


def _make_stl_bytes(extents=(20.0, 20.0, 15.0)) -> bytes:
    mesh = trimesh.creation.box(extents=list(extents))
    buf = io.BytesIO()
    mesh.export(buf, file_type="stl")
    return buf.getvalue()


def _upload_draft(
    client: TestClient,
    token: str,
    printer_id: int,
    slot_id: int,
    filename: str = "part.stl",
) -> dict:
    resp = client.post(
        "/api/jobs/upload",
        headers=_auth_header(token),
        files={"file": (filename, _make_stl_bytes(), "model/stl")},
        data={"printer_id": str(printer_id), "slot_id": str(slot_id)},
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def _slice_draft(client: TestClient, token: str, job_id: int, printer_id: int, slot_id: int) -> dict:
    resp = client.post(
        f"/api/jobs/{job_id}/slice",
        headers=_auth_header(token),
        json={
            "printer_id": printer_id,
            "slot_id": slot_id,
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
    assert resp.status_code == 200, resp.text
    return resp.json()


def _first_printer_and_slot(client: TestClient, token: str) -> tuple[int, int]:
    printers = client.get("/api/printers", headers=_auth_header(token)).json()
    p = printers[0]
    return p["id"], p["slots"][0]["id"]


def test_delete_single_draft_and_files(client: TestClient):
    auth = _login(client, "2345678", "student123")
    token = auth["access_token"]
    printer_id, slot_id = _first_printer_and_slot(client, token)

    draft = _upload_draft(client, token, printer_id, slot_id, "single.stl")
    sliced = _upload_draft(client, token, printer_id, slot_id, "sliced.stl")
    _slice_draft(client, token, sliced["id"], printer_id, slot_id)

    # Capture disk paths before deletion
    with database.SessionLocal() as db:
        draft_row = db.get(PrintJob, draft["id"])
        sliced_row = db.get(PrintJob, sliced["id"])
        assert draft_row is not None and sliced_row is not None
        draft_paths = [Path(draft_row.original_stl_path), Path(draft_row.oriented_stl_path)]
        sliced_paths = [
            Path(sliced_row.original_stl_path),
            Path(sliced_row.oriented_stl_path),
            Path(sliced_row.sliced_output_path or ""),
        ]
        for p in draft_paths + sliced_paths:
            assert p.exists()

    # Delete DRAFT
    r_del1 = client.delete(f"/api/jobs/{draft['id']}", headers=_auth_header(token))
    assert r_del1.status_code == 200, r_del1.text
    assert r_del1.json() == {"deleted": True, "id": draft["id"]}
    for p in draft_paths:
        assert not p.exists()

    # Delete SLICED
    r_del2 = client.delete(f"/api/jobs/{sliced['id']}", headers=_auth_header(token))
    assert r_del2.status_code == 200, r_del2.text
    assert r_del2.json() == {"deleted": True, "id": sliced["id"]}
    for p in sliced_paths:
        assert not p.exists()

    # Deleting non-existent job returns 404
    r_missing = client.delete(f"/api/jobs/{draft['id']}", headers=_auth_header(token))
    assert r_missing.status_code == 404


def test_delete_other_users_draft_returns_404_and_non_draft_rejected(client: TestClient):
    student_auth = _login(client, "2345678", "student123")
    student_token = student_auth["access_token"]
    admin_auth = _login(client, "admin", "admin123")
    admin_token = admin_auth["access_token"]
    printer_id, slot_id = _first_printer_and_slot(client, student_token)

    draft = _upload_draft(client, student_token, printer_id, slot_id, "owned.stl")

    # Another user cannot delete someone else's draft -> 404
    r_other = client.delete(f"/api/jobs/{draft['id']}", headers=_auth_header(admin_token))
    assert r_other.status_code == 404

    # Slice and submit the job -> QUEUED/PRINTING
    _slice_draft(client, student_token, draft["id"], printer_id, slot_id)
    r_sub = client.post(f"/api/jobs/{draft['id']}/submit", headers=_auth_header(student_token))
    assert r_sub.status_code == 200, r_sub.text
    assert r_sub.json()["status"] not in (JobStatus.DRAFT.value, JobStatus.SLICED.value)

    # Deleting submitted job is rejected with 400
    r_del_submitted = client.delete(f"/api/jobs/{draft['id']}", headers=_auth_header(student_token))
    assert r_del_submitted.status_code == 400
    assert r_del_submitted.json()["detail"]["code"] == "NOT_A_DRAFT"


def test_clear_all_drafts_preserves_submitted_and_other_users(client: TestClient):
    student_auth = _login(client, "2345678", "student123")
    student_token = student_auth["access_token"]
    admin_auth = _login(client, "admin", "admin123")
    admin_token = admin_auth["access_token"]
    printer_id, slot_id = _first_printer_and_slot(client, student_token)

    d1 = _upload_draft(client, student_token, printer_id, slot_id, "d1.stl")
    d2 = _upload_draft(client, student_token, printer_id, slot_id, "d2.stl")
    _slice_draft(client, student_token, d2["id"], printer_id, slot_id)

    submitted = _upload_draft(client, student_token, printer_id, slot_id, "sub.stl")
    _slice_draft(client, student_token, submitted["id"], printer_id, slot_id)
    r_sub = client.post(f"/api/jobs/{submitted['id']}/submit", headers=_auth_header(student_token))
    assert r_sub.status_code == 200, r_sub.text

    other_draft = _upload_draft(client, admin_token, printer_id, slot_id, "admin_draft.stl")

    # Clear all drafts for student
    r_clear = client.delete("/api/jobs/drafts", headers=_auth_header(student_token))
    assert r_clear.status_code == 200, r_clear.text
    assert r_clear.json() == {"deleted": 2}

    # Student only has the submitted job remaining
    mine = client.get("/api/jobs/mine", headers=_auth_header(student_token)).json()["jobs"]
    mine_ids = {j["id"] for j in mine}
    assert d1["id"] not in mine_ids
    assert d2["id"] not in mine_ids
    assert submitted["id"] in mine_ids

    # Admin's draft is untouched
    admin_mine = client.get("/api/jobs/mine", headers=_auth_header(admin_token)).json()["jobs"]
    assert any(j["id"] == other_draft["id"] for j in admin_mine)

    # Clearing again returns deleted: 0
    r_clear_again = client.delete("/api/jobs/drafts", headers=_auth_header(student_token))
    assert r_clear_again.status_code == 200
    assert r_clear_again.json() == {"deleted": 0}


def test_logout_deletes_user_drafts_only(client: TestClient):
    student_auth = _login(client, "2345678", "student123")
    student_token = student_auth["access_token"]
    printer_id, slot_id = _first_printer_and_slot(client, student_token)

    d1 = _upload_draft(client, student_token, printer_id, slot_id, "logout_draft.stl")
    d2 = _upload_draft(client, student_token, printer_id, slot_id, "logout_sliced.stl")
    _slice_draft(client, student_token, d2["id"], printer_id, slot_id)

    submitted = _upload_draft(client, student_token, printer_id, slot_id, "logout_keep.stl")
    _slice_draft(client, student_token, submitted["id"], printer_id, slot_id)
    assert client.post(f"/api/jobs/{submitted['id']}/submit", headers=_auth_header(student_token)).status_code == 200

    r_logout = client.post("/api/auth/logout", headers=_auth_header(student_token))
    assert r_logout.status_code == 200, r_logout.text
    assert r_logout.json() == {"deleted": 2}

    mine = client.get("/api/jobs/mine", headers=_auth_header(student_token)).json()["jobs"]
    mine_ids = {j["id"] for j in mine}
    assert d1["id"] not in mine_ids
    assert d2["id"] not in mine_ids
    assert submitted["id"] in mine_ids


def test_ttl_purge_removes_old_drafts_and_preserves_recent_and_submitted(client: TestClient):
    student_auth = _login(client, "2345678", "student123")
    student_token = student_auth["access_token"]
    printer_id, slot_id = _first_printer_and_slot(client, student_token)

    old_draft = _upload_draft(client, student_token, printer_id, slot_id, "old_draft.stl")
    old_sliced = _upload_draft(client, student_token, printer_id, slot_id, "old_sliced.stl")
    _slice_draft(client, student_token, old_sliced["id"], printer_id, slot_id)
    recent_draft = _upload_draft(client, student_token, printer_id, slot_id, "recent_draft.stl")

    old_submitted = _upload_draft(client, student_token, printer_id, slot_id, "old_sub.stl")
    _slice_draft(client, student_token, old_submitted["id"], printer_id, slot_id)
    assert client.post(f"/api/jobs/{old_submitted['id']}/submit", headers=_auth_header(student_token)).status_code == 200

    expired_ts = utcnow() - timedelta(hours=25)
    with database.SessionLocal() as db:
        for jid in (old_draft["id"], old_sliced["id"], old_submitted["id"]):
            row = db.get(PrintJob, jid)
            assert row is not None
            row.created_at = expired_ts
            row.updated_at = expired_ts
        db.commit()

    # Direct purge test
    with database.SessionLocal() as db:
        deleted = purge_expired_drafts(db, max_age_hours=24)
        assert deleted == 2

    # Verify lazy purge via GET /api/jobs/mine also works
    old_lazy = _upload_draft(client, student_token, printer_id, slot_id, "old_lazy.stl")
    with database.SessionLocal() as db:
        row = db.get(PrintJob, old_lazy["id"])
        assert row is not None
        row.created_at = expired_ts
        row.updated_at = expired_ts
        db.commit()

    mine = client.get("/api/jobs/mine", headers=_auth_header(student_token)).json()["jobs"]
    mine_ids = {j["id"] for j in mine}
    assert old_draft["id"] not in mine_ids
    assert old_sliced["id"] not in mine_ids
    assert old_lazy["id"] not in mine_ids
    assert recent_draft["id"] in mine_ids
    assert old_submitted["id"] in mine_ids


def test_get_job_stl_returns_bytes(client: TestClient):
    student_auth = _login(client, "2345678", "student123")
    student_token = student_auth["access_token"]
    admin_auth = _login(client, "admin", "admin123")
    admin_token = admin_auth["access_token"]
    printer_id, slot_id = _first_printer_and_slot(client, student_token)

    draft = _upload_draft(client, student_token, printer_id, slot_id, "cube.stl")

    # Owner can download STL
    r_stl = client.get(f"/api/jobs/{draft['id']}/stl", headers=_auth_header(student_token))
    assert r_stl.status_code == 200, r_stl.text
    assert r_stl.headers["content-type"].startswith("application/octet-stream")
    assert len(r_stl.content) > 84

    # Admin can also download STL
    r_admin = client.get(f"/api/jobs/{draft['id']}/stl", headers=_auth_header(admin_token))
    assert r_admin.status_code == 200
    assert r_admin.content == r_stl.content

    # Unauthenticated request rejected
    r_unauth = client.get(f"/api/jobs/{draft['id']}/stl")
    assert r_unauth.status_code == 401
