"""Authentication routes (/api/auth)."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth import create_access_token, get_current_user, hash_password, verify_password
from app.config import settings
from app.database import get_db
from app.models import ClassEnrollment, DAWhitelist, User
from app.schemas import (
    AuthModeOut,
    AuthTokenResponse,
    CheckDaOut,
    LoginRequest,
    RegisterRequest,
    RegisterResponse,
    TeacherPublicOut,
    UserSummary,
)
from app.services.budget import build_user_summary, get_system_settings

router = APIRouter(prefix="/api/auth", tags=["auth"])


@router.get("/mode", response_model=AuthModeOut)
def get_auth_mode(db: Session = Depends(get_db)) -> AuthModeOut:
    """Public endpoint informing the login page of dev mode and integration modes."""
    sys_settings = get_system_settings(db)
    return AuthModeOut(
        dev_mode=settings.dev_seed,
        slicer_mode=sys_settings.slicer_mode,
        fdm_mode=sys_settings.fdm_monster_mode,
        institution=settings.institution,
    )


@router.get("/teachers", response_model=list[TeacherPublicOut])
def list_public_teachers(db: Session = Depends(get_db)) -> list[TeacherPublicOut]:
    """List active teachers for student registration / approval routing."""
    teachers = list(
        db.scalars(
            select(User)
            .where(User.role == "teacher", User.is_active == True)  # noqa: E712
            .order_by(User.name.asc(), User.id.asc())
        )
    )
    return [TeacherPublicOut(id=t.id, name=t.name) for t in teachers]


@router.get("/check-da/{da}", response_model=CheckDaOut)
def check_da(da: str, db: Session = Depends(get_db)) -> CheckDaOut:
    """Check whether a 7-digit DA is registered and/or pre-enrolled in a class roster."""
    cleaned = da.strip()
    if not (len(cleaned) == 7 and cleaned.isdigit()):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "code": "INVALID_DA",
                "message": "Le numéro de DA doit contenir exactement 7 chiffres.",
            },
        )

    is_registered = db.scalar(select(User.id).where(User.da == cleaned)) is not None
    enrollments = list(
        db.scalars(
            select(ClassEnrollment)
            .where(ClassEnrollment.da == cleaned)
            .order_by(ClassEnrollment.id.asc())
        )
    )
    wl = db.get(DAWhitelist, cleaned)
    in_roster = bool(enrollments) or wl is not None

    suggested_name = next((e.suggested_name for e in enrollments if e.suggested_name), None)
    if suggested_name is None and wl is not None:
        suggested_name = wl.suggested_name

    return CheckDaOut(
        da=cleaned,
        is_registered=is_registered,
        in_roster=in_roster,
        suggested_name=suggested_name,
    )


@router.post("/register", response_model=RegisterResponse, status_code=status.HTTP_201_CREATED)
def register(body: RegisterRequest, db: Session = Depends(get_db)) -> RegisterResponse:
    """Self-register a student account (auto-approved if in a class roster, else pending teacher approval)."""
    existing = db.scalar(select(User).where(User.da == body.da))
    if existing is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "code": "DA_ALREADY_REGISTERED",
                "message": "Un compte existe déjà pour ce numéro de DA.",
            },
        )

    enrollments = list(
        db.scalars(
            select(ClassEnrollment)
            .where(ClassEnrollment.da == body.da)
            .order_by(ClassEnrollment.id.asc())
        )
    )
    wl = db.get(DAWhitelist, body.da)
    in_roster = bool(enrollments) or wl is not None

    if in_roster:
        grams_overrides = [
            e.max_active_grams_override for e in enrollments if e.max_active_grams_override is not None
        ]
        if wl is not None and wl.max_active_grams_override is not None:
            grams_overrides.append(wl.max_active_grams_override)

        minutes_overrides = [
            e.max_print_minutes_override for e in enrollments if e.max_print_minutes_override is not None
        ]
        if wl is not None and wl.max_print_minutes_override is not None:
            minutes_overrides.append(wl.max_print_minutes_override)

        user = User(
            da=body.da,
            name=body.name,
            password_hash=hash_password(body.password),
            role="student",
            approval_status="approved",
            is_active=True,
            max_active_grams_override=max(grams_overrides) if grams_overrides else None,
            max_print_minutes_override=max(minutes_overrides) if minutes_overrides else None,
        )
        db.add(user)
        db.commit()
        db.refresh(user)

        token = create_access_token(user)
        return RegisterResponse(
            access_token=token,
            user=build_user_summary(db, user),
            pending_approval=False,
        )

    if body.teacher_id is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "code": "TEACHER_REQUIRED",
                "message": "Ce numéro de DA n'est pas dans une liste de classe. Veuillez choisir un enseignant.",
            },
        )

    teacher = db.get(User, body.teacher_id)
    if teacher is None or teacher.role != "teacher" or not teacher.is_active:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={
                "code": "TEACHER_NOT_FOUND",
                "message": "L'enseignant sélectionné est introuvable ou inactif.",
            },
        )

    user = User(
        da=body.da,
        name=body.name,
        password_hash=hash_password(body.password),
        role="student",
        approval_status="pending",
        is_active=False,
        requested_teacher_id=teacher.id,
    )
    db.add(user)
    db.commit()
    db.refresh(user)

    return RegisterResponse(
        access_token=None,
        user=None,
        pending_approval=True,
        requested_teacher_name=teacher.name,
    )


@router.post("/login", response_model=AuthTokenResponse)
def login(body: LoginRequest, db: Session = Depends(get_db)) -> AuthTokenResponse:
    """Authenticate by 7-digit DA (students) or username/email (teachers/admins) and password."""
    user = db.scalar(select(User).where(User.da == body.normalized_identifier))
    if user is None or not verify_password(body.password, user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={
                "code": "INVALID_CREDENTIALS",
                "message": "Identifiant ou mot de passe invalide.",
            },
        )
    if user.approval_status == "pending":
        teacher_name = None
        if user.requested_teacher_id is not None:
            teacher = db.get(User, user.requested_teacher_id)
            teacher_name = teacher.name if teacher else None
        msg = (
            f"Votre compte est en attente d'approbation par {teacher_name}."
            if teacher_name
            else "Votre compte est en attente d'approbation par votre enseignant."
        )
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "code": "ACCOUNT_PENDING_APPROVAL",
                "message": msg,
            },
        )
    if user.approval_status == "rejected":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "code": "ACCOUNT_REJECTED",
                "message": "Votre demande de compte a été refusée par l'enseignant.",
            },
        )
    if not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "code": "ACCOUNT_DISABLED",
                "message": "Ce compte est désactivé. Contactez un administrateur.",
            },
        )

    token = create_access_token(user)
    return AuthTokenResponse(
        access_token=token,
        user=build_user_summary(db, user),
    )


@router.get("/me", response_model=UserSummary)
def get_me(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> UserSummary:
    """Return the authenticated user's profile and active budget metrics."""
    return build_user_summary(db, current_user)
