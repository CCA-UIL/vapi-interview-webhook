import express from "express";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";
import { parsePhoneNumberFromString } from "libphonenumber-js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
// Vapi webhook bodies include the assistant config (system prompt + tools)
// plus the running transcript, so payloads can easily exceed Express's
// default 100kb limit. Bumping to 10mb to comfortably absorb that.
app.use(express.json({ limit: "10mb" }));

// Serve the operator web form (public/index.html) at the root URL. Anyone
// with the form's URL can OPEN it; the actual /start-call submission
// requires the X-API-Key header.
app.use(express.static(path.join(__dirname, "public")));

// =============================================================================
// Environment
// =============================================================================

const VAPI_API_KEY = process.env.VAPI_API_KEY;
const ASSISTANT_ID = process.env.ASSISTANT_ID;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const QSTASH_TOKEN = process.env.QSTASH_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RENDER_BASE_URL = process.env.RENDER_BASE_URL;
const INTERVIEW_MAX_MINUTES = parseInt(process.env.INTERVIEW_MAX_MINUTES || "45", 10);
const SCREENING_QUESTIONS_JSON = process.env.SCREENING_QUESTIONS_JSON || "[]";
const WRAPUP_OFFSET_MINUTES = parseInt(process.env.WRAPUP_OFFSET_MINUTES || "2", 10);
const START_CALL_API_KEY = process.env.START_CALL_API_KEY;
if (!START_CALL_API_KEY) {
  console.warn("WARNING: START_CALL_API_KEY not set — /start-call is UNAUTHENTICATED. Anyone with the URL can trigger calls and burn Vapi credits.");
}

const requiredEnv = {
  VAPI_API_KEY,
  ASSISTANT_ID,
  PHONE_NUMBER_ID,
  QSTASH_TOKEN,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  RENDER_BASE_URL
};
for (const [k, v] of Object.entries(requiredEnv)) {
  if (!v) console.warn(`WARNING: env var ${k} is not set`);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});

// =============================================================================
// Constants and helpers
// =============================================================================

const ccToTz = {
  "+1": "America/New_York",
  "+254": "Africa/Nairobi",
  "+256": "Africa/Kampala",
  "+255": "Africa/Dar_es_Salaam",
  "+234": "Africa/Lagos",
  "+233": "Africa/Accra",
  "+27": "Africa/Johannesburg",
  "+44": "Europe/London",
  "+91": "Asia/Kolkata",
  "+33": "Europe/Paris"
};

function inferTimezone(number = "") {
  const codes = Object.keys(ccToTz).sort((a, b) => b.length - a.length);
  for (const c of codes) if (number.startsWith(c)) return ccToTz[c];
  return "UTC";
}

// Map ISO 3166-1 alpha-2 country codes to English country names for the
// major African Anglophone countries we care about. For others, the
// caller falls back to returning the ISO code itself.
const ISO_TO_COUNTRY_NAME = {
  KE: "Kenya",
  NG: "Nigeria",
  GH: "Ghana",
  TZ: "Tanzania",
  UG: "Uganda",
  ZA: "South Africa",
  RW: "Rwanda",
  ET: "Ethiopia",
  // Commonly-tested non-African destinations
  US: "United States",
  GB: "United Kingdom",
  CA: "Canada"
};

/**
 * Infer the participant's country from their phone number using
 * libphonenumber-js. Returns a country name string (e.g. "Kenya") or an
 * empty string if the number can't be parsed.
 *
 * Edge cases handled:
 *  - Malformed / unparseable numbers → "" + warning logged
 *  - Country we don't have a name mapping for → returns the ISO alpha-2
 *    code itself (e.g. "BF") as documented MVP fallback
 *  - VoIP / geographically-ambiguous numbers → returns whatever the
 *    library reports; acceptable for MVP
 */
function inferCountryFromPhone(phoneNumber) {
  if (!phoneNumber) {
    console.warn("inferCountryFromPhone: empty phone number");
    return "";
  }
  try {
    const parsed = parsePhoneNumberFromString(phoneNumber);
    if (!parsed || !parsed.country) {
      console.warn("inferCountryFromPhone: could not parse country from number", { phoneNumber });
      return "";
    }
    return ISO_TO_COUNTRY_NAME[parsed.country] || parsed.country;
  } catch (e) {
    console.warn("inferCountryFromPhone: parse error", { phoneNumber, error: String(e) });
    return "";
  }
}

const WORD_NUMBERS = {
  one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30,
  forty: 40, fifty: 50, sixty: 60, ninety: 90, "a": 1, "an": 1
};

function wordToNumber(word) {
  return WORD_NUMBERS[word.toLowerCase()] ?? null;
}

function parseSuggestedTimeToLocalDate({ suggestedTimeText, timezone }) {
  if (!suggestedTimeText) return null;
  const nowUtc = new Date();
  const localNow = new Date(nowUtc.toLocaleString("en-US", { timeZone: timezone }));
  let targetLocal = new Date(localNow);
  const lower = suggestedTimeText.toLowerCase();

  // "Immediately" / "right now" / synonyms — treat as 1 minute. The prompt
  // is supposed to translate these to "in 1 minute" before invoking the
  // tool, but the model sometimes passes the literal vague phrase. Map
  // here so the tool still schedules a sensible callback instead of
  // falling back to a 3-day or 5-minute default.
  if (/\b(immediately|right\s+now|right\s+away|asap|a\s*s\s*a\s*p)\b/.test(lower)) {
    targetLocal.setTime(targetLocal.getTime() + 60 * 1000);
    return { targetLocal, localNow, nowUtc };
  }

  // Track whether any day-shift pattern matched. If a day-shift matched but
  // no specific time-of-day pattern follows (e.g., "tomorrow at this same
  // time" or "in 3 days at this same time"), fall through to a
  // current-time-of-day return at the end.
  let dayShifted = false;

  if (/\btomorrow\b/.test(lower)) {
    targetLocal.setDate(targetLocal.getDate() + 1);
    dayShifted = true;
  }

  // "in N days" — digit or word
  const inDaysDigit = lower.match(/\bin\s+(\d+)\s*day(s)?\b/);
  const inDaysWord  = lower.match(/\bin\s+(a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fourteen|fifteen|twenty|thirty)\s*day(s)?\b/);
  const inDaysValue = inDaysDigit
    ? parseInt(inDaysDigit[1], 10)
    : (inDaysWord ? wordToNumber(inDaysWord[1]) : null);
  if (inDaysValue) {
    targetLocal.setDate(targetLocal.getDate() + inDaysValue);
    dayShifted = true;
  }

  // "in X minutes" — accept digits OR word-form numbers ("one", "two", ...)
  const inMinDigit = lower.match(/\bin\s+(\d+)\s*minute(s)?\b/);
  const inMinWord  = lower.match(/\bin\s+(a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty|ninety)\s*minute(s)?\b/);
  const inMinValue = inMinDigit
    ? parseInt(inMinDigit[1], 10)
    : (inMinWord ? wordToNumber(inMinWord[1]) : null);
  if (inMinValue) {
    // Add minutes to the current time WITHOUT rounding seconds — rounding
    // down to the start of the minute eats up to 59 seconds of the
    // requested delay (so "in 1 minute" became "in ~30 seconds on average").
    targetLocal.setTime(targetLocal.getTime() + inMinValue * 60 * 1000);
    return { targetLocal, localNow, nowUtc };
  }

  // "in X hours" — same word/digit handling
  const inHrDigit = lower.match(/\bin\s+(\d+)\s*hour(s)?\b/);
  const inHrWord  = lower.match(/\bin\s+(a|an|one|two|three|four|five|six|seven|eight|nine|ten|twelve)\s*hour(s)?\b/);
  const inHrValue = inHrDigit
    ? parseInt(inHrDigit[1], 10)
    : (inHrWord ? wordToNumber(inHrWord[1]) : null);
  if (inHrValue) {
    targetLocal.setTime(targetLocal.getTime() + inHrValue * 60 * 60 * 1000);
    return { targetLocal, localNow, nowUtc };
  }

  const hm24 = lower.match(/\b(at\s*)?(\d{1,2}):(\d{2})\b/);
  if (hm24) {
    targetLocal.setHours(parseInt(hm24[2], 10), parseInt(hm24[3], 10), 0, 0);
    if (targetLocal.getTime() <= localNow.getTime()) targetLocal.setDate(targetLocal.getDate() + 1);
    return { targetLocal, localNow, nowUtc };
  }

  const ampm = lower.match(/\b(at\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/);
  if (ampm) {
    let h = parseInt(ampm[2], 10);
    const m = ampm[3] ? parseInt(ampm[3], 10) : 0;
    if (ampm[4] === "pm" && h !== 12) h += 12;
    if (ampm[4] === "am" && h === 12) h = 0;
    targetLocal.setHours(h, m, 0, 0);
    if (targetLocal.getTime() <= localNow.getTime()) targetLocal.setDate(targetLocal.getDate() + 1);
    return { targetLocal, localNow, nowUtc };
  }

  const mins = lower.match(/(\d+)\s*minute(s)?\b/);
  if (mins) {
    targetLocal.setMinutes(targetLocal.getMinutes() + parseInt(mins[1], 10));
    targetLocal.setSeconds(0, 0);
    return { targetLocal, localNow, nowUtc };
  }

  // Day-shifted with no time-of-day — interpret as "this same time" on the
  // shifted day. Covers "tomorrow", "tomorrow at this same time", "in 3
  // days", "in three days at this same time", etc.
  if (dayShifted) {
    return { targetLocal, localNow, nowUtc };
  }

  return null;
}

function extractSuggestedTimeFromTranscript(transcript = "") {
  const text = transcript.replace(/\s+/g, " ").trim();
  if (!text) return null;
  const patterns = [
    /\b(call me back|callback|call me|reach me)\b[^.?!]*?(\btomorrow\b[^.?!]*|\bin\s+\d+\s*minute[s]?\b[^.?!]*|\bat\s+\d{1,2}(:\d{2})?\s*(am|pm)\b[^.?!]*|\b\d{1,2}:\d{2}\b[^.?!]*)/i,
    /(\btomorrow\b[^.?!]*|\bin\s+\d+\s*minute[s]?\b[^.?!]*|\bat\s+\d{1,2}(:\d{2})?\s*(am|pm)\b[^.?!]*|\b\d{1,2}:\d{2}\b[^.?!]*)/i
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return (m[2] || m[1] || "").trim();
  }
  return null;
}

const scheduledByKey = new Map();
function markScheduled(key) { if (key) scheduledByKey.set(key, Date.now()); }
function wasScheduled(key) {
  if (!key) return false;
  const ts = scheduledByKey.get(key);
  if (!ts) return false;
  if (Date.now() - ts > 60 * 60 * 1000) { scheduledByKey.delete(key); return false; }
  return true;
}

const timersScheduledForCallId = new Set();

// Wrap-up signals queued, waiting for the participant to finish their current
// turn before being spoken. Keyed by callId. Cleared once spoken or when the
// call ends.
const pendingWrapUpByCallId = new Map();

// Calls that have entered (or passed) the wrap-up phase. Used to redirect
// schedule_callback invocations that happen in the closing window — the model
// stubbornly picks schedule_callback over schedule_next_session for
// short-fuse times like "in one minute" no matter how clear the tool
// descriptions are. Server-side intercept compensates.
const inWrapUpPhaseForCallId = new Set();

// =============================================================================
// Supabase data layer
// =============================================================================

async function upsertParticipant({ phoneNumber, name }) {
  const { data, error } = await supabase
    .from("participants")
    .upsert({ phone_number: phoneNumber, name: name || null }, { onConflict: "phone_number" })
    .select()
    .single();
  if (error) throw new Error(`upsertParticipant failed: ${error.message}`);
  return data;
}

async function createSessionRow({ participantId, sessionNumber, priorSessionsContext }) {
  // Upsert resets the row on each /start-call. The UNIQUE(participant_id,
  // session_number) constraint means production has at most one row per
  // session, but during testing we re-call the same phone repeatedly and
  // need to start fresh each time.
  const { data, error } = await supabase
    .from("sessions")
    .upsert({
      participant_id: participantId,
      session_number: sessionNumber,
      status: "scheduled",
      prior_sessions_context: priorSessionsContext || null,
      call_id: null,
      started_at: null,
      completed_at: null,
      transcript: null,
      summary: null
    }, { onConflict: "participant_id,session_number" })
    .select()
    .single();
  if (error) throw new Error(`createSessionRow failed: ${error.message}`);
  return data;
}

async function setSessionCallId(sessionId, callId) {
  const { error } = await supabase
    .from("sessions")
    .update({ call_id: callId })
    .eq("id", sessionId);
  if (error) console.error("setSessionCallId failed:", error.message);
}

async function updateSessionByCallId(callId, updates) {
  if (!callId) return;
  const { error } = await supabase
    .from("sessions")
    .update(updates)
    .eq("call_id", callId);
  if (error) console.error("updateSessionByCallId failed:", error.message);
}

async function recordScheduledCall({ participantId, sessionNumber, scheduledAt, vapiCallId }) {
  const { error } = await supabase
    .from("scheduled_calls")
    .insert({
      participant_id: participantId,
      session_number: sessionNumber,
      scheduled_at: scheduledAt,
      vapi_call_id: vapiCallId,
      status: "sent"
    });
  if (error) console.error("recordScheduledCall failed:", error.message);
}

// =============================================================================
// Vapi API wrappers
// =============================================================================

async function vapiPost(path, body) {
  const resp = await fetch(`https://api.vapi.ai${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${VAPI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  const result = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`Vapi POST ${path} ${resp.status}: ${JSON.stringify(result)}`);
  return result;
}

// Fetch the live assistant config from Vapi and log a snapshot of the
// fields most relevant to per-call performance: transcriber, voice, model,
// and the timing/silence settings. Logged once per /start-call so future
// log review can pair a callId with the exact config that was active.
async function logCallConfigSnapshot(callId, assistantId) {
  if (!callId || !assistantId) return;
  try {
    const resp = await fetch(`https://api.vapi.ai/assistant/${assistantId}`, {
      headers: { Authorization: `Bearer ${VAPI_API_KEY}` }
    });
    if (!resp.ok) {
      console.warn("logCallConfigSnapshot: assistant fetch failed", resp.status);
      return;
    }
    const a = await resp.json();
    console.log("Call config snapshot:", JSON.stringify({
      callId,
      transcriber: {
        provider: a.transcriber?.provider,
        model: a.transcriber?.model,
        language: a.transcriber?.language,
        maxDelay: a.transcriber?.maxDelay,
        confidenceThreshold: a.transcriber?.confidenceThreshold
      },
      voice: {
        provider: a.voice?.provider,
        voiceId: a.voice?.voiceId,
        model: a.voice?.model,
        speed: a.voice?.speed
      },
      model: {
        provider: a.model?.provider,
        model: a.model?.model,
        temperature: a.model?.temperature,
        maxTokens: a.model?.maxTokens
      },
      startSpeakingPlan: a.startSpeakingPlan,
      stopSpeakingPlan: a.stopSpeakingPlan,
      silenceTimeoutSeconds: a.silenceTimeoutSeconds,
      backgroundDenoisingEnabled: a.backgroundDenoisingEnabled
    }));
  } catch (e) {
    console.warn("logCallConfigSnapshot threw:", e.message);
  }
}

// =============================================================================
// Prompt assembly
// =============================================================================
//
// The model unreliably routes between session_1_initial_call_flow and
// session_1_callback_flow when both are present in the prompt — it tends
// to default to the more prescriptive initial flow regardless of
// {{IS_CALLBACK}}. To remove the choice, we strip the irrelevant block
// from the prompt before sending it to Vapi via assistantOverrides.

const PROMPT_PATH = path.join(
  __dirname,
  "eric_project",
  "prompts",
  "Imani_system_prompt_phase1.xml"
);

function loadPromptForCall({ isCallback, activeSession = 1, hasName = false }) {
  let prompt = fs.readFileSync(PROMPT_PATH, "utf8");
  // Regex must anchor to top-level tags (column 0). Both flow blocks
  // contain inline prose references to other flows' tag names (e.g.,
  // session_1_initial_call_flow's description mentions
  // "<session_1_callback_flow>"), and an unanchored regex would lazily
  // match from those inline mentions through the end of the actual block,
  // wiping content unintentionally.
  const stripBlock = (tag, reason) => {
    const re = new RegExp(`^<${tag}>[\\s\\S]*?^</${tag}>$`, "m");
    prompt = prompt.replace(
      re,
      `<${tag}>(omitted: ${reason})</${tag}>`
    );
  };

  // The step_0_identity_check block lives INSIDE session_1_initial_call_flow,
  // but its open and close tags are line-anchored at the leading whitespace
  // they were authored with. Anchor with optional leading whitespace.
  const stripNestedBlock = (tag, reason) => {
    const re = new RegExp(`^\\s*<${tag}>[\\s\\S]*?^\\s*</${tag}>\\s*$`, "m");
    prompt = prompt.replace(re, `<${tag}>(omitted: ${reason})</${tag}>`);
  };

  if (!hasName) {
    stripNestedBlock("step_0_identity_check", "no participant name provided");
  }

  if (activeSession === 1) {
    // Session 1: choose initial vs callback based on IS_CALLBACK.
    if (isCallback) {
      stripBlock("session_1_initial_call_flow", "this call is a Session 1 callback");
    } else {
      stripBlock("session_1_callback_flow", "this call is the initial Session 1 contact");
    }
    // Session 2 and 3 opening protocols are not used in Session 1.
    stripBlock("session_2_opening_protocol", "this is Session 1");
    stripBlock("session_3_opening_protocol", "this is Session 1");
  } else if (activeSession === 2) {
    // Session 2: strip both Session 1 flows and Session 3 protocol.
    // Also strip screening_logic — Sessions 2/3 skip screening per design.
    stripBlock("session_1_initial_call_flow", "this is Session 2, not Session 1");
    stripBlock("session_1_callback_flow", "this is Session 2, not Session 1");
    stripBlock("session_3_opening_protocol", "this is Session 2, not Session 3");
    stripBlock("screening_logic", "Sessions 2 and 3 skip screening");
  } else if (activeSession === 3) {
    stripBlock("session_1_initial_call_flow", "this is Session 3");
    stripBlock("session_1_callback_flow", "this is Session 3");
    stripBlock("session_2_opening_protocol", "this is Session 3, not Session 2");
    stripBlock("screening_logic", "Sessions 2 and 3 skip screening");
  }
  return prompt;
}

// Vapi requires the FULL model object when overriding via assistantOverrides
// — partial overrides are rejected (e.g., {model: {messages: [...]}} returns
// 400 "model.provider must be one of..."). To avoid duplicating the
// assistant's model config (provider, model name, temperature, maxTokens,
// toolIds) in this file, we lazily fetch it once and cache the non-messages
// fields. Cache survives the server lifetime; restart picks up changes.
let cachedModelTemplate = null;
async function getModelTemplate() {
  if (cachedModelTemplate) return cachedModelTemplate;
  const resp = await fetch(`https://api.vapi.ai/assistant/${ASSISTANT_ID}`, {
    headers: { Authorization: `Bearer ${VAPI_API_KEY}` }
  });
  if (!resp.ok) {
    throw new Error(`getModelTemplate: GET /assistant/${ASSISTANT_ID} ${resp.status}`);
  }
  const data = await resp.json();
  const { messages, ...rest } = data.model || {};
  cachedModelTemplate = rest;
  console.log("Cached assistant model template:", Object.keys(cachedModelTemplate).join(", "));
  return cachedModelTemplate;
}

async function buildModelOverride({ isCallback, activeSession = 1, hasName = false }) {
  const template = await getModelTemplate();
  return {
    ...template,
    messages: [{ role: "system", content: loadPromptForCall({ isCallback, activeSession, hasName }) }]
  };
}

async function startVapiCall({ assistantId, customerNumber, variableValues }) {
  const isCallback = variableValues?.IS_CALLBACK === "true";
  const activeSession = parseInt(variableValues?.ACTIVE_SESSION || "1", 10);
  const hasName = Boolean((variableValues?.PARTICIPANT_NAME || "").trim());
  return vapiPost("/call", {
    assistantId,
    phoneNumberId: PHONE_NUMBER_ID,
    customer: { number: customerNumber },
    assistantOverrides: {
      variableValues,
      model: await buildModelOverride({ isCallback, activeSession, hasName })
    }
  });
}

// Short callbacks (under this many minutes) get routed through QStash:
// QStash holds the request, then fires our /timing/fire-callback handler
// which dials Vapi immediately. This avoids Vapi's multi-minute scheduler
// lead time, which empirically delays "in 1 minute" callbacks by 5+ min.
// Longer callbacks fall through to Vapi's native schedulePlan.
const QSTASH_CALLBACK_THRESHOLD_MINUTES = parseInt(process.env.QSTASH_CALLBACK_THRESHOLD_MINUTES || "10", 10);

async function scheduleVapiCallback({ assistantId, customerNumber, earliestAtIso, variableValues }) {
  // Honor whatever IS_CALLBACK and ACTIVE_SESSION the caller supplied via
  // variableValues. schedule_callback passes IS_CALLBACK=true (rescheduled
  // call should brief-acknowledge); schedule_first_attempt passes
  // IS_CALLBACK=false (participant has never been on the line, needs the
  // full intro). Previously this function hardcoded both to "true" / 1,
  // which silently overrode the schedule_first_attempt intent.
  const isCallback = variableValues?.IS_CALLBACK === "true";
  const activeSession = parseInt(variableValues?.ACTIVE_SESSION || "1", 10);
  const hasName = Boolean((variableValues?.PARTICIPANT_NAME || "").trim());
  const earliestMs = new Date(earliestAtIso).getTime();
  const delayMinutes = (earliestMs - Date.now()) / 60000;

  if (delayMinutes < QSTASH_CALLBACK_THRESHOLD_MINUTES && QSTASH_TOKEN && RENDER_BASE_URL) {
    // Short-fuse path: QStash holds the request, then fires fire-callback
    // at the target time, which dials Vapi immediately (no schedulePlan).
    await qstashScheduleAt({
      url: `${RENDER_BASE_URL}/timing/fire-callback`,
      notBeforeSeconds: Math.floor(earliestMs / 1000),
      body: { assistantId, customerNumber, variableValues, isCallback }
    });
    console.log("Short-fuse callback queued via QStash", {
      customerNumber, earliestAtIso, delayMinutes: delayMinutes.toFixed(2), isCallback, activeSession
    });
    return { id: null, status: "qstash-scheduled", earliestAt: earliestAtIso };
  }

  // Long-fuse path: hand off to Vapi's native scheduler.
  return vapiPost("/call", {
    assistantId,
    phoneNumberId: PHONE_NUMBER_ID,
    customer: { number: customerNumber },
    schedulePlan: { earliestAt: earliestAtIso },
    assistantOverrides: {
      variableValues,
      model: await buildModelOverride({ isCallback, activeSession, hasName })
    }
  });
}

async function injectSystemMessageViaControlUrl({ controlUrl, content }) {
  const resp = await fetch(controlUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "add-message", message: { role: "system", content } })
  });
  const text = await resp.text();
  console.log("controlUrl add-message resp", resp.status, text);
  return { status: resp.status, body: text };
}

// Forces the assistant to speak the given text verbatim, bypassing the
// model. Used for wrap-up because the model ignores system-message
// directives mid-interview. endCallAfterSpoken makes Vapi hang up once
// speech finishes — no separate end-call call needed. interruptAssistant
// false makes Vapi wait for the assistant to finish its current speech
// before doing the say (no barging in mid-question).
async function forceSpeakViaControlUrl({
  controlUrl,
  content,
  endCallAfterSpoken = false,
  interruptAssistantEnabled = true
}) {
  const resp = await fetch(controlUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "say",
      content,
      endCallAfterSpoken,
      interruptAssistantEnabled
    })
  });
  const text = await resp.text();
  console.log("controlUrl say resp", resp.status, text);
  return { status: resp.status, body: text };
}

async function endVapiCall({ callId, controlUrl }) {
  // Vapi's REST PATCH does not accept `status: "ended"`. The reliable way
  // to programmatically terminate a live call is via the controlUrl with
  // `{type: "end-call"}` — the same WebSocket-backed channel used for
  // add-message injection.
  if (!controlUrl) {
    console.warn("endVapiCall: missing controlUrl, cannot end call", { callId });
    return { status: 0, body: "missing controlUrl" };
  }
  try {
    const resp = await fetch(controlUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "end-call" })
    });
    const text = await resp.text();
    console.log("endVapiCall resp", resp.status, text);
    return { status: resp.status, body: text };
  } catch (e) {
    console.error("endVapiCall threw:", e);
    return { status: 0, body: String(e) };
  }
}

// =============================================================================
// QStash scheduling
// =============================================================================

async function qstashScheduleAt({ url, notBeforeSeconds, body }) {
  const resp = await fetch(`https://qstash.upstash.io/v2/publish/${url}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${QSTASH_TOKEN}`,
      "Content-Type": "application/json",
      "Upstash-Not-Before": String(notBeforeSeconds)
    },
    body: JSON.stringify(body)
  });
  const text = await resp.text();
  console.log("QStash schedule resp", resp.status, url, text);
  return { status: resp.status, body: text };
}

function buildVariableValues({ activeSession, priorSessionsContext, isCallback, participantName, country }) {
  return {
    ACTIVE_SESSION: String(activeSession),
    PRIOR_SESSIONS_CONTEXT: priorSessionsContext || "",
    INTERVIEW_MAX_MINUTES: String(INTERVIEW_MAX_MINUTES),
    IS_CALLBACK: isCallback ? "true" : "false",
    SCREENING_QUESTIONS_JSON,
    PARTICIPANT_NAME: participantName || "",
    COUNTRY: country || ""
  };
}

// =============================================================================
// Routes
// =============================================================================

/**
 * POST /start-call
 * Body: { customerNumber (req), name?, sessionNumber?=1, priorSessionsContext?, assistantId? }
 * Headers: X-API-Key (required if START_CALL_API_KEY env var is set)
 */
app.post("/start-call", async (req, res) => {
  try {
    // Auth gate: only enforced when START_CALL_API_KEY is configured.
    // If unset, the endpoint is open (a startup warning logs this).
    if (START_CALL_API_KEY) {
      const provided = req.header("X-API-Key");
      if (provided !== START_CALL_API_KEY) {
        return res.status(401).json({ error: "Unauthorized: missing or invalid X-API-Key header" });
      }
    }

    const {
      customerNumber,
      name,
      sessionNumber = 1,
      priorSessionsContext = "",
      assistantId
    } = req.body || {};

    if (!customerNumber) return res.status(400).json({ error: "Missing customerNumber" });
    if (![1, 2, 3].includes(sessionNumber)) {
      return res.status(400).json({ error: "sessionNumber must be 1, 2, or 3" });
    }

    const participant = await upsertParticipant({ phoneNumber: customerNumber, name });
    const session = await createSessionRow({
      participantId: participant.id,
      sessionNumber,
      priorSessionsContext
    });

    const variableValues = buildVariableValues({
      activeSession: sessionNumber,
      priorSessionsContext,
      isCallback: false,
      participantName: participant.name,
      country: inferCountryFromPhone(customerNumber)
    });

    const started = await startVapiCall({
      assistantId: assistantId || ASSISTANT_ID,
      customerNumber,
      variableValues
    });

    await setSessionCallId(session.id, started?.id);

    // Snapshot the live assistant config so we know which transcriber /
    // voice / model settings were active at the moment of this call.
    // Vapi's call object reports the *current* assistant config, not the
    // historical one — without this we can't reconstruct what was tested.
    logCallConfigSnapshot(started?.id, assistantId || ASSISTANT_ID).catch(e =>
      console.warn("Config snapshot log failed:", e.message)
    );

    return res.json({
      ok: true,
      callId: started?.id,
      sessionId: session.id,
      participantId: participant.id,
      status: started?.status
    });
  } catch (err) {
    console.error("start-call error:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * GET /scheduled-calls
 * Returns future-only scheduled calls for the operator dashboard.
 * Auth: same X-API-Key gate as /start-call.
 */
app.get("/scheduled-calls", async (req, res) => {
  try {
    if (START_CALL_API_KEY) {
      const provided = req.header("X-API-Key");
      if (provided !== START_CALL_API_KEY) {
        return res.status(401).json({ error: "Unauthorized: missing or invalid X-API-Key header" });
      }
    }

    const nowIso = new Date().toISOString();
    const { data: scheduled, error: schedErr } = await supabase
      .from("scheduled_calls")
      .select("id, scheduled_at, session_number, vapi_call_id, participant_id, status")
      .gt("scheduled_at", nowIso)
      .neq("status", "cancelled")
      .order("scheduled_at", { ascending: true });
    if (schedErr) throw schedErr;

    // For every row that has a vapi_call_id, verify the Vapi-side call is
    // still in "scheduled" status. Rows whose Vapi call has been deleted or
    // ended out-of-band become stale otherwise — the participant won't be
    // dialled but the dashboard would keep listing the call as upcoming.
    // Mark such rows as cancelled in Supabase so we don't re-check on every
    // dashboard load.
    const verifications = await Promise.all((scheduled || []).map(async (s) => {
      if (!s.vapi_call_id) return { row: s, live: true };
      try {
        const resp = await fetch(`https://api.vapi.ai/call/${s.vapi_call_id}`, {
          headers: { Authorization: `Bearer ${VAPI_API_KEY}` }
        });
        if (resp.status === 404) return { row: s, live: false };
        if (!resp.ok) return { row: s, live: true }; // transient — keep showing
        const call = await resp.json();
        return { row: s, live: call.status === "scheduled" };
      } catch {
        return { row: s, live: true }; // network blip — keep showing
      }
    }));

    const staleIds = verifications.filter(v => !v.live).map(v => v.row.id);
    if (staleIds.length > 0) {
      const { error: updateErr } = await supabase
        .from("scheduled_calls")
        .update({ status: "cancelled" })
        .in("id", staleIds);
      if (updateErr) console.warn("Failed to mark stale rows cancelled:", updateErr.message);
    }

    const liveRows = verifications.filter(v => v.live).map(v => v.row);

    const participantIds = [...new Set(liveRows.map(s => s.participant_id).filter(Boolean))];
    let participantsById = {};
    if (participantIds.length > 0) {
      const { data: parts, error: partErr } = await supabase
        .from("participants")
        .select("id, phone_number, name")
        .in("id", participantIds);
      if (partErr) throw partErr;
      participantsById = Object.fromEntries((parts || []).map(p => [p.id, p]));
    }

    const rows = liveRows.map(s => {
      const p = participantsById[s.participant_id] || {};
      return {
        scheduledAt: s.scheduled_at,
        phoneNumber: p.phone_number || null,
        name: p.name || null,
        sessionNumber: s.session_number,
        vapiCallId: s.vapi_call_id,
        status: s.status
      };
    });

    return res.json({ ok: true, count: rows.length, rows });
  } catch (err) {
    console.error("scheduled-calls error:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * POST /vapi
 * Vapi server webhook. Handles status-update, tool-calls, end-of-call-report.
 */
app.post("/vapi", async (req, res) => {
  try {
    const message = req.body?.message;
    const type = message?.type;

    if (type === "status-update") {
      const status = message?.status;
      const callId = message?.call?.id;
      const controlUrl = message?.call?.monitor?.controlUrl;
      console.log("status-update:", { callId, status });

      if (status === "ended" && callId) {
        timersScheduledForCallId.delete(callId);
        pendingWrapUpByCallId.delete(callId);
        inWrapUpPhaseForCallId.delete(callId);
        await updateSessionByCallId(callId, {
          status: "completed",
          completed_at: new Date().toISOString()
        });
      }

      if (status === "in-progress" && callId && !timersScheduledForCallId.has(callId)) {
        timersScheduledForCallId.add(callId);
        await updateSessionByCallId(callId, {
          status: "in_progress",
          started_at: new Date().toISOString()
        });

        const startMs = Date.now();
        // Three-stage close-out:
        //   soft (T - WRAPUP_OFFSET_MINUTES): system message asks Imani to
        //       wrap after the participant's NEXT response. Lets the
        //       conversation finish its current turn naturally.
        //   force (T - FORCE_CLOSE_OFFSET_SECONDS): Vapi force-speaks
        //       the closing line and auto-hangs up. Fail-safe if Imani
        //       didn't comply with the soft signal.
        //   hard cap (T): final fallback — endVapiCall via controlUrl.
        const FORCE_CLOSE_OFFSET_SECONDS = parseInt(process.env.FORCE_CLOSE_OFFSET_SECONDS || "30", 10);
        const softWrapupAt = Math.floor((startMs + (INTERVIEW_MAX_MINUTES - WRAPUP_OFFSET_MINUTES) * 60 * 1000) / 1000);
        const forceCloseAt = Math.floor((startMs + INTERVIEW_MAX_MINUTES * 60 * 1000 - FORCE_CLOSE_OFFSET_SECONDS * 1000) / 1000);
        const hardCapAt = Math.floor((startMs + INTERVIEW_MAX_MINUTES * 60 * 1000) / 1000);

        // Branch the close-out copy on which session this is. Sessions 1
        // and 2 propose scheduling the next conversation; Session 3 is the
        // final session and just thanks/says goodbye with no scheduling.
        const currentSession = parseInt(
          message?.call?.assistantOverrides?.variableValues?.ACTIVE_SESSION || "1",
          10
        );
        const isFinalSession = currentSession >= 3;

        // Fallback closing if Imani doesn't invoke schedule_next_session.
        // Force-close speaks this verbatim and hangs up.
        const closingSentence = isFinalSession
          ? `Well, that wraps up our final interview session. ` +
            `Thank you so much for everything you've shared across our conversations. Take care. Goodbye.`
          : `Well, that wraps up today's interview session. ` +
            `Thank you so much for everything you've shared today. ` +
            `Take care until then. Goodbye.`;

        // Soft signal: force Imani to SAY this verbatim via Vapi's say
        // action. The /timing/wrap-up handler stores this text and waits
        // for the next "user stopped speaking" event before actually firing
        // the say — so we never barge into the participant's pending
        // response to Imani's last interview question.
        //
        // Sessions 1 and 2: includes "wraps up + thanks" transition before
        // a scheduling question. After participant answers, Imani invokes
        // schedule_next_session and Vapi's request-complete closes the call.
        //
        // Session 3: final session, no further scheduling. Soft signal
        // becomes the full farewell with endCallAfterSpoken so the call
        // ends after Vapi speaks it.
        const softWrapupContent = isFinalSession
          ? `Well, that wraps up our final interview session. ` +
            `Thank you so much for everything you've shared across our conversations. Take care. Goodbye.`
          : `Well, that wraps up our interview for today. ` +
            `Thank you so much for everything you've shared. ` +
            `Before we go, I'd like to schedule our next conversation. ` +
            `Would three days from now at this same time work for you?`;

        try {
          if (controlUrl && RENDER_BASE_URL && QSTASH_TOKEN) {
            await qstashScheduleAt({
              url: `${RENDER_BASE_URL}/timing/wrap-up`,
              notBeforeSeconds: softWrapupAt,
              body: {
                callId,
                controlUrl,
                content: softWrapupContent,
                endCallAfterSpoken: isFinalSession
              }
            });
            await qstashScheduleAt({
              url: `${RENDER_BASE_URL}/timing/force-close`,
              notBeforeSeconds: forceCloseAt,
              body: { callId, controlUrl, content: closingSentence }
            });
            await qstashScheduleAt({
              url: `${RENDER_BASE_URL}/timing/hard-cap`,
              notBeforeSeconds: hardCapAt,
              body: { callId, controlUrl }
            });
            console.log("Scheduled close-out timers", { callId, softWrapupAt, forceCloseAt, hardCapAt });
          } else {
            console.warn("Skipping timer schedule — missing controlUrl, RENDER_BASE_URL, or QSTASH_TOKEN");
          }
        } catch (e) {
          console.error("Timer scheduling failed:", e);
        }
      }

      return res.json({ ok: true });
    }

    // speech-update lets us defer the wrap-up scheduling question until
    // the participant has actually finished responding to whatever Imani
    // last asked. We listen for role=user, status=stopped; if there is a
    // queued wrap-up for this call, fire it now.
    if (type === "speech-update") {
      const role = message?.role;
      const speechStatus = message?.status;
      const callId = message?.call?.id;
      if (role === "user" && speechStatus === "stopped" && callId && pendingWrapUpByCallId.has(callId)) {
        const { controlUrl, content, endCallAfterSpoken } = pendingWrapUpByCallId.get(callId);
        pendingWrapUpByCallId.delete(callId);
        try {
          await forceSpeakViaControlUrl({
            controlUrl,
            content,
            endCallAfterSpoken: !!endCallAfterSpoken,
            interruptAssistantEnabled: false
          });
          console.log("Wrap-up spoken after user-stop", { callId, endCallAfterSpoken });
        } catch (e) {
          console.error("Failed to speak queued wrap-up:", e);
        }
      }
      return res.json({ ok: true });
    }

    if (type === "tool-calls") {
      const toolCall = message.toolCallList?.[0];
      const fn = toolCall?.function;
      console.log("tool-calls:", { callId: message?.call?.id, name: fn?.name, arguments: fn?.arguments });

      // Server-side intercept: the model stubbornly picks schedule_callback
      // for short-fuse times even at end of session. If we are past the
      // wrap-up signal, treat the schedule_callback invocation as if Imani
      // had called schedule_next_session. The function name is reassigned
      // below so the rest of the handler routes correctly.
      const currentCallId = message?.call?.id;
      if (fn?.name === "schedule_callback" && inWrapUpPhaseForCallId.has(currentCallId)) {
        console.log("Intercepting schedule_callback in wrap-up phase; redirecting to schedule_next_session", { callId: currentCallId });
        fn.name = "schedule_next_session";
      }

      if (fn?.name === "schedule_callback") {
        const { suggestedTime } = fn.arguments || {};
        // Trust the call's customer number (always E.164) over the model's
        // tool argument, which can be malformed (missing country code,
        // spelled out, etc.).
        const customerNumber =
          message?.call?.customer?.number ||
          fn.arguments?.customerNumber;
        const timezone = inferTimezone(customerNumber);
        let parsed = parseSuggestedTimeToLocalDate({ suggestedTimeText: suggestedTime, timezone });
        if (!parsed) {
          // The prompt requires Imani to translate vague phrases into
          // concrete times before invoking the tool, but if she still
          // passes through something unparseable ("a few minutes",
          // "later", "soon"), recover with a 5-minute default rather
          // than failing silently — the participant just heard "Take
          // care." and the call is about to end, so without a fallback
          // they would never get called back.
          console.warn("schedule_callback: suggestedTime unparseable, falling back to 5-minute default", { suggestedTime });
          parsed = parseSuggestedTimeToLocalDate({
            suggestedTimeText: "in five minutes",
            timezone
          });
          if (!parsed) {
            return res.json({
              results: [{ toolCallId: toolCall.id, result: "Could not parse suggested time" }]
            });
          }
        }
        const { targetLocal, localNow, nowUtc } = parsed;
        const offsetMs = localNow.getTime() - nowUtc.getTime();
        const utcTarget = new Date(targetLocal.getTime() - offsetMs);

        const assistantIdForCallback =
          message?.call?.assistantId || message?.assistant?.id || ASSISTANT_ID;
        const callId = message?.call?.id;

        // Carry over the current session's context. schedule_callback
        // reschedules the SAME session, so the rescheduled call must
        // re-enter at the same active_session with the same
        // prior_sessions_context — otherwise a Session 2 reschedule
        // would dial back as a Session 1 cold call.
        const liveVars = message?.call?.assistantOverrides?.variableValues || {};
        const currentSession = parseInt(liveVars.ACTIVE_SESSION || "1", 10);
        const priorContext = liveVars.PRIOR_SESSIONS_CONTEXT || "";
        const participantName = liveVars.PARTICIPANT_NAME || "";

        const scheduled = await scheduleVapiCallback({
          assistantId: assistantIdForCallback,
          customerNumber,
          earliestAtIso: utcTarget.toISOString(),
          variableValues: buildVariableValues({
            activeSession: currentSession,
            priorSessionsContext: priorContext,
            isCallback: true,
            participantName,
            country: inferCountryFromPhone(customerNumber)
          })
        });

        markScheduled(callId || `${customerNumber}:${suggestedTime}`);

        try {
          const { data: p } = await supabase
            .from("participants")
            .select("id")
            .eq("phone_number", customerNumber)
            .maybeSingle();
          if (p?.id) {
            await recordScheduledCall({
              participantId: p.id,
              sessionNumber: currentSession,
              scheduledAt: utcTarget.toISOString(),
              vapiCallId: scheduled?.id
            });
          }
        } catch (e) {
          console.error("Persist scheduled_calls failed:", e);
        }

        return res.json({
          results: [{
            toolCallId: toolCall.toolCallId || toolCall.id,
            result: `Got it, I'll call you back ${suggestedTime}. Take care.`
          }]
        });
      }

      // ---- report_wrong_number: third party confirmed this is a wrong number ----
      if (fn?.name === "report_wrong_number") {
        const customerNumber = message?.call?.customer?.number;
        try {
          const { data: p } = await supabase
            .from("participants")
            .select("id")
            .eq("phone_number", customerNumber)
            .maybeSingle();
          if (p?.id) {
            const liveVars = message?.call?.assistantOverrides?.variableValues || {};
            const currentSession = parseInt(liveVars.ACTIVE_SESSION || "1", 10);
            await supabase
              .from("sessions")
              .update({ status: "wrong_number" })
              .eq("participant_id", p.id)
              .eq("session_number", currentSession);
            console.log("Marked session as wrong_number", { participantId: p.id, sessionNumber: currentSession });
          }
        } catch (e) {
          console.error("report_wrong_number persistence failed:", e);
        }
        return res.json({
          results: [{
            toolCallId: toolCall.toolCallId || toolCall.id,
            result: "Wrong-number outcome recorded."
          }]
        });
      }

      // ---- schedule_first_attempt: third party scheduled a callback because ----
      // ---- the intended participant was not available at this attempt.     ----
      // ---- The rescheduled call must be a fresh first-attempt (full intro) ----
      // ---- so IS_CALLBACK is false on the rescheduled call.                ----
      if (fn?.name === "schedule_first_attempt") {
        const { suggestedTime } = fn.arguments || {};
        const customerNumber = message?.call?.customer?.number;
        const timezone = inferTimezone(customerNumber);
        let parsed = parseSuggestedTimeToLocalDate({ suggestedTimeText: suggestedTime, timezone });
        if (!parsed) {
          console.warn("schedule_first_attempt: suggestedTime unparseable, falling back to 1-hour default", { suggestedTime });
          parsed = parseSuggestedTimeToLocalDate({ suggestedTimeText: "in 1 hour", timezone });
          if (!parsed) {
            return res.json({
              results: [{ toolCallId: toolCall.id, result: "Could not parse suggested time" }]
            });
          }
        }
        const { targetLocal, localNow, nowUtc } = parsed;
        const offsetMs = localNow.getTime() - nowUtc.getTime();
        const utcTarget = new Date(targetLocal.getTime() - offsetMs);

        const assistantIdForCallback =
          message?.call?.assistantId || message?.assistant?.id || ASSISTANT_ID;

        const liveVars = message?.call?.assistantOverrides?.variableValues || {};
        const currentSession = parseInt(liveVars.ACTIVE_SESSION || "1", 10);
        const participantName = liveVars.PARTICIPANT_NAME || "";

        const scheduled = await scheduleVapiCallback({
          assistantId: assistantIdForCallback,
          customerNumber,
          earliestAtIso: utcTarget.toISOString(),
          variableValues: buildVariableValues({
            activeSession: currentSession,
            priorSessionsContext: "",
            isCallback: false,
            participantName,
            country: inferCountryFromPhone(customerNumber)
          })
        });

        try {
          const { data: p } = await supabase
            .from("participants")
            .select("id")
            .eq("phone_number", customerNumber)
            .maybeSingle();
          if (p?.id) {
            await recordScheduledCall({
              participantId: p.id,
              sessionNumber: currentSession,
              scheduledAt: utcTarget.toISOString(),
              vapiCallId: scheduled?.id
            });
            await supabase
              .from("sessions")
              .update({ status: "rescheduled_unreached" })
              .eq("participant_id", p.id)
              .eq("session_number", currentSession);
          }
        } catch (e) {
          console.error("schedule_first_attempt persistence failed:", e);
        }

        return res.json({
          results: [{
            toolCallId: toolCall.toolCallId || toolCall.id,
            result: `Scheduled fresh first-attempt call for ${suggestedTime}.`
          }]
        });
      }

      // ---- schedule_next_session: schedule the next session of this study ----
      if (fn?.name === "schedule_next_session") {
        const { suggestedTime } = fn.arguments || {};
        const currentSession = parseInt(
          message?.call?.assistantOverrides?.variableValues?.ACTIVE_SESSION || "1",
          10
        );
        const nextSession = currentSession + 1;
        if (nextSession > 3) {
          // After Session 3 there is no further session.
          return res.json({
            results: [{
              toolCallId: toolCall.toolCallId || toolCall.id,
              result: "The study is complete — there is no further session."
            }]
          });
        }

        const customerNumber = message?.call?.customer?.number;
        const timezone = inferTimezone(customerNumber);
        let parsed = parseSuggestedTimeToLocalDate({
          suggestedTimeText: suggestedTime,
          timezone
        });
        if (!parsed) {
          // The model sometimes invokes this tool prematurely with a
          // question or vague phrase as suggestedTime (e.g.,
          // "a different time that works for you"). Rather than failing
          // silently — which leaves the participant with no future call
          // and a confusing closing — fall back to the 3-day default.
          // This is a recovery path; the tool description and force-say
          // wording should still discourage premature invocation.
          console.warn("schedule_next_session: suggestedTime unparseable, falling back to 3-day default", { suggestedTime });
          parsed = parseSuggestedTimeToLocalDate({
            suggestedTimeText: "in three days at this same time",
            timezone
          });
          if (!parsed) {
            return res.json({
              results: [{
                toolCallId: toolCall.toolCallId || toolCall.id,
                result: "Could not parse suggested time and fallback failed"
              }]
            });
          }
        }
        const { targetLocal, localNow, nowUtc } = parsed;
        const offsetMs = localNow.getTime() - nowUtc.getTime();
        const utcTarget = new Date(targetLocal.getTime() - offsetMs);

        const assistantIdForNext =
          message?.call?.assistantId || message?.assistant?.id || ASSISTANT_ID;
        const participantName =
          message?.call?.assistantOverrides?.variableValues?.PARTICIPANT_NAME || "";

        // Next session is its own first-of-its-kind contact, not an IS_CALLBACK
        // retry. Build variableValues accordingly.
        const nextSessionVars = buildVariableValues({
          activeSession: nextSession,
          priorSessionsContext: "",
          isCallback: false,
          participantName,
          country: inferCountryFromPhone(customerNumber)
        });

        // Short-fuse routing: for delays under the threshold, schedule via
        // QStash and dial Vapi immediately when the time arrives. Same
        // pattern as scheduleVapiCallback — avoids Vapi's native scheduler
        // lead-time problem that leaves "in one minute" calls stuck in
        // scheduled state for many minutes. Long-fuse delays still use
        // Vapi's schedulePlan.
        const delayMinutes = (utcTarget.getTime() - Date.now()) / 60000;
        let scheduled = null;
        if (delayMinutes < QSTASH_CALLBACK_THRESHOLD_MINUTES && QSTASH_TOKEN && RENDER_BASE_URL) {
          await qstashScheduleAt({
            url: `${RENDER_BASE_URL}/timing/fire-callback`,
            notBeforeSeconds: Math.floor(utcTarget.getTime() / 1000),
            body: {
              assistantId: assistantIdForNext,
              customerNumber,
              variableValues: nextSessionVars,
              isCallback: false
            }
          });
          scheduled = { id: null, status: "qstash-scheduled" };
          console.log("Short-fuse next-session call queued via QStash", {
            customerNumber, earliestAt: utcTarget.toISOString(), delayMinutes: delayMinutes.toFixed(2)
          });
        } else {
          scheduled = await vapiPost("/call", {
            assistantId: assistantIdForNext,
            phoneNumberId: PHONE_NUMBER_ID,
            customer: { number: customerNumber },
            schedulePlan: { earliestAt: utcTarget.toISOString() },
            assistantOverrides: {
              variableValues: nextSessionVars,
              model: await buildModelOverride({ isCallback: false, activeSession: nextSession })
            }
          });
        }

        console.log("Next session scheduled", {
          fromSession: currentSession,
          toSession: nextSession,
          customerNumber,
          scheduledAt: utcTarget.toISOString(),
          vapiCallId: scheduled?.id
        });

        // Persist to scheduled_calls (best-effort).
        try {
          const { data: p } = await supabase
            .from("participants")
            .select("id")
            .eq("phone_number", customerNumber)
            .maybeSingle();
          if (p?.id) {
            await recordScheduledCall({
              participantId: p.id,
              sessionNumber: nextSession,
              scheduledAt: utcTarget.toISOString(),
              vapiCallId: scheduled?.id
            });
          }
        } catch (e) {
          console.error("Persist scheduled_calls (next session) failed:", e);
        }

        // Tool result text is unused — Vapi speaks the request-complete
        // message configured on the tool (which interpolates {{suggestedTime}}).
        return res.json({
          results: [{
            toolCallId: toolCall.toolCallId || toolCall.id,
            result: `Session ${nextSession} scheduled for ${suggestedTime}.`
          }]
        });
      }

      return res.json({ results: [] });
    }

    if (type === "end-of-call-report") {
      const call = message.call;
      const callId = call?.id;
      const customerNumber = call?.customer?.number || message?.customer?.number;
      const transcript =
        message?.artifact?.transcript ||
        call?.artifact?.transcript ||
        message?.transcript ||
        call?.transcript ||
        "";
      const transcriptStructured =
        message?.artifact?.messages || call?.artifact?.messages || null;

      if (callId) {
        await updateSessionByCallId(callId, {
          status: "completed",
          completed_at: new Date().toISOString(),
          transcript: transcriptStructured || (transcript ? { plain: transcript } : null)
        });
      }

      if (customerNumber) {
        const suggestedTimeText = extractSuggestedTimeFromTranscript(transcript);
        const callIdKey = callId;
        const timeKey = `${customerNumber}:${suggestedTimeText}`;
        if (suggestedTimeText && !wasScheduled(callIdKey) && !wasScheduled(timeKey)) {
          const timezone = inferTimezone(customerNumber);
          const parsed = parseSuggestedTimeToLocalDate({ suggestedTimeText, timezone });
          if (parsed) {
            const { targetLocal, localNow, nowUtc } = parsed;
            const offsetMs = localNow.getTime() - nowUtc.getTime();
            const utcTarget = new Date(targetLocal.getTime() - offsetMs);
            const assistantIdForCallback =
              call?.assistantId || message?.assistant?.id || ASSISTANT_ID;
            await scheduleVapiCallback({
              assistantId: assistantIdForCallback,
              customerNumber,
              earliestAtIso: utcTarget.toISOString(),
              variableValues: buildVariableValues({
                activeSession: 1,
                priorSessionsContext: "",
                isCallback: true,
                participantName: "",
                country: inferCountryFromPhone(customerNumber)
              })
            });
            markScheduled(callIdKey || timeKey);
            console.log("Fallback callback scheduled from end-of-call:", {
              customerNumber, suggestedTimeText, utcTarget: utcTarget.toISOString()
            });
          }
        }
      }

      return res.json({});
    }

    return res.json({});
  } catch (err) {
    console.error("Webhook error:", err);
    return res.status(200).json({});
  }
});

/**
 * POST /timing/wrap-up
 * QStash trigger 2 minutes before hard cap. Injects the wrap-up system message.
 */
app.post("/timing/wrap-up", async (req, res) => {
  try {
    const { callId, controlUrl, content, endCallAfterSpoken = false } = req.body || {};
    if (!controlUrl || !content) return res.status(400).json({ error: "Missing controlUrl/content" });
    if (callId && !timersScheduledForCallId.has(callId)) {
      console.log("Skipping wrap-up: call already ended", { callId });
      return res.json({ ok: true, skipped: true });
    }
    // Queue the wrap-up text. It will be force-spoken when the next
    // speech-update arrives with role=user, status=stopped — i.e. when the
    // participant finishes their next turn. Avoids speaking it while the
    // participant is still expected to answer Imani's pending question.
    //
    // endCallAfterSpoken=true means this is Session 3's final farewell:
    // Vapi will hang up automatically after speaking. For Sessions 1 and 2,
    // false — the conversation continues for the scheduling exchange.
    pendingWrapUpByCallId.set(callId, {
      controlUrl,
      content,
      endCallAfterSpoken,
      queuedAt: Date.now()
    });
    // Mark this call as in the wrap-up phase. Any schedule_callback
    // invoked from this point on gets intercepted and redirected to the
    // schedule_next_session flow.
    inWrapUpPhaseForCallId.add(callId);
    console.log("Wrap-up text queued (waiting for user-stop)", { callId, endCallAfterSpoken });
    return res.json({ ok: true, queued: true });
  } catch (e) {
    console.error("/timing/wrap-up error", e);
    return res.status(500).json({ ok: false });
  }
});

/**
 * POST /timing/force-close
 * QStash trigger ~30 seconds before hard cap. If the call is still live
 * at this point, Imani did not comply with the soft wrap-up signal — Vapi
 * force-speaks the closing line and auto-hangs up.
 */
app.post("/timing/force-close", async (req, res) => {
  try {
    const { callId, controlUrl, content } = req.body || {};
    if (!controlUrl || !content) return res.status(400).json({ error: "Missing controlUrl/content" });
    if (callId && !timersScheduledForCallId.has(callId)) {
      console.log("Skipping force-close: call already ended", { callId });
      return res.json({ ok: true, skipped: true });
    }
    await forceSpeakViaControlUrl({ controlUrl, content, endCallAfterSpoken: true });
    console.log("Force-close fired", { callId });
    return res.json({ ok: true });
  } catch (e) {
    console.error("/timing/force-close error", e);
    return res.status(500).json({ ok: false });
  }
});

/**
 * POST /timing/fire-callback
 * QStash trigger at the participant's requested callback time, for
 * short-fuse callbacks (under QSTASH_CALLBACK_THRESHOLD_MINUTES).
 * Dials Vapi immediately, no schedulePlan, so there's no Vapi-scheduler
 * lead-time on top of the participant's requested delay.
 */
app.post("/timing/fire-callback", async (req, res) => {
  try {
    const { assistantId, customerNumber, variableValues, isCallback = true } = req.body || {};
    if (!assistantId || !customerNumber) {
      return res.status(400).json({ error: "Missing assistantId or customerNumber" });
    }
    // isCallback controls Session 1 initial-vs-callback choice; activeSession
    // controls which session's opening protocol is kept in the assembled
    // prompt (and strips all the others). hasName controls whether the
    // Session 1 Step 0 identity-check block is kept.
    const activeSession = parseInt(variableValues?.ACTIVE_SESSION || "1", 10);
    const hasName = Boolean((variableValues?.PARTICIPANT_NAME || "").trim());
    const result = await vapiPost("/call", {
      assistantId,
      phoneNumberId: PHONE_NUMBER_ID,
      customer: { number: customerNumber },
      assistantOverrides: {
        variableValues,
        model: await buildModelOverride({ isCallback, activeSession, hasName })
      }
    });
    console.log("Fire-callback dialed", { vapiCallId: result?.id, customerNumber, isCallback, activeSession });
    return res.json({ ok: true, vapiCallId: result?.id });
  } catch (e) {
    console.error("/timing/fire-callback error:", e);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * POST /timing/hard-cap
 * QStash trigger at INTERVIEW_MAX_MINUTES. Forcibly ends the Vapi call via
 * the controlUrl. Idempotent — skips silently if the call already ended.
 */
app.post("/timing/hard-cap", async (req, res) => {
  try {
    const { callId, controlUrl } = req.body || {};
    if (!callId) return res.status(400).json({ error: "Missing callId" });
    if (!timersScheduledForCallId.has(callId)) {
      console.log("Skipping hard-cap: call already ended", { callId });
      return res.json({ ok: true, skipped: true });
    }
    await endVapiCall({ callId, controlUrl });
    console.log("Hard cap fired", { callId });
    return res.json({ ok: true });
  } catch (e) {
    console.error("/timing/hard-cap error", e);
    return res.status(500).json({ ok: false });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on ${PORT}`));
