# GGPrint — Frozen API Contract (v1)

Base URL in dev: `http://127.0.0.1:8000` (Vite proxies `/api` -> `http://127.0.0.1:8000` in dev; Nginx proxies `/api` in Docker).

## Authentication & Roles
- Bearer JWT in `Authorization: Bearer <token>`.
- Roles: `"student"` | `"admin"`.
- DA format: 7-digit string (e.g. `"2333572"`, admin `"0000001"`).

### Dev Seed Credentials (`DEV_SEED=true`)
- Admin: `da="0000001"`, `password="admin123"`
- Pre-registered Student: `da="2345678"`, `password="student123"`
- Whitelisted unclaimed DAs (ready for self-registration): `"2333572"`, `"2399001"`, `"2401234"`

## Enums
- `JobStatus`: `"DRAFT" | "SLICED" | "PENDING_APPROVAL" | "QUEUED" | "PRINTING" | "COMPLETED" | "CANCELLED" | "FAILED" | "REJECTED"`
- Active budget jobs: `PENDING_APPROVAL`, `QUEUED`, `PRINTING`
- `PrinterType`: `"klipper" | "prusalink"`
- `PrinterStatus`: `"idle" | "printing" | "offline" | "error"`
- `ProfileKind`: `"machine" | "process" | "filament"`

---

## 1. Auth Endpoints (`/api/auth`)

### `GET /api/auth/mode`
Public endpoint so Login page knows if dev hints should be shown.
Response `200`:
```json
{
  "dev_mode": true,
  "slicer_mode": "mock",
  "fdm_mode": "mock",
  "institution": "Cégep Gérald-Godin"
}
```

### `POST /api/auth/register`
Body:
```json
{ "da": "2333572", "name": "Gabriel", "password": "secret" }
```
Validations:
- `da` must exist in `da_whitelist` (`403` `DA_NOT_WHITELISTED` if missing)
- `da` must not already have a user (`409` `DA_ALREADY_REGISTERED` if claimed)
- `password` >= 4 chars
Response `201`: `{ "access_token": "...", "token_type": "bearer", "user": UserSummary }`

### `POST /api/auth/login`
Body: `{ "da": "2333572", "password": "secret" }`
Response `200`: `{ "access_token": "...", "token_type": "bearer", "user": UserSummary }`

### `GET /api/auth/me`
Response `200`: `UserSummary`:
```json
{
  "id": 1,
  "da": "2333572",
  "name": "Gabriel",
  "role": "student",
  "is_active": true,
  "effective_max_active_grams": 100.0,
  "active_grams_used": 24.5,
  "available_grams": 75.5,
  "enforce_duration_limit": true,
  "effective_max_print_minutes": 360
}
```

---

## 2. Student Printer & Sample Endpoints (`/api/printers`, `/api/samples`)

### `GET /api/printers`
Returns enabled printers with live status from FDM Monster adapter + loaded filament/MMU slots from DB.
Response `200`:
```json
[
  {
    "id": 1,
    "name": "Voron 2.4 — Klipper #1",
    "fdm_monster_id": "klipper-voron-1",
    "printer_type": "klipper",
    "status": "idle",
    "queue_count": 0,
    "bed_x_mm": 300,
    "bed_y_mm": 300,
    "bed_z_mm": 300,
    "mmu_slots_count": 4,
    "has_mmu": true,
    "slots": [
      {
        "id": 1,
        "slot_index": 1,
        "label": "Slot 1 — BoxTurtle",
        "filament_id": 1,
        "filament_name": "PLA Noir / Black",
        "material": "PLA",
        "color_hex": "#1E293B",
        "is_loaded": true
      }
    ]
  }
]
```

### `GET /api/samples`
Lists available sample STLs in `sample-models/` (e.g. tilted bracket & oversized housing).
Response `200`: `[{ "id": "tilted-bracket.stl", "name": "Support incliné / Tilted Bracket", "description": "..." }]`

### `GET /api/samples/{sample_id}`
Returns raw `.stl` binary file.

---

## 3. Jobs, 3D Placement & Slicing Endpoints (`/api/jobs`)

### `POST /api/jobs/upload`
Multipart form: `file` (`.stl`), `printer_id` (int), `slot_id` (int).
Server validates `.stl`, saves `original.stl`, runs auto-orient (`--orient 1 --ensure-on-bed`), computes bounding box centered on bed (`pos_x=0, pos_y=0`, `min_z=0`).
Response `201`: `JobDetail` (includes `oriented_mesh_url: "/api/jobs/{id}/mesh"`).

### `POST /api/jobs/{id}/reorient`
Re-runs server auto-orient on `original.stl`, resets transform to identity centered on bed.
Response `200`: `JobDetail`.

### `GET /api/jobs/{id}/mesh`
Streams the auto-oriented STL binary (authenticated owner or admin).

### `POST /api/jobs/{id}/slice`
Body (`TransformPayload` — zero slicing settings from student, except optional `supports_enabled` toggle):
```json
{
  "printer_id": 1,
  "slot_id": 2,
  "pos_x_mm": 0.0,
  "pos_y_mm": 0.0,
  "quat_x": 0.0,
  "quat_y": 0.0,
  "quat_z": 0.0,
  "quat_w": 1.0,
  "scale": 1.0,
  "supports_enabled": true
}
```
- `supports_enabled` (optional `bool`, default `true`): toggles Organic Tree Supports (build plate only).
Backend validates bed bounds (`400` `OUT_OF_BOUNDS` if rotated/scaled/moved bounding box falls outside `[-bed_x/2, +bed_x/2]`, `[-bed_y/2, +bed_y/2]`, `[0, bed_z]`), bakes transform, runs slicer (`--orient 0 --arrange 0` + admin's optimal machine/process/filament profiles for `(printer_id, slot_id)`), and returns updated `JobDetail` with:
- `status: "SLICED"`
- `estimated_grams`, `estimated_minutes`, `layer_count`, `supports_enabled`, `gcode_filename`
- `budget_check`: `{ "within_grams": true, "within_duration": true, "can_auto_submit": true, "exceeds_grams_by": 0, "exceeds_minutes_by": 0 }`

### `POST /api/jobs/{id}/submit`
Submits a `SLICED` job.
- Checks active budget + duration limit atomically in DB transaction.
- If `within_grams && within_duration`: pushes to FDM Monster queue -> sets status `QUEUED` (or `PRINTING` if adapter starts immediately).
- If over either limit -> `409` `LIMIT_EXCEEDED` (must use `/request-approval`).
Response `200`: `JobDetail`.

### `POST /api/jobs/{id}/request-approval`
Body: `{ "note": "Projet cours génie mécanique" }`
Sets status `PENDING_APPROVAL` (reserves `estimated_grams` in active budget) and notifies Admin Approvals tab.
Response `200`: `JobDetail`.

### `GET /api/jobs/mine`
Returns current user's jobs newest-first (`JobDetail[]`) plus latest `UserSummary` budget fields (`{ "user": UserSummary, "jobs": JobDetail[] }`).

### `POST /api/jobs/{id}/cancel`
Owner or admin can cancel `PENDING_APPROVAL`, `QUEUED`, or `PRINTING` jobs -> calls FDM Monster cancel if queued/printing -> sets `CANCELLED` -> frees active grams.
Response `200`: `JobDetail`.

### `POST /api/jobs/{id}/dev-complete`
Available only when `fdm_mode == "mock"`: simulates printer finishing the job (`COMPLETED`) so user can test the auto-refund loop in 1 click!
Response `200`: `JobDetail`.

---

## 4. Admin Endpoints (`/api/admin`, requires `role == "admin"`)

### Printers & MMU Slots
- `GET /api/admin/printers` — all printers + slots + profile bindings + FDM Monster status
- `POST /api/admin/printers/sync` — pulls printers from FDM Monster adapter and upserts them
- `PATCH /api/admin/printers/{id}` — update `is_enabled`, `display_name`, `bed_x_mm`, `bed_y_mm`, `bed_z_mm`, `mmu_slots_count`, `machine_profile_id`, `process_profile_id`
- `PUT /api/admin/printers/{id}/slots/{slot_index}` — `{ "filament_id": 2, "label": "Slot 2", "is_loaded": true }`

### Filaments & OrcaSlicer Profiles
- `GET /api/admin/filaments`
- `POST /api/admin/filaments` — `{ "name", "material", "color_hex", "density_g_cm3", "filament_profile_id", "process_override_profile_id" }`
- `PATCH /api/admin/filaments/{id}`
- `DELETE /api/admin/filaments/{id}`
- `GET /api/admin/profiles` — lists uploaded `machine` / `process` / `filament` Orca JSON profiles
- `POST /api/admin/profiles` — multipart `file` (`.json`), `name`, `kind` (`machine|process|filament`), `notes`
- `DELETE /api/admin/profiles/{id}`
- `POST /api/admin/profiles/test-slice` — `{ "printer_id": 1, "slot_id": 1 }` -> runs a 20mm calibration cube through the configured slicer adapter and returns `{ "ok": true, "estimated_grams": ..., "estimated_minutes": ..., "command_preview": "..." }`

### Students & DA Whitelist
- `GET /api/admin/whitelist`
- `POST /api/admin/whitelist` — `{ "da": "2399999", "suggested_name": "...", "max_active_grams_override": null, "max_print_minutes_override": null }`
- `POST /api/admin/whitelist/csv` — multipart CSV file (`da,name,max_active_grams,max_print_minutes`) -> returns `{ "added": N, "skipped": M }`
- `DELETE /api/admin/whitelist/{da}`
- `GET /api/admin/students` — all registered users with `active_grams_used`, `effective_max_active_grams`, `effective_max_print_minutes`, total jobs
- `PATCH /api/admin/students/{user_id}` — `{ "is_active"?, "max_active_grams_override"?, "max_print_minutes_override"? }` (explicit `null` clears override back to global default)
- `POST /api/admin/students/{user_id}/reset-password` — `{ "new_password"?: "..." }` -> if omitted, generates a clean 8-char temp password and returns `{ "da": "...", "temp_password": "..." }`

### Oversized Approval Requests
- `GET /api/admin/approvals` — jobs in `PENDING_APPROVAL` (plus recent history)
- `POST /api/admin/approvals/{job_id}/decision`
  Body:
  ```json
  {
    "decision": "approve_once" | "approve_and_raise" | "reject",
    "new_max_active_grams": 250.0,
    "new_max_print_minutes": 600,
    "admin_note": "Approuvé pour projet final"
  }
  ```

### Global Settings (Highly Configurable Limits & Integrations)
- `GET /api/admin/settings`
- `PATCH /api/admin/settings`:
  - `default_max_active_grams` (float, e.g. `100.0`)
  - `enforce_duration_limit` (bool, e.g. `true`)
  - `default_max_print_minutes` (int, e.g. `360`)
  - `allow_multiple_jobs_within_budget` (bool, e.g. `true`)
  - `max_upload_mb` (int, e.g. `50`)
  - `fdm_monster_mode` (`"mock" | "live"`)
  - `fdm_monster_url` (string)
  - `fdm_monster_api_key` (string, masked on GET)
  - `slicer_mode` (`"mock" | "orcaslicer"`)
  - `orca_cli_path` (string)
