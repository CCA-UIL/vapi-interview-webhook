# Architecture — Phase 1

How the Eric voicebot stack fits together. Renders inline in VS Code's
markdown preview (open this file → click the preview icon top-right).

## Components

```mermaid
graph TB
    Op[Operator<br/>you]
    PS[PowerShell script<br/>start-call.ps1]
    SVR[Render service<br/>server.js Express app]
    SB[(Supabase<br/>participants<br/>sessions<br/>scheduled_calls)]
    V[Vapi API<br/>api.vapi.ai]
    A[Vapi assistant 'Eric'<br/>system prompt + Sonnet 4]
    Tw[Twilio<br/>internal to Vapi]
    Ph[Participant phone]
    Q[QStash / Upstash<br/>delayed webhook scheduler]

    Op -->|phone, name| PS
    PS -->|POST /start-call| SVR
    SVR <-->|upsert / read / update| SB
    SVR -->|POST /call<br/>+ variableValues| V
    V -->|outbound dial| Tw
    Tw -->|rings| Ph
    V <-->|loads prompt<br/>generates speech| A
    A <-->|voice| Ph
    V -->|webhook events:<br/>status-update<br/>tool-calls<br/>end-of-call-report| SVR
    SVR -->|publish delayed POSTs<br/>to /timing/* endpoints| Q
    Q -->|fires at 43m → /timing/wrap-up| SVR
    Q -->|fires at 45m → /timing/hard-cap| SVR
    SVR -->|inject add-message<br/>via controlUrl| V
    SVR -->|PATCH /call/:id status=ended| V
```

## Sequence 1 — starting a call

```mermaid
sequenceDiagram
    actor Op as Operator
    participant PS as start-call.ps1
    participant SVR as Render server
    participant SB as Supabase
    participant V as Vapi API
    participant A as Eric assistant
    participant Ph as Phone
    participant Q as QStash

    Op->>PS: phone, name
    PS->>SVR: POST /start-call<br/>{customerNumber, name}
    SVR->>SB: upsert participants by phone_number
    SB-->>SVR: participantId
    SVR->>SB: upsert sessions<br/>(participant_id, session_number=1,<br/>status='scheduled')
    SB-->>SVR: sessionId
    SVR->>V: POST /call<br/>{assistantId, phoneNumberId,<br/>customer.number,<br/>assistantOverrides.variableValues}
    V-->>SVR: {callId, status='queued'}
    SVR->>SB: update sessions.call_id
    SVR-->>PS: {callId, sessionId, participantId}
    V->>Ph: ringing
    Ph->>V: answer
    V->>A: load prompt<br/>interpolate {{ACTIVE_SESSION}}<br/>{{PRIOR_SESSIONS_CONTEXT}}<br/>{{PARTICIPANT_NAME}}<br/>{{INTERVIEW_MAX_MINUTES}}
    A->>Ph: introduction + consent
    V->>SVR: POST /vapi<br/>status-update: in-progress<br/>{callId, controlUrl}
    SVR->>SB: update sessions.status='in_progress', started_at
    SVR->>Q: schedule POST /timing/wrap-up<br/>at +43 min
    SVR->>Q: schedule POST /timing/hard-cap<br/>at +45 min
    Note over A,Ph: screening → Phase 1 milestones → ...
```

## Sequence 2 — wrap-up signal and close

```mermaid
sequenceDiagram
    participant Q as QStash
    participant SVR as Render server
    participant V as Vapi controlUrl
    participant A as Eric
    participant Ph as Phone
    participant SB as Supabase

    Note over Q: t = 43 min
    Q->>SVR: POST /timing/wrap-up<br/>{callId, controlUrl, content}
    SVR->>V: POST controlUrl<br/>{type: 'add-message',<br/>message: 'Wrap-up signal: ...'}
    A->>Ph: open-ended close question
    Ph->>A: final response
    A->>Ph: closing line
    A->>V: tool call: endCall
    V->>SVR: POST /vapi<br/>end-of-call-report<br/>{transcript, messages}
    SVR->>SB: update sessions<br/>status='completed', completed_at,<br/>transcript

    Note over Q: t = 45 min (fail-safe; only fires if call still live)
    Q->>SVR: POST /timing/hard-cap {callId}
    SVR->>V: PATCH /call/:id {status: 'ended'}
```

## Sequence 3 — callback scheduling

Triggered when the participant says "call me back at X" during the call.

```mermaid
sequenceDiagram
    participant A as Eric
    participant V as Vapi
    participant SVR as Render server
    participant SB as Supabase

    A->>V: tool-call: schedule_callback<br/>{customerNumber, suggestedTime}
    V->>SVR: POST /vapi<br/>tool-calls message
    SVR->>SVR: inferTimezone(phone)<br/>parseSuggestedTimeToLocalDate<br/>→ UTC ISO timestamp
    SVR->>V: POST /call<br/>{schedulePlan.earliestAt,<br/>variableValues.IS_CALLBACK='true'}
    V-->>SVR: {scheduledCallId}
    SVR->>SB: insert scheduled_calls<br/>(participant_id, scheduled_at,<br/>vapi_call_id, status='sent')
    SVR-->>V: tool result:<br/>"Confirm: I'll call you back ..."
    V->>A: tool result
    A->>Ph: confirmation sentence
    A->>V: tool call: endCall
```

## Runtime variables — what flows where

The server passes these into Vapi at call start via `assistantOverrides.variableValues`. Vapi makes them available to the assistant's system prompt by name, and substitutes `{{NAME}}` tokens inline.

| Variable | Source | Consumed by |
| --- | --- | --- |
| `ACTIVE_SESSION` | hard-coded `"1"` for MVP | prompt: `<active_session>{{ACTIVE_SESSION}}</active_session>` |
| `PRIOR_SESSIONS_CONTEXT` | server param (empty for Session 1) | prompt: `<prior_sessions_context>` block |
| `PARTICIPANT_NAME` | participants table or empty | prompt: openings, warm bridges |
| `INTERVIEW_MAX_MINUTES` | Render env (default 45) | prompt: `<time_management>`, intro |
| `IS_CALLBACK` | server (`"false"` for fresh, `"true"` for callbacks) | prompt: opening branch |
| `SCREENING_QUESTIONS_JSON` | Render env | prompt: `<screening_logic>` |

## Server-only env vars (never reach the model)

| Variable | Used by |
| --- | --- |
| `VAPI_API_KEY` | server.js → Vapi REST calls |
| `ASSISTANT_ID` | server.js → which Vapi assistant to dial with |
| `PHONE_NUMBER_ID` | server.js → which Vapi phone number to dial from |
| `QSTASH_TOKEN` | server.js → schedule delayed webhooks |
| `RENDER_BASE_URL` | server.js → callback URLs registered with QStash |
| `WRAPUP_OFFSET_MINUTES` | server.js → minutes before hard cap to fire wrap-up |
| `SUPABASE_URL` | server.js → Supabase REST |
| `SUPABASE_SERVICE_ROLE_KEY` | server.js → Supabase auth (bypasses RLS) |

## Data model

```mermaid
erDiagram
    participants ||--o{ sessions : has
    participants ||--o{ scheduled_calls : has
    participants {
        uuid id PK
        text phone_number UK
        text name
        bool screening_passed
        timestamptz created_at
    }
    sessions {
        uuid id PK
        uuid participant_id FK
        int session_number
        text call_id
        text status
        timestamptz started_at
        timestamptz completed_at
        text summary
        text prior_sessions_context
        jsonb transcript
    }
    scheduled_calls {
        uuid id PK
        uuid participant_id FK
        int session_number
        timestamptz scheduled_at
        text vapi_call_id
        text status
    }
```

`sessions` has `UNIQUE(participant_id, session_number)`. `createSessionRow` upserts on that key, so re-calling the same phone resets the row to a fresh `scheduled` state.
