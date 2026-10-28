import json
import unittest
from unittest.mock import patch

from assessment_scheduler.unit_outline_ingestion import (
    parse_unit_outline_text,
    parse_unit_outline_text_with_ollama,
)


class UnitOutlineIngestionTests(unittest.TestCase):
    def test_rule_extraction_reads_all_workflow_fields(self) -> None:
        text = """
Unit Code and Name MBAI5001 Digital Transformation & Innovation
Teaching Weeks: 12
Learning Outcomes
ULO1 Explain digital transformation
ULO2 Design an innovation proposal
Weekly Topics
Week 1: Transformation foundations
Week 2: Strategy and innovation
Prerequisite Concepts
Business fundamentals
Teaching Activities
Seminars
Applied workshops
Assessment Information
Assessment 1: Innovation proposal, Individual, 40%, due after Session 8
Breaks / Non-Teaching Weeks
Week 6 mid-term break
Scheduling Constraints
Assessments cannot be due in Week 6
"""
        unit = parse_unit_outline_text(text, "unit.pdf")

        self.assertEqual(unit.unit_code, "MBAI5001")
        self.assertEqual(unit.unit_name, "Digital Transformation & Innovation")
        self.assertEqual(unit.teaching_weeks, 12)
        self.assertEqual(unit.course_duration, 12)
        self.assertEqual(len(unit.learning_outcomes), 2)
        self.assertEqual([topic.week for topic in unit.weekly_topics], ["1", "2"])
        self.assertEqual(unit.prerequisite_concepts, ["Business fundamentals"])
        self.assertEqual(unit.teaching_activities, ["Seminars", "Applied workshops"])
        self.assertEqual(
            unit.assessment_information,
            ["Assessment 1: Innovation proposal, Individual, 40%, due after Session 8"],
        )
        self.assertEqual(unit.breaks, ["Week 6 mid-term break"])
        self.assertEqual(unit.scheduling_constraints, ["Assessments cannot be due in Week 6"])

    def test_rule_extraction_reads_numbered_outline_and_separate_identity_fields(self) -> None:
        text = """
Unit Code MBAI5001
Unit Name Digital Transformation & Innovation
Teaching Period Weeks 1-12
3. Learning Outcomes
SLO1: Explain digital transformation
4. Weekly Topics and Learning Sequence
Week Topic
1 AI, Data & Digital Twins
2 IoT, Hardware & Digital Trends
5. Prerequisite Concepts
Business strategy
6. Teaching Activities
Lectures and workshops
7. Breaks / Non-Teaching Weeks
Week 7 - Consolidation
8. Assessment Schedule
Assessment 1 Week 9
9. Scheduling Constraints
No major assessment in Week 7
10. Learning Dependency Map
AI -> IoT
"""
        unit = parse_unit_outline_text(text, "numbered-unit.pdf")

        self.assertEqual(unit.unit_code, "MBAI5001")
        self.assertEqual(unit.unit_name, "Digital Transformation & Innovation")
        self.assertEqual(unit.teaching_weeks, 12)
        self.assertEqual(unit.course_duration, 12)
        self.assertEqual([topic.week for topic in unit.weekly_topics], ["1", "2"])
        self.assertEqual(unit.breaks, ["Week 7 - Consolidation"])
        self.assertEqual(unit.assessment_information, ["Assessment 1 Week 9"])
        self.assertNotIn("Assessment 1 Week 9", unit.breaks)

    def test_rule_extraction_groups_assessment_table_cells_by_task(self) -> None:
        text = """
Unit Code MBAI5001
Assessment Information
Assessment task
Weighting
Due date
Assessment 1: Research proposal
Individual
Weighting: 30%
Available Week 2
Due date: Week 5
Assessment 2: Final report
Group
Weighting: 70%
Due date: Week 11
Scheduling Constraints
No submissions during the break
"""

        unit = parse_unit_outline_text(text, "table-unit.pdf")

        self.assertEqual(
            unit.assessment_information,
            [
                "Assessment 1: Research proposal; Individual; Weighting: 30%; "
                "Available Week 2; Due date: Week 5",
                "Assessment 2: Final report; Group; Weighting: 70%; Due date: Week 11",
            ],
        )

    def test_course_duration_uses_explicit_value_or_highest_scheduled_week(self) -> None:
        explicit = parse_unit_outline_text(
            "Teaching Weeks: 11\nCourse Duration: 14 weeks\nWeek 12: Examination",
        )
        inferred = parse_unit_outline_text(
            "Teaching Weeks: 11\nWeekly Topics\nWeek 12: Examination",
        )

        self.assertEqual(explicit.teaching_weeks, 11)
        self.assertEqual(explicit.course_duration, 14)
        self.assertEqual(inferred.course_duration, 12)

    @patch("assessment_scheduler.unit_outline_ingestion._request_json")
    def test_targeted_model_pass_recovers_omitted_weekly_topics(self, request_json) -> None:
        request_json.side_effect = [
            {
                "message": {
                    "content": json.dumps({
                        "unit_code": "CYB601A",
                        "unit_name": "Cyber Security",
                        "teaching_weeks": 12,
                        "course_duration": 12,
                        "learning_outcomes": ["Evaluate cyber security controls"],
                        "weekly_topics": [],
                        "prerequisite_concepts": [],
                        "teaching_activities": [],
                        "breaks": [],
                        "scheduling_constraints": [],
                    })
                }
            },
            {
                "message": {
                    "content": json.dumps({
                        "weekly_topics": [
                            {"week": "1", "topic": "Threat landscape"},
                            {"week": "2", "topic": "Social engineering"},
                        ]
                    })
                }
            },
        ]

        unit = parse_unit_outline_text_with_ollama(
            "Course schedule\nWeek 1 Threat landscape\nWeek 2 Social engineering"
        )

        self.assertEqual(
            [(topic.week, topic.topic) for topic in unit.weekly_topics],
            [("1", "Threat landscape"), ("2", "Social engineering")],
        )
        self.assertEqual(request_json.call_count, 2)
        targeted_prompt = request_json.call_args_list[1].kwargs["payload"]["messages"][1]["content"]
        self.assertIn("weekly class topics", targeted_prompt)


if __name__ == "__main__":
    unittest.main()
