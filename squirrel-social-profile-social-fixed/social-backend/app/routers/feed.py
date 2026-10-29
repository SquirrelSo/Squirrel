"""Feeds. The server owns filtering; the app only picks which feed and pages with the cursor.

  for_you    every post the viewer may see, newest first
  following  posts by people the viewer follows (accepted) + the viewer's own
  nearby     posts tagged with a city (`?city=` or the viewer's profile city)

Pages are keyset ranges over (created_at DESC, id DESC) backed by ix_posts_created /
ix_posts_city_created, so page 500 costs the same as page 1.
"""

from __future__ import annotations

from fastapi import APIRouter, Query
from sqlalchemy import or_

from app.deps import DB, AppSettings, CurrentViewer, Storage
from app.errors import invalid
from app.models import Post
from app.pagination import before, clamp_limit, decode_uuid_cursor, encode_cursor
from app.rules import CITY_IDS
from app.schemas import FeedKind, FeedResponse
from app.services import social

router = APIRouter(prefix="/v1", tags=["feed"])


@router.get("/feed", response_model=FeedResponse)
def feed(
    db: DB,
    viewer: CurrentViewer,
    settings: AppSettings,
    storage: Storage,
    kind: FeedKind = Query("for_you", alias="feed"),
    city: str | None = None,
    cursor: str | None = None,
    limit: int = 20,
):
    n = clamp_limit(limit)
    stmt = social.posts_query()
    if kind == "following":
        stmt = stmt.where(or_(Post.author_id == viewer.id, Post.author_id.in_(social.followed_ids(viewer.id))))
    else:
        stmt = stmt.where(social.post_visible_clause(viewer.id))
        if kind == "nearby":
            city_id = city or viewer.user.city_id
            if not city_id:
                return FeedResponse(items=[], next_cursor=None)
            if city_id not in CITY_IDS:
                raise invalid("Unknown city.", "invalid_city")
            stmt = stmt.where(Post.city_id == city_id)
    if cursor:
        ts, key = decode_uuid_cursor(cursor)
        stmt = stmt.where(before(Post.created_at, Post.id, ts, key))
    rows = db.execute(stmt.order_by(Post.created_at.desc(), Post.id.desc()).limit(n + 1)).all()
    page = rows[:n]
    nxt = encode_cursor(page[-1][0].created_at, page[-1][0].id) if len(rows) > n else None
    return FeedResponse(items=social.serialize_posts(db, viewer.id, page, settings, storage), next_cursor=nxt)
