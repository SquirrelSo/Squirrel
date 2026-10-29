"""Profile + Social: users, stats, follows, activities, media, posts, likes, saves, comments, badges.

Revision ID: 0001_profile_social
Revises:
Create Date: 2026-09-28

Why each table exists:
  users          one profile per account (JWT sub), public UUID id, no email/password stored
  user_stats     hot counters + cached Run Module XP, kept off the profile row
  follows        follow graph; PK prevents duplicates, CHECK prevents self-follow
  activities     summaries of completed workouts, unique per (source, source_ref) so a run
                 can't be duplicated; no GPS
  media          object-storage references for uploaded photos
  posts          normalised: activity / media are references, counters denormalised
  post_likes / post_saves / comments   engagement, cascade-deleted with the post
  badges / user_badges                 catalogue + awards (seeded below)
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

from app.db import UTCDateTime
from app.models import BADGE_CATALOGUE

revision = "0001_profile_social"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "users",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("auth_subject", sa.String(255), nullable=False, unique=True),
        sa.Column("username", sa.String(20), nullable=False, unique=True),
        sa.Column("username_confirmed", sa.Boolean(), nullable=False),
        sa.Column("display_name", sa.String(40), nullable=False),
        sa.Column("bio", sa.String(160), nullable=False),
        sa.Column("city_id", sa.String(32)),
        sa.Column("area", sa.String(60)),
        sa.Column("college", sa.String(80)),
        sa.Column("interests", sa.JSON(), nullable=False),
        sa.Column("avatar_look", sa.JSON()),
        sa.Column("avatar_media_id", sa.Uuid()),
        sa.Column("visibility", sa.String(16), nullable=False),
        sa.Column("role", sa.String(16), nullable=False),
        sa.Column("verified", sa.Boolean(), nullable=False),
        sa.Column("created_at", UTCDateTime(), nullable=False),
        sa.Column("updated_at", UTCDateTime(), nullable=False),
        sa.CheckConstraint("visibility IN ('public', 'private')", name="ck_users_visibility"),
        sa.CheckConstraint("role IN ('user', 'moderator', 'admin')", name="ck_users_role"),
    )
    op.create_index("ix_users_city_created", "users", ["city_id", "created_at"])

    op.create_table(
        "user_stats",
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("followers_count", sa.Integer(), nullable=False),
        sa.Column("following_count", sa.Integer(), nullable=False),
        sa.Column("posts_count", sa.Integer(), nullable=False),
        sa.Column("xp", sa.Integer(), nullable=False),
        sa.Column("xp_synced_at", UTCDateTime()),
        sa.CheckConstraint("followers_count >= 0 AND following_count >= 0 AND posts_count >= 0", name="ck_user_stats_nonneg"),
    )

    op.create_table(
        "follows",
        sa.Column("follower_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("followee_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("created_at", UTCDateTime(), nullable=False),
        sa.PrimaryKeyConstraint("follower_id", "followee_id", name="pk_follows"),
        sa.CheckConstraint("follower_id <> followee_id", name="ck_follows_not_self"),
        sa.CheckConstraint("status IN ('accepted', 'pending')", name="ck_follows_status"),
    )
    op.create_index("ix_follows_follower", "follows", ["follower_id", "status", "created_at"])
    op.create_index("ix_follows_followee", "follows", ["followee_id", "status", "created_at"])

    op.create_table(
        "activities",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("type", sa.String(16), nullable=False),
        sa.Column("source", sa.String(24), nullable=False),
        sa.Column("source_ref", sa.String(128)),
        sa.Column("verified", sa.Boolean(), nullable=False),
        sa.Column("name", sa.String(60)),
        sa.Column("distance_m", sa.Integer()),
        sa.Column("duration_s", sa.Integer()),
        sa.Column("calories", sa.Integer()),
        sa.Column("metrics", sa.JSON(), nullable=False),
        sa.Column("started_at", UTCDateTime(), nullable=False),
        sa.Column("created_at", UTCDateTime(), nullable=False),
        sa.UniqueConstraint("source", "source_ref", name="uq_activities_source_ref"),
        sa.CheckConstraint("type IN ('run', 'ride', 'workout', 'yoga', 'meal')", name="ck_activities_type"),
        sa.CheckConstraint("source IN ('run_module', 'exercise', 'manual')", name="ck_activities_source"),
    )
    op.create_index("ix_activities_user_started", "activities", ["user_id", "started_at"])

    op.create_table(
        "media",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("owner_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("purpose", sa.String(16), nullable=False),
        sa.Column("content_type", sa.String(64), nullable=False),
        sa.Column("byte_size", sa.Integer(), nullable=False),
        sa.Column("storage_key", sa.String(255), nullable=False, unique=True),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("created_at", UTCDateTime(), nullable=False),
        sa.CheckConstraint("purpose IN ('post', 'avatar')", name="ck_media_purpose"),
        sa.CheckConstraint("status IN ('pending', 'ready')", name="ck_media_status"),
    )
    op.create_index("ix_media_owner", "media", ["owner_id", "created_at"])
    # users ↔ media reference each other, so this FK is added once both exist.
    with op.batch_alter_table("users") as batch:
        batch.create_foreign_key("fk_users_avatar_media", "media", ["avatar_media_id"], ["id"], ondelete="SET NULL")

    op.create_table(
        "posts",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("author_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("caption", sa.String(280), nullable=False),
        sa.Column("activity_id", sa.Uuid(), sa.ForeignKey("activities.id", ondelete="SET NULL"), unique=True),
        sa.Column("media_id", sa.Uuid(), sa.ForeignKey("media.id", ondelete="SET NULL")),
        sa.Column("city_id", sa.String(32)),
        sa.Column("area", sa.String(60)),
        sa.Column("backdrop_scene", sa.String(24), nullable=False),
        sa.Column("backdrop_seed", sa.SmallInteger(), nullable=False),
        sa.Column("sticker", sa.String(24)),
        sa.Column("crew_name", sa.String(60)),
        sa.Column("likes_count", sa.Integer(), nullable=False),
        sa.Column("comments_count", sa.Integer(), nullable=False),
        sa.Column("created_at", UTCDateTime(), nullable=False),
        sa.CheckConstraint("likes_count >= 0 AND comments_count >= 0", name="ck_posts_counts_nonneg"),
    )
    op.create_index("ix_posts_created", "posts", ["created_at", "id"])
    op.create_index("ix_posts_author_created", "posts", ["author_id", "created_at", "id"])
    op.create_index("ix_posts_city_created", "posts", ["city_id", "created_at", "id"])

    op.create_table(
        "post_likes",
        sa.Column("post_id", sa.Uuid(), sa.ForeignKey("posts.id", ondelete="CASCADE"), nullable=False),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("created_at", UTCDateTime(), nullable=False),
        sa.PrimaryKeyConstraint("post_id", "user_id", name="pk_post_likes"),
    )
    op.create_index("ix_post_likes_user", "post_likes", ["user_id", "created_at"])

    op.create_table(
        "post_saves",
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("post_id", sa.Uuid(), sa.ForeignKey("posts.id", ondelete="CASCADE"), nullable=False),
        sa.Column("created_at", UTCDateTime(), nullable=False),
        sa.PrimaryKeyConstraint("user_id", "post_id", name="pk_post_saves"),
    )
    op.create_index("ix_post_saves_user_created", "post_saves", ["user_id", "created_at", "post_id"])

    op.create_table(
        "comments",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("post_id", sa.Uuid(), sa.ForeignKey("posts.id", ondelete="CASCADE"), nullable=False),
        sa.Column("author_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("body", sa.String(500), nullable=False),
        sa.Column("created_at", UTCDateTime(), nullable=False),
    )
    op.create_index("ix_comments_post_created", "comments", ["post_id", "created_at", "id"])

    badges = op.create_table(
        "badges",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("kind", sa.String(32), nullable=False),
        sa.Column("title", sa.String(60), nullable=False),
        sa.Column("description", sa.String(160), nullable=False),
    )
    op.create_table(
        "user_badges",
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("badge_id", sa.String(32), sa.ForeignKey("badges.id", ondelete="CASCADE"), nullable=False),
        sa.Column("awarded_at", UTCDateTime(), nullable=False),
        sa.PrimaryKeyConstraint("user_id", "badge_id", name="pk_user_badges"),
    )
    op.bulk_insert(badges, BADGE_CATALOGUE)


def downgrade() -> None:
    for table in ("user_badges", "badges", "comments", "post_saves", "post_likes", "posts"):
        op.drop_table(table)
    with op.batch_alter_table("users") as batch:
        batch.drop_constraint("fk_users_avatar_media", type_="foreignkey")
    for table in ("media", "activities", "follows", "user_stats", "users"):
        op.drop_table(table)
