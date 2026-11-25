"""Comprehensive integration and unit tests for the GGPrint backend."""

from __future__ import annotations

import io
import json
import math
import zipfile
from pathlib import Path

import numpy as np
import pytest
import trimesh
from fastapi.testclient import TestClient

from app import database, main
from app.config import detect_orca_cli_path, settings
from app.models import OrcaProfile, PrintJob, Printer, PrinterSlot
from app.services import fdm_monster
from app.services.profiles import save_profile_file
from app.services.slicer import OrcaSlicerCliAdapter, resolve_and_flatten_profile


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


def _auth_header(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _login(client: TestClient, da: str, password: str) -> dict:
    resp = client.post("/api/auth/login", json={"da": da, "password": password})
    assert resp.status_code == 200, resp.text
    return resp.json()


def _make_stl_bytes(extents=(30.0, 25.0, 20.0), tilt_deg=(0.0, 0.0)) -> bytes:
    """Create a valid binary STL mesh in memory."""
    mesh = trimesh.creation.box(extents=list(extents))
    rx, ry = tilt_deg
    if abs(rx) > 1e-6:
        mesh.apply_transform(trimesh.transformations.rotation_matrix(math.radians(rx), [1, 0, 0]))
    if abs(ry) > 1e-6:
        mesh.apply_transform(trimesh.transformations.rotation_matrix(math.radians(ry), [0, 1, 0]))
    buf = io.BytesIO()
    mesh.export(buf, file_type="stl")
    return buf.getvalue()


def test_health_and_auth_mode(client: TestClient):
    r_health = client.get("/api/health")
    assert r_health.status_code == 200
    assert r_health.json()["status"] == "ok"

    r_mode = client.get("/api/auth/mode")
    assert r_mode.status_code == 200
    body = r_mode.json()
    assert body["dev_mode"] is True
    assert body["slicer_mode"] == "mock"
    assert body["fdm_mode"] == "mock"
    assert body["needs_setup"] is False
    assert "Gérald-Godin" in body["institution"]


def test_registration_whitelist_and_duplicate_da(client: TestClient):
    # Unlisted DA without teacher_id -> 400 TEACHER_REQUIRED
    r_bad = client.post(
        "/api/auth/register",
        json={"da": "9999999", "name": "Intruder", "password": "secret123"},
    )
    assert r_bad.status_code == 400
    assert r_bad.json()["detail"]["code"] == "TEACHER_REQUIRED"

    # Enrolled DA 2333572 -> 201 auto-approved
    r_ok = client.post(
        "/api/auth/register",
        json={"da": "2333572", "name": "Gabriel", "password": "mypassword"},
    )
    assert r_ok.status_code == 201, r_ok.text
    data = r_ok.json()
    assert data["token_type"] == "bearer"
    assert data["pending_approval"] is False
    assert data["access_token"] is not None
    assert data["user"]["da"] == "2333572"
    assert data["user"]["role"] == "student"
    assert data["user"]["approval_status"] == "approved"
    assert data["user"]["effective_max_active_grams"] == 100.0
    assert data["user"]["available_grams"] == 100.0
    assert len(data["user"]["teachers"]) == 1

    # Duplicate DA -> 409
    r_dup = client.post(
        "/api/auth/register",
        json={"da": "2333572", "name": "Gabriel 2", "password": "otherpassword"},
    )
    assert r_dup.status_code == 409
    assert r_dup.json()["detail"]["code"] == "DA_ALREADY_REGISTERED"

    # Login with newly created account
    r_login = _login(client, "2333572", "mypassword")
    assert r_login["user"]["name"] == "Gabriel"


def test_seeded_printers_and_samples(client: TestClient):
    student_auth = _login(client, "2345678", "student123")
    token = student_auth["access_token"]

    r_printers = client.get("/api/printers", headers=_auth_header(token))
    assert r_printers.status_code == 200
    printers = r_printers.json()
    assert len(printers) == 5

    klippers = [p for p in printers if p["printer_type"] == "klipper"]
    prusas = [p for p in printers if p["printer_type"] == "prusalink"]
    assert len(klippers) == 2
    assert len(prusas) == 3

    voron = next(p for p in printers if p["fdm_monster_id"] == "klipper-voron-1")
    assert voron["has_mmu"] is True
    assert voron["mmu_slots_count"] == 4
    assert len(voron["slots"]) == 4
    assert all(s["color_hex"].startswith("#") for s in voron["slots"])

    r_samples = client.get("/api/samples")
    assert r_samples.status_code == 200
    samples = r_samples.json()
    sample_ids = {s["id"] for s in samples}
    assert "tilted-bracket.stl" in sample_ids
    assert "oversized-housing.stl" in sample_ids

    r_dl = client.get("/api/samples/tilted-bracket.stl")
    assert r_dl.status_code == 200
    assert len(r_dl.content) > 84


def test_upload_auto_orient_transform_slice_and_bounds(client: TestClient):
    student_auth = _login(client, "2345678", "student123")
    token = student_auth["access_token"]
    printers = client.get("/api/printers", headers=_auth_header(token)).json()
    voron = next(p for p in printers if p["fdm_monster_id"] == "klipper-voron-1")
    slot = voron["slots"][2]  # PLA Bleu Gérald-Godin

    # Upload real tilted sample STL (or synthetic tilted mesh)
    sample_resp = client.get("/api/samples/tilted-bracket.stl")
    stl_bytes = sample_resp.content

    r_up = client.post(
        "/api/jobs/upload",
        headers=_auth_header(token),
        files={"file": ("tilted-bracket.stl", stl_bytes, "model/stl")},
        data={"printer_id": str(voron["id"]), "slot_id": str(slot["id"])},
    )
    assert r_up.status_code == 201, r_up.text
    job = r_up.json()
    assert job["status"] == "DRAFT"
    assert job["bbox"]["min_z"] == pytest.approx(0.0, abs=0.05)
    # Centered XY around 0
    mid_x = 0.5 * (job["bbox"]["min_x"] + job["bbox"]["max_x"])
    mid_y = 0.5 * (job["bbox"]["min_y"] + job["bbox"]["max_y"])
    assert mid_x == pytest.approx(0.0, abs=0.1)
    assert mid_y == pytest.approx(0.0, abs=0.1)

    # Fetch oriented mesh
    r_mesh = client.get(job["oriented_mesh_url"], headers=_auth_header(token))
    assert r_mesh.status_code == 200
    assert len(r_mesh.content) > 84

    # Out-of-bounds slice check (move X far beyond +-150mm bed)
    r_oob = client.post(
        f"/api/jobs/{job['id']}/slice",
        headers=_auth_header(token),
        json={
            "printer_id": voron["id"],
            "slot_id": slot["id"],
            "pos_x_mm": 148.0,
            "pos_y_mm": 0.0,
            "quat_x": 0.0,
            "quat_y": 0.0,
            "quat_z": 0.0,
            "quat_w": 1.0,
            "scale": 1.0,
        },
    )
    assert r_oob.status_code == 400
    assert r_oob.json()["detail"]["code"] == "OUT_OF_BOUNDS"

    # Valid transform + slice (rotated 45 deg around Z, scaled 0.9, shifted +15mm X)
    angle = math.radians(45.0)
    r_slice = client.post(
        f"/api/jobs/{job['id']}/slice?sync=true",
        headers=_auth_header(token),
        json={
            "printer_id": voron["id"],
            "slot_id": slot["id"],
            "pos_x_mm": 15.0,
            "pos_y_mm": -10.0,
            "quat_x": 0.0,
            "quat_y": 0.0,
            "quat_z": math.sin(angle / 2.0),
            "quat_w": math.cos(angle / 2.0),
            "scale": 0.9,
        },
    )
    assert r_slice.status_code == 200, r_slice.text
    sliced = r_slice.json()
    assert sliced["status"] == "SLICED"
    assert sliced["supports_enabled"] is True
    assert sliced["estimated_grams"] > 0
    assert sliced["estimated_minutes"] >= 5
    assert sliced["layer_count"] >= 1
    assert sliced["gcode_filename"].endswith(".gcode")
    assert sliced["budget_check"]["can_auto_submit"] is True

    # Reorient resets transform back to identity
    r_reorient = client.post(f"/api/jobs/{job['id']}/reorient", headers=_auth_header(token))
    assert r_reorient.status_code == 200
    reoriented = r_reorient.json()
    assert reoriented["status"] == "DRAFT"
    assert reoriented["pos_x_mm"] == 0.0
    assert reoriented["scale"] == 1.0


def test_within_budget_submit_and_dev_complete_auto_refund(client: TestClient):
    student_auth = _login(client, "2345678", "student123")
    token = student_auth["access_token"]
    printers = client.get("/api/printers", headers=_auth_header(token)).json()
    mk4s = next(p for p in printers if p["fdm_monster_id"] == "prusalink-mk4s-1")
    slot = mk4s["slots"][0]

    stl_bytes = _make_stl_bytes(extents=(30.0, 30.0, 25.0))
    job = client.post(
        "/api/jobs/upload",
        headers=_auth_header(token),
        files={"file": ("small_block.stl", stl_bytes, "model/stl")},
        data={"printer_id": str(mk4s["id"]), "slot_id": str(slot["id"])},
    ).json()

    sliced = client.post(
        f"/api/jobs/{job['id']}/slice?sync=true",
        headers=_auth_header(token),
        json={
            "printer_id": mk4s["id"],
            "slot_id": slot["id"],
            "pos_x_mm": 0.0,
            "pos_y_mm": 0.0,
            "quat_x": 0.0,
            "quat_y": 0.0,
            "quat_z": 0.0,
            "quat_w": 1.0,
            "scale": 1.0,
        },
    ).json()
    grams = sliced["estimated_grams"]
    assert grams < 100.0

    submitted = client.post(f"/api/jobs/{job['id']}/submit", headers=_auth_header(token))
    assert submitted.status_code == 200, submitted.text
    sub_data = submitted.json()
    assert sub_data["status"] in ("QUEUED", "PRINTING")
    assert sub_data["fdm_monster_job_id"] is not None

    # Active grams deducted
    me_after_submit = client.get("/api/auth/me", headers=_auth_header(token)).json()
    assert me_after_submit["active_grams_used"] == pytest.approx(grams, abs=0.05)
    assert me_after_submit["available_grams"] == pytest.approx(100.0 - grams, abs=0.05)

    # Trigger dev-complete -> status COMPLETED and active grams auto-refunded!
    r_complete = client.post(f"/api/jobs/{job['id']}/dev-complete", headers=_auth_header(token))
    assert r_complete.status_code == 200, r_complete.text
    assert r_complete.json()["status"] == "COMPLETED"

    mine = client.get("/api/jobs/mine", headers=_auth_header(token)).json()
    assert mine["user"]["active_grams_used"] == 0.0
    assert mine["user"]["available_grams"] == 100.0
    assert len(mine["jobs"]) == 1
    assert mine["jobs"][0]["status"] == "COMPLETED"


def test_oversized_approval_flows_approve_raise_reject_and_cancel(client: TestClient):
    student_auth = _login(client, "2345678", "student123")
    s_token = student_auth["access_token"]
    teacher_id = student_auth["user"]["teachers"][0]["id"]
    admin_auth = _login(client, "admin", "admin123")
    a_token = admin_auth["access_token"]

    printers = client.get("/api/printers", headers=_auth_header(s_token)).json()
    voron = next(p for p in printers if p["fdm_monster_id"] == "klipper-voron-1")
    slot = voron["slots"][0]

    # Use oversized-housing.stl from sample-models/ (>100g)
    oversized_bytes = client.get("/api/samples/oversized-housing.stl").content

    def _upload_and_slice(name: str, scale: float = 1.0) -> dict:
        j = client.post(
            "/api/jobs/upload",
            headers=_auth_header(s_token),
            files={"file": (name, oversized_bytes, "model/stl")},
            data={"printer_id": str(voron["id"]), "slot_id": str(slot["id"])},
        ).json()
        r = client.post(
            f"/api/jobs/{j['id']}/slice?sync=true",
            headers=_auth_header(s_token),
            json={
                "printer_id": voron["id"],
                "slot_id": slot["id"],
                "pos_x_mm": 0.0,
                "pos_y_mm": 0.0,
                "quat_x": 0.0,
                "quat_y": 0.0,
                "quat_z": 0.0,
                "quat_w": 1.0,
                "scale": scale,
            },
        )
        assert r.status_code == 200, r.text
        return r.json()

    # Job 1: oversized -> submit blocked (409 LIMIT_EXCEEDED) -> request approval -> admin approve_once -> cancel
    job1 = _upload_and_slice("housing_1.stl")
    assert job1["estimated_grams"] > 100.0
    assert job1["budget_check"]["within_grams"] is False
    assert job1["budget_check"]["can_auto_submit"] is False

    r_sub_fail = client.post(f"/api/jobs/{job1['id']}/submit", headers=_auth_header(s_token))
    assert r_sub_fail.status_code == 409
    assert r_sub_fail.json()["detail"]["code"] == "LIMIT_EXCEEDED"

    # Multi-teacher student must specify teacher_id
    r_req_missing_teacher = client.post(
        f"/api/jobs/{job1['id']}/request-approval",
        headers=_auth_header(s_token),
        json={"note": "Projet génie mécanique"},
    )
    assert r_req_missing_teacher.status_code == 400
    assert r_req_missing_teacher.json()["detail"]["code"] == "TEACHER_REQUIRED"

    r_req1 = client.post(
        f"/api/jobs/{job1['id']}/request-approval",
        headers=_auth_header(s_token),
        json={"note": "Projet génie mécanique", "teacher_id": teacher_id},
    )
    assert r_req1.status_code == 200
    assert r_req1.json()["status"] == "PENDING_APPROVAL"
    assert r_req1.json()["teacher_id"] == teacher_id

    # Reserved in active grams while pending
    me_pending = client.get("/api/auth/me", headers=_auth_header(s_token)).json()
    assert me_pending["active_grams_used"] == pytest.approx(job1["estimated_grams"], abs=0.05)

    # Admin sees pending approval
    approvals = client.get("/api/admin/approvals", headers=_auth_header(a_token)).json()
    assert any(j["id"] == job1["id"] for j in approvals["pending"])

    # Admin approves once
    r_app1 = client.post(
        f"/api/admin/approvals/{job1['id']}/decision",
        headers=_auth_header(a_token),
        json={"decision": "approve_once", "admin_note": "OK pour ce prototype"},
    )
    assert r_app1.status_code == 200
    assert r_app1.json()["status"] == "QUEUED"

    # Student cancels queued job -> grams refunded
    r_cancel1 = client.post(f"/api/jobs/{job1['id']}/cancel", headers=_auth_header(s_token))
    assert r_cancel1.status_code == 200
    assert r_cancel1.json()["status"] == "CANCELLED"
    assert client.get("/api/auth/me", headers=_auth_header(s_token)).json()["active_grams_used"] == 0.0

    # Job 2: request approval -> admin rejects -> grams refunded
    job2 = _upload_and_slice("housing_2.stl")
    r_req2 = client.post(
        f"/api/jobs/{job2['id']}/request-approval",
        headers=_auth_header(s_token),
        json={"note": "Test rejet", "teacher_id": teacher_id},
    )
    assert r_req2.status_code == 200
    r_rej = client.post(
        f"/api/admin/approvals/{job2['id']}/decision",
        headers=_auth_header(a_token),
        json={"decision": "reject", "admin_note": "Trop massif, diviser en 2 pièces"},
    )
    assert r_rej.status_code == 200
    assert r_rej.json()["status"] == "REJECTED"
    assert client.get("/api/auth/me", headers=_auth_header(s_token)).json()["active_grams_used"] == 0.0

    # Job 3: request approval -> admin approve_and_raise -> user limit permanently raised
    job3 = _upload_and_slice("housing_3.stl")
    r_req3 = client.post(
        f"/api/jobs/{job3['id']}/request-approval",
        headers=_auth_header(s_token),
        json={"note": "Besoin limite augmentée", "teacher_id": teacher_id},
    )
    assert r_req3.status_code == 200
    r_raise = client.post(
        f"/api/admin/approvals/{job3['id']}/decision",
        headers=_auth_header(a_token),
        json={
            "decision": "approve_and_raise",
            "new_max_active_grams": 350.0,
            "new_max_print_minutes": 720,
            "admin_note": "Approuvé + limite à 350g",
        },
    )
    assert r_raise.status_code == 200
    assert r_raise.json()["status"] == "QUEUED"
    me_raised = client.get("/api/auth/me", headers=_auth_header(s_token)).json()
    assert me_raised["effective_max_active_grams"] == 350.0
    assert me_raised["effective_max_print_minutes"] == 720


def test_admin_whitelist_csv_students_password_reset_profiles_test_slice_and_settings(client: TestClient):
    admin_auth = _login(client, "admin", "admin123")
    a_token = admin_auth["access_token"]

    classes = client.get("/api/admin/classes", headers=_auth_header(a_token)).json()
    target_class = next(c for c in classes if any(e["da"] == "2345678" for e in c["enrollments"]))

    # CSV Roster upload (2 valid new DAs, 1 duplicate 2345678, 1 invalid DA)
    csv_data = (
        "da,name,max_active_grams,max_print_minutes\n"
        "2411111,Alice Tremblay,150,480\n"
        "2422222,Bob Gagnon,,\n"
        "2345678,Duplicate,,\n"
        "123,InvalidDA,,\n"
    ).encode("utf-8")
    r_csv = client.post(
        f"/api/admin/classes/{target_class['id']}/import-csv",
        headers=_auth_header(a_token),
        files={"file": ("students.csv", csv_data, "text/csv")},
    )
    assert r_csv.status_code == 200, r_csv.text
    assert r_csv.json() == {"added": 2, "skipped": 2, "reactivated": 0}

    # Register Alice (inherits CSV override 150g / 480m)
    r_alice = client.post(
        "/api/auth/register",
        json={"da": "2411111", "name": "Alice Tremblay", "password": "alicepassword"},
    )
    assert r_alice.status_code == 201
    alice_user = r_alice.json()["user"]
    assert alice_user["effective_max_active_grams"] == 150.0
    assert alice_user["effective_max_print_minutes"] == 480

    # Admin clears Alice's override back to global default using explicit null
    r_clear = client.patch(
        f"/api/admin/students/{alice_user['id']}",
        headers=_auth_header(a_token),
        json={"max_active_grams_override": None, "max_print_minutes_override": None},
    )
    assert r_clear.status_code == 200
    assert r_clear.json()["effective_max_active_grams"] == 100.0
    assert r_clear.json()["effective_max_print_minutes"] == 360

    # Admin resets Alice's password (auto-generated 8-char temp password)
    r_reset = client.post(
        f"/api/admin/students/{alice_user['id']}/reset-password",
        headers=_auth_header(a_token),
    )
    assert r_reset.status_code == 200
    temp_pwd = r_reset.json()["temp_password"]
    assert len(temp_pwd) == 8
    assert _login(client, "2411111", temp_pwd)["user"]["da"] == "2411111"

    # Admin uploads a new Orca process profile & runs test-slice
    prof_json = json.dumps({"type": "process", "name": "Fine 0.16mm", "layer_height": "0.16"}).encode("utf-8")
    r_prof = client.post(
        "/api/admin/profiles",
        headers=_auth_header(a_token),
        files={"file": ("fine_016.json", prof_json, "application/json")},
        data={"name": "Fine 0.16mm", "kind": "process", "notes": "High detail"},
    )
    assert r_prof.status_code == 201

    admin_printers = client.get("/api/admin/printers", headers=_auth_header(a_token)).json()
    voron = admin_printers[0]
    r_test_slice = client.post(
        "/api/admin/profiles/test-slice",
        headers=_auth_header(a_token),
        json={"printer_id": voron["id"], "slot_id": voron["slots"][0]["id"]},
    )
    assert r_test_slice.status_code == 200, r_test_slice.text
    ts = r_test_slice.json()
    assert ts["ok"] is True
    assert ts["estimated_grams"] > 0
    assert "--orient 0 --arrange 0" in ts["command_preview"]
    assert "enable_prime_tower=0" in ts["command_preview"]

    # Admin updates global settings and verifies duration limit toggle & key masking
    r_patch_cfg = client.patch(
        "/api/admin/settings",
        headers=_auth_header(a_token),
        json={
            "enforce_duration_limit": False,
            "default_max_active_grams": 120.0,
            "fdm_monster_api_key": "super-secret-proxmox-key-9876",
        },
    )
    assert r_patch_cfg.status_code == 200
    cfg = r_patch_cfg.json()
    assert cfg["enforce_duration_limit"] is False
    assert cfg["default_max_active_grams"] == 120.0
    assert cfg["has_fdm_monster_api_key"] is True
    assert cfg["fdm_monster_api_key"].endswith("9876")
    assert "super-secret" not in cfg["fdm_monster_api_key"]


def test_orcaslicer_cli_adapter_commands_and_3mf_extruder(tmp_path: Path):
    adapter = OrcaSlicerCliAdapter(cli_path="/opt/orca/orca-slicer")
    orient_cmd = adapter.build_orient_command(Path("in.stl"), Path("out.3mf"))
    assert orient_cmd == [
        "/opt/orca/orca-slicer",
        "--orient",
        "1",
        "--ensure-on-bed",
        "--export-3mf",
        "out.3mf",
        "in.stl",
    ]

    # Verify single-color MMU 3MF extruder packaging disables prime tower
    stl_path = tmp_path / "part.stl"
    stl_path.write_bytes(_make_stl_bytes())
    out_3mf = tmp_path / "part_slot3.3mf"
    adapter._package_single_color_3mf(stl_path, out_3mf, slot_index=3)

    with zipfile.ZipFile(out_3mf, "r") as zf:
        cfg = zf.read("Metadata/model_settings.config").decode("utf-8")
        assert 'key="extruder" value="3"' in cfg
        assert 'key="enable_prime_tower" value="0"' in cfg
        model = zf.read("3D/3dmodel.model").decode("utf-8")
        assert "<triangle " in model


@pytest.mark.anyio
async def test_poller_auto_refund_and_duration_limit(client: TestClient):
    student_auth = _login(client, "2345678", "student123")
    s_token = student_auth["access_token"]
    admin_auth = _login(client, "admin", "admin123")
    a_token = admin_auth["access_token"]

    # Lower duration limit to 10 minutes so a ~30g print fits grams (<100g) but exceeds duration!
    client.patch(
        "/api/admin/settings",
        headers=_auth_header(a_token),
        json={"enforce_duration_limit": True, "default_max_print_minutes": 10},
    )

    printers = client.get("/api/printers", headers=_auth_header(s_token)).json()
    voron = printers[0]
    slot = voron["slots"][0]

    stl_bytes = _make_stl_bytes(extents=(40.0, 40.0, 30.0))
    job = client.post(
        "/api/jobs/upload",
        headers=_auth_header(s_token),
        files={"file": ("medium.stl", stl_bytes, "model/stl")},
        data={"printer_id": str(voron["id"]), "slot_id": str(slot["id"])},
    ).json()

    sliced = client.post(
        f"/api/jobs/{job['id']}/slice?sync=true",
        headers=_auth_header(s_token),
        json={
            "printer_id": voron["id"],
            "slot_id": slot["id"],
            "pos_x_mm": 0.0,
            "pos_y_mm": 0.0,
            "quat_x": 0.0,
            "quat_y": 0.0,
            "quat_z": 0.0,
            "quat_w": 1.0,
            "scale": 1.0,
        },
    ).json()
    assert sliced["budget_check"]["within_grams"] is True
    assert sliced["budget_check"]["within_duration"] is False
    assert sliced["budget_check"]["exceeds_minutes_by"] > 0
    assert sliced["budget_check"]["can_auto_submit"] is False

    # Restore duration limit to 360 min and submit
    client.patch(
        "/api/admin/settings",
        headers=_auth_header(a_token),
        json={"default_max_print_minutes": 360},
    )
    sub = client.post(f"/api/jobs/{job['id']}/submit", headers=_auth_header(s_token)).json()
    assert sub["status"] == "QUEUED"
    assert client.get("/api/auth/me", headers=_auth_header(s_token)).json()["active_grams_used"] > 0

    # Simulate remote FDM Monster finishing job and run background poller tick
    fdm_monster._MOCK_JOBS[sub["fdm_monster_job_id"]]["status"] = "COMPLETED"
    with database.SessionLocal() as db:
        updated = await fdm_monster.poll_fdm_monster_once(db)
        assert updated == 1

    me_after = client.get("/api/auth/me", headers=_auth_header(s_token)).json()
    assert me_after["active_grams_used"] == 0.0
    assert me_after["available_grams"] == 100.0


def test_supports_toggle_affects_metrics_persistence_and_gcode(client: TestClient):
    student_auth = _login(client, "2345678", "student123")
    token = student_auth["access_token"]
    printers = client.get("/api/printers", headers=_auth_header(token)).json()
    voron = next(p for p in printers if p["fdm_monster_id"] == "klipper-voron-1")
    slot = voron["slots"][0]

    stl_bytes = _make_stl_bytes(extents=(60.0, 60.0, 40.0))
    job = client.post(
        "/api/jobs/upload",
        headers=_auth_header(token),
        files={"file": ("support_toggle_test.stl", stl_bytes, "model/stl")},
        data={"printer_id": str(voron["id"]), "slot_id": str(slot["id"])},
    ).json()

    base_payload = {
        "printer_id": voron["id"],
        "slot_id": slot["id"],
        "pos_x_mm": 0.0,
        "pos_y_mm": 0.0,
        "quat_x": 0.0,
        "quat_y": 0.0,
        "quat_z": 0.0,
        "quat_w": 1.0,
        "scale": 1.0,
    }

    r_on = client.post(
        f"/api/jobs/{job['id']}/slice?sync=true",
        headers=_auth_header(token),
        json={**base_payload, "supports_enabled": True},
    )
    assert r_on.status_code == 200, r_on.text
    sliced_on = r_on.json()
    assert sliced_on["supports_enabled"] is True

    with database.SessionLocal() as db:
        db_job = db.get(PrintJob, job["id"])
        assert db_job is not None and db_job.sliced_output_path is not None
        gcode_on = Path(db_job.sliced_output_path).read_text(encoding="utf-8")

    assert "; supports_enabled = 1" in gcode_on
    assert "; support_type = tree(auto)" in gcode_on
    assert "; support_style = organic" in gcode_on
    assert "; support_on_build_plate_only = 1" in gcode_on

    r_off = client.post(
        f"/api/jobs/{job['id']}/slice?sync=true",
        headers=_auth_header(token),
        json={**base_payload, "supports_enabled": False},
    )
    assert r_off.status_code == 200, r_off.text
    sliced_off = r_off.json()
    assert sliced_off["supports_enabled"] is False
    assert sliced_off["estimated_grams"] < sliced_on["estimated_grams"]
    assert sliced_off["estimated_minutes"] < sliced_on["estimated_minutes"]

    # Confirm supports_enabled=False persists on JobDetail returned by /api/jobs/mine
    mine = client.get("/api/jobs/mine", headers=_auth_header(token)).json()
    persisted = next(j for j in mine["jobs"] if j["id"] == job["id"])
    assert persisted["supports_enabled"] is False

    with database.SessionLocal() as db:
        db_job = db.get(PrintJob, job["id"])
        assert db_job is not None and db_job.sliced_output_path is not None
        gcode_off = Path(db_job.sliced_output_path).read_text(encoding="utf-8")

    assert "; supports_enabled = 0" in gcode_off
    assert "; supports_enabled = 1" not in gcode_off


def test_orcaslicer_cli_adapter_organic_tree_process_override(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    adapter = OrcaSlicerCliAdapter(cli_path="/opt/orca/orca-slicer")
    stl_path = tmp_path / "part.stl"
    stl_path.write_bytes(_make_stl_bytes(extents=(25.0, 25.0, 20.0)))

    machine_json = tmp_path / "machine.json"
    machine_json.write_text(json.dumps({"type": "machine", "name": "Voron"}), encoding="utf-8")
    process_json = tmp_path / "process.json"
    process_json.write_text(json.dumps({"type": "process", "layer_height": "0.20"}), encoding="utf-8")
    filament_json = tmp_path / "filament.json"
    filament_json.write_text(json.dumps({"type": "filament", "filament_density": ["1.24"]}), encoding="utf-8")

    machine_p = OrcaProfile(name="Voron", kind="machine", filename="machine.json", file_path=str(machine_json))
    process_p = OrcaProfile(name="Standard", kind="process", filename="process.json", file_path=str(process_json))
    filament_p = OrcaProfile(name="PLA", kind="filament", filename="filament.json", file_path=str(filament_json))

    printer = Printer(
        name="Voron",
        display_name="Voron 2.4",
        fdm_monster_id="klipper-voron-1",
        printer_type="klipper",
        bed_x_mm=300.0,
        bed_y_mm=300.0,
        bed_z_mm=300.0,
        mmu_slots_count=4,
    )
    slot = PrinterSlot(slot_index=2, label="Slot 2", is_loaded=True)

    preview_on = adapter.format_command_preview(machine_p, process_p, filament_p, slot_index=2, supports_enabled=True)
    preview_off = adapter.format_command_preview(machine_p, process_p, filament_p, slot_index=2, supports_enabled=False)
    assert "supports=tree(organic,buildplate)" in preview_on
    assert "supports=off" in preview_off

    captured_process_dicts: list[dict] = []

    def fake_run(cmd, capture_output, text, timeout, check):
        settings_idx = cmd.index("--load-settings") + 1
        settings_paths = cmd[settings_idx].split(";")
        override_path = Path(settings_paths[1])
        captured_process_dicts.append(json.loads(override_path.read_text(encoding="utf-8")))

        out_dir = Path(cmd[cmd.index("--outputdir") + 1])
        (out_dir / "result.gcode").write_text(
            "; filament used [g] = 12.34\n; estimated printing time (normal mode) = 42m 0s\n; total layers count = 100\nG28\n",
            encoding="utf-8",
        )
        return None

    monkeypatch.setattr("app.services.slicer.subprocess.run", fake_run)

    res_on = adapter.slice_mesh(
        oriented_stl_path=stl_path,
        output_gcode_path=tmp_path / "out_on.gcode",
        printer=printer,
        slot=slot,
        machine_profile=machine_p,
        process_profile=process_p,
        filament_profile=filament_p,
        supports_enabled=True,
    )
    assert res_on.supports_enabled is True
    assert "supports=tree(organic,buildplate)" in res_on.command_preview
    assert captured_process_dicts[0]["layer_height"] == "0.20"
    assert captured_process_dicts[0]["enable_support"] == "1"
    assert captured_process_dicts[0]["support_type"] == "tree(auto)"
    assert captured_process_dicts[0]["support_style"] == "organic"
    assert captured_process_dicts[0]["support_on_build_plate_only"] == "1"

    res_off = adapter.slice_mesh(
        oriented_stl_path=stl_path,
        output_gcode_path=tmp_path / "out_off.gcode",
        printer=printer,
        slot=slot,
        machine_profile=machine_p,
        process_profile=process_p,
        filament_profile=filament_p,
        supports_enabled=False,
    )
    assert res_off.supports_enabled is False
    assert "supports=off" in res_off.command_preview
    assert captured_process_dicts[1]["layer_height"] == "0.20"
    assert captured_process_dicts[1]["enable_support"] == "0"


def test_teacher_management_and_rbac(client: TestClient):
    admin_auth = _login(client, "admin", "admin123")
    a_token = admin_auth["access_token"]
    teacher_a_auth = _login(client, "m.tremblay@cgodin.qc.ca", "teacher123")
    ta_token = teacher_a_auth["access_token"]

    # Teacher cannot access /api/admin/teachers or /api/admin/settings (403 SUPER_ADMIN_REQUIRED)
    assert client.get("/api/admin/teachers", headers=_auth_header(ta_token)).status_code == 403
    assert client.post(
        "/api/admin/teachers",
        headers=_auth_header(ta_token),
        json={"identifier": "x.y@cgodin.qc.ca", "name": "XY", "password": "pass123"},
    ).status_code == 403
    assert client.get("/api/admin/settings", headers=_auth_header(ta_token)).status_code == 403
    assert client.patch(
        "/api/admin/settings",
        headers=_auth_header(ta_token),
        json={"default_max_active_grams": 200.0},
    ).status_code == 403

    # Teacher CANNOT access /api/admin/printers (403 FORBIDDEN), CAN access own classes & public /api/printers
    r_admin_printers = client.get("/api/admin/printers", headers=_auth_header(ta_token))
    assert r_admin_printers.status_code == 403
    assert r_admin_printers.json()["detail"]["required_permission"] == "printers:view"
    assert client.get("/api/printers", headers=_auth_header(ta_token)).status_code == 200
    assert client.get("/api/admin/classes", headers=_auth_header(ta_token)).status_code == 200

    # Main Admin creates a new teacher, toggles active, resets password, and deletes
    r_create = client.post(
        "/api/admin/teachers",
        headers=_auth_header(a_token),
        json={"identifier": "J.Dupont@cgodin.qc.ca", "name": "Julie Dupont", "password": "teachpass1"},
    )
    assert r_create.status_code == 201, r_create.text
    created_t = r_create.json()
    assert created_t["da"] == "j.dupont@cgodin.qc.ca"
    assert created_t["is_active"] is True

    # Toggle inactive -> login fails with ACCOUNT_DISABLED
    r_disable = client.patch(
        f"/api/admin/teachers/{created_t['id']}",
        headers=_auth_header(a_token),
        json={"is_active": False},
    )
    assert r_disable.status_code == 200
    assert r_disable.json()["is_active"] is False

    r_login_disabled = client.post(
        "/api/auth/login",
        json={"identifier": "j.dupont@cgodin.qc.ca", "password": "teachpass1"},
    )
    assert r_login_disabled.status_code == 403
    assert r_login_disabled.json()["detail"]["code"] == "ACCOUNT_DISABLED"

    # Re-enable + reset password + login
    client.patch(
        f"/api/admin/teachers/{created_t['id']}",
        headers=_auth_header(a_token),
        json={"is_active": True, "name": "Julie Dupont-Martin"},
    )
    r_reset = client.post(
        f"/api/admin/teachers/{created_t['id']}/reset-password",
        headers=_auth_header(a_token),
        json={"new_password": "newteachpass"},
    )
    assert r_reset.status_code == 200
    assert _login(client, "j.dupont@cgodin.qc.ca", "newteachpass")["user"]["name"] == "Julie Dupont-Martin"

    # Delete teacher
    r_del = client.delete(f"/api/admin/teachers/{created_t['id']}", headers=_auth_header(a_token))
    assert r_del.status_code == 204
    teachers = client.get("/api/admin/teachers", headers=_auth_header(a_token)).json()
    assert all(t["id"] != created_t["id"] for t in teachers)


def test_class_roster_csv_orphan_disable_and_reactivate(client: TestClient):
    ta_auth = _login(client, "m.tremblay@cgodin.qc.ca", "teacher123")
    ta_token = ta_auth["access_token"]
    tb_auth = _login(client, "s.gagnon@cgodin.qc.ca", "teacher123")
    tb_token = tb_auth["access_token"]

    # Teacher A creates a new class
    r_cls = client.post(
        "/api/admin/classes",
        headers=_auth_header(ta_token),
        json={"name": "241-305-GG — Prototypage", "code": "241-305-GG"},
    )
    assert r_cls.status_code == 201, r_cls.text
    cls_id = r_cls.json()["id"]

    # Teacher B cannot import into or delete Teacher A's class (403)
    assert client.delete(f"/api/admin/classes/{cls_id}", headers=_auth_header(tb_token)).status_code == 403

    # CSV-import new student 2488888 AND multi-teacher student 2345678
    csv_bytes = (
        "da,suggested_name,max_grams,max_minutes\n"
        "2488888,Nadia Roy,120,300\n"
        "2345678,Étudiant Démo,,\n"
    ).encode("utf-8")
    r_imp = client.post(
        f"/api/admin/classes/{cls_id}/import-csv",
        headers=_auth_header(ta_token),
        files={"file": ("roster.csv", csv_bytes, "text/csv")},
    )
    assert r_imp.status_code == 200, r_imp.text
    assert r_imp.json() == {"added": 2, "skipped": 0, "reactivated": 0}

    # 2488888 registers (auto-approved)
    r_reg = client.post(
        "/api/auth/register",
        json={"da": "2488888", "name": "Nadia Roy", "password": "nadia123"},
    )
    assert r_reg.status_code == 201, r_reg.text
    assert r_reg.json()["pending_approval"] is False

    # Delete the class -> 2488888 becomes orphaned and disabled; 2345678 stays active!
    r_del = client.delete(f"/api/admin/classes/{cls_id}", headers=_auth_header(ta_token))
    assert r_del.status_code == 200, r_del.text
    assert r_del.json()["deleted_class_id"] == cls_id
    assert r_del.json()["disabled_students_count"] == 1

    # 2488888 cannot log in (403 ACCOUNT_DISABLED), while 2345678 can still log in!
    r_nadia_login = client.post("/api/auth/login", json={"da": "2488888", "password": "nadia123"})
    assert r_nadia_login.status_code == 403
    assert r_nadia_login.json()["detail"]["code"] == "ACCOUNT_DISABLED"
    assert _login(client, "2345678", "student123")["user"]["is_active"] is True

    # Teacher A creates another class and re-imports 2488888 -> reactivated == 1, login succeeds!
    cls2_id = client.post(
        "/api/admin/classes",
        headers=_auth_header(ta_token),
        json={"name": "241-306-GG — Reprise"},
    ).json()["id"]
    r_reimp = client.post(
        f"/api/admin/classes/{cls2_id}/import-csv",
        headers=_auth_header(ta_token),
        files={"file": ("reimport.csv", b"da,name\n2488888,Nadia Roy\n", "text/csv")},
    )
    assert r_reimp.status_code == 200
    assert r_reimp.json() == {"added": 1, "skipped": 0, "reactivated": 1}
    assert _login(client, "2488888", "nadia123")["user"]["is_active"] is True


def test_unlisted_da_pending_account_approval_flow(client: TestClient):
    teachers = client.get("/api/auth/teachers").json()
    assert len(teachers) >= 2
    teacher_a = next(t for t in teachers if "Marc Tremblay" in t["name"])
    teacher_b = next(t for t in teachers if "Sophie Gagnon" in t["name"])

    # Invalid DA format -> 422
    assert client.get("/api/auth/check-da/123").status_code == 422

    # Unlisted DA 2499999 -> in_roster=False
    r_chk = client.get("/api/auth/check-da/2499999")
    assert r_chk.status_code == 200
    assert r_chk.json() == {
        "da": "2499999",
        "is_registered": False,
        "in_roster": False,
        "suggested_name": None,
    }

    # Seeded enrolled DA 2333572 -> in_roster=True without leaking suggested_name (PII protection)
    r_chk_enrolled = client.get("/api/auth/check-da/2333572")
    assert r_chk_enrolled.status_code == 200
    assert r_chk_enrolled.json()["in_roster"] is True
    assert r_chk_enrolled.json()["suggested_name"] is None

    # Register 2499999 under Teacher A -> pending_approval=True, no token
    r_reg = client.post(
        "/api/auth/register",
        json={
            "da": "2499999",
            "name": "Étudiant Hors-Liste",
            "password": "pendingpass",
            "teacher_id": teacher_a["id"],
        },
    )
    assert r_reg.status_code == 201, r_reg.text
    reg_data = r_reg.json()
    assert reg_data["pending_approval"] is True
    assert reg_data["access_token"] is None
    assert reg_data["user"] is None
    assert reg_data["requested_teacher_name"] == teacher_a["name"]

    # Login before approval -> 403 ACCOUNT_PENDING_APPROVAL
    r_login_pending = client.post("/api/auth/login", json={"da": "2499999", "password": "pendingpass"})
    assert r_login_pending.status_code == 403
    assert r_login_pending.json()["detail"]["code"] == "ACCOUNT_PENDING_APPROVAL"
    assert teacher_a["name"] in r_login_pending.json()["detail"]["message"]

    ta_token = _login(client, "m.tremblay@cgodin.qc.ca", "teacher123")["access_token"]
    tb_token = _login(client, "s.gagnon@cgodin.qc.ca", "teacher123")["access_token"]

    # Teacher B does not see request and gets 403 trying to decide
    tb_reqs = client.get("/api/admin/account-requests", headers=_auth_header(tb_token)).json()
    assert all(r["da"] != "2499999" for r in tb_reqs)

    ta_reqs = client.get("/api/admin/account-requests", headers=_auth_header(ta_token)).json()
    req_entry = next(r for r in ta_reqs if r["da"] == "2499999")

    r_tb_forbidden = client.post(
        f"/api/admin/account-requests/{req_entry['id']}/decision",
        headers=_auth_header(tb_token),
        json={"decision": "approve"},
    )
    assert r_tb_forbidden.status_code == 403

    # Teacher A approves into one of Teacher A's classes -> 2499999 can now log in!
    ta_classes = client.get("/api/admin/classes", headers=_auth_header(ta_token)).json()
    r_approve = client.post(
        f"/api/admin/account-requests/{req_entry['id']}/decision",
        headers=_auth_header(ta_token),
        json={"decision": "approve", "class_id": ta_classes[0]["id"]},
    )
    assert r_approve.status_code == 200, r_approve.text
    assert r_approve.json()["approval_status"] == "approved"

    login_ok = _login(client, "2499999", "pendingpass")
    assert login_ok["user"]["approval_status"] == "approved"
    assert login_ok["user"]["teachers"][0]["id"] == teacher_a["id"]

    # Reject flow for another unlisted DA 2499998 under Teacher B
    client.post(
        "/api/auth/register",
        json={
            "da": "2499998",
            "name": "Rejeté Test",
            "password": "rejectpass",
            "teacher_id": teacher_b["id"],
        },
    )
    tb_reqs2 = client.get("/api/admin/account-requests", headers=_auth_header(tb_token)).json()
    req2 = next(r for r in tb_reqs2 if r["da"] == "2499998")
    r_rej = client.post(
        f"/api/admin/account-requests/{req2['id']}/decision",
        headers=_auth_header(tb_token),
        json={"decision": "reject"},
    )
    assert r_rej.status_code == 200
    assert r_rej.json()["approval_status"] == "rejected"

    r_login_rej = client.post("/api/auth/login", json={"da": "2499998", "password": "rejectpass"})
    assert r_login_rej.status_code == 403
    assert r_login_rej.json()["detail"]["code"] == "ACCOUNT_REJECTED"


def test_multi_teacher_print_approval_routing(client: TestClient):
    student_auth = _login(client, "2345678", "student123")
    s_token = student_auth["access_token"]
    teachers_by_name = {t["name"]: t["id"] for t in student_auth["user"]["teachers"]}
    assert "Marc Tremblay" in teachers_by_name
    assert "Sophie Gagnon" in teachers_by_name
    teacher_a_id = teachers_by_name["Marc Tremblay"]
    teacher_b_id = teachers_by_name["Sophie Gagnon"]

    ta_token = _login(client, "m.tremblay@cgodin.qc.ca", "teacher123")["access_token"]
    tb_token = _login(client, "s.gagnon@cgodin.qc.ca", "teacher123")["access_token"]
    admin_token = _login(client, "admin", "admin123")["access_token"]

    # Create a 3rd teacher that 2345678 is NOT enrolled with
    teacher_c = client.post(
        "/api/admin/teachers",
        headers=_auth_header(admin_token),
        json={"identifier": "c.autre@cgodin.qc.ca", "name": "Claire Autre", "password": "pass123"},
    ).json()

    printers = client.get("/api/printers", headers=_auth_header(s_token)).json()
    voron = next(p for p in printers if p["fdm_monster_id"] == "klipper-voron-1")
    slot = voron["slots"][0]
    oversized_bytes = client.get("/api/samples/oversized-housing.stl").content

    def _make_sliced_job() -> int:
        j = client.post(
            "/api/jobs/upload",
            headers=_auth_header(s_token),
            files={"file": ("housing.stl", oversized_bytes, "model/stl")},
            data={"printer_id": str(voron["id"]), "slot_id": str(slot["id"])},
        ).json()
        r = client.post(
            f"/api/jobs/{j['id']}/slice?sync=true",
            headers=_auth_header(s_token),
            json={
                "printer_id": voron["id"],
                "slot_id": slot["id"],
                "pos_x_mm": 0.0,
                "pos_y_mm": 0.0,
                "quat_x": 0.0,
                "quat_y": 0.0,
                "quat_z": 0.0,
                "quat_w": 1.0,
                "scale": 1.0,
            },
        )
        assert r.status_code == 200
        return j["id"]

    job1_id = _make_sliced_job()

    # Omitting teacher_id for multi-teacher student -> 400 TEACHER_REQUIRED
    r_no_t = client.post(
        f"/api/jobs/{job1_id}/request-approval",
        headers=_auth_header(s_token),
        json={"note": "Sans enseignant"},
    )
    assert r_no_t.status_code == 400
    assert r_no_t.json()["detail"]["code"] == "TEACHER_REQUIRED"

    # Picking unrelated Teacher C -> 400 INVALID_TEACHER_SELECTION
    r_bad_t = client.post(
        f"/api/jobs/{job1_id}/request-approval",
        headers=_auth_header(s_token),
        json={"note": "Mauvais prof", "teacher_id": teacher_c["id"]},
    )
    assert r_bad_t.status_code == 400
    assert r_bad_t.json()["detail"]["code"] == "INVALID_TEACHER_SELECTION"

    # Routing to Teacher B (Sophie Gagnon)
    r_ok = client.post(
        f"/api/jobs/{job1_id}/request-approval",
        headers=_auth_header(s_token),
        json={"note": "Pour cours électronique", "teacher_id": teacher_b_id},
    )
    assert r_ok.status_code == 200, r_ok.text
    assert r_ok.json()["teacher_id"] == teacher_b_id
    assert r_ok.json()["teacher_name"] == "Sophie Gagnon"

    # Teacher A does NOT see job1; Teacher B sees it; Main Admin sees it
    ta_approvals = client.get("/api/admin/approvals", headers=_auth_header(ta_token)).json()
    tb_approvals = client.get("/api/admin/approvals", headers=_auth_header(tb_token)).json()
    ad_approvals = client.get("/api/admin/approvals", headers=_auth_header(admin_token)).json()

    assert all(j["id"] != job1_id for j in ta_approvals["pending"])
    assert any(j["id"] == job1_id for j in tb_approvals["pending"])
    assert any(j["id"] == job1_id for j in ad_approvals["pending"])

    # Teacher A gets 403 trying to decide job1
    r_ta_forbidden = client.post(
        f"/api/admin/approvals/{job1_id}/decision",
        headers=_auth_header(ta_token),
        json={"decision": "approve_once"},
    )
    assert r_ta_forbidden.status_code == 403

    # Main Admin CAN approve as backup
    r_admin_approve = client.post(
        f"/api/admin/approvals/{job1_id}/decision",
        headers=_auth_header(admin_token),
        json={"decision": "approve_once", "admin_note": "Backup admin"},
    )
    assert r_admin_approve.status_code == 200
    assert r_admin_approve.json()["status"] == "QUEUED"

    # Route a second job to Teacher A and let Teacher A decide it directly
    job2_id = _make_sliced_job()
    client.post(
        f"/api/jobs/{job2_id}/request-approval",
        headers=_auth_header(s_token),
        json={"note": "Pour cours 3D", "teacher_id": teacher_a_id},
    )
    r_ta_approve = client.post(
        f"/api/admin/approvals/{job2_id}/decision",
        headers=_auth_header(ta_token),
        json={"decision": "approve_once", "admin_note": "OK Marc"},
    )
    assert r_ta_approve.status_code == 200
    assert r_ta_approve.json()["status"] == "QUEUED"


def test_filament_api_settings_sync_and_slicer_auto_change(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
):
    """FilamentAPI settings, health test, manual sync, and auto-filament change during slicing."""
    from app.schemas import FilamentApiHealthOut, FilamentApiPrinterOut
    from app.services import filament_api

    admin_token = _login(client, "admin", "admin123")["access_token"]
    student_token = _login(client, "2345678", "student123")["access_token"]

    # 1. Default settings have FilamentAPI disabled
    r_cfg = client.get("/api/admin/settings", headers=_auth_header(admin_token))
    assert r_cfg.status_code == 200
    cfg = r_cfg.json()
    assert cfg["filament_api_enabled"] is False
    assert cfg["filament_api_url"] == "http://filament-api:8000"

    # Syncing while disabled returns 400 FILAMENT_API_DISABLED
    r_disabled = client.post(
        "/api/admin/printers/sync-filaments",
        headers=_auth_header(admin_token),
    )
    assert r_disabled.status_code == 400
    assert r_disabled.json()["detail"]["code"] == "FILAMENT_API_DISABLED"

    # 2. Mock FilamentApiClient responses
    mock_state: dict[str, str | None] = {
        "prusa-mk35": "PETG",
        "klip": "PLA",
    }

    async def _fake_check_health(self):
        return FilamentApiHealthOut(
            ok=True,
            status="ok",
            printers_configured=2,
            uptime_seconds=42.5,
            printers=[
                FilamentApiPrinterOut(id="prusa-mk35", type="prusalink", host="http://192.168.4.232"),
                FilamentApiPrinterOut(id="klip", type="klipper", host="http://pi-klipper2.local"),
            ],
        )

    async def _fake_list_printers(self):
        return [
            FilamentApiPrinterOut(id="prusa-mk35", type="prusalink", host="http://192.168.4.232"),
            FilamentApiPrinterOut(id="klip", type="klipper", host="http://pi-klipper2.local"),
        ]

    async def _fake_get_filament(self, printer_id: str):
        if printer_id not in mock_state:
            raise filament_api.FilamentApiError(f"Printer '{printer_id}' not found")
        return mock_state[printer_id]

    monkeypatch.setattr(filament_api.FilamentApiClient, "check_health", _fake_check_health)
    monkeypatch.setattr(filament_api.FilamentApiClient, "list_printers", _fake_list_printers)
    monkeypatch.setattr(filament_api.FilamentApiClient, "get_filament", _fake_get_filament)

    # Test connection endpoint
    r_test = client.post(
        "/api/admin/filament-api/test",
        headers=_auth_header(admin_token),
        json={"url": "http://10.0.0.5:8000"},
    )
    assert r_test.status_code == 200
    test_body = r_test.json()
    assert test_body["ok"] is True
    assert test_body["printers_configured"] == 2
    assert len(test_body["printers"]) == 2

    # Enable FilamentAPI in settings
    r_patch_cfg = client.patch(
        "/api/admin/settings",
        headers=_auth_header(admin_token),
        json={"filament_api_enabled": True, "filament_api_url": "http://10.0.0.5:8000"},
    )
    assert r_patch_cfg.status_code == 200
    assert r_patch_cfg.json()["filament_api_enabled"] is True
    assert r_patch_cfg.json()["filament_api_url"] == "http://10.0.0.5:8000"

    # List FilamentAPI printers
    r_fap = client.get("/api/admin/filament-api/printers", headers=_auth_header(admin_token))
    assert r_fap.status_code == 200
    assert {p["id"] for p in r_fap.json()} == {"prusa-mk35", "klip"}

    # 3. Map Prusa MK3.5 (initially loaded with PLA Bleu Gérald-Godin) to FilamentAPI ID "prusa-mk35"
    admin_printers = client.get("/api/admin/printers", headers=_auth_header(admin_token)).json()
    mk35 = next(p for p in admin_printers if p["fdm_monster_id"] == "prusalink-mk35-1")
    assert mk35["slots"][0]["filament_name"] == "PLA Bleu Gérald-Godin"

    r_map = client.patch(
        f"/api/admin/printers/{mk35['id']}",
        headers=_auth_header(admin_token),
        json={"filament_api_printer_id": "prusa-mk35"},
    )
    assert r_map.status_code == 200
    assert r_map.json()["filament_api_printer_id"] == "prusa-mk35"

    # 4. Slicer auto-changes filament when slicing (prusa-mk35 currently reports "PETG")
    stl_bytes = _make_stl_bytes(extents=(25.0, 25.0, 15.0))
    r_up = client.post(
        "/api/jobs/upload",
        headers=_auth_header(student_token),
        files={"file": ("bracket.stl", stl_bytes, "application/octet-stream")},
        data={"printer_id": str(mk35["id"]), "slot_id": str(mk35["slots"][0]["id"])},
    )
    assert r_up.status_code == 201
    job_id = r_up.json()["id"]
    assert r_up.json()["filament_material"] == "PLA"

    r_slice = client.post(
        f"/api/jobs/{job_id}/slice?sync=true",
        headers=_auth_header(student_token),
        json={
            "printer_id": mk35["id"],
            "slot_id": mk35["slots"][0]["id"],
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
    sliced = r_slice.json()
    assert sliced["filament_material"] == "PETG"
    assert sliced["filament_name"] == "PETG Orange"

    # 5. Manual sync when printer switches to "PLA Vert" (exact name) and then unloaded (None)
    mock_state["prusa-mk35"] = "PLA Vert"
    r_sync1 = client.post(
        "/api/admin/printers/sync-filaments",
        headers=_auth_header(admin_token),
    )
    assert r_sync1.status_code == 200
    sync1 = r_sync1.json()
    assert sync1["synced_count"] == 1
    assert sync1["changed_count"] == 1
    assert sync1["results"][0]["matched_filament_name"] == "PLA Vert"
    assert sync1["results"][0]["status"] == "updated"

    # When API reports generic "PLA", keep existing "PLA Vert" instead of overwriting
    mock_state["prusa-mk35"] = "PLA"
    r_sync2 = client.post(
        "/api/admin/printers/sync-filaments",
        headers=_auth_header(admin_token),
    )
    assert r_sync2.status_code == 200
    sync2 = r_sync2.json()
    assert sync2["changed_count"] == 0
    assert sync2["results"][0]["matched_filament_name"] == "PLA Vert"
    assert sync2["results"][0]["status"] == "unchanged"

    # When API reports null (unloaded), mark slot as unloaded
    mock_state["prusa-mk35"] = None
    r_sync3 = client.post(
        "/api/admin/printers/sync-filaments",
        headers=_auth_header(admin_token),
    )
    assert r_sync3.status_code == 200
    sync3 = r_sync3.json()
    assert sync3["changed_count"] == 1
    assert sync3["results"][0]["status"] == "unloaded"

    updated_printers = client.get("/api/admin/printers", headers=_auth_header(admin_token)).json()
    mk35_after = next(p for p in updated_printers if p["id"] == mk35["id"])
    assert mk35_after["slots"][0]["is_loaded"] is False
    assert mk35_after["slots"][0]["filament_id"] is None


def test_gcode_endpoint_toolpaths_supports_and_access_control(client: TestClient):
    student_auth = _login(client, "2345678", "student123")
    s_token = student_auth["access_token"]
    admin_auth = _login(client, "admin", "admin123")
    a_token = admin_auth["access_token"]

    # Register another student to test cross-user 403 on /gcode
    r_other = client.post(
        "/api/auth/register",
        json={"da": "2333572", "name": "Other Student", "password": "password123"},
    )
    assert r_other.status_code == 201
    other_token = r_other.json()["access_token"]

    printers = client.get("/api/printers", headers=_auth_header(s_token)).json()
    voron = next(p for p in printers if p["fdm_monster_id"] == "klipper-voron-1")
    slot = voron["slots"][0]

    # Use complex-mount.stl which has real overhangs
    stl_bytes = client.get("/api/samples/complex-mount.stl").content
    r_up = client.post(
        "/api/jobs/upload",
        headers=_auth_header(s_token),
        files={"file": ("complex-mount.stl", stl_bytes, "model/stl")},
        data={"printer_id": str(voron["id"]), "slot_id": str(slot["id"])},
    )
    assert r_up.status_code == 201
    job = r_up.json()
    assert job["gcode_url"] is None

    # Before slicing, GET /gcode returns 404 GCODE_NOT_FOUND
    r_pre = client.get(f"/api/jobs/{job['id']}/gcode", headers=_auth_header(s_token))
    assert r_pre.status_code == 404
    assert r_pre.json()["detail"]["code"] == "GCODE_NOT_FOUND"

    # Slice with supports enabled
    slice_payload = {
        "printer_id": voron["id"],
        "slot_id": slot["id"],
        "pos_x_mm": 0.0,
        "pos_y_mm": 0.0,
        "quat_x": 0.0,
        "quat_y": 0.0,
        "quat_z": 0.0,
        "quat_w": 1.0,
        "scale": 1.0,
        "supports_enabled": True,
    }
    r_slice_on = client.post(f"/api/jobs/{job['id']}/slice?sync=true", headers=_auth_header(s_token), json=slice_payload)
    assert r_slice_on.status_code == 200, r_slice_on.text
    sliced_on = r_slice_on.json()
    assert sliced_on["gcode_url"] == f"/api/jobs/{job['id']}/gcode"

    r_gcode_on = client.get(sliced_on["gcode_url"], headers=_auth_header(s_token))
    assert r_gcode_on.status_code == 200
    assert "text/plain" in r_gcode_on.headers.get("content-type", "")
    gcode_on = r_gcode_on.text
    assert ";LAYER_CHANGE" in gcode_on
    assert ";Z:" in gcode_on
    assert ";TYPE:Skirt" in gcode_on
    assert ";TYPE:Outer wall" in gcode_on
    assert ";TYPE:Support" in gcode_on
    assert "G1 " in gcode_on

    # Re-slice with supports disabled -> omits ;TYPE:Support
    r_slice_off = client.post(
        f"/api/jobs/{job['id']}/slice?sync=true",
        headers=_auth_header(s_token),
        json={**slice_payload, "supports_enabled": False},
    )
    assert r_slice_off.status_code == 200
    r_gcode_off = client.get(f"/api/jobs/{job['id']}/gcode", headers=_auth_header(s_token))
    assert r_gcode_off.status_code == 200
    assert ";TYPE:Support" not in r_gcode_off.text
    assert ";TYPE:Outer wall" in r_gcode_off.text

    # Admin can read student's gcode, unrelated student gets 403
    assert client.get(f"/api/jobs/{job['id']}/gcode", headers=_auth_header(a_token)).status_code == 200
    assert client.get(f"/api/jobs/{job['id']}/gcode", headers=_auth_header(other_token)).status_code == 403


def test_detect_orca_cli_path_and_profiles_inherits_flattener(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    from app import config as app_config

    fake_bin = tmp_path / "orca-slicer-headless"
    fake_bin.write_text("#!/bin/sh\n", encoding="utf-8")

    monkeypatch.delenv("ORCA_CLI_PATH", raising=False)
    monkeypatch.setattr(app_config.shutil, "which", lambda name: str(fake_bin) if name == "orca-slicer-headless" else None)
    assert detect_orca_cli_path() == str(fake_bin)

    # Multi-level vendor inheritance chain resolution
    vendor_dir = tmp_path / "vendor_profiles"
    (vendor_dir / "Vendor" / "process").mkdir(parents=True)
    (vendor_dir / "Vendor" / "process" / "fdm_base.json").write_text(
        json.dumps(
            {
                "type": "process",
                "name": "fdm_base",
                "from": "system",
                "layer_height": "0.20",
                "wall_loops": "2",
                "sparse_infill_pattern": "grid",
            }
        ),
        encoding="utf-8",
    )
    (vendor_dir / "Vendor" / "process" / "standard.json").write_text(
        json.dumps(
            {
                "type": "process",
                "name": "0.20mm Standard @Vendor",
                "inherits": "fdm_base",
                "from": "system",
                "wall_loops": "3",
                "sparse_infill_density": "20%",
            }
        ),
        encoding="utf-8",
    )

    partial_gui = {
        "name": "Custom Lab Standard",
        "from": "User",
        "inherits": "0.20mm Standard @Vendor",
        "sparse_infill_pattern": "gyroid",
    }
    flattened = resolve_and_flatten_profile(partial_gui, kind="process", extra_search_dirs=[vendor_dir])
    assert "inherits" not in flattened
    assert flattened["type"] == "process"
    assert flattened["from"] == "User"
    assert flattened["layer_height"] == "0.20"
    assert flattened["wall_loops"] == "3"
    assert flattened["sparse_infill_density"] == "20%"
    assert flattened["sparse_infill_pattern"] == "gyroid"

    # save_profile_file flattens GUI partial exports automatically
    monkeypatch.setattr(settings, "data_dir", tmp_path / "data")
    monkeypatch.setattr("app.services.slicer.detect_orca_resources_profiles_dirs", lambda _cli=None: [vendor_dir])
    saved_path = save_profile_file("gui_export.json", json.dumps(partial_gui).encode("utf-8"), kind="process")
    saved_dict = json.loads(saved_path.read_text(encoding="utf-8"))
    assert "inherits" not in saved_dict
    assert saved_dict["wall_loops"] == "3"
    assert saved_dict["sparse_infill_pattern"] == "gyroid"


def test_orcaslicer_cli_adapter_bed_centering_and_gcode_3mf_extraction(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    adapter = OrcaSlicerCliAdapter(cli_path="/opt/orca/orca-slicer")
    stl_path = tmp_path / "part.stl"
    stl_path.write_bytes(_make_stl_bytes(extents=(20.0, 20.0, 15.0)))

    machine_json = tmp_path / "machine.json"
    machine_json.write_text(
        json.dumps(
            {
                "type": "machine",
                "from": "User",
                "name": "Voron 300",
                "printable_area": ["0x0", "300x0", "300x300", "0x300"],
            }
        ),
        encoding="utf-8",
    )
    process_json = tmp_path / "process.json"
    process_json.write_text(json.dumps({"type": "process", "from": "User", "layer_height": "0.20"}), encoding="utf-8")
    filament_json = tmp_path / "filament.json"
    filament_json.write_text(json.dumps({"type": "filament", "from": "User", "filament_density": ["1.24"]}), encoding="utf-8")

    machine_p = OrcaProfile(name="Voron", kind="machine", filename="machine.json", file_path=str(machine_json))
    process_p = OrcaProfile(name="Standard", kind="process", filename="process.json", file_path=str(process_json))
    filament_p = OrcaProfile(name="PLA", kind="filament", filename="filament.json", file_path=str(filament_json))

    printer = Printer(
        name="Voron",
        display_name="Voron 2.4",
        fdm_monster_id="klipper-voron-1",
        printer_type="klipper",
        bed_x_mm=300.0,
        bed_y_mm=300.0,
        bed_z_mm=300.0,
        mmu_slots_count=4,
    )
    slot = PrinterSlot(slot_index=2, label="Slot 2", is_loaded=True)

    captured_vertices: list[tuple[float, float]] = []

    def fake_run(cmd, capture_output, text, timeout, check):
        in_3mf = Path(cmd[-1])
        with zipfile.ZipFile(in_3mf, "r") as zf:
            model_xml = zf.read("3D/3dmodel.model").decode("utf-8")
        import re as _re

        xs = [float(x) for x in _re.findall(r'x="([^"]+)"', model_xml)]
        ys = [float(y) for y in _re.findall(r'y="([^"]+)"', model_xml)]
        captured_vertices.append((0.5 * (min(xs) + max(xs)), 0.5 * (min(ys) + max(ys))))

        out_dir = Path(cmd[cmd.index("--outputdir") + 1])
        gcode_3mf = out_dir / "plate_1.gcode.3mf"
        with zipfile.ZipFile(gcode_3mf, "w", zipfile.ZIP_DEFLATED) as zout:
            zout.writestr(
                "Metadata/plate_1.gcode",
                "; total filament used [g] = 7.25\n; estimated printing time (normal mode) = 24m 10s\n; total layer number: 75\nG1 X150 Y150 E1.0\n",
            )
        return None

    monkeypatch.setattr("app.services.slicer.subprocess.run", fake_run)

    res = adapter.slice_mesh(
        oriented_stl_path=stl_path,
        output_gcode_path=tmp_path / "extracted.gcode",
        printer=printer,
        slot=slot,
        machine_profile=machine_p,
        process_profile=process_p,
        filament_profile=filament_p,
        pos_x_mm=10.0,
        pos_y_mm=-5.0,
        supports_enabled=True,
    )
    assert captured_vertices[0][0] == pytest.approx(160.0, abs=0.05)
    assert captured_vertices[0][1] == pytest.approx(145.0, abs=0.05)
    assert res.estimated_grams == 7.25
    assert res.estimated_minutes == 24
    assert res.layer_count == 75
    assert "G1 X150 Y150" in res.gcode_path.read_text(encoding="utf-8")


@pytest.mark.skipif(detect_orca_cli_path() is None, reason="OrcaSlicer CLI binary not installed")
def test_real_orcaslicer_cli_orient_and_slice_complex_mount(tmp_path: Path):
    from app.seed import _get_seeded_profile_specs

    cli_path = detect_orca_cli_path()
    assert cli_path is not None
    adapter = OrcaSlicerCliAdapter(cli_path=cli_path)

    # Verify auto_orient_stl on both tilted-bracket.stl and complex-mount.stl
    tilted_src = settings.sample_models_dir / "tilted-bracket.stl"
    tilted_out = tmp_path / "tilted_oriented.stl"
    tilted_bounds = adapter.auto_orient_stl(tilted_src, tilted_out)
    assert tilted_bounds.min_z == pytest.approx(0.0, abs=0.05)
    assert abs(0.5 * (tilted_bounds.min_x + tilted_bounds.max_x)) < 0.2
    assert abs(0.5 * (tilted_bounds.min_y + tilted_bounds.max_y)) < 0.2

    complex_src = settings.sample_models_dir / "complex-mount.stl"
    complex_out = tmp_path / "complex_oriented.stl"
    complex_bounds = adapter.auto_orient_stl(complex_src, complex_out)
    assert complex_bounds.min_z == pytest.approx(0.0, abs=0.05)

    specs = {fname: (name, kind, payload) for name, kind, fname, _notes, payload in _get_seeded_profile_specs()}
    profiles: dict[str, OrcaProfile] = {}
    for fname, (name, kind, payload) in specs.items():
        p = tmp_path / fname
        p.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        profiles[fname] = OrcaProfile(name=name, kind=kind, filename=fname, file_path=str(p))

    printer = Printer(
        name="Voron 2.4",
        display_name="Voron 2.4 — Klipper #1",
        fdm_monster_id="klipper-voron-1",
        printer_type="klipper",
        bed_x_mm=300.0,
        bed_y_mm=300.0,
        bed_z_mm=300.0,
        mmu_slots_count=4,
    )
    slot = PrinterSlot(slot_index=1, label="Slot 1", is_loaded=True)

    res_on = adapter.slice_mesh(
        oriented_stl_path=complex_out,
        output_gcode_path=tmp_path / "complex_on.gcode",
        printer=printer,
        slot=slot,
        machine_profile=profiles["voron_24_300_klipper.json"],
        process_profile=profiles["ggprint_020_standard.json"],
        filament_profile=profiles["ggprint_generic_pla.json"],
        supports_enabled=True,
    )
    gcode_on = res_on.gcode_path.read_text(encoding="utf-8", errors="ignore")
    assert res_on.layer_count >= 100
    assert res_on.estimated_grams > 0
    assert res_on.estimated_minutes >= 1
    assert ";WIDTH:" in gcode_on
    assert ";HEIGHT:" in gcode_on
    assert ";TYPE:Support" in gcode_on
    assert "sparse_infill_pattern = gyroid" in gcode_on

    res_off = adapter.slice_mesh(
        oriented_stl_path=complex_out,
        output_gcode_path=tmp_path / "complex_off.gcode",
        printer=printer,
        slot=slot,
        machine_profile=profiles["voron_24_300_klipper.json"],
        process_profile=profiles["ggprint_020_standard.json"],
        filament_profile=profiles["ggprint_generic_pla.json"],
        supports_enabled=False,
    )
    gcode_off = res_off.gcode_path.read_text(encoding="utf-8", errors="ignore")
    assert res_off.layer_count >= 100
    assert ";TYPE:Support" not in gcode_off
    assert res_off.estimated_grams < res_on.estimated_grams





