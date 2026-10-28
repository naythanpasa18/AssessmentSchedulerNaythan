from __future__ import annotations

from collections import defaultdict
from collections.abc import Iterable

from .models import AssessmentItem, FeedbackItem


COURSE_DURATION_WEEKS = 12


def analyse_schedule(
    items: Iterable[AssessmentItem],
    course_duration: int = COURSE_DURATION_WEEKS,
    subject_code: str = "",
) -> list[FeedbackItem]:
    rows = list(items)
    feedback: list[FeedbackItem] = []

    total_weight = sum(item.weight for item in rows)
    if abs(total_weight - 100) <= 0.1:
        feedback.append(
            FeedbackItem("success", "Weighting totals 100%", "The extracted assessment weights are complete.")
        )
    else:
        feedback.append(
            FeedbackItem(
                "warning",
                "Weighting requires review",
                f"The extracted components total {total_weight:g}%, rather than 100%.",
            )
        )

    unscheduled = [item for item in rows if item.due_week <= 0]
    if unscheduled:
        feedback.append(
            FeedbackItem(
                "error",
                "Missing due week",
                f"{len(unscheduled)} component(s) need a valid due week before the schedule is complete.",
            )
        )

    outside = [item for item in rows if item.due_week > course_duration]
    if outside:
        names = ", ".join(item.display_name for item in outside)
        feedback.append(
            FeedbackItem(
                "error",
                "Submission outside the course",
                f"{names} fall after Week {course_duration}. Preserve these dates, but review them before approval.",
            )
        )

    weekly_weight: dict[int, float] = defaultdict(float)
    weekly_items: dict[int, list[AssessmentItem]] = defaultdict(list)
    for item in rows:
        if 1 <= item.due_week <= course_duration:
            weekly_weight[item.due_week] += item.weight
            weekly_items[item.due_week].append(item)

    for week in sorted(weekly_weight):
        weight = weekly_weight[week]
        count = len(weekly_items[week])
        if weight > 40:
            feedback.append(
                FeedbackItem(
                    "error",
                    f"Very high load in Week {week}",
                    f"{count} component(s) worth {weight:g}% are due in this week.",
                )
            )
        elif weight > 30:
            feedback.append(
                FeedbackItem(
                    "warning",
                    f"High load in Week {week}",
                    f"{count} component(s) worth {weight:g}% are due in this week.",
                )
            )

    active_weeks = sorted(weekly_weight)
    for first, second in zip(active_weeks, active_weeks[1:]):
        if second == first + 1:
            combined = weekly_weight[first] + weekly_weight[second]
            if combined >= 50:
                feedback.append(
                    FeedbackItem(
                        "warning",
                        f"Heavy consecutive deadlines in Weeks {first}-{second}",
                        f"These two weeks contain {combined:g}% of the subject weighting.",
                    )
                )

    final_weeks = {course_duration - 1, course_duration}
    final_weight = sum(weight for week, weight in weekly_weight.items() if week in final_weeks)
    if final_weight >= 40:
        feedback.append(
            FeedbackItem(
                "warning",
                "Weighting concentrated at the end of the course",
                f"Weeks {course_duration - 1}-{course_duration} contain {final_weight:g}% of the weighting.",
            )
        )

    if not feedback:
        feedback.append(FeedbackItem("success", "Schedule looks balanced", "No configured scheduling risks were found."))
    for item in feedback:
        item.subject_code = subject_code
    return feedback


def weekly_schedule(
    items: Iterable[AssessmentItem],
    course_duration: int = COURSE_DURATION_WEEKS,
) -> list[dict[str, object]]:
    rows = list(items)
    schedule: list[dict[str, object]] = []
    for week in range(1, course_duration + 1):
        due = [item for item in rows if item.due_week == week]
        schedule.append(
            {
                "Week": week,
                "Assessments due": "; ".join(item.display_name for item in due) or "-",
                "Weight due": sum(item.weight for item in due),
            }
        )
    return schedule
