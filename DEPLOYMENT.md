# Deployment & Testing — Phase 1

Tactical reference for deploying the Phase 1 server and running tests against it.

## 1. Render service env vars

In **Render dashboard → your service → Environment**, set these (mirror `.env.example`):

| Var | Value |
| --- | --- |
| `VAPI_API_KEY` | from Vapi dashboard → Settings → API |
| `ASSISTANT_ID` | the production Eric assistant ID (set in Vapi dashboard) |
| `PHONE_NUMBER_ID` | the Vapi phone number ID — currently `6c89fc63-3d8d-4eca-98e9-ff9798ac5f9c` |
| `QSTASH_TOKEN` | from Upstash console → QStash → tokens |
| `RENDER_BASE_URL` | the public Render URL, e.g. `https://vapi-interview-webhook.onrender.com` |
| `INTERVIEW_MAX_MINUTES` | `45` (production) or `5`/`10` for short-cycle testing |
| `WRAPUP_OFFSET_MINUTES` | `2` (or `1` if testing with shorter `INTERVIEW_MAX_MINUTES`) |
| `SCREENING_QUESTIONS_JSON` | JSON array of `{id, question, pass_answer}` |
| `SUPABASE_URL` | from Supabase → Project Settings → API → Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | from Supabase → Project Settings → API → service_role secret |

Render build/start commands (already in `package.json`):

- Build: `npm install`
- Start: `npm start`

## 2. Vapi assistant configuration

In Vapi dashboard, configure the production Eric assistant:

- **System prompt**: paste the contents of `eric_project/prompts/Eric_system_prompt_phase1.xml`.
- **First message**: leave empty.
- **First message mode**: `assistant-speaks-first`.
- **Model**: `claude-sonnet-4-20250514` (or whichever Sonnet 4.x is current), temperature `0.4`.
- **Max tokens**: 200.
- **Max duration seconds**: 3727 (matches existing config; safety net beyond the server-side hard cap).
- **Voice**: Deepgram Asteria.
- **Transcriber**: Deepgram Flux (`flux-general-en`, `en`).
- **Tools**: keep `endCall` and `schedule_callback` enabled. Both are referenced by the prompt.

The runtime variables the prompt expects (server passes these in `assistantOverrides.variableValues`):

- `ACTIVE_SESSION` — `"1"` for MVP
- `PRIOR_SESSIONS_CONTEXT` — empty string for Session 1
- `INTERVIEW_MAX_MINUTES` — string of integer minutes
- `IS_CALLBACK` — `"true"` or `"false"`
- `SCREENING_QUESTIONS_JSON` — JSON array as string
- `PARTICIPANT_NAME` — first name or empty string

You don't need to declare these in the Vapi UI. Vapi accepts arbitrary `variableValues` at call-start.

## 3. Curl examples (replace placeholders with real values)

### Start a call

```bash
curl -X POST https://vapi-interview-webhook.onrender.com/start-call \
  -H "Content-Type: application/json" \
  -d '{
    "customerNumber": "+15551234567",
    "name": "Janet"
  }'
```

Response:

```json
{
  "ok": true,
  "callId": "019de012-...",
  "sessionId": "uuid-of-supabase-row",
  "participantId": "uuid-of-supabase-row",
  "status": "queued"
}
```

### Inspect Supabase state

```bash
# List participants
curl -s "$SUPABASE_URL/rest/v1/participants?select=*" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" | jq

# List sessions ordered by recency
curl -s "$SUPABASE_URL/rest/v1/sessions?select=*&order=created_at.desc" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" | jq

# List scheduled callbacks
curl -s "$SUPABASE_URL/rest/v1/scheduled_calls?select=*&order=scheduled_at.asc" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" | jq
```

(Or open Supabase → Table Editor → click each table.)

## 4. Test plan — staged

Run in order. Each stage gates the next.

1. **End-to-end Session 1 short call.** Set `INTERVIEW_MAX_MINUTES=5`, `WRAPUP_OFFSET_MINUTES=1`. Call your own phone via `/start-call`. Verify: introduction → consent → screening → opens Phase 1, Milestone 1.1. Hang up early. Confirm the `sessions` row has `status=in_progress` then `completed`, and the transcript is persisted.

2. **Callback scheduling.** Call your phone, decline ("not now, call me back in 5 minutes"). Verify Eric calls `schedule_callback`, then ends the call with the confirmation. Confirm a `scheduled_calls` row exists with `vapi_call_id` populated. Wait for the callback to fire on schedule.

3. **Wrap-up signal.** Set `INTERVIEW_MAX_MINUTES=5`, `WRAPUP_OFFSET_MINUTES=1`. Call. Stay on the line past the 4-minute mark. Verify Eric receives the wrap-up signal and runs the Session 1 close (open-ended close → closing line → endCall) before the 5-minute mark.

4. **Hard cap fail-safe.** Same env values as #3. Call. Talk past the 4-minute wrap-up. Refuse to let Eric close (keep talking). Verify the call ends at the 5-minute mark via the server's `/timing/hard-cap` route. Check Render logs for "Hard cap fired".

5. **Restore production timing.** `INTERVIEW_MAX_MINUTES=45`, `WRAPUP_OFFSET_MINUTES=2`. Run a real Session 1 call to a real participant.

## 5. Rollback

The previous server is preserved at `eric_project/server/server_28Apr2026.js`. To roll back:

```bash
cp eric_project/server/server_28Apr2026.js server.js
```

…and revert env vars accordingly. The Phase 1 prompt is at `eric_project/prompts/Eric_system_prompt_phase1.xml`; the previous orchestrator is at `eric_project/prompts/Eric_Interview_Orchestrator_28Apr26.xml`.
