from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import Any
from uuid import uuid4


class DatabaseConfigurationError(RuntimeError):
    """Raised when schedule persistence has not been configured."""


class DatabaseOperationError(RuntimeError):
    """Raised when PostgreSQL cannot complete a persistence operation."""


def _database_url(value: str | None) -> str:
    database_url = str(value or "").strip()
    if not database_url:
        raise DatabaseConfigurationError(
            "Schedule saving is not configured. Set DATABASE_URL and run the database initializer."
        )
    if database_url.startswith("postgresql+psycopg://"):
        database_url = database_url.replace("postgresql+psycopg://", "postgresql://", 1)
    if not database_url.startswith(("postgresql://", "postgres://")):
        raise DatabaseConfigurationError("DATABASE_URL must be a PostgreSQL connection URL.")
    return database_url


def _psycopg():
    try:
        import psycopg
        from psycopg.types.json import Jsonb
    except ImportError as exc:
        raise DatabaseConfigurationError(
            "The PostgreSQL driver is not installed. Run 'uv sync' before saving schedules."
        ) from exc
    return psycopg, Jsonb


def initialise_schedule_database(database_url: str | None) -> None:
    psycopg, _ = _psycopg()
    migration_path = Path(__file__).resolve().parent.parent / "migrations" / "001_create_saved_schedules.sql"
    migration_sql = migration_path.read_text(encoding="utf-8")
    try:
        with psycopg.connect(_database_url(database_url)) as connection:
            with connection.cursor() as cursor:
                cursor.execute(migration_sql)
    except DatabaseConfigurationError:
        raise
    except Exception as exc:
        raise DatabaseOperationError("PostgreSQL could not initialise schedule storage.") from exc


def save_schedule_snapshot(
    database_url: str | None,
    name: str,
    schedule_data: dict[str, Any],
) -> dict[str, str]:
    psycopg, Jsonb = _psycopg()
    schedule_id = uuid4()
    try:
        with psycopg.connect(_database_url(database_url)) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    INSERT INTO saved_schedules (id, name, schedule_data)
                    VALUES (%s, %s, %s)
                    RETURNING created_at
                    """,
                    (schedule_id, name, Jsonb(schedule_data)),
                )
                created_at = cursor.fetchone()[0]
    except DatabaseConfigurationError:
        raise
    except Exception as exc:
        raise DatabaseOperationError("PostgreSQL could not save the generated schedule.") from exc

    if isinstance(created_at, datetime):
        created_at_value = created_at.isoformat()
    else:
        created_at_value = str(created_at)
    return {"id": str(schedule_id), "name": name, "created_at": created_at_value}
