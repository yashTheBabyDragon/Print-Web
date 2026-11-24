"""Slicer adapters: MockTrimeshSlicer for local dev and OrcaSlicerCliAdapter for Proxmox."""

from __future__ import annotations

import json
import logging
import math
import re
import subprocess
import tempfile
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import numpy as np
import trimesh

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

        output_gcode_path.parent.mkdir(parents=True, exist_ok=True)
        gcode_content = (
            f"; generated by GGPrint MockTrimeshSlicer\n"
            f"; printer = {printer.display_name} ({printer.fdm_monster_id})\n"
            f"; extruder_slot = {slot.slot_index} ({slot.label})\n"
            f"; filament used [g] = {estimated_grams:.2f}\n"
            f"; estimated printing time (normal mode) = {estimated_minutes}m 0s\n"
            f"; total layers count = {layer_count}\n"
            f"{support_header}"
            f"; enable_prime_tower = 0\n"
            f"; command_preview = {command_preview}\n"
            f"G90\n"
            f"M83\n"
            f"T{max(0, slot.slot_index - 1)}\n"
            f"G28\n"
            f"G1 Z0.200 F600\n"
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


class OrcaSlicerCliAdapter:
    """Production OrcaSlicer CLI adapter for Proxmox Linux deployment."""

    def __init__(self, cli_path: str = "orca-slicer") -> None:
        self.cli_path = cli_path
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
        cmd = [self.cli_path, "--orient", "0", "--arrange", "0"]
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

    def _build_process_override_profile(
        self,
        process_profile: Optional[OrcaProfile],
        out_json_path: Path,
        supports_enabled: bool,
    ) -> OrcaProfile:
        """Create a temporary Orca process JSON merging organic tree (buildplate-only) support flags."""
        data: dict[str, object] = {}
        if process_profile is not None and process_profile.file_path:
            src_path = Path(process_profile.file_path)
            if src_path.exists():
                try:
                    loaded = json.loads(src_path.read_text(encoding="utf-8"))
                    if isinstance(loaded, dict):
                        data = loaded
                except Exception as exc:
                    logger.warning("Could not parse process profile %s: %s", src_path, exc)

        if supports_enabled:
            data["enable_support"] = "1"
            data["support_type"] = "tree(auto)"
            data["support_style"] = "organic"
            data["support_on_build_plate_only"] = "1"
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

    def _package_single_color_3mf(self, transformed_stl: Path, out_3mf: Path, slot_index: int) -> None:
        """Create a valid 3MF archive assigning the single-color MMU extruder index with prime tower disabled."""
        mesh = _load_mesh(transformed_stl)

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
            '    <item objectid="1"/>\n'
            '  </build>\n'
            '</model>\n'
        )
        model_settings = (
            '<?xml version="1.0" encoding="UTF-8"?>\n'
            '<config>\n'
            '  <object id="1">\n'
            f'    <metadata key="extruder" value="{slot_index}"/>\n'
            '    <metadata key="enable_prime_tower" value="0"/>\n'
            '  </object>\n'
            '</config>\n'
        )

        out_3mf.parent.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(out_3mf, "w", zipfile.ZIP_DEFLATED) as zout:
            zout.writestr("[Content_Types].xml", content_types)
            zout.writestr("_rels/.rels", rels)
            zout.writestr("3D/3dmodel.model", model_xml)
            zout.writestr("Metadata/model_settings.config", model_settings)

    def _parse_orca_gcode_metrics(self, gcode_path: Path) -> tuple[float, int, int]:
        """Parse filament grams, estimated minutes, and layer count from OrcaSlicer G-code comments."""
        text = gcode_path.read_text(encoding="utf-8", errors="ignore")
        grams = 10.0
        minutes = 30
        layers = 50

        m_grams = re.search(r";\s*filament used \[g\]\s*=\s*([0-9]+(?:\.[0-9]+)?)", text)
        if m_grams:
            grams = round(float(m_grams.group(1)), 2)

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
        """Run OrcaSlicer --orient 1 --ensure-on-bed if available; export normalized STL."""
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp_3mf = Path(tmpdir) / "oriented.3mf"
            cmd = self.build_orient_command(original_stl_path, tmp_3mf)
            try:
                proc = subprocess.run(cmd, capture_output=True, text=True, timeout=60, check=True)
                logger.info("OrcaSlicer orient succeeded: %s", proc.stdout[:200])
                loaded = trimesh.load(str(tmp_3mf), force="mesh", process=True)
                if isinstance(loaded, trimesh.Scene):
                    geoms = [g for g in loaded.geometry.values() if isinstance(g, trimesh.Trimesh)]
                    loaded = trimesh.util.concatenate(geoms)
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
        """Bake transform, validate bounds, package single-color MMU .3mf, and invoke OrcaSlicer CLI."""
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
            effective_process = self._build_process_override_profile(
                process_profile,
                tmp_path / "process_override.json",
                supports_enabled=supports_enabled,
            )

            transformed.export(str(baked_stl), file_type="stl")
            self._package_single_color_3mf(baked_stl, input_3mf, slot.slot_index)
            cmd = self.build_slice_command(input_3mf, out_dir, machine_profile, effective_process, filament_profile)

            try:
                subprocess.run(cmd, capture_output=True, text=True, timeout=180, check=True)
            except FileNotFoundError as exc:
                raise SlicerError(f"OrcaSlicer binary not found at '{self.cli_path}'") from exc
            except subprocess.CalledProcessError as exc:
                raise SlicerError(f"OrcaSlicer slice failed: {exc.stderr or exc.stdout}") from exc

            gcodes = list(out_dir.glob("*.gcode"))
            if not gcodes:
                raise SlicerError("OrcaSlicer completed without producing a .gcode file")
            produced = gcodes[0]
            output_gcode_path.parent.mkdir(parents=True, exist_ok=True)
            output_gcode_path.write_bytes(produced.read_bytes())

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
