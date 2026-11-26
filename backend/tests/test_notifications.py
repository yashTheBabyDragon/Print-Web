"""Tests for user notification preferences (browser + webhook) and print completion webhooks."""

from __future__ import annotations

import asyncio
import io
from pathlib import Path

import pytest
import trimesh
from fastapi.testclient import TestClient

from app import database, main
from app.config import settings
from app.services import fdm_monster, notifications


@pytest.fixture()
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Isolated TestClient backed by a fresh temp SQLite DB and data dir."""
    test_data_dir = tmp_path / "data"
    test_db_path = test_data_dir / "test_notif.db"

    monkeypatch.setattr(settings, "data_dir", test_data_dir)
    monkeypatch.setattr(settings, "database_url", f"sqlite:///{test_db_path.as_posix()}")
    monkeypatch.setattr(settings, "dev_seed", True)

    test_engine = database._build_engine(settings.effective_database_url)
    test_session_local = database.sessionmaker(autocommit=False, autoflush=False, bind=test_engine)

    monkeypatch.setattr(database, "engine", test_engine)
    monkeypatch.setattr(database, "SessionLocal", test_session_local)
    monkeypatch.setattr(main, "SessionLocal", test_session_local)

    fdm_monster._MOCK_JOBS.clear()

    with TestClient(main.app) as tc:
        yield tc

    test_engine.dispose()


def _login(client: TestClient, da: str, password: str) -> dict:
    resp = client.post("/api/auth/login", json={"da": da, "password": password})
    assert resp.status_code == 200, resp.text
    return resp.json()


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _make_stl_bytes() -> bytes:
    mesh = trimesh.creation.box(extents=[20.0, 20.0, 15.0])
    buf = io.BytesIO()
    mesh.export(buf, file_type="stl")
    return buf.getvalue()


def test_student_can_manage_notification_preferences(client: TestClient):
    # Regular student (not admin/teacher)
    auth = _login(client, "2345678", "student123")
    headers = _auth(auth["access_token"])

    # Defaults are off
    r_get = client.get("/api/auth/notifications", headers=headers)
    assert r_get.status_code == 200
    assert r_get.json() == {"notify_browser": False, "notify_webhook_url": None}

    # Enable browser notifications and set Discord webhook
    webhook = "https://discord.com/api/webhooks/123456/abcdef"
    r_patch = client.patch(
        "/api/auth/notifications",
        headers=headers,
        json={"notify_browser": True, "notify_webhook_url": webhook},
    )
    assert r_patch.status_code == 200, r_patch.text
    user_body = r_patch.json()
    assert user_body["notify_browser"] is True
    assert user_body["notify_webhook_url"] == webhook

    # Reflected on /api/auth/me
    r_me = client.get("/api/auth/me", headers=headers)
    assert r_me.status_code == 200
    assert r_me.json()["notify_browser"] is True
    assert r_me.json()["notify_webhook_url"] == webhook

    # Invalid URL is rejected with 422
    r_bad = client.patch(
        "/api/auth/notifications",
        headers=headers,
        json={"notify_webhook_url": "ftp://example.com/hook"},
    )
    assert r_bad.status_code == 422
    assert r_bad.json()["detail"]["code"] == "INVALID_WEBHOOK_URL"

    # Blank string clears webhook URL
    r_clear = client.patch(
        "/api/auth/notifications",
        headers=headers,
        json={"notify_webhook_url": "   "},
    )
    assert r_clear.status_code == 200
    assert r_clear.json()["notify_webhook_url"] is None


def test_webhook_test_endpoint_sends_discord_embed(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
):
    sent: list[tuple[str, dict]] = []

    async def fake_post(url: str, payload: dict):
        sent.append((url, payload))
        return True, 204, None

    monkeypatch.setattr(notifications, "post_webhook", fake_post)
    monkeypatch.setattr("app.routers.auth.post_webhook", fake_post)

    auth = _login(client, "2345678", "student123")
    headers = _auth(auth["access_token"])

    # Missing URL -> 400
    r_empty = client.post("/api/auth/notifications/test-webhook", headers=headers, json={})
    assert r_empty.status_code == 400
    assert r_empty.json()["detail"]["code"] == "WEBHOOK_URL_REQUIRED"

    # Explicit Discord URL -> 200 ok with embeds
    discord_url = "https://discord.com/api/webhooks/999/token"
    r_ok = client.post(
        "/api/auth/notifications/test-webhook",
        headers=headers,
        json={"webhook_url": discord_url},
    )
    assert r_ok.status_code == 200, r_ok.text
    assert r_ok.json() == {"ok": True, "status_code": 204, "error": None}
    assert len(sent) == 1
    assert sent[0][0] == discord_url
    assert sent[0][1]["event"] == "notification.test"
    assert "embeds" in sent[0][1]


def test_job_completion_triggers_user_webhook_on_dev_complete_and_poll(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
):
    sent: list[tuple[str, dict]] = []

    async def fake_post(url: str, payload: dict):
        sent.append((url, payload))
        return True, 200, None

    monkeypatch.setattr(notifications, "post_webhook", fake_post)

    auth = _login(client, "2345678", "student123")
    headers = _auth(auth["access_token"])
    webhook_url = "https://hooks.example.org/printweb"

    # Configure student webhook
    r_cfg = client.patch(
        "/api/auth/notifications",
        headers=headers,
        json={"notify_webhook_url": webhook_url},
    )
    assert r_cfg.status_code == 200

    # Pick first printer + loaded slot
    printers = client.get("/api/printers", headers=headers).json()
    printer = printers[0]
    slot = next(s for s in printer["slots"] if s["is_loaded"])

    def _submit_job(filename: str) -> dict:
        up = client.post(
            "/api/jobs/upload",
            headers=headers,
            files={"file": (filename, _make_stl_bytes(), "model/stl")},
            data={"printer_id": str(printer["id"]), "slot_id": str(slot["id"])},
        )
        assert up.status_code == 201, up.text
        job_id = up.json()["id"]

        sl = client.post(
            f"/api/jobs/{job_id}/slice?sync=true",
            headers=headers,
            json={
                "printer_id": printer["id"],
                "slot_id": slot["id"],
                "pos_x_mm": 0.0,
                "pos_y_mm": 0.0,
                "quat_x": 0.0,
                "quat_y": 0.0,
                "quat_z": 0.0,
                "quat_w": 1.0,
                "scale": 1.0,
                "supports_enabled": True,
            },
        )
        assert sl.status_code == 200, sl.text

        sub = client.post(f"/api/jobs/{job_id}/submit", headers=headers)
        assert sub.status_code == 200, sub.text
        return sub.json()

    # 1) Complete via dev-complete endpoint
    job1 = _submit_job("bracket.stl")
    r_done = client.post(f"/api/jobs/{job1['id']}/dev-complete", headers=headers)
    assert r_done.status_code == 200, r_done.text
    assert len(sent) == 1
    assert sent[0][0] == webhook_url
    assert sent[0][1]["event"] == "print.completed"
    assert sent[0][1]["job"]["id"] == job1["id"]
    assert sent[0][1]["job"]["filename"] == "bracket.stl"

    # 2) Complete via FDM Monster background poller
    job2 = _submit_job("gear.stl")
    fdm_id = job2["fdm_monster_job_id"]
    assert fdm_id in fdm_monster._MOCK_JOBS
    fdm_monster._MOCK_JOBS[fdm_id]["status"] = "COMPLETED"

    with database.SessionLocal() as db:
        updated = asyncio.run(fdm_monster.poll_fdm_monster_once(db))
    assert updated == 1
    assert len(sent) == 2
    assert sent[1][0] == webhook_url
    assert sent[1][1]["event"] == "print.completed"
    assert sent[1][1]["job"]["id"] == job2["id"]
    assert sent[1][1]["job"]["filename"] == "gear.stl"
