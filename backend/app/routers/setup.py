"""First-run setup wizard and system connectivity test routes (/api/setup)."""

from __future__ import annotations

import hashlib
import hmac
import re
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Query, status
from fastapi.security import HTTPAuthorizationCredentials
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth import bearer_scheme, create_access_token, get_current_user, hash_password
from app.config import detect_orca_cli_path, settings
from app.database import get_db
from app.models import SystemSettings, User
from app.schemas import (
    AuthTokenResponse,
    SetupCompleteRequest,
    SetupStatusOut,
    SetupTestFdmOut,
    SetupTestFdmRequest,
    SetupTestOrcaOut,
    SetupTestOrcaRequest,
)
from app.services.budget import build_user_summary, get_system_settings
from app.services.fdm_monster import FdmMonsterError, LiveFdmMonsterAdapter
from app.services.slicer import validate_orca_cli_path

router = APIRouter(prefix="/api/setup", tags=["setup"])


def has_any_admin(db: Session) -> bool:
    """Return True if at least one administrator account exists."""
    return db.scalar(select(User.id).where(User.role == "admin").limit(1)) is not None


def hash_setup_token(token: str) -> str:
    """Return SHA-256 hex digest for a raw setup token."""
    return hashlib.sha256(token.strip().encode("utf-8")).hexdigest()


def is_setup_token_valid(sys_settings: SystemSettings, token: Optional[str]) -> bool:
    """Verify a setup token against the stored SHA-256 hash and UTC expiry."""
    if not token or not token.strip() or not sys_settings.setup_token_hash:
        return False
    expires_at = sys_settings.setup_token_expires_at
    if expires_at is None:
        return False
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    if expires_at <= datetime.now(timezone.utc):
        return False
    return hmac.compare_digest(hash_setup_token(token), sys_settings.setup_token_hash)


def probe_orca_cli(cli_path: Optional[str] = None) -> tuple[bool, Optional[str], Optional[str], str]:
    """Probe an OrcaSlicer CLI executable and return (ok, resolved_path, version, detail)."""
    raw = (cli_path or "").strip()
    if raw:
        try:
            validate_orca_cli_path(raw)
        except ValueError as exc:
            return False, None, None, str(exc)
        raw_path = Path(raw)
        if raw_path.is_file():
            resolved = str(raw_path)
        elif "/" not in raw and "\\" not in raw:
            resolved = shutil.which(raw) or detect_orca_cli_path(raw)
        else:
            resolved = None
    else:
        resolved = detect_orca_cli_path()

    if not resolved:
        return False, None, None, f"OrcaSlicer executable not found ({raw or 'auto-detect'})"

    version: Optional[str] = None
    last_detail = ""
    for flag in ("--version", "--help"):
        try:
            proc = subprocess.run(
                [resolved, flag],
                capture_output=True,
                text=True,
                timeout=15,
            )
            combined = "\n".join(part for part in (proc.stdout, proc.stderr) if part).strip()
            match = re.search(
                r"(?:OrcaSlicer|orca-slicer|version)[^\r\n]*?\bv?([0-9]+\.[0-9]+\.[0-9]+(?:\.[0-9]+)?)",
                combined,
                re.IGNORECASE,
            )
            if match:
                version = match.group(1)
            if proc.returncode == 0:
                return True, resolved, version, f"OrcaSlicer CLI ready ({version or flag})"
            last_detail = combined[:300] or f"Exited with status {proc.returncode}"
        except FileNotFoundError:
            return False, resolved, None, f"OrcaSlicer executable not found at '{resolved}'"
        except subprocess.TimeoutExpired:
            last_detail = f"Timed out running {resolved} {flag}"
        except OSError as exc:
            return False, resolved, None, f"Failed to execute '{resolved}': {exc}"

    return False, resolved, version, last_detail or "OrcaSlicer CLI probe failed"


def _ensure_setup_test_authorized(
    db: Session,
    sys_settings: SystemSettings,
    token: Optional[str],
    credentials: Optional[HTTPAuthorizationCredentials],
) -> None:
    """Allow setup test probes when setup is open (no admin or valid token) or by super admin."""
    if not has_any_admin(db) or is_setup_token_valid(sys_settings, token):
        return
    if credentials is not None and credentials.credentials:
        user = get_current_user(credentials=credentials, db=db)
        if user.role == "admin":
            return
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"code": "SUPER_ADMIN_REQUIRED", "message": "Main administrator privileges required"},
        )
    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail={
            "code": "SETUP_LOCKED",
            "message": "Setup wizard is locked. Run 'print-web-cli trigger-setup' or sign in as administrator.",
        },
    )


@router.get("/status", response_model=SetupStatusOut)
def get_setup_status(
    token: Optional[str] = Query(default=None),
    x_setup_token: Optional[str] = Header(default=None, alias="X-Setup-Token"),
    db: Session = Depends(get_db),
) -> SetupStatusOut:
    """Return setup wizard state, suggested OrcaSlicer path, and safe non-secret settings."""
    sys_settings = get_system_settings(db)
    has_admin = has_any_admin(db)
    token_valid = is_setup_token_valid(sys_settings, token or x_setup_token)
    needs_setup = (not has_admin) or token_valid
    suggested_orca = detect_orca_cli_path(sys_settings.orca_cli_path) or sys_settings.orca_cli_path or "orca-slicer"

    return SetupStatusOut(
        needs_setup=needs_setup,
        has_admin=has_admin,
        token_valid=token_valid,
        setup_completed=bool(sys_settings.setup_completed),
        dev_mode=settings.dev_seed,
        institution=settings.institution,
        suggested_orca_path=suggested_orca,
        current_settings={
            "slicer_mode": sys_settings.slicer_mode if settings.dev_seed else "orcaslicer",
            "orca_cli_path": sys_settings.orca_cli_path,
            "max_concurrent_slices": sys_settings.max_concurrent_slices,
            "fdm_monster_mode": sys_settings.fdm_monster_mode if settings.dev_seed else "live",
            "fdm_monster_url": sys_settings.fdm_monster_url,
            "has_fdm_monster_api_key": bool(sys_settings.fdm_monster_api_key),
            "default_max_active_grams": sys_settings.default_max_active_grams,
            "default_max_print_minutes": sys_settings.default_max_print_minutes,
        },
    )


@router.post("/test-orcaslicer", response_model=SetupTestOrcaOut)
def setup_test_orcaslicer(
    body: SetupTestOrcaRequest,
    token: Optional[str] = Query(default=None),
    x_setup_token: Optional[str] = Header(default=None, alias="X-Setup-Token"),
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(bearer_scheme),
    db: Session = Depends(get_db),
) -> SetupTestOrcaOut:
    """Probe the configured OrcaSlicer CLI binary during setup or as super admin."""
    sys_settings = get_system_settings(db)
    _ensure_setup_test_authorized(db, sys_settings, body.token or token or x_setup_token, credentials)
    ok, path, version, detail = probe_orca_cli(body.orca_cli_path or sys_settings.orca_cli_path)
    return SetupTestOrcaOut(ok=ok, path=path, version=version, detail=detail)


@router.post("/test-fdm", response_model=SetupTestFdmOut)
async def setup_test_fdm(
    body: SetupTestFdmRequest,
    token: Optional[str] = Query(default=None),
    x_setup_token: Optional[str] = Header(default=None, alias="X-Setup-Token"),
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(bearer_scheme),
    db: Session = Depends(get_db),
) -> SetupTestFdmOut:
    """Test live connectivity to an FDM Monster v2 instance during setup or as super admin."""
    sys_settings = get_system_settings(db)
    _ensure_setup_test_authorized(db, sys_settings, body.token or token or x_setup_token, credentials)

    url = body.fdm_monster_url.strip()
    if not (url.startswith("http://") or url.startswith("https://")):
        return SetupTestFdmOut(
            ok=False,
            printer_count=0,
            printers=[],
            detail="FDM Monster URL must start with http:// or https://",
        )

    if body.fdm_monster_api_key is not None and not body.fdm_monster_api_key.startswith("*"):
        api_key = body.fdm_monster_api_key.strip()
    else:
        api_key = sys_settings.fdm_monster_api_key or ""

    adapter = LiveFdmMonsterAdapter(base_url=url, api_key=api_key)
    try:
        printers = await adapter.list_printers()
    except FdmMonsterError as exc:
        return SetupTestFdmOut(ok=False, printer_count=0, printers=[], detail=str(exc))
    except Exception as exc:
        return SetupTestFdmOut(ok=False, printer_count=0, printers=[], detail=f"Connection failed: {exc}")

    serialized_printers = [
        {
            "fdm_monster_id": p.fdm_monster_id,
            "name": p.name,
            "printer_type": p.printer_type,
            "status": p.status,
            "queue_count": p.queue_count,
        }
        for p in printers
    ]
    return SetupTestFdmOut(
        ok=True,
        printer_count=len(serialized_printers),
        printers=serialized_printers,
        detail=f"Connected to FDM Monster ({len(serialized_printers)} printer(s) found)",
    )


@router.post("/complete", response_model=AuthTokenResponse)
def complete_setup(
    body: SetupCompleteRequest,
    token: Optional[str] = Query(default=None),
    x_setup_token: Optional[str] = Header(default=None, alias="X-Setup-Token"),
    db: Session = Depends(get_db),
) -> AuthTokenResponse:
    """Finalize initial setup or CLI-authorized reconfiguration and return an admin JWT."""
    sys_settings = get_system_settings(db)
    has_admin = has_any_admin(db)
    effective_token = body.token or token or x_setup_token
    token_valid = is_setup_token_valid(sys_settings, effective_token)

    if has_admin and not token_valid:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "code": "SETUP_LOCKED",
                "message": "Setup wizard is locked. Run 'print-web-cli trigger-setup' to authorize reconfiguration.",
            },
        )

    admin_user: Optional[User] = None
    if not has_admin:
        username = (body.admin_username or "").strip().lower()
        full_name = (body.admin_name or "").strip()
        password = body.admin_password or ""
        if len(username) < 2:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail={"code": "INVALID_ADMIN_USERNAME", "message": "Admin username must be at least 2 characters."},
            )
        if not full_name:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail={"code": "INVALID_ADMIN_NAME", "message": "Admin display name is required."},
            )
        if len(password) < 4:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail={"code": "INVALID_ADMIN_PASSWORD", "message": "Admin password must be at least 4 characters."},
            )
        existing_user = db.scalar(select(User).where(User.da == username))
        if existing_user is not None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail={"code": "USERNAME_TAKEN", "message": "An account with this username already exists."},
            )
        admin_user = User(
            da=username,
            name=full_name,
            password_hash=hash_password(password),
            role="admin",
            hierarchy_rank=100,
            approval_status="approved",
            is_active=True,
        )
        db.add(admin_user)
        db.flush()
    else:
        if body.admin_username and body.admin_username.strip():
            username = body.admin_username.strip().lower()
            existing = db.scalar(select(User).where(User.da == username))
            if existing is not None:
                if existing.role != "admin":
                    raise HTTPException(
                        status_code=status.HTTP_409_CONFLICT,
                        detail={"code": "USERNAME_TAKEN", "message": "Identifier belongs to a non-admin account."},
                    )
                if body.admin_name and body.admin_name.strip():
                    existing.name = body.admin_name.strip()
                if body.admin_password is not None and body.admin_password != "":
                    if len(body.admin_password) < 4:
                        raise HTTPException(
                            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                            detail={
                                "code": "INVALID_ADMIN_PASSWORD",
                                "message": "Admin password must be at least 4 characters.",
                            },
                        )
                    existing.password_hash = hash_password(body.admin_password)
                    existing.token_version = int(getattr(existing, "token_version", 0)) + 1
                existing.is_active = True
                existing.hierarchy_rank = 100
                admin_user = existing
            else:
                password = body.admin_password or ""
                if len(password) < 4:
                    raise HTTPException(
                        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                        detail={
                            "code": "INVALID_ADMIN_PASSWORD",
                            "message": "Password (>= 4 chars) is required when creating a new admin.",
                        },
                    )
                admin_user = User(
                    da=username,
                    name=(body.admin_name or username).strip(),
                    password_hash=hash_password(password),
                    role="admin",
                    hierarchy_rank=100,
                    approval_status="approved",
                    is_active=True,
                )
                db.add(admin_user)
                db.flush()
        elif body.admin_password:
            if len(body.admin_password) < 4:
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail={"code": "INVALID_ADMIN_PASSWORD", "message": "Admin password must be at least 4 characters."},
                )
            admin_user = db.scalar(select(User).where(User.role == "admin").order_by(User.id.asc()).limit(1))
            if admin_user is not None:
                admin_user.password_hash = hash_password(body.admin_password)
                admin_user.token_version = int(getattr(admin_user, "token_version", 0)) + 1

        if admin_user is None:
            admin_user = db.scalar(
                select(User)
                .where(User.role == "admin", User.is_active == True)  # noqa: E712
                .order_by(User.id.asc())
                .limit(1)
            ) or db.scalar(select(User).where(User.role == "admin").order_by(User.id.asc()).limit(1))

    if admin_user is None:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"code": "ADMIN_CREATION_FAILED", "message": "Could not resolve administrator account."},
        )

    if body.institution is not None and body.institution.strip():
        settings.institution = body.institution.strip()

    if body.slicer_mode is not None:
        if body.slicer_mode == "mock" and not settings.dev_seed:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail={
                    "code": "MOCK_MODE_DISABLED",
                    "message": "Mock slicer mode is only available in development environments.",
                },
            )
        sys_settings.slicer_mode = body.slicer_mode
    elif not settings.dev_seed:
        sys_settings.slicer_mode = "orcaslicer"

    if body.orca_cli_path is not None and body.orca_cli_path.strip():
        try:
            sys_settings.orca_cli_path = validate_orca_cli_path(body.orca_cli_path)
        except ValueError as exc:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail={"code": "INVALID_SLICER_PATH", "message": str(exc)},
            ) from exc

    if body.max_concurrent_slices is not None:
        sys_settings.max_concurrent_slices = body.max_concurrent_slices

    if body.fdm_monster_mode is not None:
        if body.fdm_monster_mode == "mock" and not settings.dev_seed:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail={
                    "code": "MOCK_MODE_DISABLED",
                    "message": "Mock FDM Monster mode is only available in development environments.",
                },
            )
        sys_settings.fdm_monster_mode = body.fdm_monster_mode
    elif not settings.dev_seed:
        sys_settings.fdm_monster_mode = "live"

    if body.fdm_monster_url is not None and body.fdm_monster_url.strip():
        sys_settings.fdm_monster_url = body.fdm_monster_url.strip()

    if body.fdm_monster_api_key is not None and not body.fdm_monster_api_key.startswith("*"):
        sys_settings.fdm_monster_api_key = body.fdm_monster_api_key.strip()

    if body.default_max_active_grams is not None:
        sys_settings.default_max_active_grams = body.default_max_active_grams
    if body.default_max_print_minutes is not None:
        sys_settings.default_max_print_minutes = body.default_max_print_minutes

    sys_settings.setup_completed = True
    sys_settings.setup_token_hash = None
    sys_settings.setup_token_expires_at = None

    db.commit()
    db.refresh(admin_user)
    db.refresh(sys_settings)

    try:
        from app.services.slice_queue import slice_queue

        slice_queue.set_max_workers(sys_settings.max_concurrent_slices)
    except Exception:
        pass

    access_token = create_access_token(admin_user)
    return AuthTokenResponse(
        access_token=access_token,
        user=build_user_summary(db, admin_user, sys_settings),
    )
