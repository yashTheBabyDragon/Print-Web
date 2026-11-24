"""SQLAlchemy database engine, session factory, and initialization."""

from __future__ import annotations

from collections.abc import Generator

from sqlalchemy import create_engine, event, text
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.config import settings


class Base(DeclarativeBase):
    """Base declarative class for all ORM models."""


def _build_engine(database_url: str):
    is_sqlite = database_url.startswith("sqlite")
    connect_args = {"check_same_thread": False} if is_sqlite else {}
    eng = create_engine(
        database_url,
        connect_args=connect_args,
        pool_pre_ping=True,
    )
    if is_sqlite:
        @event.listens_for(eng, "connect")
        def _set_sqlite_pragma(dbapi_connection, _connection_record):
            cursor = dbapi_connection.cursor()
            cursor.execute("PRAGMA foreign_keys=ON")
            cursor.execute("PRAGMA journal_mode=WAL")
            cursor.close()
    return eng


settings.ensure_directories()
engine = _build_engine(settings.effective_database_url)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


def get_db() -> Generator[Session, None, None]:
    """Yield a database session per request."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def _migrate_sqlite_schema(eng) -> None:
    """Idempotently add new columns to existing SQLite tables."""
    with eng.begin() as conn:
        user_cols = {row[1] for row in conn.execute(text("PRAGMA table_info(users)"))}
        if user_cols:
            if "approval_status" not in user_cols:
                conn.execute(
                    text("ALTER TABLE users ADD COLUMN approval_status VARCHAR(20) NOT NULL DEFAULT 'approved'")
                )
            if "requested_teacher_id" not in user_cols:
                conn.execute(
                    text("ALTER TABLE users ADD COLUMN requested_teacher_id INTEGER REFERENCES users(id) ON DELETE SET NULL")
                )
            if "notify_browser" not in user_cols:
                conn.execute(
                    text("ALTER TABLE users ADD COLUMN notify_browser BOOLEAN NOT NULL DEFAULT 0")
                )
            if "notify_webhook_url" not in user_cols:
                conn.execute(
                    text("ALTER TABLE users ADD COLUMN notify_webhook_url VARCHAR(500)")
                )

        job_cols = {row[1] for row in conn.execute(text("PRAGMA table_info(print_jobs)"))}
        if job_cols:
            if "teacher_id" not in job_cols:
                conn.execute(
                    text("ALTER TABLE print_jobs ADD COLUMN teacher_id INTEGER REFERENCES users(id) ON DELETE SET NULL")
                )
            conn.execute(text("CREATE INDEX IF NOT EXISTS ix_print_jobs_teacher_id ON print_jobs (teacher_id)"))

        settings_cols = {row[1] for row in conn.execute(text("PRAGMA table_info(system_settings)"))}
        if settings_cols:
            if "filament_api_enabled" not in settings_cols:
                conn.execute(
                    text("ALTER TABLE system_settings ADD COLUMN filament_api_enabled BOOLEAN NOT NULL DEFAULT 0")
                )
            if "filament_api_url" not in settings_cols:
                conn.execute(
                    text(
                        "ALTER TABLE system_settings ADD COLUMN filament_api_url VARCHAR(255) NOT NULL DEFAULT 'http://filament-api:8000'"
                    )
                )

        printer_cols = {row[1] for row in conn.execute(text("PRAGMA table_info(printers)"))}
        if printer_cols:
            if "filament_api_printer_id" not in printer_cols:
                conn.execute(
                    text("ALTER TABLE printers ADD COLUMN filament_api_printer_id VARCHAR(120)")
                )


def init_db() -> None:
    """Create all tables if they do not exist and run lightweight SQLite migrations."""
    import app.models  # noqa: F401

    settings.ensure_directories()
    Base.metadata.create_all(bind=engine)
    if engine.dialect.name == "sqlite":
        _migrate_sqlite_schema(engine)
