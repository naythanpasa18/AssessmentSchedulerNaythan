import io
import unittest
import zipfile

from assessment_scheduler.feedback import analyse_schedule, weekly_schedule
from assessment_scheduler.models import AssessmentItem
from assessment_scheduler.pdf_ingestion import extract_docx_text, parse_assessment_text


HEADER = """
Program Master of Business Administration with Artificial Intelligence
Subject Code and Name MBAI5001 Digital Transformation & Innovation
"""


class IngestionTests(unittest.TestCase):
    def test_docx_text_extraction_reads_paragraphs_and_tables(self) -> None:
        document = io.BytesIO()
        with zipfile.ZipFile(document, "w") as archive:
            archive.writestr(
                "word/document.xml",
                """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
                <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
                  <w:body>
                    <w:p><w:r><w:t>Unit Code MBAI5001</w:t></w:r></w:p>
                    <w:tbl><w:tr><w:tc><w:p><w:r><w:t>Week 1</w:t></w:r></w:p></w:tc>
                    <w:tc><w:p><w:r><w:t>Foundations</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
                  </w:body>
                </w:document>""",
            )

        self.assertEqual(
            extract_docx_text(document.getvalue()),
            "Unit Code MBAI5001\nWeek 1\nFoundations",
        )

    def test_single_assessment_uses_final_portfolio_week(self) -> None:
        text = HEADER + """
Assessment Assessment 1: In-class Digital Transformation Case Portfolio
Assessment Type Individual
Assessment Details Progressive activities.
Assessment Weight 25%
Submission Date In-class activities: Weeks 2, 3, 4, 5, 6, 9
Final Portfolio Submission: End of Week 9
Assessment Criteria Refer to Marking Rubric
"""
        rows = parse_assessment_text(text, "assessment-1.pdf")
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0].due_week, 9)
        self.assertEqual(rows[0].weight, 25)
        self.assertEqual(rows[0].subject_code, "MBAI5001")
        self.assertEqual(rows[0].assessment_name, "Assessment 1: In-class Digital Transformation Case Portfolio")

    def test_single_week_assessment(self) -> None:
        text = HEADER + """
Assessment Assessment 2: Critical Comparative Essay
Assessment Type Individual
Assessment Details Compare two industries.
Assessment Weight 30%
Word Count 1,500 words
Submission Date Week 8
Minimum Sources At least 12 sources
"""
        rows = parse_assessment_text(text)
        self.assertEqual([(row.weight, row.due_week) for row in rows], [(30, 8)])

    def test_multi_part_assessment_is_split(self) -> None:
        text = HEADER + """
Assessment Assessment 3: Digital Innovation Product Launch
Assessment Type Group (3-4 students) with Individual Components
Assessment Details Report, pitch and Q&A.
Assessment Weight Part A: Report (Group) - 15%
Part B: Pitch (Group/Individual) - 10%
Part C: Q&A (Individual) - 20%
- 45% Total
Submission and Presentation Dates Week 12: Report submission
Week 13: Pitch presentations and Q&A sessions
Assessment Criteria Refer to Marking Rubrics
"""
        rows = parse_assessment_text(text)
        self.assertEqual([row.component for row in rows], ["Report", "Pitch", "Q&A"])
        self.assertEqual(
            [row.assessment_type for row in rows],
            ["Group", "Group/Individual", "Individual"],
        )
        self.assertEqual([row.weight for row in rows], [15, 10, 20])
        self.assertEqual([row.due_week for row in rows], [12, 13, 13])


class FeedbackTests(unittest.TestCase):
    def setUp(self) -> None:
        self.items = [
            AssessmentItem("MBAI5001", "Subject", "Assessment 1", "Whole assessment", "Individual", 25, 9),
            AssessmentItem("MBAI5001", "Subject", "Assessment 2", "Whole assessment", "Individual", 30, 8),
            AssessmentItem("MBAI5001", "Subject", "Assessment 3", "Report", "Group", 15, 12),
            AssessmentItem("MBAI5001", "Subject", "Assessment 3", "Pitch", "Group", 10, 13),
            AssessmentItem("MBAI5001", "Subject", "Assessment 3", "Q&A", "Individual", 20, 13),
        ]

    def test_feedback_flags_outside_course_and_consecutive_load(self) -> None:
        feedback = analyse_schedule(self.items, 12)
        titles = [item.title for item in feedback]
        self.assertIn("Weighting totals 100%", titles)
        self.assertIn("Submission outside the course", titles)
        self.assertIn("Heavy consecutive deadlines in Weeks 8-9", titles)

    def test_schedule_has_exactly_twelve_weeks(self) -> None:
        schedule = weekly_schedule(self.items, 12)
        self.assertEqual(len(schedule), 12)
        self.assertEqual(schedule[7]["Weight due"], 30)
        self.assertEqual(schedule[8]["Weight due"], 25)


if __name__ == "__main__":
    unittest.main()
