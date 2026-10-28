const state = {
  unitFiles: [],
  units: [],
  activeUnitIndex: 0,
  unitInfo: null,
  assessmentFiles: [],
  activeAssessmentSubject: "",
  activeSequenceSubject: "",
  activeValidationSubject: "",
  items: [],
  schedule: [],
  feedback: [],
  scaffolding: [],
  scaffoldingSource: "rule-based",
  scaffoldingModel: "",
  scaffoldingWarnings: [],
  courseDuration: 12,
  sessionsPerWeek: 0,
  sessionScheduleConfirmed: false,
  assessmentBriefsProcessed: false,
  review: { reviewer: "", decision: "", comments: "" },
  published: false,
  savedScheduleId: "",
  scheduleSavedAt: "",
  scheduleSavePending: false,
  scheduleSaveMessage: "",
  scheduleRevision: 0
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const extractionMethod = $("#extractionMethod");
let unitTimerInterval = null;
let unitTimerStartedAt = 0;

function formatElapsed(milliseconds) {
  const seconds = milliseconds / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${(seconds % 60).toFixed(1)}s`;
}

function startUnitTimer() {
  const timer = $("#unitGenerationTimer");
  if (unitTimerInterval) window.clearInterval(unitTimerInterval);
  unitTimerStartedAt = performance.now();
  timer.hidden = false;
  timer.className = "generation-timer running";
  timer.textContent = "Elapsed: 0.0s";
  unitTimerInterval = window.setInterval(() => {
    timer.textContent = `Elapsed: ${formatElapsed(performance.now() - unitTimerStartedAt)}`;
  }, 100);
}

function stopUnitTimer(completed) {
  if (unitTimerInterval) window.clearInterval(unitTimerInterval);
  unitTimerInterval = null;
  const timer = $("#unitGenerationTimer");
  const duration = formatElapsed(performance.now() - unitTimerStartedAt);
  timer.className = `generation-timer ${completed ? "complete" : "failed"}`;
  timer.textContent = `${completed ? "Completed in" : "Stopped after"}: ${duration}`;
}

function setSectionCollapsed(section, collapsed) {
  if (!section) return;
  section.classList.toggle("is-collapsed", collapsed);
  const button = section.querySelector(":scope > .section-heading .section-collapse-button");
  if (!button) return;
  button.setAttribute("aria-expanded", String(!collapsed));
  button.textContent = collapsed ? "⌄" : "⌃";
  const title = section.querySelector("h1, h2")?.textContent || "section";
  button.setAttribute("aria-label", `${collapsed ? "Expand" : "Collapse"} ${title}`);
  button.title = `${collapsed ? "Expand" : "Collapse"} section`;
}

function setupCollapsibleSections() {
  $$(".content-section").forEach((section) => {
    const heading = section.querySelector(":scope > .section-heading");
    if (!heading || heading.querySelector(".section-collapse-button")) return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "section-collapse-button";
    heading.appendChild(button);
    button.addEventListener("click", () => setSectionCollapsed(section, !section.classList.contains("is-collapsed")));
    setSectionCollapsed(section, false);
  });
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
  })[char]);
}

function splitLines(value) {
  return String(value || "").split("\n").map((line) => line.trim()).filter(Boolean);
}

function splitBulletLines(value) {
  return splitLines(value).map((line) => line.replace(/^(?:[\u2022*-]|\d+[.)])\s*/, "").trim()).filter(Boolean);
}

function formatBulletList(items) {
  return (items || []).filter((item) => String(item).trim()).map((item) => `\u2022 ${String(item).trim()}`).join("\n");
}

function setStatus(label, mode = "ready") {
  $("#appStatus").textContent = label;
  const pill = $(".status-pill");
  pill.classList.toggle("busy", mode === "busy");
  pill.classList.toggle("error", mode === "error");
}

function showMessages(selector, messages = [], type = "warning") {
  $(selector).innerHTML = messages
    .map((message) => `<div class="notice ${type}">${escapeHtml(message)}</div>`)
    .join("");
}

async function readApiResponse(response) {
  const body = await response.text();
  try {
    return body ? JSON.parse(body) : {};
  } catch (_error) {
    const restartHint = response.status === 404 || response.status === 405
      ? " The local server may be running an older version; stop it, start it again, and refresh this page."
      : "";
    throw new Error(`The server returned an unexpected response (${response.status}).${restartHint}`);
  }
}

function setupDropZone(input, zone, callback) {
  input.addEventListener("change", () => {
    callback(input.files);
    input.value = "";
  });
  ["dragenter", "dragover"].forEach((name) => zone.addEventListener(name, (event) => {
    event.preventDefault();
    zone.classList.add("dragover");
  }));
  ["dragleave", "drop"].forEach((name) => zone.addEventListener(name, (event) => {
    event.preventDefault();
    zone.classList.remove("dragover");
  }));
  zone.addEventListener("drop", (event) => callback(event.dataTransfer.files));
}

function validDocument(file) {
  if (!file) return false;
  return [".pdf", ".docx"].some((extension) => file.name.toLowerCase().endsWith(extension));
}

function documentTag(file) {
  return file.name.toLowerCase().endsWith(".docx") ? "DOCX" : "PDF";
}

function resetAssessmentWorkflow(clearFiles = true) {
  state.activeAssessmentSubject = "";
  state.activeSequenceSubject = "";
  state.activeValidationSubject = "";
  state.items = [];
  state.schedule = [];
  state.feedback = [];
  state.scaffolding = [];
  state.scaffoldingSource = "rule-based";
  state.scaffoldingModel = "";
  state.scaffoldingWarnings = [];
  state.assessmentBriefsProcessed = false;
  state.review = { reviewer: "", decision: "", comments: "" };
  state.published = false;
  markScheduleUnsaved();
  $$(".results-section").forEach((section) => { section.hidden = true; });
  $("#exportButton").disabled = true;
  $("#exportXmlButton").disabled = true;
  $("#clearButton").disabled = true;
  if (clearFiles) {
    state.sessionsPerWeek = 0;
    state.sessionScheduleConfirmed = false;
    state.assessmentFiles = [];
    $("#fileInput").value = "";
    $("#fileList").innerHTML = "";
    $("#generateButton").disabled = true;
    $("#uploadHint").textContent = "Upload at least one assessment brief to continue to Steps 5 and 6.";
    showMessages("#messageArea", []);
  }
  setStatus("Ready");
}

function markScheduleUnsaved() {
  state.savedScheduleId = "";
  state.scheduleSavedAt = "";
  state.scheduleSaveMessage = "";
  state.scheduleRevision += 1;
}

function addUnitFiles(files) {
  const selectedFiles = [...files];
  const rejectedFiles = selectedFiles.filter((file) => !validDocument(file));
  const existingFiles = new Set(
    state.unitFiles.map((file) => `${file.name.toLowerCase()}:${file.size}:${file.lastModified}`)
  );
  const duplicateFiles = selectedFiles.filter((file) => (
    validDocument(file) && existingFiles.has(`${file.name.toLowerCase()}:${file.size}:${file.lastModified}`)
  ));
  const addedFiles = selectedFiles.filter((file) => {
    if (!validDocument(file)) return false;
    const key = `${file.name.toLowerCase()}:${file.size}:${file.lastModified}`;
    if (existingFiles.has(key)) return false;
    existingFiles.add(key);
    return true;
  });

  if (addedFiles.length) {
    state.unitFiles.push(...addedFiles);
    state.units = [];
    state.activeUnitIndex = 0;
    state.unitInfo = null;
    $("#unit-information").hidden = true;
    $("#assessment-upload").hidden = true;
    $("#courseDurationBadge").textContent = "Course length from outline";
    if (unitTimerInterval) window.clearInterval(unitTimerInterval);
    unitTimerInterval = null;
    $("#unitGenerationTimer").hidden = true;
    resetAssessmentWorkflow(true);
  }

  $("#unitFileList").innerHTML = state.unitFiles.map((file) => `
    <div class="file-row"><span class="pdf-tag">${documentTag(file)}</span><strong>${escapeHtml(file.name)}</strong><span>${(file.size / 1024).toFixed(1)} KB</span></div>
  `).join("");
  $("#extractUnitButton").disabled = state.unitFiles.length === 0;
  $("#unitUploadHint").textContent = state.unitFiles.length
    ? `${state.unitFiles.length} unit outline${state.unitFiles.length === 1 ? "" : "s"} ready for extraction.`
    : "Upload one or more unit outlines to begin.";
  const messages = [];
  if (rejectedFiles.length) {
    messages.push(`Only PDF and DOCX files are accepted. Ignored: ${rejectedFiles.map((file) => file.name).join(", ")}`);
  }
  if (duplicateFiles.length) {
    messages.push(`Already added: ${duplicateFiles.map((file) => file.name).join(", ")}`);
  }
  showMessages(
    "#unitMessageArea",
    messages,
    rejectedFiles.length ? "error" : "warning"
  );
}

setupDropZone($("#unitFileInput"), $("#unitDropZone"), addUnitFiles);
$("#addUnitFileButton").addEventListener("click", () => $("#unitFileInput").click());

$("#extractUnitButton").addEventListener("click", async () => {
  if (!state.unitFiles.length) return;
  const formData = new FormData();
  state.unitFiles.forEach((file) => formData.append("files", file));
  formData.append("extraction_method", extractionMethod.value);
  formData.append("ollama_host", $("#ollamaHost").value);
  formData.append("ollama_model", $("#ollamaModel").value);
  const button = $("#extractUnitButton");
  button.disabled = true;
  button.querySelector("span").textContent = "Extracting…";
  startUnitTimer();
  let extractionCompleted = false;
  setStatus("Extracting unit", "busy");
  showMessages("#unitMessageArea", []);
  try {
    const response = await fetch("/api/unit-outline", { method: "POST", body: formData });
    const data = await readApiResponse(response);
    if (!response.ok) throw new Error(data.error || "Unit information could not be extracted.");
    state.units = data.units || [data.unit];
    state.activeUnitIndex = 0;
    syncCombinedUnitInformation();
    renderUnitInformation();
    $("#unit-information").hidden = false;
    showMessages("#unitMessageArea", data.warnings || [], "warning");
    extractionCompleted = true;
    setStatus("Unit extracted");
    setSectionCollapsed($("#unit-information"), false);
    $("#unit-information").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    showMessages("#unitMessageArea", [error.message], "error");
    setStatus("Error", "error");
  } finally {
    stopUnitTimer(extractionCompleted);
    button.disabled = state.unitFiles.length === 0;
    button.querySelector("span").textContent = "Extract unit information";
  }
});

function activeUnitInformation() {
  return state.units[state.activeUnitIndex] || null;
}

function ensureUnitSessionPlan(unit) {
  if (!unit) return;
  if (!Array.isArray(unit.sessions)) {
    unit.sessions = (unit.weekly_topics || []).map((entry, index) => ({
      session: index + 1,
      topic: String(entry.topic || ""),
      source_week: String(entry.week || index + 1)
    }));
  }
  unit.sessions = unit.sessions.map((session, index) => ({
    session: index + 1,
    topic: String(session.topic || ""),
    source_week: String(session.source_week || session.week || index + 1)
  }));
}

function syncWeeklyTopicsFromSessions(unit) {
  const useTeachingWeeks = state.sessionScheduleConfirmed && state.sessionsPerWeek > 0;
  unit.weekly_topics = (unit.sessions || [])
    .filter((session) => String(session.topic || "").trim())
    .map((session, index) => ({
      week: String(useTeachingWeeks
        ? Math.ceil((Number(session.session) || index + 1) / state.sessionsPerWeek)
        : (session.source_week || index + 1)),
      topic: String(session.topic || "").trim()
    }));
}

function uniqueUnitValues(values) {
  return [...new Set(values.filter((value) => String(value || "").trim()))];
}

function syncCombinedUnitInformation() {
  if (!state.units.length) {
    state.unitInfo = null;
    return;
  }
  state.units.forEach(ensureUnitSessionPlan);
  if (state.units.length === 1) {
    state.unitInfo = state.units[0];
  } else {
    state.unitInfo = {
      unit_code: uniqueUnitValues(state.units.map((unit) => unit.unit_code)).join(", "),
      unit_name: uniqueUnitValues(state.units.map((unit) => unit.unit_name)).join("; "),
      teaching_weeks: Math.max(0, ...state.units.map((unit) => Number(unit.teaching_weeks) || 0)),
      course_duration: Math.max(0, ...state.units.map((unit) => Number(unit.course_duration) || 0)),
      sessions: state.units.flatMap((unit) => (unit.sessions || []).map((session) => ({
        ...session,
        unit_code: unit.unit_code || ""
      }))),
      learning_outcomes: state.units.flatMap((unit) => (unit.learning_outcomes || []).map(
        (outcome) => `${unit.unit_code || unit.source_file}: ${outcome}`
      )),
      assessment_information: state.units.flatMap((unit) => (unit.assessment_information || []).map(
        (value) => `${unit.unit_code || unit.source_file}: ${value}`
      )),
      weekly_topics: state.units.flatMap((unit) => (unit.weekly_topics || []).map((topic) => ({
        week: topic.week,
        topic: `${unit.unit_code || unit.source_file}: ${topic.topic}`
      }))),
      prerequisite_concepts: uniqueUnitValues(state.units.flatMap((unit) => unit.prerequisite_concepts || [])),
      teaching_activities: uniqueUnitValues(state.units.flatMap((unit) => unit.teaching_activities || [])),
      breaks: uniqueUnitValues(state.units.flatMap((unit) => unit.breaks || [])),
      scheduling_constraints: uniqueUnitValues(state.units.flatMap((unit) => unit.scheduling_constraints || [])),
      source_file: state.units.map((unit) => unit.source_file).filter(Boolean).join(", ")
    };
  }
  state.courseDuration = Number(state.unitInfo.course_duration) || 12;
  $("#courseDurationBadge").textContent = state.units.length > 1
    ? `${state.courseDuration}-week combined schedule`
    : `${state.courseDuration}-week course`;
}

function renderUnitSelector() {
  const panel = $("#unitSelectorPanel");
  const selector = $("#unitSelector");
  panel.hidden = state.units.length < 2;
  selector.innerHTML = state.units.map((unit, index) => {
    const code = unit.unit_code || `Unit ${index + 1}`;
    const name = unit.unit_name ? ` — ${unit.unit_name}` : "";
    return `<option value="${index}">${escapeHtml(code + name)}</option>`;
  }).join("");
  selector.value = String(state.activeUnitIndex);
}

function renderUnitInformation() {
  const unit = activeUnitInformation();
  if (!unit) return;
  renderUnitSelector();
  $("#unitCode").value = unit.unit_code || "";
  $("#unitName").value = unit.unit_name || "";
  ensureUnitSessionPlan(unit);
  $("#numberOfSessions").value = unit.sessions.length;
  $("#learningOutcomes").value = formatBulletList(unit.learning_outcomes);
  $("#unitSource").textContent = unit.source_file ? `Source: ${unit.source_file}` : "";
  $(".breadcrumb span:last-child").textContent = state.units.length > 1
    ? `${state.units.length} units`
    : (unit.unit_code || "MBAI coursework");
  renderAssessmentInformation();
  renderSessionPlan();
}

$("#unitSelector").addEventListener("change", (event) => {
  state.activeUnitIndex = Number(event.target.value) || 0;
  renderUnitInformation();
});

const unitFieldBindings = {
  unitCode: ["unit_code", false],
  unitName: ["unit_name", false],
  learningOutcomes: ["learning_outcomes", true]
};
Object.entries(unitFieldBindings).forEach(([id, [field, isList]]) => {
  $(`#${id}`).addEventListener("change", (event) => {
    const unit = activeUnitInformation();
    if (!unit) return;
    unit[field] = isList
      ? splitBulletLines(event.target.value)
      : event.target.value;
    if (isList) event.target.value = formatBulletList(unit[field]);
    syncCombinedUnitInformation();
    if (id === "unitCode" || id === "unitName") renderUnitSelector();
  });
});

$("#learningOutcomes").addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  const field = event.currentTarget;
  const start = field.selectionStart;
  const end = field.selectionEnd;
  field.setRangeText("\n\u2022 ", start, end, "end");
  field.dispatchEvent(new Event("input", { bubbles: true }));
});

function renderAssessmentInformation() {
  const unit = activeUnitInformation();
  if (!unit) return;
  ensureUnitSessionPlan(unit);
  unit.assessment_information = unit.assessment_information || [];
  $("#assessmentInformationBody").innerHTML = unit.assessment_information.length
    ? unit.assessment_information.map((value, index) => {
      const numberMatch = String(value).match(/^\s*Assessment\s*(\d+)/i);
      const label = numberMatch ? `Assessment ${numberMatch[1]}` : `Assessment ${index + 1}`;
      const assessmentText = String(value);
      const dueSessions = Array.from(assessmentText.matchAll(/\bdue(?:\s+date)?s?\s*[:\-]?\s*(?:after|in|at|by)?\s*session\s*(\d{1,3})\b/gi));
      const fallbackSessions = Array.from(assessmentText.matchAll(/\bsession\s*(\d{1,3})\b/gi));
      const dueWeeks = Array.from(assessmentText.matchAll(/\bdue(?:\s+date)?s?\s*[:\-]?\s*(?:after|in|at|by)?\s*week\s*(\d{1,2})\b/gi));
      const fallbackWeeks = Array.from(assessmentText.matchAll(/\bweek\s*(\d{1,2})\b/gi));
      const sessionsPerWeek = Number($("#scheduleSessionsPerWeek")?.value) || 0;
      const percentageCount = Array.from(assessmentText.matchAll(/\d+(?:\.\d+)?\s*%/g)).length;
      const statedSessions = dueSessions.length
        ? dueSessions.map((match) => Number(match[1]))
        : (percentageCount > 1
          ? fallbackSessions.map((match) => Number(match[1]))
          : [Number(fallbackSessions.at(-1)?.[1] || 0)]);
      const statedWeeks = dueWeeks.length
        ? dueWeeks.map((match) => Number(match[1]))
        : (percentageCount > 1
          ? fallbackWeeks.map((match) => Number(match[1]))
          : [Number(fallbackWeeks.at(-1)?.[1] || 0)]);
      const calculatedSessions = [...new Set(
        statedSessions.filter(Boolean).length
          ? statedSessions.filter(Boolean)
          : statedWeeks.filter(Boolean).map((week) => (
            sessionsPerWeek
              ? Math.min(week * sessionsPerWeek, unit.sessions.length || Infinity)
              : 0
          )).filter(Boolean)
      )];
      const matchingAssessmentIndexes = unit.assessment_information
        .map((candidate, candidateIndex) => ({
          candidateIndex,
          number: String(candidate).match(/^\s*Assessment\s*(\d+)/i)?.[1] || ""
        }))
        .filter((candidate) => candidate.number && candidate.number === numberMatch?.[1])
        .map((candidate) => candidate.candidateIndex);
      const explicitPart = assessmentText.match(/\bpart\s+([a-z0-9]+)/i);
      const timingCount = Math.max(dueSessions.length, dueWeeks.length, calculatedSessions.length);
      const partCount = timingCount > 1 ? timingCount : 1;
      let partLabels = [];
      if (partCount > 1) {
        partLabels = Array.from({ length: partCount }, (_, partIndex) => (
          `Part ${partIndex < 26 ? String.fromCharCode(65 + partIndex) : partIndex + 1}`
        ));
      } else if (explicitPart) {
        partLabels = [`Part ${explicitPart[1].toUpperCase()}`];
      } else if (matchingAssessmentIndexes.length > 1) {
        const partIndex = matchingAssessmentIndexes.indexOf(index);
        partLabels = [`Part ${partIndex < 26 ? String.fromCharCode(65 + partIndex) : partIndex + 1}`];
      }
      const assessmentLabels = partLabels.length
        ? partLabels.map((partLabel) => `${label} ${partLabel}`)
        : [label];
      const dueSessionLabels = calculatedSessions.length
        ? calculatedSessions.map((session, sessionIndex) => (
          `${partLabels[sessionIndex] ? `${partLabels[sessionIndex]} — ` : ""}Session ${session}`
        ))
        : ["Not stated"];
      return `
      <tr>
        <td>${assessmentLabels.map((assessmentLabel) => `<strong class="assessment-part-label">${escapeHtml(assessmentLabel)}</strong>`).join("")}</td>
        <td><input value="${escapeHtml(value)}" data-assessment-info-index="${index}" aria-label="Information for ${escapeHtml(label)}"></td>
        <td>${dueSessionLabels.map((dueLabel) => `<strong class="assessment-part-label">${escapeHtml(dueLabel)}</strong>`).join("")}</td>
        <td><button class="row-delete" data-assessment-info-delete="${index}" aria-label="Remove ${escapeHtml(label)}">×</button></td>
      </tr>`;
    }).join("")
    : '<tr><td class="empty-topics" colspan="4">No assessment information was found in the unit outline.</td></tr>';

  $$('[data-assessment-info-index]').forEach((input) => input.addEventListener("change", () => {
    unit.assessment_information[Number(input.dataset.assessmentInfoIndex)] = input.value;
    syncCombinedUnitInformation();
    renderAssessmentInformation();
  }));
  $$('[data-assessment-info-delete]').forEach((button) => button.addEventListener("click", () => {
    unit.assessment_information.splice(Number(button.dataset.assessmentInfoDelete), 1);
    syncCombinedUnitInformation();
    renderAssessmentInformation();
  }));
}

$("#addAssessmentInformationButton").addEventListener("click", () => {
  const unit = activeUnitInformation();
  if (!unit) return;
  unit.assessment_information = unit.assessment_information || [];
  unit.assessment_information.push("");
  syncCombinedUnitInformation();
  renderAssessmentInformation();
});

function renderSessionPlan() {
  const unit = activeUnitInformation();
  if (!unit) return;
  ensureUnitSessionPlan(unit);
  $("#numberOfSessions").value = unit.sessions.length;
  $("#sessionPlanBody").innerHTML = unit.sessions.length
    ? unit.sessions.map((session, index) => `
      <tr>
        <td><strong>Session ${session.session}</strong></td>
        <td><input value="${escapeHtml(session.topic)}" data-session-index="${index}" aria-label="Topic for session ${session.session}"></td>
        <td><button class="row-delete" data-session-delete="${index}" aria-label="Remove session ${session.session}">×</button></td>
      </tr>
    `).join("")
    : '<tr><td class="empty-topics" colspan="3">No sessions were extracted. Add a session to continue.</td></tr>';
  $$('[data-session-index]').forEach((input) => input.addEventListener("change", () => {
    unit.sessions[Number(input.dataset.sessionIndex)].topic = input.value;
    syncWeeklyTopicsFromSessions(unit);
    syncCombinedUnitInformation();
  }));
  $$('[data-session-delete]').forEach((button) => button.addEventListener("click", () => {
    unit.sessions.splice(Number(button.dataset.sessionDelete), 1);
    ensureUnitSessionPlan(unit);
    syncWeeklyTopicsFromSessions(unit);
    syncCombinedUnitInformation();
    renderSessionPlan();
    invalidateSessionSchedule();
    renderAssessmentInformation();
  }));
}

$("#addSessionButton").addEventListener("click", () => {
  const unit = activeUnitInformation();
  if (!unit) return;
  ensureUnitSessionPlan(unit);
  unit.sessions.push({
    session: unit.sessions.length + 1,
    topic: "",
    source_week: String(unit.sessions.length + 1)
  });
  syncWeeklyTopicsFromSessions(unit);
  syncCombinedUnitInformation();
  renderSessionPlan();
  invalidateSessionSchedule();
  renderAssessmentInformation();
});

function totalTeachingSessions() {
  return Math.max(0, ...state.units.map((unit) => {
    ensureUnitSessionPlan(unit);
    return unit.sessions.length;
  }));
}

function calculatedTeachingWeeks() {
  const sessionsPerWeek = Number($("#scheduleSessionsPerWeek")?.value) || 0;
  const totalSessions = totalTeachingSessions();
  return sessionsPerWeek > 0 ? Math.ceil(totalSessions / sessionsPerWeek) : 0;
}

function renderSessionScheduleSetup() {
  const totalSessions = totalTeachingSessions();
  const sessionsPerWeek = Number($("#scheduleSessionsPerWeek").value) || 0;
  const weeks = calculatedTeachingWeeks();
  $("#sessionWeekCalculation").innerHTML = sessionsPerWeek > 0
    ? `<span><strong>${totalSessions} session${totalSessions === 1 ? "" : "s"}</strong> ÷ ${sessionsPerWeek} per week = <strong>${weeks} teaching week${weeks === 1 ? "" : "s"}</strong>.</span>`
    : "Enter at least one session per week.";
}

function invalidateSessionSchedule() {
  state.sessionScheduleConfirmed = false;
  $$(".post-session-setup").forEach((section) => { section.hidden = true; });
  if ($("#sessionWeekCalculation")) renderSessionScheduleSetup();
}

$("#scheduleSessionsPerWeek").addEventListener("input", () => {
  invalidateSessionSchedule();
  renderAssessmentInformation();
});

function confirmDeliveryPattern() {
  const sessionsPerWeek = Number($("#scheduleSessionsPerWeek").value);
  const totalSessions = totalTeachingSessions();
  if (!Number.isInteger(sessionsPerWeek) || sessionsPerWeek < 1 || sessionsPerWeek > 10) {
    $("#sessionWeekCalculation").textContent = "Enter a whole number from 1 to 10.";
    return false;
  }
  if (!totalSessions) {
    $("#sessionWeekCalculation").textContent = "Add at least one teaching session in Step 2 first.";
    return false;
  }

  state.sessionsPerWeek = sessionsPerWeek;
  state.sessionScheduleConfirmed = true;
  state.units.forEach((unit) => {
    ensureUnitSessionPlan(unit);
    unit.course_duration = Math.ceil(unit.sessions.length / sessionsPerWeek);
    syncWeeklyTopicsFromSessions(unit);
  });
  syncCombinedUnitInformation();
  state.courseDuration = Math.ceil(totalSessions / sessionsPerWeek);
  state.items.forEach((item) => {
    const dueSession = Number(item.due_session) || 0;
    item.due_week = dueSession > 0 ? Math.ceil(dueSession / sessionsPerWeek) : 0;
  });
  if (state.unitInfo) state.unitInfo.course_duration = state.courseDuration;
  $("#courseDurationBadge").textContent = `${state.courseDuration}-week course (${totalSessions} sessions)`;
  renderSessionScheduleSetup();
  return true;
}

$("#generateFromOutlineButton").addEventListener("click", async () => {
  if (!confirmDeliveryPattern()) return;
  const button = $("#generateFromOutlineButton");
  button.disabled = true;
  button.querySelector("span").textContent = "Generating…";
  setStatus("Generating draft", "busy");
  showMessages("#outlineDraftMessageArea", []);
  try {
    const response = await fetch("/api/unit-draft", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        unit_info: state.unitInfo,
        units: state.units,
        sessions_per_week: state.sessionsPerWeek
      })
    });
    const data = await readApiResponse(response);
    if (!response.ok) throw new Error(data.error || "A draft could not be generated from the unit outline.");
    updateResults(data, false);
    showMessages("#outlineDraftMessageArea", [...(data.warnings || []), ...(data.errors || [])], "warning");
    setStatus("Outline draft created");
    $("#extracted-assessments").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    showMessages("#outlineDraftMessageArea", [error.message], "error");
    setStatus("Error", "error");
  } finally {
    button.disabled = false;
    button.querySelector("span").textContent = "Generate draft from unit outline";
  }
});

$("#printUnitButton").addEventListener("click", () => {
  document.body.classList.add("print-unit");
  window.print();
  document.body.classList.remove("print-unit");
});
$("#continueButton").addEventListener("click", () => {
  if (!confirmDeliveryPattern()) return;
  $("#assessment-upload").hidden = false;
  $("#assessment-upload").scrollIntoView({ behavior: "smooth", block: "start" });
});

function addAssessmentFiles(files) {
  const selectedFiles = [...files];
  const rejectedFiles = selectedFiles.filter((file) => !validDocument(file));
  const existingFiles = new Set(
    state.assessmentFiles.map((file) => `${file.name.toLowerCase()}:${file.size}:${file.lastModified}`)
  );
  const duplicateFiles = selectedFiles.filter((file) => (
    validDocument(file) && existingFiles.has(`${file.name.toLowerCase()}:${file.size}:${file.lastModified}`)
  ));
  const addedFiles = selectedFiles.filter((file) => {
    if (!validDocument(file)) return false;
    const key = `${file.name.toLowerCase()}:${file.size}:${file.lastModified}`;
    if (existingFiles.has(key)) return false;
    existingFiles.add(key);
    return true;
  });

  if (addedFiles.length) {
    state.assessmentFiles.push(...addedFiles);
  }
  $("#fileList").innerHTML = state.assessmentFiles.map((file) => `
    <div class="file-row"><span class="pdf-tag">${documentTag(file)}</span><strong>${escapeHtml(file.name)}</strong><span>${(file.size / 1024).toFixed(1)} KB</span></div>
  `).join("");
  $("#generateButton").disabled = state.assessmentFiles.length === 0;
  $("#uploadHint").textContent = state.assessmentFiles.length
    ? `${state.assessmentFiles.length} assessment brief${state.assessmentFiles.length === 1 ? "" : "s"} ready to process.`
    : "Upload at least one assessment brief to continue to Steps 5 and 6.";
  const messages = [];
  if (rejectedFiles.length) {
    messages.push(`Only PDF and DOCX files are accepted. Ignored: ${rejectedFiles.map((file) => file.name).join(", ")}`);
  }
  if (duplicateFiles.length) {
    messages.push(`Already added: ${duplicateFiles.map((file) => file.name).join(", ")}`);
  }
  showMessages("#messageArea", messages, rejectedFiles.length ? "error" : "warning");
}

setupDropZone($("#fileInput"), $("#dropZone"), addAssessmentFiles);
$("#addAssessmentFileButton").addEventListener("click", () => $("#fileInput").click());

extractionMethod.addEventListener("change", () => {
  const usesOllama = extractionMethod.value === "ollama";
  $("#ollamaSettings").hidden = !usesOllama;
  if (state.items.length) resetAssessmentWorkflow(false);
});

$("#checkOllamaButton").addEventListener("click", async () => {
  const status = $("#ollamaStatus");
  status.textContent = "Checking…";
  try {
    const response = await fetch(`/api/ollama/models?host=${encodeURIComponent($("#ollamaHost").value)}`);
    const data = await readApiResponse(response);
    if (!response.ok) throw new Error(data.error || "Ollama is unavailable.");
    status.textContent = data.models.length ? `Connected: ${data.models.join(", ")}` : "Connected, but no models are installed.";
  } catch (error) {
    status.textContent = error.message;
  }
});

$("#generateButton").addEventListener("click", async () => {
  if (!state.assessmentFiles.length || !state.unitInfo) return;
  const formData = new FormData();
  state.assessmentFiles.forEach((file) => formData.append("files", file));
  formData.append("extraction_method", extractionMethod.value);
  formData.append("ollama_host", $("#ollamaHost").value);
  formData.append("ollama_model", $("#ollamaModel").value);
  formData.append("sessions_per_week", String(state.sessionsPerWeek || 0));
  formData.append("unit_info", JSON.stringify(state.unitInfo));
  formData.append("units", JSON.stringify(state.units));
  const button = $("#generateButton");
  button.disabled = true;
  button.querySelector("span").textContent = "Extracting…";
  setStatus("Extracting assessments", "busy");
  showMessages("#messageArea", []);
  try {
    const response = await fetch("/api/generate", { method: "POST", body: formData });
    const data = await readApiResponse(response);
    if (!response.ok) throw new Error(data.error || "Assessment information could not be extracted.");
    updateResults(data, true);
    showMessages("#messageArea", [...(data.warnings || []), ...(data.errors || [])], "warning");
    setStatus("Draft created");
    $("#extracted-assessments").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    showMessages("#messageArea", [error.message], "error");
    setStatus("Error", "error");
  } finally {
    button.disabled = state.assessmentFiles.length === 0;
    button.querySelector("span").textContent = "Generate Steps 5 and 6";
  }
});

function updateResults(data, assessmentBriefsProcessed = state.assessmentBriefsProcessed) {
  state.assessmentBriefsProcessed = assessmentBriefsProcessed;
  state.items = data.items || [];
  normaliseAssessmentDueSessions();
  state.schedule = data.schedule || [];
  state.feedback = data.feedback || [];
  state.scaffolding = data.scaffolding || [];
  state.scaffoldingSource = data.scaffolding_source || "rule-based";
  state.scaffoldingModel = data.scaffolding_model || "";
  state.scaffoldingWarnings = data.scaffolding_warnings || [];
  state.courseDuration = data.course_duration || 12;
  const totalSessions = totalTeachingSessions();
  $("#courseDurationBadge").textContent = state.sessionScheduleConfirmed
    ? `${state.courseDuration}-week course (${totalSessions} sessions)`
    : `${state.courseDuration}-week course`;
  state.review = { reviewer: "", decision: "", comments: "" };
  state.published = false;
  markScheduleUnsaved();
  $("#extracted-assessments").hidden = false;
  $("#assessment-upload").hidden = false;
  $$(".post-session-setup").forEach((section) => {
    section.hidden = !state.sessionScheduleConfirmed || !state.assessmentBriefsProcessed;
  });
  $("#exportButton").disabled = false;
  $("#exportXmlButton").disabled = false;
  $("#clearButton").disabled = false;
  renderAllResults();
  renderSessionScheduleSetup();
}

function renderAllResults() {
  renderAssessmentSelector();
  renderMetrics();
  renderAssessmentTable();
  renderLearningSequence();
  renderSchedule();
  renderStep4DraftSchedule();
  renderFeedback();
  renderReview();
  renderPublish();
}

function assessmentSubjectKey(item) {
  return String(item.subject_code || "").trim().toUpperCase() || "__UNASSIGNED__";
}

function assessmentSubjectGroups() {
  const groups = new Map();
  state.items.forEach((item) => {
    const key = assessmentSubjectKey(item);
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        code: String(item.subject_code || "").trim() || "Unassigned",
        name: String(item.subject_name || "").trim()
      });
    }
  });
  return [...groups.values()];
}

function normaliseAssessmentDueSessions(items = state.items) {
  items.forEach((item) => {
    const dueWeek = Number(item.due_week) || 0;
    const dueSession = Number(item.due_session) || 0;
    if (dueSession > 0) {
      item.due_session = dueSession;
      if (state.sessionScheduleConfirmed && state.sessionsPerWeek > 0) {
        item.due_week = Math.ceil(dueSession / state.sessionsPerWeek);
      }
      return;
    }
    item.due_session = dueWeek > 0 && state.sessionScheduleConfirmed
      ? Math.min(dueWeek * state.sessionsPerWeek, sessionCountForAssessment(item))
      : dueWeek;
  });
}

function sessionCountForAssessment(item) {
  const key = assessmentSubjectKey(item);
  const unit = state.units.find(
    (candidate) => String(candidate.unit_code || "").trim().toUpperCase() === key
  );
  if (unit?.sessions?.length) return unit.sessions.length;
  if (state.units.length === 1 && state.units[0]?.sessions?.length) return state.units[0].sessions.length;
  return state.courseDuration;
}

function selectedAssessmentEntries() {
  return state.items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => assessmentSubjectKey(item) === state.activeAssessmentSubject);
}

function renderAssessmentSelector() {
  const groups = assessmentSubjectGroups();
  const panel = $("#assessmentSelectorPanel");
  const selector = $("#assessmentSelector");
  if (!groups.some((group) => group.key === state.activeAssessmentSubject)) {
    state.activeAssessmentSubject = groups[0]?.key || "";
  }
  panel.hidden = groups.length < 2;
  selector.innerHTML = groups.map((group) => {
    const name = group.name ? ` — ${group.name}` : "";
    return `<option value="${escapeHtml(group.key)}">${escapeHtml(group.code + name)}</option>`;
  }).join("");
  selector.value = state.activeAssessmentSubject;
}

$("#assessmentSelector").addEventListener("change", (event) => {
  state.activeAssessmentSubject = event.target.value;
  renderMetrics();
  renderAssessmentTable();
});

function renderMetrics() {
  const items = selectedAssessmentEntries().map(({ item }) => item);
  const total = items.reduce((sum, item) => sum + Number(item.weight || 0), 0);
  const outside = items.filter((item) => Number(item.due_session) > sessionCountForAssessment(item)).length;
  const metrics = [
    ["Components", items.length],
    ["Total weighting", `${total.toFixed(total % 1 ? 1 : 0)}%`],
    ["After final session", outside]
  ];
  $("#metricsGrid").innerHTML = metrics.map(([label, value]) => `<div class="metric-card"><span>${label}</span><strong>${value}</strong></div>`).join("");
}

function inputCell(item, index, field, type = "text", extra = "") {
  return `<input type="${type}" value="${escapeHtml(item[field])}" data-item-index="${index}" data-item-field="${field}" ${extra}>`;
}

function assessmentPartDetails(item, index) {
  const assessmentName = String(item.assessment_name || "Untitled assessment").trim();
  const matchingIndexes = state.items
    .map((candidate, candidateIndex) => ({ candidate, candidateIndex }))
    .filter(({ candidate }) => (
      assessmentSubjectKey(candidate) === assessmentSubjectKey(item)
      && String(candidate.assessment_name || "").trim().toLocaleLowerCase() === assessmentName.toLocaleLowerCase()
    ))
    .map(({ candidateIndex }) => candidateIndex);
  const component = String(item.component || "").trim();
  const explicitPart = component.match(/^part\s+([a-z0-9]+)/i);
  let partLabel = explicitPart ? `Part ${explicitPart[1].toUpperCase()}` : "";
  if (!partLabel && matchingIndexes.length > 1) {
    const position = matchingIndexes.indexOf(index);
    partLabel = position >= 0 && position < 26
      ? `Part ${String.fromCharCode(65 + position)}`
      : `Part ${position + 1}`;
  }
  const detail = component
    && !["whole assessment", "assessment"].includes(component.toLocaleLowerCase())
    && component.toLocaleLowerCase() !== partLabel.toLocaleLowerCase()
    ? component
    : "";
  return {
    assessmentName,
    partLabel,
    displayName: `${assessmentName}${partLabel ? ` ${partLabel}` : ""}`,
    detail
  };
}

function assessmentNameCell(item, index) {
  const part = assessmentPartDetails(item, index);
  return `<div class="assessment-name-editor">
    <input value="${escapeHtml(part.displayName)}" data-item-index="${index}" data-item-field="assessment_name" data-assessment-part="${escapeHtml(part.partLabel)}" aria-label="Assessment and part">
    ${part.detail ? `<small>${escapeHtml(part.detail)}</small>` : ""}
  </div>`;
}

function bindItemInputs(container = document) {
  $$('[data-item-index]').filter((input) => container === document || container.contains(input)).forEach((input) => {
    input.addEventListener("change", () => {
      const item = state.items[Number(input.dataset.itemIndex)];
      const field = input.dataset.itemField;
      if (input.dataset.list === "true") {
        item[field] = splitBulletLines(input.value);
        input.value = formatBulletList(item[field]);
      }
      else if (field === "assessment_name" && input.dataset.assessmentPart) {
        const suffix = ` ${input.dataset.assessmentPart}`;
        item[field] = input.value.toLocaleLowerCase().endsWith(suffix.toLocaleLowerCase())
          ? input.value.slice(0, -suffix.length).trim()
          : input.value;
      }
      else item[field] = input.type === "number" ? Number(input.value) : input.value;
      if (field === "due_session") {
        item.due_week = item.due_session > 0 && state.sessionScheduleConfirmed
          ? Math.ceil(item.due_session / state.sessionsPerWeek)
          : item.due_session;
      }
      refreshAnalysis();
    });
    if (input.tagName === "TEXTAREA" && input.dataset.list === "true") {
      input.addEventListener("keydown", (event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        const start = input.selectionStart;
        const end = input.selectionEnd;
        input.setRangeText("\n\u2022 ", start, end, "end");
      });
    }
  });
}

function renderAssessmentTable() {
  const entries = selectedAssessmentEntries();
  $("#assessmentTableBody").innerHTML = entries.length ? entries.map(({ item, index }) => `
    <tr>
      <td>${assessmentNameCell(item, index)}</td>
      <td>${inputCell(item, index, "assessment_type")}</td>
      <td>${inputCell(item, index, "weight", "number", 'min="0" max="100" step="0.5"')}</td>
      <td>${inputCell(item, index, "due_session", "number", `min="0" max="${sessionCountForAssessment(item)}" step="1"`)}</td>
      <td class="source-cell" title="${escapeHtml(item.source_file)}">${escapeHtml(item.source_file || "Manual")}</td>
      <td><button class="row-delete" data-item-delete="${index}" aria-label="Remove assessment component">×</button></td>
    </tr>`).join("") : '<tr><td class="empty-topics" colspan="6">No assessments were extracted for this subject.</td></tr>';
  bindItemInputs($("#assessmentTableBody"));
  $$('[data-item-delete]').forEach((button) => button.addEventListener("click", () => {
    state.items.splice(Number(button.dataset.itemDelete), 1);
    refreshAnalysis();
  }));
}

function renderStep4DraftSchedule() {
  $("#step4DraftScheduleHead").innerHTML = $("#scheduleMatrixHead").innerHTML;
  $("#step4DraftScheduleBody").innerHTML = $("#scheduleMatrixBody").innerHTML;
  $("#step4OutsideCourse").innerHTML = $("#outsideCourse").innerHTML;
  $("#step4DraftScheduleBody").querySelectorAll(".schedule-assessment").forEach((card) => {
    card.removeAttribute("tabindex");
    card.removeAttribute("aria-describedby");
    card.querySelector(".schedule-assessment-label")?.remove();
    card.querySelector(".schedule-coverage-tooltip")?.remove();
  });
}

function selectedSequenceEntries() {
  return state.items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => assessmentSubjectKey(item) === state.activeSequenceSubject);
}

function renderSequenceSelector() {
  const groups = assessmentSubjectGroups();
  const panel = $("#sequenceSelectorPanel");
  const selector = $("#sequenceSelector");
  if (!groups.some((group) => group.key === state.activeSequenceSubject)) {
    state.activeSequenceSubject = groups[0]?.key || "";
  }
  panel.hidden = groups.length < 2;
  selector.innerHTML = groups.map((group) => {
    const name = group.name ? ` — ${group.name}` : "";
    return `<option value="${escapeHtml(group.key)}">${escapeHtml(group.code + name)}</option>`;
  }).join("");
  selector.value = state.activeSequenceSubject;
}

$("#sequenceSelector").addEventListener("change", (event) => {
  state.activeSequenceSubject = event.target.value;
  renderLearningSequence();
});

function renderLearningSequence() {
  renderSequenceSelector();
  const entries = selectedSequenceEntries();
  const methodLabel = state.scaffoldingSource === "ollama"
    ? `Ollama + ${state.scaffoldingModel || "Gemma 4"}`
    : (state.scaffoldingSource === "rule-based-fallback" ? "Rule-based fallback" : "Rule-based evaluation");
  $("#scaffoldingMethodBadge").textContent = methodLabel;
  showMessages("#scaffoldingMessageArea", state.scaffoldingWarnings, "warning");
  const counts = entries.reduce((summary, { index }) => {
    const evaluation = state.scaffolding[index] || { status: "warning" };
    summary[evaluation.status] = (summary[evaluation.status] || 0) + 1;
    return summary;
  }, {});
  $("#scaffoldingSummary").innerHTML = `
    <div><span>Covered by due week</span><strong>${counts.success || 0}</strong></div>
    <div><span>Needs review</span><strong>${counts.warning || 0}</strong></div>
    <div><span>Not covered by due week</span><strong>${counts.error || 0}</strong></div>
  `;
  $("#sequenceTableBody").innerHTML = entries.length ? entries.map(({ item, index }) => {
    const evaluation = state.scaffolding[index] || {
      status: "warning",
      label: "Needs evaluation",
      topic_readiness: "Awaiting analysis",
      rationale: "Refresh the analysis to evaluate scaffolding.",
      requirement_coverage: []
    };
    const statusClass = ["success", "warning", "error"].includes(evaluation.status)
      ? evaluation.status
      : "warning";
    const coverageItems = evaluation.requirement_coverage || [];
    const coverageChecklist = coverageItems.length
      ? `<ul class="coverage-checklist">${coverageItems.map((coverage) => {
          const coverageStatus = ["covered", "after_due", "not_mapped", "due_week_required"].includes(coverage.status)
            ? coverage.status
            : "not_mapped";
          const icon = coverageStatus === "covered" ? "✓" : (coverageStatus === "after_due" ? "×" : "!");
          return `<li class="${coverageStatus}"><span class="coverage-check-icon" aria-hidden="true">${icon}</span><div><strong>${escapeHtml(coverage.requirement)}</strong><small>${escapeHtml(coverage.detail)}</small></div></li>`;
        }).join("")}</ul>`
      : `<p>${escapeHtml(evaluation.rationale)}</p>`;
    return `
    <tr><td><strong>${escapeHtml(item.assessment_name)}</strong><br><small>${escapeHtml(item.component)}</small></td>
    <td>After Session ${item.due_session || "?"}<br><small>Week ${item.due_week || "?"}</small></td>
    <td><textarea data-item-index="${index}" data-item-field="required_topics_skills" data-list="true">${escapeHtml(formatBulletList(item.required_topics_skills))}</textarea></td>
    <td><textarea data-item-index="${index}" data-item-field="learning_outcomes_assessed" data-list="true">${escapeHtml(formatBulletList(item.learning_outcomes_assessed))}</textarea></td>
    <td class="scaffolding-cell"><span class="scaffolding-status ${statusClass}">${escapeHtml(evaluation.label)}</span><strong>${escapeHtml(evaluation.topic_readiness)}</strong>${coverageChecklist}</td></tr>
  `;
  }).join("") : '<tr><td class="empty-topics" colspan="5">No assessments were extracted for this subject.</td></tr>';
  bindItemInputs($("#sequenceTableBody"));
}

async function refreshAnalysis() {
  setStatus("Updating", "busy");
  try {
    const response = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items: state.items,
        unit_info: state.unitInfo,
        extraction_method: extractionMethod.value,
        ollama_host: $("#ollamaHost").value,
        ollama_model: $("#ollamaModel").value
      })
    });
    const data = await readApiResponse(response);
    if (!response.ok) throw new Error(data.error || "Analysis failed.");
    state.items = data.items || state.items;
    normaliseAssessmentDueSessions();
    state.schedule = data.schedule;
    state.feedback = data.feedback;
    state.scaffolding = data.scaffolding || [];
    state.scaffoldingSource = data.scaffolding_source || "rule-based";
    state.scaffoldingModel = data.scaffolding_model || "";
    state.scaffoldingWarnings = data.scaffolding_warnings || [];
    state.review = { reviewer: "", decision: "", comments: "" };
    state.published = false;
    markScheduleUnsaved();
    renderAllResults();
    setStatus("Draft updated");
  } catch (error) {
    showMessages("#messageArea", [error.message], "error");
    setStatus("Error", "error");
  }
}

$("#refreshButton").addEventListener("click", refreshAnalysis);
$("#validateButton").addEventListener("click", refreshAnalysis);
$("#addRowButton").addEventListener("click", () => {
  const template = selectedAssessmentEntries()[0]?.item || {};
  const selectedUnit = state.units.find(
    (unit) => String(unit.unit_code || "").trim().toUpperCase() === state.activeAssessmentSubject
  ) || {};
  state.items.push({
    subject_code: template.subject_code || selectedUnit.unit_code || "",
    subject_name: template.subject_name || selectedUnit.unit_name || "",
    assessment_name: "New assessment",
    component: "Whole assessment",
    assessment_type: "Individual",
    weight: 0,
    due_session: 0,
    due_week: 0,
    source_file: "",
    raw_due_text: "",
    learning_outcomes_assessed: [],
    required_topics_skills: [],
    estimated_workload_hours: 0,
    preparation_weeks: 0,
    dependencies: [],
    feedback_requirements: []
  });
  refreshAnalysis();
});

function bindScheduleCoverageTooltips() {
  const cards = $$(".schedule-assessment");
  const hideAll = () => cards.forEach((card) => {
    card.querySelector(".schedule-coverage-tooltip")?.classList.remove("is-visible");
  });
  cards.forEach((card) => {
    const tooltip = card.querySelector(".schedule-coverage-tooltip");
    if (!tooltip) return;
    const show = () => {
      hideAll();
      const cardRect = card.getBoundingClientRect();
      tooltip.classList.add("is-visible");
      const tooltipRect = tooltip.getBoundingClientRect();
      const left = Math.min(
        Math.max(8, cardRect.left + (cardRect.width / 2) - (tooltipRect.width / 2)),
        window.innerWidth - tooltipRect.width - 8
      );
      const above = cardRect.top - tooltipRect.height - 8;
      const top = above >= 8
        ? above
        : Math.min(cardRect.bottom + 8, window.innerHeight - tooltipRect.height - 8);
      tooltip.style.left = `${left}px`;
      tooltip.style.top = `${Math.max(8, top)}px`;
    };
    const hide = () => {
      window.setTimeout(() => {
        if (!card.matches(":hover") && !card.matches(":focus")) {
          tooltip.classList.remove("is-visible");
        }
      }, 0);
    };
    card.addEventListener("mouseenter", show);
    card.addEventListener("mouseleave", hide);
    card.addEventListener("focus", show);
    card.addEventListener("blur", hide);
  });
  const matrixWrap = $("#weekly-schedule .schedule-matrix-wrap");
  if (matrixWrap) matrixWrap.onscroll = hideAll;
}

function setScheduleFullscreen(enabled) {
  const section = $("#weekly-schedule");
  const button = $("#scheduleFullscreenButton");
  if (!section || !button) return;
  if (enabled) setSectionCollapsed(section, false);
  section.classList.toggle("schedule-fullscreen", enabled);
  document.body.classList.toggle("schedule-fullscreen-open", enabled);
  button.textContent = enabled ? "Exit full screen" : "Full screen";
  button.setAttribute("aria-pressed", String(enabled));
  button.setAttribute("aria-label", enabled ? "Exit full-screen schedule view" : "Open schedule in full-screen view");
}

function setStep4ScheduleFullscreen(enabled) {
  const panel = $("#step4DraftPanel");
  const button = $("#step4ScheduleFullscreenButton");
  if (!panel || !button) return;
  if (enabled) setScheduleFullscreen(false);
  panel.classList.toggle("schedule-fullscreen", enabled);
  document.body.classList.toggle("schedule-fullscreen-open", enabled);
  button.textContent = enabled ? "Exit full screen" : "Full screen";
  button.setAttribute("aria-pressed", String(enabled));
  button.setAttribute("aria-label", enabled ? "Exit full-screen outline draft" : "Open outline draft in full-screen view");
}

$("#scheduleFullscreenButton").addEventListener("click", () => {
  const section = $("#weekly-schedule");
  setStep4ScheduleFullscreen(false);
  setScheduleFullscreen(!section.classList.contains("schedule-fullscreen"));
});

$("#step4ScheduleFullscreenButton").addEventListener("click", () => {
  const panel = $("#step4DraftPanel");
  setStep4ScheduleFullscreen(!panel.classList.contains("schedule-fullscreen"));
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if ($("#weekly-schedule").classList.contains("schedule-fullscreen")) {
      setScheduleFullscreen(false);
      $("#scheduleFullscreenButton").focus();
  } else if ($("#step4DraftPanel").classList.contains("schedule-fullscreen")) {
      setStep4ScheduleFullscreen(false);
      $("#step4ScheduleFullscreenButton").focus();
    }
});

function renderScheduleSaveState() {
  const button = $("#saveScheduleButton");
  const status = $("#scheduleSaveStatus");
  button.disabled = !state.items.length || state.scheduleSavePending || Boolean(state.savedScheduleId);
  button.textContent = state.scheduleSavePending
    ? "Saving..."
    : (state.savedScheduleId ? "Schedule saved" : "Save schedule");
  status.classList.toggle(
    "error",
    Boolean(state.scheduleSaveMessage) && !state.scheduleSavePending && !state.savedScheduleId
  );
  status.textContent = state.scheduleSaveMessage;
}

$("#saveScheduleButton").addEventListener("click", async () => {
  if (state.scheduleSavePending || state.savedScheduleId || !state.items.length) return;
  const revision = state.scheduleRevision;
  const unitCodes = state.units
    .map((unit) => String(unit.unit_code || "").trim())
    .filter(Boolean);
  state.scheduleSavePending = true;
  state.scheduleSaveMessage = "Saving to PostgreSQL...";
  renderScheduleSaveState();
  try {
    const response = await fetch("/api/schedules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: `${unitCodes.join(" / ") || "Assessment"} schedule`,
        course_duration: state.courseDuration,
        unit_info: state.unitInfo || {},
        units: state.units,
        items: state.items,
        schedule: state.schedule
      })
    });
    const data = await readApiResponse(response);
    if (!response.ok) throw new Error(data.error || "The schedule could not be saved.");
    if (revision === state.scheduleRevision) {
      state.savedScheduleId = data.id;
      state.scheduleSavedAt = data.created_at;
      state.scheduleSaveMessage = "Saved to PostgreSQL.";
    } else {
      state.scheduleSaveMessage = "An earlier version was saved; save the current draft again.";
    }
  } catch (error) {
    state.scheduleSaveMessage = error.message;
  } finally {
    state.scheduleSavePending = false;
    renderScheduleSaveState();
  }
});

function scheduleRowSummary(items) {
  const methods = new Set();
  let individualWeight = 0;
  let groupWeight = 0;

  items.forEach(({ item }) => {
    const type = String(item.assessment_type || "").trim();
    const assessmentName = String(item.assessment_name || "").trim().toLocaleLowerCase();
    if (assessmentName) methods.add(assessmentName);

    const parsedWeight = Number(item.weight || 0);
    const weight = Number.isFinite(parsedWeight) ? parsedWeight : 0;
    if (/\bgroup\b/i.test(type)) groupWeight += weight;
    else individualWeight += weight;
  });

  return {
    methodCount: methods.size,
    individualWeight,
    groupWeight
  };
}

function formatPercentage(value) {
  const number = Number(value || 0);
  return `${number.toFixed(number % 1 ? 1 : 0)}%`;
}

function renderSchedule() {
  $("#draftScheduleTitle").textContent = `Draft ${state.courseDuration}-week schedule`;
  $("#publishScheduleTitle").textContent = `Publish final ${state.courseDuration}-week schedule`;

  const subjectRows = new Map();
  state.units.forEach((unit, index) => {
    const code = String(unit.unit_code || "").trim();
    const key = code.toUpperCase() || `__UNIT_${index}`;
    subjectRows.set(key, {
      key,
      code: code || `Unit ${index + 1}`,
      name: String(unit.unit_name || "").trim(),
      items: []
    });
  });
  state.items.forEach((item, index) => {
    const code = String(item.subject_code || "").trim();
    const key = code.toUpperCase() || "__UNASSIGNED__";
    if (!subjectRows.has(key)) {
      subjectRows.set(key, {
        key,
        code: code || "Unassigned",
        name: String(item.subject_name || "").trim(),
        items: []
      });
    }
    const row = subjectRows.get(key);
    if (!row.name && item.subject_name) row.name = item.subject_name;
    row.items.push({ item, index });
  });

  const weeks = Array.from({ length: state.courseDuration }, (_, index) => index + 1);
  $("#scheduleMatrixHead").innerHTML = `<tr>
    <th scope="col">Unit code</th>
    <th scope="col">Subject</th>
    ${weeks.map((week) => `<th scope="col">Week ${week}</th>`).join("")}
    <th scope="col" class="schedule-summary-heading">Number of Methods</th>
    <th scope="col" class="schedule-summary-heading" title="Total weighting not marked Group; assessments default to Individual">Individual assessments %</th>
    <th scope="col" class="schedule-summary-heading" title="Total weighting marked Group or Group/Individual">Group assessments %</th>
  </tr>`;
  $("#scheduleMatrixBody").innerHTML = subjectRows.size
    ? [...subjectRows.values()].map((row) => {
      const summary = scheduleRowSummary(row.items);
      return `<tr>
      <th scope="row">${escapeHtml(row.code)}</th>
      <td class="schedule-subject-name">${escapeHtml(row.name || "Subject name unavailable")}</td>
      ${weeks.map((week) => {
        const dueItems = row.items.filter(({ item }) => Number(item.due_week) === week);
        if (!dueItems.length) return '<td class="schedule-empty"><span>—</span></td>';
        return `<td class="schedule-has-items"><div class="schedule-cell-items">${dueItems.map(({ item, index }) => {
          const part = assessmentPartDetails(item, index);
          const component = part.detail ? `<small>${escapeHtml(part.detail)}</small>` : "";
          const dueSession = Number(item.due_session) || 0;
          const dueSessionLabel = dueSession
            ? `<span class="schedule-session">Due after Session ${dueSession}</span>`
            : "";
          const weight = Number(item.weight || 0);
          const weightLabel = weight.toFixed(weight % 1 ? 1 : 0);
          const evaluation = state.scaffolding[index] || {
            status: "warning",
            label: "Needs evaluation",
            topic_readiness: "Awaiting topic coverage analysis",
            rationale: "Refresh the analysis to evaluate topic coverage.",
            requirement_coverage: []
          };
          const statusClass = ["success", "warning", "error"].includes(evaluation.status)
            ? evaluation.status
            : "warning";
          const coverageItems = evaluation.requirement_coverage || [];
          const coverageDetail = coverageItems.length
            ? `<ul>${coverageItems.map((coverage) => `<li><strong>${escapeHtml(coverage.requirement)}</strong><span>${escapeHtml(coverage.detail)}</span></li>`).join("")}</ul>`
            : `<p>${escapeHtml(evaluation.rationale || "No topic coverage detail is available.")}</p>`;
          const tooltipId = `schedule-coverage-${index}`;
          return `<article class="schedule-assessment coverage-${statusClass}" tabindex="0" aria-describedby="${tooltipId}">
            <span class="schedule-assessment-label">${escapeHtml(evaluation.label || "Needs evaluation")}</span>
            <strong class="schedule-assessment-title">${escapeHtml(part.displayName)}</strong>
            ${component}${dueSessionLabel}<span class="schedule-weight">${weightLabel}%</span>
            <div class="schedule-coverage-tooltip" id="${tooltipId}" role="tooltip">
              <div class="schedule-tooltip-heading"><strong>Topic coverage evaluation</strong><span class="scaffolding-status ${statusClass}">${escapeHtml(evaluation.label)}</span></div>
              <b>${escapeHtml(evaluation.topic_readiness || "Readiness unavailable")}</b>
              ${coverageDetail}
            </div>
          </article>`;
        }).join("")}</div></td>`;
      }).join("")}
      <td class="schedule-summary-value"><strong>${summary.methodCount}</strong></td>
      <td class="schedule-summary-value"><strong>${formatPercentage(summary.individualWeight)}</strong></td>
      <td class="schedule-summary-value"><strong>${formatPercentage(summary.groupWeight)}</strong></td>
    </tr>`;
    }).join("")
    : `<tr><td class="schedule-no-data" colspan="${weeks.length + 5}">No units or assessments are available.</td></tr>`;
  bindScheduleCoverageTooltips();

  const outside = state.items.filter((item) => Number(item.due_week) > state.courseDuration);
  $("#outsideCourse").innerHTML = outside.length
    ? `<div class="outside-panel"><strong>Outside the ${state.courseDuration}-week course</strong><ul>${outside.map((item) => `<li>${escapeHtml(item.assessment_name)} — ${escapeHtml(item.component)}, Week ${item.due_week}</li>`).join("")}</ul></div>`
    : "";
  renderScheduleSaveState();
}

function renderValidationSelector() {
  const groups = assessmentSubjectGroups();
  const panel = $("#validationSelectorPanel");
  const selector = $("#validationSelector");
  if (!groups.some((group) => group.key === state.activeValidationSubject)) {
    state.activeValidationSubject = groups[0]?.key || "";
  }
  panel.hidden = groups.length < 2;
  selector.innerHTML = groups.map((group) => {
    const name = group.name ? ` — ${group.name}` : "";
    return `<option value="${escapeHtml(group.key)}">${escapeHtml(group.code + name)}</option>`;
  }).join("");
  selector.value = state.activeValidationSubject;
}

function selectedValidationFeedback() {
  return state.feedback.filter((item) => {
    if (!Object.prototype.hasOwnProperty.call(item, "subject_code")) return true;
    const key = String(item.subject_code || "").trim().toUpperCase() || "__UNASSIGNED__";
    return key === state.activeValidationSubject;
  });
}

$("#validationSelector").addEventListener("change", (event) => {
  state.activeValidationSubject = event.target.value;
  renderFeedback();
});

function renderFeedback() {
  renderValidationSelector();
  const feedback = selectedValidationFeedback();
  $("#feedbackList").innerHTML = feedback.length
    ? feedback.map((item) => `<article class="feedback-card ${escapeHtml(item.severity)}"><strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.message)}</p></article>`).join("")
    : '<article class="feedback-card success"><strong>No validation issues</strong><p>No configured scheduling risks were found for this subject.</p></article>';
  const errors = feedback.filter((item) => item.severity === "error").length;
  $("#validationDecision").className = `decision-banner ${errors ? "invalid" : "valid"}`;
  $("#validationDecision").innerHTML = errors
    ? `<strong>Subject schedule requires optimisation</strong><span>${errors} blocking validation issue${errors === 1 ? "" : "s"} found.</span>`
    : "<strong>Subject schedule valid</strong><span>No blocking validation issues were found for this subject.</span>";
}

$("#optimizeButton").addEventListener("click", async () => {
  setStatus("Optimising", "busy");
  try {
    const response = await fetch("/api/optimize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items: state.items,
        unit_info: state.unitInfo,
        extraction_method: extractionMethod.value,
        ollama_host: $("#ollamaHost").value,
        ollama_model: $("#ollamaModel").value
      })
    });
    const data = await readApiResponse(response);
    if (!response.ok) throw new Error(data.error || "Optimisation failed.");
    state.items = data.items;
    if (state.sessionScheduleConfirmed && state.sessionsPerWeek > 0) {
      state.items.forEach((item) => {
        item.due_session = Number(item.due_week) > 0
          ? Number(item.due_week) * state.sessionsPerWeek
          : 0;
      });
    } else {
      normaliseAssessmentDueSessions();
    }
    state.schedule = data.schedule;
    state.feedback = data.feedback;
    state.scaffolding = data.scaffolding || [];
    state.scaffoldingSource = data.scaffolding_source || "rule-based";
    state.scaffoldingModel = data.scaffolding_model || "";
    state.scaffoldingWarnings = data.scaffolding_warnings || [];
    state.review = { reviewer: "", decision: "", comments: "" };
    state.published = false;
    markScheduleUnsaved();
    $("#optimizationChanges").innerHTML = `<ul>${(data.changes || []).map((change) => `<li>${escapeHtml(change)}</li>`).join("")}</ul>`;
    renderAllResults();
    setStatus("Optimised");
  } catch (error) {
    $("#optimizationChanges").innerHTML = `<div class="notice error">${escapeHtml(error.message)}</div>`;
    setStatus("Error", "error");
  }
});

function renderReview() {
  const scheduleValid = !state.feedback.some((item) => item.severity === "error");
  $("#reviewerName").value = state.review.reviewer;
  $("#reviewDecision").value = state.review.decision;
  $("#reviewComments").value = state.review.comments;
  ["#reviewerName", "#reviewDecision", "#reviewComments", "#saveReviewButton"].forEach((selector) => {
    $(selector).disabled = !scheduleValid;
  });
  $("#reviewStatus").textContent = !scheduleValid
    ? "Resolve blocking validation issues before academic review."
    : state.review.decision === "approved"
    ? `Approved by ${state.review.reviewer || "academic reviewer"}.`
    : state.review.decision === "changes" ? "Changes required — return to optimisation." : "Awaiting academic decision.";
}

$("#saveReviewButton").addEventListener("click", () => {
  if (state.feedback.some((item) => item.severity === "error")) {
    $("#reviewStatus").textContent = "Resolve blocking validation issues before academic review.";
    return;
  }
  state.review = {
    reviewer: $("#reviewerName").value.trim(),
    decision: $("#reviewDecision").value,
    comments: $("#reviewComments").value.trim()
  };
  if (!state.review.decision) {
    $("#reviewStatus").textContent = "Select an approval decision first.";
    return;
  }
  state.published = false;
  renderReview();
  renderPublish();
  if (state.review.decision === "changes") $("#optimization").scrollIntoView({ behavior: "smooth", block: "start" });
  else $("#publish").scrollIntoView({ behavior: "smooth", block: "start" });
});

function finalScheduleTable() {
  const active = state.schedule.filter((week) => week["Assessments due"] !== "-");
  return `<div class="table-wrap"><table class="data-table final-table"><thead><tr><th>Week</th><th>Assessments due</th><th>Weight</th></tr></thead><tbody>${active.map((week) => `<tr><td>Week ${week.Week}</td><td>${escapeHtml(week["Assessments due"])}</td><td>${week["Weight due"]}%</td></tr>`).join("")}</tbody></table></div>`;
}

function renderPublish() {
  const scheduleValid = !state.feedback.some((item) => item.severity === "error");
  const approved = state.review.decision === "approved" && scheduleValid;
  $("#publishButton").disabled = !approved || state.published;
  $("#printScheduleButton").disabled = !approved;
  $("#publishBadge").className = `publish-badge ${state.published ? "published" : approved ? "approved" : ""}`;
  $("#publishBadge").textContent = state.published ? "Published" : approved ? "Approved" : "Awaiting approval";
  $("#publishSummary").innerHTML = approved
    ? `<p><strong>${escapeHtml(state.unitInfo?.unit_code || "Unit")} ${escapeHtml(state.unitInfo?.unit_name || "")}</strong> · Reviewed by ${escapeHtml(state.review.reviewer || "academic reviewer")}</p>${finalScheduleTable()}`
    : "<p>Academic approval is required before publication.</p>";
}

$("#publishButton").addEventListener("click", () => {
  if (state.review.decision !== "approved") return;
  state.published = true;
  renderPublish();
  setStatus("Published");
});
$("#printScheduleButton").addEventListener("click", () => {
  document.body.classList.add("print-schedule");
  window.print();
  document.body.classList.remove("print-schedule");
});

$("#clearButton").addEventListener("click", () => resetAssessmentWorkflow(true));
$("#exportButton").addEventListener("click", () => {
  const payload = JSON.stringify({ unit: state.unitInfo, units: state.units, items: state.items, schedule: state.schedule, feedback: state.feedback, scaffolding: state.scaffolding, scaffolding_source: state.scaffoldingSource, scaffolding_model: state.scaffoldingModel, review: state.review, published: state.published }, null, 2);
  const blob = new Blob([payload], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "assessment-scheduling-workflow.json";
  link.click();
  URL.revokeObjectURL(link.href);
});

$("#exportXmlButton").addEventListener("click", async () => {
  const payload = {
    name: `${state.unitInfo?.unit_code || "Assessment"} schedule`,
    course_duration: state.courseDuration,
    unit_info: state.unitInfo,
    units: state.units,
    items: state.items,
    schedule: state.schedule,
  };
  try {
    const response = await fetch("/api/schedules/export.xml", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || `Request failed (${response.status}).`);
    }
    const disposition = response.headers.get("Content-Disposition") || "";
    const filename = disposition.match(/filename="?([^";]+)"?/i)?.[1] || "assessment-weekly-schedule.xml";
    const blob = await response.blob();
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    link.click();
    URL.revokeObjectURL(link.href);
  } catch (error) {
    showMessages("#messageArea", [error.message], "error");
  }
});

$("#sectionFilter").addEventListener("input", (event) => {
  const query = event.target.value.toLowerCase();
  $$("#sectionLinks a").forEach((link) => { link.hidden = !link.textContent.toLowerCase().includes(query); });
});
$("#sectionLinks").addEventListener("click", (event) => {
  const link = event.target.closest("a");
  if (!link) return;
  $$("#sectionLinks a").forEach((item) => item.classList.toggle("active", item === link));
  setSectionCollapsed($(link.getAttribute("href")), false);
});
$("#menuButton").addEventListener("click", () => $("#primaryNav").classList.toggle("open"));

setupCollapsibleSections();
