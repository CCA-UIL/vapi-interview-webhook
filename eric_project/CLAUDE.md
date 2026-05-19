# CLAUDE.md — Imani Voicebot Project

This document is the handoff context for an AI ethnographic interviewer project. It contains everything Claude Code needs to continue the work without re-litigating previous decisions.

## Project Overview

**Goal:** Build "Imani," a Vapi-based outbound voice AI that conducts ethnographic interviews with Nairobi residents who own Electric Pressure Cookers (EPCs). The research explores cultural, emotional, social, and economic dimensions of EPC adoption.

**Current state (2026-05-14):** Phase 1 is built and the full Session 1 → 2 → 3 chain has been validated end-to-end on short test calls. Imani runs each session against real phone numbers with session-appropriate opening flows, screening only on Session 1, scheduling of the next session at the end of Sessions 1 and 2 (with a defensive server-side intercept for tool selection), and a final farewell with auto-hang-up at the end of Session 3. Callback scheduling works for both short (QStash) and long (Vapi schedulePlan) delays for both `schedule_callback` and `schedule_next_session`. Country localization: the server infers the participant's country from their phone number (via `libphonenumber-js`) and passes it as `COUNTRY` runtime variable; the prompt's `<localization>` block adapts Imani's vocabulary, idiom, register, and cultural framing accordingly. Real-participant pilot with full 45-min calls is the next milestone.

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

Each session has phases. Each phase has milestones. Each milestone has an opening probe, optional follow-up probes, and an exit condition. **Phase 1 MVP only runs Session 1**; Sessions 2 and 3 prompt blocks are present but not yet exercised by the server.

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
- `<screening_logic>` — embeds `{{SCREENING_QUESTIONS_JSON}}` inline in the prompt body so the model sees the actual JSON questions verbatim, not just the variable name. Includes a transition sentence requirement before the first question.

## Repository Layout

```
vapi-interview-webhook/
├── server.js                         # Production server, deployed to Render. Express + Supabase + QStash.
├── package.json, package-lock.json
├── render.yaml                       # Render service config
├── ARCHITECTURE.md                   # Mermaid component + sequence diagrams
├── DEPLOYMENT.md                     # Render env vars, Vapi config, test plan, curl examples
├── .env / .env.example               # Local-runtime env, mirrors Render env
├── scripts/
│   ├── start-call.ps1 / .sh          # Trigger a call: `.\scripts\start-call.ps1 +1NUM Name`
│   ├── inspect-db.ps1 / .sh          # Read Supabase tables
│   └── update-assistant.ps1          # Push a local prompt file to the Vapi assistant (rarely needed now —
│                                     # server reads prompt per-call from disk)
└── eric_project/
    ├── CLAUDE.md                     # This file
    ├── README.md
    ├── prompts/
    │   ├── Imani_system_prompt_phase1.xml         # PRODUCTION PROMPT, source of truth, ~158KB
    │   ├── Eric_Interview_Orchestrator_28Apr26.xml  # Legacy orchestrator, reference only
    │   ├── Vapi_system_prompt_milestone.txt      # Original milestone prompt, reference only
    │   ├── session_1_and_2_summaries_reference.txt  # Reference summaries for Session 3 testing
    │   └── diagnostic_variable_interpolation.txt # One-off Vapi diagnostic prompt
    ├── server/
    │   └── server_28Apr2026.js       # Legacy server, reference only
    ├── sim_prompts/
    │   ├── SIM_revised.txt           # Standard SIM (solo mother of three, charcoal→EPC)
    │   ├── SIM_resistant.txt         # Harder SIM for stress testing
    │   ├── SIM_mombasa.txt           # Alternative persona
    │   └── SIM_session_3.txt         # Session 3-aware SIM
    ├── reference/
    │   └── Cooking_in_Nairobi_interview_guide.docx
    └── vapi_config/
        └── schedule_callback.json    # Snapshot of the Vapi-side tool config (source of truth backup)
```

## Phase 1: Built — state of the system

### What's deployed

- `POST /start-call` — body `{customerNumber, name?, sessionNumber?=1, priorSessionsContext?, assistantId?}`. Upserts participant + session in Supabase, posts to Vapi `/call` with `assistantOverrides.model.messages` (the per-call assembled prompt) and runtime `variableValues`.
- `POST /vapi` — webhook. Handles `status-update` (start = schedule the three-stage close-out timers, end = clean up + mark session completed), `speech-update` (fires queued wrap-up say after participant-stop), `tool-calls` (`schedule_callback` and `schedule_next_session`, with server-side intercept for wrap-up-phase misroutes), `end-of-call-report` (persist transcript, fallback callback parsing).
- `POST /timing/wrap-up` — QStash trigger at T - `WRAPUP_OFFSET_MINUTES`. **Queues** the wrap-up text in `pendingWrapUpByCallId` and marks the call in `inWrapUpPhaseForCallId`. Does NOT speak yet — that happens in the speech-update handler when the participant's next turn ends.
- `POST /timing/force-close` — QStash trigger ~30s before hard cap. Force-speaks the closing line via Vapi `{type:"say"}`, `endCallAfterSpoken:true` auto-hangs up. Skips silently if call already ended.
- `POST /timing/hard-cap` — final fail-safe at INTERVIEW_MAX_MINUTES. Ends Vapi call via controlUrl `{type:"end-call"}`. Skips silently if call already ended.
- `POST /timing/fire-callback` — QStash trigger for short-fuse callbacks. Dials Vapi immediately with the appropriate prompt (controlled by `isCallback` in body). Used by both `schedule_callback` (same-session retry, any session 1/2/3) and `schedule_next_session` (short Session 2/3 dial).

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
- **Session 3 (final)**: soft text is *"Well, that wraps up our final interview session. Thank you so much for everything you've shared across our conversations. Take care."* — `endCallAfterSpoken:true` (Vapi auto-hangs up; no scheduling step).

The server reads `ACTIVE_SESSION` from variableValues to branch.

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
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

RLS is enabled on all three tables with no policies (server uses service-role key, anon key is denied).

`createSessionRow` upserts on `(participant_id, session_number)` — re-calling the same phone resets the row to a fresh `scheduled` state, so test cycles don't hit unique-constraint errors.

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
| `SCREENING_QUESTIONS_JSON` | JSON array of `{id, question, pass_answer}` |
| `CONSENT_STATEMENT_ENABLED` | `"true"` (default) or `"false"`. When `"true"`, Imani reads the formal consent statement and waits for an explicit yes/no before screening. When `"false"`, screening starts immediately after the availability check. Read fresh per call (no restart needed). |
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
- `model.toolIds`: `schedule_callback` (`1349e77b-...`), `schedule_next_session` (`93497b3c-...`), `report_wrong_number` (`528b1b63-...`), `schedule_first_attempt` (`a9aa8752-...`)

### `schedule_callback` tool (reusable, Vapi org-level)

Snapshot at `eric_project/vapi_config/schedule_callback.json`. Used when the participant says "not now, call me back later" at the start of any session — Session 1's consent step, or Session 2/3's "Is now still a good time to talk?" check. Server preserves the live `ACTIVE_SESSION` and `PRIOR_SESSIONS_CONTEXT` from the current call so the rescheduled call re-enters at the same session with the same prior context.
- Parameters: `suggestedTime` (required), `customerNumber` (optional — server uses call.customer.number; the model's value is ignored).
- Description explicitly forbids using it for next-session scheduling.
- `messages[0]`: `{type: "request-start", content: ""}` — empty content suppresses the model's filler.
- `messages[1]`: `{type: "request-complete", content: "Got it. I'll call you {{suggestedTime}}. Take care.", endCallAfterSpokenEnabled: true}` — Vapi speaks this verbatim and auto-ends. Wording is intentionally neutral (no "back") so it sounds correct even when the server intercept redirects this invocation to schedule_next_session.

### `report_wrong_number` tool (reusable, Vapi org-level)

Snapshot at `eric_project/vapi_config/report_wrong_number.json`. Used in Session 1's Step 0 identity-check flow when the third party who answered confirms this is NOT the right number for the intended participant. No parameters. `request-complete` content: `"Sorry to have bothered you. Goodbye."` with `endCallAfterSpokenEnabled: true`. Server-side handler sets `sessions.status='wrong_number'` for the participant's Session 1 row.

### `schedule_first_attempt` tool (reusable, Vapi org-level)

Snapshot at `eric_project/vapi_config/schedule_first_attempt.json`. Used in Session 1's Step 0 identity-check flow when the third party confirms it IS the right number but the participant is unavailable and a time has been agreed for trying again. Parameters: `suggestedTime` (required, concrete). Distinct from `schedule_callback` because the participant has NEVER been on the line yet — the rescheduled call must give them the full introduction. The server schedules the rescheduled call with `isCallback=false` (NOT true like `schedule_callback`) and `priorSessionsContext=""`, so the rescheduled call enters `session_1_initial_call_flow` and gives the full intro. Sets `sessions.status='rescheduled_unreached'`. `request-complete` content: `"OK, I will try again at the agreed time. Thank you. Goodbye."` with `endCallAfterSpokenEnabled: true`.

### `schedule_next_session` tool (reusable, Vapi org-level)

Snapshot at `eric_project/vapi_config/schedule_next_session.json`. Used at the end of Sessions 1 and 2 to schedule the next session in the multi-session study.
- Parameters: `suggestedTime` (required, must be a concrete time, not a question or placeholder).
- Description explicitly requires the model to wait for a concrete time from the participant before invoking — addresses the model's tendency to invoke prematurely with a clarifying question as the argument.
- `messages[0]`: `{type: "request-start", content: ""}` — suppresses filler.
- `messages[1]`: `{type: "request-complete", content: "Got it. I'll call you {{suggestedTime}} for our next conversation. Take care until then.", endCallAfterSpokenEnabled: true}` — Vapi speaks this verbatim and auto-ends.

### Per-call prompt assembly

The server reads `eric_project/prompts/Imani_system_prompt_phase1.xml` at call time and **strips opening flow blocks that don't match the active session/IS_CALLBACK combination** before sending the assembled prompt via `assistantOverrides.model.messages`. The model sees only the one opening flow it should use.

`loadPromptForCall({ isCallback, activeSession })` in server.js handles the stripping. Sessions 2 and 3 also strip `screening_logic` (per design — they skip screening). The strip regex is line-anchored (`^<tag>...^</tag>$` with `m` flag) because both flow blocks contain inline prose mentions of other flows' tag names that would otherwise be eaten by lazy matching.

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
- **Operator web dashboard at `/`.** Static HTML in `public/index.html` served by the same Render service. Table-based UI: each row is a call. Editable columns are Phone, Name, Schedule (datetime-local input — blank means dial immediately). Read-only columns are Scheduled-for, Session, Status (badge), and Notes (human-readable from `sessions.status`). Per-row actions: Call (POSTs to `/start-call`) and Delete (POSTs to `/scheduled-calls/:id` for server-backed rows, or removes the localStorage draft). Drafts live in browser localStorage (key `eric_draft_rows_v1`) until submitted. `/start-call` is protected by `X-API-Key` header (env var `START_CALL_API_KEY`); the dashboard prompts for the key once and stores it in localStorage. Scheduled times are interpreted in the participant's local timezone, inferred from the phone number's country code via `parseLocalDatetimeInTimezone` (independent of the host's local timezone — uses Intl.DateTimeFormat.formatToParts).
- **Read-back-and-confirm before scheduling.** Before invoking either `schedule_callback` or `schedule_next_session`, Imani must read the proposed time back to the participant ("So I will call you back tomorrow at 3pm, OK?") and wait for explicit confirmation. Specified in three prompt locations: `<session_1_initial_call_flow>` Step 2 callback sub-flow, `<session_1_callback_flow>` Step 3 reschedule branch (which references the Step 2 sub-flow), and the new top-level `<next_session_scheduling>` block (which governs end-of-session scheduling for Sessions 1 and 2). The block is not stripped by `loadPromptForCall` — it applies to every session. The tool's `request-complete` message remains the final goodbye that's spoken after Vapi receives the tool invocation.
- **Identity check at Session 1 start.** When `PARTICIPANT_NAME` is non-empty, Imani's first utterance is *"Hello, am I speaking with [full name]?"* — no introduction yet. Branches: (a) confirmed → full intro → consent → screening → interview; (b) not them, right number, person not available → ask better time → `schedule_first_attempt` → rescheduled call gets full intro (IS_CALLBACK=false); (c) not them, wrong number → `report_wrong_number` → call ends, marked as wrong number in Supabase. Third party asking "who are you / why?" gets a one-sentence honest answer about being a robot researcher and the participant having agreed to take part. `PARTICIPANT_NAME` arrives in **title + first + last** form (e.g., "Mr. Emeka Obi") and is used verbatim in greetings throughout the call. Sessions 2 and 3 greet by full name but skip the identity-check (participant already confirmed in Session 1). Operator dashboard input field hints at this format.
- **New `sessions.status` values.** In addition to `scheduled`, `in_progress`, `completed`: `wrong_number` (set by `report_wrong_number` tool), `rescheduled_unreached` (set by `schedule_first_attempt` tool — the participant has not yet been reached), and end-of-call-report-derived values from Vapi's `endedReason`: `no_answer`, `voicemail`, `invalid_number`, `no_engagement` (silence-timed-out), `completed_at_cap`, `busy`. `mapEndedReasonToStatus` does the mapping; `statusToNotesLabel` renders the dashboard Notes column. Tool-set terminal statuses (`wrong_number`, `rescheduled_unreached`) are not overwritten by the end-of-call-report handler.

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

## Phase 2 and Phase 3 Work (Deferred)

**Phase 2** — Wire up real summarisation and broader testing:
- Manually populate `sessions.prior_sessions_context` for testing (a human reads the call transcript and writes a summary). Currently it's always empty, so Sessions 2 and 3 work structurally but Imani has no actual prior content to bridge from.
- Add cross-call scheduling validation (Sessions 1 → 2 → 3 with real day-gap delays, not minute-gap testing)
- Real-participant testing with the strengthened milestones at full 45-min duration

**Phase 3** — Automated summarisation pipeline:
- LLM-based summary generation (Anthropic API call) triggered after each call ends
- Summary stored in `sessions.summary`
- Retrieved into `sessions.prior_sessions_context` for the next session
- Summarisation prompt to be designed; should match the prose style of `eric_project/prompts/session_1_and_2_summaries_reference.txt`

## Current Open Issues / Punch List

1. **Validate real-participant probing depth on a full 45-min call.** Short test calls (3-min) showed Imani being less probing than in sim. Likely artifact of time pressure + token budget; user has set `maxTokens=250`, `temperature=0.4` to match sim. Pending test result.
2. **If probing is still thin at 45 min**, the next suspects are the latency tweaks (`startSpeakingPlan.waitSeconds: 0.3`, `transcriber.maxDelay: 500`) — they were lowered for snappier conversation but may be reducing model deliberation time. Consider partial revert toward 0.5-0.8s.
3. **PRIOR_SESSIONS_CONTEXT is always empty.** Sessions 2 and 3 run the right opening protocols but with no actual prior-session content to bridge from. Imani occasionally hallucinates plausible-sounding prior content. Phase 2/3 work to populate this with real summaries.
4. **Vapi's "No result returned" error** appears in transcripts intermittently. Cause unknown; not prompt-fixable. Investigate Vapi-side.
5. **Stale QStash messages from prior server runs** occasionally fire and hit the timing handlers with dead callIds. Skipped silently via the in-memory tracking sets. Harmless log noise.
6. **Screening question priming.** Imani still occasionally improvises eligibility checks beyond `SCREENING_QUESTIONS_JSON` if the role/study_context blocks describe the target population. The role has been sanitized; `study_context` could also be sanitized if needed.
7. **Transcription accuracy** can drop on quiet/short answers (Deepgram flux-general-en). Has been observed transcribing innocuous answers as "Hang up", causing Imani to obey and end the call early. Worth re-evaluating transcriber config.
8. **Phase 2 / Phase 3 work** queued.

## Testing Approach

For prompt iteration, use the SIM personas in `eric_project/sim_prompts/`. Standard pattern:
1. Set Vapi prompt to the Imani prompt being tested
2. Set the SIM prompt as a separate Vapi assistant
3. Call one assistant with the other (agent-to-agent test)
4. Manually toggle `<active_session>` value and `<prior_sessions_context>` content for each session
5. Review transcript

For production code, real call testing via:
```powershell
.\scripts\start-call.ps1 +1NUMBER Name
.\scripts\inspect-db.ps1 sessions   # check the lifecycle
```

For staged short-cycle testing of timing: set `INTERVIEW_MAX_MINUTES=3, WRAPUP_OFFSET_MINUTES=1, FORCE_CLOSE_OFFSET_SECONDS=30` on Render. Whole close-out cycle plays in 3 minutes.
