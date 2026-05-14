# Vapi assistant — configuration notes

Notes about the Vapi assistant Imani runs on. Live values pulled from the Vapi API on **2026-05-14**. Update this file as you change settings; the `## Change log` section at the bottom is a place to record what you tried, why, and how it went.

Source of truth is the Vapi dashboard (and the running config there). This file is a human-readable companion — not auto-synced. The JSON snapshots of the reusable tools (`schedule_callback.json`, `schedule_next_session.json`) sit alongside this file.

## Current assistant config (as of 2026-05-14)

- **Name:** `Imani Interview Orchestrator-test calls`
- **ID:** `51e71a19-ba5c-484f-970d-55a0b39b8b0a`

### Model

| Field | Value |
| --- | --- |
| Provider | `anthropic` |
| Model | `claude-sonnet-4-20250514` |
| Temperature | `0.5` |
| Max tokens | `250` |
| Tool IDs | `1349e77b-...` (schedule_callback), `93497b3c-...` (schedule_next_session) |

_Notes:_

- _Why this model:_
- _Temperature history:_
- _maxTokens history:_

### Voice

#### Test voice (cheaper american voice)

| Field | Value |
| --- | --- |
| Provider | `vapi` |
| Voice ID | `Layla` |
| Speed | `1.1` |

#### Nigeria voice

| Provider | `11labs` |
| Voice ID | `EYQ7WzWOUhRLHwL7i08O` |
| Voice model | 'Eleven_flash_v2_5' |   a bit less latency than the 11labs multilngual v2
| Stability | `0.5` |
| Clarity + similarity | `0.8` |
| Speed | `1.1` |

11labs voices


Adeola **- a bit slow . intonations not natural.  a bit boring.
Olabisi - intonations not natural eOHsvebhdtt0XFeHVMQY
Bukola - robotic. 
Princess - very good but unnaturally short pauses between sentences. happy.  EYQ7WzWOUhRLHwL7i08O 
Taiwo- too serious
Bonnie - good but weird intonations. eSsKYR3BasKvhJghjsCX (high latency?)
Taiwo- sounds pretty natural but very monotonous and boring
Ayomide - does not sound happy.
Ololade - sounds pretty natural. a bit serious. sounds like she is reading.

Christiania - one of the best but intonations a bit weird sometimes. increase to 1.1
Kehinde- one of the best. a bit serious. increase to 1.1 gM1otA87NrAmOwyCoJE6


### Transcriber

### Test transcriber (cheaper)

| Field | Value |
| --- | --- |
| Provider | `deepgram` |
| Model | `flux-general-en` |
| Language | `en` |
| Confidence threshold | `0.4` |
| Wait seconds | '1.2' |
| Numerals | `false` (numbers spelled out) |

### Higher quality transcriber

| Provider | `deepgram` |
| Model | `nova-3-general` | via Composer (can't select it in the Dashboard)
| Language | `English` |
| Background Denoising | 'On' |
| Smart endpointing | 'Off'| have not tried this yet
| Confidence threshold | `` |
| Numerals | `` (numbers spelled out) |

speechmatics adds a lot of latency. 

### Call-flow / timing

### With Deepgram

| Field | Value |
| --- | --- |
| `firstMessageMode` | `assistant-speaks-first-with-model-generated-message` |
| `firstMessage` | (empty — model generates from system prompt) |
| `startSpeakingPlan.waitSeconds` | `0.3` |
| `stopSpeakingPlan.numWords` | `3` |
| `stopSpeakingPlan.voiceSeconds` | `0.3` |
| `silenceTimeoutSeconds` | (unset — Vapi default, ~30s) |
| `maxDurationSeconds` | `3727` (~62 min) |

### With Speechmatics

| `startSpeakingPlan.waitSeconds` | `1.4` |

_Notes:_

- _Why waitSeconds 0.3:_
- _Why this silence timeout:_

### Other

| Field | Value |
| --- | --- |
| `endCallFunctionEnabled` | `true` |
| `backgroundDenoisingEnabled` | `true` |
| `backgroundSound` | `off` |
| `serverMessages` | `function-call`, `tool-calls`, `status-update`, `hang`, `end-of-call-report`, `speech-update` |

`speech-update` is required for the wrap-up flow (server defers the soft-signal say until the participant's next turn ends — see CLAUDE.md).

## Change log

Add entries with date and rationale. Newest at the top.

- **2026-05-14** — File created. Captured live config above.

## How to refresh this snapshot

To pull current values from Vapi and compare against what's documented here:

```powershell
# In a terminal, from the repo root:
$env:VAPI_API_KEY = "your_key"
curl.exe -s -H "Authorization: Bearer $env:VAPI_API_KEY" "https://api.vapi.ai/assistant/<ASSISTANT_ID>" | ConvertFrom-Json | Select-Object name, id, model, voice, transcriber, firstMessageMode, startSpeakingPlan, stopSpeakingPlan, silenceTimeoutSeconds, maxDurationSeconds, serverMessages
```

Or ask Claude to fetch + diff.
