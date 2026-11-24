"""Application configuration using pydantic-settings."""

from __future__ import annotations

from pathlib import Path
from pydantic_settings import BaseSettings, SettingsConfigDict


BACKEND_DIR = Path(__file__).resolve().parent.parent
REPO_ROOT = BACKEND_DIR.parent


class Settings(BaseSettings):
    """Environment-backed application configuration."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    database_url: str = "sqlite:///./data/ggprint.db"
    jwt_secret: str = "ggprint-dev-secret-key-change-in-production-001"
    jwt_algorithm: str = "HS256"
    jwt_expire_minutes: int = 60 * 24 * 7

    dev_seed: bool = True
    institution: str = "Cégep Gérald-Godin"

    data_dir: Path = BACKEND_DIR / "data"
    sample_models_dir: Path = REPO_ROOT / "sample-models"
    poll_interval_seconds: int = 15

    cors_origins: list[str] = [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:3000",
        "http://127.0.0.1:3000",
    ]

    @property
    def jobs_dir(self) -> Path:
        return self.data_dir / "jobs"

    @property
    def profiles_dir(self) -> Path:
        return self.data_dir / "profiles"

    @property
    def effective_database_url(self) -> str:
        """Resolve relative SQLite URLs relative to BACKEND_DIR and ensure dirs exist."""
        url = self.database_url
        if url.startswith("sqlite:///./"):
            rel_path = url[len("sqlite:///./"):]
            abs_path = (BACKEND_DIR / rel_path).resolve()
            abs_path.parent.mkdir(parents=True, exist_ok=True)
            return f"sqlite:///{abs_path.as_posix()}"
        if url.startswith("sqlite:///") and url != "sqlite:///:memory:":
            raw_path = url[len("sqlite:///"):]
            abs_path = Path(raw_path)
            abs_path.parent.mkdir(parents=True, exist_ok=True)
        return url

    def ensure_directories(self) -> None:
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.jobs_dir.mkdir(parents=True, exist_ok=True)
        self.profiles_dir.mkdir(parents=True, exist_ok=True)


settings = Settings()
