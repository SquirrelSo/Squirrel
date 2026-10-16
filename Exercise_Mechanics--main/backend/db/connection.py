"""Database connection settings."""

from __future__ import annotations

import os
import threading
from collections.abc import Iterator
from contextlib import contextmanager

import psycopg
from psycopg_pool import ConnectionPool

CONNECT_TIMEOUT_S = 3  # a down database must not stall a request or a training socket for long
POOL_MAX_SIZE = 5      # well under a Supabase session pooler's per-database limit
POOL_WAIT_S = 5        # how long a request waits for a connection before failing (e.g. database down)


def database_url() -> str | None:
    """The DATABASE_URL, or None when the database is not configured."""
    url = os.environ.get("DATABASE_URL", "").strip()
    return url or None


def enabled() -> bool:
    return database_url() is not None


def connect() -> psycopg.Connection:
    url = database_url()
    if url is None:
        raise RuntimeError("DATABASE_URL is not set")
    return psycopg.connect(url, connect_timeout=CONNECT_TIMEOUT_S)


_pools: dict[str, ConnectionPool] = {}
_pools_lock = threading.Lock()


def _pool() -> ConnectionPool:
    url = database_url()
    if url is None:
        raise RuntimeError("DATABASE_URL is not set")
    with _pools_lock:
        pool = _pools.get(url)
        if pool is None:
            pool = ConnectionPool(
                url, min_size=0, max_size=POOL_MAX_SIZE, timeout=POOL_WAIT_S, open=True,
                kwargs={"connect_timeout": CONNECT_TIMEOUT_S},
                # A hosted database drops idle connections; check each one before handing it out.
                check=ConnectionPool.check_connection,
            )
            _pools[url] = pool
        return pool


@contextmanager
def pooled() -> Iterator[psycopg.Connection]:
    """A reused connection for request-path queries (accounts, profiles). Commits when the block
    ends, rolls back if it raises."""
    with _pool().connection() as conn:
        yield conn


def close_pools() -> None:
    with _pools_lock:
        for pool in _pools.values():
            pool.close()
        _pools.clear()
