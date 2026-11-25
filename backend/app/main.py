"""FastAPI application entrypoint with lifespan DB init, seeding, and FDM Monster poller."""

from __future__ import annotations

import asyncio
import contextlib
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.database import SessionLocal, init_db
from app.routers import admin, auth, jobs, printers, samples
from app.seed import seed_database
from app.services.drafts import purge_expired_drafts
from app.services.fdm_monster import poll_fdm_monster_once
from app.services.filament_api import poll_filament_api_once

logger = logging.getLogger(__name__)

DRAFT_PURGE_INTERVAL_SECONDS = 30 * 60


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


@asynccontextmanager
async def lifespan(_app: FastAPI):
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
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$" if settings.dev_seed else None,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router)
app.include_router(printers.router)
app.include_router(samples.router)
app.include_router(jobs.router)
app.include_router(admin.router)


@app.get("/api/health", tags=["health"])
def health_check() -> dict[str, str]:
    """Liveness probe for Docker/Nginx/local dev."""
    return {"status": "ok", "service": "ggprint-backend"}
