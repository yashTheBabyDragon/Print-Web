"""Operator CLI for GGPrint production setup, admin recovery, and health checks."""

from __future__ import annotations

import argparse
import asyncio
import getpass
import hashlib
import secrets
import sys
from datetime import datetime, timedelta, timezone
from typing import Optional

from sqlalchemy import func, select, text

from app import database
from app.auth import hash_password
from app.config import settings
from app.models import User
from app.routers.setup import probe_orca_cli
from app.services.budget import get_system_settings
from app.services.fdm_monster import FdmMonsterError, LiveFdmMonsterAdapter


def _cmd_create_admin(args: argparse.Namespace) -> int:
    username = args.username.strip().lower()
    if len(username) < 2:
        print("Error: --username must be at least 2 characters.", file=sys.stderr)
        return 1

    name = args.name.strip()
    if not name:
        print("Error: --name cannot be empty.", file=sys.stderr)
        return 1

    password = args.password
    if password is None:
        password = getpass.getpass("Password: ")
        confirm = getpass.getpass("Confirm password: ")
        if password != confirm:
            print("Error: Passwords do not match.", file=sys.stderr)
            return 1

    if len(password) < 4:
        print("Error: Password must be at least 4 characters.", file=sys.stderr)
        return 1

    database.init_db()
    with database.SessionLocal() as db:
        sys_settings = get_system_settings(db)
        existing = db.scalar(select(User).where(User.da == username))
        if existing is not None:
            if not args.reset:
                print(
                    f"Error: User '{username}' already exists. Pass --reset to update password.",
                    file=sys.stderr,
                )
                return 1
            if existing.role != "admin":
                print(
                    f"Error: User '{username}' exists with role '{existing.role}', not 'admin'.",
                    file=sys.stderr,
                )
                return 1
            existing.password_hash = hash_password(password)
            existing.name = name
            existing.hierarchy_rank = 100
            existing.is_active = True
            existing.approval_status = "approved"
            existing.token_version = int(getattr(existing, "token_version", 0)) + 1
            action = "updated"
        else:
            db.add(
                User(
                    da=username,
                    name=name,
                    password_hash=hash_password(password),
                    role="admin",
                    hierarchy_rank=100,
                    approval_status="approved",
                    is_active=True,
                )
            )
            action = "created"

        sys_settings.setup_completed = True
        db.commit()

    print(f"Main Admin '{username}' {action} successfully (setup_completed=True).")
    return 0


def _cmd_trigger_setup(args: argparse.Namespace) -> int:
    if args.ttl_minutes <= 0:
        print("Error: --ttl-minutes must be > 0.", file=sys.stderr)
        return 1

    database.init_db()
    raw_token = secrets.token_urlsafe(24)
    token_hash = hashlib.sha256(raw_token.encode("utf-8")).hexdigest()
    expires_at = datetime.now(timezone.utc) + timedelta(minutes=args.ttl_minutes)

    with database.SessionLocal() as db:
        sys_settings = get_system_settings(db)
        sys_settings.setup_token_hash = token_hash
        sys_settings.setup_token_expires_at = expires_at
        db.commit()

    base_url = args.base_url.rstrip("/")
    setup_url = f"{base_url}/setup?token={raw_token}"
    print(f"Setup token: {raw_token}")
    print(f"Expires at (UTC): {expires_at.isoformat()}")
    print(f"Setup URL: {setup_url}")
    return 0


def _cmd_check_health(_args: argparse.Namespace) -> int:
    db_ok = False
    admin_count = 0
    orca_path_cfg = settings.default_orca_cli_path
    fdm_mode = "live" if not settings.dev_seed else settings.default_fdm_monster_mode
    fdm_url = settings.default_fdm_monster_url
    fdm_key = ""

    try:
        database.init_db()
        with database.SessionLocal() as db:
            db.execute(text("SELECT 1"))
            db_ok = True
            admin_count = int(
                db.scalar(select(func.count(User.id)).where(User.role == "admin")) or 0
            )
            sys_settings = get_system_settings(db)
            orca_path_cfg = sys_settings.orca_cli_path
            fdm_mode = sys_settings.fdm_monster_mode if settings.dev_seed else "live"
            fdm_url = sys_settings.fdm_monster_url
            fdm_key = sys_settings.fdm_monster_api_key or ""
    except Exception as exc:
        print(f"Database: ERROR ({exc})")
        return 1

    print(f"Database: OK (admins={admin_count}, dev_seed={settings.dev_seed})")

    orca_ok, resolved_orca, orca_ver, orca_detail = probe_orca_cli(orca_path_cfg)
    print(
        f"OrcaSlicer: {'OK' if orca_ok else 'FAIL'} "
        f"(path={resolved_orca or orca_path_cfg}, version={orca_ver or 'unknown'}, detail={orca_detail})"
    )

    if fdm_mode == "mock":
        print("FDM Monster: OK (mock mode)")
    else:
        try:
            printers = asyncio.run(LiveFdmMonsterAdapter(fdm_url, fdm_key).list_printers())
            print(f"FDM Monster: OK ({len(printers)} printer(s) at {fdm_url})")
        except FdmMonsterError as exc:
            print(f"FDM Monster: FAIL ({exc})")
        except Exception as exc:
            print(f"FDM Monster: FAIL ({exc})")

    return 0 if db_ok else 1


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="ggprint-cli",
        description="GGPrint operator administration CLI",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_create = sub.add_parser("create-admin", help="Create or reset a Main Admin account")
    p_create.add_argument("--username", required=True, help="Admin login username or email")
    p_create.add_argument("--name", required=True, help="Admin display name")
    p_create.add_argument("--password", default=None, help="Admin password (prompted if omitted)")
    p_create.add_argument("--reset", action="store_true", help="Reset password if admin already exists")
    p_create.set_defaults(func=_cmd_create_admin)

    p_trigger = sub.add_parser("trigger-setup", help="Generate a time-limited setup wizard token")
    p_trigger.add_argument("--ttl-minutes", type=int, default=30, help="Token lifetime in minutes (default: 30)")
    p_trigger.add_argument(
        "--base-url",
        default="http://localhost:8080",
        help="Public portal base URL (default: http://localhost:8080)",
    )
    p_trigger.set_defaults(func=_cmd_trigger_setup)

    p_health = sub.add_parser("check-health", help="Verify DB, admin count, OrcaSlicer CLI, and FDM Monster")
    p_health.set_defaults(func=_cmd_check_health)

    return parser


def main(argv: Optional[list[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
