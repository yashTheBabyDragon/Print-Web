"""Tests for production stability hardening (/api/health, SQLite WAL) and GitHub update checker."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from app import database, main
from app.config import settings
from app.services import fdm_monster, updater


@pytest.fixture()
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Isolated TestClient backed by a fresh temp SQLite DB and data dir."""
    test_data_dir = tmp_path / "data"
    test_db_path = test_data_dir / "test_stability.db"

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
    updater.clear_update_cache()

    with TestClient(main.app) as tc:
        yield tc

    test_engine.dispose()


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _login(client: TestClient, identifier: str, password: str) -> dict:
    resp = client.post("/api/auth/login", json={"identifier": identifier, "password": password})
    assert resp.status_code == 200, resp.text
    return resp.json()


def test_health_endpoint_and_sqlite_wal_pragmas(client: TestClient):
    resp = client.get("/api/health")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "ok"
    assert body["service"] == "ggprint-backend"
    assert body["db_ok"] is True
    assert isinstance(body["version"], str) and len(body["version"]) >= 1
    assert isinstance(body["uptime_seconds"], (int, float)) and body["uptime_seconds"] >= 0

    with database.SessionLocal() as db:
        mode = db.execute(text("PRAGMA journal_mode")).scalar()
        busy = db.execute(text("PRAGMA busy_timeout")).scalar()
        fk = db.execute(text("PRAGMA foreign_keys")).scalar()
        assert str(mode).lower() == "wal"
        assert int(busy) == 5000
        assert int(fk) == 1


def test_update_status_available_up_to_date_404_offline_and_rbac(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
):
    a_token = _login(client, "admin", "admin123")["access_token"]
    t_token = _login(client, "m.tremblay@cgodin.qc.ca", "teacher123")["access_token"]

    r_teacher = client.get("/api/admin/system/update-status", headers=_auth(t_token))
    assert r_teacher.status_code == 403
    assert r_teacher.json()["detail"]["required_permission"] == "settings:manage"

    monkeypatch.setattr(settings, "app_version", "1.0.0")
    monkeypatch.setattr(settings, "github_repo", "yashTheBabyDragon/GGPrint-Web")

    class _FakeResp:
        def __init__(self, status_code: int, payload: dict[str, Any] | None = None):
            self.status_code = status_code
            self._payload = payload or {}

        def json(self) -> dict[str, Any]:
            return self._payload

    def _patch_httpx(handler):
        class _FakeClient:
            def __init__(self, *args, **kwargs):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                return False

            async def get(self, url: str, headers: dict[str, str] | None = None):
                return handler(url, headers)

        monkeypatch.setattr(updater.httpx, "AsyncClient", _FakeClient)

    _patch_httpx(
        lambda _u, _h: _FakeResp(
            200,
            {
                "tag_name": "v1.2.0",
                "html_url": "https://github.com/yashTheBabyDragon/GGPrint-Web/releases/tag/v1.2.0",
                "body": "New features!",
                "published_at": "2026-11-24T12:00:00Z",
            },
        )
    )
    r_avail = client.get("/api/admin/system/update-status?force=true", headers=_auth(a_token))
    assert r_avail.status_code == 200, r_avail.text
    d1 = r_avail.json()
    assert d1["current_version"] == "1.0.0"
    assert d1["latest_version"] == "1.2.0"
    assert d1["update_available"] is True
    assert d1["error"] is None
    assert "v1.2.0" in d1["release_url"]

    _patch_httpx(
        lambda _u, _h: _FakeResp(
            200,
            {
                "tag_name": "v1.0.0",
                "html_url": "https://github.com/yashTheBabyDragon/GGPrint-Web/releases/tag/v1.0.0",
            },
        )
    )
    r_same = client.get("/api/admin/system/update-status?force=true", headers=_auth(a_token))
    assert r_same.status_code == 200
    assert r_same.json()["update_available"] is False
    assert r_same.json()["latest_version"] == "1.0.0"

    _patch_httpx(lambda _u, _h: _FakeResp(404))
    r_404 = client.get("/api/admin/system/update-status?force=true", headers=_auth(a_token))
    assert r_404.status_code == 200
    assert r_404.json()["update_available"] is False
    assert r_404.json()["latest_version"] is None
    assert r_404.json()["error"] is None

    def _raise_offline(_u, _h):
        raise httpx.ConnectError("Network unreachable")

    _patch_httpx(_raise_offline)
    r_off = client.get("/api/admin/system/update-status?force=true", headers=_auth(a_token))
    assert r_off.status_code == 200
    assert r_off.json()["update_available"] is False
    assert r_off.json()["error"] is not None
