"""Media upload tickets. See app/services/media.py for the flow."""

from __future__ import annotations

import uuid
from datetime import timedelta

from fastapi import APIRouter, status

from app.db import utcnow
from app.deps import DB, AppSettings, CurrentViewer, Limiter, Storage
from app.errors import ApiError, invalid, not_found
from app.models import Media
from app.schemas import CreateUploadRequest, MediaOut, UploadTicket
from app.services.media import ALLOWED_CONTENT_TYPES, UPLOAD_URL_TTL_S

router = APIRouter(prefix="/v1", tags=["media"])


def _require(storage) -> None:
    if not storage.configured:
        raise ApiError(503, "media_unavailable", "Photo uploads aren't available yet.")


@router.post("/media/uploads", response_model=UploadTicket, status_code=status.HTTP_201_CREATED)
def create_upload(body: CreateUploadRequest, db: DB, viewer: CurrentViewer, settings: AppSettings, storage: Storage, limiter: Limiter):
    _require(storage)
    limiter.hit("media:create", str(viewer.id))
    ext = ALLOWED_CONTENT_TYPES.get(body.content_type)
    if not ext:
        raise invalid("Upload a JPEG, PNG, WebP or HEIC image.", "unsupported_media_type")
    if body.byte_size > settings.media_max_bytes:
        raise invalid(f"Images can be at most {settings.media_max_bytes // (1024 * 1024)} MB.", "media_too_large")
    media_id = uuid.uuid4()
    key = f"{body.purpose}/{viewer.id}/{media_id}.{ext}"
    url, headers = storage.presign_put(key, body.content_type, body.byte_size)
    db.add(Media(id=media_id, owner_id=viewer.id, purpose=body.purpose, content_type=body.content_type, byte_size=body.byte_size, storage_key=key))
    db.commit()
    return UploadTicket(media_id=media_id, upload_url=url, method="PUT", headers=headers, expires_at=utcnow() + timedelta(seconds=UPLOAD_URL_TTL_S))


@router.post("/media/{media_id}/complete", response_model=MediaOut)
def complete_upload(media_id: uuid.UUID, db: DB, viewer: CurrentViewer, storage: Storage):
    _require(storage)
    m = db.get(Media, media_id)
    if not m or m.owner_id != viewer.id:
        raise not_found("Upload not found.")
    if m.status != "ready":
        obj = storage.head(m.storage_key)
        if obj is None:
            raise ApiError(409, "upload_missing", "The file hasn't finished uploading.")
        if obj.byte_size != m.byte_size or obj.content_type != m.content_type:
            raise invalid("The uploaded file doesn't match what was declared.", "upload_mismatch")
        m.status = "ready"
        db.commit()
    return MediaOut(media_id=m.id, status=m.status, url=storage.public_url(m.storage_key))
