import unittest
from datetime import datetime, timezone
from unittest.mock import MagicMock, patch
from uuid import UUID

from assessment_scheduler.schedule_repository import (
    DatabaseConfigurationError,
    save_schedule_snapshot,
)


class ScheduleRepositoryTests(unittest.TestCase):
    def test_postgresql_url_is_required(self) -> None:
        with self.assertRaises(DatabaseConfigurationError):
            save_schedule_snapshot("", "Example", {"schedule": []})

    @patch("assessment_scheduler.schedule_repository.uuid4")
    @patch("assessment_scheduler.schedule_repository._psycopg")
    def test_snapshot_is_inserted_as_jsonb(self, psycopg_factory, make_uuid) -> None:
        schedule_id = UUID("d7430677-4465-4b1f-84dd-c7ff225bb9d6")
        make_uuid.return_value = schedule_id
        created_at = datetime(2026, 10, 9, 10, 30, tzinfo=timezone.utc)

        cursor = MagicMock()
        cursor.fetchone.return_value = (created_at,)
        cursor_context = MagicMock()
        cursor_context.__enter__.return_value = cursor
        connection = MagicMock()
        connection.cursor.return_value = cursor_context
        connection_context = MagicMock()
        connection_context.__enter__.return_value = connection
        psycopg = MagicMock()
        psycopg.connect.return_value = connection_context
        jsonb = MagicMock(side_effect=lambda value: ("jsonb", value))
        psycopg_factory.return_value = (psycopg, jsonb)

        data = {"schema_version": 1, "schedule": [{"Week": 1}]}
        saved = save_schedule_snapshot(
            "postgresql+psycopg://scheduler:test@localhost/scheduler",
            "MBAI5001 schedule",
            data,
        )

        psycopg.connect.assert_called_once_with("postgresql://scheduler:test@localhost/scheduler")
        parameters = cursor.execute.call_args.args[1]
        self.assertEqual(parameters, (schedule_id, "MBAI5001 schedule", ("jsonb", data)))
        self.assertEqual(saved["id"], str(schedule_id))
        self.assertEqual(saved["created_at"], created_at.isoformat())


if __name__ == "__main__":
    unittest.main()
