# Assessment Scheduler

A local web application for extracting unit and assessment information, designing a course-length assessment schedule, validating it, and recording academic approval.

The interface uses React, TypeScript, Vite, Tailwind CSS, and shadcn/ui. A Python/Flask API handles PDF and DOCX parsing, optional Ollama/Gemma 4 extraction, deterministic scheduling logic, and PostgreSQL schedule snapshots. The previous plain HTML interface remains in `static/` as a fallback.

## Workflow

1. Upload one or more unit outline PDF or DOCX files.
2. Extract each subject by unit code, review assessment information already present in the outline, and refine its ordered session-and-topic teaching plan.
3. Enter the sessions delivered per week, then either generate a draft from the outline or continue with additional assessment briefs.
4. Review assessments grouped by unit / subject code, including Part A/B labels, set each deadline as **Due after session**, and review the outline-only weekly draft.
5. Upload and process any additional assessment briefs, then review topic and skill coverage for each unit / subject code.
6. Review the updated weekly draft matrix; due weeks are calculated from the selected session deadlines.
7. Validate workload balance, timing, and progression separately for each unit / subject code.
8. Optimise invalid or overloaded weeks while showing every proposed move.
9. Record the human/academic review decision and comments.
10. Publish and print the approved final schedule.

Rule-based extraction is available without an LLM. A local Ollama Gemma 4 model can optionally be selected, with automatic fallback to deterministic extraction if Ollama is unavailable. The complete workflow can also be exported as JSON.

## Run with uv

Install `uv`, then run:

```powershell
uv sync
uv run python app.py
```

Open `http://localhost:8501`.

`uv sync` creates or updates `.venv` from `pyproject.toml` and `uv.lock`. Activating the environment is not required when using `uv run`.

The committed production frontend is served automatically by Flask, so Node.js is not required just to run the application.

## Frontend development with shadcn/ui

Install Node.js 24 LTS or newer, then use two terminals:

```powershell
# Terminal 1 - Flask API
uv run python app.py

# Terminal 2 - Vite frontend with hot reload
cd frontend
npm install
npm run dev
```

Open `http://localhost:5173` while developing. Vite proxies `/api` requests to Flask on port 8501.

After a frontend change, create the production build that Flask serves:

```powershell
cd frontend
npm run build
```

shadcn configuration lives in `frontend/components.json`, and installed components live in `frontend/src/components/ui`.

## Save Step 6 schedules to PostgreSQL

Create an empty PostgreSQL database and a user that can create tables in it. In the PowerShell session used to run the application, configure the connection and initialise the schedule table:

```powershell
$env:DATABASE_URL = "postgresql://scheduler:your-password@localhost:5432/assessment_scheduler"
uv sync
uv run flask --app app init-db
uv run python app.py
```

After generating Step 6, select **Save schedule**. Each click stores an immutable JSONB snapshot in the `saved_schedules` table. The snapshot includes the units, assessment items, course duration, and generated weekly schedule. Editing or optimising the draft enables the button again so the new version can be saved separately.

The rest of the application works without PostgreSQL. If `DATABASE_URL` is not configured, only the Step 6 save action is unavailable.

## Tests

```powershell
uv run python -m unittest discover -s tests -v
```

## Optional Ollama and Gemma 4

Install Ollama, then download the model:

```powershell
ollama pull gemma4
```

Start the application, select **Ollama + Gemma 4** from the top bar, and check the connection. Assessment text is sent only to the local Ollama API at `http://localhost:11434`. If Ollama is unavailable, the application warns the user and falls back to rule-based extraction.
