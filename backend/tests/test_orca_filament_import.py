"""Tests for OrcaSlicer filament import (.json, .orca_filament, .zip, upsert, validation, RBAC)."""

from __future__ import annotations

import io
import json
import zipfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import database, main
from app.config import settings
from app.services import fdm_monster


@pytest.fixture()
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Isolated TestClient backed by a fresh temp SQLite DB and data dir."""
    test_data_dir = tmp_path / "data"
    test_db_path = test_data_dir / "test_orca_filament_import.db"

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


def _orca_filament_bytes(
    *,
    name: str,
    material: str = "PLA",
    density: str = "1.24",
    color: str = "#E11D48",
) -> bytes:
    payload = {
        "type": "filament",
        "from": "User",
        "instantiation": "true",
        "version": "2.2.0.0",
        "name": name,
        "filament_settings_id": [name],
        "filament_type": [material],
        "filament_density": [density],
        "default_filament_colour": [color],
        "nozzle_temperature": ["215"],
        "textured_plate_temp": ["60"],
    }
    return json.dumps(payload).encode("utf-8")


def test_import_single_orca_json_and_upsert(client: TestClient):
    a_token = _login(client, "admin", "admin123")["access_token"]

    # 1. Import a single OrcaSlicer filament JSON
    raw = _orca_filament_bytes(name="Polymaker PolyLite PLA Red", material="PLA", density="1.25", color="#DC2626")
    resp = client.post(
        "/api/admin/filaments/import-orca",
        headers=_auth(a_token),
        files=[("files", ("polymaker_red.json", raw, "application/json"))],
        data={"update_existing": "true"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["created_count"] == 1
    assert body["updated_count"] == 0
    assert body["skipped_count"] == 0
    assert len(body["imported"]) == 1

    item = body["imported"][0]
    assert item["action"] == "created"
    assert item["filename"] == "polymaker_red.json"
    assert item["filament"]["name"] == "Polymaker PolyLite PLA Red"
    assert item["filament"]["material"] == "PLA"
    assert item["filament"]["density_g_cm3"] == pytest.approx(1.25)
    assert item["filament"]["color_hex"] == "#DC2626"
    assert item["filament"]["filament_profile_id"] == item["profile"]["id"]
    assert item["profile"]["kind"] == "filament"

    # 2. Re-import with updated density & color and update_existing=True -> updated
    raw_v2 = _orca_filament_bytes(name="polymaker polylite pla red", material="PLA+", density="1.27", color="#B91C1C")
    resp_upd = client.post(
        "/api/admin/filaments/import-orca",
        headers=_auth(a_token),
        files=[("files", ("polymaker_red_v2.json", raw_v2, "application/json"))],
        data={"update_existing": "true"},
    )
    assert resp_upd.status_code == 200, resp_upd.text
    upd_body = resp_upd.json()
    assert upd_body["created_count"] == 0
    assert upd_body["updated_count"] == 1
    assert upd_body["imported"][0]["action"] == "updated"
    assert upd_body["imported"][0]["filament"]["id"] == item["filament"]["id"]
    assert upd_body["imported"][0]["filament"]["material"] == "PLA+"
    assert upd_body["imported"][0]["filament"]["color_hex"] == "#B91C1C"

    # 3. Re-import with update_existing=False -> skipped
    resp_skip = client.post(
        "/api/admin/filaments/import-orca",
        headers=_auth(a_token),
        files=[("files", ("polymaker_red_v2.json", raw_v2, "application/json"))],
        data={"update_existing": "false"},
    )
    assert resp_skip.status_code == 200
    assert resp_skip.json()["skipped_count"] == 1
    assert resp_skip.json()["created_count"] == 0


def test_import_multi_file_and_orca_filament_zip_with_skipped_invalid(client: TestClient):
    a_token = _login(client, "admin", "admin123")["access_token"]

    # Build an .orca_filament ZIP bundle containing 2 valid filament JSONs + 1 machine profile
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("petg_cyan.json", _orca_filament_bytes(name="Prusament PETG Cyan", material="PETG", density="1.27", color="#06B6D4"))
        zf.writestr("tpu_black.json", _orca_filament_bytes(name="Overture TPU 95A", material="TPU", density="1.21", color="#111827"))
        zf.writestr("machine_wrong.json", json.dumps({"type": "machine", "name": "Voron"}).encode("utf-8"))
    bundle_bytes = buf.getvalue()

    standalone_json = _orca_filament_bytes(name="eSUN ABS White", material="ABS", density="1.05", color="#F8FAFC")
    bad_json = b"{not valid json"

    resp = client.post(
        "/api/admin/filaments/import-orca",
        headers=_auth(a_token),
        files=[
            ("files", ("pack.orca_filament", bundle_bytes, "application/octet-stream")),
            ("files", ("esun_abs.json", standalone_json, "application/json")),
            ("files", ("broken.json", bad_json, "application/json")),
        ],
        data={"update_existing": "true"},
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["created_count"] == 3
    assert data["updated_count"] == 0
    assert data["skipped_count"] == 2
    imported_names = {i["filament"]["name"] for i in data["imported"]}
    assert imported_names == {"Prusament PETG Cyan", "Overture TPU 95A", "eSUN ABS White"}
    skipped_files = {s["filename"] for s in data["skipped"]}
    assert skipped_files == {"machine_wrong.json", "broken.json"}


def test_import_orca_filaments_rbac_and_empty_validation(client: TestClient):
    t_token = _login(client, "m.tremblay@example.edu", "teacher123")["access_token"]
    a_token = _login(client, "admin", "admin123")["access_token"]

    raw = _orca_filament_bytes(name="Blocked Filament")
    r_teacher = client.post(
        "/api/admin/filaments/import-orca",
        headers=_auth(t_token),
        files=[("files", ("blocked.json", raw, "application/json"))],
    )
    assert r_teacher.status_code == 403
    assert r_teacher.json()["detail"]["required_permission"] == "filaments:create_delete"

    # No files provided -> 400
    r_empty = client.post(
        "/api/admin/filaments/import-orca",
        headers=_auth(a_token),
        data={"update_existing": "true"},
    )
    assert r_empty.status_code == 400
    assert r_empty.json()["detail"]["code"] == "NO_FILES"
