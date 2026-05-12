# CLAUDE.md — Eric Voicebot Project

This document is the handoff context for an AI ethnographic interviewer project. It contains everything Claude Code needs to continue the work without re-litigating previous decisions.

## Project Overview

**Goal:** Build "Eric," a Vapi-based outbound voice AI that conducts ethnographic interviews with Nairobi residents who own Electric Pressure Cookers (EPCs). The research explores cultural, emotional, social, and economic dimensions of EPC adoption.

**Current state (2026-05-11):** Phase 1 is built and live. Eric runs Session 1 end-to-end against real phone numbers: introduction → consent → "is now a good time?" → screening → interview phases → soft wrap-up → forced closing line + auto-end. Callback scheduling works for both short (QStash) and long (Vapi schedulePlan) delays. Real-participant pilot with full 45-min calls is the next milestone.

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

Eric reads `<active_session>` and `<is_callback>` to pick his opening flow from a routing table in `<opening_flow_decision>` near the top of the prompt.

### Server-Side Prompt Assembly (Critical)

**The model proved unreliable at conditional routing between opening flow blocks.** When both `<session_1_initial_call_flow>` and `<session_1_callback_flow>` were present, even with `{{IS_CALLBACK}}` correctly substituted and an explicit routing table at the top, the model defaulted to whichever flow was more prescriptive (the initial flow) regardless of `IS_CALLBACK`.

**Solution:** server reads the prompt template from disk, strips the inappropriate opening flow block based on IS_CALLBACK, and sends the assembled prompt via `assistantOverrides.model.messages` on every call. The model only ever sees one opening flow.

Implications:
- The prompt template at `eric_project/prompts/Eric_system_prompt_phase1.xml` is the source of truth
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

**Real-participant probing depth is still being validated.** In short test calls (3-min), Eric was observed to be less probing than in sim. May be artifact of the test cap; full 45-min test pending.

### Other Key Prompt Blocks

- `<continuity_check>` — handles participants who reject prior conversation history
- `<post_close_behaviour>` — hard rule that after the closing line, Eric only outputs minimal acknowledgments
- `<placeholder_handling>` — never read bracketed template placeholders aloud
- `<voice_and_manner>` — TTS-aware rules: no emojis, no markdown, no narration of internal reasoning
- `<appliance_disambiguation_principle>` — for every cooking appliance the participant names, resolve both technology and fuel/power source
- `<pre_probe_checklist>` — five checks Eric runs before every probe (Redundancy, Attribution, Category-listing, Deflection, Ambiguity)
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
    │   ├── Eric_system_prompt_phase1.xml         # PRODUCTION PROMPT, source of truth, ~158KB
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
- `POST /vapi` — webhook. Handles `status-update` (start = schedule the three-stage close-out timers, end = mark session completed), `tool-calls` (`schedule_callback`), `end-of-call-report` (persist transcript, fallback callback parsing).
- `POST /timing/wrap-up` — soft signal, system message injection via controlUrl
- `POST /timing/force-close` — Vapi `{type:"say"}` force-speaks the closing line, `endCallAfterSpoken: true` auto-hangs up
- `POST /timing/hard-cap` — final fail-safe, Vapi `{type:"end-call"}` via controlUrl
- `POST /timing/fire-callback` — QStash trigger for short-fuse callbacks; dials Vapi immediately with no schedulePlan

### Prompt structure

The prompt at `eric_project/prompts/Eric_system_prompt_phase1.xml`:
- Top: `<active_session>{{ACTIVE_SESSION}}</active_session>` + `<is_callback>{{IS_CALLBACK}}</is_callback>` + `<opening_flow_decision>` table
- `<prior_sessions_context>{{PRIOR_SESSIONS_CONTEXT}}</prior_sessions_context>`
- `<role>` — sanitized of "Nairobi" / "EPC" specifics (those leaked into screening as supplemental questions)
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

Configured in `server.js`. Times relative to call start:
- **Soft signal** at T - `WRAPUP_OFFSET_MINUTES` (default 2): system message asks Eric to wrap after the participant's NEXT response. Inlines the verbatim closing sentence so no lookup needed.
- **Force close** at T - `FORCE_CLOSE_OFFSET_SECONDS` (default 30): if call still live, Vapi force-speaks the closing line and auto-hangs up. The model is bypassed entirely.
- **Hard cap** at T - `INTERVIEW_MAX_MINUTES`: final fail-safe, `endVapiCall` via controlUrl `{type:"end-call"}`.

The closing sentence is hardcoded in `server.js`: *"Well, that wraps up today's interview session. Thank you so much for everything you've shared today. When we speak next time, I'd like to hear about your experience with different cooking methods and your pressure cooker. Take care until then."* TODO: branch on ACTIVE_SESSION when Phase 2 wires Sessions 2/3.

### Callback scheduling — short-fuse vs long-fuse

When Eric invokes `schedule_callback`, the server splits behavior by delay:
- **Delay < `QSTASH_CALLBACK_THRESHOLD_MINUTES` (default 10)** → server schedules a QStash POST to `/timing/fire-callback` at the target time. That handler dials Vapi immediately with no schedulePlan. Avoids Vapi's multi-minute scheduler lead time on tight schedules ("in 1 minute" was empirically taking 5+ minutes via Vapi schedulePlan).
- **Delay ≥ threshold** → uses Vapi's native `schedulePlan.earliestAt`. Lead time is negligible relative to the wait.

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
| `ASSISTANT_ID` | The Eric assistant ID on Vapi |
| `PHONE_NUMBER_ID` | Vapi phone number resource ID |
| `QSTASH_TOKEN` | Upstash QStash token |
| `RENDER_BASE_URL` | Public Render URL, e.g. `https://vapi-interview-webhook.onrender.com` |
| `INTERVIEW_MAX_MINUTES` | 45 in production, 3-5 for short tests |
| `WRAPUP_OFFSET_MINUTES` | 2 in production |
| `FORCE_CLOSE_OFFSET_SECONDS` | 30 (default) |
| `QSTASH_CALLBACK_THRESHOLD_MINUTES` | 10 (default) |
| `SCREENING_QUESTIONS_JSON` | JSON array of `{id, question, pass_answer}` |
| `SUPABASE_URL` | Supabase project URL (no `/rest/v1` suffix) |
| `SUPABASE_SERVICE_ROLE_KEY` | Service-role JWT (server-side only, bypasses RLS) |

### Vapi assistant config (production)

- Model: `claude-sonnet-4-20250514`, `temperature: 0.4`, `maxTokens: 250` (matches sim parity)
- Voice: ElevenLabs (voice ID configured in dashboard)
- Transcriber: Speechmatics, `maxDelay: 500` (Speechmatics floor)
- `firstMessageMode: assistant-speaks-first-with-model-generated-message`, empty `firstMessage`
- `startSpeakingPlan.waitSeconds: 0.3`, `stopSpeakingPlan.numWords: 3, voiceSeconds: 0.3`
- `endCallFunctionEnabled: true`
- `model.toolIds: ["1349e77b-..."]` referencing the reusable `schedule_callback` tool

### `schedule_callback` tool (reusable, Vapi org-level)

Snapshot at `eric_project/vapi_config/schedule_callback.json`. Key fields:
- Parameters: `suggestedTime` (required, string), `customerNumber` (optional — server uses call.customer.number)
- `messages[0]`: `{type: "request-start", content: ""}` — empty content suppresses the model's "let me set that up" filler
- `messages[1]`: `{type: "request-complete", content: "Got it. I'll call you back {{suggestedTime}}. Take care.", endCallAfterSpokenEnabled: true}` — Vapi speaks this verbatim and auto-ends. The model is bypassed.

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
- **Forcing the assistant to speak:** `controlUrl` with `{type: "say", content: "...", endCallAfterSpoken: true}` makes Vapi speak the literal text and (optionally) hang up after. Bypasses the model entirely. Combined with the soft-signal-then-force-say staging, gives reliable wrap-ups.
- **Mid-conversation system messages are unreliable.** Adding a `{role: "system"}` message via `add-message` mid-call is hit-or-miss — the model often ignores it and continues its current behavior. For hard requirements, use `{type: "say"}` instead.
- **`endedReason: "assistant-ended-call-after-message-spoken"`** is what you see when `endCallAfterSpokenEnabled` triggers.

### Prompt construction

- **Server-side prompt assembly is more reliable than model-side conditional routing.** When the prompt has multiple opening flows and asks the model to pick by IS_CALLBACK, the model picks the most prescriptive option regardless. Strip the inappropriate block on the server, send the assembled prompt via `assistantOverrides.model.messages`.
- **Strip-regex must be line-anchored.** `^<tag>...^</tag>$` with `m` flag. Inline prose mentions of tag names ("see <session_1_callback_flow>") would otherwise be matched and the regex would lazily delete through to the actual closing tag of the wrong block.
- **Prompt size:** 158KB has worked. Anthropic Sonnet 4 handles this fine. Watch for impacts on first-token latency; not currently a problem.

### Other

- **Vapi assistant pre-config:** Vapi's `firstMessageMode: assistant-speaks-first` with empty `firstMessage` causes the assistant to wait silently. Use `assistant-speaks-first-with-model-generated-message` to have the model generate the first turn from the system prompt.
- **`schedule_callback`'s `customerNumber` argument is unreliable.** The model passes the literal `"{{customerNumber}}"` placeholder string, or no value, or a malformed phone. Server takes `customerNumber` from `message.call.customer.number` (guaranteed E.164) and ignores the model's value.

## Resolved Decisions

- **Single Render service** for MVP. Don't split into orchestrator + summariser.
- **Participant names will be used.** `PARTICIPANT_NAME` is a runtime variable. Eric addresses the participant by name when available.
- **Database: Supabase free tier.** Schema as above. RLS enabled with no policies.
- **Server-side prompt assembly per call** for opening-flow routing, not model-side conditional logic.
- **Three-stage close-out** (soft → force-say → hard cap) instead of a single force action.
- **QStash short-fuse routing** for callbacks under threshold; Vapi schedulePlan for longer.
- **`schedule_callback` is a reusable Vapi tool** (in dashboard Tools list), referenced by `toolIds` on the assistant.
- **Tool result text is spoken by Vapi via `request-complete` + `endCallAfterSpoken`**, not by the model.

## Iteration History — Lessons Learned (Don't Repeat These)

- **Inference-based session detection failed multiple times.** Switched to server-driven `<active_session>` value plus server-side prompt assembly. Don't try model-side conditional routing again.
- **Don't quote a trigger phrase inside a prohibition.** Telling the model "don't ask about Nairobi residents who own EPCs" made it ask about exactly that. Frame rules positively. Describe categories abstractly. Pink-elephant trap. (Saved as feedback memory.)
- **Don't over-extrapolate from one diagnostic.** A test that proves one mechanism doesn't disprove others. Confirm with the user before declaring their existing code broken. (Saved as feedback memory.)
- **Anchor regex to top-level tags when stripping prompt blocks.** Both opening flows reference each other's tag names in their prose. Unanchored regex catastrophically eats the wrong block.
- **The model unreliably honors mid-conversation system messages.** Don't rely on inject-and-comply for hard requirements (wrap-ups, end-call). Use Vapi's `{type:"say"}` to bypass the model.
- **Soft signal → force-say staging beats single force action.** Single force-say barges in mid-question. Two-stage gives Eric a chance to wrap up at the next natural turn boundary, with force as fail-safe.
- **Strengthened milestones produce depth at cost of naturalness when participants are guarded.** Real-participant data still needed to validate.
- **The 43/45-minute pattern came from rejecting "abrupt hang-up at 45 minutes" in favour of "soft warning then fail-safe." Now staged into three.**
- **Earlier "Session 2 detection worked" reports were misleading** — appeared to work because of fallback paths in the prompt, not because the summary was actually being read by Eric. Use diagnostic markers to distinguish "appears to work" from "is verifiably working."

## Phase 2 and Phase 3 Work (Deferred)

**Phase 2** — Add Sessions 2 and 3 with manual summarisation:
- Manually populate `sessions.prior_sessions_context` for testing (a human reads the call transcript and writes a summary)
- Add per-participant cross-session scheduling (Session 2 N days after Session 1 completes, Session 3 M days after Session 2)
- Skip screening flow on Sessions 2 and 3 (already wired in prompt; needs server side)
- Branch the closing line in `server.js` on ACTIVE_SESSION (currently hardcoded to Session 1)
- Validate session_2 and session_3 opening protocols on real callbacks

**Phase 3** — Automated summarisation pipeline:
- LLM-based summary generation (Anthropic API call) triggered after each call ends
- Summary stored in `sessions.summary`
- Retrieved into `sessions.prior_sessions_context` for the next session
- Summarisation prompt to be designed; should match the prose style of `eric_project/prompts/session_1_and_2_summaries_reference.txt`

## Current Open Issues / Punch List

1. **Validate real-participant probing depth on a full 45-min call.** Short test calls (3-min) showed Eric being less probing than in sim. Likely artifact of time pressure + token budget; user has set `maxTokens=250`, `temperature=0.4` to match sim. Pending test result.
2. **If probing is still thin at 45 min**, the next suspects are the latency tweaks (`startSpeakingPlan.waitSeconds: 0.3`, `transcriber.maxDelay: 500`) — they were lowered for snappier conversation but may be reducing model deliberation time. Consider partial revert toward 0.5-0.8s.
3. **Vapi's "No result returned" error** appears in transcripts intermittently. Cause unknown; not prompt-fixable. Investigate Vapi-side.
4. **Stale QStash messages from prior server runs** occasionally fire and hit the timing handlers with dead callIds. Skipped silently via `timersScheduledForCallId` in-memory check. Annoying log noise but harmless.
5. **Screening question priming.** Eric still occasionally improvises eligibility checks beyond `SCREENING_QUESTIONS_JSON` if the role/study_context blocks describe the target population. The role has been sanitized; `study_context` could also be sanitized if needed.
6. **Phase 2 / Phase 3 work** queued.

## Testing Approach

For prompt iteration, use the SIM personas in `eric_project/sim_prompts/`. Standard pattern:
1. Set Vapi prompt to the Eric prompt being tested
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
