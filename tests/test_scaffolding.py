import unittest

from assessment_scheduler.models import AssessmentItem
from assessment_scheduler.scaffolding import evaluate_scaffolding


def assessment(name: str, due_week: int, required: list[str]) -> AssessmentItem:
    return AssessmentItem(
        subject_code="TEST1001",
        subject_name="Test unit",
        assessment_name=name,
        component="Whole assessment",
        assessment_type="Individual",
        weight=50,
        due_week=due_week,
        required_topics_skills=required,
    )


class ScaffoldingEvaluationTests(unittest.TestCase):
    def test_assessments_are_evaluated_independently_for_topic_coverage(self) -> None:
        items = [
            assessment("Assessment 1: Foundations", 7, ["Security foundations"]),
            assessment("Assessment 2: Applied Analysis", 6, ["Advanced threat analysis"]),
        ]
        topics = [
            {"week": "1", "topic": "Security foundations"},
            {"week": "6", "topic": "Advanced threat analysis"},
        ]

        evaluations = evaluate_scaffolding(items, topics)

        self.assertEqual(evaluations[0].label, "Covered")
        self.assertEqual(evaluations[1].label, "Covered")
        self.assertEqual(evaluations[1].topic_readiness, "All requirements covered by Week 6")

    def test_topic_taught_in_due_week_counts_as_covered(self) -> None:
        items = [assessment("Assessment 1", 6, ["Cryptography"])]
        topics = [{"week": "Week 6", "topic": "Cryptography"}]

        evaluation = evaluate_scaffolding(items, topics)[0]

        self.assertEqual(evaluation.status, "success")
        self.assertEqual(evaluation.label, "Covered")
        self.assertIn("on or before", evaluation.rationale)
        self.assertEqual(evaluation.requirement_coverage[0]["status"], "covered")
        self.assertEqual(evaluation.requirement_coverage[0]["matched_week"], 6)

    def test_topic_taught_after_due_week_is_not_covered(self) -> None:
        items = [assessment("Assessment 1", 6, ["Cryptography"])]
        topics = [{"week": "8", "topic": "Cryptography"}]

        evaluation = evaluate_scaffolding(items, topics)[0]

        self.assertEqual(evaluation.status, "error")
        self.assertEqual(evaluation.label, "Not covered by due week")
        self.assertIn("after Week 6", evaluation.rationale)
        self.assertEqual(evaluation.requirement_coverage[0]["status"], "after_due")

    def test_missing_weekly_topics_are_reported_as_missing_input(self) -> None:
        evaluation = evaluate_scaffolding(
            [assessment("Assessment 1", 6, ["Cryptography"])],
            [],
        )[0]

        self.assertEqual(evaluation.status, "warning")
        self.assertEqual(evaluation.label, "Weekly topics required")
        self.assertIn("Step 2", evaluation.topic_readiness)
        self.assertIn("No weekly class topics", evaluation.requirement_coverage[0]["detail"])

    def test_named_case_requirements_match_broader_curriculum_topics(self) -> None:
        items = [assessment(
            "Assessment 3: Case Study",
            12,
            [
                "SolarWinds Orion Platform security incident analysis",
                "Supply Chain Attack",
                "Backdoor methods",
                "Assessing potential risks to individuals from a breach",
                "Detailing immediate remediation actions and patch updates",
                "Cybersecurity solutions (IDPS, firewalls, antivirus)",
            ],
        )]
        topics = [
            {"week": "1", "topic": "Cybersecurity Threat Landscape: data breaches and data protection"},
            {"week": "4", "topic": "Security Assessment and Testing: vulnerability management"},
            {"week": "8", "topic": "Endpoint Security"},
            {"week": "9", "topic": "Network Security"},
            {"week": "10", "topic": "Digital Forensics and Incident Response: mitigation and recovery"},
        ]

        evaluation = evaluate_scaffolding(items, topics)[0]

        self.assertEqual(evaluation.label, "Covered")
        self.assertEqual(
            [entry["status"] for entry in evaluation.requirement_coverage],
            ["covered"] * 6,
        )
        self.assertEqual(
            [entry["matched_week"] for entry in evaluation.requirement_coverage],
            [10, 1, 1, 1, 4, 8],
        )

    def test_more_specific_match_is_preferred_over_earlier_generic_security_topic(self) -> None:
        item = assessment("Assessment 1", 6, ["Security assessment"])
        topics = [
            {"week": "3", "topic": "Secure Coding and application security controls"},
            {"week": "4", "topic": "Security Assessment and Testing"},
        ]

        evaluation = evaluate_scaffolding([item], topics)[0]

        self.assertEqual(evaluation.requirement_coverage[0]["matched_week"], 4)


if __name__ == "__main__":
    unittest.main()
