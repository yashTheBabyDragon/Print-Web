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
    assert body["service"] == "print-web-backend"
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
    t_token = _login(client, "m.tremblay@example.edu", "teacher123")["access_token"]

    r_teacher = client.get("/api/admin/system/update-status", headers=_auth(t_token))
    assert r_teacher.status_code == 403
    assert r_teacher.json()["detail"]["code"] == "SUPER_ADMIN_REQUIRED"

    monkeypatch.setattr(settings, "app_version", "1.0.0")
    monkeypatch.setattr(settings, "github_repo", "yashTheBabyDragon/Print-Web")

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
                "html_url": "https://github.com/yashTheBabyDragon/Print-Web/releases/tag/v1.2.0",
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
                "html_url": "https://github.com/yashTheBabyDragon/Print-Web/releases/tag/v1.0.0",
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


def test_update_trigger_rbac_validation_and_file_queue(
    client: TestClient,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    a_token = _login(client, "admin", "admin123")["access_token"]
    t_login = _login(client, "m.tremblay@example.edu", "teacher123")
    t_token = t_login["access_token"]
    teacher_id = t_login["user"]["id"]

    # 1. Default teacher -> 403 SUPER_ADMIN_REQUIRED on update-trigger
    r_t_forbid = client.post(
        "/api/admin/system/update-trigger",
        headers=_auth(t_token),
        json={"target_version": "v1.2.0"},
    )
    assert r_t_forbid.status_code == 403
    assert r_t_forbid.json()["detail"]["code"] == "SUPER_ADMIN_REQUIRED"

    # 2. Updater not configured -> 400 UPDATER_NOT_CONFIGURED
    monkeypatch.setattr(settings, "updater_dir", None)
    r_unconf = client.post(
        "/api/admin/system/update-trigger",
        headers=_auth(a_token),
        json={"target_version": "v1.2.0"},
    )
    assert r_unconf.status_code == 400
    assert r_unconf.json()["detail"]["code"] == "UPDATER_NOT_CONFIGURED"

    # Configure updater_dir
    upd_dir = tmp_path / "updater"
    upd_dir.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(settings, "updater_dir", str(upd_dir))

    # 3. Invalid tag -> 400 INVALID_VERSION_TAG
    r_bad_tag = client.post(
        "/api/admin/system/update-trigger",
        headers=_auth(a_token),
        json={"target_version": "v1.2.0; rm -rf /"},
    )
    assert r_bad_tag.status_code == 400
    assert r_bad_tag.json()["detail"]["code"] == "INVALID_VERSION_TAG"

    # 4. Admin triggers update -> 202 and writes request.json + status.json
    r_ok = client.post(
        "/api/admin/system/update-trigger",
        headers=_auth(a_token),
        json={"target_version": "v1.2.0"},
    )
    assert r_ok.status_code == 202, r_ok.text
    job = r_ok.json()
    assert job["state"] == "queued"
    assert job["target_version"] == "v1.2.0"
    assert (upd_dir / "request.json").is_file()
    assert (upd_dir / "status.json").is_file()

    # 5. Concurrent trigger while queued -> 409 UPDATE_IN_PROGRESS
    r_dup = client.post(
        "/api/admin/system/update-trigger",
        headers=_auth(a_token),
        json={"target_version": "v1.3.0"},
    )
    assert r_dup.status_code == 409
    assert r_dup.json()["detail"]["code"] == "UPDATE_IN_PROGRESS"

    # 6. Admin-only updates:manage cannot be delegated to a teacher, and trigger stays SUPER_ADMIN_REQUIRED
    (upd_dir / "status.json").write_text('{"state": "succeeded", "target_version": "v1.2.0"}', encoding="utf-8")
    r_grant = client.patch(
        f"/api/admin/teachers/{teacher_id}",
        headers=_auth(a_token),
        json={"permissions": ["updates:manage"]},
    )
    assert r_grant.status_code == 403
    assert r_grant.json()["detail"]["code"] == "ADMIN_ONLY_PERMISSION"

    assert client.get("/api/admin/settings", headers=_auth(t_token)).status_code == 403
    r_t_denied = client.post(
        "/api/admin/system/update-trigger",
        headers=_auth(t_token),
        json={"target_version": "v1.3.0"},
    )
    assert r_t_denied.status_code == 403
    assert r_t_denied.json()["detail"]["code"] == "SUPER_ADMIN_REQUIRED"


def test_update_trigger_allows_stale_job_and_reports_write_errors(
    client: TestClient,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    import json

    a_token = _login(client, "admin", "admin123")["access_token"]
    upd_dir = tmp_path / "updater"
    upd_dir.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(settings, "updater_dir", str(upd_dir))

    # 1. Stale queued status (>15 min old) should NOT lock out future updates
    (upd_dir / "status.json").write_text(
        json.dumps(
            {
                "state": "queued",
                "target_version": "0.1.4",
                "requested_by": "admin",
                "updated_at": "2020-01-01T00:00:00+00:00",
                "message": "Update to 0.1.4 queued.",
            }
        ),
        encoding="utf-8",
    )
    (upd_dir / "request.json").write_text('{"target_version": "0.1.4"}', encoding="utf-8")

    st_before = client.get("/api/admin/system/update-status?force=false", headers=_auth(a_token))
    assert st_before.status_code == 200
    assert "print-web-update.path" in (st_before.json()["update_job"]["message"] or "")

    r_requeue = client.post(
        "/api/admin/system/update-trigger",
        headers=_auth(a_token),
        json={"target_version": "0.1.5"},
    )
    assert r_requeue.status_code == 202, r_requeue.text
    assert r_requeue.json()["target_version"] == "0.1.5"
    assert r_requeue.json()["state"] == "queued"

    # 2. Simulate host permission/write failure -> clean 500 UPDATER_WRITE_FAILED JSON error
    (upd_dir / "status.json").write_text('{"state": "succeeded"}', encoding="utf-8")

    def _fail_write_text(self, *args, **kwargs):  # noqa: ANN001
        raise PermissionError(1, "Operation not permitted")

    monkeypatch.setattr(Path, "write_text", _fail_write_text)
    r_perm = client.post(
        "/api/admin/system/update-trigger",
        headers=_auth(a_token),
        json={"target_version": "0.1.6"},
    )
    assert r_perm.status_code == 500
    assert r_perm.json()["detail"]["code"] == "UPDATER_WRITE_FAILED"


def test_install_orcaslicer_script_discovery_fallback_and_notice(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    import importlib.util
    import json

    script_path = Path(__file__).resolve().parents[1] / "scripts" / "install_orcaslicer.py"
    spec = importlib.util.spec_from_file_location("install_orcaslicer", script_path)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)

    assert mod.score_asset("OrcaSlicer_Linux_AppImage_Ubuntu2404_V2.5.2.AppImage", arch="x86_64") == 3
    assert mod.score_asset("OrcaSlicer_Linux_AppImage_Ubuntu2404_aarch64_V2.5.2.AppImage", arch="x86_64") == -1
    assert mod.score_asset("OrcaSlicer-Linux-flatpak_V2.5.2_x86_64.flatpak", arch="x86_64") == -1
    assert mod.score_asset("OrcaSlicer_Linux_AppImage_Ubuntu2404_aarch64_V2.5.2.AppImage", arch="aarch64") == 3
    assert mod.score_asset("OrcaSlicer_Linux_AppImage_Ubuntu2404_V2.5.2.AppImage", arch="aarch64") == -1

    class _FakeResp:
        def __init__(self, body: bytes, final_url: str = ""):
            self._body = body
            self._url = final_url

        def read(self) -> bytes:
            return self._body

        def geturl(self) -> str:
            return self._url

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

    def _fake_urlopen_web(req, timeout=30):  # noqa: ANN001
        url = req.full_url if hasattr(req, "full_url") else str(req)
        if url.endswith("/releases/latest"):
            return _FakeResp(b"", "https://github.com/OrcaSlicer/OrcaSlicer/releases/tag/v2.5.2")
        if url.endswith("/releases/expanded_assets/v2.5.2"):
            html = (
                '<a href="/OrcaSlicer/OrcaSlicer/releases/download/v2.5.2/OrcaSlicer_Linux_AppImage_Ubuntu2404_aarch64_V2.5.2.AppImage">arm</a>'
                '<a href="/OrcaSlicer/OrcaSlicer/releases/download/v2.5.2/OrcaSlicer_Linux_AppImage_Ubuntu2404_V2.5.2.AppImage">x64</a>'
            ).encode("utf-8")
            return _FakeResp(html, url)
        raise AssertionError(f"Unexpected URL: {url}")

    monkeypatch.setattr(mod.urllib.request, "urlopen", _fake_urlopen_web)
    tag, asset_name, dl_url = mod.resolve_release_asset("latest", arch="x86_64")
    assert tag == "v2.5.2"
    assert asset_name == "OrcaSlicer_Linux_AppImage_Ubuntu2404_V2.5.2.AppImage"
    assert dl_url == "https://github.com/OrcaSlicer/OrcaSlicer/releases/download/v2.5.2/OrcaSlicer_Linux_AppImage_Ubuntu2404_V2.5.2.AppImage"

    tag_arm, asset_arm, _ = mod.resolve_release_asset("latest", arch="aarch64")
    assert tag_arm == "v2.5.2"
    assert asset_arm == "OrcaSlicer_Linux_AppImage_Ubuntu2404_aarch64_V2.5.2.AppImage"

    # Fallback to REST API when web discovery raises
    def _fake_urlopen_api_fallback(req, timeout=30):  # noqa: ANN001
        url = req.full_url if hasattr(req, "full_url") else str(req)
        if "github.com/OrcaSlicer/OrcaSlicer/releases" in url:
            raise OSError("HTML fetch failed")
        payload = json.dumps(
            {
                "tag_name": "v2.5.1",
                "assets": [
                    {
                        "name": "OrcaSlicer_Linux_AppImage_Ubuntu2204_V2.5.1.AppImage",
                        "browser_download_url": "https://example.invalid/orca-2.5.1.AppImage",
                    }
                ],
            }
        ).encode("utf-8")
        return _FakeResp(payload, url)

    monkeypatch.setattr(mod.urllib.request, "urlopen", _fake_urlopen_api_fallback)
    tag2, asset2, dl2 = mod.resolve_release_asset("latest", arch="x86_64")
    assert (tag2, asset2, dl2) == (
        "v2.5.1",
        "OrcaSlicer_Linux_AppImage_Ubuntu2204_V2.5.1.AppImage",
        "https://example.invalid/orca-2.5.1.AppImage",
    )

    notice_path = tmp_path / "ORCASLICER_SOURCE_NOTICE.txt"
    mod.write_source_notice(notice_path, tag, asset_name, dl_url)
    notice_txt = notice_path.read_text(encoding="utf-8")
    assert "AGPL-3.0" in notice_txt
    assert "v2.5.2" in notice_txt
    assert "archive/refs/tags/v2.5.2.tar.gz" in notice_txt
