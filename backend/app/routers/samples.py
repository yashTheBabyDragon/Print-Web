"""Sample STL model listing and download routes (/api/samples)."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, status
from fastapi.responses import FileResponse

from app.config import settings
from app.schemas import SampleModelOut

router = APIRouter(prefix="/api/samples", tags=["samples"])

_SAMPLE_METADATA: dict[str, tuple[str, str]] = {
    "tilted-bracket.stl": (
        "Support incliné / Tilted Bracket",
        "Équerre inclinée à 37° (~25g) — idéale pour tester l'auto-orientation à plat et l'impression dans le budget.",
    ),
    "complex-mount.stl": (
        "Support complexe multi-faces / Complex Multi-Face Mount",
        "Pièce mécanique avec congé cylindrique, chanfrein 45°, pente 30° et cavité (~38g) pour tester Poser à plat et l'accrochage exact au plateau.",
    ),
    "oversized-housing.stl": (
        "Boîtier surdimensionné / Oversized Housing",
        "Boîtier technique 110×110×60 mm (>100g) — idéal pour tester la demande d'approbation administrateur.",
    ),
}


@router.get("", response_model=list[SampleModelOut])
def list_samples() -> list[SampleModelOut]:
    """List sample .stl files located in sample-models/."""
    sample_dir = settings.sample_models_dir
    if not sample_dir.exists():
        return []

    items: list[SampleModelOut] = []
    for path in sorted(sample_dir.glob("*.stl")):
        name, desc = _SAMPLE_METADATA.get(
            path.name,
            (path.stem.replace("-", " ").title(), f"Modèle STL de démonstration ({path.name})"),
        )
        items.append(SampleModelOut(id=path.name, name=name, description=desc))
    return items


@router.get("/{sample_id}")
def get_sample_stl(sample_id: str) -> FileResponse:
    """Stream raw binary STL sample model."""
    if "/" in sample_id or "\\" in sample_id or ".." in sample_id or not sample_id.lower().endswith(".stl"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"code": "INVALID_SAMPLE_ID", "message": "Invalid sample model identifier"},
        )
    target = (settings.sample_models_dir / sample_id).resolve()
    base = settings.sample_models_dir.resolve()
    if not target.is_relative_to(base) or not target.exists():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "SAMPLE_NOT_FOUND", "message": "Sample model not found"},
        )
    return FileResponse(path=target, media_type="model/stl", filename=sample_id)
