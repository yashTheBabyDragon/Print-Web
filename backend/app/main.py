"""FastAPI application entrypoint with lifespan DB init, seeding, and FDM Monster poller."""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import text

from app.config import DEFAULT_JWT_SECRET, settings
from app.database import SessionLocal, init_db
from app.routers import admin, auth, jobs, printers, samples
from app.seed import seed_database
from app.services.drafts import purge_expired_drafts
from app.services.fdm_monster import poll_fdm_monster_once
from app.services.filament_api import poll_filament_api_once

logger = logging.getLogger(__name__)

DRAFT_PURGE_INTERVAL_SECONDS = 30 * 60
_STARTED_AT = time.monotonic()


async def _fdm_poller_loop() -> None:
    """Background task polling FDM Monster and FilamentAPI every 15s to sync statuses and filaments."""
    while True:
        try:
            await asyncio.sleep(settings.poll_interval_seconds)
            with SessionLocal() as db:
                await poll_fdm_monster_once(db)
                await poll_filament_api_once(db)
        except asyncio.CancelledError:
            break
        except Exception as exc:
            logger.warning("Background poller tick error: %s", exc)


async def _draft_purge_loop() -> None:
    """Background task periodically purging unsubmitted drafts older than 24 hours."""
    while True:
        try:
            await asyncio.sleep(DRAFT_PURGE_INTERVAL_SECONDS)
            with SessionLocal() as db:
                deleted = purge_expired_drafts(db)
                if deleted:
                    logger.info("Purged %d expired draft job(s)", deleted)
        except asyncio.CancelledError:
            break
        except Exception as exc:
            logger.warning("Background draft purge tick error: %s", exc)


_INSECURE_JWT_SECRETS = frozenset(
    {
        DEFAULT_JWT_SECRET,
        "change-this-to-a-long-random-production-secret",
    }
)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    is_weak_secret = (
        settings.jwt_secret in _INSECURE_JWT_SECRETS
        or len((settings.jwt_secret or "").strip()) < 16
    )
    if is_weak_secret:
        if not settings.dev_seed:
            raise RuntimeError(
                "Refusing to start in production (DEV_SEED=false) with an insecure or short JWT_SECRET."
            )
        logger.warning(
            "SECURITY WARNING: JWT_SECRET is using an insecure development value. "
            "Set a strong random JWT_SECRET (>= 16 chars) in your environment for production deployments."
        )

    init_db()
    with SessionLocal() as db:
        seed_database(db)
        purge_expired_drafts(db)

    poller_task = asyncio.create_task(_fdm_poller_loop())
    draft_purge_task = asyncio.create_task(_draft_purge_loop())
    try:
        yield
    finally:
        poller_task.cancel()
        draft_purge_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await poller_task
        with contextlib.suppress(asyncio.CancelledError):
            await draft_purge_task


app = FastAPI(
    title="GGPrint API",
    description="Cégep Gérald-Godin 3D Print & Slicing Portal API",
    version=settings.app_version,
    lifespan=lifespan,
)


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    """Catch unexpected errors, log full traceback server-side, and return clean JSON."""
    logger.exception("Unhandled error on %s %s: %s", request.method, request.url.path, exc)
    return JSONResponse(
        status_code=500,
        content={
            "detail": {
                "code": "INTERNAL_ERROR",
                "message": "An unexpected internal error occurred",
            }
        },
    )

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$" if settings.dev_seed else None,
    allow_credentials=False,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)

app.include_router(auth.router)
app.include_router(printers.router)
app.include_router(samples.router)
app.include_router(jobs.router)
app.include_router(admin.router)


@app.get("/api/health", tags=["health"])
def health_check():
    """Liveness and database readiness probe for Docker/Nginx/systemd/local dev."""
    uptime = round(max(0.0, time.monotonic() - _STARTED_AT), 2)
    db_ok = True
    try:
        with SessionLocal() as db:
            db.execute(text("SELECT 1"))
    except Exception as exc:
        logger.error("Health check DB probe failed: %s", exc)
        db_ok = False

    payload = {
        "status": "ok" if db_ok else "degraded",
        "service": "ggprint-backend",
        "version": settings.app_version,
        "db_ok": db_ok,
        "uptime_seconds": uptime,
    }
    if not db_ok:
        return JSONResponse(status_code=503, content=payload)
    return payload
