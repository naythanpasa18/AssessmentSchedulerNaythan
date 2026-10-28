from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field
from typing import Any

from .models import AssessmentItem


STOP_WORDS = {
    "and", "the", "for", "with", "from", "into", "using", "skills", "topic",
    "assessment", "analysis", "introduction", "fundamentals", "principles",
    "security", "cybersecurity", "cyber", "solution", "solutions",
}


# These concept families make the non-model fallback compare curriculum meaning
# rather than exact wording. They also document the intended level of mapping:
# an assessment's case or technology can be supported by a broader class topic.
CONCEPT_FAMILIES: dict[str, tuple[str, ...]] = {
    "incident_response": (
        "incident analysis", "incident response", "security incident",
        "digital forensic", "cyber incident", "incident investigation",
    ),
    "threat_analysis": (
        "threat analysis", "threat landscape", "threat categorisation",
        "threat categorization", "cyber threat categorisation",
        "cyber threat categorization", "threat classification",
        "supply chain attack", "supply-chain attack",
        "third party risk", "third-party risk", "vendor risk",
    ),
    "malware_and_backdoors": (
        "backdoor", "malware", "trojan", "malicious code", "threat landscape",
        "endpoint security", "incident response",
    ),
    "defensive_controls": (
        "idps", "intrusion detection", "intrusion prevention", "firewall",
        "antivirus", "anti-virus", "network security", "endpoint security",
        "security control", "cybersecurity solution", "cyber security solution",
        "mitigate attacks", "mitigating attacks",
    ),
    "information_security_functions": (
        "information security function", "cia triad", "confidentiality",
        "integrity", "availability", "security function",
    ),
    "security_assessment": (
        "security assessment", "security testing", "vulnerability assessment",
        "penetration testing", "organisational security assessment",
        "organizational security assessment",
    ),
    "risk_treatment": (
        "risk treatment", "risk management", "risk mitigation", "risk transfer",
        "risk acceptance", "risk avoidance",
    ),
    "privacy_and_breach_risk": (
        "risk to individuals", "risks to individuals", "data breach",
        "data protection", "privacy risk", "privacy", "personal information",
    ),
    "remediation_and_patching": (
        "remediation", "patch update", "patching", "patch management",
        "vulnerability management", "mitigation and recovery", "recovery action",
    ),
}


@dataclass(slots=True)
class ScaffoldingEvaluation:
    assessment_name: str
    component: str
    status: str
    label: str
    rationale: str
    topic_readiness: str
    matched_topics: list[dict[str, object]]
    requirement_coverage: list[dict[str, object]] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _tokens(value: str) -> set[str]:
    return {
        token
        for token in re.findall(r"[a-z0-9]+", value.casefold())
        if len(token) > 2 and token not in STOP_WORDS
    }


def _topic_match_score(required: str, topic: str) -> int:
    required_text = required.casefold().strip()
    topic_text = topic.casefold().strip()
    if min(len(required_text), len(topic_text)) >= 4 and (
        required_text in topic_text or topic_text in required_text
    ):
        return 100
    required_tokens = _tokens(required)
    topic_tokens = _tokens(topic)
    common = required_tokens & topic_tokens

    def concept_tags(text: str) -> set[str]:
        normalised = re.sub(r"[^a-z0-9]+", " ", text.casefold()).strip()
        return {
            family
            for family, phrases in CONCEPT_FAMILIES.items()
            if any(re.sub(r"[^a-z0-9]+", " ", phrase.casefold()).strip() in normalised for phrase in phrases)
        }

    shared_concepts = concept_tags(required) & concept_tags(topic)
    score = len(shared_concepts) * 50
    if common and (len(common) >= 2 or min(len(required_tokens), len(topic_tokens)) == 1):
        score += 15 + (len(common) * 5)
    return score


def _topic_matches(required: str, topic: str) -> bool:
    return _topic_match_score(required, topic) > 0


def parse_week_number(value: object) -> int:
    """Return the first numeric week from values such as 1, '1', or 'Week 1'."""

    match = re.search(r"\b(\d{1,2})\b", str(value or ""))
    return int(match.group(1)) if match else 0


def evaluate_scaffolding(
    items: list[AssessmentItem],
    weekly_topics: list[dict[str, object]] | None,
) -> list[ScaffoldingEvaluation]:
    """Evaluate whether required topics and skills are covered by each due week."""

    topics: list[tuple[int, str]] = []
    for value in weekly_topics or []:
        if not isinstance(value, dict):
            continue
        week = parse_week_number(value.get("week", 0))
        topic = str(value.get("topic", "")).strip()
        if week > 0 and topic:
            topics.append((week, topic))

    evaluations: list[ScaffoldingEvaluation] = []
    for item in items:
        matched: dict[tuple[int, str], None] = {}
        covered_requirements: list[str] = []
        future_requirements: list[str] = []
        unmatched_requirements: list[str] = []
        requirement_coverage: list[dict[str, object]] = []
        for required in item.required_topics_skills or []:
            requirement_matches = [
                (week, topic)
                for week, topic in topics
                if _topic_matches(required, topic)
            ]
            covered_matches = [
                match for match in requirement_matches if item.due_week > 0 and match[0] <= item.due_week
            ]
            if item.due_week <= 0:
                requirement_coverage.append({
                    "requirement": required,
                    "status": "due_week_required",
                    "matched_week": 0,
                    "matched_topic": "",
                    "detail": "Enter a due week to evaluate coverage.",
                })
            elif covered_matches:
                covered_requirements.append(required)
                for match in covered_matches:
                    matched[match] = None
                week, topic = max(
                    covered_matches,
                    key=lambda value: (_topic_match_score(required, value[1]), -value[0]),
                )
                requirement_coverage.append({
                    "requirement": required,
                    "status": "covered",
                    "matched_week": week,
                    "matched_topic": topic,
                    "detail": f"Covered in Week {week}: {topic}.",
                })
            elif requirement_matches:
                future_requirements.append(required)
                for match in requirement_matches:
                    matched[match] = None
                week, topic = max(
                    requirement_matches,
                    key=lambda value: (_topic_match_score(required, value[1]), -value[0]),
                )
                requirement_coverage.append({
                    "requirement": required,
                    "status": "after_due",
                    "matched_week": week,
                    "matched_topic": topic,
                    "detail": f"Taught in Week {week}, after the Week {item.due_week} due date.",
                })
            else:
                unmatched_requirements.append(required)
                detail = (
                    "No weekly class topics are available from Step 2."
                    if not topics
                    else "No matching weekly class topic was found."
                )
                requirement_coverage.append({
                    "requirement": required,
                    "status": "not_mapped",
                    "matched_week": 0,
                    "matched_topic": "",
                    "detail": detail,
                })
        matched_topics = [
            {"week": week, "topic": topic}
            for week, topic in sorted(matched, key=lambda value: (value[0], value[1].casefold()))
        ]

        required_count = len(item.required_topics_skills or [])
        covered_count = len(covered_requirements)
        if item.due_week <= 0:
            status, label = "error", "Due week required"
            topic_readiness = "Due week not entered"
            rationale = "Add a due week before checking whether the required topics have been covered."
        elif not required_count:
            status, label = "warning", "Needs mapping"
            topic_readiness = "Required topics not entered"
            rationale = "Add the required topics or skills to evaluate class coverage."
        elif not topics:
            status, label = "warning", "Weekly topics required"
            topic_readiness = "No weekly topics available from Step 2"
            rationale = "Add or extract weekly class topics in Step 2 before evaluating coverage."
        elif future_requirements:
            status, label = "error", "Not covered by due week"
            topic_readiness = f"{covered_count} of {required_count} requirements covered by Week {item.due_week}"
            future_list = ", ".join(future_requirements)
            rationale = (
                f"The following requirements are only matched to classes after Week {item.due_week}: "
                f"{future_list}. Topics taught in Week {item.due_week} count as covered."
            )
            if unmatched_requirements:
                rationale += f" No weekly-topic match was found for: {', '.join(unmatched_requirements)}."
        elif unmatched_requirements:
            status = "warning"
            label = "Partially covered" if covered_requirements else "Review mapping"
            topic_readiness = f"{covered_count} of {required_count} requirements covered by Week {item.due_week}"
            unmatched_list = ", ".join(unmatched_requirements)
            rationale = f"No weekly-topic match was found for: {unmatched_list}."
        else:
            status, label = "success", "Covered"
            latest_week = max(
                week
                for week, topic in matched
                if week <= item.due_week
            )
            topic_readiness = f"All requirements covered by Week {latest_week}"
            rationale = (
                f"All {required_count} required topics and skills are matched to classes taught "
                f"on or before the Week {item.due_week} due week."
            )

        evaluations.append(
            ScaffoldingEvaluation(
                assessment_name=item.assessment_name,
                component=item.component,
                status=status,
                label=label,
                rationale=rationale,
                topic_readiness=topic_readiness,
                matched_topics=matched_topics,
                requirement_coverage=requirement_coverage,
            )
        )
    return evaluations
