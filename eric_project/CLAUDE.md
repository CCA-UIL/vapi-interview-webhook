# CLAUDE.md — Imani Voicebot Project

This document is the handoff context for an AI ethnographic interviewer project. It contains everything Claude Code needs to continue the work without re-litigating previous decisions.

## Project Overview

**Goal:** Build "Imani," a Vapi-based outbound voice AI that conducts ethnographic interviews with Nairobi residents who own Electric Pressure Cookers (EPCs). The research explores cultural, emotional, social, and economic dimensions of EPC adoption.

**Current state (2026-05-21):** Two distinct voice flows are deployed and being iterated:
- **Imani interview bot** — three ~45-minute sessions (Phases 1-14) with session-appropriate opening flows, identity check (Session 1, when name provided), formal consent statement (toggleable via env var), end-of-session scheduling for the next session, and a final farewell with auto-hang-up at the end of Session 3. Eligibility screening has been **removed** from the main interview — it now happens via a separate screening bot before Session 1 is even scheduled. Callback scheduling works for both short (QStash) and long (Vapi schedulePlan) delays. Country localization adapts vocabulary/idiom/register to the participant's country (inferred from phone via `libphonenumber-js`).
- **Imani screening bot** — short call (typically 2–3 min) using a separate `prescreening_prompt.xml` on the same Vapi assistant. Bot asks 12 questions; Vapi's `analysisPlan.structuredDataPlan` extracts answers at end-of-call into a typed schema; the result lands in the `prescreening_responses` table for analyst review. Bot also answers participant FAQ questions inline and flags unanswered ones for human follow-up.

A table-based operator dashboard at `/` drives both flows (Interview operator tab + Screening tab), with multi-select bulk delete on the interview side and a sortable/Excel-downloadable response table on the screening side.

Real-participant pilot with full 45-min interview calls is the next milestone for the interview bot.

**The user's preferences (apply throughout):**
- Direct, ruthlessly honest, no pleasantries
- Skip "I understand" / "That's interesting" / cushioning
- Challenge wrong assumptions immediately
- If unsure, say so. If you don't know, say "I don't know"
- Note explicit hypotheses at the end of substantive responses
- For graphics: only visualise data the user explicitly provides

## Architecture (As Built)

The interview is structured as three separate ~45-minute calls, scheduled days or weeks apart:

- **Session 1 — Life and Cooking Context** (Phases 1-4): household, kitchen, cooking rhythm, cooking identity, gender roles
- **Session 2 — Cooking Technology and Meaning** (Phases 5-9): fuel/appliance history, EPC acquisition, EPC integration, community meaning, design feedback
- **Session 3 — Daily Life, Economics, Full Picture** (Phases 10-14): economics, daily rhythm, mealtime/hospitality, health/transmission, post-meal/close

Each session has phases. Each phase has milestones. Each milestone has an opening probe, optional follow-up probes, and an exit condition. Sessions 2 and 3 prompt blocks are present and the server can dial each session distinctly; full real-participant Session 2/3 testing is still pending.

### Session Detection (Server-Driven, Not Inferred)

The system prompt contains:
- `<active_session>{{ACTIVE_SESSION}}</active_session>` at the top — value is "1", "2", or "3", set by the server at call start
- `<is_callback>{{IS_CALLBACK}}</is_callback>` directly below — "true" or "false", set by the server
- `<prior_sessions_context>{{PRIOR_SESSIONS_CONTEXT}}</prior_sessions_context>` — populated by the server with summary content from previous sessions (empty for Session 1)

Imani reads `<active_session>` and `<is_callback>` to pick her opening flow from a routing table in `<opening_flow_decision>` near the top of the prompt.

### Server-Side Prompt Assembly (Critical)

**The model proved unreliable at conditional routing between opening flow blocks.** When both `<session_1_initial_call_flow>` and `<session_1_callback_flow>` were present, even with `{{IS_CALLBACK}}` correctly substituted and an explicit routing table at the top, the model defaulted to whichever flow was more prescriptive (the initial flow) regardless of `IS_CALLBACK`.

**Solution:** server reads the prompt template from disk, strips the inappropriate opening flow block based on IS_CALLBACK, and sends the assembled prompt via `assistantOverrides.model.messages` on every call. The model only ever sees one opening flow.

Implications:
- The prompt template at `eric_project/prompts/Imani_system_prompt_phase1.xml` is the source of truth
- The Vapi-stored prompt on the assistant is a fallback only — never used in practice
- Prompt edits no longer require `update-assistant.ps1` — just commit + push triggers Render redeploy
- The strip regex is line-anchored (`^<tag>...^</tag>$` with `m` flag) because both flow blocks contain inline prose mentions of each other's tag names

### The Strengthening Pattern (Probe Quality)

Several milestones have been "strengthened" with extra structure:

1. **Opening probe** (basic open question)
2. **Anti-deflection rule** with named common deflection phrases that should trigger re-probe
3. **`do_not_settle_for`** explicit list of survey-level answer patterns
4. **`missing_piece_check`** — names the specific data pieces required, gives 1-3 probe options for each missing piece, caps at ONE missing-piece probe per call
5. **Tightened exit condition** that references the missing_piece_check
6. **Increased fallback budget** (4-5 turns instead of 3)

Strengthened milestones: 1.3, 1.4, 4.1, 4.2, 5.3, 6.2, 6.3, 7.1, 7.3, 8.1, 9.1, 11.2, 12.1, 12.3, 13.2, 13.3, 14.3.
Unstrengthened: 1.1, 1.2, 2.1-2.4, 3.1-3.3, 4.3, 5.1-5.2, 6.1, 7.2, 8.2, 9.2-9.3, 10.1-10.3, 13.1, 14.1-14.2.

**Real-participant probing depth is still being validated.** In short test calls (3-min), Imani was observed to be less probing than in sim. May be artifact of the test cap; full 45-min test pending.

### Other Key Prompt Blocks

- `<continuity_check>` — handles participants who reject prior conversation history
- `<post_close_behaviour>` — hard rule that after the closing line, Imani only outputs minimal acknowledgments
- `<placeholder_handling>` — never read bracketed template placeholders aloud
- `<voice_and_manner>` — TTS-aware rules: no emojis, no markdown, no narration of internal reasoning
- `<appliance_disambiguation_principle>` — for every cooking appliance the participant names, resolve both technology and fuel/power source
- `<pre_probe_checklist>` — five checks Imani runs before every probe (Redundancy, Attribution, Category-listing, Deflection, Ambiguity)
- `<step_0_identity_check>` (Session 1 only, stripped when no name provided) — name verification before the introduction; routes to `report_wrong_number` or `schedule_first_attempt` when the participant isn't on the line.
- `<consent_branch_enabled>` / `<consent_branch_disabled>` — paired blocks at every consent injection point. Server strips the inactive one based on the `CONSENT_STATEMENT_ENABLED` env var. Active branch reads a formal multi-paragraph consent statement and waits for explicit yes/no.
- `<vague_time_handling>` — vague-phrase→concrete-time mapping (e.g., "tomorrow" → "tomorrow at this same time"). Applies before any scheduling tool invocation.
- `<next_session_scheduling>` — governs the read-back-and-confirm pattern at end-of-Sessions-1/2 before `schedule_next_session` fires.
- `<session_2_3_availability_branch>` — shared "is now still a good time?" handling for Sessions 2 and 3 openings; routes to `schedule_callback` on reschedule.
- `<screening_logic>` — **emptied placeholder.** Eligibility screening moved to the dedicated screening bot. Kept the tag as a no-op so existing strip-block calls don't error.

## Repository Layout

```
vapi-interview-webhook/
├── server.js                         # Production server, deployed to Render. Express + Supabase + QStash.
├── package.json, package-lock.json
├── render.yaml                       # Render service config
├── public/
│   └── index.html                    # Operator dashboard (two tabs: Interview operator + Screening). Vanilla HTML/JS, no build step. SheetJS lazy-loaded from CDN for Excel export.
├── ARCHITECTURE.md                   # Mermaid component + sequence diagrams
├── DEPLOYMENT.md                     # Render env vars, Vapi config, test plan, curl examples
├── .env / .env.example               # Local-runtime env, mirrors Render env
├── scripts/
│   ├── start-call.ps1 / .sh          # Trigger an interview call from CLI (mostly superseded by the operator UI)
│   ├── inspect-db.ps1 / .sh          # Read Supabase tables
│   └── update-assistant.ps1          # Push a local prompt file to the Vapi assistant (rarely needed —
│                                     # server reads prompts per-call from disk)
└── eric_project/
    ├── CLAUDE.md                     # This file
    ├── README.md
    ├── prompts/
    │   ├── Imani_system_prompt_phase1.xml         # INTERVIEW PROMPT (source of truth for sessions 1/2/3)
    │   ├── prescreening_prompt.xml                # SCREENING PROMPT (12-question bot)
    │   ├── Eric_Interview_Orchestrator_28Apr26.xml  # Legacy orchestrator, reference only
    │   ├── Vapi_system_prompt_milestone.txt      # Original milestone prompt, reference only
    │   ├── session_1_and_2_summaries_reference.txt  # Reference summaries for Session 3 testing
    │   └── diagnostic_variable_interpolation.txt # One-off Vapi diagnostic prompt
    ├── server/
    │   └── server_28Apr2026.js       # Legacy server, reference only
    ├── sim_prompts/
    │   └── ...                       # Standard / resistant / mombasa / Session 3 SIM personas
    ├── reference/
    │   └── Cooking_in_Nairobi_interview_guide.docx
    └── vapi_config/
        ├── schedule_callback.json
        ├── schedule_next_session.json
        ├── schedule_first_attempt.json
        ├── report_wrong_number.json
        ├── prescreening_complete.json
        └── assistant_notes.md        # User-maintained notes on Vapi assistant settings (voices, transcribers, etc.)
```

## Phase 1: Built — state of the system

### What's deployed

**Interview endpoints:**
- `POST /start-call` — body `{customerNumber, name?, sessionNumber?=1, priorSessionsContext?, acknowledgeMissingPriorContext?, scheduledAtLocal?, assistantId?}`. Upserts participant + session, optionally schedules for the future (interpreting `scheduledAtLocal` in the participant's local timezone) or dials immediately. Inserts a `scheduled_calls` row for every call (immediate or scheduled), snapshotting the submitted name as `name_at_call`. For `sessionNumber > 1` the server auto-loads `PRIOR_SESSIONS_CONTEXT` from `sessions.summary` for sessions 1..N-1 via `loadPriorSessionsContext` — caller does not need to supply it. If any prior session is missing its summary, the endpoint returns **409 `{error: "missing_prior_context", missing: [...], message: "..."}`** unless the caller passes `acknowledgeMissingPriorContext: true` (the operator dashboard exposes this as an Override checkbox revealed on 409). Explicit `priorSessionsContext` in the body still overrides the auto-loaded value for backward compatibility with curl workflows.
- `GET /scheduled-calls` — interview dashboard data. Returns recent (last 7 days) + future scheduled-calls rows, joined with participant info. Reconciles `status='sent'` rows whose Vapi call has ended (maps `endedReason` → outcome). Returns the per-row Name snapshot.
- `DELETE /scheduled-calls/:id` — cancel a scheduled interview (best-effort Vapi delete + Supabase soft-cancel).

**Screening endpoints:**
- `POST /start-prescreening` — body `{customerNumber, name?, scheduledAtLocal?}`. Dials Vapi with the screening prompt and `assistantOverrides.analysisPlan.structuredDataPlan` (12-field schema). Sets `variableValues.CALL_KIND="prescreening"` so callbacks during the screening flow stay in the screening prompt.
- `GET /prescreening-responses` — screening dashboard data. Returns rows joined with participants and an `interviewCalled` derived flag (true if any non-cancelled `scheduled_calls` row exists for the participant).
- `PATCH /prescreening-responses/:id` — analyst-controlled flags: `disqualified`, `force_active`, `analyst_notes`.
- `DELETE /prescreening-responses/:id` — hard-delete the screening row (participant record preserved).

**Webhook:**
- `POST /vapi` — handles `status-update` (skip close-out timers for prescreening calls), `speech-update` (queued wrap-up trigger for interviews), `tool-calls` (all tools), `end-of-call-report` (interview: persist transcript + map endedReason to status; screening: extract `analysis.structuredData` and upsert into `prescreening_responses`).

**QStash-driven timers (interview only):**
- `POST /timing/wrap-up` — QStash trigger at T - `WRAPUP_OFFSET_MINUTES`. Queues the wrap-up text in `pendingWrapUpByCallId` and marks the call in `inWrapUpPhaseForCallId`. The speech-update handler force-speaks the queued text when the participant next stops talking.
- `POST /timing/force-close` — fail-safe ~30s before hard cap. Force-speaks the closing line and auto-hangs up.
- `POST /timing/hard-cap` — final fail-safe at `INTERVIEW_MAX_MINUTES`. Ends Vapi call via controlUrl.
- `POST /timing/fire-callback` — short-fuse callback firing. Honors `CALL_KIND` in body so the rescheduled call uses the right prompt (interview vs screening).

### Prompt structure

The prompt at `eric_project/prompts/Imani_system_prompt_phase1.xml`:
- Top: `<active_session>{{ACTIVE_SESSION}}</active_session>` + `<is_callback>{{IS_CALLBACK}}</is_callback>` + `<opening_flow_decision>` table
- `<prior_sessions_context>{{PRIOR_SESSIONS_CONTEXT}}</prior_sessions_context>`
- `<role>` — sanitized of "Nairobi" / "EPC" specifics (those leaked into screening as supplemental questions)
- `<localization>` — adapts vocabulary, idiom, code-switching, register, and cultural framing to `{{COUNTRY}}` (inferred by the server from the participant's phone number). Tells Imani to recognise local terms without asking for clarification, stay inside the participant's vocabulary, accept code-switching, and apply cultural context to probes. Falls back to neutral international English if COUNTRY is empty.
- `<runtime_variables>` documentation
- `<session_1_initial_call_flow>` — full intro, consent, "is now a good time", screening or callback scheduling
- `<session_1_callback_flow>` — brief reidentification + availability check
- `<screening_logic>` — embeds `{{SCREENING_QUESTIONS_JSON}}` inline; transition sentence required before first question
- `<time_management>` — describes the wrap-up signal protocol
- `<session_assignment>` — describes the routing rules (`<opening_flow_decision>` at top is the primary routing)
- `<continuity_check>`, `<placeholder_handling>`, `<study_context>`
- `<interview_structure>` — all 14 phases, all milestones (Sessions 2 and 3 included for Phase 2 readiness)
- `<how_to_probe>`, `<scope_discipline>`, `<voice_and_manner>`, `<post_close_behaviour>`, `<following_unexpected_depth>`
- `<session_2_opening_protocol>`, `<session_3_opening_protocol>` — sanitized of vivid example phrases that previously leaked into Session 1 ("three kids", "pilau and your mother's kitchen")
- `<closing_protocol>` with `<session_1_close>`, `<session_2_close>`, `<session_3_close>`
- `<examples>`

### Three-stage close-out

Configured in `server.js`'s status-update handler. Times relative to call start:

- **Soft signal** at T - `WRAPUP_OFFSET_MINUTES` (default 2). QStash fires `/timing/wrap-up`, which does NOT speak immediately — it **queues** the wrap-up text in `pendingWrapUpByCallId` and marks the call in `inWrapUpPhaseForCallId`. When the next `speech-update` arrives with `role=user, status=stopped` (i.e. participant finishes their next turn), the handler force-speaks the queued text via Vapi `{type:"say"}` with `interruptAssistantEnabled:false`. This means the soft signal never barges in mid-question.
- **Force close** at T - `FORCE_CLOSE_OFFSET_SECONDS` (default 30). If the call is still live, force-speaks the closing line and auto-hangs up. Fail-safe if Imani didn't wrap on the soft signal.
- **Hard cap** at T = `INTERVIEW_MAX_MINUTES`. Forces `endVapiCall` via controlUrl `{type:"end-call"}`. Final fail-safe.

**Branching on session:**

- **Sessions 1 and 2**: soft text is *"Well, that wraps up our interview for today. Thank you so much for everything you've shared. Before we go, I'd like to schedule our next conversation. Would three days from now at this same time work for you?"* — `endCallAfterSpoken:false` (conversation continues so the participant can answer and Imani can invoke `schedule_next_session`).
- **Session 3 (final)**: soft text is *"Well, that wraps up our final interview session. Thank you so much for everything you've shared across our conversations. Take care. Goodbye."* — `endCallAfterSpoken:true` (Vapi auto-hangs up; no scheduling step). The appended "Goodbye." buffers TTS clipping that was rendering "Take care." as garbled audio.

The server reads `ACTIVE_SESSION` from variableValues to branch. **Skipped entirely for screening calls** — the status-update handler checks `variableValues.CALL_KIND` and short-circuits before scheduling any timer when the call is `prescreening`. Screening calls close out via the `prescreening_complete` tool instead.

### Callback / next-session scheduling — short-fuse vs long-fuse

Both `schedule_callback` (for "I can't talk now, call me back later" during the initial call's consent step) and `schedule_next_session` (at end of Sessions 1 and 2) use the same short-fuse pattern:

- **Delay < `QSTASH_CALLBACK_THRESHOLD_MINUTES` (default 10)** → server schedules a QStash POST to `/timing/fire-callback` at the target time. That handler dials Vapi immediately with no schedulePlan. Avoids Vapi's multi-minute scheduler lead time on tight schedules.
- **Delay ≥ threshold** → uses Vapi's native `schedulePlan.earliestAt`. Lead time is negligible relative to the wait.

The `/timing/fire-callback` body includes `isCallback` and `variableValues` (with `ACTIVE_SESSION`), so the handler builds the right per-call prompt regardless of whether it's a Session 1 callback or a Session 2/3 dial.

### Server-side tool intercept (wrap-up phase)

The model stubbornly picks `schedule_callback` over `schedule_next_session` for short-fuse times ("in one minute") at end of session, despite the tool descriptions explicitly forbidding it. Server-side compensates:

- `inWrapUpPhaseForCallId` Set is populated when `/timing/wrap-up` queues the soft signal.
- In the tool-calls handler, if Imani invokes `schedule_callback` while the call is in `inWrapUpPhaseForCallId`, the server **reassigns `fn.name = "schedule_next_session"`** before the rest of the handler runs. The Session 2/3 dial is scheduled correctly regardless of which tool the model picked.

If `schedule_next_session`'s `suggestedTime` argument is unparseable (the model sometimes invokes it prematurely with its own clarifying question as the argument), the server falls back to scheduling "in three days at this same time" rather than failing silently. A real follow-up call gets queued; the audio confirmation is the only thing that sounds off in that recovery case.

### Database schema (live in Supabase)

```sql
CREATE TABLE participants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_number TEXT NOT NULL UNIQUE,
  name TEXT,
  screening_passed BOOLEAN DEFAULT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  participant_id UUID REFERENCES participants(id) NOT NULL,
  session_number INT NOT NULL CHECK (session_number IN (1, 2, 3)),
  call_id TEXT,
  status TEXT NOT NULL,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  summary TEXT,
  prior_sessions_context TEXT,
  transcript JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(participant_id, session_number)
);

CREATE TABLE scheduled_calls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  participant_id UUID REFERENCES participants(id) NOT NULL,
  session_number INT NOT NULL CHECK (session_number IN (1, 2, 3)),
  scheduled_at TIMESTAMPTZ NOT NULL,
  vapi_call_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- 'sent' | 'cancelled' | <per-attempt outcome like 'completed' / 'no_answer' / 'wrong_number' / 'rescheduled_unreached' / etc.>
  name_at_call TEXT,                       -- snapshot of the name as submitted at call time
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE daytime_retries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  participant_id UUID REFERENCES participants(id) NOT NULL,
  session_number INT NOT NULL CHECK (session_number IN (1, 2, 3)),
  attempts INT NOT NULL DEFAULT 0,
  last_attempt_at TIMESTAMPTZ,
  declined BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(participant_id, session_number)
);

CREATE TABLE prescreening_responses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  participant_id UUID REFERENCES participants(id) NOT NULL, -- not unique: re-screens get their own rows
  vapi_call_id TEXT UNIQUE,                                 -- UNIQUE for idempotency on end-of-call-report
  name_at_call TEXT,
  duration_seconds INTEGER,
  -- Q1
  about_you_text TEXT,
  -- Q2-Q6
  english_interview_ok BOOLEAN,
  robot_recorded_ok BOOLEAN,
  whatsapp_photos_ok BOOLEAN,
  main_cook BOOLEAN,
  owns_epc BOOLEAN,
  -- Q7-Q8
  epc_uses_last_week INTEGER,
  age INTEGER,
  -- Q9-Q12 (PPI assets)
  owns_tv BOOLEAN,
  owns_fridge BOOLEAN,
  owns_car BOOLEAN,
  piped_water BOOLEAN,
  -- Derived + meta
  ppi_score INTEGER,            -- 0-4 asset count (placeholder for a real PPI scorecard)
  needs_followup BOOLEAN DEFAULT FALSE,
  followup_notes TEXT,
  raw_extraction JSONB,         -- full LLM output kept verbatim
  disqualified BOOLEAN DEFAULT FALSE,
  force_active BOOLEAN DEFAULT FALSE,
  analyst_notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

RLS is enabled on all five tables with no policies (server uses service-role key, anon key is denied).

`createSessionRow` upserts on `(participant_id, session_number)` — re-calling the same phone resets the row to a fresh `scheduled` state, so test cycles don't hit unique-constraint errors.

`daytime_retries` is upserted on `(participant_id, session_number)` and cleared in `/start-call` after `upsertParticipant` — operator re-dial gives a fresh `DAYTIME_RETRY_CAP` budget. The `declined` flag is set when the bot ends a connected call without scheduling (assistant-ended-call with participant turns), to prevent any stale future-scheduled callback from restarting the retry chain.

### Render env vars (production)

| Var | Value |
|---|---|
| `VAPI_API_KEY` | Vapi API key |
| `ASSISTANT_ID` | The Imani assistant ID on Vapi |
| `PHONE_NUMBER_ID` | Vapi phone number resource ID |
| `QSTASH_TOKEN` | Upstash QStash token |
| `RENDER_BASE_URL` | Public Render URL, e.g. `https://vapi-interview-webhook.onrender.com` |
| `INTERVIEW_MAX_MINUTES` | 45 in production, 3-5 for short tests |
| `WRAPUP_OFFSET_MINUTES` | 2 in production |
| `FORCE_CLOSE_OFFSET_SECONDS` | 30 (default) |
| `QSTASH_CALLBACK_THRESHOLD_MINUTES` | 10 (default) |
| `DAYTIME_RETRY_CAP` | 4 (default). Max auto-retry attempts per (participant, session) when dial-time failures (busy/no-answer/voicemail) chain. After the cap, operator must manually re-dial. |
| `DAYTIME_RETRY_INTERVAL_MINUTES` | 60 (default). Spacing between daytime retries. |
| `DAYTIME_WINDOW_START_HOUR` | 8 (default). Earliest hour (participant's local timezone, inferred from phone country code) at which a daytime retry will fire. |
| `DAYTIME_WINDOW_END_HOUR` | 20 (default). Latest hour (exclusive). Retries scheduled outside the window snap to next-day START_HOUR. |
| `SCREENING_QUESTIONS_JSON` | **Deprecated.** Was used by the old in-interview `<screening_logic>` block, which has been removed. Safe to leave set; nothing reads it anymore. |
| `CONSENT_STATEMENT_ENABLED` | `"true"` (default) or `"false"`. When `"true"`, Imani reads the formal consent statement and waits for explicit yes/no before the interview begins. When `"false"`, the interview begins immediately after the availability check. Read fresh per call (no restart needed). |
| `START_CALL_API_KEY` | Required for `/start-call`, `/start-prescreening`, and all dashboard endpoints. Sent as `X-API-Key` header. If unset, endpoints are open (development only — startup warning logs this). |
| `SUPABASE_URL` | Supabase project URL (no `/rest/v1` suffix) |
| `SUPABASE_SERVICE_ROLE_KEY` | Service-role JWT (server-side only, bypasses RLS) |

### Vapi assistant config (production)

- Model: `claude-sonnet-4-20250514`, `temperature: 0.4`, `maxTokens: 250` (matches sim parity)
- Voice: ElevenLabs (voice ID configured in dashboard)
- Transcriber: Speechmatics or Deepgram (varies; check assistant config). Watch transcription accuracy on quiet/short answers.
- `firstMessageMode: assistant-speaks-first-with-model-generated-message`, empty `firstMessage` (model generates the first turn from the system prompt). Tried `assistant-waits-for-user` briefly but reverted — model first-token latency makes Imani's opening greeting slow enough that there's no perceptible overlap with the participant's pickup, so having her speak first feels cleaner.
- `startSpeakingPlan.waitSeconds: 0.3`, `stopSpeakingPlan.numWords: 3, voiceSeconds: 0.3`
- `endCallFunctionEnabled: true`
- `serverMessages: ["function-call", "tool-calls", "status-update", "hang", "end-of-call-report", "speech-update"]`. `speech-update` is required for the wrap-up flow to detect participant-stop events.
- `model.toolIds`: `schedule_callback` (`1349e77b-...`), `schedule_next_session` (`93497b3c-...`), `report_wrong_number` (`528b1b63-...`), `schedule_first_attempt` (`a9aa8752-...`), `prescreening_complete` (`b84c81f5-...`). The screening prompt only uses `prescreening_complete`, `schedule_callback` (for "call me back later" during screening), `schedule_first_attempt`, and `report_wrong_number`. The interview prompt only uses `schedule_callback`, `schedule_next_session`, `schedule_first_attempt`, and `report_wrong_number`.
- `firstMessageInterruptionsEnabled: true` — participant can interrupt the intro (don't-restart-on-interrupt rule is in the prompt).
- `voice.chunkPlan` is explicitly enabled (`enabled:true`, `formatPlan.enabled:true`) with regex replacements that strip any stray `<EVAL:[^>]*>` or `Eval: tested ...` paraphrases from TTS. These remain as a safety net but are no longer the primary mechanism — see the next bullet.
- **Classification audit via silent async tool, NOT inline text.** Earlier iterations tried having the model emit a `<EVAL: ...>` diagnostic tag before its spoken response, with Vapi's `removeAngleBracketContent` formatter or a custom regex stripping it from TTS. That approach failed in production because Vapi chunks the model's output as it streams (default chunk size ~30 chars), the formatter runs per-chunk, and the model paraphrased the diagnostic as spoken-English sentence fragments (`"Deflective, no."` etc.) instead of literal angle-bracket text. Those fragments don't have angle brackets and don't have an "EVAL:" anchor on every fragment, so no regex can reliably catch them without over-stripping legitimate conversation. **Current architecture** (commit 6/3/2026): the `log_classification` reusable Vapi tool (`async: true`, id `7098e195-...`, snapshot at `eric_project/vapi_config/log_classification.json`) is invoked by the model BEFORE every spoken response on every turn. The tool takes `precedence_walk` (full ladder walk, ~150-250 chars) and `final_classification` (enum). Vapi cannot speak tool-call arguments — they land in `artifact.messages` for analyst audit but never reach TTS. With `async:true` the model does not wait for the tool result, so the latency cost is just the extra token generation for the JSON args (~100-300ms). The prompt's `<evaluation_rule>` block instructs invocation; the server's `/vapi` tool-calls handler has a `log_classification` branch that logs to console and acks.
- For screening calls, `/start-prescreening` passes a per-call `assistantOverrides.analysisPlan.structuredDataPlan` (12-field JSON schema + `needs_followup` boolean + `followup_notes` string). Vapi runs an extraction LLM at end-of-call and delivers the result to the webhook in `message.analysis.structuredData`.
- For **interview calls**, the same per-call override mechanism attaches `assistantOverrides.analysisPlan.summaryPlan` (constant `INTERVIEW_SUMMARY_PLAN` in `server.js`). Vapi runs a prose-summary LLM at end-of-call producing 1500-2500 words with UPPERCASE section headers (HOUSEHOLD AND ENVIRONMENT, COOKING RHYTHM, etc. — see the constant for the full set). The summary arrives in `message.analysis.summary` and is persisted by the end-of-call-report handler into `sessions.summary` for both the tool-set-terminal branch and the regular branch. Attached at all five interview-call sites: `startVapiCall`, `scheduleVapiCallback` long-fuse, `/start-call` future-scheduled, `schedule_next_session` long-fuse, `/timing/fire-callback`. Loaded back as `PRIOR_SESSIONS_CONTEXT` on the next session's dial via `loadPriorSessionsContext`.

### `schedule_callback` tool (reusable, Vapi org-level)

Snapshot at `eric_project/vapi_config/schedule_callback.json`. Used when the participant says "not now, call me back later" at the start of any session — Session 1's consent step, or Session 2/3's "Is now still a good time to talk?" check. Server preserves the live `ACTIVE_SESSION` and `PRIOR_SESSIONS_CONTEXT` from the current call so the rescheduled call re-enters at the same session with the same prior context.
- Parameters: `suggestedTime` (required), `customerNumber` (optional — server uses call.customer.number; the model's value is ignored).
- Description explicitly forbids using it for next-session scheduling.
- `messages[0]`: `{type: "request-start", content: ""}` — empty content suppresses the model's filler.
- `messages[1]`: `{type: "request-complete", content: "Take care. Goodbye.", endCallAfterSpokenEnabled: true}` — Vapi speaks this verbatim and auto-ends. Short and unambiguous; the appended "Goodbye." buffers TTS clipping that was previously rendering "Take care." as garbled audio. The verbal time read-back happens via the prompt's confirmation flow BEFORE the tool is invoked.

### `report_wrong_number` tool (reusable, Vapi org-level)

Snapshot at `eric_project/vapi_config/report_wrong_number.json`. Used in Session 1's Step 0 identity-check flow when the third party who answered confirms this is NOT the right number for the intended participant. No parameters. `request-complete` content: `"Sorry to have bothered you. Goodbye."` with `endCallAfterSpokenEnabled: true`. Server-side handler sets `sessions.status='wrong_number'` for the participant's Session 1 row.

### `schedule_first_attempt` tool (reusable, Vapi org-level)

Snapshot at `eric_project/vapi_config/schedule_first_attempt.json`. Used in Session 1's Step 0 identity-check flow when the third party confirms it IS the right number but the participant is unavailable and a time has been agreed for trying again. Parameters: `suggestedTime` (required, concrete). Distinct from `schedule_callback` because the participant has NEVER been on the line yet — the rescheduled call must give them the full introduction. The server schedules the rescheduled call with `isCallback=false` (NOT true like `schedule_callback`) and `priorSessionsContext=""`, so the rescheduled call enters `session_1_initial_call_flow` and gives the full intro. Sets `sessions.status='rescheduled_unreached'`. `request-complete` content: `"OK, I will try again at the agreed time. Thank you. Goodbye."` with `endCallAfterSpokenEnabled: true`.

### `schedule_next_session` tool (reusable, Vapi org-level)

Snapshot at `eric_project/vapi_config/schedule_next_session.json`. Used at the end of Sessions 1 and 2 to schedule the next session in the multi-session study.
- Parameters: `suggestedTime` (required, must be a concrete time, not a question or placeholder).
- Description explicitly requires the model to wait for a concrete time from the participant before invoking — addresses the model's tendency to invoke prematurely with a clarifying question as the argument.
- `messages[0]`: `{type: "request-start", content: ""}` — suppresses filler.
- `messages[1]`: `{type: "request-complete", content: "Take care until then. Goodbye.", endCallAfterSpokenEnabled: true}` — Vapi speaks this verbatim and auto-ends. Verbal read-back of the agreed time happens via the prompt's confirmation flow BEFORE the tool is invoked.

### `prescreening_complete` tool (reusable, Vapi org-level)

Snapshot at `eric_project/vapi_config/prescreening_complete.json`. Used by the screening bot immediately after Q12 is answered. No parameters. `request-complete` content: `"Thank you so much for your time. If you are selected for the interview, we will call you back. Goodbye."` with `endCallAfterSpokenEnabled: true`. The screening prompt explicitly tells the model NOT to call endCall directly — the model just invokes this tool silently, the platform speaks the verbatim three-sentence close and ends the call. **Required server-side handler**: a tool-call branch that returns `{ result: "Closing call." }` so Vapi gets a tool response and proceeds with the request-complete + auto-hangup. Without that handler the model loops, re-invoking the tool until eventually falling back to plain endCall.

### Per-call prompt assembly

Two distinct prompt paths, both built fresh per call by `buildModelOverride({ isCallback, activeSession, hasName, callKind })`:

**Interview path** (`loadPromptForCall`): reads `Imani_system_prompt_phase1.xml` and strips blocks that don't apply to this call:
- The non-matching opening flow (initial vs callback).
- `session_2_opening_protocol` / `session_3_opening_protocol` blocks not used by the current session.
- `screening_logic` for sessions 2 and 3 (Sessions 2/3 always skip screening; the block is also empty now since screening was moved to the screening bot).
- `step_0_identity_check` when no participant name was provided (otherwise the model leaks a half-formed identity-check sentence).
- `consent_branch_enabled` vs `consent_branch_disabled` based on the `CONSENT_STATEMENT_ENABLED` env var (multiple instances stripped with `gm` flag).

**Screening path** (`loadPrescreeningPrompt`): reads `prescreening_prompt.xml` and strips `step_0_identity_check` when no name. The screening prompt is much smaller (~9KB vs ~158KB) — no phases/milestones, just identity check + intro + availability + 12 questions + close.

The strip regex is line-anchored (`^<tag>...^</tag>$` with `m` flag) so inline prose mentions of other tag names don't get lazily eaten.

Effect: prompt edits no longer require `update-assistant.ps1`. Commit + push triggers Render redeploy and the next call uses the new prompt. The Vapi-stored prompt is a fallback only.

## Hard-Won Vapi Knowledge

Recorded so future iterations don't relearn these the hard way.

### Webhook & runtime

- **Express body limit must be `10mb`.** Vapi webhook payloads include the full assistant config (system prompt + tools) plus the running transcript. Default 100kb returns 413 PayloadTooLargeError before any handler runs. Symptom: sessions stuck at `scheduled`, no application logs.
- **Variable interpolation has two channels.** `{{VAR}}` in the prompt body substitutes inline at call time. Bare-name references (e.g., "Parse SCREENING_QUESTIONS_JSON" in prose) also reach the model through a separate channel. Use `{{...}}` when placement matters; either works for reading values by name.
- **Vapi rejects partial `model` overrides.** `assistantOverrides.model = {messages: [...]}` returns 400 "model.provider must be one of...". Must include the full model object (provider, model, temperature, maxTokens, toolIds). Server caches the assistant's model fields once and uses them as the base.

### Tools

- **Two tool shapes coexist:** legacy `model.functions[]` (no `messages` config) and newer `model.tools[]` (supports `messages`). Migrate to `tools[]` to use the messages config.
- **Two tool storage modes:** inline (`model.tools[]` directly on assistant) vs reusable (`POST /tool` then reference via `model.toolIds[]`). Only reusable tools appear in the dashboard's Tools page.
- **`request-complete` with `endCallAfterSpokenEnabled: true`** lets Vapi speak a tool result and auto-end without involving the model. Bypasses the model's tendency to ignore tool results.
- **`request-start` with empty content** suppresses the model's pre-tool-call filler ("let me set that up", "just a sec"). Confirmed accepted by Vapi.
- **`{{result}}` does NOT substitute** in tool message templates. `{{output}}` doesn't either. **`{{toolArgName}}` (e.g., `{{suggestedTime}}`) DOES substitute** with the argument value. Use tool args, not the result, for content interpolation.

### Call control

- **Ending a call:** `PATCH /call/:id` with `{status: "ended"}` returns 400 ("property status should not exist"). Use the call's `controlUrl` with `{type: "end-call"}` instead. The controlUrl appears in the `status-update` webhook payload at `message.call.monitor.controlUrl`.
- **Forcing the assistant to speak:** `controlUrl` with `{type: "say", content: "...", endCallAfterSpoken: true}` makes Vapi speak the literal text and (optionally) hang up after. Bypasses the model entirely.
- **`interruptAssistantEnabled: false` on a `say` action** makes Vapi wait for the assistant's current speech to finish before doing the say. Use this when force-speaking mid-conversation to avoid barging into the middle of Imani's question.
- **`speech-update` webhook events** fire with `role` ∈ {`user`, `assistant`} and `status` ∈ {`started`, `stopped`}. Enabling it in `serverMessages` lets the server detect when the participant finishes their turn — used to defer wrap-up speech to a natural turn boundary.
- **Mid-conversation system messages are unreliable.** Adding a `{role: "system"}` message via `add-message` mid-call is hit-or-miss — the model often ignores it and continues its current behavior. For hard requirements, use `{type: "say"}` instead.
- **`endedReason: "assistant-ended-call-after-message-spoken"`** is what you see when `endCallAfterSpokenEnabled` triggers.
- **Vapi's native `schedulePlan.earliestAt` has multi-minute lead time** on tight schedules (empirically 5+ min for "in 1 minute" requests stuck in `scheduled` state). For sub-10-minute delays, schedule via QStash and dial Vapi immediately when the time arrives.

### Prompt construction

- **Server-side prompt assembly is more reliable than model-side conditional routing.** When the prompt has multiple opening flows and asks the model to pick by IS_CALLBACK, the model picks the most prescriptive option regardless. Strip the inappropriate block on the server, send the assembled prompt via `assistantOverrides.model.messages`.
- **Strip-regex must be line-anchored.** `^<tag>...^</tag>$` with `m` flag. Inline prose mentions of tag names ("see <session_1_callback_flow>") would otherwise be matched and the regex would lazily delete through to the actual closing tag of the wrong block.
- **Prompt size:** 158KB has worked. Anthropic Sonnet 4 handles this fine. Watch for impacts on first-token latency; not currently a problem.

### Other

- **Vapi assistant pre-config:** Vapi's `firstMessageMode: assistant-speaks-first` with empty `firstMessage` causes the assistant to wait silently. Use `assistant-speaks-first-with-model-generated-message` to have the model generate the first turn from the system prompt. Tried `assistant-waits-for-user` briefly (participant speaks first) but reverted — model first-token latency already delays Imani's greeting enough that overlap with the participant's pickup isn't a real problem, so having her speak first is cleaner.
- **`schedule_callback`'s `customerNumber` argument is unreliable.** The model passes the literal `"{{customerNumber}}"` placeholder string, or no value, or a malformed phone. Server takes `customerNumber` from `message.call.customer.number` (guaranteed E.164) and ignores the model's value.
- **The model picks the wrong scheduling tool at end of session.** Despite tool descriptions explicitly disambiguating `schedule_callback` (for "I can't talk now" only) and `schedule_next_session` (for end-of-session next-session scheduling), the model picks `schedule_callback` for short delays like "in one minute" because the pattern feels callback-shaped. Server-side intercept (`inWrapUpPhaseForCallId`) compensates by reassigning the function name when invoked in wrap-up phase.
- **The model invokes `schedule_next_session` prematurely** with its own clarifying question as the `suggestedTime` argument when the participant declines the default. Tool description explicitly forbids this. Server has a parse-failure fallback to "in three days at this same time" so a real follow-up call gets queued either way.

## Resolved Decisions

- **Single Render service** for MVP. Don't split into orchestrator + summariser.
- **Participant names will be used.** `PARTICIPANT_NAME` is a runtime variable. Imani addresses the participant by name when available.
- **Database: Supabase free tier.** Schema as above. RLS enabled with no policies.
- **Per-call server-side prompt assembly** strips all opening flow blocks that don't match the active session/IS_CALLBACK combination. Also strips `screening_logic` for Sessions 2 and 3.
- **Three-stage close-out** (soft signal queued → speech-update triggers say → force-close fallback → hard cap). Soft signal waits for participant-stop before speaking. Session 3 uses a final-farewell variant with `endCallAfterSpoken:true`.
- **QStash short-fuse routing** for any callback/next-session under `QSTASH_CALLBACK_THRESHOLD_MINUTES` (default 10); Vapi schedulePlan for longer.
- **Both scheduling tools are reusable Vapi tools** (`schedule_callback` + `schedule_next_session`), referenced by `toolIds` on the assistant.
- **Tool result text is spoken by Vapi via `request-complete` + `endCallAfterSpoken`**, not by the model.
- **Server-side intercept** redirects misrouted `schedule_callback` invocations during wrap-up to `schedule_next_session`.
- **Country localization is server-derived.** The server uses `libphonenumber-js` to parse the participant's phone number, maps the ISO alpha-2 country code to an English country name (lookup table for KE/NG/GH/TZ/UG/ZA/RW/ET/US/GB/CA; ISO code as fallback for unmapped countries), and passes it as the `COUNTRY` runtime variable. The prompt's `<localization>` block uses `{{COUNTRY}}` to adapt Imani's behaviour. No country-specific knowledge packs are baked in for MVP — relies on the model's training-data knowledge of country-specific English.
- **Operator web dashboard at `/`.** Static HTML in `public/index.html` served by the same Render service. **Two tabs**: Interview operator + Screening. Interview tab: table-based call queue with per-row Phone, Name, **Session selector (1/2/3 dropdown, default 1)**, Schedule, Scheduled-for, Status, Notes, per-row Call/Delete buttons, multi-select with bulk delete. When a Session 2/3 dial gets a 409 `missing_prior_context` response, an **Override checkbox** is revealed on that row; ticking it and re-submitting passes `acknowledgeMissingPriorContext: true` and dials with empty prior context. Screening tab: sortable response table (Date, Duration, Phone, Name, About-you-quote, 12 question columns, PPI, Follow-up?, Follow-up details, Disqualify, Force show, Called, Actions/Delete). Row-click sends participant to interview tab with phone+name pre-filled. Downloadable .xlsx via lazy-loaded SheetJS. Drafts live in browser localStorage (key `eric_draft_rows_v1`) until submitted. All endpoints protected by `X-API-Key` header (env var `START_CALL_API_KEY`); the dashboard prompts for the key once and stores it in localStorage. Scheduled times are interpreted in the participant's local timezone, inferred from the phone number's country code via `parseLocalDatetimeInTimezone` (independent of the host's local timezone — uses Intl.DateTimeFormat.formatToParts).
- **Read-back-and-confirm before scheduling.** Before invoking either `schedule_callback` or `schedule_next_session`, Imani must read the proposed time back to the participant ("So I will call you back tomorrow at 3pm, OK?") and wait for explicit confirmation. Specified in three prompt locations: `<session_1_initial_call_flow>` Step 2 callback sub-flow, `<session_1_callback_flow>` Step 3 reschedule branch (which references the Step 2 sub-flow), and the top-level `<next_session_scheduling>` block (which governs end-of-session scheduling for Sessions 1 and 2). The block is not stripped by `loadPromptForCall` — it applies to every session. The tool's `request-complete` message remains the final goodbye that's spoken after Vapi receives the tool invocation.
- **New `sessions.status` values.** In addition to `scheduled`, `in_progress`, `completed`: `wrong_number` (set by `report_wrong_number` tool), `rescheduled_unreached` (set by `schedule_first_attempt` tool — the participant has not yet been reached), and end-of-call-report-derived values from Vapi's `endedReason`: `no_answer`, `voicemail`, `invalid_number`, `no_engagement` (silence-timed-out), `completed_at_cap`, `busy`. `mapEndedReasonToStatus` does the mapping; `statusToNotesLabel` renders the dashboard Notes column. Tool-set terminal statuses (`wrong_number`, `rescheduled_unreached`) are not overwritten by the end-of-call-report handler.
- **Per-attempt outcome tracking on `scheduled_calls.status`.** When the same participant has multiple interview attempts at the same session_number, the shared `sessions` row only reflects the latest call. To preserve per-attempt history for the dashboard, the end-of-call-report handler also writes the outcome onto `scheduled_calls.status` keyed by `vapi_call_id`. The dashboard's `GET /scheduled-calls` reads from there (not from sessions). Reconciliation pass on the dashboard endpoint backfills old rows with `status='sent'` by checking the Vapi call's current state.
- **Per-call name snapshot.** `scheduled_calls.name_at_call` and `prescreening_responses.name_at_call` capture the name as submitted for THIS specific call. The dashboards render those snapshots rather than the shared `participants.name`. This way, leaving the name blank for one call does not retroactively blank out earlier rows for the same phone, and the bot uses the SUBMITTED name (blank or not) — not whatever's stored on participants.
- **Screening flow.** Separate prompt (`prescreening_prompt.xml`) and database table (`prescreening_responses`). `POST /start-prescreening` dials Vapi with the screening prompt + a per-call `analysisPlan.structuredDataPlan` (14-field JSON schema: 12 Qs + needs_followup + followup_notes). `variableValues.CALL_KIND="prescreening"` flows through to identify the call kind on rescheduled callbacks (prompt selection in `buildModelOverride` routes to `loadPrescreeningPrompt`). The end-of-call-report handler detects `CALL_KIND=prescreening`, reads `analysis.structuredData`, computes a 0-4 asset count as `ppi_score`, and upserts a row keyed by `vapi_call_id` (UNIQUE — one row per call, so re-screens for the same phone show as separate rows in the dashboard, sorted by created_at DESC). `GET /prescreening-responses`, `PATCH /prescreening-responses/:id`, and `DELETE /prescreening-responses/:id` drive the dashboard tab. Note: code-level identifiers (file names, endpoint paths, table name, tool names like `prescreening_complete`) still use `prescreening` / `pre-screening` for historical reasons; only user-facing labels say "Screening" / "Screening call".
- **Screening removed from main interview.** The old in-prompt `<screening_logic>` block has been emptied to a placeholder. Eligibility screening now happens via the dedicated screening bot before Session 1 is even scheduled. The `SCREENING_QUESTIONS_JSON` env var is deprecated (nothing reads it).
- **Screening bot answers participant FAQs and flags follow-up needs.** A `<participant_questions>` block in `prescreening_prompt.xml` carries verbatim answers for anticipated questions (why photos, why a robot, who selected me, data privacy, duration, can-I-stop). For payment or any off-FAQ question, the bot punts with `"That's a great question — someone from the team will follow up with you on that."` The extraction LLM at end-of-call sets `needs_followup` (bool) and `followup_notes` (short summary). Dashboard surfaces those as a Follow-up? column (amber highlight when set) so the analyst knows to reach out.
- **Identity check at Session 1 start.** When `PARTICIPANT_NAME` is non-empty, Imani's first utterance is *"Hello, am I speaking with [full name]?"* — no introduction yet. Branches: (a) confirmed → full intro → consent → interview; (b) not them, right number, person not available → ask better time → `schedule_first_attempt` → rescheduled call gets full intro (IS_CALLBACK=false); (c) not them, wrong number → `report_wrong_number` → call ends, marked as wrong number in Supabase. Third party asking "who are you / why?" gets a one-sentence honest answer about being a robot researcher and the participant having agreed to take part. `PARTICIPANT_NAME` arrives in **title + first + last** form (e.g., "Mr. Emeka Obi") and is used verbatim in greetings throughout the call. Sessions 2 and 3 greet by full name but skip the identity-check (participant already confirmed in Session 1). Operator dashboard input field hints at this format.
- **Recording disclosure in interview consent / screening intro.** The interview consent statement includes "This call will be recorded." The screening intro includes "This call is being recorded for internal research purposes." right before "This will only take a few minutes."
- **Verbatim closes via tool messages.** All terminal closes (callback, next-session, wrong-number, schedule-first-attempt, screening complete) live in tool `request-complete` messages with `endCallAfterSpokenEnabled: true`, not in model output. The model just invokes the tool silently; Vapi speaks the verbatim text and hangs up. Solves the recurring problem of the model truncating closes ("Goodbye." instead of the full 3-sentence message). **Every tool that uses this pattern needs a server-side webhook handler that returns a tool-call result** — Vapi won't fire the request-complete until it gets one. The `prescreening_complete` tool needed a trivial `return res.json({ results: [{ result: "Closing call." }] })` branch to stop the model from looping.
- **Automated per-call summarisation for interviews.** Every interview call attaches `analysisPlan.summaryPlan` (constant `INTERVIEW_SUMMARY_PLAN`) in `assistantOverrides` — same per-call override mechanism already proven by `/start-prescreening`'s `structuredDataPlan`. Vapi runs a prose-summary LLM at end-of-call (1500–2500 words, UPPERCASE section headers); `message.analysis.summary` lands in `sessions.summary`. `loadPriorSessionsContext` reads sessions 1..N-1 for the participant when dialing Session N and injects the concatenated summaries as `PRIOR_SESSIONS_CONTEXT`. Manual Phase 2/3 summarisation work (originally a separate Anthropic API pipeline) is no longer needed; the Vapi-side summary suffices.
- **Block-on-missing-summary safety, not silent fallback.** When the operator dials Session N > 1 and any prior session's summary is missing, `/start-call` returns 409 `missing_prior_context` rather than silently dialing with empty context. The dashboard reveals an Override checkbox for explicit acknowledgement. The rationale: silent empty-context dials make stale or incomplete prior state invisible to the operator; an explicit block surfaces it. The hard-fail also catches the case where a summary failed to generate (extraction timeout / Vapi-side failure) on a prior call — operator sees it immediately rather than at analysis time.
- **Daytime hourly retry chain for dial-time failures.** When a call fails before connecting (`customer-busy`, `no-answer`, `voicemail`), the existing 30-second mid-call-drop retry doesn't apply. A separate chain auto-retries hourly (`DAYTIME_RETRY_INTERVAL_MINUTES`) within the participant's local 8am–8pm window (`DAYTIME_WINDOW_START_HOUR`/`END_HOUR`), capped at `DAYTIME_RETRY_CAP` attempts per (participant, session). Counter persisted in `daytime_retries` Supabase table so Render restarts don't break the chain. Retries route through `scheduleVapiCallback` (Vapi's `schedulePlan.earliestAt` for the 60-min delay → survives Vapi-side too). Operator re-dial via `/start-call` clears the row, giving a fresh budget. If the bot ends a connected call without scheduling (assistant-ended-call with participant turns), the chain is marked `declined` so any stale future-scheduled callback that fails later won't restart it. `shouldDaytimeRetry` and `shouldAutoRetryAfterDrop` are mutually exclusive (one checks for "no user turn in transcript", the other for "user turn present"), so no double-firing.

## Iteration History — Lessons Learned (Don't Repeat These)

- **Inference-based session detection failed multiple times.** Switched to server-driven `<active_session>` value plus server-side prompt assembly. Don't try model-side conditional routing again.
- **Don't quote a trigger phrase inside a prohibition.** Telling the model "don't ask about Nairobi residents who own EPCs" made it ask about exactly that. Frame rules positively. Describe categories abstractly. Pink-elephant trap. (Saved as feedback memory.)
- **Don't over-extrapolate from one diagnostic.** A test that proves one mechanism doesn't disprove others. Confirm with the user before declaring their existing code broken. (Saved as feedback memory.)
- **Anchor regex to top-level tags when stripping prompt blocks.** Both opening flows reference each other's tag names in their prose. Unanchored regex catastrophically eats the wrong block.
- **The model unreliably honors mid-conversation system messages.** Don't rely on inject-and-comply for hard requirements (wrap-ups, end-call). Use Vapi's `{type:"say"}` to bypass the model.
- **Soft signal → force-say staging beats single force action.** Single force-say barges in mid-question. Two-stage gives Imani a chance to wrap up at the next natural turn boundary, with force as fail-safe.
- **Queue-then-speak-on-user-stop is more reliable than fire-and-pray timing.** Vapi's `speech-update` event with `role=user, status=stopped` is the right turn-boundary signal. Pure timing-based wrap-up cuts off the participant mid-answer.
- **Trust the server to correct model tool-selection errors.** Don't expect prompt/description tweaks to perfectly bias the model between similar tools. The model picks the wrong one often enough that a server-side intercept (e.g., `inWrapUpPhaseForCallId`) is more robust than yet another description revision.
- **Don't let the model parse times.** Imani will sometimes invoke `schedule_next_session` with a question or vague phrase as `suggestedTime`. Server-side parser failure must have a default-fallback (3 days), not silent failure — otherwise no callback gets scheduled and the participant never hears back.
- **Strengthened milestones produce depth at cost of naturalness when participants are guarded.** Real-participant data still needed to validate.
- **The 43/45-minute pattern came from rejecting "abrupt hang-up at 45 minutes" in favour of "soft warning then fail-safe." Now staged into three.**
- **Earlier "Session 2 detection worked" reports were misleading** — appeared to work because of fallback paths in the prompt, not because the summary was actually being read by Imani. Use diagnostic markers to distinguish "appears to work" from "is verifiably working."
- **`messagesOpenAIFormatted` and `artifact.messages` aggregate consecutive same-role turns.** They look like single mega-utterances even when the call was properly turn-taking. Don't diagnose monologuing from those alone — the visible aggregation is a storage artifact, not the actual model output. Audio is the only reliable source for "did the bot dump everything in one breath."
- **`artifact.transcript` (the STRING field) is also rolled up by role and is NOT chronological.** Character offset in that string tells you nothing about when something was said in the call. The `bot` and `user` entries in `artifact.messages` likewise carry only call-start timestamps for this assistant (only `tool_calls` events have real per-event `time` / `secondsFromStart`). For chronology, use the tool-call timestamps as anchors (each `log_classification` invocation marks the bot processing one participant turn) or download `artifact.recordingUrl` and time things from the audio. Cause unverified — could be the 11labs scribe_v2_realtime transcriber, the Vapi artifact storage layer, or both — but the practical rule stands regardless: don't infer "X happened at minute N" from the transcript string.
- **Vapi tools using `request-complete` need a server-side handler that returns a tool result.** Without it, Vapi waits forever, the model re-invokes, and the model eventually gives up with a plain `endCall`. The handler can be trivial (`return res.json({ results: [{ result: "..." }] })`) but it MUST exist. Discovered when `prescreening_complete` was looping in production.
- **`scheduleVapiCallback` must not hardcode `IS_CALLBACK` or `activeSession`.** Earlier versions did, silently overriding the intent of `schedule_first_attempt` (which needs `IS_CALLBACK=false` so the rescheduled call gives the full intro). Always read these from the passed-in `variableValues`.
- **Per-call name SNAPSHOT, not per-participant.** Dashboard rows that join `participants.name` get retroactively rewritten when a later call changes the participant's name. Snapshot at call time (`name_at_call`) so historical rows show what was actually used.
- **TTS clipping on short final utterances.** "Take care." rendered as garbled audio (transcriber wrote "take a yay" / "take a guess"). The fix is to append a throwaway word like "Goodbye." so the meaningful phrase has audio buffer before the cutoff. Pattern applies to every tool's `request-complete` and the force-close text.
- **Don't let the prompt instruct "speak the close, then call endCall" — the model reverses the order.** Empirically the model calls endCall first and the prescribed close gets truncated to "Goodbye." Move the close text into a tool's `request-complete` with `endCallAfterSpokenEnabled: true` so Vapi handles speech + hangup atomically.
- **`firstMessageInterruptionsEnabled: false` makes things worse, not better.** Was tried to stop pickup-greeting interruptions from restarting the intro. Side effect: participant cannot interrupt long monologues. Better fix: re-enable interruptions and use a prompt rule that forbids re-starting the intro on interruption.
- **Skip the close-out timers for screening calls.** The status-update handler used to schedule three-stage close-out for every call. Screening calls don't need it (the screening bot's own close fires via `prescreening_complete`). Hard-coded `INTERVIEW_MAX_MINUTES=4` would otherwise fire the wrap-up signal mid-screening and trigger spurious "would three days from now work?" scheduling prompts.
- **Separate persistent table for the daytime retry counter — not `scheduled_calls`, not in-memory.** Considered two cheaper alternatives: (a) reuse `scheduled_calls` by counting prior rows for the same (participant, session_number) with a failure status, or (b) keep an in-memory Map like `autoRetryCountBySession`. Rejected (a) because querying-and-counting on every end-of-call is more fragile than a single counter row, and the `declined` flag needs its own representation distinct from per-attempt outcome. Rejected (b) because Vapi's `schedulePlan.earliestAt` retries can fire after a Render restart, at which point an in-memory counter would have reset and the chain would restart from 0 — operator gets stuck in an infinite retry loop until the participant picks up or manually intervenes. The persistent `daytime_retries` table makes the chain survivable across restarts.

## Phase 2 and Phase 3 Work

**Phase 2** — Broader testing (in progress):
- Add cross-call scheduling validation (Sessions 1 → 2 → 3 with real day-gap delays, not minute-gap testing)
- Real-participant testing with the strengthened milestones at full 45-min duration
- Auto-loaded summarisation via `analysisPlan.summaryPlan` is in place (was previously Phase 3 work) — `loadPriorSessionsContext` reads `sessions.summary` for prior sessions and injects as `PRIOR_SESSIONS_CONTEXT` on Session N>1 dials. Pending validation that the auto-generated summaries are good enough quality to bridge real participants from one session to the next.

**Phase 3** — Status: the originally-planned Anthropic-API summarisation pipeline is no longer needed. Vapi's per-call `analysisPlan.summaryPlan` produces structured prose summaries directly (see `INTERVIEW_SUMMARY_PLAN` in `server.js`). If the auto-generated summaries prove inadequate after Phase 2 validation, a follow-up Anthropic-API rewrite could still be slotted in — fields/table are unchanged. Reference prose-style target remains `eric_project/prompts/session_1_and_2_summaries_reference.txt`.

## Current Open Issues / Punch List

1. **Validate real-participant probing depth on a full 45-min call.** Short test calls (3-min) showed Imani being less probing than in sim. Likely artifact of time pressure + token budget; user has set `maxTokens=250`, `temperature=0.4` to match sim. Pending test result.
2. **If probing is still thin at 45 min**, the next suspects are the latency tweaks (`startSpeakingPlan.waitSeconds: 0.2-0.3`, `transcriber.maxDelay: 500`) — they were lowered for snappier conversation but may be reducing model deliberation time. Consider partial revert toward 0.5-0.8s.
3. **Validate auto-summary quality at real-participant scale.** `analysisPlan.summaryPlan` now generates `sessions.summary` automatically and `loadPriorSessionsContext` injects it on the next session dial — but the summaries have only been spot-checked. Pending: confirm a real 45-min Session 1 produces a summary that lets Imani convincingly bridge to Session 2 ("Last time you mentioned X...") without hallucination. If summaries are too shallow or wrong, tighten `INTERVIEW_SUMMARY_PLAN`'s system message or swap to a dedicated Anthropic-API rewrite.
4. **Vapi's "No result returned" error** appears in transcripts intermittently. Cause unknown; not prompt-fixable. Investigate Vapi-side.
5. **Stale QStash messages from prior server runs** occasionally fire and hit the timing handlers with dead callIds. Skipped silently via the in-memory tracking sets. Harmless log noise.
6. **Transcription accuracy** can drop on quiet/short answers (Deepgram flux-general-en or Speechmatics default). Has been observed transcribing innocuous answers as "Hang up", causing Imani to obey and end the call early. Worth re-evaluating transcriber config. AssemblyAI and Gladia were tested and dropped speech; Deepgram is most reliable so far.
7. **Cancellation of future-scheduled screening calls** is not supported from the dashboard. The interview operator tab has a Cancel button; the screening tab does not (cancellation would require either rerouting screening through `scheduled_calls` or adding a separate cancel flow). Use the Vapi dashboard directly if needed.
8. **`needs_followup` extraction depends on the analysis LLM correctly identifying that the screening bot used the punt phrasing.** False negatives possible — the punt is in the transcript but the LLM might not flag it. If you see a missed flag, send the call ID and the schema description can be tightened.
9. **PPI score is a 0-4 asset count, not a real PPI scorecard.** A true PPI score would require ~10 country-specific indicators and weights from the Innovations for Poverty Action scorecards. Treat the current number as a rough wealth proxy.
10. **Phase 2 work** still queued (cross-call scheduling validation at real day-gap intervals, full 45-min real-participant runs); Phase 3 (separate summarisation pipeline) is now subsumed by per-call `analysisPlan.summaryPlan` — see item 3 above.
11. **Daytime retry chain operational behaviour** still needs production validation: confirm the hourly cadence actually fires (not deferred by Vapi schedulePlan lead time), the window snap-to-next-day at night-fail boundary works in a non-UTC timezone, and the `declined` flag stops a chain when the participant explicitly refuses. Test plan in `server.js` commit `ef4dcba` message.

## Testing Approach

For prompt iteration, use the SIM personas in `eric_project/sim_prompts/`. Standard pattern:
1. Set Vapi prompt to the Imani prompt being tested
2. Set the SIM prompt as a separate Vapi assistant
3. Call one assistant with the other (agent-to-agent test)
4. Manually toggle `<active_session>` value and `<prior_sessions_context>` content for each session
5. Review transcript

For production code, real call testing via the operator dashboard at `/`. The CLI scripts (`.\scripts\start-call.ps1 +1NUMBER Name`) still work for interview calls but most operations now go through the UI:
- **Interview operator tab**: add a row, fill phone/name/schedule, click Call. Watch the Status column to track lifecycle.
- **Screening tab**: enter phone/name/schedule in the form at the top, click "Screening call". After the call, the response row appears (table auto-refreshes every 15s while the tab is active).
- For ad-hoc DB inspection: `.\scripts\inspect-db.ps1 sessions` or `scheduled_calls` or `prescreening_responses`.

For staged short-cycle testing of interview timing: set `INTERVIEW_MAX_MINUTES=3, WRAPUP_OFFSET_MINUTES=1, FORCE_CLOSE_OFFSET_SECONDS=30` on Render. Whole close-out cycle plays in 3 minutes. **Screening calls ignore these timers entirely** (status-update handler short-circuits when `CALL_KIND=prescreening`), so the short interview cap doesn't truncate a screening test.

To disable the consent statement during interview testing (faster cycles): `CONSENT_STATEMENT_ENABLED=false` on Render. Read fresh per call.
