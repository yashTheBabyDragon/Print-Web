"""Centralized declarative Role-Based Access Control (RBAC) with Discord-style rank hierarchy."""

from __future__ import annotations

import json
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from enum import Enum

from fastapi import Depends, HTTPException, status

from app.auth import get_current_user
from app.models import User


class Permission(str, Enum):
    """Fine-grained application permissions."""

    # 3D Studio & Slicer
    SLICER_USE = "slicer:use"

    # Printers & Configurator
    PRINTERS_VIEW = "printers:view"
    PRINTERS_MANAGE_SLOTS = "printers:manage_slots"
    PRINTERS_EDIT = "printers:edit"
    PRINTERS_CREATE_DELETE = "printers:create_delete"

    # Filaments Editor
    FILAMENTS_VIEW = "filaments:view"
    FILAMENTS_EDIT = "filaments:edit"
    FILAMENTS_CREATE_DELETE = "filaments:create_delete"

    # Slicer Profiles (.json / .ini)
    PROFILES_VIEW = "profiles:view"
    PROFILES_MANAGE = "profiles:manage"

    # Classes & Rosters
    CLASSES_MANAGE_OWN = "classes:manage_own"
    CLASSES_MANAGE_ALL = "classes:manage_all"

    # Students & Quotas
    STUDENTS_MANAGE_OWN = "students:manage_own"
    STUDENTS_MANAGE_ALL = "students:manage_all"
    STUDENTS_ADJUST_QUOTAS = "students:adjust_quotas"
    STUDENTS_RESET_PASSWORD = "students:reset_password"

    # Approvals
    APPROVALS_JOBS_OWN = "approvals:jobs_own"
    APPROVALS_JOBS_ALL = "approvals:jobs_all"
    APPROVALS_ACCOUNTS_OWN = "approvals:accounts_own"
    APPROVALS_ACCOUNTS_ALL = "approvals:accounts_all"

    # Staff Account Management (Discord-style hierarchy)
    ACCOUNTS_VIEW = "accounts:view"
    ACCOUNTS_CREATE_TECH = "accounts:create_tech"
    ACCOUNTS_CREATE_TEACHER = "accounts:create_teacher"
    ACCOUNTS_EDIT_PERMISSIONS = "accounts:edit_permissions"
    ACCOUNTS_MANAGE_STATUS = "accounts:manage_status"
    ACCOUNTS_DELETE = "accounts:delete"

    # System & API Configuration (Strictly Main Admin Only)
    SETTINGS_MANAGE = "settings:manage"
    UPDATES_MANAGE = "updates:manage"


VALID_PERMISSION_KEYS: frozenset[str] = frozenset(p.value for p in Permission)

ADMIN_ONLY_PERMISSIONS: frozenset[Permission] = frozenset(
    {
        Permission.SETTINGS_MANAGE,
        Permission.UPDATES_MANAGE,
    }
)
ADMIN_ONLY_PERMISSION_KEYS: frozenset[str] = frozenset(p.value for p in ADMIN_ONLY_PERMISSIONS)

LEGACY_PERMISSION_ALIASES: dict[str, tuple[str, ...]] = {
    "printers:manage": (
        Permission.PRINTERS_VIEW.value,
        Permission.PRINTERS_MANAGE_SLOTS.value,
        Permission.PRINTERS_EDIT.value,
        Permission.PRINTERS_CREATE_DELETE.value,
    ),
    "filaments:manage": (
        Permission.FILAMENTS_VIEW.value,
        Permission.FILAMENTS_EDIT.value,
        Permission.FILAMENTS_CREATE_DELETE.value,
    ),
    "approvals:manage_own": (
        Permission.APPROVALS_JOBS_OWN.value,
        Permission.APPROVALS_ACCOUNTS_OWN.value,
    ),
    "approvals:manage_all": (
        Permission.APPROVALS_JOBS_ALL.value,
        Permission.APPROVALS_ACCOUNTS_ALL.value,
    ),
    "teachers:manage": (
        Permission.ACCOUNTS_VIEW.value,
        Permission.ACCOUNTS_CREATE_TECH.value,
        Permission.ACCOUNTS_CREATE_TEACHER.value,
        Permission.ACCOUNTS_EDIT_PERMISSIONS.value,
        Permission.ACCOUNTS_MANAGE_STATUS.value,
        Permission.ACCOUNTS_DELETE.value,
    ),
}

# (permission, group, resource, admin_only)
PERMISSION_CATALOG: list[tuple[Permission, str, str, bool]] = [
    (Permission.SLICER_USE, "slicer", "slicer", False),
    (Permission.PRINTERS_VIEW, "lab", "printers", False),
    (Permission.PRINTERS_MANAGE_SLOTS, "lab", "printers", False),
    (Permission.PRINTERS_EDIT, "lab", "printers", False),
    (Permission.PRINTERS_CREATE_DELETE, "lab", "printers", False),
    (Permission.FILAMENTS_VIEW, "lab", "filaments", False),
    (Permission.FILAMENTS_EDIT, "lab", "filaments", False),
    (Permission.FILAMENTS_CREATE_DELETE, "lab", "filaments", False),
    (Permission.PROFILES_VIEW, "lab", "profiles", False),
    (Permission.PROFILES_MANAGE, "lab", "profiles", False),
    (Permission.CLASSES_MANAGE_OWN, "classes", "classes", False),
    (Permission.CLASSES_MANAGE_ALL, "classes", "classes", False),
    (Permission.STUDENTS_MANAGE_OWN, "students", "students", False),
    (Permission.STUDENTS_MANAGE_ALL, "students", "students", False),
    (Permission.STUDENTS_ADJUST_QUOTAS, "students", "students", False),
    (Permission.STUDENTS_RESET_PASSWORD, "students", "students", False),
    (Permission.APPROVALS_JOBS_OWN, "approvals", "approvals", False),
    (Permission.APPROVALS_JOBS_ALL, "approvals", "approvals", False),
    (Permission.APPROVALS_ACCOUNTS_OWN, "approvals", "approvals", False),
    (Permission.APPROVALS_ACCOUNTS_ALL, "approvals", "approvals", False),
    (Permission.ACCOUNTS_VIEW, "accounts", "accounts", False),
    (Permission.ACCOUNTS_CREATE_TECH, "accounts", "accounts", False),
    (Permission.ACCOUNTS_CREATE_TEACHER, "accounts", "accounts", False),
    (Permission.ACCOUNTS_EDIT_PERMISSIONS, "accounts", "accounts", False),
    (Permission.ACCOUNTS_MANAGE_STATUS, "accounts", "accounts", False),
    (Permission.ACCOUNTS_DELETE, "accounts", "accounts", False),
    (Permission.SETTINGS_MANAGE, "administration", "settings", True),
    (Permission.UPDATES_MANAGE, "administration", "updates", True),
]

ROLE_DEFAULT_RANK: dict[str, int] = {
    "student": 0,
    "tech": 50,
    "teacher": 50,
    "admin": 100,
}

ROLE_PERMISSIONS: dict[str, frozenset[Permission]] = {
    "student": frozenset({Permission.SLICER_USE}),
    "teacher": frozenset(
        {
            Permission.SLICER_USE,
            Permission.CLASSES_MANAGE_OWN,
            Permission.STUDENTS_MANAGE_OWN,
            Permission.STUDENTS_ADJUST_QUOTAS,
            Permission.STUDENTS_RESET_PASSWORD,
            Permission.APPROVALS_JOBS_OWN,
            Permission.APPROVALS_ACCOUNTS_OWN,
        }
    ),
    "tech": frozenset(
        {
            Permission.SLICER_USE,
            Permission.CLASSES_MANAGE_ALL,
            Permission.STUDENTS_MANAGE_ALL,
            Permission.STUDENTS_ADJUST_QUOTAS,
            Permission.STUDENTS_RESET_PASSWORD,
            Permission.APPROVALS_JOBS_ALL,
            Permission.APPROVALS_ACCOUNTS_ALL,
            Permission.PRINTERS_VIEW,
            Permission.PRINTERS_MANAGE_SLOTS,
            Permission.PRINTERS_EDIT,
            Permission.PRINTERS_CREATE_DELETE,
            Permission.FILAMENTS_VIEW,
            Permission.FILAMENTS_EDIT,
            Permission.FILAMENTS_CREATE_DELETE,
            Permission.PROFILES_VIEW,
            Permission.PROFILES_MANAGE,
        }
    ),
    "admin": frozenset(Permission),
}


@dataclass(frozen=True)
class PresetDefinition:
    id: str
    role: str
    default_rank: int
    permissions: tuple[str, ...]


PERMISSION_PRESET_DEFS: dict[str, PresetDefinition] = {
    "teacher_default": PresetDefinition(
        id="teacher_default",
        role="teacher",
        default_rank=50,
        permissions=tuple(sorted(p.value for p in ROLE_PERMISSIONS["teacher"])),
    ),
    "lab_tech": PresetDefinition(
        id="lab_tech",
        role="tech",
        default_rank=50,
        permissions=tuple(sorted(p.value for p in ROLE_PERMISSIONS["tech"])),
    ),
    "printer_operator": PresetDefinition(
        id="printer_operator",
        role="tech",
        default_rank=40,
        permissions=(
            Permission.SLICER_USE.value,
            Permission.PRINTERS_VIEW.value,
            Permission.PRINTERS_MANAGE_SLOTS.value,
            Permission.FILAMENTS_VIEW.value,
            Permission.FILAMENTS_EDIT.value,
            Permission.APPROVALS_JOBS_ALL.value,
        ),
    ),
    "coordinator": PresetDefinition(
        id="coordinator",
        role="teacher",
        default_rank=70,
        permissions=(
            Permission.SLICER_USE.value,
            Permission.CLASSES_MANAGE_ALL.value,
            Permission.STUDENTS_MANAGE_ALL.value,
            Permission.STUDENTS_ADJUST_QUOTAS.value,
            Permission.STUDENTS_RESET_PASSWORD.value,
            Permission.APPROVALS_JOBS_ALL.value,
            Permission.APPROVALS_ACCOUNTS_ALL.value,
            Permission.ACCOUNTS_VIEW.value,
            Permission.ACCOUNTS_CREATE_TECH.value,
            Permission.ACCOUNTS_EDIT_PERMISSIONS.value,
            Permission.ACCOUNTS_MANAGE_STATUS.value,
        ),
    ),
    "slicer_only": PresetDefinition(
        id="slicer_only",
        role="teacher",
        default_rank=10,
        permissions=(Permission.SLICER_USE.value,),
    ),
}

PERMISSION_PRESETS: dict[str, list[str]] = {
    pid: sorted(pdef.permissions) for pid, pdef in PERMISSION_PRESET_DEFS.items()
}

# Direct permission implication map: holding `broader` satisfies `narrower`.
IMPLIED_BY_PERMISSIONS: dict[Permission, tuple[Permission, ...]] = {
    Permission.PRINTERS_VIEW: (
        Permission.PRINTERS_MANAGE_SLOTS,
        Permission.PRINTERS_EDIT,
        Permission.PRINTERS_CREATE_DELETE,
    ),
    Permission.FILAMENTS_VIEW: (
        Permission.FILAMENTS_EDIT,
        Permission.FILAMENTS_CREATE_DELETE,
    ),
    Permission.PROFILES_VIEW: (Permission.PROFILES_MANAGE,),
    Permission.CLASSES_MANAGE_OWN: (Permission.CLASSES_MANAGE_ALL,),
    Permission.STUDENTS_MANAGE_OWN: (Permission.STUDENTS_MANAGE_ALL,),
    Permission.APPROVALS_JOBS_OWN: (Permission.APPROVALS_JOBS_ALL,),
    Permission.APPROVALS_ACCOUNTS_OWN: (Permission.APPROVALS_ACCOUNTS_ALL,),
    Permission.ACCOUNTS_VIEW: (
        Permission.ACCOUNTS_CREATE_TECH,
        Permission.ACCOUNTS_CREATE_TEACHER,
        Permission.ACCOUNTS_EDIT_PERMISSIONS,
        Permission.ACCOUNTS_MANAGE_STATUS,
        Permission.ACCOUNTS_DELETE,
    ),
}


def get_effective_rank(user: User) -> int:
    """Return a User's effective hierarchy rank (admin=100, student=0, staff default=50)."""
    if user.role == "admin":
        return 100
    if user.role == "student":
        return 0
    raw = getattr(user, "hierarchy_rank", None)
    if raw is None:
        return ROLE_DEFAULT_RANK.get(user.role, 50)
    return max(1, min(99, int(raw)))


def normalize_permission_keys(keys: Iterable[str], *, drop_admin_only: bool = False) -> list[str]:
    """Expand legacy aliases cleanly and return sorted unique valid permission strings."""
    expanded: set[str] = set()
    for raw in keys:
        key = str(raw).strip()
        if not key:
            continue
        if key in LEGACY_PERMISSION_ALIASES:
            expanded.update(LEGACY_PERMISSION_ALIASES[key])
        elif key in VALID_PERMISSION_KEYS:
            expanded.add(key)
        else:
            raise ValueError(f"Unknown permission key(s): {key}")
    if drop_admin_only:
        expanded -= ADMIN_ONLY_PERMISSION_KEYS
    return sorted(expanded)


def expand_implied_permissions(keys: Iterable[str]) -> set[str]:
    """Return `keys` plus any narrower permissions implied by them."""
    effective = set(keys)
    changed = True
    while changed:
        changed = False
        for narrower, broaders in IMPLIED_BY_PERMISSIONS.items():
            if narrower.value in effective:
                continue
            if any(b.value in effective for b in broaders):
                effective.add(narrower.value)
                changed = True
    return effective


def get_permissions_for_role(role: str) -> list[str]:
    """Return sorted list of default permission strings granted to a role."""
    perms = ROLE_PERMISSIONS.get(role, frozenset())
    return sorted(p.value for p in perms)


def get_user_permissions(user: User) -> list[str]:
    """Return effective sorted permission strings for a User, honoring custom overrides.

    Non-admin roles are always stripped of strictly admin-only permissions (`settings:manage`, `updates:manage`).
    """
    if user.role == "admin":
        return sorted(p.value for p in Permission)

    raw_json = getattr(user, "permissions_json", None)
    if raw_json is not None:
        try:
            parsed = json.loads(raw_json)
            if isinstance(parsed, list):
                collected: set[str] = set()
                for item in parsed:
                    key = str(item).strip()
                    if key in LEGACY_PERMISSION_ALIASES:
                        collected.update(LEGACY_PERMISSION_ALIASES[key])
                    elif key in VALID_PERMISSION_KEYS:
                        collected.add(key)
                collected -= ADMIN_ONLY_PERMISSION_KEYS
                return sorted(collected)
        except (ValueError, TypeError):
            pass

    return get_permissions_for_role(user.role)


def validate_permission_keys(keys: list[str]) -> list[str]:
    """Validate and normalize a list of permission keys, raising ValueError on unknown keys."""
    return normalize_permission_keys(keys, drop_admin_only=False)


def validate_delegatable_permissions(keys: list[str]) -> list[str]:
    """Validate permissions intended for a non-admin staff account; reject admin-only keys."""
    unknown: list[str] = []
    expanded: set[str] = set()
    for raw in keys:
        key = str(raw).strip()
        if not key:
            continue
        if key in LEGACY_PERMISSION_ALIASES:
            expanded.update(LEGACY_PERMISSION_ALIASES[key])
        elif key in VALID_PERMISSION_KEYS:
            expanded.add(key)
        else:
            unknown.append(key)
    if unknown:
        raise ValueError(f"Unknown permission key(s): {', '.join(sorted(set(unknown)))}")
    forbidden = sorted(expanded & ADMIN_ONLY_PERMISSION_KEYS)
    if forbidden:
        raise PermissionError(
            f"Admin-only permission(s) cannot be assigned to non-admin accounts: {', '.join(forbidden)}"
        )
    return sorted(expanded)


def resolve_preset(preset_id: str) -> list[str]:
    """Resolve a named permission preset to a sorted list of permission keys."""
    if preset_id not in PERMISSION_PRESET_DEFS:
        raise ValueError(f"Unknown permission preset: {preset_id}")
    return sorted(set(PERMISSION_PRESET_DEFS[preset_id].permissions))


def get_preset_spec(preset_id: str) -> PresetDefinition:
    """Return full PresetDefinition for `preset_id` or raise ValueError."""
    if preset_id not in PERMISSION_PRESET_DEFS:
        raise ValueError(f"Unknown permission preset: {preset_id}")
    return PERMISSION_PRESET_DEFS[preset_id]


def has_permission(user_or_role: User | str, permission: Permission) -> bool:
    """Check whether a User instance (including custom overrides) or role string holds `permission`.

    Broader permissions (`*:manage_all`, higher printer/filament tiers) automatically satisfy
    implied narrower permissions. Admin-only permissions always require `role == "admin"`.
    """
    if permission in ADMIN_ONLY_PERMISSIONS:
        if isinstance(user_or_role, User):
            return user_or_role.role == "admin"
        return user_or_role == "admin"

    accepted = {permission.value}
    for broader in IMPLIED_BY_PERMISSIONS.get(permission, ()):
        accepted.add(broader.value)

    if isinstance(user_or_role, User):
        user_perms = expand_implied_permissions(get_user_permissions(user_or_role))
        return bool(user_perms & accepted)
    role_perms = expand_implied_permissions(p.value for p in ROLE_PERMISSIONS.get(user_or_role, frozenset()))
    return bool(role_perms & accepted)


def require_permission(permission: Permission) -> Callable[..., User]:
    """FastAPI dependency enforcing that the authenticated user has `permission`."""

    def _dependency(current_user: User = Depends(get_current_user)) -> User:
        if not has_permission(current_user, permission):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail={
                    "code": "FORBIDDEN",
                    "message": f"Permission '{permission.value}' is required for this action.",
                    "required_permission": permission.value,
                },
            )
        return current_user

    return _dependency


def require_any_permission(*permissions: Permission) -> Callable[..., User]:
    """FastAPI dependency enforcing that the authenticated user has at least one of `permissions`."""

    def _dependency(current_user: User = Depends(get_current_user)) -> User:
        if not any(has_permission(current_user, perm) for perm in permissions):
            names = ", ".join(p.value for p in permissions)
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail={
                    "code": "FORBIDDEN",
                    "message": f"One of permissions [{names}] is required for this action.",
                    "required_permission": permissions[0].value if permissions else "",
                },
            )
        return current_user

    return _dependency
