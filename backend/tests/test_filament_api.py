"""Unit and integration tests for FilamentAPI HTTP client, matching, poller, and error resilience."""

from __future__ import annotations

import asyncio
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app import database, main
from app.config import settings
from app.models import Filament, Printer, PrinterSlot, SystemSettings
from app.services import fdm_monster, filament_api
from app.services.filament_api import (
    FilamentApiClient,
    FilamentApiError,
    match_filament_in_catalog,
    poll_filament_api_once,
)


@pytest.fixture()
def isolated_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Isolated SQLite DB + FastAPI TestClient."""
    test_data_dir = tmp_path / "data"
    test_db_path = test_data_dir / "test_filament_api.db"

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
        yield tc, test_session_local

    test_engine.dispose()


def _patch_httpx_transport(monkeypatch: pytest.MonkeyPatch, handler):
    transport = httpx.MockTransport(handler)
    real_async_client = httpx.AsyncClient

    def _mock_async_client(*args, **kwargs):
        kwargs["transport"] = transport
        return real_async_client(*args, **kwargs)

    monkeypatch.setattr(filament_api.httpx, "AsyncClient", _mock_async_client)


def test_filament_api_client_http_endpoints(monkeypatch: pytest.MonkeyPatch):
    """Verify FilamentApiClient calls /health, /printers, and /filament/{id} and handles errors."""

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/health":
            return httpx.Response(
                200,
                json={"status": "ok", "printers_configured": 2, "uptime_seconds": 99.5},
            )
        if request.url.path == "/printers":
            return httpx.Response(
                200,
                json={
                    "printers": [
                        {"id": "klip", "type": "klipper", "host": "http://pi-klipper2.local"},
                        {"id": "prusa-1", "type": "prusalink", "host": "http://192.168.4.232"},
                    ]
                },
            )
        if request.url.path == "/filament/klip":
            return httpx.Response(
                200,
                json={"printer_id": "klip", "type": "klipper", "filament": "PLA"},
            )
        if request.url.path == "/filament/prusa-1":
            return httpx.Response(
                200,
                json={"printer_id": "prusa-1", "type": "prusalink", "filament": None},
            )
        if request.url.path == "/filament/unknown":
            return httpx.Response(404, json={"error": "unknown printer"})
        if request.url.path == "/filament/offline":
            return httpx.Response(502, json={"error": "printer unreachable"})
        return httpx.Response(404)

    _patch_httpx_transport(monkeypatch, handler)
    client = FilamentApiClient("http://filament-api.local:8000/")

    health = asyncio.run(client.check_health())
    assert health.ok is True
    assert health.printers_configured == 2
    assert health.uptime_seconds == 99.5
    assert [p.id for p in health.printers] == ["klip", "prusa-1"]

    printers = asyncio.run(client.list_printers())
    assert len(printers) == 2
    assert printers[0].type == "klipper"

    assert asyncio.run(client.get_filament("klip")) == "PLA"
    assert asyncio.run(client.get_filament("prusa-1")) is None

    with pytest.raises(FilamentApiError, match="not found"):
        asyncio.run(client.get_filament("unknown"))

    with pytest.raises(FilamentApiError):
        asyncio.run(client.get_filament("offline"))


def test_match_filament_catalog_priorities(isolated_env):
    """Verify exact name > preserve current material > exact material > substring fallback."""
    _tc, session_local = isolated_env
    with session_local() as db:
        pla_bleu = db.scalar(select(Filament).where(Filament.name == "PLA Bleu Print-Web"))
        assert pla_bleu is not None

        # Exact name match beats material preservation
        matched_exact = match_filament_in_catalog(db, "pla vert", current_filament=pla_bleu)
        assert matched_exact is not None
        assert matched_exact.name == "PLA Vert"

        # Preserves current filament when material matches generic string
        matched_keep = match_filament_in_catalog(db, "PLA", current_filament=pla_bleu)
        assert matched_keep is not None
        assert matched_keep.id == pla_bleu.id

        # Exact material match switches when current filament has different material
        matched_petg = match_filament_in_catalog(db, "PETG", current_filament=pla_bleu)
        assert matched_petg is not None
        assert matched_petg.material == "PETG"

        # Substring fallback (e.g. "Prusament PETG" or "PLA+")
        matched_sub = match_filament_in_catalog(db, "Prusament PETG")
        assert matched_sub is not None
        assert matched_sub.material == "PETG"

        # Unknown material returns None
        assert match_filament_in_catalog(db, "PEEK-CF") is None
        assert match_filament_in_catalog(db, None) is None


def test_poll_filament_api_once_and_slice_fallback_on_error(
    isolated_env,
    monkeypatch: pytest.MonkeyPatch,
):
    """Background poller updates mapped printers, and slice gracefully falls back if API errors."""
    tc, session_local = isolated_env

    # Enable FilamentAPI and map Prusa MK3.5
    with session_local() as db:
        cfg = db.get(SystemSettings, 1)
        assert cfg is not None
        cfg.filament_api_enabled = True
        cfg.filament_api_url = "http://filament-api:8000"

        mk35 = db.scalar(select(Printer).where(Printer.fdm_monster_id == "prusalink-mk35-1"))
        assert mk35 is not None
        mk35.filament_api_printer_id = "prusa-mk35"
        db.commit()

    def ok_handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/filament/prusa-mk35":
            return httpx.Response(200, json={"printer_id": "prusa-mk35", "type": "prusalink", "filament": "PETG"})
        return httpx.Response(404)

    _patch_httpx_transport(monkeypatch, ok_handler)

    with session_local() as db:
        changed = asyncio.run(poll_filament_api_once(db))
        assert changed == 1

        mk35 = db.scalar(select(Printer).where(Printer.fdm_monster_id == "prusalink-mk35-1"))
        assert mk35 is not None
        slot = db.scalar(select(PrinterSlot).where(PrinterSlot.printer_id == mk35.id, PrinterSlot.slot_index == 1))
        assert slot is not None
        assert slot.filament is not None
        assert slot.filament.material == "PETG"
        mk35_id = mk35.id
        slot_id = slot.id

    # Now make FilamentAPI return 502; slicing should still succeed with the last-known PETG filament
    def err_handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(502, json={"error": "upstream printer timeout"})

    _patch_httpx_transport(monkeypatch, err_handler)

    student_token = tc.post("/api/auth/login", json={"da": "2345678", "password": "student123"}).json()["access_token"]
    headers = {"Authorization": f"Bearer {student_token}"}

    import io
    import trimesh

    buf = io.BytesIO()
    trimesh.creation.box(extents=[20.0, 20.0, 20.0]).export(buf, file_type="stl")

    r_up = tc.post(
        "/api/jobs/upload",
        headers=headers,
        files={"file": ("cube.stl", buf.getvalue(), "application/octet-stream")},
        data={"printer_id": str(mk35_id), "slot_id": str(slot_id)},
    )
    assert r_up.status_code == 201
    job_id = r_up.json()["id"]

    r_slice = tc.post(
        f"/api/jobs/{job_id}/slice",
        headers=headers,
        json={
            "printer_id": mk35_id,
            "slot_id": slot_id,
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
    assert r_slice.status_code == 200, r_slice.text
    assert r_slice.json()["filament_material"] == "PETG"
