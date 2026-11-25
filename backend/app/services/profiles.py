"""OrcaSlicer profile storage, inheritance flattening, and calibration test-slice service."""

from __future__ import annotations

import json
import tempfile
import uuid
from pathlib import Path
from typing import Optional

import trimesh

from app.config import settings
from app.models import OrcaProfile, Printer, PrinterSlot, SystemSettings
from app.schemas import TestSliceResponse
from app.services.slicer import (
    build_command_preview,
    resolve_and_flatten_profile,
    run_slice,
)


def save_profile_file(filename: str, content: bytes, kind: Optional[str] = None) -> Path:
    """Validate JSON profile content, resolve any 'inherits' chain, and persist to data/profiles/."""
    try:
        parsed = json.loads(content.decode("utf-8-sig"))
    except Exception as exc:
        raise ValueError(f"Profile must be valid JSON: {exc}") from exc

    if not isinstance(parsed, dict):
        raise ValueError("Profile JSON must be a JSON object")

    if isinstance(parsed.get("inherits"), str) and parsed["inherits"].strip():
        parsed = resolve_and_flatten_profile(parsed, kind=kind)
        out_bytes = json.dumps(parsed, indent=2).encode("utf-8")
    else:
        out_bytes = content

    settings.ensure_directories()
    safe_name = Path(filename).name or "profile.json"
    stored_name = f"{uuid.uuid4().hex[:8]}_{safe_name}"
    dest = settings.profiles_dir / stored_name
    dest.write_bytes(out_bytes)
    return dest


def test_slice_calibration_cube(
    printer: Printer,
    slot: PrinterSlot,
    sys_settings: SystemSettings,
) -> TestSliceResponse:
    """Run a 20mm calibration cube through the configured slicer adapter to validate profiles."""
    with tempfile.TemporaryDirectory() as tmpdir:
        tmp = Path(tmpdir)
        cube_stl = tmp / "calibration_20mm.stl"
        out_gcode = tmp / "calibration_20mm.gcode"

        cube = trimesh.creation.box(extents=[20.0, 20.0, 20.0])
        cube.apply_translation([0.0, 0.0, 10.0])
        cube.export(str(cube_stl), file_type="stl")

        result = run_slice(
            oriented_stl_path=cube_stl,
            output_gcode_path=out_gcode,
            printer=printer,
            slot=slot,
            sys_settings=sys_settings,
        )
        preview = result.command_preview or build_command_preview(printer, slot, sys_settings)
        return TestSliceResponse(
            ok=True,
            estimated_grams=result.estimated_grams,
            estimated_minutes=result.estimated_minutes,
            layer_count=result.layer_count,
            command_preview=preview,
        )


def delete_profile_file(profile: OrcaProfile) -> None:
    """Remove profile JSON file from disk if present."""
    try:
        path = Path(profile.file_path)
        if path.exists():
            path.unlink()
    except OSError:
        pass
