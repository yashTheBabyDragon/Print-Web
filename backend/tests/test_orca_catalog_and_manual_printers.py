"""Tests for OrcaSlicer .opc / folder catalog engine, manual/catalog printer CRUD, and safe FDM sync."""

from __future__ import annotations

import io
import json
import struct
from pathlib import Path

import pytest
import trimesh
from fastapi.testclient import TestClient

from app import database, main
from app.config import settings
from app.services import fdm_monster
from app.services.orca_catalog import (
    OrcaCatalogIndex,
    clear_orca_catalog_cache,
    extract_machine_metadata,
    parse_opc_file,
)
from app.services.slicer import resolve_and_flatten_profile


@pytest.fixture()
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Create an isolated TestClient backed by a fresh temp SQLite DB and data dir."""
    test_data_dir = tmp_path / "data"
    test_db_path = test_data_dir / "test_ggprint.db"

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


def _login(client: TestClient, da: str, password: str) -> dict[str, str]:
    resp = client.post("/api/auth/login", json={"da": da, "password": password})
    assert resp.status_code == 200, resp.text
    token = resp.json()["access_token"]
    return {"Authorization": f"Bearer {token}"}


def _build_synthetic_opc(out_path: Path) -> None:
    """Write a minimal valid ZCRO v2 .opc file covering base types, vec<enum>, and inheritance."""
    buf = bytearray()

    def w_u64(v: int) -> None:
        buf.extend(struct.pack("<Q", v))

    def w_u32(v: int) -> None:
        buf.extend(struct.pack("<I", v))

    def w_i32(v: int) -> None:
        buf.extend(struct.pack("<i", v))

    def w_u16(v: int) -> None:
        buf.extend(struct.pack("<H", v))

    def w_u8(v: int) -> None:
        buf.append(v)

    def w_f64(v: float) -> None:
        buf.extend(struct.pack("<d", v))

    def w_str(s: str) -> None:
        raw = s.encode("utf-8")
        w_u64(len(raw))
        buf.extend(raw)

    # Header placeholder (filled below)
    buf.extend(b"ZCRO")
    buf.extend(struct.pack("<IQII", 2, 0, 0, 2))

    w_str("TestVendor")
    w_str("1.0.0")

    keys = [
        "printable_area",      # 0 -> vec point (0x4000 | 6)
        "printable_height",    # 1 -> f64 (1)
        "gcode_flavor",        # 2 -> enum (9)
        "nozzle_diameter",     # 3 -> vec f64 (0x4000 | 1)
        "layer_height",        # 4 -> f64 (1)
        "filament_type",       # 5 -> vec str (0x4000 | 3)
        "filament_density",    # 6 -> vec f64 (0x4000 | 1)
        "default_filament_colour",  # 7 -> vec str (0x4000 | 3)
        "extruder_colour",     # 8 -> vec str (0x4000 | 3)
        "compatible_printers", # 9 -> vec str (0x4000 | 3)
    ]
    types = [
        0x4000 | 6,
        1,
        9,
        0x4000 | 1,
        1,
        0x4000 | 3,
        0x4000 | 1,
        0x4000 | 3,
        0x4000 | 3,
        0x4000 | 3,
    ]
    enum_pool = ["", "klipper", "marlin2"]

    w_u64(len(keys))
    for k in keys:
        w_str(k)
    w_u64(len(types))
    for t in types:
        w_u16(t)
    w_u64(len(enum_pool))
    for ep in enum_pool:
        w_str(ep)

    # Vendors (1 vendor, 1 model)
    w_u64(1)
    for s in ("TestVendor", "Test Vendor", "TestVendor", "1.0.0", "", ""):
        w_str(s)
    w_u64(1)  # models count
    w_str("TestLab Pro")
    w_str("TestLab Pro")
    w_str("TestLab")
    w_u8(0)
    w_str("TestMfg")
    w_u64(1)
    w_str("0.4")
    w_u64(1)
    w_str("Lab PLA @TestLab")
    w_u64(0)  # exclude_plates
    w_str("")  # bed_model
    w_str("")  # bed_texture
    for _ in range(7):
        w_str("")
    w_u64(0)
    w_u64(0)

    def _w_meta(inherits: str, instantiation: str) -> None:
        w_str(inherits)
        w_u64(0)
        w_str("")
        w_str(instantiation)
        w_str("SET1")
        w_str("FIL1")
        w_u64(0)

    # SEC 0: Process (1 preset)
    w_u32(1)
    w_str("0.20mm Standard @TestLab")
    w_str("process/0.20mm Standard @TestLab.json")
    w_u32(2)
    w_u16(4)
    w_f64(0.2)
    w_u16(9)
    w_u64(1)
    w_str("TestLab Pro 0.4 nozzle")
    _w_meta("", "true")

    # SEC 1: Filament (base + child inheritance)
    w_u32(2)
    w_str("fdm_filament_common_test")
    w_str("filament/fdm_filament_common_test.json")
    w_u32(2)
    w_u16(5)
    w_u64(1)
    w_str("PETG")
    w_u16(6)
    w_u64(1)
    w_f64(1.27)
    _w_meta("", "false")

    w_str("Lab PETG Orange @TestLab")
    w_str("filament/Lab PETG Orange @TestLab.json")
    w_u32(1)
    w_u16(7)
    w_u64(1)
    w_str("#F97316")
    _w_meta("fdm_filament_common_test", "true")

    # SEC 2: Machine (1 preset, 2 extruders, Klipper flavor)
    w_u32(1)
    w_str("TestLab Pro 0.4 nozzle")
    w_str("machine/TestLab Pro 0.4 nozzle.json")
    w_u32(4)
    w_u16(0)
    w_u64(4)
    for x, y in ((0.0, 0.0), (300.0, 0.0), (300.0, 300.0), (0.0, 300.0)):
        w_f64(x)
        w_f64(y)
    w_u16(1)
    w_f64(320.0)
    w_u16(2)
    w_i32(1)
    w_u16(1)
    w_u16(8)
    w_u64(2)
    w_str("#00A7D9")
    w_str("#F97316")
    _w_meta("", "true")

    w_u32(0)
    w_u32(0)
    out_path.write_bytes(bytes(buf))


def test_opc_parser_catalog_index_and_inheritance_hook(tmp_path: Path) -> None:
    clear_orca_catalog_cache()
    pdir = tmp_path / "profiles"
    pdir.mkdir(parents=True, exist_ok=True)
    opc_file = pdir / "TestVendor.opc"
    _build_synthetic_opc(opc_file)

    bundle = parse_opc_file(opc_file)
    assert bundle.vendor_id == "TestVendor"
    assert len(bundle.models) == 1
    assert bundle.models[0].name == "TestLab Pro"

    idx = OrcaCatalogIndex([pdir])
    detail = idx.get_vendor_detail("TestVendor")
    assert len(detail["models"]) == 1
    assert detail["models"][0]["bed_x_mm"] == 300.0
    assert detail["models"][0]["bed_z_mm"] == 320.0
    assert detail["models"][0]["mmu_slots_count"] == 2
    assert detail["models"][0]["printer_type"] == "klipper"

    flat_fil = idx.flatten_preset("filament", "Lab PETG Orange @TestLab", vendor_id="TestVendor")
    assert flat_fil["filament_type"] == ["PETG"]
    assert flat_fil["filament_density"] == ["1.27"]
    assert flat_fil["default_filament_colour"] == ["#F97316"]
    assert flat_fil["from"] == "User"

    # Verify resolve_and_flatten_profile hooks into .opc archives automatically
    resolved = resolve_and_flatten_profile(
        {"name": "Student PETG", "inherits": "Lab PETG Orange @TestLab"},
        kind="filament",
        extra_search_dirs=[pdir],
    )
    assert "inherits" not in resolved
    assert resolved["filament_type"] == ["PETG"]
    assert resolved["default_filament_colour"] == ["#F97316"]


def test_manual_printer_crud_fdm_link_sync_safety_and_standalone_submit(client: TestClient) -> None:
    admin_hdrs = _login(client, "admin", "admin123")
    reg = client.post(
        "/api/auth/register",
        json={"da": "2333572", "name": "Test Student", "password": "mypassword"},
    )
    assert reg.status_code == 201, reg.text
    student_hdrs = {"Authorization": f"Bearer {reg.json()['access_token']}"}

    # 1. Create a standalone manual printer (no FDM Monster ID)
    create_resp = client.post(
        "/api/admin/printers",
        json={
            "display_name": "Lab Standalone MK4S",
            "printer_type": "prusalink",
            "bed_x_mm": 250.0,
            "bed_y_mm": 210.0,
            "bed_z_mm": 220.0,
            "mmu_slots_count": 2,
            "slot_filament_ids": [1, 2],
        },
        headers=admin_hdrs,
    )
    assert create_resp.status_code == 201, create_resp.text
    created = create_resp.json()
    assert created["is_manual"] is True
    assert created["is_fdm_linked"] is False
    assert created["fdm_monster_id"].startswith("manual-")
    assert created["mmu_slots_count"] == 2
    assert created["slots"][0]["filament_id"] == 1
    assert created["slots"][1]["filament_id"] == 2
    printer_id = created["id"]
    slot_id = created["slots"][0]["id"]

    # 2. Running FDM Monster sync preserves manual/standalone printer and its slots
    sync_resp = client.post("/api/admin/printers/sync", headers=admin_hdrs)
    assert sync_resp.status_code == 200, sync_resp.text
    synced_ids = {p["id"] for p in sync_resp.json()}
    assert printer_id in synced_ids

    # 3. Link manual printer to a unique FDM Monster ID via PATCH, then unlink back to standalone
    link_resp = client.patch(
        f"/api/admin/printers/{printer_id}",
        json={"fdm_monster_id": "custom-lab-fdm-99"},
        headers=admin_hdrs,
    )
    assert link_resp.status_code == 200, link_resp.text
    assert link_resp.json()["is_fdm_linked"] is True
    assert link_resp.json()["fdm_monster_id"] == "custom-lab-fdm-99"

    unlink_resp = client.patch(
        f"/api/admin/printers/{printer_id}",
        json={"fdm_monster_id": ""},
        headers=admin_hdrs,
    )
    assert unlink_resp.status_code == 200, unlink_resp.text
    assert unlink_resp.json()["is_fdm_linked"] is False
    assert unlink_resp.json()["fdm_monster_id"].startswith("manual-")

    # 4. Upload + sync slice on standalone printer, then confirm submit returns PRINTER_NOT_LINKED_FDM
    mesh = trimesh.creation.box(extents=[20.0, 20.0, 20.0])
    stl_buf = io.BytesIO()
    mesh.export(stl_buf, file_type="stl")
    up = client.post(
        "/api/jobs/upload",
        data={"printer_id": str(printer_id), "slot_id": str(slot_id)},
        files={"file": ("cube.stl", stl_buf.getvalue(), "application/octet-stream")},
        headers=student_hdrs,
    )
    assert up.status_code == 201, up.text
    job_id = up.json()["id"]

    sl = client.post(
        f"/api/jobs/{job_id}/slice?sync=true",
        json={"printer_id": printer_id, "slot_id": slot_id, "scale": 1.0, "supports_enabled": False},
        headers=student_hdrs,
    )
    assert sl.status_code == 200, sl.text
    assert sl.json()["status"] == "SLICED"

    sub = client.post(f"/api/jobs/{job_id}/submit", headers=student_hdrs)
    assert sub.status_code == 400
    assert sub.json()["detail"]["code"] == "PRINTER_NOT_LINKED_FDM"


def test_orca_catalog_import_endpoints_with_mocked_catalog_dir(
    client: TestClient,
    tmp_path: Path,
    monkeypatch,
) -> None:
    clear_orca_catalog_cache()
    pdir = tmp_path / "orca_profiles"
    pdir.mkdir(parents=True, exist_ok=True)
    _build_synthetic_opc(pdir / "TestVendor.opc")

    # Point get_orca_catalog used by admin router to our synthetic .opc directory
    from app.services import orca_catalog as oc_mod

    idx = OrcaCatalogIndex([pdir])
    monkeypatch.setattr(oc_mod, "get_orca_catalog", lambda *args, **kwargs: idx)
    monkeypatch.setattr("app.routers.admin.get_orca_catalog", lambda *args, **kwargs: idx)

    admin_hdrs = _login(client, "admin", "admin123")

    vendors_resp = client.get("/api/admin/orca-catalog/vendors", headers=admin_hdrs)
    assert vendors_resp.status_code == 200
    assert any(v["id"] == "TestVendor" for v in vendors_resp.json())

    detail_resp = client.get("/api/admin/orca-catalog/vendors/TestVendor", headers=admin_hdrs)
    assert detail_resp.status_code == 200
    detail = detail_resp.json()
    assert detail["models"][0]["bed_x_mm"] == 300.0
    assert detail["filaments"][0]["preset_name"] == "Lab PETG Orange @TestLab"

    imp_resp = client.post(
        "/api/admin/orca-catalog/import-printer",
        json={
            "vendor": "TestVendor",
            "machine_preset_name": "TestLab Pro 0.4 nozzle",
            "process_preset_name": "0.20mm Standard @TestLab",
            "filament_preset_names": ["Lab PETG Orange @TestLab"],
            "display_name": "Catalog Imported Klipper",
        },
        headers=admin_hdrs,
    )
    assert imp_resp.status_code == 200, imp_resp.text
    imp = imp_resp.json()
    assert imp["printer"]["display_name"] == "Catalog Imported Klipper"
    assert imp["printer"]["printer_type"] == "klipper"
    assert imp["printer"]["mmu_slots_count"] == 2
    assert imp["printer"]["is_fdm_linked"] is False
    assert imp["machine_profile"]["kind"] == "machine"
    assert imp["process_profile"]["kind"] == "process"
    assert len(imp["filaments"]) == 1
    assert imp["filaments"][0]["material"] == "PETG"
    from app.database import SessionLocal
    from app.models import OrcaProfile

    with SessionLocal() as db:
        prof = db.get(OrcaProfile, imp["machine_profile"]["id"])
        assert prof is not None
        assert json.loads(Path(prof.file_path).read_text(encoding="utf-8"))["gcode_flavor"] == "klipper"
