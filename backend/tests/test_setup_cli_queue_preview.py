"""Tests for Setup Wizard, CLI operator commands, SliceQueueManager, and heavy STL preview decimation."""

from __future__ import annotations

import io
import re
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import pytest
import trimesh
from fastapi.testclient import TestClient
from sqlalchemy import select

from app import cli, database, main
from app.auth import hash_password
from app.config import settings
from app.models import JobStatus, PrintJob, Printer, SystemSettings, User
from app.services import fdm_monster, slice_queue as slice_queue_mod
from app.services.fdm_monster import RemotePrinterInfo
from app.services.slice_queue import SliceQueueFullError, SliceQueueManager, SliceTask
from app.services.slicer import SlicerError, generate_preview_stl


def _setup_isolated_db(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, *, dev_seed: bool):
    test_data_dir = tmp_path / "data"
    test_db_path = test_data_dir / "test_suite.db"

    monkeypatch.setattr(settings, "data_dir", test_data_dir)
    monkeypatch.setattr(settings, "database_url", f"sqlite:///{test_db_path.as_posix()}")
    monkeypatch.setattr(settings, "dev_seed", dev_seed)
    monkeypatch.setattr(settings, "admin_password", "")
    monkeypatch.setattr(settings, "jwt_secret", "test-production-jwt-secret-key-001")
    monkeypatch.setattr(settings, "slicer_mode_override", "mock" if dev_seed else None)
    monkeypatch.setattr(settings, "institution", "3D Print Lab")

    test_engine = database._build_engine(settings.effective_database_url)
    test_session_local = database.sessionmaker(autocommit=False, autoflush=False, bind=test_engine)

    monkeypatch.setattr(database, "engine", test_engine)
    monkeypatch.setattr(database, "SessionLocal", test_session_local)
    monkeypatch.setattr(main, "SessionLocal", test_session_local)

    fdm_monster._MOCK_JOBS.clear()
    return test_engine, test_session_local


@pytest.fixture()
def prod_client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Fresh production-like TestClient (DEV_SEED=false, 0 admins)."""
    test_engine, _ = _setup_isolated_db(tmp_path, monkeypatch, dev_seed=False)
    with TestClient(main.app) as tc:
        yield tc
    test_engine.dispose()


@pytest.fixture()
def dev_client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Fresh dev-mode TestClient (DEV_SEED=true, mock slicer)."""
    test_engine, _ = _setup_isolated_db(tmp_path, monkeypatch, dev_seed=True)
    with TestClient(main.app) as tc:
        yield tc
    test_engine.dispose()


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _login(client: TestClient, identifier: str, password: str) -> dict:
    resp = client.post("/api/auth/login", json={"identifier": identifier, "password": password})
    assert resp.status_code == 200, resp.text
    return resp.json()


def _make_cube_stl_bytes(extents=(20.0, 20.0, 15.0)) -> bytes:
    mesh = trimesh.creation.box(extents=list(extents))
    buf = io.BytesIO()
    mesh.export(buf, file_type="stl")
    return buf.getvalue()


def _make_heavy_stl_bytes(radius: float = 20.0) -> tuple[bytes, int, np.ndarray]:
    """Build a >125,000-triangle STL mesh in memory and return (bytes, face_count, extents)."""
    mesh = trimesh.creation.uv_sphere(radius=radius, count=[260, 260])
    assert len(mesh.faces) > 125_000
    buf = io.BytesIO()
    mesh.export(buf, file_type="stl")
    return buf.getvalue(), len(mesh.faces), np.asarray(mesh.extents, dtype=float)


# ---------------------------------------------------------------------------
# 1 & 2. Auth Mode, Setup Wizard Status & Complete Flow
# ---------------------------------------------------------------------------


def test_setup_wizard_fresh_db_completion_and_lockdown(
    prod_client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
):
    # Fresh DB with 0 admins and DEV_SEED=false -> needs_setup=True
    r_mode = prod_client.get("/api/auth/mode")
    assert r_mode.status_code == 200, r_mode.text
    mode = r_mode.json()
    assert mode["dev_mode"] is False
    assert mode["slicer_mode"] == "orcaslicer"
    assert mode["fdm_mode"] == "live"
    assert mode["needs_setup"] is True

    r_status = prod_client.get("/api/setup/status")
    assert r_status.status_code == 200, r_status.text
    st = r_status.json()
    assert st["needs_setup"] is True
    assert st["has_admin"] is False
    assert st["token_valid"] is False
    assert st["setup_completed"] is False
    assert st["dev_mode"] is False

    # Connectivity probes are accessible before first admin exists
    monkeypatch.setattr(
        "app.routers.setup.probe_orca_cli",
        lambda path=None: (True, "/usr/bin/orca-slicer", "2.3.0", "OrcaSlicer CLI ready"),
    )
    r_orca = prod_client.post("/api/setup/test-orcaslicer", json={"orca_cli_path": "/usr/bin/orca-slicer"})
    assert r_orca.status_code == 200
    assert r_orca.json() == {
        "ok": True,
        "path": "/usr/bin/orca-slicer",
        "version": "2.3.0",
        "detail": "OrcaSlicer CLI ready",
    }

    async def fake_list_printers(self):
        return [
            RemotePrinterInfo(
                fdm_monster_id="p1",
                name="Voron Lab",
                printer_type="klipper",
                status="idle",
                queue_count=0,
                bed_x_mm=300.0,
                bed_y_mm=300.0,
                bed_z_mm=300.0,
                mmu_slots_count=1,
            )
        ]

    monkeypatch.setattr("app.routers.setup.LiveFdmMonsterAdapter.list_printers", fake_list_printers)
    r_fdm = prod_client.post(
        "/api/setup/test-fdm",
        json={"fdm_monster_url": "http://fdm-monster:4000", "fdm_monster_api_key": "abc"},
    )
    assert r_fdm.status_code == 200
    assert r_fdm.json()["ok"] is True
    assert r_fdm.json()["printer_count"] == 1

    # Mock mode rejected in production setup
    r_mock_rej = prod_client.post(
        "/api/setup/complete",
        json={
            "admin_username": "mainadmin",
            "admin_name": "Main Admin",
            "admin_password": "prodpassword123",
            "slicer_mode": "mock",
        },
    )
    assert r_mock_rej.status_code == 400
    assert r_mock_rej.json()["detail"]["code"] == "MOCK_MODE_DISABLED"

    # Existing non-admin account with same username -> 409 USERNAME_TAKEN
    with database.SessionLocal() as db:
        db.add(
            User(
                da="takenuser",
                name="Student Taken",
                password_hash=hash_password("pass1234"),
                role="student",
                approval_status="approved",
                is_active=True,
            )
        )
        db.commit()

    r_conflict = prod_client.post(
        "/api/setup/complete",
        json={
            "admin_username": "takenuser",
            "admin_name": "Should Fail",
            "admin_password": "prodpassword123",
        },
    )
    assert r_conflict.status_code == 409
    assert r_conflict.json()["detail"]["code"] == "USERNAME_TAKEN"

    # Complete initial setup cleanly
    r_done = prod_client.post(
        "/api/setup/complete",
        json={
            "admin_username": "MainAdmin",
            "admin_name": "FabLab Coordinator",
            "admin_password": "prodpassword123",
            "institution": "3D Print Lab — Labo 3D",
            "slicer_mode": "orcaslicer",
            "orca_cli_path": "/usr/local/bin/orca-slicer",
            "max_concurrent_slices": 3,
            "fdm_monster_mode": "live",
            "fdm_monster_url": "http://fdm-prod:4000",
            "fdm_monster_api_key": "live-key-9876",
            "default_max_active_grams": 150.0,
            "default_max_print_minutes": 420,
        },
    )
    assert r_done.status_code == 200, r_done.text
    done_body = r_done.json()
    assert done_body["access_token"]
    assert done_body["user"]["da"] == "mainadmin"
    assert done_body["user"]["role"] == "admin"

    # Post-setup: /api/auth/mode & /api/setup/status reflect completion
    mode_after = prod_client.get("/api/auth/mode").json()
    assert mode_after["needs_setup"] is False
    assert mode_after["institution"] == "3D Print Lab — Labo 3D"

    st_after = prod_client.get("/api/setup/status").json()
    assert st_after["needs_setup"] is False
    assert st_after["has_admin"] is True
    assert st_after["token_valid"] is False
    assert st_after["setup_completed"] is True
    assert st_after["current_settings"]["max_concurrent_slices"] == 3
    assert st_after["current_settings"]["has_fdm_monster_api_key"] is True
    assert st_after["current_settings"]["default_max_active_grams"] == 150.0
    assert st_after["current_settings"]["default_max_print_minutes"] == 420

    # Subsequent setup/complete & unauthenticated setup probes are locked (403 SETUP_LOCKED)
    r_locked = prod_client.post(
        "/api/setup/complete",
        json={
            "admin_username": "attacker",
            "admin_name": "Attacker",
            "admin_password": "evilpassword",
        },
    )
    assert r_locked.status_code == 403
    assert r_locked.json()["detail"]["code"] == "SETUP_LOCKED"

    r_probe_locked = prod_client.post("/api/setup/test-orcaslicer", json={"orca_cli_path": "orca-slicer"})
    assert r_probe_locked.status_code == 403
    assert r_probe_locked.json()["detail"]["code"] == "SETUP_LOCKED"

    # Signed-in admin can still use setup probe endpoints
    r_probe_admin = prod_client.post(
        "/api/setup/test-orcaslicer",
        headers=_auth(done_body["access_token"]),
        json={"orca_cli_path": "/usr/bin/orca-slicer"},
    )
    assert r_probe_admin.status_code == 200
    assert r_probe_admin.json()["ok"] is True


# ---------------------------------------------------------------------------
# 3. CLI Commands (create-admin, trigger-setup, check-health) & One-Time Token
# ---------------------------------------------------------------------------


def test_cli_commands_and_one_time_setup_token(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
):
    test_engine, _ = _setup_isolated_db(tmp_path, monkeypatch, dev_seed=False)
    try:
        # 1) create-admin creates Main Admin and marks setup_completed=True
        rc = cli.main(
            [
                "create-admin",
                "--username",
                "CliAdmin",
                "--name",
                "CLI Admin",
                "--password",
                "firstpass123",
            ]
        )
        assert rc == 0
        out = capsys.readouterr().out
        assert "cliadmin" in out and "setup_completed=True" in out

        # Duplicate without --reset fails cleanly
        rc_dup = cli.main(
            [
                "create-admin",
                "--username",
                "cliadmin",
                "--name",
                "CLI Admin",
                "--password",
                "secondpass123",
            ]
        )
        assert rc_dup == 1
        capsys.readouterr()

        # --reset updates password and bumps token_version
        rc_reset = cli.main(
            [
                "create-admin",
                "--username",
                "cliadmin",
                "--name",
                "CLI Admin Updated",
                "--password",
                "secondpass123",
                "--reset",
            ]
        )
        assert rc_reset == 0
        capsys.readouterr()

        with database.SessionLocal() as db:
            admin = db.scalar(select(User).where(User.da == "cliadmin"))
            assert admin is not None
            assert admin.name == "CLI Admin Updated"
            assert admin.token_version == 1

        # 2) trigger-setup issues a valid token & setup URL
        rc_trig = cli.main(
            [
                "trigger-setup",
                "--ttl-minutes",
                "15",
                "--base-url",
                "https://print.example.edu/",
            ]
        )
        assert rc_trig == 0
        trig_out = capsys.readouterr().out
        m_tok = re.search(r"Setup token:\s*(\S+)", trig_out)
        assert m_tok is not None
        setup_token = m_tok.group(1)
        assert f"https://print.example.edu/setup?token={setup_token}" in trig_out

        # 3) check-health verifies DB, OrcaSlicer probe, and FDM Monster probe
        monkeypatch.setattr(
            cli,
            "probe_orca_cli",
            lambda _path=None: (True, "/usr/bin/orca-slicer", "2.3.0", "ready"),
        )

        async def fake_fdm_list(self):
            return []

        monkeypatch.setattr(cli.LiveFdmMonsterAdapter, "list_printers", fake_fdm_list)
        rc_health = cli.main(["check-health"])
        assert rc_health == 0
        health_out = capsys.readouterr().out
        assert "Database: OK (admins=1, dev_seed=False)" in health_out
        assert "OrcaSlicer: OK" in health_out
        assert "FDM Monster: OK (0 printer(s)" in health_out

        # 4) Verify ?token= grants one-time access to /api/setup/status & /api/setup/complete, then invalidates
        with TestClient(main.app) as client:
            st_tok = client.get(f"/api/setup/status?token={setup_token}")
            assert st_tok.status_code == 200
            assert st_tok.json()["has_admin"] is True
            assert st_tok.json()["token_valid"] is True
            assert st_tok.json()["needs_setup"] is True

            # Login works with CLI-reset password
            assert _login(client, "cliadmin", "secondpass123")["user"]["da"] == "cliadmin"

            # Reconfigure via ?token=
            r_complete = client.post(
                f"/api/setup/complete?token={setup_token}",
                json={
                    "admin_username": "cliadmin",
                    "admin_password": "thirdpass789",
                    "default_max_active_grams": 220.0,
                },
            )
            assert r_complete.status_code == 200, r_complete.text
            assert r_complete.json()["access_token"]

            # Same token is now invalidated
            st_reused = client.get(f"/api/setup/status?token={setup_token}").json()
            assert st_reused["token_valid"] is False
            assert st_reused["needs_setup"] is False

            r_reuse = client.post(
                f"/api/setup/complete?token={setup_token}",
                json={"default_max_active_grams": 300.0},
            )
            assert r_reuse.status_code == 403
            assert r_reuse.json()["detail"]["code"] == "SETUP_LOCKED"

            # Expired token from trigger-setup is rejected
            assert cli.main(["trigger-setup", "--ttl-minutes", "10"]) == 0
            exp_out = capsys.readouterr().out
            exp_token = re.search(r"Setup token:\s*(\S+)", exp_out).group(1)  # type: ignore[union-attr]
            with database.SessionLocal() as db:
                cfg = db.get(SystemSettings, 1)
                assert cfg is not None
                cfg.setup_token_expires_at = datetime.now(timezone.utc) - timedelta(minutes=1)
                db.commit()

            assert client.get(f"/api/setup/status?token={exp_token}").json()["token_valid"] is False
            r_exp = client.post(
                f"/api/setup/complete?token={exp_token}",
                json={"default_max_active_grams": 300.0},
            )
            assert r_exp.status_code == 403
            assert r_exp.json()["detail"]["code"] == "SETUP_LOCKED"
    finally:
        test_engine.dispose()


# ---------------------------------------------------------------------------
# 4. Async Slice Queue, Polling, Queue Stats, ?sync=true & SLICE_FAILED
# ---------------------------------------------------------------------------


def test_async_slice_queue_polling_stats_sync_and_failure(
    dev_client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
):
    s_token = _login(dev_client, "2345678", "student123")["access_token"]
    printers = dev_client.get("/api/printers", headers=_auth(s_token)).json()
    voron = printers[0]
    slot = voron["slots"][0]

    r_up = dev_client.post(
        "/api/jobs/upload",
        headers=_auth(s_token),
        files={"file": ("queue_part.stl", _make_cube_stl_bytes(), "model/stl")},
        data={"printer_id": str(voron["id"]), "slot_id": str(slot["id"])},
    )
    assert r_up.status_code == 201, r_up.text
    job_id = r_up.json()["id"]

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

    # Gate run_slice so we deterministically observe SLICING_QUEUED / SLICING + queue stats
    real_run_slice = slice_queue_mod.run_slice
    entered = threading.Event()
    release = threading.Event()

    def gated_run_slice(*args, **kwargs):
        entered.set()
        release.wait(timeout=5.0)
        return real_run_slice(*args, **kwargs)

    monkeypatch.setattr(slice_queue_mod, "run_slice", gated_run_slice)

    r_async = dev_client.post(f"/api/jobs/{job_id}/slice", headers=_auth(s_token), json=slice_payload)
    assert r_async.status_code == 200, r_async.text
    queued_job = r_async.json()
    assert queued_job["status"] == JobStatus.SLICING_QUEUED.value

    assert entered.wait(timeout=3.0)
    r_stats_busy = dev_client.get("/api/jobs/queue/stats", headers=_auth(s_token))
    assert r_stats_busy.status_code == 200
    busy_stats = r_stats_busy.json()
    assert busy_stats["max_workers"] >= 1
    assert busy_stats["active_workers"] + busy_stats["queued_count"] >= 1

    r_poll_busy = dev_client.get(f"/api/jobs/{job_id}", headers=_auth(s_token))
    assert r_poll_busy.status_code == 200
    assert r_poll_busy.json()["status"] in (JobStatus.SLICING_QUEUED.value, JobStatus.SLICING.value)
    assert r_poll_busy.json()["slice_queue_position"] is not None

    release.set()

    # Poll GET /api/jobs/{id} until SLICED
    polled = None
    for _ in range(60):
        r_poll = dev_client.get(f"/api/jobs/{job_id}", headers=_auth(s_token))
        assert r_poll.status_code == 200
        polled = r_poll.json()
        if polled["status"] == JobStatus.SLICED.value:
            break
        time.sleep(0.05)

    assert polled is not None
    assert polled["status"] == JobStatus.SLICED.value
    assert polled["estimated_grams"] > 0
    assert polled["gcode_url"] == f"/api/jobs/{job_id}/gcode"
    assert polled["slice_error"] is None
    assert polled["slice_queue_position"] is None

    idle_stats = dev_client.get("/api/jobs/queue/stats", headers=_auth(s_token)).json()
    assert idle_stats["active_workers"] == 0
    assert idle_stats["queued_count"] == 0

    # ?sync=true returns SLICED directly in one request
    monkeypatch.setattr(slice_queue_mod, "run_slice", real_run_slice)
    r_sync = dev_client.post(
        f"/api/jobs/{job_id}/slice?sync=true",
        headers=_auth(s_token),
        json={**slice_payload, "supports_enabled": False},
    )
    assert r_sync.status_code == 200, r_sync.text
    assert r_sync.json()["status"] == JobStatus.SLICED.value
    assert r_sync.json()["supports_enabled"] is False

    # Slicer failure sets SLICE_FAILED + slice_error (async) and 400 SLICER_ERROR (?sync=true)
    def failing_run_slice(*_args, **_kwargs):
        raise SlicerError("Simulated OrcaSlicer failure")

    monkeypatch.setattr(slice_queue_mod, "run_slice", failing_run_slice)

    r_fail_async = dev_client.post(f"/api/jobs/{job_id}/slice", headers=_auth(s_token), json=slice_payload)
    assert r_fail_async.status_code == 200
    assert r_fail_async.json()["status"] == JobStatus.SLICING_QUEUED.value

    failed_body = None
    for _ in range(60):
        r_poll = dev_client.get(f"/api/jobs/{job_id}", headers=_auth(s_token))
        assert r_poll.status_code == 200
        failed_body = r_poll.json()
        if failed_body["status"] == JobStatus.SLICE_FAILED.value:
            break
        time.sleep(0.05)

    assert failed_body is not None
    assert failed_body["status"] == JobStatus.SLICE_FAILED.value
    assert "Simulated OrcaSlicer failure" in (failed_body["slice_error"] or "")

    r_fail_sync = dev_client.post(
        f"/api/jobs/{job_id}/slice?sync=true",
        headers=_auth(s_token),
        json=slice_payload,
    )
    assert r_fail_sync.status_code == 400
    assert r_fail_sync.json()["detail"]["code"] == "SLICER_ERROR"
    assert "Simulated OrcaSlicer failure" in r_fail_sync.json()["detail"]["message"]


def test_slice_queue_manager_unit_bounds_replacement_and_recovery(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    test_engine, _ = _setup_isolated_db(tmp_path, monkeypatch, dev_seed=True)
    mgr = SliceQueueManager(max_workers=1, max_queue_size=2)
    try:
        assert mgr.set_max_workers(10) == 4
        assert mgr.set_max_workers(0) == 1
        assert mgr.stats()["max_workers"] == 1

        # Seed DB and test stale recovery
        database.init_db()
        with database.SessionLocal() as db:
            from app.seed import seed_database

            seed_database(db)
            user = db.scalar(select(User).where(User.da == "2345678"))
            printer = db.scalar(select(Printer).limit(1))
            assert user is not None and printer is not None
            slot = printer.slots[0]
            j_queued = PrintJob(
                user_id=user.id,
                printer_id=printer.id,
                slot_id=slot.id,
                filament_id=slot.filament_id,
                status=JobStatus.SLICING_QUEUED.value,
                original_filename="stale_q.stl",
                original_stl_path=str(tmp_path / "stale_q.stl"),
                oriented_stl_path=str(tmp_path / "stale_q_o.stl"),
            )
            j_active = PrintJob(
                user_id=user.id,
                printer_id=printer.id,
                slot_id=slot.id,
                filament_id=slot.filament_id,
                status=JobStatus.SLICING.value,
                original_filename="stale_a.stl",
                original_stl_path=str(tmp_path / "stale_a.stl"),
                oriented_stl_path=str(tmp_path / "stale_a_o.stl"),
            )
            db.add_all([j_queued, j_active])
            db.commit()
            stale_ids = (j_queued.id, j_active.id)

        # Gate execution so worker holds slot 1 while we test queue capacity & replacement
        entered = threading.Event()
        release = threading.Event()

        def slow_execute(_self, _task: SliceTask) -> None:
            entered.set()
            release.wait(timeout=5.0)

        monkeypatch.setattr(SliceQueueManager, "_execute_task", slow_execute)
        mgr.start(max_workers=1)

        with database.SessionLocal() as db:
            for jid in stale_ids:
                row = db.get(PrintJob, jid)
                assert row is not None and row.status == JobStatus.DRAFT.value

        def _task(jid: int, scale: float = 1.0) -> SliceTask:
            return SliceTask(
                job_id=jid,
                printer_id=1,
                slot_id=1,
                pos_x_mm=0.0,
                pos_y_mm=0.0,
                quat_x=0.0,
                quat_y=0.0,
                quat_z=0.0,
                quat_w=1.0,
                scale=scale,
                supports_enabled=True,
                gcode_path=str(tmp_path / f"{jid}.gcode"),
            )

        seq1 = mgr.enqueue(_task(101))
        assert entered.wait(timeout=3.0)
        assert mgr.get_position(101) == 0

        # Fill bounded pending queue (capacity=2)
        mgr.enqueue(_task(102, scale=1.0))
        mgr.enqueue(_task(103, scale=1.0))
        assert mgr.get_position(102) == 1
        assert mgr.get_position(103) == 2

        # Replacing existing job_id=102 succeeds without hitting SliceQueueFullError
        mgr.enqueue(_task(102, scale=1.25))
        assert mgr.stats()["queued_count"] == 2

        # Adding a 3rd waiting job exceeds max_queue_size=2
        with pytest.raises(SliceQueueFullError):
            mgr.enqueue(_task(104))

        release.set()
        assert mgr.wait_for_job(101, target_seq=seq1, timeout=5.0) is True
        assert mgr.wait_for_job(103, timeout=5.0) is True
        assert mgr.stats()["queued_count"] == 0
    finally:
        mgr.stop(timeout=2.0)
        test_engine.dispose()


# ---------------------------------------------------------------------------
# 5. Heavy STL Preview Decimation & /mesh ETag / 304 / ?full=true
# ---------------------------------------------------------------------------


def test_heavy_stl_preview_decimation_and_mesh_etag_caching(
    dev_client: TestClient,
    tmp_path: Path,
):
    heavy_bytes, orig_faces, orig_extents = _make_heavy_stl_bytes(radius=20.0)
    assert orig_faces > 125_000

    # Direct generate_preview_stl check on heavy STL
    oriented_path = tmp_path / "oriented.stl"
    preview_path = tmp_path / "preview.stl"
    oriented_path.write_bytes(heavy_bytes)

    created = generate_preview_stl(oriented_path, preview_path)
    assert created is True
    assert preview_path.is_file()
    preview_mesh = trimesh.load(str(preview_path), file_type="stl", force="mesh", process=False)
    assert 0 < len(preview_mesh.faces) <= 120_000
    assert len(preview_mesh.faces) < orig_faces
    np.testing.assert_allclose(preview_mesh.extents, orig_extents, atol=0.05)

    # Small mesh (<= 120,000 faces) skips preview generation
    small_path = tmp_path / "small.stl"
    small_preview = tmp_path / "small_preview.stl"
    small_path.write_bytes(_make_cube_stl_bytes())
    assert generate_preview_stl(small_path, small_preview) is False
    assert not small_preview.exists()

    # Upload heavy STL via API and verify GET /api/jobs/{id}/mesh + ETag + 304 + ?full=true
    s_token = _login(dev_client, "2345678", "student123")["access_token"]
    printers = dev_client.get("/api/printers", headers=_auth(s_token)).json()
    voron = printers[0]
    slot = voron["slots"][0]

    r_up = dev_client.post(
        "/api/jobs/upload",
        headers=_auth(s_token),
        files={"file": ("heavy_sphere.stl", heavy_bytes, "model/stl")},
        data={"printer_id": str(voron["id"]), "slot_id": str(slot["id"])},
    )
    assert r_up.status_code == 201, r_up.text
    job = r_up.json()

    r_mesh_preview = dev_client.get(f"/api/jobs/{job['id']}/mesh", headers=_auth(s_token))
    assert r_mesh_preview.status_code == 200
    etag_preview = r_mesh_preview.headers.get("etag")
    assert etag_preview
    assert "max-age=3600" in r_mesh_preview.headers.get("cache-control", "")

    loaded_preview = trimesh.load(io.BytesIO(r_mesh_preview.content), file_type="stl", force="mesh", process=False)
    assert len(loaded_preview.faces) <= 120_000
    assert len(loaded_preview.faces) < orig_faces
    np.testing.assert_allclose(loaded_preview.extents, orig_extents, atol=0.1)

    # Conditional GET with matching ETag -> 304 Not Modified
    r_304 = dev_client.get(
        f"/api/jobs/{job['id']}/mesh",
        headers={**_auth(s_token), "If-None-Match": etag_preview},
    )
    assert r_304.status_code == 304
    assert r_304.content == b""

    # ?full=true returns the full-resolution oriented mesh with distinct ETag
    r_mesh_full = dev_client.get(f"/api/jobs/{job['id']}/mesh?full=true", headers=_auth(s_token))
    assert r_mesh_full.status_code == 200
    assert r_mesh_full.headers.get("etag") != etag_preview
    assert len(r_mesh_full.content) > len(r_mesh_preview.content)
    loaded_full = trimesh.load(io.BytesIO(r_mesh_full.content), file_type="stl", force="mesh", process=False)
    assert len(loaded_full.faces) == orig_faces


def test_live_fdm_monster_api_key_normalization_and_401_diagnostics(monkeypatch):
    import asyncio
    import httpx
    import pytest
    from app.services.fdm_monster import FdmMonsterError, LiveFdmMonsterAdapter

    # 1. Strips whitespace, matching quotes, and redundant "Bearer " prefix
    adapter = LiveFdmMonsterAdapter(
        "http://fdm-monster:4000",
        '  Bearer "fdmm_api_123456789012345678901234567890"  ',
    )
    assert adapter.api_key == "fdmm_api_123456789012345678901234567890"
    assert adapter._headers() == {"Authorization": "Bearer fdmm_api_123456789012345678901234567890"}

    # 2. Rejects truncated preview / short fdmm_api_ keys before making network calls
    called = False

    async def fail_if_called(self, url, **kwargs):  # noqa: ANN001
        nonlocal called
        called = True
        raise AssertionError("Network call should not happen for truncated key")

    monkeypatch.setattr(httpx.AsyncClient, "get", fail_if_called)

    for bad_key in ("fdmm_api_uFAu7x\u2026", "fdmm_api_short"):
        bad_adapter = LiveFdmMonsterAdapter("http://fdm-monster:4000", bad_key)
        with pytest.raises(FdmMonsterError) as exc_info:
            asyncio.run(bad_adapter.list_printers())
        msg = str(exc_info.value)
        assert "truncated" in msg
        assert "full one-time" in msg
    assert called is False

    # 3. Clear 401 diagnostics with empty and non-empty tokens
    async def mock_401_get(self, url, **kwargs):  # noqa: ANN001
        req = httpx.Request("GET", url)
        return httpx.Response(401, json={"message": "Invalid API key"}, request=req)

    monkeypatch.setattr(httpx.AsyncClient, "get", mock_401_get)

    empty_adapter = LiveFdmMonsterAdapter("http://fdm-monster:4000", "")
    with pytest.raises(FdmMonsterError) as empty_exc:
        asyncio.run(empty_adapter.list_printers())
    assert "401 Unauthorized" in str(empty_exc.value)
    assert "no API key sent" in str(empty_exc.value)
    assert "Invalid API key" in str(empty_exc.value)

    full_token = "fdmm_api_" + ("A" * 43)
    full_adapter = LiveFdmMonsterAdapter("http://fdm-monster:4000", full_token)
    with pytest.raises(FdmMonsterError) as full_exc:
        asyncio.run(full_adapter.list_printers())
    full_msg = str(full_exc.value)
    assert "401 Unauthorized" in full_msg
    assert f"len={len(full_token)}" in full_msg
    assert "Invalid API key" in full_msg
    assert full_token not in full_msg
