"""Student printer listing routes (/api/printers)."""

from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.auth import get_current_user
from app.database import get_db
from app.models import Printer, PrinterSlot, User
from app.schemas import PrinterOut
from app.services.budget import get_system_settings
from app.services.fdm_monster import FdmMonsterError, get_fdm_adapter
from app.services.serializers import serialize_printer

router = APIRouter(prefix="/api/printers", tags=["printers"])


@router.get("", response_model=list[PrinterOut])
async def list_enabled_printers(
    _current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[PrinterOut]:
    """Return enabled printers merged with live status from FDM Monster and DB slot filaments."""
    sys_settings = get_system_settings(db)
    adapter = get_fdm_adapter(sys_settings)

    try:
        remote_list = await adapter.list_printers()
        remote_map = {rp.fdm_monster_id: rp for rp in remote_list}
    except FdmMonsterError:
        remote_map = {}

    printers = list(
        db.scalars(
            select(Printer)
            .where(Printer.is_enabled.is_(True))
            .options(selectinload(Printer.slots).selectinload(PrinterSlot.filament))
            .order_by(Printer.id.asc())
        )
    )

    for p in printers:
        rp = remote_map.get(p.fdm_monster_id)
        if rp:
            p.status = rp.status
            p.queue_count = rp.queue_count

    return [serialize_printer(p) for p in printers]
