"""Idempotent initial database seeding for Print-Web."""

from __future__ import annotations

import json
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth import hash_password
from app.config import detect_orca_cli_path, settings
from app.models import (
    ClassEnrollment,
    DAWhitelist,
    Filament,
    OrcaProfile,
    Printer,
    PrinterSlot,
    PrinterStatus,
    PrinterType,
    ProfileKind,
    SystemSettings,
    TeacherClass,
    User,
)


def _build_machine_profile(
    *,
    name: str,
    gcode_flavor: str,
    bed_x: int,
    bed_y: int,
    bed_z: int,
    mmu_slots: int,
    extruder_colours: list[str],
    max_accel_xy: str,
    max_speed_xy: str,
    retraction_length: str,
    retraction_speed: str,
    start_gcode: str,
    end_gcode: str,
) -> dict:
    """Build a complete, standalone CLI-verified OrcaSlicer machine JSON profile."""
    def _per_ext(val: str) -> list[str]:
        return [val] * mmu_slots

    return {
        "type": "machine",
        "from": "User",
        "instantiation": "true",
        "version": "2.5.0.0",
        "name": name,
        "printer_settings_id": name,
        "printer_technology": "FFF",
        "printer_variant": "0.4",
        "printer_notes": "",
        "gcode_flavor": gcode_flavor,
        "printable_area": ["0x0", f"{bed_x}x0", f"{bed_x}x{bed_y}", f"0x{bed_y}"],
        "printable_height": str(bed_z),
        "single_extruder_multi_material": "1",
        "support_chamber_temp_control": "0",
        "support_air_filtration": "0",
        "silent_mode": "0",
        "disable_m73": "0" if gcode_flavor == "marlin2" else "1",
        "nozzle_diameter": _per_ext("0.4"),
        "extruder_colour": extruder_colours[:mmu_slots],
        "extruder_offset": _per_ext("0x0"),
        "deretraction_speed": _per_ext(retraction_speed),
        "max_layer_height": _per_ext("0.28"),
        "min_layer_height": _per_ext("0.08"),
        "retraction_minimum_travel": _per_ext("0.8"),
        "retract_before_wipe": _per_ext("0%"),
        "retract_when_changing_layer": _per_ext("1"),
        "retraction_length": _per_ext(retraction_length),
        "retract_length_toolchange": _per_ext("2"),
        "z_hop": _per_ext("0.4"),
        "retract_restart_extra": _per_ext("0"),
        "retract_restart_extra_toolchange": _per_ext("0"),
        "retraction_speed": _per_ext(retraction_speed),
        "wipe": _per_ext("1"),
        "z_hop_types": _per_ext("Auto Lift"),
        "cooling_tube_retraction": "90",
        "parking_pos_retraction": "90",
        "extruder_clearance_radius": "57",
        "extruder_clearance_height_to_rod": "36",
        "extruder_clearance_height_to_lid": "90",
        "machine_max_acceleration_e": ["5000", "5000"],
        "machine_max_acceleration_extruding": [max_accel_xy, max_accel_xy],
        "machine_max_acceleration_retracting": ["5000", "5000"],
        "machine_max_acceleration_x": [max_accel_xy, max_accel_xy],
        "machine_max_acceleration_y": [max_accel_xy, max_accel_xy],
        "machine_max_acceleration_z": ["500", "200"],
        "machine_max_speed_e": ["60", "60"],
        "machine_max_speed_x": [max_speed_xy, max_speed_xy],
        "machine_max_speed_y": [max_speed_xy, max_speed_xy],
        "machine_max_speed_z": ["20", "20"],
        "machine_max_jerk_e": ["2.5", "2.5"],
        "machine_max_jerk_x": ["9", "9"],
        "machine_max_jerk_y": ["9", "9"],
        "machine_max_jerk_z": ["3", "3"],
        "machine_min_extruding_rate": ["0", "0"],
        "machine_min_travel_rate": ["0", "0"],
        "default_filament_profile": ["Print-Web Generic PLA"],
        "before_layer_change_gcode": ";BEFORE_LAYER_CHANGE\n;[layer_z]\nG92 E0\n",
        "layer_change_gcode": ";AFTER_LAYER_CHANGE\n;[layer_z]\n",
        "change_filament_gcode": "T[next_extruder]\n",
        "machine_start_gcode": start_gcode,
        "machine_end_gcode": end_gcode,
    }


def _build_process_profile(
    *,
    name: str,
    sparse_infill_density: str,
    outer_wall_speed: str,
    inner_wall_speed: str,
    sparse_infill_speed: str,
    internal_solid_infill_speed: str,
    top_surface_speed: str,
    travel_speed: str,
    default_acceleration: str,
) -> dict:
    """Build a complete, standalone CLI-verified OrcaSlicer process JSON profile."""
    return {
        "type": "process",
        "from": "User",
        "instantiation": "true",
        "version": "2.5.0.0",
        "name": name,
        "print_settings_id": name,
        "layer_height": "0.20",
        "initial_layer_print_height": "0.20",
        "adaptive_layer_height": "0",
        "print_sequence": "by layer",
        "wall_loops": "3",
        "wall_generator": "classic",
        "wall_sequence": "inner wall/outer wall",
        "wall_infill_order": "inner wall/outer wall/infill",
        "top_shell_layers": "5",
        "top_shell_thickness": "1.0",
        "bottom_shell_layers": "3",
        "bottom_shell_thickness": "0.6",
        "top_surface_pattern": "monotonicline",
        "bottom_surface_pattern": "monotonic",
        "only_one_wall_top": "1",
        "ensure_vertical_shell_thickness": "ensure_all",
        "detect_thin_wall": "0",
        "detect_overhang_wall": "1",
        "detect_narrow_internal_solid_infill": "1",
        "extra_perimeters_on_overhangs": "0",
        "precise_outer_wall": "0",
        "seam_position": "aligned",
        "seam_slope_conditional": "1",
        "seam_slope_inner_walls": "1",
        "seam_slope_min_length": "0",
        "seam_slope_type": "none",
        "staggered_inner_seams": "0",
        "line_width": "0.42",
        "initial_layer_line_width": "0.50",
        "outer_wall_line_width": "0.42",
        "inner_wall_line_width": "0.45",
        "sparse_infill_line_width": "0.45",
        "internal_solid_infill_line_width": "0.42",
        "top_surface_line_width": "0.42",
        "support_line_width": "0.42",
        "sparse_infill_density": sparse_infill_density,
        "sparse_infill_pattern": "gyroid",
        "infill_direction": "45",
        "infill_combination": "0",
        "infill_wall_overlap": "15%",
        "top_bottom_infill_wall_overlap": "5%",
        "infill_anchor": "400%",
        "infill_anchor_max": "40",
        "minimum_sparse_infill_area": "15",
        "reduce_infill_retraction": "1",
        "filter_out_gap_fill": "1",
        "gap_fill_target": "everywhere",
        "outer_wall_speed": outer_wall_speed,
        "inner_wall_speed": inner_wall_speed,
        "sparse_infill_speed": sparse_infill_speed,
        "internal_solid_infill_speed": internal_solid_infill_speed,
        "top_surface_speed": top_surface_speed,
        "initial_layer_speed": "50",
        "initial_layer_infill_speed": "105",
        "gap_infill_speed": "180",
        "bridge_speed": "50",
        "internal_bridge_speed": "50",
        "travel_speed": travel_speed,
        "support_speed": "150",
        "support_interface_speed": "80",
        "overhang_speed_classic": "1",
        "overhang_1_4_speed": "0",
        "overhang_2_4_speed": "50",
        "overhang_3_4_speed": "30",
        "overhang_4_4_speed": "10",
        "default_acceleration": default_acceleration,
        "outer_wall_acceleration": "4000",
        "inner_wall_acceleration": "0",
        "top_surface_acceleration": "2000",
        "initial_layer_acceleration": "500",
        "travel_acceleration": "0",
        "accel_to_decel_enable": "0",
        "bridge_flow": "1",
        "internal_bridge_flow": "0.95",
        "internal_bridge_support_thickness": "0.8",
        "bridge_no_support": "0",
        "print_flow_ratio": "1.0",
        "elefant_foot_compensation": "0.1",
        "xy_hole_compensation": "0",
        "xy_contour_compensation": "0",
        "resolution": "0.012",
        "enable_arc_fitting": "1",
        "reduce_crossing_wall": "0",
        "max_travel_detour_distance": "0",
        "slowdown_for_curled_perimeters": "0",
        "spiral_mode": "0",
        "interface_shells": "0",
        "raft_layers": "0",
        "skirt_loops": "1",
        "skirt_distance": "2",
        "skirt_height": "1",
        "brim_width": "0",
        "brim_object_gap": "0.1",
        "draft_shield": "disabled",
        "ironing_type": "no ironing",
        "ironing_flow": "10%",
        "ironing_spacing": "0.15",
        "ironing_speed": "30",
        "enable_support": "1",
        "support_type": "tree(auto)",
        "support_style": "organic",
        "support_on_build_plate_only": "1",
        "support_threshold_angle": "30",
        "support_filament": "0",
        "support_interface_filament": "0",
        "support_top_z_distance": "0.2",
        "support_bottom_z_distance": "0.2",
        "support_interface_top_layers": "2",
        "support_interface_bottom_layers": "2",
        "support_interface_spacing": "0.5",
        "support_interface_pattern": "auto",
        "support_interface_loop_pattern": "0",
        "support_base_pattern": "default",
        "support_base_pattern_spacing": "2.5",
        "support_object_xy_distance": "0.35",
        "support_expansion": "0",
        "tree_support_angle_slow": "30",
        "tree_support_branch_angle": "45",
        "tree_support_branch_angle_organic": "45",
        "tree_support_branch_diameter": "2",
        "tree_support_branch_diameter_double_wall": "10",
        "tree_support_branch_distance_organic": "5",
        "tree_support_tip_diameter": "2",
        "tree_support_wall_count": "0",
        "enable_prime_tower": "0",
        "prime_tower_width": "35",
        "wipe_tower_no_sparse_layers": "0",
        "standby_temperature_delta": "-5",
        "role_based_wipe_speed": "0",
        "wipe_on_loops": "0",
        "wipe_before_external_loop": "0",
        "wipe_speed": "100%",
        "exclude_object": "1",
        "gcode_label_objects": "0",
        "filename_format": "{input_filename_base}_{layer_height}mm_{filament_type[0]}_{print_time}.gcode",
    }


def _build_filament_profile(
    *,
    name: str,
    filament_type: str,
    density: str,
    nozzle_temp: str,
    nozzle_temp_initial: str,
    bed_temp: str,
    temp_low: str,
    temp_high: str,
    max_volumetric_speed: str,
    fan_min: str,
    fan_max: str,
    overhang_fan: str,
    close_fan_layers: str,
    slow_down_layer_time: str,
    temp_vitrification: str,
) -> dict:
    """Build a complete, standalone CLI-verified OrcaSlicer filament JSON profile."""
    return {
        "type": "filament",
        "from": "User",
        "instantiation": "true",
        "version": "2.5.0.0",
        "name": name,
        "filament_settings_id": [name],
        "filament_type": [filament_type],
        "filament_vendor": ["Print-Web"],
        "filament_density": [density],
        "filament_diameter": ["1.75"],
        "filament_flow_ratio": ["0.98"],
        "filament_cost": ["22"],
        "filament_soluble": ["0"],
        "filament_max_volumetric_speed": [max_volumetric_speed],
        "filament_minimal_purge_on_wipe_tower": ["15"],
        "bed_type": ["Textured PEI Plate"],
        "cool_plate_temp": [bed_temp],
        "eng_plate_temp": [bed_temp],
        "hot_plate_temp": [bed_temp],
        "textured_plate_temp": [bed_temp],
        "cool_plate_temp_initial_layer": [bed_temp],
        "eng_plate_temp_initial_layer": [bed_temp],
        "hot_plate_temp_initial_layer": [bed_temp],
        "textured_plate_temp_initial_layer": [bed_temp],
        "nozzle_temperature": [nozzle_temp],
        "nozzle_temperature_initial_layer": [nozzle_temp_initial],
        "nozzle_temperature_range_low": [temp_low],
        "nozzle_temperature_range_high": [temp_high],
        "temperature_vitrification": [temp_vitrification],
        "fan_min_speed": [fan_min],
        "fan_max_speed": [fan_max],
        "overhang_fan_threshold": ["50%"],
        "overhang_fan_speed": [overhang_fan],
        "additional_cooling_fan_speed": ["60" if filament_type == "PLA" else "20"],
        "slow_down_for_layer_cooling": ["1"],
        "slow_down_layer_time": [slow_down_layer_time],
        "slow_down_min_speed": ["10"],
        "close_fan_the_first_x_layers": [close_fan_layers],
        "full_fan_speed_layer": ["0" if filament_type == "PLA" else "3"],
        "reduce_fan_stop_start_freq": ["1"],
        "fan_cooling_layer_time": ["100"],
        "filament_deretraction_speed": ["nil"],
        "filament_retraction_minimum_travel": ["nil"],
        "filament_retract_before_wipe": ["nil"],
        "filament_retract_when_changing_layer": ["nil"],
        "filament_retraction_length": ["nil"],
        "filament_z_hop": ["nil"],
        "filament_z_hop_types": ["nil"],
        "filament_retract_restart_extra": ["nil"],
        "filament_retraction_speed": ["nil"],
        "filament_wipe": ["nil"],
        "filament_wipe_distance": ["nil"],
        "filament_start_gcode": ["; filament start gcode\n"],
        "filament_end_gcode": ["; filament end gcode\n"],
    }


def _get_seeded_profile_specs() -> list[tuple[str, str, str, str, dict]]:
    """Return the 9 canonical Print-Web OrcaSlicer profile definitions."""
    klipper_start = (
        "G90\nM83\n"
        "M140 S[bed_temperature_initial_layer_single]\n"
        "M104 S[nozzle_temperature_initial_layer]\n"
        "G28\n"
        "M190 S[bed_temperature_initial_layer_single]\n"
        "M109 S[nozzle_temperature_initial_layer]\n"
        "T[initial_extruder]\n"
        "G92 E0\n"
    )
    klipper_end = "M104 S0\nM140 S0\nG91\nG1 Z10 F600\nG90\nM84\n"
    prusa_start = (
        "G90\nM83\n"
        "M140 S[bed_temperature_initial_layer_single]\n"
        "M104 S[nozzle_temperature_initial_layer]\n"
        "G28 W\n"
        "M190 S[bed_temperature_initial_layer_single]\n"
        "M109 S[nozzle_temperature_initial_layer]\n"
        "T[initial_extruder]\n"
        "G92 E0\n"
    )
    prusa_end = "M104 S0\nM140 S0\nG91\nG1 Z10 F600\nG90\nM84\n"

    return [
        (
            "Voron 2.4 300mm Klipper",
            ProfileKind.MACHINE.value,
            "voron_24_300_klipper.json",
            "Default Klipper Voron 2.4 + BoxTurtle 4-lane MMU machine profile",
            _build_machine_profile(
                name="Voron 2.4 300mm Klipper",
                gcode_flavor="klipper",
                bed_x=300,
                bed_y=300,
                bed_z=300,
                mmu_slots=4,
                extruder_colours=["#1E293B", "#F8FAFC", "#00A7D9", "#10B981"],
                max_accel_xy="10000",
                max_speed_xy="350",
                retraction_length="0.8",
                retraction_speed="35",
                start_gcode=klipper_start,
                end_gcode=klipper_end,
            ),
        ),
        (
            "RatRig V-Core 300mm Klipper",
            ProfileKind.MACHINE.value,
            "ratrig_vcore_300_klipper.json",
            "Default Klipper RatRig V-Core single extruder profile",
            _build_machine_profile(
                name="RatRig V-Core 300mm Klipper",
                gcode_flavor="klipper",
                bed_x=300,
                bed_y=300,
                bed_z=300,
                mmu_slots=1,
                extruder_colours=["#F97316"],
                max_accel_xy="10000",
                max_speed_xy="350",
                retraction_length="0.8",
                retraction_speed="35",
                start_gcode=klipper_start,
                end_gcode=klipper_end,
            ),
        ),
        (
            "Prusa MK4S + MMU3",
            ProfileKind.MACHINE.value,
            "prusa_mk4s_mmu3.json",
            "PrusaLink MK4S with 5-slot MMU3 machine profile",
            _build_machine_profile(
                name="Prusa MK4S + MMU3",
                gcode_flavor="marlin2",
                bed_x=250,
                bed_y=210,
                bed_z=220,
                mmu_slots=5,
                extruder_colours=["#1E293B", "#F8FAFC", "#00A7D9", "#F97316", "#10B981"],
                max_accel_xy="4000",
                max_speed_xy="250",
                retraction_length="0.7",
                retraction_speed="35",
                start_gcode=prusa_start,
                end_gcode=prusa_end,
            ),
        ),
        (
            "Prusa CORE One + MMU3",
            ProfileKind.MACHINE.value,
            "prusa_coreone_mmu3.json",
            "PrusaLink CORE One enclosed with 5-slot MMU3",
            _build_machine_profile(
                name="Prusa CORE One + MMU3",
                gcode_flavor="marlin2",
                bed_x=250,
                bed_y=220,
                bed_z=270,
                mmu_slots=5,
                extruder_colours=["#00A7D9", "#1E293B", "#F8FAFC", "#F97316", "#10B981"],
                max_accel_xy="7000",
                max_speed_xy="300",
                retraction_length="0.7",
                retraction_speed="35",
                start_gcode=prusa_start,
                end_gcode=prusa_end,
            ),
        ),
        (
            "Prusa MK3.5",
            ProfileKind.MACHINE.value,
            "prusa_mk35.json",
            "PrusaLink MK3.5 single extruder profile",
            _build_machine_profile(
                name="Prusa MK3.5",
                gcode_flavor="marlin2",
                bed_x=250,
                bed_y=210,
                bed_z=210,
                mmu_slots=1,
                extruder_colours=["#00A7D9"],
                max_accel_xy="4000",
                max_speed_xy="220",
                retraction_length="0.8",
                retraction_speed="35",
                start_gcode=prusa_start,
                end_gcode=prusa_end,
            ),
        ),
        (
            "0.20mm Standard @Print-Web",
            ProfileKind.PROCESS.value,
            "printweb_020_standard.json",
            "Optimal FabLab process profile: 0.20mm layer, 3 walls, 20% gyroid, organic tree supports, no prime tower",
            _build_process_profile(
                name="0.20mm Standard @Print-Web",
                sparse_infill_density="20%",
                outer_wall_speed="140",
                inner_wall_speed="180",
                sparse_infill_speed="200",
                internal_solid_infill_speed="200",
                top_surface_speed="150",
                travel_speed="350",
                default_acceleration="6000",
            ),
        ),
        (
            "0.20mm Structural PETG @Print-Web",
            ProfileKind.PROCESS.value,
            "printweb_020_petg.json",
            "Tuned PETG process profile with moderated speeds, 25% gyroid, and organic tree supports",
            _build_process_profile(
                name="0.20mm Structural PETG @Print-Web",
                sparse_infill_density="25%",
                outer_wall_speed="90",
                inner_wall_speed="120",
                sparse_infill_speed="140",
                internal_solid_infill_speed="140",
                top_surface_speed="100",
                travel_speed="300",
                default_acceleration="4000",
            ),
        ),
        (
            "Print-Web Generic PLA",
            ProfileKind.FILAMENT.value,
            "printweb_generic_pla.json",
            "210C nozzle / 60C textured PEI bed",
            _build_filament_profile(
                name="Print-Web Generic PLA",
                filament_type="PLA",
                density="1.24",
                nozzle_temp="210",
                nozzle_temp_initial="215",
                bed_temp="60",
                temp_low="195",
                temp_high="225",
                max_volumetric_speed="15",
                fan_min="100",
                fan_max="100",
                overhang_fan="100",
                close_fan_layers="1",
                slow_down_layer_time="8",
                temp_vitrification="60",
            ),
        ),
        (
            "Print-Web Generic PETG",
            ProfileKind.FILAMENT.value,
            "printweb_generic_petg.json",
            "245C nozzle / 80C textured PEI bed",
            _build_filament_profile(
                name="Print-Web Generic PETG",
                filament_type="PETG",
                density="1.27",
                nozzle_temp="245",
                nozzle_temp_initial="250",
                bed_temp="80",
                temp_low="230",
                temp_high="260",
                max_volumetric_speed="12",
                fan_min="30",
                fan_max="60",
                overhang_fan="80",
                close_fan_layers="3",
                slow_down_layer_time="10",
                temp_vitrification="80",
            ),
        ),
    ]


def _ensure_profile_file(filename: str, payload: dict) -> Path:
    settings.ensure_directories()
    path = settings.profiles_dir / filename
    should_write = not path.exists()
    if not should_write:
        try:
            existing = json.loads(path.read_text(encoding="utf-8-sig"))
            if not isinstance(existing, dict) or len(existing) < 15 or not existing.get("from"):
                should_write = True
        except Exception:
            should_write = True
    if should_write:
        path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    return path


def seed_database(db: Session) -> None:
    """Ensure SystemSettings exists, bootstrap optional admin/dev data cleanly."""
    detected_cli = detect_orca_cli_path(settings.orca_cli_path_override)
    if settings.dev_seed:
        default_mode = settings.slicer_mode_override or ("orcaslicer" if detected_cli else "mock")
        default_fdm_mode = settings.default_fdm_monster_mode if settings.default_fdm_monster_mode else "mock"
    else:
        default_mode = "orcaslicer"
        default_fdm_mode = "live"
    default_cli = detected_cli or settings.default_orca_cli_path or "orca-slicer"

    admin_exists = db.scalar(select(User.id).where(User.role == "admin").limit(1)) is not None
    will_seed_admin = bool(settings.dev_seed or settings.admin_password.strip())

    sys_settings = db.get(SystemSettings, 1)
    if sys_settings is None:
        sys_settings = SystemSettings(
            id=1,
            slicer_mode=default_mode,
            fdm_monster_mode=default_fdm_mode,
            fdm_monster_url=settings.default_fdm_monster_url,
            orca_cli_path=default_cli,
            setup_completed=bool(admin_exists or will_seed_admin),
        )
        db.add(sys_settings)
        db.commit()
    else:
        dirty = False
        if not settings.dev_seed:
            if sys_settings.slicer_mode == "mock":
                sys_settings.slicer_mode = "orcaslicer"
                dirty = True
            if sys_settings.fdm_monster_mode == "mock":
                sys_settings.fdm_monster_mode = "live"
                dirty = True
            if detected_cli and sys_settings.orca_cli_path == "orca-slicer":
                sys_settings.orca_cli_path = detected_cli
                dirty = True
        elif settings.slicer_mode_override:
            if sys_settings.slicer_mode != settings.slicer_mode_override:
                sys_settings.slicer_mode = settings.slicer_mode_override
                dirty = True
        elif (
            detected_cli
            and sys_settings.slicer_mode == "mock"
            and sys_settings.orca_cli_path == "orca-slicer"
        ):
            sys_settings.slicer_mode = "orcaslicer"
            sys_settings.orca_cli_path = detected_cli
            dirty = True
        if (admin_exists or will_seed_admin) and not sys_settings.setup_completed:
            sys_settings.setup_completed = True
            dirty = True
        if dirty:
            db.commit()

    # In production (DEV_SEED=false), bootstrap the initial Main Admin if ADMIN_PASSWORD is set
    # and no admin account exists yet.
    if settings.admin_password.strip():
        if not admin_exists:
            admin_da = settings.admin_username.strip().lower() or "admin"
            if db.scalar(select(User.id).where(User.da == admin_da).limit(1)) is None:
                db.add(
                    User(
                        da=admin_da,
                        name=settings.admin_name.strip() or "Admin FabLab",
                        password_hash=hash_password(settings.admin_password.strip()),
                        role="admin",
                        hierarchy_rank=100,
                        approval_status="approved",
                        is_active=True,
                    )
                )
                sys_settings.setup_completed = True
                db.commit()

    if not settings.dev_seed:
        return

    # 1. Seed Main Admin, Demo Student, and 2 Demo Teachers
    admin_user = db.scalar(select(User).where(User.da == "admin"))
    if admin_user is None:
        admin_user = User(
            da="admin",
            name="Admin FabLab",
            password_hash=hash_password("admin123"),
            role="admin",
            hierarchy_rank=100,
            approval_status="approved",
            is_active=True,
        )
        db.add(admin_user)

    demo_student = db.scalar(select(User).where(User.da == "2345678"))
    if demo_student is None:
        demo_student = User(
            da="2345678",
            name="Étudiant Démo",
            password_hash=hash_password("student123"),
            role="student",
            hierarchy_rank=0,
            approval_status="approved",
            is_active=True,
        )
        db.add(demo_student)

    teacher_specs = [
        (
            "m.tremblay@example.edu",
            "Marc Tremblay",
            "teacher123",
            [
                (
                    "3DP-101 — Conception 3D (Gr. 01)",
                    "3DP-101",
                    [
                        ("2345678", "Étudiant Démo"),
                        ("2333572", "Gabriel"),
                        ("2399001", "Camille"),
                    ],
                ),
                (
                    "3DP-204 — Robotique (Gr. 02)",
                    "3DP-204",
                    [
                        ("2401234", "Lucas"),
                    ],
                ),
            ],
        ),
        (
            "s.gagnon@example.edu",
            "Sophie Gagnon",
            "teacher123",
            [
                (
                    "ELEC-112 — Électronique (Gr. 01)",
                    "ELEC-112",
                    [
                        ("2345678", "Étudiant Démo"),
                        ("2405555", "Alex"),
                    ],
                ),
            ],
        ),
    ]

    teachers_by_da: dict[str, User] = {}
    for t_da, t_name, t_pw, _classes in teacher_specs:
        t_user = db.scalar(select(User).where(User.da == t_da))
        if t_user is None:
            t_user = User(
                da=t_da,
                name=t_name,
                password_hash=hash_password(t_pw),
                role="teacher",
                hierarchy_rank=50,
                approval_status="approved",
                is_active=True,
            )
            db.add(t_user)
        teachers_by_da[t_da] = t_user
    db.commit()

    # 2. Seed Teacher Classes & Class Enrollments (leave 2333572 unclaimed in users)
    for t_da, _t_name, _t_pw, classes_spec in teacher_specs:
        t_user = teachers_by_da[t_da]
        db.refresh(t_user)
        for c_name, c_code, enrollments in classes_spec:
            tc = db.scalar(
                select(TeacherClass).where(
                    TeacherClass.teacher_id == t_user.id,
                    TeacherClass.name == c_name,
                )
            )
            if tc is None:
                tc = TeacherClass(
                    teacher_id=t_user.id,
                    name=c_name,
                    code=c_code,
                    is_default_individual=False,
                )
                db.add(tc)
                db.flush()
            for e_da, e_name in enrollments:
                existing_enrollment = db.scalar(
                    select(ClassEnrollment).where(
                        ClassEnrollment.class_id == tc.id,
                        ClassEnrollment.da == e_da,
                    )
                )
                if existing_enrollment is None:
                    db.add(
                        ClassEnrollment(
                            class_id=tc.id,
                            da=e_da,
                            suggested_name=e_name,
                        )
                    )
    db.commit()

    # Migrate any orphan legacy DAWhitelist rows into a default class under the first teacher
    legacy_entries = list(db.scalars(select(DAWhitelist)))
    if legacy_entries:
        enrolled_das = set(db.scalars(select(ClassEnrollment.da)))
        orphan_entries = [wl for wl in legacy_entries if wl.da not in enrolled_das]
        if orphan_entries:
            first_teacher = teachers_by_da.get("m.tremblay@example.edu")
            if first_teacher is not None:
                default_cls = db.scalar(
                    select(TeacherClass).where(
                        TeacherClass.teacher_id == first_teacher.id,
                        TeacherClass.is_default_individual == True,  # noqa: E712
                    )
                )
                if default_cls is None:
                    default_cls = TeacherClass(
                        teacher_id=first_teacher.id,
                        name="Registre importé",
                        code=None,
                        is_default_individual=True,
                    )
                    db.add(default_cls)
                    db.flush()
                for wl in orphan_entries:
                    db.add(
                        ClassEnrollment(
                            class_id=default_cls.id,
                            da=wl.da,
                            suggested_name=wl.suggested_name,
                            max_active_grams_override=wl.max_active_grams_override,
                            max_print_minutes_override=wl.max_print_minutes_override,
                        )
                    )
                db.commit()

    # 3. Seed or upgrade OrcaSlicer JSON profiles
    profile_specs = _get_seeded_profile_specs()
    if db.scalar(select(OrcaProfile.id).limit(1)) is None:
        for name, kind, fname, notes, payload in profile_specs:
            fpath = _ensure_profile_file(fname, payload)
            db.add(
                OrcaProfile(
                    name=name,
                    kind=kind,
                    filename=fname,
                    file_path=str(fpath),
                    notes=notes,
                )
            )
        db.commit()
    else:
        existing_profiles = {p.name: p for p in db.scalars(select(OrcaProfile))}
        updated_paths = False
        for name, _kind, fname, _notes, payload in profile_specs:
            prof = existing_profiles.get(name)
            if prof is not None and prof.filename == fname:
                fpath = _ensure_profile_file(fname, payload)
                if prof.file_path != str(fpath):
                    prof.file_path = str(fpath)
                    updated_paths = True
        if updated_paths:
            db.commit()

    profiles_by_name = {p.name: p for p in db.scalars(select(OrcaProfile))}

    # 4. Seed 5 Filaments if none exist yet
    if db.scalar(select(Filament.id).limit(1)) is None:
        pla_prof = profiles_by_name.get("Print-Web Generic PLA")
        petg_prof = profiles_by_name.get("Print-Web Generic PETG")
        petg_proc = profiles_by_name.get("0.20mm Structural PETG @Print-Web")

        filament_specs = [
            ("PLA Noir", "PLA", "#1E293B", 1.24, pla_prof, None),
            ("PLA Blanc", "PLA", "#F8FAFC", 1.24, pla_prof, None),
            ("PLA Bleu Print-Web", "PLA", "#00A7D9", 1.24, pla_prof, None),
            ("PETG Orange", "PETG", "#F97316", 1.27, petg_prof, petg_proc),
            ("PLA Vert", "PLA", "#10B981", 1.24, pla_prof, None),
        ]
        for name, mat, color_hex, density, f_prof, p_ovr in filament_specs:
            db.add(
                Filament(
                    name=name,
                    material=mat,
                    color_hex=color_hex,
                    density_g_cm3=density,
                    filament_profile_id=f_prof.id if f_prof else None,
                    process_override_profile_id=p_ovr.id if p_ovr else None,
                    is_active=True,
                )
            )
        db.commit()

    filaments_by_name = {f.name: f for f in db.scalars(select(Filament))}
    pla_noir = filaments_by_name.get("PLA Noir")
    pla_blanc = filaments_by_name.get("PLA Blanc")
    pla_bleu = filaments_by_name.get("PLA Bleu Print-Web")
    petg_orange = filaments_by_name.get("PETG Orange")
    pla_vert = filaments_by_name.get("PLA Vert")

    std_proc = profiles_by_name.get("0.20mm Standard @Print-Web")

    # 5. Seed 2 Klipper + 3 PrusaLink Printers & MMU Slots if none exist yet
    if db.scalar(select(Printer.id).limit(1)) is None:
        printer_specs = [
            {
                "name": "Voron 2.4 — Klipper #1",
                "fdm_monster_id": "klipper-voron-1",
                "printer_type": PrinterType.KLIPPER.value,
                "bed": (300.0, 300.0, 300.0),
                "machine": profiles_by_name.get("Voron 2.4 300mm Klipper"),
                "slots": [
                    (1, "Slot 1 — BoxTurtle", pla_noir),
                    (2, "Slot 2 — BoxTurtle", pla_blanc),
                    (3, "Slot 3 — BoxTurtle", pla_bleu),
                    (4, "Slot 4 — BoxTurtle", pla_vert),
                ],
            },
            {
                "name": "RatRig V-Core — Klipper #2",
                "fdm_monster_id": "klipper-ratrig-1",
                "printer_type": PrinterType.KLIPPER.value,
                "bed": (300.0, 300.0, 300.0),
                "machine": profiles_by_name.get("RatRig V-Core 300mm Klipper"),
                "slots": [
                    (1, "Extrudeur Direct", petg_orange),
                ],
            },
            {
                "name": "Prusa MK4S + MMU3",
                "fdm_monster_id": "prusalink-mk4s-1",
                "printer_type": PrinterType.PRUSALINK.value,
                "bed": (250.0, 210.0, 220.0),
                "machine": profiles_by_name.get("Prusa MK4S + MMU3"),
                "slots": [
                    (1, "MMU3 Slot 1", pla_noir),
                    (2, "MMU3 Slot 2", pla_blanc),
                    (3, "MMU3 Slot 3", pla_bleu),
                    (4, "MMU3 Slot 4", petg_orange),
                    (5, "MMU3 Slot 5", pla_vert),
                ],
            },
            {
                "name": "Prusa CORE One + MMU3",
                "fdm_monster_id": "prusalink-coreone-1",
                "printer_type": PrinterType.PRUSALINK.value,
                "bed": (250.0, 220.0, 270.0),
                "machine": profiles_by_name.get("Prusa CORE One + MMU3"),
                "slots": [
                    (1, "MMU3 Slot 1", pla_bleu),
                    (2, "MMU3 Slot 2", pla_noir),
                    (3, "MMU3 Slot 3", pla_blanc),
                    (4, "MMU3 Slot 4", petg_orange),
                    (5, "MMU3 Slot 5", pla_vert),
                ],
            },
            {
                "name": "Prusa MK3.5",
                "fdm_monster_id": "prusalink-mk35-1",
                "printer_type": PrinterType.PRUSALINK.value,
                "bed": (250.0, 210.0, 210.0),
                "machine": profiles_by_name.get("Prusa MK3.5"),
                "slots": [
                    (1, "Extrudeur Simple", pla_bleu),
                ],
            },
        ]

        for spec in printer_specs:
            bx, by, bz = spec["bed"]
            slots = spec["slots"]
            machine_p = spec["machine"]
            printer = Printer(
                name=spec["name"],
                display_name=spec["name"],
                fdm_monster_id=spec["fdm_monster_id"],
                printer_type=spec["printer_type"],
                status=PrinterStatus.IDLE.value,
                queue_count=0,
                is_enabled=True,
                bed_x_mm=bx,
                bed_y_mm=by,
                bed_z_mm=bz,
                mmu_slots_count=len(slots),
                machine_profile_id=machine_p.id if machine_p else None,
                process_profile_id=std_proc.id if std_proc else None,
            )
            db.add(printer)
            db.flush()
            for slot_idx, label, fil in slots:
                db.add(
                    PrinterSlot(
                        printer_id=printer.id,
                        slot_index=slot_idx,
                        label=label,
                        filament_id=fil.id if fil else None,
                        is_loaded=True,
                    )
                )
        db.commit()
