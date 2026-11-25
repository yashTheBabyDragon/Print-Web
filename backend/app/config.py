"""Application configuration using pydantic-settings."""

from __future__ import annotations

import os
import re
import shutil
from pathlib import Path
from typing import Optional

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


BACKEND_DIR = Path(__file__).resolve().parent.parent
REPO_ROOT = BACKEND_DIR.parent
DEFAULT_JWT_SECRET = "ggprint-dev-secret-key-change-in-production-001"


def detect_app_version() -> str:
    """Detect GGPrint version from .ggprint-version file or backend/pyproject.toml."""
    version_file = REPO_ROOT / ".ggprint-version"
    try:
        if version_file.is_file():
            val = version_file.read_text(encoding="utf-8").strip().lstrip("vV")
            if val:
                return val
    except OSError:
        pass

    pyproject = BACKEND_DIR / "pyproject.toml"
    try:
        if pyproject.is_file():
            text = pyproject.read_text(encoding="utf-8")
            m = re.search(r'^version\s*=\s*"([^"]+)"', text, re.MULTILINE)
            if m:
                return m.group(1).strip()
    except OSError:
        pass
    return "1.0.0"


def detect_orca_cli_path(preferred_path: Optional[str] = None) -> Optional[str]:
    """Detect an installed OrcaSlicer CLI executable across Windows, Linux/Docker, and macOS."""
    candidates: list[Path] = []
    if preferred_path:
        pref = preferred_path.strip()
        if pref:
            pref_path = Path(pref)
            if pref_path.is_file():
                return str(pref_path)
            resolved = shutil.which(pref)
            if resolved:
                return resolved

    env_path = os.environ.get("ORCA_CLI_PATH", "").strip()
    if env_path:
        candidates.append(Path(env_path))

    for binary_name in ("orca-slicer-headless", "orca-slicer", "OrcaSlicer"):
        found = shutil.which(binary_name)
        if found:
            return found

    candidates.extend(
        [
            Path(r"C:\Program Files\OrcaSlicer\orca-slicer.exe"),
            Path(r"C:\Program Files (x86)\OrcaSlicer\orca-slicer.exe"),
            Path.home() / "AppData" / "Local" / "Programs" / "OrcaSlicer" / "orca-slicer.exe",
            Path("/usr/local/bin/orca-slicer-headless"),
            Path("/usr/local/bin/orca-slicer"),
            Path("/usr/bin/orca-slicer"),
            Path("/opt/orcaslicer/AppRun"),
            Path("/opt/OrcaSlicer/AppRun"),
            Path("/app/bin/orca-slicer"),
            Path("/Applications/OrcaSlicer.app/Contents/MacOS/OrcaSlicer"),
        ]
    )

    for cand in candidates:
        try:
            if cand.is_file():
                return str(cand)
        except OSError:
            continue
    return None


def detect_orca_resources_profiles_dirs(cli_path: Optional[str] = None) -> list[Path]:
    """Return existing directories containing OrcaSlicer vendor/user JSON or zip profiles."""
    raw_dirs: list[Path] = []
    effective_cli = cli_path or detect_orca_cli_path()
    if effective_cli:
        cli_file = Path(effective_cli)
        if cli_file.exists():
            resolved = cli_file.resolve()
            raw_dirs.extend(
                [
                    resolved.parent / "resources" / "profiles",
                    resolved.parent.parent / "resources" / "profiles",
                    resolved.parent / "profiles",
                ]
            )

    raw_dirs.extend(
        [
            Path(r"C:\Program Files\OrcaSlicer\resources\profiles"),
            Path(r"C:\Program Files (x86)\OrcaSlicer\resources\profiles"),
            Path("/opt/orcaslicer/resources/profiles"),
            Path("/opt/OrcaSlicer/resources/profiles"),
            Path("/usr/share/OrcaSlicer/resources/profiles"),
            Path("/usr/local/share/OrcaSlicer/resources/profiles"),
        ]
    )

    appdata = os.environ.get("APPDATA", "").strip()
    if appdata:
        raw_dirs.extend(
            [
                Path(appdata) / "OrcaSlicer" / "system",
                Path(appdata) / "OrcaSlicer" / "user",
            ]
        )
    raw_dirs.extend(
        [
            Path.home() / ".config" / "OrcaSlicer" / "system",
            Path.home() / ".config" / "OrcaSlicer" / "user",
            settings.profiles_dir,
        ]
    )

    seen: set[Path] = set()
    existing: list[Path] = []
    for d in raw_dirs:
        try:
            resolved_dir = d.resolve()
            if resolved_dir not in seen and resolved_dir.is_dir():
                seen.add(resolved_dir)
                existing.append(resolved_dir)
        except OSError:
            continue
    return existing


class Settings(BaseSettings):
    """Environment-backed application configuration."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    database_url: str = "sqlite:///./data/ggprint.db"
    jwt_secret: str = DEFAULT_JWT_SECRET
    jwt_algorithm: str = "HS256"
    jwt_expire_minutes: int = 60 * 24 * 7

    app_version: str = Field(default_factory=detect_app_version)
    github_repo: str = "yashTheBabyDragon/GGPrint-Web"
    github_token: Optional[str] = None

    @field_validator("app_version", mode="before")
    @classmethod
    def _normalize_app_version(cls, value: object) -> str:
        if isinstance(value, str):
            cleaned = value.strip().lstrip("vV")
            if cleaned:
                return cleaned
        return detect_app_version()

    dev_seed: bool = False
    institution: str = "Cégep Gérald-Godin"

    data_dir: Path = BACKEND_DIR / "data"
    sample_models_dir: Path = REPO_ROOT / "sample-models"
    poll_interval_seconds: int = 15
    slicer_mode_override: Optional[str] = None
    orca_cli_path_override: Optional[str] = None

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
