import json
import unittest
from unittest.mock import patch

from assessment_scheduler.ollama_ingestion import (
    OllamaError,
    evaluate_scaffolding_with_ollama,
    list_ollama_models,
    parse_assessment_text_with_ollama,
)
from assessment_scheduler.models import AssessmentItem


class OllamaIngestionTests(unittest.TestCase):
    @patch("assessment_scheduler.ollama_ingestion._request_json")
    def test_structured_response_becomes_assessment_items(self, request_json) -> None:
        request_json.return_value = {
            "message": {
                "content": json.dumps(
                    {
                        "subject_code": "MBAI5001",
                        "subject_name": "Digital Transformation & Innovation",
                        "items": [
                            {
                                "assessment_name": "Assessment 3: Product Launch",
                                "component": "Report",
                                "assessment_type": "Group",
                                "weight": 15,
                                "due_week": 12,
                                "due_session": 23,
                                "raw_due_text": "Week 12: Report submission",
                            },
                            {
                                "assessment_name": "Assessment 3: Product Launch",
                                "component": "Pitch",
                                "assessment_type": "Group/Individual",
                                "weight": 10,
                                "due_week": 13,
                                "due_session": 25,
                                "raw_due_text": "Week 13: Pitch presentations",
                            },
                        ],
                    }
                )
            }
        }

        items = parse_assessment_text_with_ollama("Assessment brief text", "assessment.pdf")

        self.assertEqual([item.due_week for item in items], [12, 13])
        self.assertEqual([item.due_session for item in items], [23, 25])
        self.assertEqual([item.weight for item in items], [15, 10])
        self.assertEqual(items[0].source_file, "assessment.pdf")
        payload = request_json.call_args.kwargs["payload"]
        self.assertEqual(payload["model"], "gemma4")
        self.assertFalse(payload["stream"])
        self.assertEqual(payload["options"]["temperature"], 0)
        self.assertEqual(payload["options"]["num_ctx"], 16_384)
        self.assertIsInstance(payload["format"], dict)
        self.assertIn("assessment context", payload["messages"][1]["content"])

    @patch("assessment_scheduler.ollama_ingestion._request_json")
    def test_invalid_model_response_is_rejected(self, request_json) -> None:
        request_json.return_value = {"message": {"content": "not json"}}
        with self.assertRaises(OllamaError):
            parse_assessment_text_with_ollama("Assessment brief text")

    @patch("assessment_scheduler.ollama_ingestion._request_json")
    def test_model_listing(self, request_json) -> None:
        request_json.return_value = {
            "models": [{"name": "gemma4:latest"}, {"name": "gemma4:e2b"}]
        }
        self.assertEqual(
            list_ollama_models(),
            ["gemma4:e2b", "gemma4:latest"],
        )

    @patch("assessment_scheduler.ollama_ingestion._request_json")
    def test_model_generates_scaffolding_evaluations(self, request_json) -> None:
        request_json.return_value = {
            "message": {
                "content": json.dumps({
                    "evaluations": [
                        {
                            "item_index": 0,
                            "requirement_coverage": [
                                {
                                    "requirement_index": 0,
                                    "coverage_status": "covered",
                                    "matched_topic_index": 0,
                                }
                            ],
                        }
                    ]
                })
            }
        }
        items = [
            AssessmentItem(
                subject_code="CYB601A",
                subject_name="Cyber Security",
                assessment_name="Assessment 1: Quiz",
                component="Whole assessment",
                assessment_type="Quiz",
                weight=20,
                due_week=4,
                required_topics_skills=["Public Key Infrastructure (PKI)"],
            )
        ]
        unit_info = {
            "weekly_topics": [
                {"week": "Week 2", "topic": "Encryption and certificate management"}
            ]
        }

        evaluations = evaluate_scaffolding_with_ollama(items, unit_info)

        self.assertEqual(evaluations[0].label, "Covered")
        self.assertEqual(
            evaluations[0].matched_topics,
            [{"week": 2, "topic": "Encryption and certificate management"}],
        )
        self.assertEqual(evaluations[0].requirement_coverage[0]["status"], "covered")
        payload = request_json.call_args.kwargs["payload"]
        self.assertEqual(payload["model"], "gemma4")
        self.assertIn("semantic curriculum mapping", payload["messages"][1]["content"])
        self.assertIn("named case does not need to be taught by name", payload["messages"][1]["content"])
        self.assertIn("Prefer the most relevant topic taught on or before", payload["messages"][1]["content"])

    @patch("assessment_scheduler.ollama_ingestion._request_json")
    def test_incomplete_scaffolding_response_is_rejected(self, request_json) -> None:
        request_json.return_value = {
            "message": {"content": json.dumps({"evaluations": []})}
        }
        items = [
            AssessmentItem(
                subject_code="CYB601A",
                subject_name="Cyber Security",
                assessment_name="Assessment 1",
                component="Whole assessment",
                assessment_type="Quiz",
                weight=20,
                due_week=4,
            )
        ]
        with self.assertRaises(OllamaError):
            evaluate_scaffolding_with_ollama(items, {"weekly_topics": []})

    @patch("assessment_scheduler.ollama_ingestion._request_json")
    def test_semantic_validation_recovers_named_case_model_omissions(self, request_json) -> None:
        requirements = [
            "Analyzing the SolarWinds Orion Platform security incident",
            "Analyzing supply chain attacks",
            "Analyzing backdoor methods",
            "Assessing potential risks to individuals from a breach",
            "Detailing immediate remediation actions and patch updates",
            "Proposing future cybersecurity solutions to mitigate attacks",
        ]
        request_json.return_value = {
            "message": {
                "content": json.dumps({
                    "evaluations": [{
                        "item_index": 0,
                        "requirement_coverage": [
                            {
                                "requirement_index": index,
                                "coverage_status": "not_mapped",
                                "matched_topic_index": -1,
                            }
                            for index in range(len(requirements))
                        ],
                    }]
                })
            }
        }
        items = [
            AssessmentItem(
                subject_code="CYB601A",
                subject_name="Cyber Security",
                assessment_name="Assessment 3: Case Study",
                component="Report",
                assessment_type="Case study",
                weight=20,
                due_week=12,
                required_topics_skills=requirements,
            )
        ]
        unit_info = {
            "weekly_topics": [
                {"week": "1", "topic": "Cybersecurity Threat Landscape: data breaches, data protection and malicious code"},
                {"week": "4", "topic": "Security Assessment and Testing: vulnerability management"},
                {"week": "8", "topic": "Endpoint Security"},
                {"week": "9", "topic": "Network Security"},
                {"week": "10", "topic": "Digital Forensics and Incident Response: mitigation and recovery"},
            ]
        }

        evaluation = evaluate_scaffolding_with_ollama(items, unit_info)[0]

        self.assertEqual(evaluation.label, "Covered")
        self.assertEqual(
            [entry["status"] for entry in evaluation.requirement_coverage],
            ["covered"] * 6,
        )
        self.assertTrue(all(entry["matched_topic"] for entry in evaluation.requirement_coverage))
        self.assertTrue(all("Related coverage found" in entry["detail"] for entry in evaluation.requirement_coverage))

    @patch("assessment_scheduler.ollama_ingestion._request_json")
    def test_missing_model_checklist_entry_is_recovered_semantically(self, request_json) -> None:
        request_json.return_value = {
            "message": {
                "content": json.dumps({
                    "evaluations": [{
                        "item_index": 0,
                        "requirement_coverage": [],
                    }]
                })
            }
        }
        item = AssessmentItem(
            subject_code="CYB601A",
            subject_name="Cyber Security",
            assessment_name="Assessment 3",
            component="Report",
            assessment_type="Case study",
            weight=20,
            due_week=12,
            required_topics_skills=["Analyzing a security incident"],
        )

        evaluation = evaluate_scaffolding_with_ollama(
            [item],
            {"weekly_topics": [{"week": "10", "topic": "Digital Forensics and Incident Response"}]},
        )[0]

        self.assertEqual(evaluation.label, "Covered")
        self.assertEqual(evaluation.requirement_coverage[0]["matched_week"], 10)

    @patch("assessment_scheduler.ollama_ingestion._request_json")
    def test_more_relevant_semantic_topic_corrects_weak_model_match(self, request_json) -> None:
        request_json.return_value = {
            "message": {
                "content": json.dumps({
                    "evaluations": [{
                        "item_index": 0,
                        "requirement_coverage": [{
                            "requirement_index": 0,
                            "coverage_status": "covered",
                            "matched_topic_index": 0,
                        }],
                    }]
                })
            }
        }
        item = AssessmentItem(
            subject_code="CYB601A",
            subject_name="Cyber Security",
            assessment_name="Assessment 2",
            component="Report",
            assessment_type="Report",
            weight=30,
            due_week=9,
            required_topics_skills=["Organisational security assessment"],
        )
        unit_info = {
            "weekly_topics": [
                {"week": "3", "topic": "Secure Coding and application security controls"},
                {"week": "4", "topic": "Security Assessment and Testing"},
            ]
        }

        evaluation = evaluate_scaffolding_with_ollama([item], unit_info)[0]

        self.assertEqual(evaluation.requirement_coverage[0]["matched_week"], 4)
        self.assertIn("Related coverage found", evaluation.requirement_coverage[0]["detail"])


if __name__ == "__main__":
    unittest.main()
