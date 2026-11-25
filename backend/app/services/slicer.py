"""Slicer adapters: MockTrimeshSlicer for local dev and OrcaSlicerCliAdapter for Proxmox."""

from __future__ import annotations

import json
import logging
import math
import re
import subprocess
import tempfile
import xml.etree.ElementTree as ET
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional

import numpy as np
import trimesh

from app.config import detect_orca_cli_path, detect_orca_resources_profiles_dirs
from app.models import OrcaProfile, Printer, PrinterSlot, SystemSettings

logger = logging.getLogger(__name__)


class SlicerError(Exception):
    """Raised when mesh loading or slicing fails."""


class OutOfBoundsError(SlicerError):
    """Raised when the transformed mesh extends outside the printer build volume."""


@dataclass
class BoundsResult:
    min_x: float
    max_x: float
    min_y: float
    max_y: float
    min_z: float
    max_z: float

    @property
    def size_x_mm(self) -> float:
        return round(self.max_x - self.min_x, 3)

    @property
    def size_y_mm(self) -> float:
        return round(self.max_y - self.min_y, 3)

    @property
    def size_z_mm(self) -> float:
        return round(self.max_z - self.min_z, 3)


@dataclass
class SliceResult:
    estimated_grams: float
    estimated_minutes: int
    layer_count: int
    supports_enabled: bool
    gcode_path: Path
    gcode_filename: str
    bounds: BoundsResult
    command_preview: str


def _load_mesh(stl_path: Path) -> trimesh.Trimesh:
    """Load an STL file as a single Trimesh instance, validating non-empty geometry."""
    try:
        loaded = trimesh.load(str(stl_path), file_type="stl", force="mesh", process=True)
    except Exception as exc:
        raise SlicerError(f"Unable to parse STL file: {exc}") from exc

    if isinstance(loaded, trimesh.Scene):
        geoms = [g for g in loaded.geometry.values() if isinstance(g, trimesh.Trimesh)]
        if not geoms:
            raise SlicerError("STL scene contains no triangle meshes")
        mesh = trimesh.util.concatenate(geoms)
    elif isinstance(loaded, trimesh.Trimesh):
        mesh = loaded
    else:
        raise SlicerError("Uploaded file did not resolve to a valid 3D mesh")

    if len(mesh.vertices) == 0 or len(mesh.faces) == 0:
        raise SlicerError("STL mesh has zero vertices or faces")
    return mesh


def _extract_bounds(mesh: trimesh.Trimesh) -> BoundsResult:
    b = mesh.bounds
    return BoundsResult(
        min_x=round(float(b[0][0]), 3),
        max_x=round(float(b[1][0]), 3),
        min_y=round(float(b[0][1]), 3),
        max_y=round(float(b[1][1]), 3),
        min_z=round(float(b[0][2]), 3),
        max_z=round(float(b[1][2]), 3),
    )


def _center_xy_and_drop_z(mesh: trimesh.Trimesh, target_x: float = 0.0, target_y: float = 0.0) -> trimesh.Trimesh:
    """Translate mesh so its XY bounding box center is at (target_x, target_y) and min_z == 0."""
    b = mesh.bounds
    cx = 0.5 * (float(b[0][0]) + float(b[1][0]))
    cy = 0.5 * (float(b[0][1]) + float(b[1][1]))
    min_z = float(b[0][2])
    mesh.apply_translation([target_x - cx, target_y - cy, -min_z])
    return mesh


def _validate_bed_bounds(bounds: BoundsResult, printer: Printer) -> None:
    """Ensure the transformed bounding box fits inside [-bed_x/2, +bed_x/2], [-bed_y/2, +bed_y/2], [0, bed_z]."""
    half_x = float(printer.bed_x_mm) / 2.0
    half_y = float(printer.bed_y_mm) / 2.0
    max_z = float(printer.bed_z_mm)
    tol = 0.05  # 50 micron tolerance for floating-point rounding

    violations: list[str] = []
    if bounds.min_x < -half_x - tol or bounds.max_x > half_x + tol:
        violations.append(
            f"X [{bounds.min_x:.1f}, {bounds.max_x:.1f}] exceeds bed [-{half_x:.1f}, {half_x:.1f}] mm"
        )
    if bounds.min_y < -half_y - tol or bounds.max_y > half_y + tol:
        violations.append(
            f"Y [{bounds.min_y:.1f}, {bounds.max_y:.1f}] exceeds bed [-{half_y:.1f}, {half_y:.1f}] mm"
        )
    if bounds.min_z < -tol or bounds.max_z > max_z + tol:
        violations.append(
            f"Z [{bounds.min_z:.1f}, {bounds.max_z:.1f}] exceeds bed [0.0, {max_z:.1f}] mm"
        )

    if violations:
        raise OutOfBoundsError("Model exceeds printer build volume: " + "; ".join(violations))


def _chain_2d_segments(segments: np.ndarray) -> list[tuple[list[tuple[float, float]], bool]]:
    """Stitch unordered 2D cross-section segments into ordered polylines and closed loops."""
    if segments is None or len(segments) == 0:
        return []

    n = len(segments)
    adj: dict[tuple[int, int], list[tuple[int, int]]] = {}
    pts_arr = np.asarray(segments, dtype=float)

    def _key(pt: np.ndarray) -> tuple[int, int]:
        return (int(round(float(pt[0]) * 100.0)), int(round(float(pt[1]) * 100.0)))

    for idx in range(n):
        p0, p1 = pts_arr[idx][0], pts_arr[idx][1]
        if math.hypot(float(p1[0] - p0[0]), float(p1[1] - p0[1])) < 1e-4:
            continue
        k0 = _key(p0)
        k1 = _key(p1)
        if k0 == k1:
            continue
        adj.setdefault(k0, []).append((idx, 1))
        adj.setdefault(k1, []).append((idx, 0))

    used = bytearray(n)
    chains: list[tuple[list[tuple[float, float]], bool]] = []

    for start_idx in range(n):
        if used[start_idx]:
            continue
        p0, p1 = pts_arr[start_idx][0], pts_arr[start_idx][1]
        k0, k1 = _key(p0), _key(p1)
        if k0 == k1:
            used[start_idx] = 1
            continue

        used[start_idx] = 1
        poly: list[tuple[float, float]] = [
            (float(p0[0]), float(p0[1])),
            (float(p1[0]), float(p1[1])),
        ]
        start_key = k0
        end_key = k1

        # Extend forward from tail
        while True:
            if end_key == start_key and len(poly) >= 3:
                break
            found = None
            for cand_idx, end_side in adj.get(end_key, ()):
                if not used[cand_idx]:
                    found = (cand_idx, end_side)
                    break
            if found is None:
                break
            cand_idx, end_side = found
            used[cand_idx] = 1
            next_pt = pts_arr[cand_idx][end_side]
            poly.append((float(next_pt[0]), float(next_pt[1])))
            end_key = _key(next_pt)

        # If open, extend backward from head
        if end_key != start_key:
            head_pts: list[tuple[float, float]] = []
            while True:
                found = None
                for cand_idx, end_side in adj.get(start_key, ()):
                    if not used[cand_idx]:
                        found = (cand_idx, end_side)
                        break
                if found is None:
                    break
                cand_idx, end_side = found
                used[cand_idx] = 1
                prev_pt = pts_arr[cand_idx][end_side]
                head_pts.append((float(prev_pt[0]), float(prev_pt[1])))
                start_key = _key(prev_pt)
            if head_pts:
                head_pts.reverse()
                poly = head_pts + poly

        is_closed = len(poly) >= 3 and (
            start_key == end_key
            or math.hypot(poly[0][0] - poly[-1][0], poly[0][1] - poly[-1][1]) < 0.2
        )

        # Drop micro-segments (< 0.12 mm) while keeping shape and closure
        simplified: list[tuple[float, float]] = [poly[0]]
        for pt in poly[1:-1]:
            if math.hypot(pt[0] - simplified[-1][0], pt[1] - simplified[-1][1]) >= 0.12:
                simplified.append(pt)
        if is_closed:
            if len(simplified) >= 3:
                if math.hypot(simplified[0][0] - simplified[-1][0], simplified[0][1] - simplified[-1][1]) >= 0.12:
                    simplified.append(simplified[0])
                else:
                    simplified[-1] = simplified[0]
            if len(simplified) >= 4:
                chains.append((simplified, True))
        else:
            last_pt = poly[-1]
            if math.hypot(last_pt[0] - simplified[-1][0], last_pt[1] - simplified[-1][1]) >= 0.05:
                simplified.append(last_pt)
            if len(simplified) >= 2:
                chains.append((simplified, False))

    return chains


def _signed_area_2d(pts: list[tuple[float, float]]) -> float:
    area = 0.0
    for i in range(len(pts) - 1):
        area += pts[i][0] * pts[i + 1][1] - pts[i + 1][0] * pts[i][1]
    return 0.5 * area


def _inset_closed_loop(pts: list[tuple[float, float]], inset_mm: float = 0.42) -> list[tuple[float, float]]:
    """Compute a single inward-offset perimeter loop for Inner wall preview."""
    if len(pts) < 4:
        return []
    ring = pts[:-1]
    area = _signed_area_2d(pts)
    if abs(area) < 2.0:
        return []

    orient = 1.0 if area > 0 else -1.0
    m = len(ring)
    out: list[tuple[float, float]] = []
    for i in range(m):
        p_prev = ring[(i - 1) % m]
        p_curr = ring[i]
        p_next = ring[(i + 1) % m]

        dx1, dy1 = p_curr[0] - p_prev[0], p_curr[1] - p_prev[1]
        l1 = math.hypot(dx1, dy1)
        dx2, dy2 = p_next[0] - p_curr[0], p_next[1] - p_curr[1]
        l2 = math.hypot(dx2, dy2)
        if l1 < 1e-6 or l2 < 1e-6:
            continue

        nx1, ny1 = -orient * dy1 / l1, orient * dx1 / l1
        nx2, ny2 = -orient * dy2 / l2, orient * dx2 / l2
        mx, my = nx1 + nx2, ny1 + ny2
        ml = math.hypot(mx, my)
        if ml < 1e-6:
            nx, ny = nx1, ny1
            scale = 1.0
        else:
            nx, ny = mx / ml, my / ml
            cos_half = max(0.55, nx * nx1 + ny * ny1)
            scale = min(1.8, 1.0 / cos_half)

        out.append((p_curr[0] + nx * inset_mm * scale, p_curr[1] + ny * inset_mm * scale))

    if len(out) < 3:
        return []
    out.append(out[0])
    inset_area = _signed_area_2d(out)
    if inset_area * area <= 0 or abs(inset_area) < 0.5:
        return []
    return out


def _scanline_infill(
    segments: np.ndarray,
    angle_rad: float,
    spacing_mm: float,
) -> list[tuple[tuple[float, float], tuple[float, float]]]:
    """Generate clipped 2D hatch lines inside closed cross-section segments."""
    if segments is None or len(segments) == 0:
        return []

    pts = np.asarray(segments, dtype=float)
    cos_a = math.cos(angle_rad)
    sin_a = math.sin(angle_rad)

    x0 = pts[:, 0, 0]
    y0 = pts[:, 0, 1]
    x1 = pts[:, 1, 0]
    y1 = pts[:, 1, 1]

    rx0 = x0 * cos_a + y0 * sin_a
    ry0 = -x0 * sin_a + y0 * cos_a
    rx1 = x1 * cos_a + y1 * sin_a
    ry1 = -x1 * sin_a + y1 * cos_a

    y_min = float(min(ry0.min(), ry1.min()))
    y_max = float(max(ry0.max(), ry1.max()))
    span = y_max - y_min
    if span < 0.4:
        return []

    eff_spacing = max(float(spacing_mm), span / 220.0)
    ys = np.arange(y_min + eff_spacing * 0.5, y_max, eff_spacing)

    hatches: list[tuple[tuple[float, float], tuple[float, float]]] = []
    for row_idx, y_val in enumerate(ys):
        mask = ((ry0 <= y_val) & (y_val < ry1)) | ((ry1 <= y_val) & (y_val < ry0))
        if not np.any(mask):
            continue
        denom = ry1[mask] - ry0[mask]
        valid = np.abs(denom) > 1e-9
        if not np.any(valid):
            continue
        t = (y_val - ry0[mask][valid]) / denom[valid]
        xs = np.sort(rx0[mask][valid] + t * (rx1[mask][valid] - rx0[mask][valid]))
        if len(xs) < 2:
            continue

        pairs: list[tuple[float, float]] = []
        for i in range(0, len(xs) - 1, 2):
            xa = float(xs[i])
            xb = float(xs[i + 1])
            if xb - xa >= 0.35:
                pairs.append((xa, xb))
        if row_idx % 2 == 1:
            pairs.reverse()

        for xa, xb in pairs:
            sx, ex = (xb, xa) if row_idx % 2 == 1 else (xa, xb)
            ax = sx * cos_a - y_val * sin_a
            ay = sx * sin_a + y_val * cos_a
            bx = ex * cos_a - y_val * sin_a
            by = ex * sin_a + y_val * cos_a
            hatches.append(((ax, ay), (bx, by)))

    return hatches


def _generate_mock_toolpath_gcode(
    transformed: trimesh.Trimesh,
    bounds: BoundsResult,
    layer_height_mm: float,
    layer_count: int,
    supports_enabled: bool,
    printer: Printer,
) -> str:
    """Slice transformed mesh into layer contours, infill/surfaces, skirt, and optional tree supports."""
    if layer_count <= 0 or bounds.size_z_mm <= 0.01:
        return ""

    if layer_count <= 360:
        sample_indices = list(range(layer_count))
    else:
        sample_indices = sorted(set(int(x) for x in np.linspace(0, layer_count - 1, 300)))

    z_heights = [
        min(bounds.max_z - 0.02, max(bounds.min_z + 0.02, (idx + 0.5) * layer_height_mm))
        for idx in sample_indices
    ]
    z_prints = [round((idx + 1) * layer_height_mm, 3) for idx in sample_indices]

    try:
        raw_lines, _, _ = trimesh.intersections.mesh_multiplane(
            transformed,
            [0.0, 0.0, 0.0],
            [0.0, 0.0, 1.0],
            z_heights,
        )
    except Exception as exc:
        logger.warning("MockTrimeshSlicer mesh_multiplane failed: %s", exc)
        return ""

    # Detect overhang clusters on a 4 mm XY grid when supports are enabled
    support_branches: list[tuple[float, float, int, float]] = []
    if supports_enabled and len(raw_lines) >= 3:
        cell_mm = 4.0
        occ_by_layer: list[set[tuple[int, int]]] = []
        for segs in raw_lines:
            occ: set[tuple[int, int]] = set()
            if segs is not None and len(segs) > 0:
                pts = np.asarray(segs, dtype=float)
                for p in pts.reshape(-1, 2):
                    occ.add((int(math.floor(float(p[0]) / cell_mm)), int(math.floor(float(p[1]) / cell_mm))))
                for a, b in _scanline_infill(pts, 0.0, cell_mm):
                    gx0 = int(math.floor(min(a[0], b[0]) / cell_mm))
                    gx1 = int(math.floor(max(a[0], b[0]) / cell_mm))
                    gy = int(math.floor(a[1] / cell_mm))
                    for gx in range(gx0, gx1 + 1):
                        occ.add((gx, gy))
            occ_by_layer.append(occ)

        raw_overhangs: list[tuple[float, float, int, float]] = []
        for s_idx in range(2, len(occ_by_layer)):
            prev_union = occ_by_layer[s_idx - 1] | occ_by_layer[s_idx - 2]
            for gx, gy in occ_by_layer[s_idx] - prev_union:
                cx = (gx + 0.5) * cell_mm
                cy = (gy + 0.5) * cell_mm
                raw_overhangs.append((cx, cy, s_idx, z_prints[s_idx]))

        for cx, cy, s_idx, z_top in raw_overhangs:
            merged = False
            for b_idx, (bx, by, b_top_idx, b_z_top) in enumerate(support_branches):
                if math.hypot(cx - bx, cy - by) <= 11.0:
                    if s_idx < b_top_idx:
                        support_branches[b_idx] = (cx, cy, s_idx, z_top)
                    merged = True
                    break
            if not merged and len(support_branches) < 16:
                support_branches.append((cx, cy, s_idx, z_top))

    half_bed_x = float(printer.bed_x_mm) * 0.5 - 1.0
    half_bed_y = float(printer.bed_y_mm) * 0.5 - 1.0

    def _clamp_xy(x: float, y: float) -> tuple[float, float]:
        return (
            max(-half_bed_x, min(half_bed_x, x)),
            max(-half_bed_y, min(half_bed_y, y)),
        )

    out: list[str] = []
    cur_x = 0.0
    cur_y = 0.0
    last_feature = ""

    def set_feature(name: str) -> None:
        nonlocal last_feature
        if last_feature != name:
            out.append(f";TYPE:{name}")
            last_feature = name

    def emit_polyline(pts: list[tuple[float, float]]) -> None:
        nonlocal cur_x, cur_y
        if len(pts) < 2:
            return
        sx, sy = _clamp_xy(pts[0][0], pts[0][1])
        if math.hypot(sx - cur_x, sy - cur_y) > 0.05:
            out.append(f"G0 F6000 X{sx:.3f} Y{sy:.3f}")
            cur_x, cur_y = sx, sy
        for px_raw, py_raw in pts[1:]:
            px, py = _clamp_xy(px_raw, py_raw)
            dist = math.hypot(px - cur_x, py - cur_y)
            if dist < 0.02:
                continue
            de = dist * 0.033
            out.append(f"G1 F1800 X{px:.3f} Y{py:.3f} E{de:.4f}")
            cur_x, cur_y = px, py

    total_sampled = len(raw_lines)
    for s_idx, segs in enumerate(raw_lines):
        z_print = z_prints[s_idx]
        out.append(";LAYER_CHANGE")
        out.append(f";Z:{z_print:.3f}")
        out.append(f"G0 Z{z_print:.3f} F600")
        last_feature = ""

        # Layer 0 skirt around XY footprint
        if s_idx == 0:
            skirt_pad = 4.0
            sx0 = max(-half_bed_x, bounds.min_x - skirt_pad)
            sx1 = min(half_bed_x, bounds.max_x + skirt_pad)
            sy0 = max(-half_bed_y, bounds.min_y - skirt_pad)
            sy1 = min(half_bed_y, bounds.max_y + skirt_pad)
            if sx1 - sx0 > 1.0 and sy1 - sy0 > 1.0:
                set_feature("Skirt")
                emit_polyline([(sx0, sy0), (sx1, sy0), (sx1, sy1), (sx0, sy1), (sx0, sy0)])

        # Tapered organic tree support rings for branches reaching higher layers
        active_branches = [b for b in support_branches if b[2] > s_idx]
        if active_branches:
            set_feature("Support")
            for bx, by, _, z_top in active_branches:
                r = max(1.6, min(4.8, 1.8 + 0.04 * max(0.0, z_top - z_print)))
                ring: list[tuple[float, float]] = []
                steps = 10
                for k in range(steps + 1):
                    ang = (2.0 * math.pi * k) / steps
                    ring.append((bx + r * math.cos(ang), by + r * math.sin(ang)))
                emit_polyline(ring)

        if segs is None or len(segs) == 0:
            continue

        segs_arr = np.asarray(segs, dtype=float)
        chains = _chain_2d_segments(segs_arr)
        if not chains:
            continue

        set_feature("Outer wall")
        inner_loops: list[list[tuple[float, float]]] = []
        for poly, is_closed in chains:
            emit_polyline(poly)
            if is_closed:
                inset = _inset_closed_loop(poly, 0.42)
                if inset:
                    inner_loops.append(inset)

        if inner_loops:
            set_feature("Inner wall")
            for loop in inner_loops:
                emit_polyline(loop)

        is_bottom = s_idx < 3
        is_top = s_idx >= max(3, total_sampled - 3)
        angle = math.radians(45.0 if s_idx % 2 == 0 else -45.0)
        if is_bottom:
            hatches = _scanline_infill(segs_arr, angle, 1.2)
            if hatches:
                set_feature("Bottom surface")
                for a, b in hatches:
                    emit_polyline([a, b])
        elif is_top:
            hatches = _scanline_infill(segs_arr, angle, 1.2)
            if hatches:
                set_feature("Top surface")
                for a, b in hatches:
                    emit_polyline([a, b])
        else:
            hatches = _scanline_infill(segs_arr, angle, 3.5)
            if hatches:
                set_feature("Sparse infill")
                for a, b in hatches:
                    emit_polyline([a, b])

    return "\n".join(out) + ("\n" if out else "")


class MockTrimeshSlicer:
    """Deterministic trimesh-based slicer for local Windows/macOS/Linux development."""

    def _find_flattest_base_transform(self, mesh: trimesh.Trimesh) -> Optional[np.ndarray]:
        """Find a rotation aligning the largest flat convex-hull facet downward (-Z) matching OrcaSlicer."""
        try:
            hull = mesh.convex_hull
            if len(hull.faces) == 0:
                return None
            normals = hull.face_normals
            areas = hull.area_faces
            centers = hull.triangles_center

            # Group coplanar faces on the convex hull by quantized normal + plane offset
            groups: dict[tuple[int, int, int, int], list[int]] = {}
            for idx in range(len(hull.faces)):
                n = normals[idx]
                offset = float(np.dot(n, centers[idx]))
                key = (
                    int(round(float(n[0]) * 200)),
                    int(round(float(n[1]) * 200)),
                    int(round(float(n[2]) * 200)),
                    int(round(offset * 10)),
                )
                groups.setdefault(key, []).append(idx)

            candidates: list[tuple[float, np.ndarray]] = []
            for idxs in groups.values():
                group_area = float(np.sum(areas[idxs]))
                avg_normal = np.average(normals[idxs], axis=0, weights=areas[idxs])
                norm_len = float(np.linalg.norm(avg_normal))
                if norm_len < 1e-8:
                    continue
                candidates.append((group_area, avg_normal / norm_len))

            if not candidates:
                return None

            max_area = max(area for area, _ in candidates)
            tied = [
                (area, normal)
                for area, normal in candidates
                if area >= max_area * (1.0 - 1e-3)
            ]
            # LayOnFace.cpp find_largest_plane: prefer the plane already facing most downward (-Z)
            _, best_normal = max(tied, key=lambda item: float(-item[1][2]))

            down = np.array([0.0, 0.0, -1.0])
            if float(np.dot(best_normal, down)) < -1.0 + 1e-9:
                return trimesh.transformations.rotation_matrix(np.pi, [1.0, 0.0, 0.0])
            return trimesh.geometry.align_vectors(best_normal, down)
        except Exception as exc:
            logger.debug("Convex-hull base orientation fallback skipped: %s", exc)
            return None

    def auto_orient_stl(self, original_stl_path: Path, oriented_stl_path: Path) -> BoundsResult:
        """Load STL, find most stable flat orientation, center XY at (0,0) with min_z=0, and export."""
        mesh = _load_mesh(original_stl_path)
        work = mesh.copy()

        # Center around origin before stable pose computation for numerical stability
        work.apply_translation(-work.centroid)
        oriented = False
        try:
            transforms, probs = trimesh.poses.compute_stable_poses(work, n_samples=1)
            if len(transforms) > 0:
                best_idx = int(np.argmax(probs)) if len(probs) == len(transforms) else 0
                work.apply_transform(transforms[best_idx])
                oriented = True
        except Exception as exc:
            logger.debug("compute_stable_poses unavailable (%s); using convex-hull facet solver", exc)

        if not oriented:
            mat = self._find_flattest_base_transform(work)
            if mat is not None:
                work.apply_transform(mat)

        _center_xy_and_drop_z(work, target_x=0.0, target_y=0.0)
        oriented_stl_path.parent.mkdir(parents=True, exist_ok=True)
        work.export(str(oriented_stl_path), file_type="stl")
        return _extract_bounds(work)

    def apply_transform(
        self,
        oriented_stl_path: Path,
        pos_x_mm: float,
        pos_y_mm: float,
        quat_x: float,
        quat_y: float,
        quat_z: float,
        quat_w: float,
        scale: float,
    ) -> tuple[trimesh.Trimesh, BoundsResult]:
        """Apply student scale, quaternion rotation (x,y,z,w), and bed XY placement with min_z=0."""
        mesh = _load_mesh(oriented_stl_path)
        work = mesh.copy()

        # Center around local bounding-box center prior to scale and rotation
        b = work.bounds
        local_center = 0.5 * (b[0] + b[1])
        work.apply_translation(-local_center)

        if abs(scale - 1.0) > 1e-6:
            work.apply_scale(float(scale))

        q = np.array([quat_w, quat_x, quat_y, quat_z], dtype=float)
        norm = float(np.linalg.norm(q))
        if norm > 1e-8:
            q = q / norm
            rot_matrix = trimesh.transformations.quaternion_matrix(q)
            work.apply_transform(rot_matrix)

        _center_xy_and_drop_z(work, target_x=float(pos_x_mm), target_y=float(pos_y_mm))
        return work, _extract_bounds(work)

    def _estimate_volume_cm3(self, mesh: trimesh.Trimesh) -> float:
        """Estimate solid mesh volume in cm^3, handling non-watertight meshes gracefully."""
        vol_mm3 = 0.0
        if mesh.is_watertight:
            try:
                vol_mm3 = float(abs(mesh.volume))
            except Exception:
                vol_mm3 = 0.0

        if vol_mm3 <= 1e-3:
            try:
                hull_vol = float(abs(mesh.convex_hull.volume))
                # Non-watertight meshes may have internal cavities; use 70% of convex hull as conservative proxy
                vol_mm3 = hull_vol * 0.70
            except Exception:
                vol_mm3 = 0.0

        if vol_mm3 <= 1e-3:
            extents = mesh.extents
            vol_mm3 = float(extents[0] * extents[1] * extents[2]) * 0.35

        return max(0.1, vol_mm3 / 1000.0)

    def slice_mesh(
        self,
        oriented_stl_path: Path,
        output_gcode_path: Path,
        printer: Printer,
        slot: PrinterSlot,
        density_g_cm3: float,
        pos_x_mm: float = 0.0,
        pos_y_mm: float = 0.0,
        quat_x: float = 0.0,
        quat_y: float = 0.0,
        quat_z: float = 0.0,
        quat_w: float = 1.0,
        scale: float = 1.0,
        command_preview: str = "",
        supports_enabled: bool = True,
    ) -> SliceResult:
        """Bake transform, verify bed bounds, estimate filament/time, and emit mock G-code."""
        transformed, bounds = self.apply_transform(
            oriented_stl_path=oriented_stl_path,
            pos_x_mm=pos_x_mm,
            pos_y_mm=pos_y_mm,
            quat_x=quat_x,
            quat_y=quat_y,
            quat_z=quat_z,
            quat_w=quat_w,
            scale=scale,
        )
        _validate_bed_bounds(bounds, printer)

        volume_cm3 = self._estimate_volume_cm3(transformed)
        surface_cm2 = max(0.5, float(transformed.area) / 100.0)
        # Approximate 3-perimeter shell + 20% sparse infill + optional organic tree supports
        shell_cm3 = min(volume_cm3, surface_cm2 * 0.12)
        interior_cm3 = max(0.0, volume_cm3 - shell_cm3)
        infill_cm3 = interior_cm3 * 0.20
        support_cm3 = volume_cm3 * 0.06 if supports_enabled else 0.0
        effective_cm3 = shell_cm3 + infill_cm3 + support_cm3

        estimated_grams = round(max(0.5, effective_cm3 * float(density_g_cm3)), 2)
        layer_height_mm = 0.20
        layer_count = max(1, int(math.ceil(max(0.2, bounds.size_z_mm) / layer_height_mm)))
        estimated_minutes = max(5, int(round(estimated_grams * 2.2 + layer_count * 0.08)))

        support_header = (
            "; supports_enabled = 1\n"
            "; support_type = tree(auto)\n"
            "; support_style = organic\n"
            "; support_on_build_plate_only = 1\n"
            if supports_enabled
            else "; supports_enabled = 0\n"
        )

        toolpath_gcode = _generate_mock_toolpath_gcode(
            transformed=transformed,
            bounds=bounds,
            layer_height_mm=layer_height_mm,
            layer_count=layer_count,
            supports_enabled=supports_enabled,
            printer=printer,
        )

        output_gcode_path.parent.mkdir(parents=True, exist_ok=True)
        gcode_content = (
            f"; generated by GGPrint MockTrimeshSlicer\n"
            f"; printer = {printer.display_name} ({printer.fdm_monster_id})\n"
            f"; extruder_slot = {slot.slot_index} ({slot.label})\n"
            f"; filament used [g] = {estimated_grams:.2f}\n"
            f"; estimated printing time (normal mode) = {estimated_minutes}m 0s\n"
            f"; total layers count = {layer_count}\n"
            f"; layer_height = {layer_height_mm:.2f}\n"
            f"; ggprint_coord_origin = center\n"
            f"{support_header}"
            f"; enable_prime_tower = 0\n"
            f"; command_preview = {command_preview}\n"
            f"G90\n"
            f"M83\n"
            f"T{max(0, slot.slot_index - 1)}\n"
            f"G28\n"
            f"{toolpath_gcode}"
            f"M104 S0\n"
            f"M140 S0\n"
            f"M84\n"
        )
        output_gcode_path.write_text(gcode_content, encoding="utf-8")

        return SliceResult(
            estimated_grams=estimated_grams,
            estimated_minutes=estimated_minutes,
            layer_count=layer_count,
            supports_enabled=supports_enabled,
            gcode_path=output_gcode_path,
            gcode_filename=output_gcode_path.name,
            bounds=bounds,
            command_preview=command_preview,
        )


def _index_vendor_presets(search_dirs: list[Path]) -> dict[str, dict[str, Any]]:
    """Index OrcaSlicer preset JSONs by preset name across directories and vendor .zip archives."""
    presets: dict[str, dict[str, Any]] = {}

    def _register(raw_text: str) -> None:
        try:
            loaded = json.loads(raw_text)
        except Exception:
            return
        if isinstance(loaded, dict):
            name = loaded.get("name")
            if isinstance(name, str) and name.strip() and name not in presets:
                presets[name.strip()] = loaded

    for root in search_dirs:
        if not root.exists():
            continue
        try:
            for json_path in sorted(root.rglob("*.json")):
                if not json_path.is_file():
                    continue
                try:
                    _register(json_path.read_text(encoding="utf-8-sig"))
                except OSError:
                    continue
            for zip_path in sorted(root.rglob("*.zip")):
                if not zip_path.is_file():
                    continue
                try:
                    with zipfile.ZipFile(zip_path, "r") as zf:
                        for entry in zf.namelist():
                            if entry.lower().endswith(".json"):
                                try:
                                    _register(zf.read(entry).decode("utf-8-sig"))
                                except Exception:
                                    continue
                except Exception:
                    continue
        except OSError:
            continue

    return presets


def resolve_and_flatten_profile(
    profile_data: dict[str, Any],
    *,
    kind: Optional[str] = None,
    cli_path: Optional[str] = None,
    extra_search_dirs: Optional[list[Path]] = None,
) -> dict[str, Any]:
    """Resolve OrcaSlicer 'inherits' chains against vendor/user JSONs and flatten for CLI use."""
    data = dict(profile_data)
    inherits_name = data.get("inherits")
    if isinstance(inherits_name, str) and inherits_name.strip():
        search_dirs: list[Path] = []
        if extra_search_dirs:
            search_dirs.extend(extra_search_dirs)
        search_dirs.extend(detect_orca_resources_profiles_dirs(cli_path))
        presets_by_name = _index_vendor_presets(search_dirs)

        chain: list[dict[str, Any]] = []
        visited: set[str] = set()
        curr_name: Optional[str] = inherits_name.strip()
        resolved_all = True

        while curr_name:
            if curr_name in visited or len(chain) >= 24:
                resolved_all = False
                break
            visited.add(curr_name)
            parent = presets_by_name.get(curr_name)
            if parent is None:
                resolved_all = False
                logger.warning("OrcaSlicer profile parent '%s' not found in resources/profiles", curr_name)
                break
            chain.append(parent)
            next_parent = parent.get("inherits")
            curr_name = next_parent.strip() if isinstance(next_parent, str) and next_parent.strip() else None

        if chain:
            merged: dict[str, Any] = {}
            for ancestor in reversed(chain):
                merged.update(ancestor)
            merged.update(data)
            data = merged
            if resolved_all:
                data.pop("inherits", None)

    if kind and "type" not in data:
        data["type"] = kind
    if not data.get("from"):
        data["from"] = "User"
    elif data.get("from") == "system" and "inherits" not in data:
        data["from"] = "User"
    if "instantiation" not in data:
        data["instantiation"] = "true"
    if "version" not in data:
        data["version"] = "2.5.0.0"

    return data


def _parse_3mf_to_trimesh(three_mf_path: Path) -> trimesh.Trimesh:
    """Parse a 3MF archive (including OrcaSlicer component transforms) without requiring networkx."""
    with zipfile.ZipFile(three_mf_path, "r") as zf:
        entries = set(zf.namelist())
        root_model = "3D/3dmodel.model"
        if root_model not in entries:
            model_candidates = [n for n in zf.namelist() if n.lower().endswith(".model")]
            if not model_candidates:
                raise SlicerError(f"3MF archive {three_mf_path.name} contains no .model geometry")
            root_model = model_candidates[0]

        def _read_model(entry_path: str) -> tuple[dict[str, tuple], list[tuple[str, Optional[str]]]]:
            norm = entry_path.lstrip("/")
            if norm not in entries:
                raise SlicerError(f"Missing 3MF model part '{norm}'")
            root = ET.fromstring(zf.read(norm))
            objs: dict[str, tuple] = {}
            for elem in root.iter():
                if elem.tag.endswith("}object") or elem.tag == "object":
                    oid = elem.attrib.get("id")
                    if not oid:
                        continue
                    mesh_el = None
                    comps_el = None
                    for ch in elem:
                        if ch.tag.endswith("}mesh") or ch.tag == "mesh":
                            mesh_el = ch
                        elif ch.tag.endswith("}components") or ch.tag == "components":
                            comps_el = ch
                    if mesh_el is not None:
                        verts: list[list[float]] = []
                        faces: list[list[int]] = []
                        for sub in mesh_el:
                            if sub.tag.endswith("}vertices") or sub.tag == "vertices":
                                for v in sub:
                                    verts.append(
                                        [
                                            float(v.attrib["x"]),
                                            float(v.attrib["y"]),
                                            float(v.attrib["z"]),
                                        ]
                                    )
                            elif sub.tag.endswith("}triangles") or sub.tag == "triangles":
                                for t in sub:
                                    faces.append(
                                        [
                                            int(t.attrib["v1"]),
                                            int(t.attrib["v2"]),
                                            int(t.attrib["v3"]),
                                        ]
                                    )
                        if verts and faces:
                            objs[oid] = (
                                "mesh",
                                np.asarray(verts, dtype=float),
                                np.asarray(faces, dtype=np.int64),
                            )
                    elif comps_el is not None:
                        comps: list[tuple[Optional[str], Optional[str], Optional[str]]] = []
                        for comp in comps_el:
                            if comp.tag.endswith("}component") or comp.tag == "component":
                                c_oid = comp.attrib.get("objectid")
                                c_path = None
                                for attr_k, attr_v in comp.attrib.items():
                                    if attr_k.endswith("}path") or attr_k == "path":
                                        c_path = attr_v
                                c_tx = comp.attrib.get("transform")
                                comps.append((c_path, c_oid, c_tx))
                        objs[oid] = ("components", comps)

            build_items: list[tuple[str, Optional[str]]] = []
            for elem in root.iter():
                if elem.tag.endswith("}build") or elem.tag == "build":
                    for item in elem:
                        if item.tag.endswith("}item") or item.tag == "item":
                            oid = item.attrib.get("objectid")
                            if oid:
                                build_items.append((oid, item.attrib.get("transform")))
            return objs, build_items

        def _parse_tx(tx_str: Optional[str]) -> np.ndarray:
            mat = np.eye(4, dtype=float)
            if not tx_str:
                return mat
            vals = [float(x) for x in tx_str.strip().split()]
            if len(vals) == 12:
                mat[0:3, 0] = vals[0:3]
                mat[0:3, 1] = vals[3:6]
                mat[0:3, 2] = vals[6:9]
                mat[0:3, 3] = vals[9:12]
            return mat

        cache: dict[str, tuple[dict[str, tuple], list[tuple[str, Optional[str]]]]] = {}

        def _get_model(path: str):
            norm = path.lstrip("/")
            if norm not in cache:
                cache[norm] = _read_model(norm)
            return cache[norm]

        def _collect(entry_path: str, oid: str, parent_tx: np.ndarray) -> list[trimesh.Trimesh]:
            objs, _ = _get_model(entry_path)
            node = objs.get(oid)
            if node is None:
                return []
            if node[0] == "mesh":
                mesh = trimesh.Trimesh(vertices=node[1].copy(), faces=node[2].copy(), process=False)
                mesh.apply_transform(parent_tx)
                return [mesh]
            collected: list[trimesh.Trimesh] = []
            for c_path, c_oid, c_tx in node[1]:
                if not c_oid:
                    continue
                target_path = c_path if c_path else entry_path
                tx = parent_tx @ _parse_tx(c_tx)
                collected.extend(_collect(target_path, c_oid, tx))
            return collected

        objs, build_items = _get_model(root_model)
        all_meshes: list[trimesh.Trimesh] = []
        if build_items:
            for oid, tx_str in build_items:
                all_meshes.extend(_collect(root_model, oid, _parse_tx(tx_str)))
        else:
            for oid in objs:
                all_meshes.extend(_collect(root_model, oid, np.eye(4, dtype=float)))

    if not all_meshes:
        raise SlicerError(f"3MF archive {three_mf_path.name} contained no meshes")
    merged = trimesh.util.concatenate(all_meshes) if len(all_meshes) > 1 else all_meshes[0]
    if len(merged.vertices) == 0 or len(merged.faces) == 0:
        raise SlicerError(f"3MF archive {three_mf_path.name} has empty geometry")
    return merged


class OrcaSlicerCliAdapter:
    """Production OrcaSlicer CLI adapter for Windows and Linux/Docker deployments."""

    def __init__(self, cli_path: Optional[str] = None) -> None:
        self.cli_path = cli_path or detect_orca_cli_path() or "orca-slicer"
        self._geom_helper = MockTrimeshSlicer()

    def build_orient_command(self, input_stl: Path, output_3mf: Path) -> list[str]:
        return [
            self.cli_path,
            "--orient",
            "1",
            "--ensure-on-bed",
            "--export-3mf",
            str(output_3mf),
            str(input_stl),
        ]

    def build_slice_command(
        self,
        input_3mf: Path,
        output_dir: Path,
        machine_profile: Optional[OrcaProfile],
        process_profile: Optional[OrcaProfile],
        filament_profile: Optional[OrcaProfile],
    ) -> list[str]:
        cmd = [self.cli_path, "--allow-newer-file", "--orient", "0", "--arrange", "0"]
        settings_files = [
            p.file_path for p in (machine_profile, process_profile) if p is not None and p.file_path
        ]
        if settings_files:
            cmd.extend(["--load-settings", ";".join(settings_files)])
        if filament_profile is not None and filament_profile.file_path:
            cmd.extend(["--load-filaments", filament_profile.file_path])
        cmd.extend(["--outputdir", str(output_dir), "--slice", "0", str(input_3mf)])
        return cmd

    def format_command_preview(
        self,
        machine_profile: Optional[OrcaProfile],
        process_profile: Optional[OrcaProfile],
        filament_profile: Optional[OrcaProfile],
        slot_index: int,
        supports_enabled: bool = True,
    ) -> str:
        cmd = self.build_slice_command(
            input_3mf=Path(f"job_slot_{slot_index}.3mf"),
            output_dir=Path("out"),
            machine_profile=machine_profile,
            process_profile=process_profile,
            filament_profile=filament_profile,
        )
        support_tag = "supports=tree(organic,buildplate)" if supports_enabled else "supports=off"
        return " ".join(cmd) + f" [extruder={slot_index}, enable_prime_tower=0, {support_tag}]"

    def _prepare_runtime_profile(
        self,
        profile: Optional[OrcaProfile],
        out_json_path: Path,
        expected_kind: str,
    ) -> tuple[Optional[OrcaProfile], dict[str, Any]]:
        """Load, resolve 'inherits' chains, normalize, and write a CLI-safe JSON profile."""
        if profile is None or not profile.file_path:
            return None, {}

        src_path = Path(profile.file_path)
        data: dict[str, Any] = {}
        if src_path.exists():
            try:
                loaded = json.loads(src_path.read_text(encoding="utf-8-sig"))
                if isinstance(loaded, dict):
                    data = loaded
            except Exception as exc:
                logger.warning("Could not parse %s profile %s: %s", expected_kind, src_path, exc)

        data = resolve_and_flatten_profile(data, kind=expected_kind, cli_path=self.cli_path)
        if expected_kind in ("process", "filament"):
            data.pop("compatible_printers", None)
            data.pop("compatible_printers_condition", None)

        out_json_path.parent.mkdir(parents=True, exist_ok=True)
        out_json_path.write_text(json.dumps(data, indent=2), encoding="utf-8")
        return (
            OrcaProfile(
                name=profile.name,
                kind=expected_kind,
                filename=out_json_path.name,
                file_path=str(out_json_path),
            ),
            data,
        )

    def _build_process_override_profile(
        self,
        process_profile: Optional[OrcaProfile],
        out_json_path: Path,
        supports_enabled: bool,
    ) -> OrcaProfile:
        """Create a temporary Orca process JSON merging organic tree (buildplate-only) support flags."""
        data: dict[str, Any] = {}
        if process_profile is not None and process_profile.file_path:
            src_path = Path(process_profile.file_path)
            if src_path.exists():
                try:
                    loaded = json.loads(src_path.read_text(encoding="utf-8-sig"))
                    if isinstance(loaded, dict):
                        data = loaded
                except Exception as exc:
                    logger.warning("Could not parse process profile %s: %s", src_path, exc)

        data = resolve_and_flatten_profile(data, kind="process", cli_path=self.cli_path)
        data.pop("compatible_printers", None)
        data.pop("compatible_printers_condition", None)
        data.setdefault("enable_prime_tower", "0")

        if supports_enabled:
            data["enable_support"] = "1"
            data["support_type"] = "tree(auto)"
            data["support_style"] = "organic"
            data["support_on_build_plate_only"] = "1"
            data.setdefault("support_threshold_angle", "30")
            data.setdefault("support_interface_top_layers", "2")
            data.setdefault("support_interface_bottom_layers", "2")
            data.setdefault("support_interface_spacing", "0.5")
            data.setdefault("support_top_z_distance", "0.2")
            data.setdefault("support_bottom_z_distance", "0.2")
            data.setdefault("tree_support_branch_angle", "45")
            data.setdefault("tree_support_branch_angle_organic", "45")
            data.setdefault("tree_support_branch_diameter", "2")
            data.setdefault("tree_support_branch_distance_organic", "5")
            data.setdefault("tree_support_tip_diameter", "2")
            data.setdefault("tree_support_wall_count", "0")
        else:
            data["enable_support"] = "0"

        out_json_path.parent.mkdir(parents=True, exist_ok=True)
        out_json_path.write_text(json.dumps(data, indent=2), encoding="utf-8")
        return OrcaProfile(
            name=process_profile.name if process_profile else "ggprint_supports_override",
            kind="process",
            filename=out_json_path.name,
            file_path=str(out_json_path),
        )

    def _get_printable_area_center(
        self,
        printer: Printer,
        machine_data: Optional[dict[str, Any]] = None,
    ) -> tuple[float, float]:
        """Determine the bed center coordinate expected by OrcaSlicer from printable_area."""
        area = machine_data.get("printable_area") if machine_data else None
        pts: list[tuple[float, float]] = []
        if isinstance(area, str):
            area = [part.strip() for part in area.split(",") if part.strip()]
        if isinstance(area, list):
            for entry in area:
                if isinstance(entry, str) and "x" in entry.lower():
                    try:
                        xs, ys = entry.lower().split("x", 1)
                        pts.append((float(xs.strip()), float(ys.strip())))
                    except ValueError:
                        continue
        if pts:
            xs = [p[0] for p in pts]
            ys = [p[1] for p in pts]
            return (0.5 * (min(xs) + max(xs)), 0.5 * (min(ys) + max(ys)))
        return (0.5 * float(printer.bed_x_mm), 0.5 * float(printer.bed_y_mm))

    def _package_single_color_3mf(
        self,
        transformed_stl: Path,
        out_3mf: Path,
        slot_index: int,
        bed_offset_xy: tuple[float, float] = (0.0, 0.0),
    ) -> None:
        """Create a valid 3MF archive assigning the single-color MMU extruder index with prime tower disabled."""
        mesh = _load_mesh(transformed_stl)
        off_x, off_y = float(bed_offset_xy[0]), float(bed_offset_xy[1])
        if abs(off_x) > 1e-6 or abs(off_y) > 1e-6:
            mesh = mesh.copy()
            mesh.apply_translation([off_x, off_y, 0.0])

        content_types = (
            '<?xml version="1.0" encoding="UTF-8"?>\n'
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n'
            '  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n'
            '  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>\n'
            '  <Default Extension="config" ContentType="text/xml"/>\n'
            '</Types>\n'
        )
        rels = (
            '<?xml version="1.0" encoding="UTF-8"?>\n'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n'
            '  <Relationship Target="/3D/3dmodel.model" Id="rel0" '
            'Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>\n'
            '</Relationships>\n'
        )
        verts_xml = "\n".join(
            f'          <vertex x="{v[0]:.6f}" y="{v[1]:.6f}" z="{v[2]:.6f}"/>'
            for v in mesh.vertices
        )
        tris_xml = "\n".join(
            f'          <triangle v1="{int(f[0])}" v2="{int(f[1])}" v3="{int(f[2])}"/>'
            for f in mesh.faces
        )
        model_xml = (
            '<?xml version="1.0" encoding="UTF-8"?>\n'
            '<model unit="millimeter" xml:lang="en-US" '
            'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">\n'
            '  <resources>\n'
            '    <object id="1" type="model">\n'
            '      <mesh>\n'
            '        <vertices>\n'
            f'{verts_xml}\n'
            '        </vertices>\n'
            '        <triangles>\n'
            f'{tris_xml}\n'
            '        </triangles>\n'
            '      </mesh>\n'
            '    </object>\n'
            '  </resources>\n'
            '  <build>\n'
            '    <item objectid="1" printable="1"/>\n'
            '  </build>\n'
            '</model>\n'
        )
        model_settings = (
            '<?xml version="1.0" encoding="UTF-8"?>\n'
            '<config>\n'
            '  <object id="1">\n'
            f'    <metadata key="extruder" value="{slot_index}"/>\n'
            '    <metadata key="enable_prime_tower" value="0"/>\n'
            '    <part id="1" subtype="normal_part">\n'
            f'      <metadata key="extruder" value="{slot_index}"/>\n'
            '    </part>\n'
            '  </object>\n'
            '</config>\n'
        )

        out_3mf.parent.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(out_3mf, "w", zipfile.ZIP_DEFLATED) as zout:
            zout.writestr("[Content_Types].xml", content_types)
            zout.writestr("_rels/.rels", rels)
            zout.writestr("3D/3dmodel.model", model_xml)
            zout.writestr("Metadata/model_settings.config", model_settings)

    def _extract_gcode_from_output_dir(self, out_dir: Path) -> bytes:
        """Extract produced G-code bytes from either *.gcode or *.gcode.3mf output."""
        gcodes = sorted(p for p in out_dir.rglob("*.gcode") if p.is_file())
        if gcodes:
            return gcodes[0].read_bytes()

        gcode_3mfs = sorted(p for p in out_dir.rglob("*.gcode.3mf") if p.is_file())
        for archive_path in gcode_3mfs:
            try:
                with zipfile.ZipFile(archive_path, "r") as zf:
                    entries = sorted(n for n in zf.namelist() if n.lower().endswith(".gcode"))
                    if entries:
                        return zf.read(entries[0])
            except Exception as exc:
                logger.warning("Failed reading .gcode.3mf archive %s: %s", archive_path, exc)

        raise SlicerError("OrcaSlicer completed without producing a .gcode or .gcode.3mf file")

    def _parse_orca_gcode_metrics(self, gcode_path: Path) -> tuple[float, int, int]:
        """Parse filament grams, estimated minutes, and layer count from OrcaSlicer G-code comments."""
        text = gcode_path.read_text(encoding="utf-8", errors="ignore")
        grams = 10.0
        minutes = 30
        layers = 50

        m_total_grams = re.search(r";\s*total filament used \[g\]\s*=\s*([0-9]+(?:\.[0-9]+)?)", text)
        if m_total_grams:
            grams = round(float(m_total_grams.group(1)), 2)
        else:
            m_grams = re.search(r";\s*filament used \[g\]\s*=\s*([^\r\n]+)", text)
            if m_grams:
                vals = [float(x) for x in re.findall(r"[0-9]+(?:\.[0-9]+)?", m_grams.group(1))]
                if vals:
                    grams = round(sum(vals), 2)

        m_time = re.search(r";\s*estimated printing time.*?=\s*(.+)", text)
        if m_time:
            raw = m_time.group(1)
            days = sum(int(x) for x in re.findall(r"(\d+)d", raw))
            hrs = sum(int(x) for x in re.findall(r"(\d+)h", raw))
            mins = sum(int(x) for x in re.findall(r"(\d+)m", raw))
            secs = sum(int(x) for x in re.findall(r"(\d+)s", raw))
            minutes = max(1, days * 1440 + hrs * 60 + mins + (1 if secs >= 30 else 0))

        m_layers = re.search(r";\s*total layer(?:s)?\s*(?:number|count)\s*[:=]\s*(\d+)", text, re.IGNORECASE)
        if m_layers:
            layers = max(1, int(m_layers.group(1)))

        return grams, minutes, layers

    def auto_orient_stl(self, original_stl_path: Path, oriented_stl_path: Path) -> BoundsResult:
        """Run OrcaSlicer --orient 1 --ensure-on-bed --export-3mf; export normalized STL centered at (0,0)."""
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp_3mf = Path(tmpdir) / "oriented.3mf"
            cmd = self.build_orient_command(original_stl_path, tmp_3mf)
            try:
                proc = subprocess.run(cmd, capture_output=True, text=True, timeout=60, check=True)
                logger.info("OrcaSlicer orient succeeded: %s", (proc.stdout or "")[:200])
                if not tmp_3mf.exists():
                    raise SlicerError("OrcaSlicer orient completed without producing oriented.3mf")
                loaded = _parse_3mf_to_trimesh(tmp_3mf)
                _center_xy_and_drop_z(loaded, 0.0, 0.0)
                oriented_stl_path.parent.mkdir(parents=True, exist_ok=True)
                loaded.export(str(oriented_stl_path), file_type="stl")
                return _extract_bounds(loaded)
            except FileNotFoundError as exc:
                raise SlicerError(f"OrcaSlicer binary not found at '{self.cli_path}'") from exc
            except subprocess.CalledProcessError as exc:
                raise SlicerError(f"OrcaSlicer orient failed: {exc.stderr or exc.stdout}") from exc

    def slice_mesh(
        self,
        oriented_stl_path: Path,
        output_gcode_path: Path,
        printer: Printer,
        slot: PrinterSlot,
        machine_profile: Optional[OrcaProfile],
        process_profile: Optional[OrcaProfile],
        filament_profile: Optional[OrcaProfile],
        pos_x_mm: float = 0.0,
        pos_y_mm: float = 0.0,
        quat_x: float = 0.0,
        quat_y: float = 0.0,
        quat_z: float = 0.0,
        quat_w: float = 1.0,
        scale: float = 1.0,
        supports_enabled: bool = True,
    ) -> SliceResult:
        """Bake transform, validate bounds, package single-color MMU .3mf at printable_area center, and invoke OrcaSlicer CLI."""
        transformed, bounds = self._geom_helper.apply_transform(
            oriented_stl_path=oriented_stl_path,
            pos_x_mm=pos_x_mm,
            pos_y_mm=pos_y_mm,
            quat_x=quat_x,
            quat_y=quat_y,
            quat_z=quat_z,
            quat_w=quat_w,
            scale=scale,
        )
        _validate_bed_bounds(bounds, printer)

        preview = self.format_command_preview(
            machine_profile,
            process_profile,
            filament_profile,
            slot.slot_index,
            supports_enabled=supports_enabled,
        )

        with tempfile.TemporaryDirectory() as tmpdir:
            tmp_path = Path(tmpdir)
            baked_stl = tmp_path / "transformed.stl"
            input_3mf = tmp_path / "job.3mf"
            out_dir = tmp_path / "out"
            out_dir.mkdir(parents=True, exist_ok=True)

            effective_machine, machine_data = self._prepare_runtime_profile(
                machine_profile,
                tmp_path / "machine_effective.json",
                expected_kind="machine",
            )
            effective_process = self._build_process_override_profile(
                process_profile,
                tmp_path / "process_override.json",
                supports_enabled=supports_enabled,
            )
            effective_filament, _ = self._prepare_runtime_profile(
                filament_profile,
                tmp_path / "filament_effective.json",
                expected_kind="filament",
            )

            bed_center = self._get_printable_area_center(printer, machine_data)
            transformed.export(str(baked_stl), file_type="stl")
            self._package_single_color_3mf(
                baked_stl,
                input_3mf,
                slot.slot_index,
                bed_offset_xy=bed_center,
            )
            cmd = self.build_slice_command(
                input_3mf,
                out_dir,
                effective_machine,
                effective_process,
                effective_filament,
            )

            try:
                subprocess.run(cmd, capture_output=True, text=True, timeout=180, check=True)
            except FileNotFoundError as exc:
                raise SlicerError(f"OrcaSlicer binary not found at '{self.cli_path}'") from exc
            except subprocess.CalledProcessError as exc:
                raise SlicerError(f"OrcaSlicer slice failed: {exc.stderr or exc.stdout}") from exc

            gcode_bytes = self._extract_gcode_from_output_dir(out_dir)
            output_gcode_path.parent.mkdir(parents=True, exist_ok=True)
            output_gcode_path.write_bytes(gcode_bytes)

        grams, minutes, layers = self._parse_orca_gcode_metrics(output_gcode_path)
        return SliceResult(
            estimated_grams=grams,
            estimated_minutes=minutes,
            layer_count=layers,
            supports_enabled=supports_enabled,
            gcode_path=output_gcode_path,
            gcode_filename=output_gcode_path.name,
            bounds=bounds,
            command_preview=preview,
        )


def resolve_profiles_for_slot(
    printer: Printer,
    slot: PrinterSlot,
) -> tuple[Optional[OrcaProfile], Optional[OrcaProfile], Optional[OrcaProfile]]:
    """Resolve (machine_profile, process_profile, filament_profile) for a printer + MMU slot."""
    machine_profile = printer.machine_profile
    filament = slot.filament
    filament_profile = filament.filament_profile if filament else None
    process_profile = (
        filament.process_override_profile
        if filament and filament.process_override_profile is not None
        else printer.process_profile
    )
    return machine_profile, process_profile, filament_profile


def build_command_preview(
    printer: Printer,
    slot: PrinterSlot,
    sys_settings: SystemSettings,
    supports_enabled: bool = True,
) -> str:
    machine_p, process_p, filament_p = resolve_profiles_for_slot(printer, slot)
    adapter = OrcaSlicerCliAdapter(cli_path=sys_settings.orca_cli_path)
    return adapter.format_command_preview(
        machine_p,
        process_p,
        filament_p,
        slot.slot_index,
        supports_enabled=supports_enabled,
    )


def run_auto_orient(
    original_stl_path: Path,
    oriented_stl_path: Path,
    sys_settings: SystemSettings,
) -> BoundsResult:
    """Auto-orient an uploaded STL using the configured slicer mode."""
    if sys_settings.slicer_mode == "orcaslicer":
        adapter = OrcaSlicerCliAdapter(cli_path=sys_settings.orca_cli_path)
        return adapter.auto_orient_stl(original_stl_path, oriented_stl_path)
    return MockTrimeshSlicer().auto_orient_stl(original_stl_path, oriented_stl_path)


def run_slice(
    oriented_stl_path: Path,
    output_gcode_path: Path,
    printer: Printer,
    slot: PrinterSlot,
    sys_settings: SystemSettings,
    pos_x_mm: float = 0.0,
    pos_y_mm: float = 0.0,
    quat_x: float = 0.0,
    quat_y: float = 0.0,
    quat_z: float = 0.0,
    quat_w: float = 1.0,
    scale: float = 1.0,
    supports_enabled: bool = True,
) -> SliceResult:
    """Slice an oriented STL with student transform and admin profiles."""
    machine_p, process_p, filament_p = resolve_profiles_for_slot(printer, slot)
    preview = OrcaSlicerCliAdapter(cli_path=sys_settings.orca_cli_path).format_command_preview(
        machine_p, process_p, filament_p, slot.slot_index, supports_enabled=supports_enabled
    )

    if sys_settings.slicer_mode == "orcaslicer":
        adapter = OrcaSlicerCliAdapter(cli_path=sys_settings.orca_cli_path)
        return adapter.slice_mesh(
            oriented_stl_path=oriented_stl_path,
            output_gcode_path=output_gcode_path,
            printer=printer,
            slot=slot,
            machine_profile=machine_p,
            process_profile=process_p,
            filament_profile=filament_p,
            pos_x_mm=pos_x_mm,
            pos_y_mm=pos_y_mm,
            quat_x=quat_x,
            quat_y=quat_y,
            quat_z=quat_z,
            quat_w=quat_w,
            scale=scale,
            supports_enabled=supports_enabled,
        )

    density = float(slot.filament.density_g_cm3) if slot.filament else 1.24
    return MockTrimeshSlicer().slice_mesh(
        oriented_stl_path=oriented_stl_path,
        output_gcode_path=output_gcode_path,
        printer=printer,
        slot=slot,
        density_g_cm3=density,
        pos_x_mm=pos_x_mm,
        pos_y_mm=pos_y_mm,
        quat_x=quat_x,
        quat_y=quat_y,
        quat_z=quat_z,
        quat_w=quat_w,
        scale=scale,
        command_preview=preview,
        supports_enabled=supports_enabled,
    )
