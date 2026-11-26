"""Security hardening tests for SSRF protection, JWT revocation, fail-closed secrets, PII, and release URLs."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app import database, main
from app.config import DEFAULT_JWT_SECRET, settings
from app.services import fdm_monster, notifications, updater


@pytest.fixture()
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Isolated TestClient backed by a fresh temp SQLite DB and data dir."""
    test_data_dir = tmp_path / "data"
    test_db_path = test_data_dir / "test_security_auth_ssrf.db"

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


def test_ssrf_blocks_loopback_private_link_local_and_internal_hosts(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
):
    token = _login(client, "2345678", "student123")["access_token"]

    blocked_urls = [
        "http://127.0.0.1:8000/api/health",
        "http://[::1]:8000/api/health",
        "http://localhost/admin",
        "http://10.0.0.5/internal",
        "http://172.16.0.1/hook",
        "http://192.168.1.10/hook",
        "http://169.254.169.254/latest/meta-data/",
        "http://fdm-monster.internal/api",
        "http://printer.local/hook",
    ]
    for url in blocked_urls:
        with pytest.raises(ValueError):
            notifications.normalize_webhook_url(url)

        r_patch = client.patch(
            "/api/auth/notifications",
            headers=_auth(token),
            json={"notify_webhook_url": url},
        )
        assert r_patch.status_code == 422, f"Expected 422 for {url}, got {r_patch.status_code}"

    # Verify _is_discord_webhook rejects suffix spoofing
    assert notifications._is_discord_webhook("https://discord.com/api/webhooks/1/2") is True
    assert notifications._is_discord_webhook("https://ptb.discord.com/api/webhooks/1/2") is True
    assert notifications._is_discord_webhook("https://evildiscord.com/api/webhooks/1/2") is False

    # Verify DNS resolution SSRF block inside post_webhook
    monkeypatch.setattr(
        notifications.socket,
        "getaddrinfo",
        lambda host, port: [(2, 1, 6, "", ("169.254.169.254", 0))],
    )
    r_test = client.post(
        "/api/auth/notifications/test-webhook",
        headers=_auth(token),
        json={"webhook_url": "https://rebind.example.com/hook"},
    )
    assert r_test.status_code == 200
    assert r_test.json()["ok"] is False
    assert r_test.json()["error"] == "Blocked webhook target"


def test_jwt_revocation_on_logout(client: TestClient):
    login_data = _login(client, "2345678", "student123")
    token = login_data["access_token"]

    assert client.get("/api/auth/me", headers=_auth(token)).status_code == 200

    # Logout revokes the token immediately
    r_logout = client.post("/api/auth/logout", headers=_auth(token))
    assert r_logout.status_code == 200

    r_after = client.get("/api/auth/me", headers=_auth(token))
    assert r_after.status_code == 401
    assert r_after.json()["detail"]["code"] == "TOKEN_REVOKED"

    # Fresh login issues a new valid token
    fresh_token = _login(client, "2345678", "student123")["access_token"]
    assert client.get("/api/auth/me", headers=_auth(fresh_token)).status_code == 200


def test_fail_closed_jwt_secret_when_dev_seed_false(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    test_data_dir = tmp_path / "prod_data"
    test_db_path = test_data_dir / "prod.db"
    monkeypatch.setattr(settings, "data_dir", test_data_dir)
    monkeypatch.setattr(settings, "database_url", f"sqlite:///{test_db_path.as_posix()}")
    monkeypatch.setattr(settings, "dev_seed", False)
    monkeypatch.setattr(settings, "jwt_secret", DEFAULT_JWT_SECRET)

    with pytest.raises(RuntimeError, match="JWT_SECRET"):
        with TestClient(main.app):
            pass

    monkeypatch.setattr(settings, "jwt_secret", "too-short")
    with pytest.raises(RuntimeError, match="JWT_SECRET"):
        with TestClient(main.app):
            pass


def test_check_da_does_not_leak_suggested_name(client: TestClient):
    # 2333572 is pre-enrolled in roster with suggested_name="Gabriel"
    r = client.get("/api/auth/check-da/2333572")
    assert r.status_code == 200
    body = r.json()
    assert body["da"] == "2333572"
    assert body["in_roster"] is True
    assert body["is_registered"] is False
    assert body["suggested_name"] is None


def test_updater_rejects_non_github_release_url(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
):
    a_token = _login(client, "admin", "admin123")["access_token"]

    class _FakeResp:
        status_code = 200

        def json(self) -> dict[str, Any]:
            return {
                "tag_name": "v2.0.0",
                "html_url": "javascript:alert(1)",
            }

    class _FakeClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def get(self, url: str, headers: dict[str, str] | None = None):
            return _FakeResp()

    monkeypatch.setattr(updater.httpx, "AsyncClient", _FakeClient)
    r = client.get("/api/admin/system/update-status?force=true", headers=_auth(a_token))
    assert r.status_code == 200
    assert r.json()["release_url"] is None


def test_mock_modes_disabled_and_blocked_when_not_dev(client, monkeypatch):
    """When dev_seed=False, mock modes are rejected via API and never used by adapters."""
    from app.config import settings
    from app.database import SessionLocal
    from app.models import SystemSettings
    from app.services.fdm_monster import LiveFdmMonsterAdapter, get_fdm_adapter
    from app.services.serializers import serialize_settings

    admin_token = _login(client, "admin", "admin123")["access_token"]
    monkeypatch.setattr(settings, "dev_seed", False)

    mode_res = client.get("/api/auth/mode")
    assert mode_res.status_code == 200
    assert mode_res.json()["dev_mode"] is False
    assert mode_res.json()["slicer_mode"] == "orcaslicer"
    assert mode_res.json()["fdm_mode"] == "live"

    bad_slicer = client.patch(
        "/api/admin/settings",
        headers=_auth(admin_token),
        json={"slicer_mode": "mock"},
    )
    assert bad_slicer.status_code == 400
    assert bad_slicer.json()["detail"]["code"] == "MOCK_MODE_DISABLED"

    bad_fdm = client.patch(
        "/api/admin/settings",
        headers=_auth(admin_token),
        json={"fdm_monster_mode": "mock"},
    )
    assert bad_fdm.status_code == 400
    assert bad_fdm.json()["detail"]["code"] == "MOCK_MODE_DISABLED"

    with SessionLocal() as db:
        sys_cfg = db.get(SystemSettings, 1)
        assert sys_cfg is not None
        sys_cfg.slicer_mode = "mock"
        sys_cfg.fdm_monster_mode = "mock"
        db.commit()
        assert isinstance(get_fdm_adapter(sys_cfg), LiveFdmMonsterAdapter)
        serialized = serialize_settings(sys_cfg)
        assert serialized.slicer_mode == "orcaslicer"
        assert serialized.fdm_monster_mode == "live"
