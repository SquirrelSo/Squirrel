"""Object storage for user media (post images, avatar photos).

Flow — binary never goes through the JSON API:
  1. POST /v1/media/uploads        → { media_id, upload_url, method: PUT, headers, expires_at }
  2. client PUTs the bytes to upload_url (straight to the bucket)
  3. POST /v1/media/:id/complete   → server HEADs the object, checks size + type, marks it ready
  4. POST /v1/posts { media_id }   (or PATCH profile { avatar_media_id })

Any S3-compatible store works (AWS S3, Cloudflare R2, MinIO) via SOCIAL_MEDIA_* settings.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from app.config import Settings

ALLOWED_CONTENT_TYPES = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/heic": "heic"}
UPLOAD_URL_TTL_S = 900


@dataclass
class StoredObject:
    byte_size: int
    content_type: str


class MediaStorage(Protocol):
    configured: bool

    def presign_put(self, key: str, content_type: str, byte_size: int) -> tuple[str, dict[str, str]]: ...

    def head(self, key: str) -> StoredObject | None: ...

    def public_url(self, key: str) -> str: ...


class DisabledStorage:
    configured = False

    def presign_put(self, key, content_type, byte_size):  # pragma: no cover - guarded by `configured`
        raise RuntimeError("media storage not configured")

    def head(self, key):  # pragma: no cover
        return None

    def public_url(self, key):  # pragma: no cover
        return ""


class S3Storage:
    configured = True

    def __init__(self, settings: Settings):
        import boto3  # imported lazily: only needed when media is configured

        self.bucket = settings.media_bucket
        self.public_base = settings.media_public_base_url
        self.client = boto3.client("s3", region_name=settings.media_region, endpoint_url=settings.media_endpoint_url)

    def presign_put(self, key: str, content_type: str, byte_size: int) -> tuple[str, dict[str, str]]:
        url = self.client.generate_presigned_url(
            "put_object",
            Params={"Bucket": self.bucket, "Key": key, "ContentType": content_type, "ContentLength": byte_size},
            ExpiresIn=UPLOAD_URL_TTL_S,
        )
        return url, {"Content-Type": content_type}

    def head(self, key: str) -> StoredObject | None:
        from botocore.exceptions import ClientError

        try:
            r = self.client.head_object(Bucket=self.bucket, Key=key)
        except ClientError:
            return None
        return StoredObject(byte_size=int(r["ContentLength"]), content_type=r.get("ContentType", ""))

    def public_url(self, key: str) -> str:
        if self.public_base:
            return f"{self.public_base}/{key}"
        return self.client.generate_presigned_url("get_object", Params={"Bucket": self.bucket, "Key": key}, ExpiresIn=3600)


def make_storage(settings: Settings) -> MediaStorage:
    return S3Storage(settings) if settings.media_bucket else DisabledStorage()
