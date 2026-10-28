from __future__ import annotations

from dataclasses import asdict, dataclass


@dataclass(slots=True)
class AssessmentItem:
    """A schedulable assessment or independently weighted component."""

    subject_code: str
    subject_name: str
    assessment_name: str
    component: str
    assessment_type: str
    weight: float
    due_week: int
    due_session: int = 0
    source_file: str = ""
    raw_due_text: str = ""
    learning_outcomes_assessed: list[str] | None = None
    required_topics_skills: list[str] | None = None
    estimated_workload_hours: float = 0.0
    preparation_weeks: int = 0
    dependencies: list[str] | None = None
    feedback_requirements: list[str] | None = None

    def __post_init__(self) -> None:
        self.learning_outcomes_assessed = list(self.learning_outcomes_assessed or [])
        self.required_topics_skills = list(self.required_topics_skills or [])
        self.dependencies = list(self.dependencies or [])
        self.feedback_requirements = list(self.feedback_requirements or [])

    @property
    def display_name(self) -> str:
        if self.component and self.component.lower() not in {
            "whole assessment",
            "assessment",
        }:
            return f"{self.assessment_name} - {self.component}"
        return self.assessment_name

    def to_dict(self) -> dict[str, object]:
        return asdict(self)


@dataclass(slots=True)
class FeedbackItem:
    severity: str
    title: str
    message: str
    subject_code: str = ""
