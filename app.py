from __future__ import annotations

import json
import os
import re
from dataclasses import asdict
from pathlib import Path

import click
from flask import Flask, jsonify, request, send_from_directory
from werkzeug.exceptions import HTTPException

from assessment_scheduler.feedback import COURSE_DURATION_WEEKS, analyse_schedule, weekly_schedule
from assessment_scheduler.models import AssessmentItem, FeedbackItem
from assessment_scheduler.ollama_ingestion import (
    DEFAULT_OLLAMA_HOST,
    DEFAULT_OLLAMA_MODEL,
    OllamaError,
    evaluate_scaffolding_with_ollama,
    list_ollama_models,
    parse_assessment_text_with_ollama,
)
from assessment_scheduler.pdf_ingestion import extract_docx_text, extract_pdf_text, parse_assessment_text
from assessment_scheduler.scaffolding import evaluate_scaffolding
from assessment_scheduler.schedule_repository import (
    DatabaseConfigurationError,
    DatabaseOperationError,
    initialise_schedule_database,
    save_schedule_snapshot,
)
from assessment_scheduler.unit_outline_ingestion import (
    UnitInformation,
    WeeklyTopic,
    parse_unit_outline_text,
    parse_unit_outline_text_with_ollama,
)
from assessment_scheduler.xml_export import schedule_to_xml, schedule_xml_filename


app = Flask(__name__, static_folder="static", static_url_path="/static")
app.config["MAX_CONTENT_LENGTH"] = 30 * 1024 * 1024
app.config["DATABASE_URL"] = os.environ.get("DATABASE_URL", "")
FRONTEND_DIST = Path(__file__).resolve().parent / "frontend" / "dist"


@app.errorhandler(HTTPException)
def handle_http_error(error: HTTPException):
    if request.path.startswith("/api/"):
        return jsonify({"error": error.description, "status": error.code}), error.code
    return error


def _is_supported_upload(filename: str | None) -> bool:
    return bool(filename and Path(filename).suffix.lower() in {".pdf", ".docx"})


def _extract_upload_text(data: bytes, filename: str, preserve_layout: bool = False) -> str:
    if Path(filename).suffix.lower() == ".docx":
        return extract_docx_text(data)
    return extract_pdf_text(data, preserve_layout=preserve_layout)


def _course_duration(unit_info: dict[str, object] | None) -> int:
    try:
        duration = int((unit_info or {}).get("course_duration", COURSE_DURATION_WEEKS) or COURSE_DURATION_WEEKS)
    except (TypeError, ValueError):
        duration = COURSE_DURATION_WEEKS
    return duration if 1 <= duration <= 52 else COURSE_DURATION_WEEKS


def _assessment_sort_key(item: AssessmentItem) -> tuple[int, int | str]:
    number_match = re.search(r"\bAssessment\s*(\d+)\b", item.assessment_name, re.IGNORECASE)
    if number_match:
        return 0, int(number_match.group(1))
    return 1, item.assessment_name.casefold()


def _break_weeks(unit_info: dict[str, object] | None, course_duration: int) -> set[int]:
    invalid_weeks: set[int] = set()
    for value in (unit_info or {}).get("breaks", []) or []:
        description = str(value).strip(" •-\t")
        if not (
            re.match(r"^Weeks?\b", description, re.IGNORECASE)
            or re.search(r"\b(?:break|recess|non-teaching|study week)\b", description, re.IGNORECASE)
        ):
            continue
        for start, end in re.findall(
            r"\bWeeks?\s*(\d{1,2})(?:\s*[-–]\s*(\d{1,2}))?",
            description,
            re.IGNORECASE,
        ):
            first = int(start)
            last = int(end or start)
            invalid_weeks.update(range(min(first, last), max(first, last) + 1))
    return {week for week in invalid_weeks if 1 <= week <= course_duration}


def _serialise_result(
    items: list[AssessmentItem],
    unit_info: dict[str, object] | None = None,
    extraction_method: str = "rule-based",
    ollama_model: str = DEFAULT_OLLAMA_MODEL,
    ollama_host: str = DEFAULT_OLLAMA_HOST,
    require_ollama_scaffolding: bool = False,
) -> dict[str, object]:
    items = sorted(items, key=_assessment_sort_key)
    course_duration = _course_duration(unit_info)
    subject_groups: dict[str, list[AssessmentItem]] = {}
    for item in items:
        key = item.subject_code.casefold() or "__unassigned__"
        subject_groups.setdefault(key, []).append(item)
    feedback: list[FeedbackItem] = []
    for subject_items in subject_groups.values():
        feedback.extend(
            analyse_schedule(
                subject_items,
                course_duration,
                subject_code=subject_items[0].subject_code,
            )
        )
    break_weeks = _break_weeks(unit_info, course_duration)
    on_break = [item for item in items if item.due_week in break_weeks]
    for subject_items in subject_groups.values():
        subject_on_break = [item for item in subject_items if item in on_break]
        if not subject_on_break:
            continue
        names = ", ".join(item.display_name for item in subject_on_break)
        weeks = ", ".join(f"Week {week}" for week in sorted({item.due_week for item in subject_on_break}))
        feedback.append(
            FeedbackItem(
                "error",
                "Submission scheduled in a non-teaching week",
                f"{names} fall in {weeks}. Review the fixed dates or use optimisation before approval.",
                subject_items[0].subject_code,
            )
        )

    insufficient_preparation = [
        item
        for item in items
        if item.due_week > 0 and item.preparation_weeks > 0 and item.due_week - item.preparation_weeks < 1
    ]
    for subject_items in subject_groups.values():
        subject_insufficient = [item for item in subject_items if item in insufficient_preparation]
        if not subject_insufficient:
            continue
        names = ", ".join(item.display_name for item in subject_insufficient)
        feedback.append(
            FeedbackItem(
                "warning",
                "Preparation extends before Week 1",
                f"The stated preparation time for {names} begins before the teaching period.",
                subject_items[0].subject_code,
            )
        )

    scaffolding_source = "rule-based"
    scaffolding_warnings: list[str] = []
    if require_ollama_scaffolding or extraction_method == "ollama":
        try:
            scaffolding = evaluate_scaffolding_with_ollama(
                items,
                unit_info,
                model=ollama_model,
                host=ollama_host,
            )
            scaffolding_source = "ollama"
        except OllamaError as exc:
            if require_ollama_scaffolding:
                raise
            scaffolding = evaluate_scaffolding(
                items,
                (unit_info or {}).get("weekly_topics", []),
            )
            scaffolding_source = "rule-based-fallback"
            scaffolding_warnings.append(
                f"Gemma 4 scaffolding evaluation was unavailable ({exc}). Rule-based evaluation was used."
            )
    else:
        scaffolding = evaluate_scaffolding(
            items,
            (unit_info or {}).get("weekly_topics", []),
        )

    return {
        "items": [item.to_dict() for item in items],
        "schedule": weekly_schedule(items, course_duration),
        "feedback": [asdict(item) for item in feedback],
        "scaffolding": [evaluation.to_dict() for evaluation in scaffolding],
        "scaffolding_source": scaffolding_source,
        "scaffolding_model": ollama_model if scaffolding_source == "ollama" else "",
        "scaffolding_warnings": scaffolding_warnings,
        "course_duration": course_duration,
    }


def _item_from_json(value: dict[str, object]) -> AssessmentItem:
    return AssessmentItem(
        subject_code=str(value.get("subject_code", "")).strip(),
        subject_name=str(value.get("subject_name", "")).strip(),
        assessment_name=str(value.get("assessment_name", "")).strip(),
        component=str(value.get("component", "Whole assessment")).strip() or "Whole assessment",
        assessment_type=str(value.get("assessment_type", "Unspecified")).strip() or "Unspecified",
        weight=float(value.get("weight", 0) or 0),
        due_week=int(value.get("due_week", 0) or 0),
        due_session=int(value.get("due_session", 0) or 0),
        source_file=str(value.get("source_file", "")).strip(),
        raw_due_text=str(value.get("raw_due_text", "")).strip(),
        learning_outcomes_assessed=[str(item).strip() for item in value.get("learning_outcomes_assessed", []) or []],
        required_topics_skills=[str(item).strip() for item in value.get("required_topics_skills", []) or []],
        estimated_workload_hours=float(value.get("estimated_workload_hours", 0) or 0),
        preparation_weeks=int(value.get("preparation_weeks", 0) or 0),
        dependencies=[str(item).strip() for item in value.get("dependencies", []) or []],
        feedback_requirements=[str(item).strip() for item in value.get("feedback_requirements", []) or []],
    )


def _component_key(value: str) -> str:
    normalised = re.sub(r"[^a-z0-9]+", " ", value.casefold()).strip()
    if normalised in {"", "assessment", "whole assessment"}:
        return ""
    match = re.search(r"\b(?:part|component|instalment|installment|stage|submission)\s*([a-z0-9]+)", normalised)
    return match.group(1) if match else normalised


def _assessment_match_score(brief: AssessmentItem, scheduled: AssessmentItem) -> int:
    brief_code = brief.subject_code.casefold().strip()
    scheduled_code = scheduled.subject_code.casefold().strip()
    if brief_code and scheduled_code and brief_code != scheduled_code:
        return -1

    brief_number = re.search(r"\bassessment\s*(\d+)\b", brief.assessment_name, re.IGNORECASE)
    scheduled_number = re.search(r"\bassessment\s*(\d+)\b", scheduled.assessment_name, re.IGNORECASE)
    if brief_number and scheduled_number and brief_number.group(1) != scheduled_number.group(1):
        return -1

    score = 0
    if brief_code and scheduled_code:
        score += 30
    if brief_number and scheduled_number:
        score += 100

    def name_tokens(value: str) -> set[str]:
        return {
            token for token in re.findall(r"[a-z0-9]+", value.casefold())
            if token not in {"assessment", "part", "component"} and not token.isdigit()
        }

    brief_tokens = name_tokens(brief.assessment_name)
    scheduled_tokens = name_tokens(scheduled.assessment_name)
    if brief_tokens and scheduled_tokens:
        overlap = brief_tokens & scheduled_tokens
        score += round(50 * len(overlap) / max(len(brief_tokens), len(scheduled_tokens)))

    brief_component = _component_key(brief.component)
    scheduled_component = _component_key(scheduled.component)
    if brief_component and scheduled_component:
        score += 25 if brief_component == scheduled_component else -20
    elif not brief_component:
        score += 5
    return score if score >= 50 else -1


def _merge_brief_items_with_schedule(
    brief_items: list[AssessmentItem],
    scheduled_items: list[AssessmentItem],
) -> list[AssessmentItem]:
    """Retain the outline schedule while enriching matching rows from briefs."""

    if not scheduled_items:
        return brief_items

    merged: list[AssessmentItem] = []
    matched_briefs: set[int] = set()
    for scheduled in scheduled_items:
        candidates = [
            (score, index, brief)
            for index, brief in enumerate(brief_items)
            if (score := _assessment_match_score(brief, scheduled)) >= 0
        ]
        if not candidates:
            merged.append(scheduled)
            continue

        _, brief_index, brief = max(
            candidates,
            key=lambda value: (
                value[0],
                value[1] not in matched_briefs,
                -value[1],
            ),
        )
        matched_briefs.add(brief_index)
        values = brief.to_dict()
        values.update({
            # Step 4 contains the reviewed schedule. Briefs add coverage metadata,
            # but must not silently move or rename an assessment in the matrix.
            "subject_code": scheduled.subject_code or brief.subject_code,
            "subject_name": scheduled.subject_name or brief.subject_name,
            "assessment_name": scheduled.assessment_name or brief.assessment_name,
            "component": scheduled.component or brief.component,
            "assessment_type": (
                scheduled.assessment_type
                if scheduled.assessment_type not in {"", "Unspecified"}
                else brief.assessment_type
            ),
            "weight": scheduled.weight or brief.weight,
            "due_week": scheduled.due_week or brief.due_week,
            "due_session": scheduled.due_session or brief.due_session,
            "raw_due_text": scheduled.raw_due_text or brief.raw_due_text,
        })
        merged.append(_item_from_json(values))

    merged.extend(brief for index, brief in enumerate(brief_items) if index not in matched_briefs)
    return merged


def _optimise_items(items: list[AssessmentItem], unit_info: dict[str, object]) -> tuple[list[AssessmentItem], list[str]]:
    course_duration = _course_duration(unit_info)
    invalid_weeks = _break_weeks(unit_info, course_duration)

    changes: list[str] = []
    valid_weeks = [week for week in range(1, course_duration + 1) if week not in invalid_weeks]
    if not valid_weeks:
        return items, ["No optimisation was applied because every course week is marked unavailable."]

    def nearest_valid(target: int, excluded: set[int] | None = None) -> int:
        excluded = excluded or set()
        candidates = [week for week in valid_weeks if week not in excluded]
        return min(candidates or valid_weeks, key=lambda week: (abs(week - target), week))

    for item in items:
        if item.due_week < 1 or item.due_week > course_duration or item.due_week in invalid_weeks:
            old_week = item.due_week
            target = min(max(item.due_week, 1), course_duration)
            item.due_week = nearest_valid(target)
            changes.append(f"Moved {item.display_name} from Week {old_week or 'unset'} to Week {item.due_week}.")

    for _ in range(len(items) * 2):
        loads = {week: sum(item.weight for item in items if item.due_week == week) for week in valid_weeks}
        overloaded = [week for week, load in loads.items() if load > 40]
        if not overloaded:
            break
        moved = False
        for week in overloaded:
            candidates = sorted((item for item in items if item.due_week == week), key=lambda item: item.weight)
            for item in candidates:
                target_weeks = sorted(
                    (candidate for candidate in valid_weeks if candidate != week and loads[candidate] + item.weight <= 40),
                    key=lambda candidate: (abs(candidate - week), loads[candidate], candidate),
                )
                if not target_weeks:
                    continue
                new_week = target_weeks[0]
                item.due_week = new_week
                changes.append(f"Moved {item.display_name} from Week {week} to Week {new_week} to reduce workload concentration.")
                moved = True
                break
            if moved:
                break
        if not moved:
            break

    if not changes:
        changes.append("No automatic moves were needed; the draft already meets the configured timing rules.")
    return items, changes


@app.get("/")
def index():
    if (FRONTEND_DIST / "index.html").is_file():
        return send_from_directory(FRONTEND_DIST, "index.html")
    return app.send_static_file("index.html")


@app.get("/assets/<path:filename>")
def frontend_asset(filename: str):
    return send_from_directory(FRONTEND_DIST / "assets", filename)


@app.cli.command("init-db")
def init_db_command() -> None:
    """Create the PostgreSQL table used by Step 6 schedule snapshots."""

    try:
        initialise_schedule_database(app.config.get("DATABASE_URL"))
    except (DatabaseConfigurationError, DatabaseOperationError) as exc:
        raise click.ClickException(str(exc)) from exc
    click.echo("PostgreSQL schedule storage is ready.")


@app.post("/api/schedules")
def save_generated_schedule():
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({"error": "A JSON schedule snapshot is required."}), 400

    units = payload.get("units", [])
    unit_info = payload.get("unit_info", {})
    items = payload.get("items", [])
    schedule = payload.get("schedule", [])
    if not isinstance(units, list) or not isinstance(unit_info, dict):
        return jsonify({"error": "Unit information must use the expected structure."}), 400
    if not isinstance(items, list) or not items or not isinstance(schedule, list) or not schedule:
        return jsonify({"error": "Generate the Step 6 schedule before saving it."}), 400

    try:
        course_duration = int(payload.get("course_duration", len(schedule)))
    except (TypeError, ValueError):
        return jsonify({"error": "Course duration must be a whole number."}), 400
    if not 1 <= course_duration <= 52:
        return jsonify({"error": "Course duration must be between 1 and 52 weeks."}), 400

    name = str(payload.get("name", "")).strip()
    if not name:
        unit_codes = [
            str(unit.get("unit_code", "")).strip()
            for unit in units
            if isinstance(unit, dict) and str(unit.get("unit_code", "")).strip()
        ]
        name = f"{' / '.join(unit_codes) or 'Assessment'} schedule"
    name = name[:200]
    schedule_data = {
        "schema_version": 1,
        "course_duration": course_duration,
        "unit_info": unit_info,
        "units": units,
        "items": items,
        "schedule": schedule,
    }
    try:
        saved = save_schedule_snapshot(
            app.config.get("DATABASE_URL"),
            name,
            schedule_data,
        )
    except (DatabaseConfigurationError, DatabaseOperationError) as exc:
        return jsonify({"error": str(exc)}), 503
    return jsonify(saved), 201


@app.post("/api/schedules/export.xml")
def export_generated_schedule_xml():
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({"error": "A JSON schedule snapshot is required."}), 400

    items = payload.get("items", [])
    schedule = payload.get("schedule", [])
    if not isinstance(items, list) or not items or not isinstance(schedule, list) or not schedule:
        return jsonify({"error": "Generate the weekly schedule before exporting it."}), 400

    try:
        course_duration = int(payload.get("course_duration", len(schedule)))
    except (TypeError, ValueError):
        return jsonify({"error": "Course duration must be a whole number."}), 400
    if not 1 <= course_duration <= 52:
        return jsonify({"error": "Course duration must be between 1 and 52 weeks."}), 400

    export_payload = {**payload, "course_duration": course_duration}
    xml = schedule_to_xml(export_payload)
    return app.response_class(
        xml,
        mimetype="application/xml",
        headers={
            "Content-Disposition": f'attachment; filename="{schedule_xml_filename(export_payload)}"'
        },
    )


@app.post("/api/unit-outline")
def extract_unit_outline():
    uploads = request.files.getlist("files") or request.files.getlist("file")
    uploads = [upload for upload in uploads if upload.filename]
    if not uploads:
        return jsonify({"error": "Upload at least one PDF or DOCX unit outline."}), 400
    invalid_files = [Path(upload.filename).name for upload in uploads if not _is_supported_upload(upload.filename)]
    if invalid_files:
        return jsonify({
            "error": "Only PDF and DOCX unit outlines are accepted.",
            "details": invalid_files,
        }), 415

    extraction_method = request.form.get("extraction_method", "rule-based")
    ollama_host = request.form.get("ollama_host", DEFAULT_OLLAMA_HOST)
    ollama_model = request.form.get("ollama_model", DEFAULT_OLLAMA_MODEL)
    warnings: list[str] = []
    errors: list[str] = []
    units: list[UnitInformation] = []

    for upload in uploads:
        source_file = Path(upload.filename).name
        try:
            outline_text = _extract_upload_text(upload.read(), source_file, preserve_layout=True)
            if extraction_method == "ollama":
                try:
                    unit = parse_unit_outline_text_with_ollama(
                        outline_text,
                        source_file=source_file,
                        model=ollama_model,
                        host=ollama_host,
                    )
                    if not unit.weekly_topics or not unit.assessment_information:
                        rule_unit = parse_unit_outline_text(outline_text, source_file=source_file)
                        if not unit.weekly_topics and rule_unit.weekly_topics:
                            unit.weekly_topics = rule_unit.weekly_topics
                            warnings.append(
                                f"{source_file}: Gemma 4 did not return weekly topics; "
                                "rule-based weekly-topic extraction was used."
                            )
                        if not unit.assessment_information and rule_unit.assessment_information:
                            unit.assessment_information = rule_unit.assessment_information
                            warnings.append(
                                f"{source_file}: Gemma 4 did not return assessment information; "
                                "rule-based assessment extraction was used."
                            )
                except OllamaError as exc:
                    unit = parse_unit_outline_text(outline_text, source_file=source_file)
                    warnings.append(f"{source_file}: Ollama was unavailable ({exc}). Rule-based extraction was used.")
            else:
                unit = parse_unit_outline_text(outline_text, source_file=source_file)
        except Exception as exc:
            errors.append(f"{source_file}: {exc}")
            continue

        missing = []
        for label, value in (
            ("unit code", unit.unit_code),
            ("unit name", unit.unit_name),
            ("teaching weeks", unit.teaching_weeks),
            ("course duration", unit.course_duration),
            ("learning outcomes", unit.learning_outcomes),
            ("assessment information", unit.assessment_information),
            ("weekly topics", unit.weekly_topics),
            ("prerequisite concepts", unit.prerequisite_concepts),
            ("teaching activities", unit.teaching_activities),
            ("breaks / non-teaching weeks", unit.breaks),
            ("scheduling constraints", unit.scheduling_constraints),
        ):
            if not value:
                missing.append(label)
        if missing:
            warnings.append(f"{source_file}: Review fields not found: " + ", ".join(missing) + ".")
        units.append(unit)

    if not units:
        return jsonify({
            "error": "The unit outlines could not be read.",
            "details": errors,
        }), 422

    if errors:
        warnings.append("Some unit outlines could not be read: " + "; ".join(errors))

    def unique(values: list[str]) -> list[str]:
        return list(dict.fromkeys(value for value in values if value))

    grouped_units: dict[str, UnitInformation] = {}
    for index, unit in enumerate(units):
        group_key = unit.unit_code.casefold() if unit.unit_code else f"source:{index}:{unit.source_file.casefold()}"
        if group_key not in grouped_units:
            grouped_units[group_key] = unit
            continue

        existing = grouped_units[group_key]
        existing.unit_name = existing.unit_name or unit.unit_name
        existing.teaching_weeks = max(existing.teaching_weeks, unit.teaching_weeks)
        existing.course_duration = max(existing.course_duration, unit.course_duration)
        existing.learning_outcomes = unique(existing.learning_outcomes + unit.learning_outcomes)
        existing.assessment_information = unique(
            existing.assessment_information + unit.assessment_information
        )
        existing.prerequisite_concepts = unique(existing.prerequisite_concepts + unit.prerequisite_concepts)
        existing.teaching_activities = unique(existing.teaching_activities + unit.teaching_activities)
        existing.breaks = unique(existing.breaks + unit.breaks)
        existing.scheduling_constraints = unique(
            existing.scheduling_constraints + unit.scheduling_constraints
        )
        topic_keys = {(topic.week, topic.topic) for topic in existing.weekly_topics}
        existing.weekly_topics.extend(
            topic for topic in unit.weekly_topics if (topic.week, topic.topic) not in topic_keys
        )
        existing.source_file = ", ".join(unique([existing.source_file, unit.source_file]))

    units = list(grouped_units.values())

    if len(units) == 1:
        combined_unit = units[0]
    else:
        durations = unique([str(unit.course_duration) for unit in units if unit.course_duration])
        if len(durations) > 1:
            warnings.append(
                "The outlines have different course durations; the longest duration was used for the combined schedule."
            )

        combined_unit = UnitInformation(
            unit_code=", ".join(unique([unit.unit_code for unit in units])),
            unit_name="; ".join(unique([unit.unit_name for unit in units])),
            teaching_weeks=max((unit.teaching_weeks for unit in units), default=0),
            course_duration=max((unit.course_duration for unit in units), default=0),
            learning_outcomes=[
                f"{unit.unit_code or unit.source_file}: {value}"
                for unit in units
                for value in unit.learning_outcomes
            ],
            assessment_information=[
                f"{unit.unit_code or unit.source_file}: {value}"
                for unit in units
                for value in unit.assessment_information
            ],
            weekly_topics=[
                WeeklyTopic(
                    week=topic.week,
                    topic=f"{unit.unit_code or unit.source_file}: {topic.topic}",
                )
                for unit in units
                for topic in unit.weekly_topics
            ],
            prerequisite_concepts=unique([
                value for unit in units for value in unit.prerequisite_concepts
            ]),
            teaching_activities=unique([
                value for unit in units for value in unit.teaching_activities
            ]),
            breaks=unique([value for unit in units for value in unit.breaks]),
            scheduling_constraints=unique([
                value for unit in units for value in unit.scheduling_constraints
            ]),
            source_file=", ".join(unit.source_file for unit in units),
        )

    return jsonify({
        "unit": combined_unit.to_dict(),
        "units": [unit.to_dict() for unit in units],
        "warnings": warnings,
    })


MULTI_DUE_COMPONENT_PATTERN = re.compile(
    r"(?:(?P<label>\b(?:part|component|instalment|installment|stage|submission)\s*"
    r"[A-Z0-9]+(?:\s*[-:]\s*[^,;|%]{1,40})?)\s*[,;:]?\s*)?"
    r"(?P<weight>\d+(?:\.\d+)?)\s*%"
    r"(?:(?!\d+(?:\.\d+)?\s*%).){0,100}?"
    r"\bdue(?:\s+date)?s?\s*[:\-]?\s*(?:after|in|at|by)?\s*"
    r"(?P<kind>session|week)\s*(?P<number>\d{1,3})\b",
    re.IGNORECASE,
)

REVERSED_DUE_COMPONENT_PATTERN = re.compile(
    r"\b(?P<kind>session|week)\s*(?P<number>\d{1,3})\b"
    r"\s*(?:[-:|–—]|\()\s*"
    r"(?P<weight>\d+(?:\.\d+)?)\s*%",
    re.IGNORECASE,
)


def _separately_due_components(text: str) -> list[tuple[str, float, str, int, str]]:
    matches: list[tuple[int, str, float, str, int, str]] = []
    occupied: list[tuple[int, int]] = []
    for pattern in (MULTI_DUE_COMPONENT_PATTERN, REVERSED_DUE_COMPONENT_PATTERN):
        for match in pattern.finditer(text):
            if any(match.start() < end and match.end() > start for start, end in occupied):
                continue
            label = str(match.groupdict().get("label") or "").strip(" :-,;")
            matches.append((
                match.start(),
                label,
                float(match.group("weight")),
                match.group("kind").lower(),
                int(match.group("number")),
                match.group(0).strip(),
            ))
            occupied.append((match.start(), match.end()))
    matches.sort(key=lambda value: value[0])
    if len(matches) < 2:
        return []
    return [value[1:] for value in matches]


def _stated_component_label(text: str) -> str:
    match = re.search(
        r"\b((?:part|component|instalment|installment|stage|submission)\s*[A-Z0-9]+"
        r"(?:\s*[-:]\s*[^,;|%]{1,40})?)",
        text,
        re.IGNORECASE,
    )
    return match.group(1).strip(" :-,;") if match else ""


def _draft_items_from_unit_outlines(
    unit_info: dict[str, object],
    units: list[dict[str, object]],
    sessions_per_week: int,
) -> tuple[list[AssessmentItem], list[str]]:
    source_units = units or [unit_info]
    items: list[AssessmentItem] = []
    warnings: list[str] = []

    for unit in source_units:
        values = unit.get("assessment_information", [])
        if not isinstance(values, list):
            continue
        sessions = unit.get("sessions", [])
        session_count = len(sessions) if isinstance(sessions, list) else 0
        subject_code = str(unit.get("unit_code", "")).strip()
        subject_name = str(unit.get("unit_name", "")).strip()
        source_file = str(unit.get("source_file", "")).strip()
        for index, value in enumerate(values, start=1):
            text = str(value).strip()
            if not text:
                continue
            name_match = re.search(
                r"\b(Assessment\s*\d+(?:\s*[:\-]\s*.*?)?)"
                r"(?=\s*(?:[,;|]|\b(?:Individual|Group|Weight(?:ing)?|Worth|Due|Available|Release|Week|Session)\b|\d+(?:\.\d+)?%|$))",
                text,
                re.IGNORECASE,
            )
            if name_match:
                assessment_name = name_match.group(1).strip(" :-")
            else:
                assessment_name = re.split(r"[,;|]", text, maxsplit=1)[0].strip() or f"Assessment {index}"

            weight_match = re.search(
                r"\b(?:weight(?:ing)?|worth)\s*(?:\(%\))?\s*[:\-]?\s*(\d+(?:\.\d+)?)\s*%?",
                text,
                re.IGNORECASE,
            )
            if not weight_match:
                weight_match = re.search(r"\b(\d+(?:\.\d+)?)\s*%", text)
            weight = float(weight_match.group(1)) if weight_match else 0.0
            assessment_type = "Group" if re.search(r"\bgroup\b", text, re.IGNORECASE) else "Individual"
            split_components = _separately_due_components(text)
            if split_components:
                for component_index, (label, component_weight, due_kind, due_number, raw_due) in enumerate(
                    split_components,
                    start=1,
                ):
                    if due_kind == "session":
                        due_session = due_number
                        due_week = (due_session + sessions_per_week - 1) // sessions_per_week
                    else:
                        due_week = due_number
                        due_session = due_week * sessions_per_week
                        if session_count:
                            due_session = min(due_session, session_count)
                    items.append(AssessmentItem(
                        subject_code=subject_code,
                        subject_name=subject_name,
                        assessment_name=assessment_name,
                        component=label or f"Instalment {component_index}",
                        assessment_type=assessment_type,
                        weight=component_weight,
                        due_week=due_week,
                        due_session=due_session,
                        source_file=source_file,
                        raw_due_text=raw_due,
                    ))
                continue

            session_match = re.search(
                r"\b(?:due(?:\s+date)?s?\s*[:\-]?\s*(?:after|in|at|by)?\s*|after\s+)session\s*(\d{1,3})\b",
                text,
                re.IGNORECASE,
            )
            if not session_match:
                session_matches = re.findall(r"\bsession\s*(\d{1,3})\b", text, re.IGNORECASE)
                fallback_session = int(session_matches[-1]) if session_matches else 0
            else:
                fallback_session = 0
            week_match = re.search(
                r"\bdue(?:\s+date)?s?\s*[:\-]?\s*(?:after|in|at|by)?\s*week\s*(\d{1,2})\b",
                text,
                re.IGNORECASE,
            )
            if not week_match:
                week_matches = re.findall(r"\bweek\s*(\d{1,2})\b", text, re.IGNORECASE)
                fallback_week = int(week_matches[-1]) if week_matches else 0
            else:
                fallback_week = 0
            if session_match:
                due_session = int(session_match.group(1))
                due_week = (due_session + sessions_per_week - 1) // sessions_per_week
            elif fallback_session:
                due_session = fallback_session
                due_week = (due_session + sessions_per_week - 1) // sessions_per_week
            elif week_match:
                due_week = int(week_match.group(1))
                due_session = due_week * sessions_per_week
                if session_count:
                    due_session = min(due_session, session_count)
            elif fallback_week:
                due_week = fallback_week
                due_session = due_week * sessions_per_week
                if session_count:
                    due_session = min(due_session, session_count)
            else:
                due_session = 0
                due_week = 0

            item = AssessmentItem(
                subject_code=subject_code,
                subject_name=subject_name,
                assessment_name=assessment_name,
                component=_stated_component_label(text) or "Whole assessment",
                assessment_type=assessment_type,
                weight=weight,
                due_week=due_week,
                due_session=due_session,
                source_file=source_file,
                raw_due_text=text,
            )
            items.append(item)
            missing = []
            if not weight_match:
                missing.append("weight")
            if not session_match and not fallback_session and not week_match and not fallback_week:
                missing.append("due session")
            if missing:
                warnings.append(
                    f"{item.display_name}: review missing {' and '.join(missing)} from the unit outline."
                )
    return items, warnings


@app.post("/api/unit-draft")
def generate_unit_outline_draft():
    payload = request.get_json(silent=True) or {}
    unit_info = payload.get("unit_info", {})
    units = payload.get("units", [])
    try:
        sessions_per_week = int(payload.get("sessions_per_week", 0))
    except (TypeError, ValueError):
        sessions_per_week = 0
    if not isinstance(unit_info, dict) or not isinstance(units, list):
        return jsonify({"error": "Unit information must use the expected structure."}), 400
    if not 1 <= sessions_per_week <= 10:
        return jsonify({"error": "Sessions per week must be a whole number from 1 to 10."}), 400

    unit_values = [value for value in units if isinstance(value, dict)]
    items, warnings = _draft_items_from_unit_outlines(unit_info, unit_values, sessions_per_week)
    if not items:
        return jsonify({
            "error": "No assessment information is available in Step 2. Add an assessment row or upload assessment briefs."
        }), 422
    result = _serialise_result(items, unit_info)
    result["warnings"] = warnings
    result["errors"] = []
    return jsonify(result)


@app.post("/api/generate")
def generate_schedule():
    files = request.files.getlist("files")
    if not files or not any(upload.filename for upload in files):
        return jsonify({"error": "Upload at least one PDF or DOCX assessment brief."}), 400
    invalid_files = [Path(upload.filename).name for upload in files if not _is_supported_upload(upload.filename)]
    if invalid_files:
        return jsonify({
            "error": "Only PDF and DOCX assessment files are accepted.",
            "details": invalid_files,
        }), 415

    extraction_method = request.form.get("extraction_method", "rule-based")
    ollama_host = request.form.get("ollama_host", DEFAULT_OLLAMA_HOST)
    ollama_model = request.form.get("ollama_model", DEFAULT_OLLAMA_MODEL)
    try:
        sessions_per_week = int(request.form.get("sessions_per_week", 0) or 0)
    except (TypeError, ValueError):
        sessions_per_week = 0
    items: list[AssessmentItem] = []
    warnings: list[str] = []
    errors: list[str] = []
    try:
        unit_info = json.loads(request.form.get("unit_info", "{}"))
    except json.JSONDecodeError:
        unit_info = {}
    try:
        unit_infos = json.loads(request.form.get("units", "[]"))
        if not isinstance(unit_infos, list):
            unit_infos = []
    except json.JSONDecodeError:
        unit_infos = []
    try:
        raw_existing_items = json.loads(request.form.get("existing_items", "[]"))
        if not isinstance(raw_existing_items, list):
            raw_existing_items = []
        existing_items = [
            _item_from_json(value) for value in raw_existing_items if isinstance(value, dict)
        ]
    except (json.JSONDecodeError, TypeError, ValueError):
        existing_items = []
    require_ollama_scaffolding = request.form.get(
        "require_ollama_scaffolding", "false"
    ).casefold() in {"1", "true", "yes", "on"}
    if not existing_items and 1 <= sessions_per_week <= 10:
        existing_items, outline_warnings = _draft_items_from_unit_outlines(
            unit_info,
            [value for value in unit_infos if isinstance(value, dict)],
            sessions_per_week,
        )
        warnings.extend(outline_warnings)

    for upload in files:
        source_file = Path(upload.filename or "assessment.pdf").name
        try:
            document_text = _extract_upload_text(upload.read(), source_file)
            if extraction_method == "ollama":
                try:
                    parsed = parse_assessment_text_with_ollama(
                        document_text,
                        source_file=source_file,
                        model=ollama_model,
                        host=ollama_host,
                    )
                except OllamaError as exc:
                    parsed = parse_assessment_text(document_text, source_file=source_file)
                    warnings.append(
                        f"{source_file}: Ollama was unavailable ({exc}). Rule-based extraction was used."
                    )
            else:
                parsed = parse_assessment_text(document_text, source_file=source_file)

            matching_units = [
                value for value in unit_infos
                if isinstance(value, dict)
                and str(value.get("unit_code", "")).strip()
                and re.search(
                    rf"(?<!\w){re.escape(str(value.get('unit_code', '')).strip())}(?!\w)",
                    document_text,
                    re.IGNORECASE,
                )
            ]
            fallback_unit = (
                matching_units[0] if len(matching_units) == 1
                else unit_infos[0] if len(unit_infos) == 1
                else unit_info if not unit_infos
                else {}
            )
            for item in parsed:
                if not item.subject_code:
                    item.subject_code = str(fallback_unit.get("unit_code", ""))
                if not item.subject_name:
                    item.subject_name = str(fallback_unit.get("unit_name", ""))
                if sessions_per_week > 0:
                    if item.due_session > 0:
                        item.due_week = (item.due_session + sessions_per_week - 1) // sessions_per_week
                    elif item.due_week > 0:
                        item.due_session = item.due_week * sessions_per_week
                        sessions = fallback_unit.get("sessions", [])
                        if isinstance(sessions, list) and sessions:
                            item.due_session = min(item.due_session, len(sessions))
            items.extend(parsed)
        except Exception as exc:  # Keep successful files available when one file fails.
            errors.append(f"{source_file}: {exc}")

    if not items:
        return jsonify({"error": "No assessments could be extracted.", "details": errors}), 422

    items = _merge_brief_items_with_schedule(items, existing_items)
    try:
        result = _serialise_result(
            items,
            unit_info,
            extraction_method=extraction_method,
            ollama_model=ollama_model,
            ollama_host=ollama_host,
            require_ollama_scaffolding=require_ollama_scaffolding,
        )
    except OllamaError as exc:
        return jsonify({
            "error": f"Step 5 requires Ollama, but the coverage evaluation could not be completed: {exc}"
        }), 503
    result["warnings"] = [*warnings, *result.get("scaffolding_warnings", [])]
    result["errors"] = errors
    return jsonify(result)


@app.post("/api/analyze")
def analyze_schedule():
    payload = request.get_json(silent=True) or {}
    raw_items = payload.get("items", [])
    unit_info = payload.get("unit_info", {})
    extraction_method = str(payload.get("extraction_method", "rule-based"))
    ollama_host = str(payload.get("ollama_host", DEFAULT_OLLAMA_HOST))
    ollama_model = str(payload.get("ollama_model", DEFAULT_OLLAMA_MODEL))
    require_ollama_scaffolding = bool(payload.get("require_ollama_scaffolding", False))
    if not isinstance(raw_items, list) or not isinstance(unit_info, dict):
        return jsonify({"error": "Items and unit information must use the expected structure."}), 400
    try:
        items = [_item_from_json(value) for value in raw_items if isinstance(value, dict)]
    except (TypeError, ValueError) as exc:
        return jsonify({"error": f"Invalid assessment value: {exc}"}), 400
    try:
        result = _serialise_result(
            items,
            unit_info,
            extraction_method=extraction_method,
            ollama_model=ollama_model,
            ollama_host=ollama_host,
            require_ollama_scaffolding=require_ollama_scaffolding,
        )
    except OllamaError as exc:
        return jsonify({
            "error": f"Step 5 requires Ollama, but the coverage evaluation could not be completed: {exc}"
        }), 503
    return jsonify(result)


@app.post("/api/optimize")
def optimize_schedule():
    payload = request.get_json(silent=True) or {}
    raw_items = payload.get("items", [])
    unit_info = payload.get("unit_info", {})
    extraction_method = str(payload.get("extraction_method", "rule-based"))
    ollama_host = str(payload.get("ollama_host", DEFAULT_OLLAMA_HOST))
    ollama_model = str(payload.get("ollama_model", DEFAULT_OLLAMA_MODEL))
    require_ollama_scaffolding = bool(payload.get("require_ollama_scaffolding", False))
    if not isinstance(raw_items, list) or not isinstance(unit_info, dict):
        return jsonify({"error": "Items and unit information are required."}), 400
    try:
        items = [_item_from_json(value) for value in raw_items if isinstance(value, dict)]
    except (TypeError, ValueError) as exc:
        return jsonify({"error": f"Invalid assessment value: {exc}"}), 400
    items, changes = _optimise_items(items, unit_info)
    try:
        result = _serialise_result(
            items,
            unit_info,
            extraction_method=extraction_method,
            ollama_model=ollama_model,
            ollama_host=ollama_host,
            require_ollama_scaffolding=require_ollama_scaffolding,
        )
    except OllamaError as exc:
        return jsonify({
            "error": f"Step 5 requires Ollama, but the coverage evaluation could not be completed: {exc}"
        }), 503
    result["changes"] = changes
    return jsonify(result)


@app.get("/api/ollama/models")
def ollama_models():
    host = request.args.get("host", DEFAULT_OLLAMA_HOST)
    try:
        return jsonify({"models": list_ollama_models(host)})
    except OllamaError as exc:
        return jsonify({"error": str(exc)}), 503


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=8501, debug=True, use_reloader=False)
