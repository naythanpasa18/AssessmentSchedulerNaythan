from __future__ import annotations

import re
from typing import Any
from xml.etree import ElementTree as ET


def _text(parent: ET.Element, tag: str, value: object) -> ET.Element:
    element = ET.SubElement(parent, tag)
    element.text = "" if value is None else str(value)
    return element


def _values(parent: ET.Element, tag: str, item_tag: str, values: object) -> None:
    container = ET.SubElement(parent, tag)
    if not isinstance(values, list):
        return
    for value in values:
        _text(container, item_tag, value)


def _week_number(row: dict[str, Any]) -> int:
    try:
        return int(row.get("Week", row.get("week", 0)) or 0)
    except (TypeError, ValueError):
        return 0


def schedule_xml_filename(payload: dict[str, Any]) -> str:
    unit_info = payload.get("unit_info") if isinstance(payload.get("unit_info"), dict) else {}
    base = str(unit_info.get("unit_code") or payload.get("name") or "assessment").strip()
    safe_base = re.sub(r"[^A-Za-z0-9._-]+", "-", base).strip("-._") or "assessment"
    return f"{safe_base}-weekly-schedule.xml"


def schedule_to_xml(payload: dict[str, Any]) -> bytes:
    """Serialise a generated weekly schedule to a stable, readable XML document."""

    root = ET.Element("assessmentSchedule", {"version": "1"})
    _text(root, "name", payload.get("name", "Assessment schedule"))
    _text(root, "courseDuration", payload.get("course_duration", ""))

    units_element = ET.SubElement(root, "units")
    units = payload.get("units", [])
    if isinstance(units, list):
        for value in units:
            if not isinstance(value, dict):
                continue
            unit = ET.SubElement(units_element, "unit")
            _text(unit, "code", value.get("unit_code", ""))
            _text(unit, "name", value.get("unit_name", ""))

    unit_info = payload.get("unit_info") if isinstance(payload.get("unit_info"), dict) else {}
    topics_by_week: dict[int, list[str]] = {}
    for value in unit_info.get("weekly_topics", []) or []:
        if not isinstance(value, dict):
            continue
        try:
            week = int(str(value.get("week", "")).strip())
        except (TypeError, ValueError):
            continue
        topic = str(value.get("topic", "")).strip()
        if topic:
            topics_by_week.setdefault(week, []).append(topic)

    items = [value for value in payload.get("items", []) if isinstance(value, dict)]
    weeks_element = ET.SubElement(root, "weeks")
    for row in payload.get("schedule", []):
        if not isinstance(row, dict):
            continue
        week_number = _week_number(row)
        week = ET.SubElement(weeks_element, "week", {"number": str(week_number)})
        _values(week, "topics", "topic", topics_by_week.get(week_number, []))

        summary = ET.SubElement(week, "summary")
        _text(summary, "assessmentsDue", row.get("Assessments due", row.get("assessments_due", "")))
        _text(summary, "weightDue", row.get("Weight due", row.get("weight_due", 0)))

        assessments = ET.SubElement(week, "assessments")
        for item in items:
            try:
                due_week = int(item.get("due_week", 0) or 0)
            except (TypeError, ValueError):
                continue
            if due_week != week_number:
                continue
            assessment = ET.SubElement(assessments, "assessment")
            for tag, key in (
                ("subjectCode", "subject_code"),
                ("subjectName", "subject_name"),
                ("assessmentName", "assessment_name"),
                ("component", "component"),
                ("assessmentType", "assessment_type"),
                ("weight", "weight"),
                ("dueWeek", "due_week"),
                ("dueSession", "due_session"),
                ("rawDueText", "raw_due_text"),
                ("estimatedWorkloadHours", "estimated_workload_hours"),
                ("preparationWeeks", "preparation_weeks"),
                ("sourceFile", "source_file"),
            ):
                _text(assessment, tag, item.get(key, ""))
            _values(
                assessment,
                "learningOutcomesAssessed",
                "learningOutcome",
                item.get("learning_outcomes_assessed", []),
            )
            _values(
                assessment,
                "requiredTopicsSkills",
                "requirement",
                item.get("required_topics_skills", []),
            )
            _values(assessment, "dependencies", "dependency", item.get("dependencies", []))
            _values(
                assessment,
                "feedbackRequirements",
                "requirement",
                item.get("feedback_requirements", []),
            )

    ET.indent(root, space="  ")
    return ET.tostring(root, encoding="utf-8", xml_declaration=True)
