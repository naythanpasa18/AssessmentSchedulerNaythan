from __future__ import annotations

import io
import re
import zipfile
from pathlib import Path
from typing import BinaryIO
from xml.etree import ElementTree

from .models import AssessmentItem


SPACE_RE = re.compile(r"\s+")
WEEK_RE = re.compile(r"\bWeek\s*(\d{1,2})\b", re.IGNORECASE)
SESSION_RE = re.compile(r"\bSession\s*(\d{1,3})\b", re.IGNORECASE)
NUMBER_RE = re.compile(r"\bAssessment\s+(\d+)\b", re.IGNORECASE)


def _flatten(text: str) -> str:
    return SPACE_RE.sub(" ", text).strip()


def _clean_title(value: str) -> str:
    return value.strip(" :-")


def _extract_first(pattern: str, text: str, default: str = "") -> str:
    match = re.search(pattern, text, flags=re.IGNORECASE)
    return match.group(1).strip() if match else default


def _extract_identity(flat: str) -> tuple[str, str, str, str]:
    subject_match = re.search(
        r"Subject\s+Code\s+and\s+Name\s+([A-Z]{2,}\d{4})\s+(.+?)\s+"
        r"Assessment\s+Assessment\s+\d+",
        flat,
        flags=re.IGNORECASE,
    )
    if subject_match:
        subject_code = subject_match.group(1).upper()
        subject_name = subject_match.group(2).strip()
    else:
        subject_code = _extract_first(r"\b([A-Z]{2,}\d{4})\b", flat)
        subject_name = ""

    assessment_name = _extract_first(
        r"Assessment\s+(Assessment\s+\d+\s*:.+?)\s+Assessment\s+Type",
        flat,
        "Untitled assessment",
    )
    assessment_name = _clean_title(assessment_name)

    assessment_type = _extract_first(
        r"Assessment\s+Type\s+(.+?)\s+Assessment\s+Details",
        flat,
        "Unspecified",
    )
    return subject_code, subject_name, assessment_name, assessment_type


def _extract_due_text(flat: str) -> str:
    patterns = (
        r"Submission\s+and\s+Presentation\s+Dates\s+(.+?)\s+Assessment\s+Criteria",
        r"Submission\s+Date\s+(.+?)\s+Minimum\s+Sources",
        r"Submission\s+Date\s+(.+?)\s+Assessment\s+Criteria",
    )
    for pattern in patterns:
        value = _extract_first(pattern, flat)
        if value:
            return value
    return ""


def _extract_weight_block(flat: str) -> str:
    return _extract_first(
        r"Assessment\s+Weight\s+(.+?)\s+"
        r"(?:Word\s+Count|Submission(?:\s+and\s+Presentation)?\s+Dates?|Assessment\s+Criteria)",
        flat,
    )


def _total_weight(weight_block: str, flat: str) -> float:
    total = re.search(r"(\d+(?:\.\d+)?)%\s+Total", weight_block, re.IGNORECASE)
    if total:
        return float(total.group(1))
    first = re.search(r"(\d+(?:\.\d+)?)%", weight_block)
    if first:
        return float(first.group(1))
    fallback = re.search(r"Assessment\s+Weight\s+(\d+(?:\.\d+)?)%", flat, re.IGNORECASE)
    return float(fallback.group(1)) if fallback else 0.0


def _component_weights_without_modes(weight_block: str) -> list[tuple[str, float]]:
    pattern = re.compile(
        r"Part\s+[A-Z]\s*:\s*(.+?)\s*\([^)]*\)\s*[\-–—]\s*(\d+(?:\.\d+)?)%",
        re.IGNORECASE,
    )
    return [(name.strip(" :-"), float(weight)) for name, weight in pattern.findall(weight_block)]


def _component_weights(weight_block: str) -> list[tuple[str, str, float]]:
    pattern = re.compile(
        r"Part\s+[A-Z]\s*:\s*(.+?)\s*\(([^)]*)\)\s*[^0-9%]*\s*(\d+(?:\.\d+)?)%",
        re.IGNORECASE,
    )
    components = [
        (name.strip(" :-"), participation.strip(), float(weight))
        for name, participation, weight in pattern.findall(weight_block)
    ]
    if components:
        return components
    return [
        (name, "", weight)
        for name, weight in _component_weights_without_modes(weight_block)
    ]


def _component_assessment_type(participation: str, overall_type: str) -> str:
    has_group = bool(re.search(r"\bgroup\b", participation, re.IGNORECASE))
    has_individual = bool(re.search(r"\bindividual\b", participation, re.IGNORECASE))
    if has_group and has_individual:
        return "Group/Individual"
    if has_group:
        return "Group"
    if has_individual:
        return "Individual"
    return overall_type


def _week_for_component(component: str, due_text: str) -> int | None:
    due_segments = re.findall(
        r"Week\s*(\d{1,2})\s*:\s*(.+?)(?=\s+Week\s*\d{1,2}\s*:|$)",
        due_text,
        flags=re.IGNORECASE,
    )
    component_key = component.lower()
    aliases = [component_key]
    if "q&a" in component_key or "q & a" in component_key:
        aliases.extend(["q&a", "q & a", "q and a"])

    for week, description in due_segments:
        description_lower = description.lower()
        if any(alias in description_lower for alias in aliases):
            return int(week)
    return None


def _session_for_component(component: str, due_text: str) -> int | None:
    due_segments = re.findall(
        r"Session\s*(\d{1,3})\s*:\s*(.+?)(?=\s+Session\s*\d{1,3}\s*:|$)",
        due_text,
        flags=re.IGNORECASE,
    )
    component_key = component.lower()
    aliases = [component_key]
    if "q&a" in component_key or "q & a" in component_key:
        aliases.extend(["q&a", "q & a", "q and a"])

    for session, description in due_segments:
        description_lower = description.lower()
        if any(alias in description_lower for alias in aliases):
            return int(session)
    return None


def _primary_due_week(due_text: str, flat: str) -> int:
    final_match = re.search(
        r"Final\s+Portfolio\s+Submission\s*:\s*(?:End\s+of\s+)?Week\s*(\d{1,2})",
        due_text,
        flags=re.IGNORECASE,
    )
    if final_match:
        return int(final_match.group(1))

    weeks = [int(value) for value in WEEK_RE.findall(due_text)]
    if weeks:
        return max(weeks)

    # Last-resort fallback for less structured briefs.
    weeks = [int(value) for value in WEEK_RE.findall(flat[:5000])]
    return max(weeks) if weeks else 0


def _primary_due_session(due_text: str, flat: str) -> int:
    sessions = [int(value) for value in SESSION_RE.findall(due_text)]
    if sessions:
        return max(sessions)
    sessions = [int(value) for value in SESSION_RE.findall(flat[:5000])]
    return max(sessions) if sessions else 0


def _extract_analysis_fields(flat: str) -> dict[str, object]:
    outcomes_block = _extract_first(
        r"(?:Subject|Unit)\s+Learning\s+Outcomes\s+addressed\s*:\s*(.+?)\s+"
        r"(?:Course\s+Learning\s+Outcomes|Assessment\s+(?:Description|Task)|RUBRIC|Marking\s+Rubric)",
        flat,
    )
    outcome_codes = list(dict.fromkeys(re.findall(r"\b(?:SLO|ULO|LO)\s*\d+\b", outcomes_block, re.IGNORECASE)))

    required_topics = _extract_first(
        r"Required\s+(?:Topics|Knowledge|Skills)\s*[:\-]?\s*(.+?)\s+"
        r"(?:Estimated\s+Workload|Preparation\s+Time|Dependencies|Feedback\s+Requirements|Assessment\s+Criteria)",
        flat,
    )
    dependencies = _extract_first(
        r"(?:Assessment\s+)?Dependencies\s*[:\-]?\s*(.+?)\s+"
        r"(?:Feedback\s+Requirements|Assessment\s+Criteria|Subject\s+Learning\s+Outcomes)",
        flat,
    )
    feedback = _extract_first(
        r"Feedback\s+Requirements\s*[:\-]?\s*(.+?)\s+"
        r"(?:Assessment\s+Criteria|Subject\s+Learning\s+Outcomes|Submission)",
        flat,
    )
    workload = re.search(r"Estimated\s+Workload\s*[:\-]?\s*(\d+(?:\.\d+)?)\s*hours?", flat, re.IGNORECASE)
    preparation = re.search(r"Preparation\s+Time\s*[:\-]?\s*(\d+)\s*weeks?", flat, re.IGNORECASE)

    def split_values(value: str) -> list[str]:
        if not value:
            return []
        return [part.strip(" ,;•-") for part in re.split(r"[;•]|\s+-\s+", value) if part.strip(" ,;•-")]

    return {
        "learning_outcomes_assessed": [code.upper().replace(" ", "") for code in outcome_codes],
        "required_topics_skills": split_values(required_topics),
        "estimated_workload_hours": float(workload.group(1)) if workload else 0.0,
        "preparation_weeks": int(preparation.group(1)) if preparation else 0,
        "dependencies": split_values(dependencies),
        "feedback_requirements": split_values(feedback),
    }


def parse_assessment_text(text: str, source_file: str = "") -> list[AssessmentItem]:
    """Convert extracted PDF text into editable scheduling rows."""

    flat = _flatten(text)
    subject_code, subject_name, assessment_name, assessment_type = _extract_identity(flat)
    due_text = _extract_due_text(flat)
    weight_block = _extract_weight_block(flat)
    total_weight = _total_weight(weight_block, flat)
    components = _component_weights(weight_block)
    analysis_fields = _extract_analysis_fields(flat)

    if components:
        items: list[AssessmentItem] = []
        fallback_week = _primary_due_week(due_text, flat)
        fallback_session = _primary_due_session(due_text, flat)
        for component, participation, weight in components:
            due_week = _week_for_component(component, due_text) or fallback_week
            due_session = _session_for_component(component, due_text) or fallback_session
            items.append(
                AssessmentItem(
                    subject_code=subject_code,
                    subject_name=subject_name,
                    assessment_name=assessment_name,
                    component=component,
                    assessment_type=_component_assessment_type(participation, assessment_type),
                    weight=weight,
                    due_week=due_week,
                    due_session=due_session,
                    source_file=source_file,
                    raw_due_text=due_text,
                    **analysis_fields,
                )
            )
        return items

    return [
        AssessmentItem(
            subject_code=subject_code,
            subject_name=subject_name,
            assessment_name=assessment_name,
            component="Whole assessment",
            assessment_type=assessment_type,
            weight=total_weight,
            due_week=_primary_due_week(due_text, flat),
            due_session=_primary_due_session(due_text, flat),
            source_file=source_file,
            raw_due_text=due_text,
            **analysis_fields,
        )
    ]


def extract_pdf_text(
    file: str | Path | bytes | BinaryIO,
    preserve_layout: bool = False,
) -> str:
    """Extract text from a path, byte string, or uploaded file object."""

    try:
        from pypdf import PdfReader
    except ImportError as exc:  # pragma: no cover - depends on environment
        raise RuntimeError("PDF support requires the 'pypdf' package.") from exc

    if isinstance(file, bytes):
        source = io.BytesIO(file)
    else:
        source = file

    reader = PdfReader(source)
    extraction_mode = "layout" if preserve_layout else "plain"
    return "\n".join(
        page.extract_text(extraction_mode=extraction_mode) or ""
        for page in reader.pages
    )


def extract_docx_text(file: str | Path | bytes | BinaryIO) -> str:
    """Extract paragraph and table text from a DOCX file in document order."""

    if isinstance(file, bytes):
        source: str | Path | BinaryIO = io.BytesIO(file)
    else:
        source = file

    try:
        with zipfile.ZipFile(source) as archive:
            document_xml = archive.read("word/document.xml")
    except (zipfile.BadZipFile, KeyError) as exc:
        raise ValueError("The file is not a valid DOCX document.") from exc

    try:
        root = ElementTree.fromstring(document_xml)
    except ElementTree.ParseError as exc:
        raise ValueError("The DOCX document content is invalid.") from exc

    namespace = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
    lines: list[str] = []
    for paragraph in root.iter(f"{namespace}p"):
        parts: list[str] = []
        for element in paragraph.iter():
            if element.tag == f"{namespace}t" and element.text:
                parts.append(element.text)
            elif element.tag == f"{namespace}tab":
                parts.append("\t")
            elif element.tag in {f"{namespace}br", f"{namespace}cr"}:
                parts.append("\n")
        text = "".join(parts).strip()
        if text:
            lines.append(text)
    return "\n".join(lines)


def parse_assessment_pdf(file: str | Path | bytes | BinaryIO, source_file: str = "") -> list[AssessmentItem]:
    if not source_file and isinstance(file, (str, Path)):
        source_file = Path(file).name
    return parse_assessment_text(extract_pdf_text(file), source_file=source_file)
