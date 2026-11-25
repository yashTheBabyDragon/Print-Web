"""PrusaSlicer .ini config bundle and flat config parser -> OrcaSlicer-compatible JSON profiles."""

from __future__ import annotations

import io
import re
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal, Optional

_HEX_COLOR_RE = re.compile(r"^#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$")
_SECTION_RE = re.compile(r"^\[([^\]]+)\]$")
_SLUG_RE = re.compile(r"[^a-zA-Z0-9._-]+")
MAX_ZIP_ENTRIES = 200
MAX_ZIP_ENTRY_BYTES = 2 * 1024 * 1024  # 2 MB per archive entry
MAX_ZIP_TOTAL_BYTES = 20 * 1024 * 1024  # 20 MB cumulative decompressed bytes

_GCODE_KEYS = frozenset(
    {
        "start_gcode",
        "end_gcode",
        "layer_gcode",
        "before_layer_gcode",
        "toolchange_gcode",
        "start_filament_gcode",
        "end_filament_gcode",
    }
)

_FILAMENT_KEYS = frozenset(
    {
        "filament_type",
        "filament_density",
        "filament_colour",
        "default_filament_colour",
        "temperature",
        "first_layer_temperature",
        "bed_temperature",
        "first_layer_bed_temperature",
        "extrusion_multiplier",
        "filament_max_volumetric_speed",
        "min_fan_speed",
        "max_fan_speed",
        "disable_fan_first_layers",
        "filament_diameter",
        "filament_cost",
        "filament_vendor",
        "start_filament_gcode",
        "end_filament_gcode",
    }
)

_PROCESS_KEYS = frozenset(
    {
        "layer_height",
        "first_layer_height",
        "perimeters",
        "top_solid_layers",
        "bottom_solid_layers",
        "fill_density",
        "fill_pattern",
        "support_material",
        "support_material_threshold",
        "brim_width",
        "skirt_loops",
        "perimeter_speed",
        "infill_speed",
        "travel_speed",
        "first_layer_speed",
        "extrusion_width",
        "seam_position",
    }
)

_MACHINE_KEYS = frozenset(
    {
        "bed_shape",
        "max_print_height",
        "nozzle_diameter",
        "gcode_flavor",
        "start_gcode",
        "end_gcode",
        "layer_gcode",
        "retract_length",
        "retract_speed",
        "retract_lift",
        "deretract_speed",
    }
)


@dataclass
class ConvertedPrusaProfile:
    kind: Literal["filament", "process", "machine"]
    name: str
    filename: str
    source_filename: str
    orca_json: dict[str, Any]
    notes: str
    material: str = "PLA"
    density_g_cm3: float = 1.24
    color_hex: str = "#6B7280"


def _slugify(name: str) -> str:
    cleaned = _SLUG_RE.sub("_", name.strip()).strip("._-")
    return (cleaned or "profile")[:80]


def _unescape_gcode(val: str) -> str:
    raw = val.strip()
    if len(raw) >= 2 and raw[0] == '"' and raw[-1] == '"':
        raw = raw[1:-1]
    return raw.replace("\\r\\n", "\n").replace("\\n", "\n").replace("\\t", "\t").replace("\\\\", "\\")


def _split_list(val: str) -> list[str]:
    if not val:
        return []
    delim = ";" if ";" in val else ","
    return [part.strip().strip('"') for part in val.split(delim) if part.strip().strip('"')]


def _first_val(val: Optional[str]) -> Optional[str]:
    if not val:
        return None
    parts = _split_list(val)
    return parts[0] if parts else val.strip().strip('"') or None


def _normalize_hex_color(raw: Optional[str]) -> Optional[str]:
    if not raw:
        return None
    cleaned = raw.strip().strip('"')
    if not cleaned:
        return None
    if not cleaned.startswith("#"):
        cleaned = f"#{cleaned}"
    m = _HEX_COLOR_RE.match(cleaned)
    if not m:
        return None
    digits = m.group(1)
    if len(digits) == 3:
        digits = "".join(ch * 2 for ch in digits)
    return f"#{digits.upper()}"


def extract_prusaslicer_ini_entries(filename: str, content: bytes) -> list[tuple[str, bytes]]:
    """Extract (ini_filename, raw_bytes) pairs from a .ini or .zip upload."""
    safe_name = Path(filename or "config.ini").name
    lower = safe_name.lower()

    if lower.endswith(".zip"):
        try:
            zf = zipfile.ZipFile(io.BytesIO(content))
        except zipfile.BadZipFile as exc:
            raise ValueError("Invalid .zip archive") from exc

        entries: list[tuple[str, bytes]] = []
        total_uncompressed = 0
        with zf:
            infos = zf.infolist()
            if len(infos) > MAX_ZIP_ENTRIES:
                raise ValueError(f"Archive exceeds maximum allowed entry count ({MAX_ZIP_ENTRIES})")
            for info in infos:
                if info.is_dir():
                    continue
                member_path = info.filename.replace("\\", "/")
                if member_path.startswith("__MACOSX/") or "/__MACOSX/" in member_path:
                    continue
                if not member_path.lower().endswith(".ini"):
                    continue
                if info.file_size > MAX_ZIP_ENTRY_BYTES:
                    raise ValueError(
                        f"Archive entry '{Path(member_path).name}' exceeds maximum uncompressed size of 2 MB"
                    )
                with zf.open(info, "r") as member_stream:
                    data = member_stream.read(MAX_ZIP_ENTRY_BYTES + 1)
                if len(data) > MAX_ZIP_ENTRY_BYTES:
                    raise ValueError(
                        f"Archive entry '{Path(member_path).name}' exceeds maximum uncompressed size of 2 MB"
                    )
                total_uncompressed += len(data)
                if total_uncompressed > MAX_ZIP_TOTAL_BYTES:
                    raise ValueError("Archive exceeds maximum total uncompressed size of 20 MB")
                entries.append((Path(member_path).name, data))

        if not entries:
            raise ValueError("Archive does not contain any .ini files")
        return entries

    if lower.endswith(".ini"):
        return [(safe_name, content)]

    raise ValueError("Unsupported file type (expected .ini or .zip)")


def _parse_ini_sections(text: str) -> tuple[dict[str, str], list[tuple[str, dict[str, str]]]]:
    """Parse INI text into (flat_keys, [(section_header, keys_dict), ...])."""
    flat: dict[str, str] = {}
    sections: list[tuple[str, dict[str, str]]] = []
    current_dict: dict[str, str] = flat

    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or line.startswith(";"):
            continue
        sec_match = _SECTION_RE.match(line)
        if sec_match:
            sec_name = sec_match.group(1).strip()
            current_dict = {}
            sections.append((sec_name, current_dict))
            continue
        if "=" not in line:
            continue
        key, val = line.split("=", 1)
        key = key.strip()
        val = val.strip()
        if not key:
            continue
        if key in _GCODE_KEYS:
            val = _unescape_gcode(val)
        current_dict[key] = val

    return flat, sections


def _resolve_bundle_inherits(
    kind_prefix: str,
    name: str,
    sections_by_key: dict[tuple[str, str], dict[str, str]],
    visited: set[str],
) -> dict[str, str]:
    """Recursively resolve `inherits = parent1; parent2` within the same PrusaSlicer bundle."""
    if name in visited:
        return {}
    visited.add(name)

    raw = sections_by_key.get((kind_prefix, name))
    if raw is None:
        return {}

    merged: dict[str, str] = {}
    inherits_raw = raw.get("inherits", "").strip()
    if inherits_raw:
        for parent_name in [p.strip() for p in inherits_raw.split(";") if p.strip()]:
            parent_vals = _resolve_bundle_inherits(kind_prefix, parent_name, sections_by_key, visited)
            merged.update(parent_vals)

    for k, v in raw.items():
        if k != "inherits":
            merged[k] = v
    return merged


def _convert_filament(name: str, kv: dict[str, str], source_filename: str) -> ConvertedPrusaProfile:
    material = (_first_val(kv.get("filament_type")) or "PLA").upper()[:40]
    density = 1.24
    raw_d = _first_val(kv.get("filament_density"))
    if raw_d:
        try:
            d_val = float(raw_d)
            if 0.1 < d_val <= 10.0:
                density = round(d_val, 3)
        except ValueError:
            pass

    color_hex = (
        _normalize_hex_color(_first_val(kv.get("default_filament_colour")))
        or _normalize_hex_color(_first_val(kv.get("filament_colour")))
        or "#6B7280"
    )

    nozzle_temp = _first_val(kv.get("temperature")) or "210"
    nozzle_init = _first_val(kv.get("first_layer_temperature")) or nozzle_temp
    bed_temp = _first_val(kv.get("bed_temperature")) or "60"
    bed_init = _first_val(kv.get("first_layer_bed_temperature")) or bed_temp
    flow_ratio = _first_val(kv.get("extrusion_multiplier")) or "0.98"
    max_vol = _first_val(kv.get("filament_max_volumetric_speed")) or "15"
    fan_min = _first_val(kv.get("min_fan_speed")) or "100"
    fan_max = _first_val(kv.get("max_fan_speed")) or "100"
    close_fan = _first_val(kv.get("disable_fan_first_layers")) or "1"
    diameter = _first_val(kv.get("filament_diameter")) or "1.75"
    cost = _first_val(kv.get("filament_cost")) or "25"
    vendor = _first_val(kv.get("filament_vendor")) or "PrusaSlicer"
    start_gcode = kv.get("start_filament_gcode", "; filament start gcode\n")
    end_gcode = kv.get("end_filament_gcode", "; filament end gcode\n")

    orca_json: dict[str, Any] = {
        "type": "filament",
        "from": "User",
        "instantiation": "true",
        "version": "2.2.0.0",
        "name": name,
        "filament_settings_id": [name],
        "filament_type": [material],
        "filament_vendor": [vendor],
        "filament_density": [str(density)],
        "filament_diameter": [diameter],
        "filament_flow_ratio": [flow_ratio],
        "filament_cost": [cost],
        "filament_max_volumetric_speed": [max_vol],
        "default_filament_colour": [color_hex],
        "nozzle_temperature": [nozzle_temp],
        "nozzle_temperature_initial_layer": [nozzle_init],
        "hot_plate_temp": [bed_temp],
        "textured_plate_temp": [bed_temp],
        "hot_plate_temp_initial_layer": [bed_init],
        "textured_plate_temp_initial_layer": [bed_init],
        "fan_min_speed": [fan_min],
        "fan_max_speed": [fan_max],
        "close_fan_the_first_x_layers": [close_fan],
        "filament_start_gcode": [start_gcode],
        "filament_end_gcode": [end_gcode],
    }

    notes = f"Imported from PrusaSlicer · {nozzle_temp}C nozzle · {bed_temp}C bed"
    return ConvertedPrusaProfile(
        kind="filament",
        name=name[:120],
        filename=f"{_slugify(name)}_filament.json",
        source_filename=source_filename,
        orca_json=orca_json,
        notes=notes,
        material=material,
        density_g_cm3=density,
        color_hex=color_hex,
    )


def _convert_process(name: str, kv: dict[str, str], source_filename: str) -> ConvertedPrusaProfile:
    layer_h = _first_val(kv.get("layer_height")) or "0.20"
    first_h = _first_val(kv.get("first_layer_height")) or layer_h
    fill_density = _first_val(kv.get("fill_density")) or "15%"
    if fill_density and not fill_density.endswith("%"):
        fill_density = f"{fill_density}%"

    orca_json: dict[str, Any] = {
        "type": "process",
        "from": "User",
        "instantiation": "true",
        "version": "2.2.0.0",
        "name": name,
        "print_settings_id": name,
        "layer_height": layer_h,
        "initial_layer_print_height": first_h,
        "wall_loops": _first_val(kv.get("perimeters")) or "2",
        "top_shell_layers": _first_val(kv.get("top_solid_layers")) or "4",
        "bottom_shell_layers": _first_val(kv.get("bottom_solid_layers")) or "3",
        "sparse_infill_density": fill_density,
        "sparse_infill_pattern": _first_val(kv.get("fill_pattern")) or "gyroid",
        "enable_support": _first_val(kv.get("support_material")) or "0",
        "support_threshold_angle": _first_val(kv.get("support_material_threshold")) or "30",
        "brim_width": _first_val(kv.get("brim_width")) or "0",
        "skirt_loops": _first_val(kv.get("skirt_loops")) or "1",
        "outer_wall_speed": _first_val(kv.get("perimeter_speed")) or "100",
        "sparse_infill_speed": _first_val(kv.get("infill_speed")) or "150",
        "travel_speed": _first_val(kv.get("travel_speed")) or "250",
        "initial_layer_speed": _first_val(kv.get("first_layer_speed")) or "40",
        "line_width": _first_val(kv.get("extrusion_width")) or "0.42",
        "seam_position": _first_val(kv.get("seam_position")) or "aligned",
    }

    notes = f"Imported from PrusaSlicer · {layer_h}mm layer · {fill_density} infill"
    return ConvertedPrusaProfile(
        kind="process",
        name=name[:150],
        filename=f"{_slugify(name)}_process.json",
        source_filename=source_filename,
        orca_json=orca_json,
        notes=notes,
    )


def _convert_machine(name: str, kv: dict[str, str], source_filename: str) -> ConvertedPrusaProfile:
    bed_shape_raw = kv.get("bed_shape", "")
    printable_area = [pt.strip() for pt in bed_shape_raw.split(",") if "x" in pt.strip()]
    if not printable_area:
        printable_area = ["0x0", "250x0", "250x210", "0x210"]

    nozzle_list = _split_list(kv.get("nozzle_diameter", "")) or ["0.4"]
    n_ext = len(nozzle_list)

    def _per_ext(key: str, default: str) -> list[str]:
        vals = _split_list(kv.get(key, ""))
        if not vals:
            return [default] * n_ext
        if len(vals) < n_ext:
            return vals + [vals[-1]] * (n_ext - len(vals))
        return vals[:n_ext]

    gcode_flavor = (_first_val(kv.get("gcode_flavor")) or "marlin2").lower()
    printable_height = _first_val(kv.get("max_print_height")) or "210"

    orca_json: dict[str, Any] = {
        "type": "machine",
        "from": "User",
        "instantiation": "true",
        "version": "2.2.0.0",
        "name": name,
        "printer_settings_id": name,
        "printer_technology": "FFF",
        "gcode_flavor": gcode_flavor,
        "printable_area": printable_area,
        "printable_height": printable_height,
        "nozzle_diameter": nozzle_list,
        "retraction_length": _per_ext("retract_length", "0.8"),
        "retraction_speed": _per_ext("retract_speed", "35"),
        "z_hop": _per_ext("retract_lift", "0.2"),
        "deretraction_speed": _per_ext("deretract_speed", "35"),
        "machine_start_gcode": kv.get("start_gcode", ""),
        "machine_end_gcode": kv.get("end_gcode", ""),
        "layer_change_gcode": kv.get("layer_gcode", ""),
    }

    notes = f"Imported from PrusaSlicer · {gcode_flavor} · Z {printable_height}mm"
    return ConvertedPrusaProfile(
        kind="machine",
        name=name[:150],
        filename=f"{_slugify(name)}_machine.json",
        source_filename=source_filename,
        orca_json=orca_json,
        notes=notes,
    )


def parse_prusaslicer_ini(filename: str, content: bytes) -> list[ConvertedPrusaProfile]:
    """Parse a PrusaSlicer .ini config bundle or flat exported .ini into OrcaSlicer JSON profiles."""
    try:
        text = content.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise ValueError(f"File is not valid UTF-8 text: {exc}") from exc

    flat, sections = _parse_ini_sections(text)
    results: list[ConvertedPrusaProfile] = []

    if sections:
        sections_by_key: dict[tuple[str, str], dict[str, str]] = {}
        ordered_targets: list[tuple[str, str]] = []

        for header, kv in sections:
            if ":" not in header:
                continue
            prefix, sec_name = header.split(":", 1)
            prefix_lower = prefix.strip().lower()
            sec_name = sec_name.strip()
            if prefix_lower not in ("filament", "print", "printer") or not sec_name:
                continue
            sections_by_key[(prefix_lower, sec_name)] = kv
            ordered_targets.append((prefix_lower, sec_name))

        for prefix_lower, sec_name in ordered_targets:
            if sec_name.startswith("*") and sec_name.endswith("*"):
                continue
            resolved = _resolve_bundle_inherits(prefix_lower, sec_name, sections_by_key, set())
            if prefix_lower == "filament":
                results.append(_convert_filament(sec_name, resolved, filename))
            elif prefix_lower == "print":
                results.append(_convert_process(sec_name, resolved, filename))
            elif prefix_lower == "printer":
                results.append(_convert_machine(sec_name, resolved, filename))

        if not results:
            raise ValueError("No supported [filament:], [print:], or [printer:] sections found in .ini bundle")
        return results

    if not flat:
        raise ValueError("INI file is empty or contains no key=value settings")

    base_name = Path(filename).stem or "PrusaSlicer Import"
    has_filament = any(k in flat for k in _FILAMENT_KEYS)
    has_process = any(k in flat for k in _PROCESS_KEYS)
    has_machine = any(k in flat for k in _MACHINE_KEYS)

    if has_filament:
        results.append(_convert_filament(base_name, flat, filename))
    if has_process:
        results.append(_convert_process(base_name, flat, filename))
    if has_machine:
        results.append(_convert_machine(base_name, flat, filename))

    if not results:
        raise ValueError("No recognized PrusaSlicer filament, print, or printer parameters found")
    return results
