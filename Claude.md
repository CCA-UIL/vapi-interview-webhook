# CLAUDE.md — Eric Voicebot Project

This document is the handoff context for an AI ethnographic interviewer project. It contains everything Claude Code needs to continue the work without re-litigating previous decisions.

## Project Overview

**Goal:** Build "Eric," a Vapi-based outbound voice AI that conducts ethnographic interviews with Nairobi residents who own Electric Pressure Cookers (EPCs). The research explores cultural, emotional, social, and economic dimensions of EPC adoption.

**Current state:** The interview prompt is iterated and tested across all three sessions in simulation. The architecture is solid. The next phase is adapting it to a production outbound-call system with persistent storage and per-participant scheduling.

**The user's preferences (apply throughout):**
- Direct, ruthlessly honest, no pleasantries
- Skip "I understand" / "That's interesting" / cushioning
- Challenge wrong assumptions immediately
- If unsure, say so. If you don't know, say "I don't know"
- Note explicit hypotheses at the end of substantive responses
- For graphics: only visualise data the user explicitly provides

## Architecture (As Designed)

The interview is structured as three separate ~45-minute calls, scheduled days or weeks apart:

- **Session 1 — Life and Cooking Context** (Phases 1-4): household, kitchen, cooking rhythm, cooking identity, gender roles
- **Session 2 — Cooking Technology and Meaning** (Phases 5-9): fuel/appliance history, EPC acquisition, EPC integration, community meaning, design feedback
- **Session 3 — Daily Life, Economics, Full Picture** (Phases 10-14): economics, daily rhythm, mealtime/hospitality, health/transmission, post-meal/close

Each session has phases. Each phase has milestones. Each milestone has an opening probe, optional follow-up probes, and an exit condition.

### Session Detection (Server-Driven, Not Inferred)

After many failed attempts at having Eric detect his session from context, the architecture moved to server-driven session assignment.

The system prompt contains:
- `<active_session>N</active_session>` at the top — value is 1, 2, or 3, set by the server at call start
- `<prior_sessions_context>` block — populated by the server with summary content from previous sessions (empty for Session 1, has Session 1 summary for Session 2, has both Session 1 and Session 2 summaries for Session 3)

Eric reads the `<active_session>` value and runs the corresponding session's phases. He reads the `<prior_sessions_context>` block as ground truth for prior conversations and uses it for thread weaving, cross-session contradiction checks, and warm bridges in the opening line.

**Critical lesson:** When summaries were placed inside other XML wrapper tags like `<session_1_summary>` and `<session_2_summary>`, they did not reach the model reliably through Vapi. Plain prose inside `<prior_sessions_context>` works. Do not re-introduce nested summary tags.

### The Strengthening Pattern (Probe Quality)

Several milestones across the three sessions have been "strengthened" — meaning they contain additional structure beyond the basic milestone format. The pattern that works:

1. **Opening probe** (basic open question)
2. **Anti-deflection rule** with named common deflection phrases that should trigger re-probe
3. **`do_not_settle_for`** explicit list of survey-level answer patterns
4. **`missing_piece_check`** — names the specific data pieces required, gives 1-3 probe options for each missing piece, caps at ONE missing-piece probe per call
5. **Tightened exit condition** that references the missing_piece_check
6. **Increased fallback budget** (4-5 turns instead of 3)

The strengthened milestones are: 1.3, 1.4, 4.1, 4.2, 5.3, 6.2, 6.3, 7.1, 7.3, 8.1, 9.1, 11.2, 12.1, 12.3, 13.2, 13.3, 14.3.

The unstrengthened milestones (1.1, 1.2, 2.1-2.4, 3.1-3.3, 4.3, 5.1-5.2, 6.1, 7.2, 8.2, 9.2-9.3, 10.1-10.3, 13.1, 14.1-14.2) consistently produce thin data with guarded participants. Strengthening any of them follows the same template above.

**Important:** Do not strengthen further milestones without first testing with real participants. The current strengthening produces noticeable interview-length increase with guarded SIMs. Real cooperative participants likely make this a non-issue, but we don't have that data yet.

### Other Key Prompt Blocks

- `<continuity_check>` — handles participants who reject prior conversation history. If a participant says "I don't remember talking to you before" in Session 2 or 3, Eric verifies once with a specific summary detail. If rejection holds, ends the call rather than restarting from Session 1.
- `<post_close_behaviour>` — hard rule that after the closing line, Eric only outputs minimal acknowledgments ("Take care," "Goodbye"). Prevents the methodology-monologue post-close drift.
- `<placeholder_handling>` — never read bracketed template placeholders like [the method they named] aloud.
- `<voice_and_manner>` — TTS-aware rules: no emojis, no markdown, no narration of internal reasoning.
- `<appliance_disambiguation_principle>` — for every cooking appliance the participant names, resolve both technology (heating mechanism) and fuel/power source. Six example probe patterns provided.
- `<pre_probe_checklist>` — five checks Eric runs before every probe (Redundancy, Attribution, Category-listing, Deflection, Ambiguity). Check 4 (Deflection) has been heavily strengthened.

## Repository Layout

The project files exist in two locations:

**Anthropic project files** (read-only references, in `/mnt/project/` if accessing from Claude environment):
- `Vapi_clone_system_prompt_30Mar26.txt` — early version of Eric's prompt, kept for reference. Do not use.
- `Agent_to_Agent_chat_March_2026_MS_feedback_0704.docx` — original feedback that informed the strengthening patterns. Reference document.

**Working files** (in `/mnt/user-data/outputs/` from prior session, copy these into your project):
- `Vapi_system_prompt_milestone.txt` — **THE CURRENT ERIC PROMPT.** Three sessions, 14 phases, 152KB. This is the prompt to adapt for production.
- `SIM_system_prompt_revised.txt` — Standard SIM persona for testing (solo mother of three, charcoal→EPC, jewelry sale, woodsmoke memory).
- `SIM_system_prompt_resistant.txt` — Harder SIM for stress testing.
- `SIM_system_prompt_mombasa.txt` — Alternative persona (woman with two daughters, husband in Mombasa, gas-primary, grandmother-taught).
- `SIM_system_prompt_session_3.txt` — Session 3-aware SIM (knows about prior sessions for testing).
- `session_1_and_2_summaries_for_session_3.txt` — Combined prior-session summaries used in Session 3 testing.

**Production code (existing, needs adaptation):**
- `Eric_Interview_Orchestrator_28Apr26.xml` — The CURRENT production prompt running on Vapi. This is a single-call orchestrator with timed phase transitions and screening. **Will be replaced by an adapted version of `Vapi_system_prompt_milestone.txt`.**
- `server_28Apr2026.js` — The CURRENT production server. Express, Render-hosted. Handles `/start-call`, `/vapi` webhook, `/timing/transition`. Will be substantially rewritten for the new architecture.

## What's Working in Production Right Now

The current production system (running on Render with the orchestrator prompt and `server_28Apr2026.js`):

- POST `/start-call` initiates an outbound Vapi call given a customer number and assistant ID
- Vapi calls back to `/vapi` with status-update, tool-calls, and end-of-call-report events
- QStash schedules timed phase transitions during the call (will be removed)
- Screening flow runs at call start (driven by `SCREENING_QUESTIONS_JSON` runtime variable)
- Three-strikes-and-out rule for screening
- Callback scheduling via `schedule_callback` tool with in-memory 1-hour dedup
- End-of-call data is processed
- Initiated from Postman by POSTing to `/start-call`

Environment variables on Render:
- `ASSISTANT_ID`
- `INTERVIEW_MAX_MINUTES`
- `INTERVIEW_PHASES_JSON`
- `QSTASH_TOKEN`
- `SCREENING_QUESTIONS_JSON` (currently `[{"id":1,"question":"Do you currently use a cookstove?","pass_answer":"yes"}]`)
- `VAPI_API_KEY`

## Phase 1 Work (To Be Done Next)

The work that's been scoped but not yet built:

### 1. Adapt Eric's Prompt (Session 1 Only Mode)

Take `Vapi_system_prompt_milestone.txt` and produce a production version that:

- Keeps the screening flow protocol from the current orchestrator (do not modify screening yet — user wants to keep it as-is for testing)
- Includes the session_assignment block but always passes Session 1 as the active session in MVP
- Has all 14 phases defined (so Sessions 2 and 3 are ready when Phase 2 work happens), but Session 1 is the only one called by the active_session value
- Adds a 43-minute wrap-up handling instruction (see Time Management below)
- All the strengthening, missing_piece_checks, voice rules, post_close_behaviour, etc. preserved
- Runtime variables interpolated by Vapi at call start:
  - `INTERVIEW_MAX_MINUTES` (kept)
  - `IS_CALLBACK` (kept)
  - `SCREENING_QUESTIONS_JSON` (kept)
  - `ACTIVE_SESSION` (new, value 1/2/3)
  - `PRIOR_SESSIONS_CONTEXT` (new, empty for Session 1)
  - Possibly `PARTICIPANT_NAME` — needs decision (see deferred questions below)

### 2. Rewrite the Server

Build a new `server.js` that:

- Keeps `/start-call` endpoint with similar interface
- Keeps `/vapi` webhook with status-update, tool-calls, end-of-call-report handlers
- **Removes** `/timing/transition` and the QStash phase-transition setup
- **Adds** a 43-minute soft-warning timer using QStash (server injects an add-message via Vapi telling Eric to wrap up)
- **Adds** a 45-minute hard-cap fail-safe using Vapi's call-end API
- Keeps callback scheduling with in-memory dedup (migration to database is Phase 2 work)
- Keeps `end_call`, `schedule_callback`, `evaluate_screening_response` tools (logic unchanged for MVP)
- Integrates with Supabase for participant tracking

User wants a clean rewrite (not minimal-change). Confirm with user before starting that this is still the preference.

### 3. Database Schema

User has been recommended Supabase free tier. They have not yet confirmed which database they're using. Confirm before writing schema.

Proposed schema:

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
  call_id TEXT,                    -- Vapi call ID
  status TEXT NOT NULL,            -- scheduled, in_progress, completed, failed, screened_out
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  summary TEXT,                    -- populated after call ends (Phase 3 work)
  prior_sessions_context TEXT,     -- populated before call from earlier sessions
  transcript JSONB,                -- full transcript stored from end-of-call-report
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(participant_id, session_number)
);

CREATE TABLE scheduled_calls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  participant_id UUID REFERENCES participants(id) NOT NULL,
  session_number INT NOT NULL CHECK (session_number IN (1, 2, 3)),
  scheduled_at TIMESTAMPTZ NOT NULL,
  vapi_call_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending, sent, completed, failed
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

### 4. Postman/curl Examples

- Initial call trigger
- Manually verifying database state
- Inspecting scheduled callbacks

## Time Management — 43 / 45 Minute Pattern

Replaces the timed-phase-transition mechanism. New approach:

- **Soft warning at 43 minutes** — server uses QStash to schedule a webhook fire 43 minutes after call start. Webhook injects an add-message via Vapi's API telling Eric: "We're at 43 minutes — please wrap up by asking your final question, delivering the closing line, and ending the call."
- **Hard cap at 45 minutes** — second QStash trigger 45 minutes after call start. If the call is still active when this fires, server calls Vapi's call-end API directly as a fail-safe.

Eric needs a corresponding instruction block in his prompt explaining what to do when he receives the wrap-up message — skip remaining milestones, deliver the open-ended close, then the closing line, then call `end_call`.

## Phase 2 and Phase 3 Work (Deferred)

Don't build these in Phase 1.

**Phase 2** — Add Sessions 2 and 3 with manual summarisation:
- Build the data model for tracking participant state
- Manually populate `prior_sessions_context` for testing (a human reads the call transcript and writes a summary)
- Add per-participant cross-session scheduling (server schedules Session 2 N days after Session 1 completes, and Session 3 M days after Session 2)
- Skip screening flow on Sessions 2 and 3

**Phase 3** — Automated summarisation pipeline:
- LLM-based summary generation (Anthropic API call) triggered after each call ends
- Summary stored in `sessions.summary`
- Retrieved into `sessions.prior_sessions_context` for the next session
- The summarisation prompt itself is yet to be designed — it needs to produce summaries in the same prose style as the existing manual summaries (see `session_1_and_2_summaries_for_session_3.txt` for reference)

## Deferred Questions Awaiting User Answers

These were asked at the end of the previous Claude session and not answered. Get them resolved before building:

- **Question A** — Single Render service or split orchestrator + summariser? Recommendation: single service for MVP. User to confirm.
- **Question B** — Participant names? Eric should be able to address by name if available. User to confirm whether `PARTICIPANT_NAME` becomes a runtime variable.
- **Question C** — Clean rewrite of server.js, or minimal-change? Recommendation: clean rewrite for production code. User to confirm.
- **Database choice** — Supabase recommended. User has not confirmed signup or alternate choice (Neon also acceptable).

## Known Vapi Quirks and Constraints

Hard-won knowledge from extensive debugging:

1. **Plain-prose context blocks reach the model. Wrapped XML summary tags do not.** Use `<prior_sessions_context>` with prose content inside, not nested `<session_X_summary>` tags.

2. **Vapi has no documented system prompt size limit, but 152KB worked in testing.** Don't grow significantly past current size without retesting.

3. **Vapi's "No result returned" error appears mid-transcript intermittently.** Cause unknown; appears to be a tool call returning null. Not prompt-fixable. Investigate Vapi-side.

4. **Vapi's call termination after Eric's closing line is unreliable.** The post_close_behaviour rule in the prompt mitigates but doesn't fully solve. The 45-minute hard cap fail-safe is partially compensating for this.

5. **Sonnet 4.6 is the current model.** Confirmed by user. Don't change without testing.

6. **Runtime variable interpolation in Vapi:** Variables in the system prompt are interpolated using `{{variable_name}}` syntax. Verify the exact syntax in the existing `Eric_Interview_Orchestrator_28Apr26.xml` file before writing the new prompt.

## Iteration History — Lessons Learned (Don't Repeat These)

These are mistakes made and corrected. Do not retread.

- **Inference-based session detection failed multiple times.** Switched to server-driven `<active_session>` value. Don't try to make the model infer session from context again.

- **Structural fixes proposed without empirical verification wasted multiple cycles.** When something fails, run a diagnostic test (e.g., the PURPLE ELEPHANT MARKER test that proved content placement issues) before proposing structural fixes. Always verify the prompt loaded in Vapi matches what was edited (paste back the first 200 characters as a check).

- **Strengthened milestones produce depth at cost of naturalness when participants are guarded.** The SIM is more guarded than real participants. Don't optimise heavily against SIM behaviour without real-participant data.

- **The 43/45-minute pattern came from rejecting "abrupt hang-up at 45 minutes" in favour of "soft warning then fail-safe." Keep this design.**

- **Earlier "Session 2 detection worked" reports were misleading** — Session 2 detection appeared to work because of fallback paths in the prompt, not because the summary was actually being read by Eric. Distinguish "appears to work" from "is verifiably working" by using diagnostic markers.

## Testing Approach

For prompt iteration, use the SIM personas in `/mnt/user-data/outputs/`. The standard testing pattern:

1. Set Vapi prompt to the Eric prompt being tested
2. Set the SIM prompt as a separate Vapi assistant
3. Call one assistant with the other (agent-to-agent test)
4. Manually toggle `<active_session>` value and `<prior_sessions_context>` content for each session
5. Review transcript

For production code, real call testing is the next step. SIM testing is at diminishing returns.

## Current Open Issues / Punch List

1. **Build Phase 1** (the work scoped above)
2. **Investigate Vapi "No result returned" error** — appears in transcripts, prompt-side fixes don't address it
3. **Investigate Vapi post-close termination** — call doesn't always end cleanly after closing line; 45-minute fail-safe mitigates
4. **Real-participant pilot** — system has been validated extensively in simulation. Real-call testing is needed before further prompt iteration.
5. **Phase 2 and Phase 3 work** queued behind Phase 1

## How to Proceed

When user gives permission to start Phase 1:

1. Confirm the four deferred questions (A, B, C, database)
2. Get the latest `Vapi_system_prompt_milestone.txt` (152KB version with all strengthening) from the user — it's not in this repo by default, ask them to paste or upload it
3. Get the existing `server_28Apr2026.js` from the user (uploaded in previous session)
4. Adapt the prompt for Session 1 production mode (preserves all 14 phases for future Phase 2 work)
5. Build the new server.js (clean rewrite assuming user confirms)
6. Set up Supabase schema
7. Provide deployment instructions for Render and Vapi
8. Provide Postman/curl examples for testing

Test in stages:
- First, an outbound call to user's own phone using the new prompt to verify Session 1 runs end-to-end
- Then, callback scheduling test
- Then, the 43-minute wrap-up trigger test (use a shorter time for testing)
- Then, full call with the 45-minute fail-safe