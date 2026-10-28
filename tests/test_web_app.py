import io
import json
import unittest
from unittest.mock import patch

from app import app
from assessment_scheduler.scaffolding import ScaffoldingEvaluation
from assessment_scheduler.schedule_repository import DatabaseConfigurationError
from assessment_scheduler.unit_outline_ingestion import UnitInformation, WeeklyTopic


class WebAppTests(unittest.TestCase):
    def setUp(self) -> None:
        app.config.update(TESTING=True)
        self.client = app.test_client()

    def test_home_page_serves_html_interface(self) -> None:
        response = self.client.get("/")
        self.assertEqual(response.status_code, 200)
        self.assertIn(b"IQTERRA Assessment Scheduler", response.data)
        self.assertIn(b'id="root"', response.data)
        self.assertIn(b'type="module"', response.data)

    def test_schedule_matrix_includes_assessment_summary_columns(self) -> None:
        response = self.client.get("/static/app.js")
        self.assertEqual(response.status_code, 200)
        self.assertIn(b"Number of Methods", response.data)
        self.assertIn(b"Individual assessments %", response.data)
        self.assertIn(b"Group assessments %", response.data)
        self.assertNotIn(b"Total assessment %", response.data)
        self.assertIn(b"assessmentSelector", response.data)
        self.assertIn(b"sequenceSelector", response.data)
        self.assertIn(b"validationSelector", response.data)
        self.assertIn(b"scheduleMatrixBody", response.data)
        self.assertIn(b"scheduleFullscreenButton", response.data)
        self.assertIn(b"Due after Session", response.data)
        self.assertIn(b"assessmentPartDetails", response.data)
        self.assertIn(b"saveScheduleButton", response.data)
        response.close()

    @patch("app.save_schedule_snapshot")
    def test_step_6_schedule_can_be_saved(self, save_snapshot) -> None:
        save_snapshot.return_value = {
            "id": "d7430677-4465-4b1f-84dd-c7ff225bb9d6",
            "name": "MBAI5001 schedule",
            "created_at": "2026-10-09T10:30:00+11:00",
        }
        payload = {
            "name": "MBAI5001 schedule",
            "course_duration": 12,
            "unit_info": {"unit_code": "MBAI5001", "course_duration": 12},
            "units": [{"unit_code": "MBAI5001", "unit_name": "Digital Transformation"}],
            "items": [{"assessment_name": "Assessment 1", "weight": 100, "due_week": 8}],
            "schedule": [{"Week": week, "Assessments due": "-", "Weight due": 0} for week in range(1, 13)],
        }

        with patch.dict(app.config, {"DATABASE_URL": "postgresql://scheduler:test@localhost/scheduler"}):
            response = self.client.post("/api/schedules", json=payload)

        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.get_json()["id"], "d7430677-4465-4b1f-84dd-c7ff225bb9d6")
        database_url, name, schedule_data = save_snapshot.call_args.args
        self.assertEqual(database_url, "postgresql://scheduler:test@localhost/scheduler")
        self.assertEqual(name, "MBAI5001 schedule")
        self.assertEqual(schedule_data["schema_version"], 1)
        self.assertEqual(schedule_data["items"], payload["items"])
        self.assertEqual(schedule_data["schedule"], payload["schedule"])

    def test_step_6_schedule_requires_generated_data(self) -> None:
        response = self.client.post("/api/schedules", json={"items": [], "schedule": []})
        self.assertEqual(response.status_code, 400)
        self.assertIn("Generate the Step 6 schedule", response.get_json()["error"])

    @patch("app.save_schedule_snapshot")
    def test_step_6_save_reports_missing_database_configuration(self, save_snapshot) -> None:
        save_snapshot.side_effect = DatabaseConfigurationError("Set DATABASE_URL first.")
        response = self.client.post(
            "/api/schedules",
            json={
                "course_duration": 1,
                "unit_info": {},
                "units": [],
                "items": [{"assessment_name": "Assessment 1"}],
                "schedule": [{"Week": 1}],
            },
        )
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.get_json()["error"], "Set DATABASE_URL first.")

    def test_missing_api_route_returns_json_error(self) -> None:
        response = self.client.get("/api/not-a-route")
        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.content_type, "application/json")
        self.assertIn("error", response.get_json())

    @patch("app.extract_pdf_text")
    def test_unit_outline_endpoint_returns_extracted_information(self, extract_pdf_text) -> None:
        extract_pdf_text.return_value = """
        Unit Code and Name MBAI5001 Digital Transformation & Innovation
        Teaching Weeks: 12
        Learning Outcomes
        ULO1 Explain digital transformation
        Weekly Topics
        Week 1: Transformation foundations
        Week 2: Strategy and innovation
        Prerequisite Concepts
        Business fundamentals
        Teaching Activities
        Workshops
        Assessment Information
        Assessment 1: Comparative essay, 30%, due after Session 8
        Breaks / Non-Teaching Weeks
        Week 6 mid-term break
        Scheduling Constraints
        No assessment during Week 6
        """
        response = self.client.post(
            "/api/unit-outline",
            data={
                "extraction_method": "rule-based",
                "file": (io.BytesIO(b"fake-pdf"), "unit-outline.pdf"),
            },
            content_type="multipart/form-data",
        )
        self.assertEqual(response.status_code, 200)
        unit = response.get_json()["unit"]
        self.assertEqual(unit["unit_code"], "MBAI5001")
        self.assertEqual(unit["unit_name"], "Digital Transformation & Innovation")
        self.assertEqual(unit["teaching_weeks"], 12)
        self.assertEqual(unit["course_duration"], 12)
        self.assertEqual(unit["weekly_topics"][0], {"week": "1", "topic": "Transformation foundations"})
        self.assertEqual(
            unit["assessment_information"],
            ["Assessment 1: Comparative essay, 30%, due after Session 8"],
        )
        self.assertEqual(unit["breaks"], ["Week 6 mid-term break"])
        self.assertTrue(extract_pdf_text.call_args.kwargs["preserve_layout"])

    def test_unit_outline_rejects_unsupported_file(self) -> None:
        response = self.client.post(
            "/api/unit-outline",
            data={"file": (io.BytesIO(b"plain text"), "unit-outline.txt")},
            content_type="multipart/form-data",
        )
        self.assertEqual(response.status_code, 415)
        self.assertIn("Only PDF", response.get_json()["error"])

    def test_unit_outline_assessments_can_generate_a_draft_schedule(self) -> None:
        unit = {
            "unit_code": "MBAI5001",
            "unit_name": "Digital Transformation",
            "course_duration": 5,
            "assessment_information": [
                "Assessment 1: Comparative essay, Group, 30%, due after Session 8"
            ],
            "weekly_topics": [
                {"week": "1", "topic": "Transformation foundations"}
            ],
            "source_file": "unit-outline.pdf",
        }
        response = self.client.post(
            "/api/unit-draft",
            json={"unit_info": unit, "units": [unit], "sessions_per_week": 3},
        )

        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        self.assertEqual(data["items"][0]["assessment_name"], "Assessment 1: Comparative essay")
        self.assertEqual(data["items"][0]["assessment_type"], "Group")
        self.assertEqual(data["items"][0]["weight"], 30)
        self.assertEqual(data["items"][0]["due_session"], 8)
        self.assertEqual(data["items"][0]["due_week"], 3)

    def test_unit_outline_due_week_converts_to_last_available_session(self) -> None:
        unit = {
            "unit_code": "MBAI5001",
            "unit_name": "Digital Transformation",
            "assessment_information": [
                "Assessment 1: Final report, 40%, Due date: Week 5"
            ],
            "sessions": [
                {"session": number, "topic": f"Topic {number}"}
                for number in range(1, 14)
            ],
            "source_file": "unit-outline.pdf",
        }

        response = self.client.post(
            "/api/unit-draft",
            json={"unit_info": unit, "units": [unit], "sessions_per_week": 3},
        )

        self.assertEqual(response.status_code, 200)
        item = response.get_json()["items"][0]
        self.assertEqual(item["due_session"], 13)
        self.assertEqual(item["due_week"], 5)

    def test_unit_outline_draft_prefers_labelled_weight_and_due_week(self) -> None:
        unit = {
            "unit_code": "MBAI5001",
            "unit_name": "Digital Transformation",
            "assessment_information": [
                "Assessment 1: Final report; Available Week 2; Pass mark 50%; "
                "Weighting: 30%; Due date: Week 5"
            ],
            "source_file": "unit-outline.pdf",
        }

        response = self.client.post(
            "/api/unit-draft",
            json={"unit_info": unit, "units": [unit], "sessions_per_week": 3},
        )

        self.assertEqual(response.status_code, 200)
        item = response.get_json()["items"][0]
        self.assertEqual(item["weight"], 30)
        self.assertEqual(item["due_session"], 15)
        self.assertEqual(item["due_week"], 5)

    def test_unit_outline_draft_splits_one_assessment_across_sessions(self) -> None:
        unit = {
            "unit_code": "MBAI5001",
            "unit_name": "Digital Transformation",
            "assessment_information": [
                "Assessment 1: Portfolio; 25% is due in Session 2, "
                "25% is due in Session 4 and 50% is due in Session 9"
            ],
            "source_file": "unit-outline.pdf",
        }

        response = self.client.post(
            "/api/unit-draft",
            json={"unit_info": unit, "units": [unit], "sessions_per_week": 3},
        )

        self.assertEqual(response.status_code, 200)
        items = response.get_json()["items"]
        self.assertEqual(len(items), 3)
        self.assertEqual([item["assessment_name"] for item in items], ["Assessment 1: Portfolio"] * 3)
        self.assertEqual([item["component"] for item in items], [
            "Instalment 1",
            "Instalment 2",
            "Instalment 3",
        ])
        self.assertEqual([item["weight"] for item in items], [25, 25, 50])
        self.assertEqual([item["due_session"] for item in items], [2, 4, 9])
        self.assertEqual([item["due_week"] for item in items], [1, 2, 3])

    @patch("app.extract_docx_text")
    def test_unit_outline_endpoint_accepts_docx(self, extract_docx_text) -> None:
        extract_docx_text.return_value = """
        Unit Code and Name MBAI5001 Digital Transformation
        Teaching Weeks: 12
        Weekly Topics
        Week 1: Transformation foundations
        """
        response = self.client.post(
            "/api/unit-outline",
            data={"file": (io.BytesIO(b"fake-docx"), "unit-outline.docx")},
            content_type="multipart/form-data",
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["unit"]["unit_code"], "MBAI5001")
        extract_docx_text.assert_called_once_with(b"fake-docx")

    @patch("app.extract_pdf_text")
    def test_unit_outline_endpoint_combines_multiple_outlines(self, extract_pdf_text) -> None:
        extract_pdf_text.side_effect = [
            """
            Unit Code and Name MBAI5001 Digital Transformation
            Teaching Weeks: 10
            Learning Outcomes
            ULO1 Explain digital transformation
            Weekly Topics
            Week 1: Transformation foundations
            """,
            """
            Unit Code and Name MBAI5002 Applied Analytics
            Teaching Weeks: 12
            Learning Outcomes
            ULO1 Apply analytics methods
            Weekly Topics
            Week 2: Analytics foundations
            """,
        ]
        response = self.client.post(
            "/api/unit-outline",
            data={
                "extraction_method": "rule-based",
                "files": [
                    (io.BytesIO(b"first-pdf"), "first-outline.pdf"),
                    (io.BytesIO(b"second-pdf"), "second-outline.pdf"),
                ],
            },
            content_type="multipart/form-data",
        )

        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        self.assertEqual(len(data["units"]), 2)
        self.assertEqual(data["unit"]["unit_code"], "MBAI5001, MBAI5002")
        self.assertEqual(data["unit"]["course_duration"], 12)
        self.assertEqual(
            data["unit"]["weekly_topics"],
            [
                {"week": "1", "topic": "MBAI5001: Transformation foundations"},
                {"week": "2", "topic": "MBAI5002: Analytics foundations"},
            ],
        )
        self.assertEqual(extract_pdf_text.call_count, 2)

    @patch("app.extract_pdf_text")
    def test_unit_outlines_with_same_code_are_grouped_together(self, extract_pdf_text) -> None:
        extract_pdf_text.side_effect = [
            """
            Unit Code and Name MBAI5001 Digital Transformation
            Teaching Weeks: 12
            Weekly Topics
            Week 1: Transformation foundations
            """,
            """
            Unit Code and Name MBAI5001 Digital Transformation
            Teaching Weeks: 12
            Weekly Topics
            Week 2: Strategy and innovation
            """,
        ]
        response = self.client.post(
            "/api/unit-outline",
            data={
                "files": [
                    (io.BytesIO(b"first-pdf"), "first-outline.pdf"),
                    (io.BytesIO(b"second-pdf"), "second-outline.pdf"),
                ],
            },
            content_type="multipart/form-data",
        )

        self.assertEqual(response.status_code, 200)
        units = response.get_json()["units"]
        self.assertEqual(len(units), 1)
        self.assertEqual(units[0]["unit_code"], "MBAI5001")
        self.assertEqual(units[0]["source_file"], "first-outline.pdf, second-outline.pdf")
        self.assertEqual([topic["week"] for topic in units[0]["weekly_topics"]], ["1", "2"])

    @patch("app.extract_pdf_text", return_value="Weekly Topics\nWeek 1: Security foundations")
    @patch("app.parse_unit_outline_text_with_ollama")
    @patch("app.parse_unit_outline_text")
    def test_unit_outline_recovers_weekly_topics_when_ollama_omits_them(
        self,
        parse_rules,
        parse_ollama,
        _extract_pdf_text,
    ) -> None:
        parse_ollama.return_value = UnitInformation(
            unit_code="CYB601A",
            unit_name="Cyber Security",
            teaching_weeks=12,
            course_duration=12,
        )
        parse_rules.return_value = UnitInformation(
            weekly_topics=[WeeklyTopic(week="1", topic="Security foundations")]
        )

        response = self.client.post(
            "/api/unit-outline",
            data={
                "extraction_method": "ollama",
                "file": (io.BytesIO(b"fake-pdf"), "unit-outline.pdf"),
            },
            content_type="multipart/form-data",
        )

        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        self.assertEqual(
            data["unit"]["weekly_topics"],
            [{"week": "1", "topic": "Security foundations"}],
        )
        self.assertTrue(any("rule-based weekly-topic" in warning for warning in data["warnings"]))

    @patch("app.extract_pdf_text")
    def test_generate_endpoint_returns_schedule(self, extract_pdf_text) -> None:
        extract_pdf_text.return_value = """
        Subject Code and Name MBAI5001 Digital Transformation & Innovation
        Assessment Assessment 2: Critical Comparative Essay
        Assessment Type Individual
        Assessment Details Compare two industries.
        Assessment Weight 30%
        Word Count 1,500 words
        Submission Date Week 8
        Minimum Sources At least 12 sources
        """
        response = self.client.post(
            "/api/generate",
            data={
                "extraction_method": "rule-based",
                "files": (io.BytesIO(b"fake-pdf"), "assessment.pdf"),
            },
            content_type="multipart/form-data",
        )
        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        self.assertEqual(data["items"][0]["due_week"], 8)
        self.assertEqual(data["schedule"][7]["Weight due"], 30)

    @patch("app.evaluate_scaffolding_with_ollama")
    @patch("app.extract_pdf_text")
    def test_detailed_schedule_uses_ollama_and_retains_outline_timing(
        self,
        extract_pdf_text,
        evaluate_scaffolding,
    ) -> None:
        extract_pdf_text.return_value = """
        Subject Code and Name MBAI5001 Digital Transformation & Innovation
        Assessment Assessment 2: Critical Comparative Essay
        Assessment Type Individual
        Assessment Details Compare two industries.
        Assessment Weight 30%
        Submission Date Week 5
        Required Topics Strategic analysis
        """
        evaluate_scaffolding.return_value = [
            ScaffoldingEvaluation(
                assessment_name="Assessment 2: Critical Comparative Essay",
                component="Whole assessment",
                status="success",
                label="Covered",
                rationale="The topic is covered before submission.",
                topic_readiness="Ready",
                matched_topics=[{"week": 1, "topic": "Strategic analysis"}],
            )
        ]
        existing_items = [{
            "subject_code": "MBAI5001",
            "subject_name": "Digital Transformation & Innovation",
            "assessment_name": "Assessment 2: Critical Comparative Essay",
            "component": "Whole assessment",
            "assessment_type": "Individual",
            "weight": 30,
            "due_week": 2,
            "due_session": 5,
        }]

        response = self.client.post(
            "/api/generate",
            data={
                "files": (io.BytesIO(b"fake-pdf"), "assessment.pdf"),
                "unit_info": json.dumps({
                    "course_duration": 5,
                    "weekly_topics": [{"week": "1", "topic": "Strategic analysis"}],
                }),
                "existing_items": json.dumps(existing_items),
                "sessions_per_week": "3",
                "extraction_method": "rule-based",
                "require_ollama_scaffolding": "true",
                "ollama_model": "gemma4",
            },
            content_type="multipart/form-data",
        )

        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        self.assertEqual(data["items"][0]["due_session"], 5)
        self.assertEqual(data["items"][0]["due_week"], 2)
        self.assertEqual(data["schedule"][1]["Weight due"], 30)
        self.assertEqual(data["scaffolding_source"], "ollama")
        evaluate_scaffolding.assert_called_once()

    @patch("app.extract_pdf_text")
    def test_generate_endpoint_preserves_explicit_due_session(self, extract_pdf_text) -> None:
        extract_pdf_text.return_value = """
        Subject Code and Name MBAI5001 Digital Transformation & Innovation
        Assessment Assessment 2: Critical Comparative Essay
        Assessment Type Individual
        Assessment Details Compare two industries.
        Assessment Weight 30%
        Word Count 1,500 words
        Submission Date Session 5
        Minimum Sources At least 12 sources
        """
        response = self.client.post(
            "/api/generate",
            data={
                "extraction_method": "rule-based",
                "sessions_per_week": "3",
                "files": (io.BytesIO(b"fake-pdf"), "assessment.pdf"),
            },
            content_type="multipart/form-data",
        )

        self.assertEqual(response.status_code, 200)
        item = response.get_json()["items"][0]
        self.assertEqual(item["due_session"], 5)
        self.assertEqual(item["due_week"], 2)

    @patch("app.extract_docx_text")
    def test_generate_endpoint_accepts_docx(self, extract_docx_text) -> None:
        extract_docx_text.return_value = """
        Subject Code and Name MBAI5001 Digital Transformation & Innovation
        Assessment Assessment 2: Critical Comparative Essay
        Assessment Type Individual
        Assessment Details Compare two industries.
        Assessment Weight 30%
        Word Count 1,500 words
        Submission Date Week 8
        Minimum Sources At least 12 sources
        """
        response = self.client.post(
            "/api/generate",
            data={"files": (io.BytesIO(b"fake-docx"), "assessment.docx")},
            content_type="multipart/form-data",
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["items"][0]["source_file"], "assessment.docx")
        extract_docx_text.assert_called_once_with(b"fake-docx")

    @patch("app.extract_pdf_text")
    def test_generate_matches_assessment_to_uploaded_unit_code(self, extract_pdf_text) -> None:
        extract_pdf_text.return_value = """
        Subject Code and Name CYB601A Cyber Security
        Assessment Assessment 1: Security Report
        Assessment Type Individual
        Assessment Details Review the security posture.
        Assessment Weight 30%
        Submission Date Week 6
        Assessment Criteria Refer to rubric
        """
        response = self.client.post(
            "/api/generate",
            data={
                "files": (io.BytesIO(b"fake-pdf"), "security-assessment.pdf"),
                "units": json.dumps([
                    {"unit_code": "MBAI5001", "unit_name": "Digital Transformation"},
                    {"unit_code": "CYB601A", "unit_name": "Cyber Security"},
                ]),
            },
            content_type="multipart/form-data",
        )

        self.assertEqual(response.status_code, 200)
        item = response.get_json()["items"][0]
        self.assertEqual(item["subject_code"], "CYB601A")
        self.assertEqual(item["subject_name"], "Cyber Security")

    def test_generate_endpoint_rejects_unsupported_assessment(self) -> None:
        response = self.client.post(
            "/api/generate",
            data={"files": (io.BytesIO(b"plain text"), "assessment.txt")},
            content_type="multipart/form-data",
        )
        self.assertEqual(response.status_code, 415)
        self.assertIn("Only PDF", response.get_json()["error"])

    def test_analyze_endpoint_recalculates_edited_items(self) -> None:
        response = self.client.post(
            "/api/analyze",
            json={
                "items": [
                    {
                        "subject_code": "MBAI5001",
                        "subject_name": "Digital Transformation & Innovation",
                        "assessment_name": "Assessment 1",
                        "component": "Whole assessment",
                        "assessment_type": "Individual",
                        "weight": 100,
                        "due_session": 13,
                        "due_week": 13,
                        "source_file": "assessment.pdf",
                        "raw_due_text": "Week 13",
                    }
                ]
            },
        )
        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        self.assertEqual(data["items"][0]["due_session"], 13)
        titles = [item["title"] for item in data["feedback"]]
        self.assertIn("Submission outside the course", titles)

    def test_analyze_endpoint_uses_extracted_course_duration(self) -> None:
        response = self.client.post(
            "/api/analyze",
            json={
                "unit_info": {"course_duration": 10},
                "items": [
                    {
                        "assessment_name": "Assessment 1",
                        "component": "Whole assessment",
                        "assessment_type": "Individual",
                        "weight": 100,
                        "due_week": 11,
                    }
                ],
            },
        )
        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        self.assertEqual(data["course_duration"], 10)
        self.assertEqual(len(data["schedule"]), 10)
        self.assertIn("Submission outside the course", [item["title"] for item in data["feedback"]])

    def test_analyze_endpoint_returns_validation_per_subject(self) -> None:
        response = self.client.post(
            "/api/analyze",
            json={
                "items": [
                    {
                        "subject_code": "MBAI5001",
                        "subject_name": "Digital Transformation",
                        "assessment_name": "Assessment 1",
                        "component": "Whole assessment",
                        "assessment_type": "Individual",
                        "weight": 100,
                        "due_week": 5,
                    },
                    {
                        "subject_code": "MBAI5002",
                        "subject_name": "Applied Analytics",
                        "assessment_name": "Assessment 1",
                        "component": "Whole assessment",
                        "assessment_type": "Individual",
                        "weight": 100,
                        "due_week": 6,
                    },
                ]
            },
        )

        self.assertEqual(response.status_code, 200)
        feedback = response.get_json()["feedback"]
        self.assertEqual({item["subject_code"] for item in feedback}, {"MBAI5001", "MBAI5002"})
        weighting_results = [item for item in feedback if item["title"] == "Weighting totals 100%"]
        self.assertEqual(len(weighting_results), 2)
        self.assertFalse(any("200%" in item["message"] for item in feedback))

    def test_analyze_endpoint_sorts_assessments_by_number(self) -> None:
        def item(name: str, component: str) -> dict[str, object]:
            return {
                "assessment_name": name,
                "component": component,
                "assessment_type": "Individual",
                "weight": 20,
                "due_week": 5,
            }

        response = self.client.post(
            "/api/analyze",
            json={
                "items": [
                    item("Assessment 3: Case Study", "Report"),
                    item("Assessment 3: Case Study", "Presentation"),
                    item("Assessment 2: Report", "Whole assessment"),
                    item("Assessment 1: Online Quizzes", "Quiz 1"),
                    item("Assessment 1: Online Quizzes", "Quiz 2"),
                ]
            },
        )

        self.assertEqual(response.status_code, 200)
        rows = response.get_json()["items"]
        self.assertEqual(
            [(row["assessment_name"], row["component"]) for row in rows],
            [
                ("Assessment 1: Online Quizzes", "Quiz 1"),
                ("Assessment 1: Online Quizzes", "Quiz 2"),
                ("Assessment 2: Report", "Whole assessment"),
                ("Assessment 3: Case Study", "Report"),
                ("Assessment 3: Case Study", "Presentation"),
            ],
        )
        self.assertEqual(
            [value["assessment_name"] for value in response.get_json()["scaffolding"]],
            [row["assessment_name"] for row in rows],
        )

    def test_optimize_endpoint_moves_invalid_and_overloaded_weeks(self) -> None:
        response = self.client.post(
            "/api/optimize",
            json={
                "unit_info": {"breaks": ["Week 6 mid-term break"]},
                "items": [
                    {
                        "assessment_name": "Assessment 1",
                        "component": "Whole assessment",
                        "assessment_type": "Individual",
                        "weight": 30,
                        "due_week": 6,
                    },
                    {
                        "assessment_name": "Assessment 2",
                        "component": "Whole assessment",
                        "assessment_type": "Individual",
                        "weight": 30,
                        "due_week": 13,
                    },
                ],
            },
        )
        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        due_weeks = [item["due_week"] for item in data["items"]]
        self.assertTrue(all(1 <= week <= 12 and week != 6 for week in due_weeks))
        self.assertTrue(data["changes"])

    def test_analyze_endpoint_flags_non_teaching_week(self) -> None:
        response = self.client.post(
            "/api/analyze",
            json={
                "unit_info": {"breaks": ["Week 6 mid-term break"]},
                "items": [
                    {
                        "assessment_name": "Assessment 1",
                        "component": "Whole assessment",
                        "assessment_type": "Individual",
                        "weight": 100,
                        "due_week": 6,
                    }
                ],
            },
        )
        self.assertEqual(response.status_code, 200)
        titles = [item["title"] for item in response.get_json()["feedback"]]
        self.assertIn("Submission scheduled in a non-teaching week", titles)

    @patch("app.evaluate_scaffolding_with_ollama")
    def test_analyze_endpoint_uses_ollama_for_scaffolding(self, evaluate) -> None:
        evaluate.return_value = [
            ScaffoldingEvaluation(
                assessment_name="Assessment 1",
                component="Whole assessment",
                status="success",
                label="Covered",
                rationale="The model found suitable preparation before submission.",
                topic_readiness="Content ready by Week 2",
                matched_topics=[{"week": 2, "topic": "Security foundations"}],
            )
        ]

        response = self.client.post(
            "/api/analyze",
            json={
                "extraction_method": "ollama",
                "ollama_host": "http://localhost:11434",
                "ollama_model": "gemma4",
                "unit_info": {
                    "weekly_topics": [
                        {"week": "2", "topic": "Security foundations"}
                    ]
                },
                "items": [
                    {
                        "assessment_name": "Assessment 1",
                        "component": "Whole assessment",
                        "assessment_type": "Quiz",
                        "weight": 20,
                        "due_week": 4,
                        "required_topics_skills": ["Security foundations"],
                    }
                ],
            },
        )

        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        self.assertEqual(data["scaffolding_source"], "ollama")
        self.assertEqual(data["scaffolding_model"], "gemma4")
        self.assertEqual(data["scaffolding"][0]["label"], "Covered")
        evaluate.assert_called_once()


if __name__ == "__main__":
    unittest.main()
