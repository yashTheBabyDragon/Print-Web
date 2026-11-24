"""Idempotent initial database seeding for GGPrint."""

from __future__ import annotations

import json
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth import hash_password
from app.config import settings
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


def _ensure_profile_file(filename: str, payload: dict) -> Path:
    settings.ensure_directories()
    path = settings.profiles_dir / filename
    if not path.exists():
        path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    return path


def seed_database(db: Session) -> None:
    """Ensure SystemSettings exists and seed dev demo data when DEV_SEED=true."""
    sys_settings = db.get(SystemSettings, 1)
    if sys_settings is None:
        sys_settings = SystemSettings(id=1)
        db.add(sys_settings)
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
            approval_status="approved",
            is_active=True,
        )
        db.add(demo_student)

    teacher_specs = [
        (
            "m.tremblay@cgodin.qc.ca",
            "Marc Tremblay",
            "teacher123",
            [
                (
                    "241-101-GG — Conception 3D (Gr. 01)",
                    "241-101-GG",
                    [
                        ("2345678", "Étudiant Démo"),
                        ("2333572", "Gabriel"),
                        ("2399001", "Camille"),
                    ],
                ),
                (
                    "241-204-GG — Robotique (Gr. 02)",
                    "241-204-GG",
                    [
                        ("2401234", "Lucas"),
                    ],
                ),
            ],
        ),
        (
            "s.gagnon@cgodin.qc.ca",
            "Sophie Gagnon",
            "teacher123",
            [
                (
                    "243-112-GG — Électronique (Gr. 01)",
                    "243-112-GG",
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
            first_teacher = teachers_by_da.get("m.tremblay@cgodin.qc.ca")
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

    # 3. Seed OrcaSlicer JSON profiles if none exist yet
    if db.scalar(select(OrcaProfile.id).limit(1)) is None:
        profile_specs = [
            (
                "Voron 2.4 300mm Klipper",
                ProfileKind.MACHINE.value,
                "voron_24_300_klipper.json",
                "Default Klipper Voron 2.4 + BoxTurtle 4-lane MMU machine profile",
                {
                    "type": "machine",
                    "name": "Voron 2.4 300mm Klipper",
                    "gcode_flavor": "klipper",
                    "printable_area": ["0x0", "300x0", "300x300", "0x300"],
                    "printable_height": "300",
                    "nozzle_diameter": ["0.4"],
                },
            ),
            (
                "RatRig V-Core 300mm Klipper",
                ProfileKind.MACHINE.value,
                "ratrig_vcore_300_klipper.json",
                "Default Klipper RatRig V-Core single extruder profile",
                {
                    "type": "machine",
                    "name": "RatRig V-Core 300mm Klipper",
                    "gcode_flavor": "klipper",
                    "printable_area": ["0x0", "300x0", "300x300", "0x300"],
                    "printable_height": "300",
                    "nozzle_diameter": ["0.4"],
                },
            ),
            (
                "Prusa MK4S + MMU3",
                ProfileKind.MACHINE.value,
                "prusa_mk4s_mmu3.json",
                "PrusaLink MK4S with 5-slot MMU3 machine profile",
                {
                    "type": "machine",
                    "name": "Prusa MK4S + MMU3",
                    "gcode_flavor": "marlin2",
                    "printable_area": ["0x0", "250x0", "250x210", "0x210"],
                    "printable_height": "220",
                    "nozzle_diameter": ["0.4"],
                },
            ),
            (
                "Prusa CORE One + MMU3",
                ProfileKind.MACHINE.value,
                "prusa_coreone_mmu3.json",
                "PrusaLink CORE One enclosed with 5-slot MMU3",
                {
                    "type": "machine",
                    "name": "Prusa CORE One + MMU3",
                    "gcode_flavor": "marlin2",
                    "printable_area": ["0x0", "250x0", "250x220", "0x220"],
                    "printable_height": "270",
                    "nozzle_diameter": ["0.4"],
                },
            ),
            (
                "Prusa MK3.5",
                ProfileKind.MACHINE.value,
                "prusa_mk35.json",
                "PrusaLink MK3.5 single extruder profile",
                {
                    "type": "machine",
                    "name": "Prusa MK3.5",
                    "gcode_flavor": "marlin2",
                    "printable_area": ["0x0", "250x0", "250x210", "0x210"],
                    "printable_height": "210",
                    "nozzle_diameter": ["0.4"],
                },
            ),
            (
                "0.20mm Standard @GGPrint",
                ProfileKind.PROCESS.value,
                "ggprint_020_standard.json",
                "Optimal FabLab process profile: 0.20mm layer, 3 walls, 20% gyroid, tree supports, no prime tower",
                {
                    "type": "process",
                    "name": "0.20mm Standard @GGPrint",
                    "layer_height": "0.20",
                    "wall_loops": "3",
                    "sparse_infill_density": "20%",
                    "sparse_infill_pattern": "gyroid",
                    "enable_support": "1",
                    "support_type": "tree(auto)",
                    "enable_prime_tower": "0",
                },
            ),
            (
                "0.20mm Structural PETG @GGPrint",
                ProfileKind.PROCESS.value,
                "ggprint_020_petg.json",
                "Tuned PETG process profile with moderated speeds and auto supports",
                {
                    "type": "process",
                    "name": "0.20mm Structural PETG @GGPrint",
                    "layer_height": "0.20",
                    "wall_loops": "3",
                    "sparse_infill_density": "25%",
                    "enable_support": "1",
                    "enable_prime_tower": "0",
                },
            ),
            (
                "GGPrint Generic PLA",
                ProfileKind.FILAMENT.value,
                "ggprint_generic_pla.json",
                "210C nozzle / 60C textured PEI bed",
                {
                    "type": "filament",
                    "name": "GGPrint Generic PLA",
                    "filament_type": ["PLA"],
                    "filament_density": ["1.24"],
                    "nozzle_temperature": ["210"],
                    "hot_plate_temp": ["60"],
                },
            ),
            (
                "GGPrint Generic PETG",
                ProfileKind.FILAMENT.value,
                "ggprint_generic_petg.json",
                "245C nozzle / 80C textured PEI bed",
                {
                    "type": "filament",
                    "name": "GGPrint Generic PETG",
                    "filament_type": ["PETG"],
                    "filament_density": ["1.27"],
                    "nozzle_temperature": ["245"],
                    "hot_plate_temp": ["80"],
                },
            ),
        ]
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

    profiles_by_name = {p.name: p for p in db.scalars(select(OrcaProfile))}

    # 4. Seed 5 Filaments if none exist yet
    if db.scalar(select(Filament.id).limit(1)) is None:
        pla_prof = profiles_by_name.get("GGPrint Generic PLA")
        petg_prof = profiles_by_name.get("GGPrint Generic PETG")
        petg_proc = profiles_by_name.get("0.20mm Structural PETG @GGPrint")

        filament_specs = [
            ("PLA Noir", "PLA", "#1E293B", 1.24, pla_prof, None),
            ("PLA Blanc", "PLA", "#F8FAFC", 1.24, pla_prof, None),
            ("PLA Bleu Gérald-Godin", "PLA", "#00A7D9", 1.24, pla_prof, None),
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
    pla_bleu = filaments_by_name.get("PLA Bleu Gérald-Godin")
    petg_orange = filaments_by_name.get("PETG Orange")
    pla_vert = filaments_by_name.get("PLA Vert")

    std_proc = profiles_by_name.get("0.20mm Standard @GGPrint")

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
