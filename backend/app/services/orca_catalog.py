"""OrcaSlicer .opc (ZCRO v2) and plain JSON vendor catalog parser and flattener."""

from __future__ import annotations

import json
import logging
import math
import re
import struct
import threading
import zipfile
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Any, Optional

from app.config import detect_orca_resources_profiles_dirs

logger = logging.getLogger(__name__)

_HEX_COLOR_RE = re.compile(r"^#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$")
_MATERIAL_DEFAULT_COLORS: dict[str, str] = {
    "PLA": "#00A7D9",
    "PETG": "#F97316",
    "ABS": "#EF4444",
    "ASA": "#DC2626",
    "TPU": "#8B5CF6",
    "PA": "#10B981",
    "PC": "#0EA5E9",
    "PVA": "#EAB308",
    "HIPS": "#F59E0B",
    "PP": "#14B8A6",
}


def _norm_scalar(val: Any) -> Any:
    if isinstance(val, float):
        if math.isnan(val) or math.isinf(val):
            return None
        return f"{val:g}"
    if isinstance(val, bool):
        return "1" if val else "0"
    if isinstance(val, int):
        return str(val)
    return val


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


def _normalize_hex_color(raw: Optional[str], material: str = "PLA") -> str:
    if raw:
        cleaned = raw.strip()
        if not cleaned.startswith("#"):
            cleaned = f"#{cleaned}"
        match = _HEX_COLOR_RE.match(cleaned)
        if match:
            digits = match.group(1)
            if len(digits) == 3:
                digits = "".join(ch * 2 for ch in digits)
            return f"#{digits.upper()}"
    return _MATERIAL_DEFAULT_COLORS.get(material.upper(), "#00A7D9")


def _extract_bed_dimensions(machine_data: dict[str, Any]) -> tuple[float, float, float]:
    bed_x = 250.0
    bed_y = 210.0
    bed_z = 220.0

    area = machine_data.get("printable_area")
    if isinstance(area, str):
        area = [p.strip() for p in area.split(",") if p.strip()]
    if isinstance(area, list):
        xs: list[float] = []
        ys: list[float] = []
        for entry in area:
            if isinstance(entry, str) and "x" in entry.lower():
                parts = entry.lower().split("x", 1)
                try:
                    xs.append(float(parts[0].strip()))
                    ys.append(float(parts[1].strip()))
                except ValueError:
                    continue
        if xs and ys:
            span_x = round(max(xs) - min(xs), 2)
            span_y = round(max(ys) - min(ys), 2)
            if span_x >= 40.0:
                bed_x = span_x
            if span_y >= 40.0:
                bed_y = span_y

    height_raw = _first_str(machine_data.get("printable_height"))
    if height_raw:
        try:
            hz = round(float(height_raw), 2)
            if hz >= 40.0:
                bed_z = hz
        except ValueError:
            pass

    return bed_x, bed_y, bed_z


def extract_machine_metadata(machine_data: dict[str, Any]) -> dict[str, Any]:
    """Derive Print-Web printer attributes from a flattened OrcaSlicer machine JSON."""
    bed_x, bed_y, bed_z = _extract_bed_dimensions(machine_data)

    colors = machine_data.get("extruder_colour")
    nozzles = machine_data.get("nozzle_diameter")
    ext_count = 1
    if isinstance(colors, list) and len(colors) > 1:
        ext_count = len(colors)
    elif isinstance(nozzles, list) and len(nozzles) > 1:
        ext_count = len(nozzles)

    single_ext_mmu = str(machine_data.get("single_extruder_multi_material") or "").strip().lower() in {
        "1",
        "true",
    }
    name_upper = str(machine_data.get("name") or "").upper()
    if ext_count > 1:
        mmu_slots = min(16, ext_count)
    elif single_ext_mmu or "MMU" in name_upper or "AMS" in name_upper:
        mmu_slots = 5 if "MMU" in name_upper else 4
    else:
        mmu_slots = 1

    flavor = str(machine_data.get("gcode_flavor") or "").lower()
    printer_type = "klipper" if "klipper" in flavor else "prusalink"

    return {
        "bed_x_mm": bed_x,
        "bed_y_mm": bed_y,
        "bed_z_mm": bed_z,
        "mmu_slots_count": mmu_slots,
        "printer_type": printer_type,
        "nozzle_diameter": _first_str(nozzles) or "0.4",
    }


def extract_filament_metadata(
    filament_data: dict[str, Any],
    fallback_name: str = "Custom Filament",
) -> dict[str, Any]:
    """Derive Print-Web filament attributes from a flattened OrcaSlicer filament JSON."""
    name = str(filament_data.get("name") or _first_str(filament_data.get("filament_settings_id")) or fallback_name).strip()
    if not name:
        name = fallback_name
    raw_mat = _first_str(filament_data.get("filament_type")) or "PLA"
    material = raw_mat.upper()[:40]

    density = 1.24
    raw_density = _first_str(filament_data.get("filament_density"))
    if raw_density:
        try:
            d = float(raw_density)
            if 0.1 < d <= 10.0:
                density = round(d, 3)
        except ValueError:
            pass

    color_raw = _first_str(filament_data.get("default_filament_colour")) or _first_str(
        filament_data.get("filament_colour")
    )
    color_hex = _normalize_hex_color(color_raw, material)

    nozzle_temp = _first_str(filament_data.get("nozzle_temperature"))
    bed_temp = _first_str(filament_data.get("textured_plate_temp")) or _first_str(
        filament_data.get("hot_plate_temp")
    )
    notes_parts = ["OrcaSlicer catalog"]
    if nozzle_temp:
        notes_parts.append(f"{nozzle_temp}C nozzle")
    if bed_temp:
        notes_parts.append(f"{bed_temp}C bed")

    return {
        "name": name[:120],
        "material": material,
        "density_g_cm3": density,
        "color_hex": color_hex,
        "notes": " · ".join(notes_parts),
    }


@dataclass(frozen=True)
class _CondToken:
    kind: str  # OR, AND, NOT, LPAREN, RPAREN, LBRACK, RBRACK, OP, REGEX, STR, NUM, BOOL, IDENT
    value: Any


_TWO_CHAR_OPS = ("=~", "!~", "==", "!=", "<=", ">=", "&&", "||")
_TRUTHY_FALSE = {"", "0", "false", "no", "off", "nil"}


def _tokenize_condition(expr: str) -> list[_CondToken]:
    tokens: list[_CondToken] = []
    i = 0
    n = len(expr)
    while i < n:
        ch = expr[i]
        if ch.isspace():
            i += 1
            continue
        two = expr[i : i + 2]
        if two in _TWO_CHAR_OPS:
            if two == "&&":
                tokens.append(_CondToken("AND", two))
            elif two == "||":
                tokens.append(_CondToken("OR", two))
            else:
                tokens.append(_CondToken("OP", two))
            i += 2
            continue
        if ch == "(":
            tokens.append(_CondToken("LPAREN", ch))
            i += 1
            continue
        if ch == ")":
            tokens.append(_CondToken("RPAREN", ch))
            i += 1
            continue
        if ch == "[":
            tokens.append(_CondToken("LBRACK", ch))
            i += 1
            continue
        if ch == "]":
            tokens.append(_CondToken("RBRACK", ch))
            i += 1
            continue
        if ch == "!":
            tokens.append(_CondToken("NOT", ch))
            i += 1
            continue
        if ch in ("<", ">"):
            tokens.append(_CondToken("OP", ch))
            i += 1
            continue
        if ch == "/":
            i += 1
            chars: list[str] = []
            closed = False
            while i < n:
                c = expr[i]
                if c == "\\" and i + 1 < n:
                    nxt = expr[i + 1]
                    if nxt == "/":
                        chars.append("/")
                    else:
                        chars.append(c)
                        chars.append(nxt)
                    i += 2
                    continue
                if c == "/":
                    i += 1
                    closed = True
                    break
                chars.append(c)
                i += 1
            if not closed:
                raise ValueError("Unterminated regex literal")
            pattern = re.compile("".join(chars), re.DOTALL)
            tokens.append(_CondToken("REGEX", pattern))
            continue
        if ch in ('"', "'"):
            quote = ch
            i += 1
            chars = []
            closed = False
            while i < n:
                c = expr[i]
                if c == "\\" and i + 1 < n:
                    chars.append(expr[i + 1])
                    i += 2
                    continue
                if c == quote:
                    i += 1
                    closed = True
                    break
                chars.append(c)
                i += 1
            if not closed:
                raise ValueError("Unterminated string literal")
            tokens.append(_CondToken("STR", "".join(chars)))
            continue
        if ch.isdigit() or (ch == "-" and i + 1 < n and expr[i + 1].isdigit()):
            j = i + 1
            has_dot = False
            while j < n and (expr[j].isdigit() or (expr[j] == "." and not has_dot)):
                if expr[j] == ".":
                    has_dot = True
                j += 1
            tokens.append(_CondToken("NUM", float(expr[i:j])))
            i = j
            continue
        if ch.isalpha() or ch == "_":
            j = i + 1
            while j < n and (expr[j].isalnum() or expr[j] == "_"):
                j += 1
            word = expr[i:j]
            low = word.lower()
            if low == "and":
                tokens.append(_CondToken("AND", word))
            elif low == "or":
                tokens.append(_CondToken("OR", word))
            elif low == "not":
                tokens.append(_CondToken("NOT", word))
            elif low == "true":
                tokens.append(_CondToken("BOOL", True))
            elif low == "false":
                tokens.append(_CondToken("BOOL", False))
            else:
                tokens.append(_CondToken("IDENT", word))
            i = j
            continue
        raise ValueError(f"Unexpected character {ch!r} in condition")
    return tokens


@lru_cache(maxsize=512)
def _compile_condition(expr: str) -> Any:
    tokens = _tokenize_condition(expr)
    pos = 0
    total = len(tokens)

    def _peek() -> Optional[_CondToken]:
        return tokens[pos] if pos < total else None

    def _consume(kind: Optional[str] = None) -> _CondToken:
        nonlocal pos
        if pos >= total:
            raise ValueError("Unexpected end of condition")
        tok = tokens[pos]
        if kind is not None and tok.kind != kind:
            raise ValueError(f"Expected {kind}, got {tok.kind}")
        pos += 1
        return tok

    def _parse_or() -> Any:
        node = _parse_and()
        while (tok := _peek()) is not None and tok.kind == "OR":
            _consume("OR")
            rhs = _parse_and()
            node = ("or", node, rhs)
        return node

    def _parse_and() -> Any:
        node = _parse_not()
        while (tok := _peek()) is not None and tok.kind == "AND":
            _consume("AND")
            rhs = _parse_not()
            node = ("and", node, rhs)
        return node

    def _parse_not() -> Any:
        if (tok := _peek()) is not None and tok.kind == "NOT":
            _consume("NOT")
            return ("not", _parse_not())
        return _parse_comparison()

    def _parse_operand() -> Any:
        tok = _peek()
        if tok is None:
            raise ValueError("Expected operand")
        if tok.kind == "IDENT":
            name = _consume("IDENT").value
            idx: Optional[int] = None
            if (nxt := _peek()) is not None and nxt.kind == "LBRACK":
                _consume("LBRACK")
                num_tok = _consume("NUM")
                _consume("RBRACK")
                idx = int(num_tok.value)
            return ("var", name, idx)
        if tok.kind in ("STR", "NUM", "BOOL", "REGEX"):
            _consume()
            return ("lit", tok.kind, tok.value)
        raise ValueError(f"Unexpected token {tok.kind}")

    def _parse_comparison() -> Any:
        tok = _peek()
        if tok is not None and tok.kind == "LPAREN":
            _consume("LPAREN")
            inner = _parse_or()
            _consume("RPAREN")
            return inner
        lhs = _parse_operand()
        nxt = _peek()
        if nxt is not None and nxt.kind == "OP":
            op = _consume("OP").value
            rhs = _parse_operand()
            return ("cmp", op, lhs, rhs)
        return ("truthy", lhs)

    ast = _parse_or()
    if pos != total:
        raise ValueError(f"Trailing tokens at position {pos}")
    return ast


def _resolve_var(machine_flat: dict[str, Any], name: str, idx: Optional[int]) -> Any:
    if name not in machine_flat:
        return ""
    val = machine_flat.get(name)
    if val is None:
        return ""
    if idx is not None:
        if isinstance(val, list):
            return val[idx] if 0 <= idx < len(val) else ""
        return val if idx == 0 else ""
    if isinstance(val, list):
        if name == "printer_notes":
            return "\n".join(str(x) for x in val)
        return _first_str(val) or ""
    if isinstance(val, bool):
        return "1" if val else "0"
    return val


def _to_str(val: Any) -> str:
    if val is None:
        return ""
    if isinstance(val, bool):
        return "1" if val else "0"
    return str(val)


def _to_float(val: Any) -> Optional[float]:
    if isinstance(val, bool):
        return 1.0 if val else 0.0
    if isinstance(val, (int, float)):
        return None if (math.isnan(val) or math.isinf(val)) else float(val)
    s = str(val).strip()
    if not s:
        return None
    try:
        f = float(s)
        return None if (math.isnan(f) or math.isinf(f)) else f
    except ValueError:
        return None


def _is_truthy(val: Any) -> bool:
    if isinstance(val, bool):
        return val
    return str(val or "").strip().lower() not in _TRUTHY_FALSE


def _eval_operand(node: Any, machine_flat: dict[str, Any]) -> Any:
    if node[0] == "var":
        return _resolve_var(machine_flat, node[1], node[2])
    return node[2]


def _eval_condition_ast(node: Any, machine_flat: dict[str, Any]) -> bool:
    kind = node[0]
    if kind == "or":
        return _eval_condition_ast(node[1], machine_flat) or _eval_condition_ast(node[2], machine_flat)
    if kind == "and":
        return _eval_condition_ast(node[1], machine_flat) and _eval_condition_ast(node[2], machine_flat)
    if kind == "not":
        return not _eval_condition_ast(node[1], machine_flat)
    if kind == "truthy":
        return _is_truthy(_eval_operand(node[1], machine_flat))
    if kind == "cmp":
        _, op, lhs_node, rhs_node = node
        lhs = _eval_operand(lhs_node, machine_flat)
        rhs = _eval_operand(rhs_node, machine_flat)
        if op in ("=~", "!~"):
            lhs_s = _to_str(lhs)
            if isinstance(rhs, re.Pattern):
                matched = bool(rhs.fullmatch(lhs_s))
            else:
                try:
                    matched = bool(re.compile(str(rhs), re.DOTALL).fullmatch(lhs_s))
                except re.error:
                    return False
            return matched if op == "=~" else not matched

        if isinstance(lhs, bool) or isinstance(rhs, bool):
            lb = _is_truthy(lhs)
            rb = _is_truthy(rhs)
            if op == "==":
                return lb == rb
            if op == "!=":
                return lb != rb

        lf = _to_float(lhs)
        rf = _to_float(rhs)
        if lf is not None and rf is not None:
            if op == "==":
                return math.isclose(lf, rf, rel_tol=1e-9, abs_tol=1e-9)
            if op == "!=":
                return not math.isclose(lf, rf, rel_tol=1e-9, abs_tol=1e-9)
            if op == "<":
                return lf < rf
            if op == "<=":
                return lf <= rf
            if op == ">":
                return lf > rf
            if op == ">=":
                return lf >= rf

        ls = _to_str(lhs)
        rs = _to_str(rhs)
        if op == "==":
            return ls == rs
        if op == "!=":
            return ls != rs
        if op == "<":
            return ls < rs
        if op == "<=":
            return ls <= rs
        if op == ">":
            return ls > rs
        if op == ">=":
            return ls >= rs
    return False


def evaluate_compatible_printers_condition(expr: str, machine_flat: dict[str, Any]) -> bool:
    """Safely evaluate an OrcaSlicer/PrusaSlicer compatible_printers_condition expression."""
    cleaned = (expr or "").strip()
    if not cleaned:
        return True
    try:
        ast = _compile_condition(cleaned)
        return _eval_condition_ast(ast, machine_flat)
    except Exception:
        return False


def _resolve_compatible_printers(
    flat: dict[str, Any],
    flat_machines: list[tuple[str, dict[str, Any]]],
) -> list[str]:
    """Resolve compatible machine preset names from explicit list or condition expression."""
    compat = flat.get("compatible_printers")
    compat_list = [str(c).strip() for c in compat if str(c).strip()] if isinstance(compat, list) else []
    if compat_list:
        return compat_list
    cpc = str(flat.get("compatible_printers_condition") or "").strip()
    if not cpc:
        return []
    return [
        m_name
        for m_name, m_flat in flat_machines
        if evaluate_compatible_printers_condition(cpc, m_flat)
    ]


@dataclass
class OpcModelInfo:
    id: str
    name: str
    family: str
    manufacturer: str
    nozzles: list[str] = field(default_factory=list)
    default_materials: list[str] = field(default_factory=list)
    bed_model: str = ""
    bed_texture: str = ""


@dataclass
class OpcBundle:
    vendor_id: str
    vendor_name: str
    vendor_version: str
    vendor_dir: str
    models: list[OpcModelInfo] = field(default_factory=list)
    presets: dict[tuple[str, str], dict[str, Any]] = field(default_factory=dict)


def parse_opc_file(path: Path) -> OpcBundle:
    """Parse an OrcaSlicer 2.5 ZCRO binary .opc vendor archive."""
    data = path.read_bytes()
    pos = 0
    total = len(data)
    if total < 24 or data[:4] != b"ZCRO":
        raise ValueError(f"Unsupported .opc header in {path.name}")
    ver, _fsize, _crc, _flags = struct.unpack_from("<IQII", data, 4)
    if ver != 2:
        raise ValueError(f"Unsupported .opc version {ver} in {path.name}")
    pos = 24

    def _ru64() -> int:
        nonlocal pos
        v = struct.unpack_from("<Q", data, pos)[0]
        pos += 8
        return v

    def _ru32() -> int:
        nonlocal pos
        v = struct.unpack_from("<I", data, pos)[0]
        pos += 4
        return v

    def _ri32() -> int:
        nonlocal pos
        v = struct.unpack_from("<i", data, pos)[0]
        pos += 4
        return v

    def _ru16() -> int:
        nonlocal pos
        v = struct.unpack_from("<H", data, pos)[0]
        pos += 2
        return v

    def _ru8() -> int:
        nonlocal pos
        v = data[pos]
        pos += 1
        return v

    def _rf64() -> float:
        nonlocal pos
        v = struct.unpack_from("<d", data, pos)[0]
        pos += 8
        return v

    def _rstr() -> str:
        nonlocal pos
        n = _ru64()
        raw = data[pos : pos + n]
        pos += n
        return raw.decode("utf-8", errors="replace")

    vendor_name = _rstr()
    vendor_version = _rstr()
    keys = [_rstr() for _ in range(_ru64())]
    types = [_ru16() for _ in range(_ru64())]
    enum_pool = [_rstr() for _ in range(_ru64())]

    def _read_val(t: int) -> Any:
        is_vec = bool(t & 0x4000)
        base = t & 0x3FFF
        if is_vec and base == 9:
            cnt = _ru32()
            out: list[str] = []
            for _ in range(cnt):
                idx = _ru16()
                if idx == 0:
                    _ri32()
                    out.append("nil")
                elif idx < len(enum_pool):
                    out.append(enum_pool[idx])
            return out

        def _one() -> Any:
            if base == 1:
                return _rf64()
            if base == 2:
                return _ri32()
            if base == 3:
                return _rstr()
            if base == 4:
                v = _rf64()
                return None if math.isnan(v) or math.isinf(v) else f"{v:g}%"
            if base == 5:
                v = _rf64()
                is_pct = bool(_ru8())
                if math.isnan(v) or math.isinf(v):
                    return None
                return f"{v:g}%" if is_pct else f"{v:g}"
            if base == 6:
                x = _rf64()
                y = _rf64()
                return f"{x:g}x{y:g}"
            if base == 10:
                return [f"{_rf64():g}x{_rf64():g}" for _ in range(_ru64())]
            if base == 7:
                return f"{_rf64():g},{_rf64():g},{_rf64():g}"
            if base == 8:
                return bool(_ru8())
            if base == 9:
                enum_int = _ri32()
                idx = _ru16()
                return enum_pool[idx] if idx < len(enum_pool) else str(enum_int)
            raise ValueError(f"Unsupported .opc field type base={base} raw={t}")

        if is_vec:
            cnt = _ru64()
            arr: list[Any] = []
            for _ in range(cnt):
                nv = _norm_scalar(_one())
                if nv is not None:
                    arr.append(nv)
            return arr
        return _norm_scalar(_one())

    vendor_id = path.stem
    vendor_display = vendor_name or path.stem
    vendor_dir = path.stem
    models: list[OpcModelInfo] = []

    vc = _ru64()
    for vi in range(vc):
        v_id = _rstr()
        v_name = _rstr()
        v_dir = _rstr()
        _v_ver = _rstr()
        _v_url1 = _rstr()
        _v_url2 = _rstr()
        if vi == 0:
            vendor_id = v_id or path.stem
            vendor_display = v_name or vendor_display
            vendor_dir = v_dir or vendor_id
        mc = _ru64()
        for _ in range(mc):
            mid = _rstr()
            mname = _rstr()
            mfam = _rstr()
            _mtech = _ru8()
            mman = _rstr()
            nozzles = [s for s in (_rstr() for _ in range(_ru64())) if s]
            def_mats = [s for s in (_rstr() for _ in range(_ru64())) if s]
            _exclude_plates = [_rstr() for _ in range(_ru64())]
            bed_model = _rstr()
            bed_texture = _rstr()
            for _ in range(7):
                _rstr()
            models.append(
                OpcModelInfo(
                    id=mid,
                    name=mname or mid,
                    family=mfam,
                    manufacturer=mman,
                    nozzles=nozzles,
                    default_materials=def_mats,
                    bed_model=bed_model,
                    bed_texture=bed_texture,
                )
            )
        for _ in range(_ru64()):
            _rstr()
        for _ in range(_ru64()):
            _rstr()

    presets: dict[tuple[str, str], dict[str, Any]] = {}
    for kind in ("process", "filament", "machine"):
        cnt = _ru32()
        for _ in range(cnt):
            pname = _rstr()
            _ppath = _rstr()
            ne = _ru32()
            kv: dict[str, Any] = {}
            for _ in range(ne):
                kidx = _ru16()
                if kidx >= len(keys):
                    raise ValueError(f"Corrupt .opc key index {kidx} in {path.name}")
                val = _read_val(types[kidx])
                if val is not None:
                    kv[keys[kidx]] = val
            inherits = _rstr()
            sub_inherits = [_rstr() for _ in range(_ru64())]
            _desc = _rstr()
            instantiation = _rstr()
            setting_id = _rstr()
            filament_id = _rstr()
            for _ in range(_ru64()):
                _rstr()
            kv["name"] = pname
            kv["type"] = kind
            if inherits:
                kv["inherits"] = inherits
            if sub_inherits:
                kv["sub_inherits"] = sub_inherits
            if instantiation:
                kv["instantiation"] = instantiation
            if setting_id:
                kv["setting_id"] = setting_id
            if filament_id:
                kv["filament_id"] = filament_id
            presets[(kind, pname)] = kv

    return OpcBundle(
        vendor_id=vendor_id,
        vendor_name=vendor_display,
        vendor_version=vendor_version,
        vendor_dir=vendor_dir,
        models=models,
        presets=presets,
    )


def _find_cover_file(vendor_dir_path: Path, model_id: str, model_name: str) -> Optional[Path]:
    if not vendor_dir_path.is_dir():
        return None
    candidates: list[str] = []
    for base in (model_name, model_id):
        b = (base or "").strip()
        if b:
            candidates.append(f"{b}_cover.png")
            candidates.append(f"{b}_cover.svg")
            candidates.append(f"{b}.png")
    for cand in candidates:
        p = vendor_dir_path / cand
        if p.is_file():
            return p
    return None


@dataclass
class _CatalogEntry:
    bundle: OpcBundle
    vendor_dir_path: Path
    cover_files: dict[str, Path] = field(default_factory=dict)


class OrcaCatalogIndex:
    """In-memory index across OrcaSlicer .opc archives and legacy vendor profile directories."""

    def __init__(self, profile_roots: list[Path]) -> None:
        self.profile_roots = profile_roots
        self.vendors: dict[str, _CatalogEntry] = {}
        self.presets_by_kind_name: dict[tuple[str, str], dict[str, Any]] = {}
        self.presets_by_name: dict[str, dict[str, Any]] = {}
        self._load()

    def _register_preset(self, kind: str, pname: str, data: dict[str, Any]) -> None:
        if (kind, pname) not in self.presets_by_kind_name:
            self.presets_by_kind_name[(kind, pname)] = data
        if pname not in self.presets_by_name:
            self.presets_by_name[pname] = data

    def _load(self) -> None:
        for root in self.profile_roots:
            if not root.is_dir():
                continue
            # 1. Parse .opc archives
            for opc_path in sorted(root.glob("*.opc")):
                try:
                    bundle = parse_opc_file(opc_path)
                except Exception as exc:
                    logger.warning("Skipping .opc archive %s: %s", opc_path, exc)
                    continue

                vid = bundle.vendor_id or opc_path.stem
                if vid in self.vendors:
                    continue
                vdir = root / (bundle.vendor_dir or vid)
                if not vdir.is_dir():
                    vdir = root / opc_path.stem
                covers: dict[str, Path] = {}
                for m in bundle.models:
                    cf = _find_cover_file(vdir, m.id, m.name)
                    if cf is not None:
                        covers[cf.name] = cf
                self.vendors[vid] = _CatalogEntry(bundle=bundle, vendor_dir_path=vdir, cover_files=covers)
                for (kind, pname), pdata in bundle.presets.items():
                    self._register_preset(kind, pname, pdata)

            # 2. Parse legacy uncompressed vendor JSON directories not covered by .opc
            for meta_json in sorted(root.glob("*.json")):
                if meta_json.name.lower() in {"blacklist.json"}:
                    continue
                vid = meta_json.stem
                vdir = root / vid
                if not vdir.is_dir() or vid in self.vendors:
                    continue
                try:
                    raw_vendor = json.loads(meta_json.read_text(encoding="utf-8-sig"))
                except Exception:
                    continue
                if not isinstance(raw_vendor, dict):
                    continue
                models: list[OpcModelInfo] = []
                for mm in raw_vendor.get("machine_model_list", []) or []:
                    if not isinstance(mm, dict):
                        continue
                    mid = str(mm.get("name") or "").strip()
                    if not mid:
                        continue
                    nozzles_raw = mm.get("nozzle_diameter") or ""
                    nozzles = [s.strip() for s in str(nozzles_raw).replace(",", ";").split(";") if s.strip()]
                    mats_raw = mm.get("default_materials") or ""
                    mats = [s.strip() for s in str(mats_raw).split(";") if s.strip()]
                    models.append(
                        OpcModelInfo(
                            id=mid,
                            name=mid,
                            family=str(mm.get("family") or ""),
                            manufacturer=str(mm.get("manufacturer") or vid),
                            nozzles=nozzles,
                            default_materials=mats,
                        )
                    )
                presets: dict[tuple[str, str], dict[str, Any]] = {}
                for kind_dir in ("process", "filament", "machine"):
                    subdir = vdir / kind_dir
                    if not subdir.is_dir():
                        continue
                    for jf in sorted(subdir.rglob("*.json")):
                        try:
                            pd = json.loads(jf.read_text(encoding="utf-8-sig"))
                        except Exception:
                            continue
                        if isinstance(pd, dict) and isinstance(pd.get("name"), str):
                            pn = pd["name"].strip()
                            pd.setdefault("type", kind_dir)
                            presets[(kind_dir, pn)] = pd
                            self._register_preset(kind_dir, pn, pd)

                bundle = OpcBundle(
                    vendor_id=vid,
                    vendor_name=str(raw_vendor.get("name") or vid),
                    vendor_version=str(raw_vendor.get("version") or ""),
                    vendor_dir=vid,
                    models=models,
                    presets=presets,
                )
                covers: dict[str, Path] = {}
                for m in models:
                    cf = _find_cover_file(vdir, m.id, m.name)
                    if cf is not None:
                        covers[cf.name] = cf
                self.vendors[vid] = _CatalogEntry(bundle=bundle, vendor_dir_path=vdir, cover_files=covers)

    def _find_preset_in_scope(
        self,
        kind: str,
        name: str,
        bundle: Optional[OpcBundle] = None,
    ) -> Optional[dict[str, Any]]:
        if bundle is not None:
            hit = bundle.presets.get((kind, name))
            if hit is not None:
                return hit
        if (kind, name) in self.presets_by_kind_name:
            return self.presets_by_kind_name[(kind, name)]
        return self.presets_by_name.get(name)

    def flatten_preset(
        self,
        kind: str,
        name: str,
        *,
        vendor_id: Optional[str] = None,
    ) -> dict[str, Any]:
        """Resolve OrcaSlicer inherits + sub_inherits chains into a standalone CLI JSON dict."""
        entry = self.vendors.get(vendor_id) if vendor_id else None
        bundle = entry.bundle if entry else None

        target = self._find_preset_in_scope(kind, name, bundle)
        if target is None:
            raise KeyError(f"OrcaSlicer {kind} preset '{name}' not found")

        visited: set[str] = set()

        def _collect_merged(preset_dict: dict[str, Any]) -> dict[str, Any]:
            merged: dict[str, Any] = {}
            parents: list[str] = []
            inh = preset_dict.get("inherits")
            if isinstance(inh, str) and inh.strip():
                parents.append(inh.strip())
            sub_inh = preset_dict.get("sub_inherits")
            if isinstance(sub_inh, list):
                for s in sub_inh:
                    if isinstance(s, str) and s.strip():
                        parents.append(s.strip())
            for parent_name in parents:
                if parent_name in visited or len(visited) >= 32:
                    continue
                visited.add(parent_name)
                parent = self._find_preset_in_scope(kind, parent_name, bundle)
                if parent is not None:
                    merged.update(_collect_merged(parent))
            merged.update(preset_dict)
            return merged

        visited.add(name)
        flat = _collect_merged(target)
        flat.pop("inherits", None)
        flat.pop("sub_inherits", None)
        flat["name"] = str(flat.get("name") or name)
        flat["type"] = kind
        flat["from"] = "User"
        flat["instantiation"] = "true"
        flat.setdefault("version", "2.5.0.0")
        return flat

    def list_vendors(self) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for vid, entry in self.vendors.items():
            b = entry.bundle
            inst_machines = sum(
                1
                for (k, _n), d in b.presets.items()
                if k == "machine" and str(d.get("instantiation", "")).lower() == "true"
            )
            inst_procs = sum(
                1
                for (k, _n), d in b.presets.items()
                if k == "process" and str(d.get("instantiation", "")).lower() == "true"
            )
            inst_fils = sum(
                1
                for (k, _n), d in b.presets.items()
                if k == "filament" and str(d.get("instantiation", "")).lower() == "true"
            )
            if not b.models and inst_fils == 0:
                continue
            out.append(
                {
                    "id": vid,
                    "name": b.vendor_name or vid,
                    "version": b.vendor_version,
                    "model_count": len(b.models),
                    "machine_count": inst_machines,
                    "process_count": inst_procs,
                    "filament_count": inst_fils,
                    "is_library": len(b.models) == 0,
                }
            )
        out.sort(key=lambda item: (item["is_library"], item["name"].lower()))
        return out

    def get_vendor_detail(self, vendor_id: str) -> dict[str, Any]:
        entry = self.vendors.get(vendor_id)
        if entry is None:
            raise KeyError(f"Vendor '{vendor_id}' not found")
        bundle = entry.bundle

        # Instantiable machine presets indexed cleanly
        machine_presets: list[dict[str, Any]] = []
        machines_by_model: dict[str, list[dict[str, Any]]] = {}
        flat_machines: list[tuple[str, dict[str, Any]]] = []
        for (kind, pname), pdata in bundle.presets.items():
            if kind != "machine" or str(pdata.get("instantiation", "")).lower() != "true":
                continue
            try:
                flat = self.flatten_preset("machine", pname, vendor_id=vendor_id)
            except KeyError:
                flat = pdata
            flat_machines.append((pname, flat))
            meta = extract_machine_metadata(flat)
            p_model = str(flat.get("printer_model") or "").strip()
            item = {
                "name": pname,
                "vendor": vendor_id,
                "printer_model": p_model,
                "nozzle_diameter": meta["nozzle_diameter"],
                "bed_x_mm": meta["bed_x_mm"],
                "bed_y_mm": meta["bed_y_mm"],
                "bed_z_mm": meta["bed_z_mm"],
                "mmu_slots_count": meta["mmu_slots_count"],
                "printer_type": meta["printer_type"],
                "default_print_profile": str(flat.get("default_print_profile") or "").strip(),
            }
            machine_presets.append(item)
            if p_model:
                machines_by_model.setdefault(p_model, []).append(item)

        machine_presets.sort(key=lambda x: x["name"].lower())
        flat_machines.sort(key=lambda x: x[0].lower())

        models_out: list[dict[str, Any]] = []
        for m in bundle.models:
            matched = machines_by_model.get(m.id) or machines_by_model.get(m.name) or []
            if not matched:
                matched = [
                    mp
                    for mp in machine_presets
                    if mp["name"] == m.name or mp["name"].startswith(f"{m.name} ")
                ]
            matched_names = [mp["name"] for mp in matched]
            sample_meta = matched[0] if matched else None
            cover_file = _find_cover_file(entry.vendor_dir_path, m.id, m.name)
            cover_url = (
                f"/api/admin/orca-catalog/cover/{vendor_id}/{cover_file.name}"
                if cover_file is not None
                else None
            )
            models_out.append(
                {
                    "id": m.id,
                    "name": m.name,
                    "family": m.family,
                    "manufacturer": m.manufacturer,
                    "nozzles": m.nozzles,
                    "default_materials": m.default_materials,
                    "cover_url": cover_url,
                    "bed_x_mm": sample_meta["bed_x_mm"] if sample_meta else 250.0,
                    "bed_y_mm": sample_meta["bed_y_mm"] if sample_meta else 210.0,
                    "bed_z_mm": sample_meta["bed_z_mm"] if sample_meta else 220.0,
                    "mmu_slots_count": sample_meta["mmu_slots_count"] if sample_meta else 1,
                    "printer_type": sample_meta["printer_type"] if sample_meta else "prusalink",
                    "machine_presets": matched_names,
                }
            )

        # Instantiable process presets
        process_presets: list[dict[str, Any]] = []
        for (kind, pname), pdata in bundle.presets.items():
            if kind != "process" or str(pdata.get("instantiation", "")).lower() != "true":
                continue
            try:
                flat = self.flatten_preset("process", pname, vendor_id=vendor_id)
            except KeyError:
                flat = pdata
            compat_list = _resolve_compatible_printers(flat, flat_machines)
            process_presets.append(
                {
                    "name": pname,
                    "vendor": vendor_id,
                    "layer_height": _first_str(flat.get("layer_height")) or "0.20",
                    "compatible_printers": compat_list,
                }
            )
        process_presets.sort(key=lambda x: x["name"].lower())

        # Filaments: vendor filaments + OrcaFilamentLibrary (if vendor itself isn't OrcaFilamentLibrary)
        filaments_out: list[dict[str, Any]] = []
        seen_fil_names: set[str] = set()
        source_bundles: list[tuple[str, OpcBundle]] = [(vendor_id, bundle)]
        if vendor_id != "OrcaFilamentLibrary" and "OrcaFilamentLibrary" in self.vendors:
            source_bundles.append(("OrcaFilamentLibrary", self.vendors["OrcaFilamentLibrary"].bundle))

        for src_vid, src_bundle in source_bundles:
            for (kind, pname), pdata in src_bundle.presets.items():
                if kind != "filament" or str(pdata.get("instantiation", "")).lower() != "true":
                    continue
                if pname in seen_fil_names:
                    continue
                seen_fil_names.add(pname)
                try:
                    flat = self.flatten_preset("filament", pname, vendor_id=src_vid)
                except KeyError:
                    flat = pdata
                fmeta = extract_filament_metadata(flat, fallback_name=pname)
                compat_list = _resolve_compatible_printers(flat, flat_machines)
                filaments_out.append(
                    {
                        "preset_name": pname,
                        "name": fmeta["name"],
                        "vendor": src_vid,
                        "material": fmeta["material"],
                        "color_hex": fmeta["color_hex"],
                        "density_g_cm3": fmeta["density_g_cm3"],
                        "compatible_printers": compat_list,
                    }
                )
        filaments_out.sort(key=lambda x: (x["vendor"] != vendor_id, x["material"], x["name"].lower()))

        return {
            "id": vendor_id,
            "name": bundle.vendor_name or vendor_id,
            "version": bundle.vendor_version,
            "is_library": len(bundle.models) == 0,
            "models": models_out,
            "machine_presets": machine_presets,
            "process_presets": process_presets,
            "filaments": filaments_out,
        }

    def resolve_cover_path(self, vendor_id: str, filename: str) -> Optional[Path]:
        entry = self.vendors.get(vendor_id)
        if entry is None:
            return None
        safe_name = Path(filename or "").name
        if not safe_name or safe_name != filename:
            return None
        target = entry.cover_files.get(safe_name)
        if target and target.is_file():
            return target
        return None


_CATALOG_LOCK = threading.Lock()
_CATALOG_CACHE: dict[tuple[str, ...], OrcaCatalogIndex] = {}


def _resolve_profile_roots(cli_path: Optional[str] = None, extra_dirs: Optional[list[Path]] = None) -> list[Path]:
    roots: list[Path] = []
    if extra_dirs:
        roots.extend(extra_dirs)
    builtin = Path("/opt/orcaslicer-builtin/resources/profiles")
    if builtin.is_dir():
        roots.append(builtin)
    roots.extend(detect_orca_resources_profiles_dirs(cli_path))
    deduped: list[Path] = []
    seen: set[str] = set()
    for r in roots:
        try:
            key = str(r.resolve())
        except OSError:
            key = str(r)
        if key not in seen and r.is_dir():
            seen.add(key)
            deduped.append(r)
    return deduped


def get_orca_catalog(
    cli_path: Optional[str] = None,
    extra_dirs: Optional[list[Path]] = None,
) -> OrcaCatalogIndex:
    """Return a cached OrcaCatalogIndex across all detected OrcaSlicer profile roots."""
    roots = _resolve_profile_roots(cli_path, extra_dirs)
    cache_key = tuple(str(p) for p in roots)
    with _CATALOG_LOCK:
        cached = _CATALOG_CACHE.get(cache_key)
        if cached is None:
            cached = OrcaCatalogIndex(roots)
            _CATALOG_CACHE[cache_key] = cached
        return cached


def clear_orca_catalog_cache() -> None:
    """Clear the cached OrcaSlicer catalog (used by tests)."""
    with _CATALOG_LOCK:
        _CATALOG_CACHE.clear()
