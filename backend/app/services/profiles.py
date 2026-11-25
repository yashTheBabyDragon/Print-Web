"""OrcaSlicer profile storage, inheritance flattening, and calibration test-slice service."""

from __future__ import annotations

import io
import json
import re
import tempfile
import uuid
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional

import trimesh

from app.config import settings
from app.models import OrcaProfile, Printer, PrinterSlot, ProfileKind, SystemSettings
from app.schemas import TestSliceResponse
from app.services.slicer import (
    build_command_preview,
    resolve_and_flatten_profile,
    run_slice,
)

_HEX_COLOR_RE = re.compile(r"^#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$")
_FILAMENT_HINT_KEYS = frozenset(
    {
        "filament_type",
        "filament_density",
        "nozzle_temperature",
        "filament_settings_id",
        "filament_vendor",
        "filament_colour",
        "default_filament_colour",
    }
)


@dataclass
class ParsedOrcaFilament:
    name: str
    material: str
    density_g_cm3: float
    color_hex: str
    notes: str


def _first_str(val: Any) -> Optional[str]:
    if isinstance(val, list):
        for item in val:
            s = str(item).strip()
            if s:
                return s
        return None
    if isinstance(val, (str, int, float)):
        s = str(val).strip()
        return s or None
    return None


def _normalize_hex_color(raw: Optional[str]) -> Optional[str]:
    if not raw:
        return None
    cleaned = raw.strip()
    if not cleaned.startswith("#"):
        cleaned = f"#{cleaned}"
    m = _HEX_COLOR_RE.match(cleaned)
    if not m:
        return None
    digits = m.group(1)
    if len(digits) == 3:
        digits = "".join(ch * 2 for ch in digits)
    return f"#{digits.upper()}"


def extract_orca_filament_entries(filename: str, content: bytes) -> list[tuple[str, bytes]]:
    """Extract (json_filename, raw_bytes) pairs from a .json, .orca_filament, or .zip upload."""
    safe_name = Path(filename or "filament.json").name
    lower = safe_name.lower()

    if lower.endswith((".orca_filament", ".zip")):
        try:
            zf = zipfile.ZipFile(io.BytesIO(content))
        except zipfile.BadZipFile as exc:
            raise ValueError("Invalid .orca_filament / .zip archive") from exc

        entries: list[tuple[str, bytes]] = []
        with zf:
            for info in zf.infolist():
                if info.is_dir():
                    continue
                member_path = info.filename.replace("\\", "/")
                if member_path.startswith("__MACOSX/") or "/__MACOSX/" in member_path:
                    continue
                if not member_path.lower().endswith(".json"):
                    continue
                entries.append((Path(member_path).name, zf.read(info)))

        if not entries:
            raise ValueError("Archive does not contain any .json filament profile files")
        return entries

    if lower.endswith(".json"):
        return [(safe_name, content)]

    raise ValueError("Unsupported file type (expected .json, .orca_filament, or .zip)")


def parse_orca_filament_json(
    filename: str,
    content: bytes,
    default_color_hex: Optional[str] = None,
) -> ParsedOrcaFilament:
    """Validate an OrcaSlicer filament JSON profile and extract GGPrint filament metadata."""
    try:
        data = json.loads(content.decode("utf-8-sig"))
    except Exception as exc:
        raise ValueError(f"Invalid JSON: {exc}") from exc

    if not isinstance(data, dict):
        raise ValueError("Filament profile must be a JSON object")

    raw_type = str(data.get("type") or "").strip().lower()
    if raw_type in ("machine", "process"):
        raise ValueError(f"Expected filament profile, got '{raw_type}' profile")
    if raw_type != "filament" and not any(k in data for k in _FILAMENT_HINT_KEYS):
        raise ValueError("JSON does not appear to be an OrcaSlicer filament profile")

    if isinstance(data.get("inherits"), str) and data["inherits"].strip():
        data = resolve_and_flatten_profile(data, kind=ProfileKind.FILAMENT.value)

    raw_name = str(data.get("name") or "").strip() or Path(filename).stem
    name = raw_name[:120]

    raw_material = _first_str(data.get("filament_type")) or "PLA"
    material = raw_material.upper()[:40]

    density = 1.24
    raw_density = _first_str(data.get("filament_density"))
    if raw_density:
        try:
            parsed_d = float(raw_density)
            if 0.1 < parsed_d <= 10.0:
                density = round(parsed_d, 3)
        except ValueError:
            pass

    color_hex = (
        _normalize_hex_color(_first_str(data.get("default_filament_colour")))
        or _normalize_hex_color(_first_str(data.get("filament_colour")))
        or _normalize_hex_color(default_color_hex)
        or "#6B7280"
    )

    nozzle_temp = _first_str(data.get("nozzle_temperature"))
    bed_temp = _first_str(data.get("textured_plate_temp")) or _first_str(data.get("hot_plate_temp"))
    note_parts = ["Imported from OrcaSlicer"]
    if nozzle_temp:
        note_parts.append(f"{nozzle_temp}C nozzle")
    if bed_temp:
        note_parts.append(f"{bed_temp}C bed")

    return ParsedOrcaFilament(
        name=name,
        material=material,
        density_g_cm3=density,
        color_hex=color_hex,
        notes=" · ".join(note_parts),
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
