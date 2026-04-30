# Eric Voicebot Project

This is the working directory for the Eric ethnographic interviewer voicebot.

**Start here: `CLAUDE.md`** — this is the handoff document for Claude Code.
It contains everything needed to pick up the project, including project goal,
architecture, file layout, Phase 1 work scope, known issues, and lessons
learned.

## Directory Layout

```
.
├── CLAUDE.md                          # Read this first
├── README.md                          # This file
├── prompts/
│   ├── Vapi_system_prompt_milestone.txt          # CURRENT iterated Eric (3 sessions, 14 phases, 152KB)
│   ├── Eric_Interview_Orchestrator_28Apr26.xml   # CURRENT production prompt (single-call orchestrator)
│   └── session_1_and_2_summaries_reference.txt   # Sample summary format for Phase 3 work
├── sim_prompts/
│   ├── SIM_revised.txt                           # Standard SIM (solo mother, charcoal→EPC)
│   ├── SIM_resistant.txt                         # Harder SIM for stress testing
│   ├── SIM_mombasa.txt                           # Alternative persona (different background)
│   └── SIM_session_3.txt                         # Session 3-aware SIM (knows prior sessions)
├── server/
│   └── server_28Apr2026.js                       # CURRENT production server (Node/Express, Render-hosted)
└── reference/
    └── Cooking_in_Nairobi_interview_guide.docx   # Original research interview guide
```

## What's What

### `prompts/Vapi_system_prompt_milestone.txt`
This is the most important file. It's the iterated Eric prompt covering all
three sessions, with all the strengthening, missing_piece_checks, and probe
quality work that's been done. Phase 1 will adapt this for production deployment
with the screening flow integrated and Session 1 active.

### `prompts/Eric_Interview_Orchestrator_28Apr26.xml`
The current Eric prompt running in production. Single-call architecture with
timed phase transitions and screening. Reference only — this will be replaced.

### `server/server_28Apr2026.js`
The current production server. Reference only — Phase 1 is a clean rewrite.

### `sim_prompts/`
SIM personas used for agent-to-agent testing. Useful if Claude Code needs to
do further prompt validation. Phase 1 testing should focus on real-call
testing, not SIM testing.

### `reference/Cooking_in_Nairobi_interview_guide.docx`
The original research interview guide that drove the design of Eric's phases
and milestones. Reference document.

## Next Step

Open `CLAUDE.md` and proceed from the "How to Proceed" section.
