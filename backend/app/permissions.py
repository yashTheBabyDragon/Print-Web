"""Centralized declarative Role-Based Access Control (RBAC) with per-user overrides and presets."""

from __future__ import annotations

import json
from collections.abc import Callable
from enum import Enum

from fastapi import Depends, HTTPException, status

from app.auth import get_current_user
from app.models import User


class Permission(str, Enum):
    """Fine-grained application permissions."""

    SLICER_USE = "slicer:use"
    CLASSES_MANAGE_OWN = "classes:manage_own"
    CLASSES_MANAGE_ALL = "classes:manage_all"
    STUDENTS_MANAGE_OWN = "students:manage_own"
    STUDENTS_MANAGE_ALL = "students:manage_all"
    APPROVALS_MANAGE_OWN = "approvals:manage_own"
    APPROVALS_MANAGE_ALL = "approvals:manage_all"
    PRINTERS_MANAGE = "printers:manage"
    FILAMENTS_MANAGE = "filaments:manage"
    PROFILES_MANAGE = "profiles:manage"
    TEACHERS_MANAGE = "teachers:manage"
    SETTINGS_MANAGE = "settings:manage"


VALID_PERMISSION_KEYS: frozenset[str] = frozenset(p.value for p in Permission)

PERMISSION_CATALOG: list[tuple[Permission, str]] = [
    (Permission.SLICER_USE, "slicer"),
    (Permission.CLASSES_MANAGE_OWN, "classes"),
    (Permission.CLASSES_MANAGE_ALL, "classes"),
    (Permission.STUDENTS_MANAGE_OWN, "students"),
    (Permission.STUDENTS_MANAGE_ALL, "students"),
    (Permission.APPROVALS_MANAGE_OWN, "approvals"),
    (Permission.APPROVALS_MANAGE_ALL, "approvals"),
    (Permission.PRINTERS_MANAGE, "lab"),
    (Permission.FILAMENTS_MANAGE, "lab"),
    (Permission.PROFILES_MANAGE, "lab"),
    (Permission.TEACHERS_MANAGE, "administration"),
    (Permission.SETTINGS_MANAGE, "administration"),
]

ROLE_PERMISSIONS: dict[str, frozenset[Permission]] = {
    "student": frozenset({Permission.SLICER_USE}),
    "teacher": frozenset(
        {
            Permission.SLICER_USE,
            Permission.CLASSES_MANAGE_OWN,
            Permission.STUDENTS_MANAGE_OWN,
            Permission.APPROVALS_MANAGE_OWN,
        }
    ),
    "admin": frozenset(Permission),
}

PERMISSION_PRESETS: dict[str, list[str]] = {
    "teacher_default": [
        Permission.SLICER_USE.value,
        Permission.CLASSES_MANAGE_OWN.value,
        Permission.STUDENTS_MANAGE_OWN.value,
        Permission.APPROVALS_MANAGE_OWN.value,
    ],
    "lab_tech": [
        Permission.SLICER_USE.value,
        Permission.PRINTERS_MANAGE.value,
        Permission.FILAMENTS_MANAGE.value,
        Permission.PROFILES_MANAGE.value,
        Permission.APPROVALS_MANAGE_ALL.value,
    ],
    "coordinator": [
        Permission.SLICER_USE.value,
        Permission.CLASSES_MANAGE_OWN.value,
        Permission.CLASSES_MANAGE_ALL.value,
        Permission.STUDENTS_MANAGE_OWN.value,
        Permission.STUDENTS_MANAGE_ALL.value,
        Permission.APPROVALS_MANAGE_OWN.value,
        Permission.APPROVALS_MANAGE_ALL.value,
    ],
    "slicer_only": [
        Permission.SLICER_USE.value,
    ],
    "full_admin": sorted(p.value for p in Permission),
}


def get_permissions_for_role(role: str) -> list[str]:
    """Return sorted list of default permission strings granted to a role."""
    perms = ROLE_PERMISSIONS.get(role, frozenset())
    return sorted(p.value for p in perms)


def get_user_permissions(user: User) -> list[str]:
    """Return effective sorted permission strings for a User, honoring custom overrides."""
    if user.role == "admin":
        return sorted(p.value for p in Permission)

    raw_json = getattr(user, "permissions_json", None)
    if raw_json is not None:
        try:
            parsed = json.loads(raw_json)
            if isinstance(parsed, list):
                valid = sorted({str(item) for item in parsed if str(item) in VALID_PERMISSION_KEYS})
                return valid
        except (ValueError, TypeError):
            pass

    return get_permissions_for_role(user.role)


def validate_permission_keys(keys: list[str]) -> list[str]:
    """Validate and normalize a list of permission keys, raising ValueError on unknown keys."""
    unknown = [k for k in keys if k not in VALID_PERMISSION_KEYS]
    if unknown:
        raise ValueError(f"Unknown permission key(s): {', '.join(sorted(set(unknown)))}")
    return sorted(set(keys))


def resolve_preset(preset_id: str) -> list[str]:
    """Resolve a named permission preset to a sorted list of permission keys."""
    if preset_id not in PERMISSION_PRESETS:
        raise ValueError(f"Unknown permission preset: {preset_id}")
    return sorted(set(PERMISSION_PRESETS[preset_id]))


IMPLIED_BY_PERMISSIONS: dict[Permission, tuple[Permission, ...]] = {
    Permission.CLASSES_MANAGE_OWN: (Permission.CLASSES_MANAGE_ALL,),
    Permission.STUDENTS_MANAGE_OWN: (Permission.STUDENTS_MANAGE_ALL,),
    Permission.APPROVALS_MANAGE_OWN: (Permission.APPROVALS_MANAGE_ALL,),
}


def has_permission(user_or_role: User | str, permission: Permission) -> bool:
    """Check whether a User instance (including custom overrides) or role string holds `permission`.

    `*:manage_all` automatically satisfies the corresponding `*:manage_own` permission.
    """
    accepted = {permission.value}
    for broader in IMPLIED_BY_PERMISSIONS.get(permission, ()):
        accepted.add(broader.value)

    if isinstance(user_or_role, User):
        return bool(set(get_user_permissions(user_or_role)) & accepted)
    role_perms = {p.value for p in ROLE_PERMISSIONS.get(user_or_role, frozenset())}
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
