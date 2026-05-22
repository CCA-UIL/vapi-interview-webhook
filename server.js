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

// Map Vapi endedReason strings to richer sessions.status values so the
// operator dashboard's Notes column can show meaningful outcomes.
// Anything not matched here falls through to "completed".
function mapEndedReasonToStatus(endedReason) {
  if (!endedReason) return "completed";
  const r = String(endedReason).toLowerCase();
  if (r.includes("did-not-answer") || r.includes("no-answer")) return "no_answer";
  if (r.includes("voicemail")) return "voicemail";
  if (
    r.includes("invalid") ||
    r.includes("twilio-failed-to-connect") ||
    r.includes("phone-call-provider-bypass") ||
    r.includes("provider-error") && r.includes("phone")
  ) return "invalid_number";
  if (r.includes("silence-timed-out")) return "no_engagement";
  if (r.includes("exceeded-max-duration")) return "completed_at_cap";
  if (r.startsWith("customer-busy")) return "busy";
  return "completed";
}

// Human-readable label for sessions.status. Used by the operator dashboard
// Notes column.
function statusToNotesLabel(status) {
  switch (status) {
    case "wrong_number":          return "Wrong number";
    case "rescheduled_unreached": return "Person unavailable — rescheduled";
    case "no_answer":             return "No answer";
    case "voicemail":             return "Voicemail";
    case "invalid_number":        return "Not a valid number";
    case "no_engagement":         return "Silence — no engagement";
    case "completed_at_cap":      return "Completed (hit time cap)";
    case "busy":                  return "Busy";
    case "completed":             return "";
    case "scheduled":             return "";
    case "in_progress":           return "";
    case "cancelled":             return "Cancelled";
    default:                      return status || "";
  }
}

function inferTimezone(number = "") {
  const codes = Object.keys(ccToTz).sort((a, b) => b.length - a.length);
  for (const c of codes) if (number.startsWith(c)) return ccToTz[c];
  return "UTC";
}

// Interpret a naive local datetime string (e.g., "2026-05-20T10:00" from an
// <input type="datetime-local">) as if it were expressed in the given target
// timezone, and return the corresponding absolute UTC Date. Independent of
// the host's local timezone (uses Intl.DateTimeFormat.formatToParts).
function parseLocalDatetimeInTimezone(naiveLocal, timezone) {
  if (!naiveLocal) return null;
  const withSeconds = /:\d{2}:\d{2}$/.test(naiveLocal) ? naiveLocal : naiveLocal + ":00";
  const asUtc = new Date(withSeconds + "Z");
  if (isNaN(asUtc.getTime())) return null;
  // Discover what wall-clock time that "fake-UTC" instant lands on in the
  // target timezone, reconstruct that wall-clock as UTC, and use the
  // difference as the timezone offset to subtract.
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false
  });
  const parts = Object.fromEntries(fmt.formatToParts(asUtc).map(p => [p.type, p.value]));
  const wallAsUtc = Date.UTC(
    parseInt(parts.year, 10),
    parseInt(parts.month, 10) - 1,
    parseInt(parts.day, 10),
    parseInt(parts.hour, 10) % 24,
    parseInt(parts.minute, 10),
    parseInt(parts.second, 10)
  );
  const offsetMs = wallAsUtc - asUtc.getTime();
  return new Date(asUtc.getTime() - offsetMs);
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
  // When the operator submits a blank name, do NOT overwrite an existing
  // participant's stored name. Pass only phone_number — on conflict the
  // update is a no-op for the name column; on insert (new phone) the
  // column defaults to NULL. Per-call name tracking lives on
  // scheduled_calls.name_at_call, not here.
  const trimmed = (name || "").trim();
  const row = trimmed
    ? { phone_number: phoneNumber, name: trimmed }
    : { phone_number: phoneNumber };
  const { data, error } = await supabase
    .from("participants")
    .upsert(row, { onConflict: "phone_number" })
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

async function recordScheduledCall({ participantId, sessionNumber, scheduledAt, vapiCallId, nameAtCall = null }) {
  const { error } = await supabase
    .from("scheduled_calls")
    .insert({
      participant_id: participantId,
      session_number: sessionNumber,
      scheduled_at: scheduledAt,
      vapi_call_id: vapiCallId,
      status: "sent",
      name_at_call: nameAtCall || null
    });
  if (error) console.error("recordScheduledCall failed:", error.message);
}

// Update the scheduled_calls row whose vapi_call_id matches the just-ended
// call. Each attempt now carries its own outcome (status). Avoids the
// "join by (participant, session)" problem where two attempts to the same
// (participant, session_number) would share one sessions row and lose the
// older attempt's outcome.
async function updateScheduledCallStatusByVapiId(vapiCallId, status) {
  if (!vapiCallId || !status) return;
  const { error } = await supabase
    .from("scheduled_calls")
    .update({ status })
    .eq("vapi_call_id", vapiCallId);
  if (error) console.warn("updateScheduledCallStatusByVapiId failed:", error.message);
}

// Simple asset count derived from the 4 asset questions. A real PPI score
// requires country-specific scorecards and ~10 indicators; we have 4, so
// this is just a 0-4 count placeholder until/unless a full scorecard is
// wired in.
function computePpiScore(data) {
  if (!data) return null;
  let score = 0;
  if (data.owns_tv) score++;
  if (data.owns_fridge) score++;
  if (data.owns_car) score++;
  if (data.piped_water) score++;
  return score;
}

// Persist the prescreening analysis (LLM-extracted structured data from the
// transcript) into the prescreening_responses table. Upserts by
// participant_id — per the user's preference, a rescreen overwrites the
// previous responses (UNIQUE constraint on participant_id enforces this).
async function handlePrescreeningEndOfCall({ message, call, customerNumber, callId }) {
  try {
    const analysis = message?.analysis || call?.analysis || {};
    const data = analysis.structuredData || {};
    console.log("Prescreening end-of-call", {
      callId,
      customerNumber,
      hasStructuredData: Boolean(analysis.structuredData),
      keys: Object.keys(data)
    });

    if (!customerNumber) {
      console.warn("Prescreening end-of-call missing customerNumber, skipping persist");
      return;
    }

    // Skip persisting when the call yielded no meaningful screening data.
    // Happens on early hang-ups, wrong-number calls, and reschedules where
    // the participant never got past Q1. The participant's eventual
    // completed call will create the proper row.
    const hasAnyData = Object.values(data).some(v => v !== null && v !== undefined && v !== "");
    if (!hasAnyData) {
      console.warn("Prescreening end-of-call: empty structuredData, skipping persist", { callId });
      return;
    }

    const { data: p } = await supabase
      .from("participants")
      .select("id")
      .eq("phone_number", customerNumber)
      .maybeSingle();
    if (!p?.id) {
      console.warn("Prescreening end-of-call: no participant row for", customerNumber);
      return;
    }

    const ppi = computePpiScore(data);
    // Snapshot the name that was used for THIS specific call. The
    // participants table can be updated later, but we want the
    // prescreening row to show what name (if any) was provided when
    // this call was placed.
    const nameAtCall = (
      call?.assistantOverrides?.variableValues?.PARTICIPANT_NAME ||
      message?.call?.assistantOverrides?.variableValues?.PARTICIPANT_NAME ||
      ""
    ).trim();
    // Compute call duration so the dashboard can flag short / aborted
    // screening calls.
    const startedAt = call?.startedAt || message?.call?.startedAt;
    const endedAt   = call?.endedAt   || message?.call?.endedAt;
    let durationSeconds = null;
    if (startedAt && endedAt) {
      const ms = new Date(endedAt).getTime() - new Date(startedAt).getTime();
      if (!isNaN(ms) && ms > 0) durationSeconds = Math.round(ms / 1000);
    }
    const row = {
      participant_id: p.id,
      vapi_call_id: callId,
      name_at_call: nameAtCall || null,
      duration_seconds: durationSeconds,
      about_you_text: data.about_you_text ?? null,
      english_interview_ok: data.english_interview_ok ?? null,
      robot_recorded_ok: data.robot_recorded_ok ?? null,
      whatsapp_photos_ok: data.whatsapp_photos_ok ?? null,
      main_cook: data.main_cook ?? null,
      owns_epc: data.owns_epc ?? null,
      epc_uses_last_week: data.epc_uses_last_week ?? null,
      age: data.age ?? null,
      owns_tv: data.owns_tv ?? null,
      owns_fridge: data.owns_fridge ?? null,
      owns_car: data.owns_car ?? null,
      piped_water: data.piped_water ?? null,
      ppi_score: ppi,
      needs_followup: data.needs_followup ?? false,
      followup_notes: data.followup_notes || null,
      raw_extraction: data,
      updated_at: new Date().toISOString()
    };

    // Upsert on vapi_call_id so each screening attempt gets its own row
    // (one row per call, not per participant — re-screens for the same
    // phone now appear as separate rows in the dashboard, sorted by
    // created_at DESC). Idempotent if end-of-call-report fires twice
    // for the same call.
    const { error } = await supabase
      .from("prescreening_responses")
      .upsert(row, { onConflict: "vapi_call_id" });
    if (error) {
      console.error("Failed to upsert prescreening_responses:", error.message);
    } else {
      console.log("Prescreening response persisted", { participantId: p.id, callId, ppi });
    }
  } catch (e) {
    console.error("handlePrescreeningEndOfCall error:", e);
  }
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

const PRESCREENING_PROMPT_PATH = path.join(
  __dirname,
  "eric_project",
  "prompts",
  "prescreening_prompt.xml"
);

// JSON schema used by Vapi's analysisPlan.structuredDataPlan to extract
// structured data from the prescreening transcript at end-of-call.
const PRESCREENING_SCHEMA = {
  type: "object",
  properties: {
    about_you_text: {
      type: "string",
      description: "The participant's free-text answer to 'Tell me a bit about yourself.' Quote them directly; trim to ~300 chars if long."
    },
    english_interview_ok: {
      type: "boolean",
      description: "Q2: Comfortable conducting three 45-minute phone interviews in English."
    },
    robot_recorded_ok: {
      type: "boolean",
      description: "Q3: Comfortable being interviewed by a robot and having the interview recorded."
    },
    whatsapp_photos_ok: {
      type: "boolean",
      description: "Q4: Willing to send 3 EPC photos + 3 kitchen photos via WhatsApp."
    },
    main_cook: {
      type: "boolean",
      description: "Q5: Main person responsible for planning, preparing, or overseeing meals."
    },
    owns_epc: {
      type: "boolean",
      description: "Q6: Owns an electric pressure cooker."
    },
    epc_uses_last_week: {
      type: "integer",
      description: "Q7: Number of times the participant used their electric pressure cooker last week. If unclear, leave null."
    },
    age: {
      type: "integer",
      description: "Q8: Participant's age in years."
    },
    owns_tv: { type: "boolean", description: "Q9: Owns a television." },
    owns_fridge: { type: "boolean", description: "Q10: Owns a refrigerator." },
    owns_car: { type: "boolean", description: "Q11: Owns a private car or van." },
    piped_water: { type: "boolean", description: "Q12: Has piped water at home." },
    needs_followup: {
      type: "boolean",
      description: "True if the participant raised any question during the call that the bot punted with the standard phrasing 'someone from the team will follow up'. Includes any question about payment/money/compensation/incentives, or any other off-FAQ question. False if the participant did not ask any follow-up-needed question."
    },
    followup_notes: {
      type: "string",
      description: "If needs_followup is true, a short 1-line summary of what the participant asked about (e.g., 'Asked about payment / compensation', 'Wanted to know who funds the study'). Concatenate multiple items with semicolons. Leave empty if needs_followup is false."
    }
  },
  required: []
};

function loadPromptForCall({ isCallback, activeSession = 1, hasName = false, consentEnabled = true }) {
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

  // Consent step gate. The prompt contains both <consent_branch_enabled>
  // and <consent_branch_disabled> blocks at every place the consent step
  // could fire (Session 1 initial flow + callback flow). Strip the
  // inactive variant — and there can be multiple, so use gm.
  const stripNestedBlockAll = (tag, reason) => {
    const re = new RegExp(`^\\s*<${tag}>[\\s\\S]*?^\\s*</${tag}>\\s*$`, "gm");
    prompt = prompt.replace(re, `<${tag}>(omitted: ${reason})</${tag}>`);
  };
  if (consentEnabled) {
    stripNestedBlockAll("consent_branch_disabled", "consent step is enabled");
  } else {
    stripNestedBlockAll("consent_branch_enabled", "consent step is disabled via CONSENT_STATEMENT_ENABLED env var");
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

// CONSENT_STATEMENT_ENABLED is read fresh per call so toggling the env var
// in Render takes effect on the next dial without a restart. Defaults to
// true (consent step on) when the variable is unset.
function consentStatementEnabled() {
  return String(process.env.CONSENT_STATEMENT_ENABLED || "true").toLowerCase() !== "false";
}

// Load the prescreening prompt and strip the step_0 identity-check block
// when no participant name was provided. Mirrors the per-call stripping
// pattern used in loadPromptForCall for the interview prompt.
function loadPrescreeningPrompt({ hasName = false }) {
  let prompt = fs.readFileSync(PRESCREENING_PROMPT_PATH, "utf8");
  if (!hasName) {
    const re = /^\s*<step_0_identity_check>[\s\S]*?^\s*<\/step_0_identity_check>\s*$/m;
    prompt = prompt.replace(re, "<step_0_identity_check>(omitted: no participant name provided)</step_0_identity_check>");
  }
  return prompt;
}

async function buildModelOverride({ isCallback, activeSession = 1, hasName = false, callKind = "interview" }) {
  const template = await getModelTemplate();
  const content = callKind === "prescreening"
    ? loadPrescreeningPrompt({ hasName })
    : loadPromptForCall({
        isCallback, activeSession, hasName, consentEnabled: consentStatementEnabled()
      });
  return {
    ...template,
    messages: [{ role: "system", content }]
  };
}

async function startVapiCall({ assistantId, customerNumber, variableValues }) {
  const isCallback = variableValues?.IS_CALLBACK === "true";
  const activeSession = parseInt(variableValues?.ACTIVE_SESSION || "1", 10);
  const hasName = Boolean((variableValues?.PARTICIPANT_NAME || "").trim());
  const callKind = variableValues?.CALL_KIND || "interview";
  return vapiPost("/call", {
    assistantId,
    phoneNumberId: PHONE_NUMBER_ID,
    customer: { number: customerNumber },
    assistantOverrides: {
      variableValues,
      model: await buildModelOverride({ isCallback, activeSession, hasName, callKind })
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
  const callKind = variableValues?.CALL_KIND || "interview";
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
      model: await buildModelOverride({ isCallback, activeSession, hasName, callKind })
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

function buildVariableValues({ activeSession, priorSessionsContext, isCallback, participantName, country, callKind = "interview" }) {
  return {
    ACTIVE_SESSION: String(activeSession),
    PRIOR_SESSIONS_CONTEXT: priorSessionsContext || "",
    INTERVIEW_MAX_MINUTES: String(INTERVIEW_MAX_MINUTES),
    IS_CALLBACK: isCallback ? "true" : "false",
    SCREENING_QUESTIONS_JSON,
    PARTICIPANT_NAME: participantName || "",
    COUNTRY: country || "",
    CALL_KIND: callKind
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
      assistantId,
      // Optional naive local datetime string ("YYYY-MM-DDTHH:MM") from the
      // operator UI's <input type="datetime-local">. If present, the call is
      // scheduled for the future in the timezone inferred from the phone
      // number's country code. If empty/missing, the call dials immediately.
      scheduledAtLocal
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

    // Use the SUBMITTED name (this call's name), not whatever happens to
    // be stored on participants.name from a prior call. A blank submission
    // means PARTICIPANT_NAME="" for this call, which skips the identity
    // check. This also keeps the per-row dashboard display accurate.
    const submittedName = (name || "").trim();

    const variableValues = buildVariableValues({
      activeSession: sessionNumber,
      priorSessionsContext,
      isCallback: false,
      participantName: submittedName,
      country: inferCountryFromPhone(customerNumber)
    });

    // Decide between immediate dial and future schedule.
    let scheduledUtcIso = null;
    if (scheduledAtLocal && String(scheduledAtLocal).trim()) {
      const tz = inferTimezone(customerNumber);
      const utcDate = parseLocalDatetimeInTimezone(scheduledAtLocal, tz);
      if (!utcDate) {
        return res.status(400).json({ error: "scheduledAtLocal could not be parsed" });
      }
      if (utcDate.getTime() <= Date.now()) {
        return res.status(400).json({ error: "scheduledAtLocal is in the past" });
      }
      scheduledUtcIso = utcDate.toISOString();
    }

    const hasName = Boolean(submittedName);

    let vapiCallId = null;
    let vapiStatus = null;

    if (scheduledUtcIso) {
      // Future-scheduled: hand off to Vapi's native scheduler.
      const result = await vapiPost("/call", {
        assistantId: assistantId || ASSISTANT_ID,
        phoneNumberId: PHONE_NUMBER_ID,
        customer: { number: customerNumber },
        schedulePlan: { earliestAt: scheduledUtcIso },
        assistantOverrides: {
          variableValues,
          model: await buildModelOverride({ isCallback: false, activeSession: sessionNumber, hasName })
        }
      });
      vapiCallId = result?.id;
      vapiStatus = result?.status;
    } else {
      const started = await startVapiCall({
        assistantId: assistantId || ASSISTANT_ID,
        customerNumber,
        variableValues
      });
      vapiCallId = started?.id;
      vapiStatus = started?.status;
    }

    await setSessionCallId(session.id, vapiCallId);

    // Record a scheduled_calls row for the operator dashboard, regardless of
    // whether this is an immediate or future-scheduled dial. Immediate calls
    // use now() as scheduled_at so they still appear in the table view.
    // The submitted name is snapshotted onto the row so the dashboard's
    // Name column reflects what was submitted for THIS call — not a name
    // pulled from a different attempt on the same phone.
    try {
      await recordScheduledCall({
        participantId: participant.id,
        sessionNumber,
        scheduledAt: scheduledUtcIso || new Date().toISOString(),
        vapiCallId,
        nameAtCall: submittedName
      });
    } catch (e) {
      console.error("Failed to record scheduled_calls row:", e);
    }

    // Snapshot the live assistant config so we know which transcriber /
    // voice / model settings were active at the moment of this call.
    if (!scheduledUtcIso) {
      logCallConfigSnapshot(vapiCallId, assistantId || ASSISTANT_ID).catch(e =>
        console.warn("Config snapshot log failed:", e.message)
      );
    }

    return res.json({
      ok: true,
      callId: vapiCallId,
      sessionId: session.id,
      participantId: participant.id,
      status: vapiStatus,
      scheduledAt: scheduledUtcIso
    });
  } catch (err) {
    console.error("start-call error:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * POST /start-prescreening
 * Body: { customerNumber (req), name?, scheduledAtLocal? }
 * Places a screening call using the screening prompt and a
 * structured-data extraction schema. The participant answers 12 short
 * questions; the analysis runs at end-of-call and the extracted JSON is
 * upserted into the prescreening_responses table for the human analyst.
 */
app.post("/start-prescreening", async (req, res) => {
  try {
    if (START_CALL_API_KEY) {
      const provided = req.header("X-API-Key");
      if (provided !== START_CALL_API_KEY) {
        return res.status(401).json({ error: "Unauthorized: missing or invalid X-API-Key header" });
      }
    }

    const { customerNumber, name, scheduledAtLocal } = req.body || {};
    if (!customerNumber) return res.status(400).json({ error: "Missing customerNumber" });

    const participant = await upsertParticipant({ phoneNumber: customerNumber, name });
    const submittedName = (name || "").trim();
    const hasName = Boolean(submittedName);

    let scheduledUtcIso = null;
    if (scheduledAtLocal && String(scheduledAtLocal).trim()) {
      const tz = inferTimezone(customerNumber);
      const utcDate = parseLocalDatetimeInTimezone(scheduledAtLocal, tz);
      if (!utcDate) return res.status(400).json({ error: "scheduledAtLocal could not be parsed" });
      if (utcDate.getTime() <= Date.now()) return res.status(400).json({ error: "scheduledAtLocal is in the past" });
      scheduledUtcIso = utcDate.toISOString();
    }

    const variableValues = buildVariableValues({
      activeSession: 1,
      priorSessionsContext: "",
      isCallback: false,
      participantName: submittedName,
      country: inferCountryFromPhone(customerNumber),
      callKind: "prescreening"
    });

    // Compose model override with the prescreening prompt (NOT Imani's
    // interview prompt). Use the same model template otherwise so voice,
    // transcriber, and tool wiring stay identical.
    const template = await getModelTemplate();
    const model = {
      ...template,
      messages: [{ role: "system", content: loadPrescreeningPrompt({ hasName }) }]
    };

    // Per-call analysisPlan override carries the structured-data schema.
    // Vapi runs an extraction LLM after the call ends; the result lands
    // on call.analysis.structuredData and is delivered to our webhook.
    const analysisPlan = {
      structuredDataPlan: {
        enabled: true,
        schema: PRESCREENING_SCHEMA
      },
      summaryPlan: { enabled: true }
    };

    const baseBody = {
      assistantId: ASSISTANT_ID,
      phoneNumberId: PHONE_NUMBER_ID,
      customer: { number: customerNumber },
      assistantOverrides: { variableValues, model, analysisPlan }
    };
    const body = scheduledUtcIso
      ? { ...baseBody, schedulePlan: { earliestAt: scheduledUtcIso } }
      : baseBody;

    const result = await vapiPost("/call", body);
    const vapiCallId = result?.id;

    // Prescreening calls live exclusively in the prescreening_responses
    // table. The interview operator's scheduled_calls table is reserved
    // for interview sessions 1/2/3 (CHECK constraint enforces this). The
    // prescreening row is created by the end-of-call-report handler once
    // the analysis is available; for future-scheduled prescreening calls
    // there is no row until the call actually completes.

    return res.json({
      ok: true,
      callId: vapiCallId,
      participantId: participant.id,
      status: result?.status,
      scheduledAt: scheduledUtcIso
    });
  } catch (err) {
    console.error("start-prescreening error:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * GET /scheduled-calls
 * Returns scheduled_calls rows (future + recent past), joined with
 * participant info and the matching session status, for the operator
 * dashboard table. Auth: same X-API-Key gate as /start-call.
 */
app.get("/scheduled-calls", async (req, res) => {
  try {
    if (START_CALL_API_KEY) {
      const provided = req.header("X-API-Key");
      if (provided !== START_CALL_API_KEY) {
        return res.status(401).json({ error: "Unauthorized: missing or invalid X-API-Key header" });
      }
    }

    // Pull recent + future scheduled rows (within the last 7 days, plus all
    // future). The dashboard uses this for its single table view.
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const { data: scheduled, error: schedErr } = await supabase
      .from("scheduled_calls")
      .select("id, scheduled_at, session_number, vapi_call_id, participant_id, status, created_at, name_at_call, duration_seconds")
      .gt("scheduled_at", sevenDaysAgo)
      .neq("status", "cancelled")
      .order("scheduled_at", { ascending: true });
    if (schedErr) throw schedErr;

    // Reconcile each row against Vapi:
    // - Future rows still scheduled on Vapi → live, status='sent'.
    // - Future rows whose Vapi call was deleted/ended → mark cancelled.
    // - Past rows with status='sent' but Vapi call has ended → backfill
    //   status from Vapi's endedReason. Catches old rows that pre-date
    //   the per-row outcome tracking, and any row where end-of-call-report
    //   somehow missed updating us.
    const nowMs = Date.now();
    const verifications = await Promise.all((scheduled || []).map(async (s) => {
      if (!s.vapi_call_id) return { row: s, live: true };
      const isFuture = new Date(s.scheduled_at).getTime() > nowMs;
      const needsReconcile = isFuture || s.status === "sent";
      if (!needsReconcile) return { row: s, live: true };
      try {
        const resp = await fetch(`https://api.vapi.ai/call/${s.vapi_call_id}`, {
          headers: { Authorization: `Bearer ${VAPI_API_KEY}` }
        });
        if (resp.status === 404) return { row: s, live: false };
        if (!resp.ok) return { row: s, live: true };
        const call = await resp.json();
        if (call.status === "scheduled") return { row: s, live: true };
        if (call.status === "ended" && s.status === "sent") {
          // Backfill: derive a status from endedReason and persist.
          const derived = mapEndedReasonToStatus(call.endedReason);
          return { row: { ...s, status: derived }, live: true, backfillTo: derived };
        }
        // Ended call already reconciled (status != 'sent').
        return { row: s, live: true };
      } catch {
        return { row: s, live: true };
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

    const backfills = verifications.filter(v => v.live && v.backfillTo);
    await Promise.all(backfills.map(v =>
      supabase.from("scheduled_calls").update({ status: v.backfillTo }).eq("id", v.row.id)
    ));

    const liveRows = verifications.filter(v => v.live).map(v => v.row);

    // Bulk-fetch participants for phone/name display.
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
      // scheduled_calls.status is the per-attempt outcome. "sent" means
      // the call was placed/scheduled but no outcome recorded yet — show
      // as "scheduled" in the dashboard.
      const callStatus = s.status === "sent" ? "scheduled" : s.status;
      // The Name column comes from the per-row snapshot, not the
      // participants table. Old rows that pre-date the name_at_call
      // column will show blank; that's intentional.
      return {
        scheduledCallId: s.id,
        scheduledAt: s.scheduled_at,
        phoneNumber: p.phone_number || null,
        name: s.name_at_call || null,
        sessionNumber: s.session_number,
        vapiCallId: s.vapi_call_id,
        callStatus,
        notes: statusToNotesLabel(callStatus),
        completed: ["completed", "completed_at_cap"].includes(callStatus),
        durationSeconds: s.duration_seconds
      };
    });

    return res.json({ ok: true, count: rows.length, rows });
  } catch (err) {
    console.error("scheduled-calls error:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * GET /prescreening-responses
 * Returns all prescreening_responses rows with participant phone/name and
 * a derived "interviewCalled" flag (true if any interview call exists for
 * the participant). Auth: same X-API-Key gate as the other endpoints.
 */
app.get("/prescreening-responses", async (req, res) => {
  try {
    if (START_CALL_API_KEY) {
      const provided = req.header("X-API-Key");
      if (provided !== START_CALL_API_KEY) {
        return res.status(401).json({ error: "Unauthorized: missing or invalid X-API-Key header" });
      }
    }

    const { data: rows, error } = await supabase
      .from("prescreening_responses")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) throw error;

    const participantIds = [...new Set((rows || []).map(r => r.participant_id).filter(Boolean))];
    let participantsById = {};
    let interviewCalledIds = new Set();
    if (participantIds.length > 0) {
      const { data: parts } = await supabase
        .from("participants")
        .select("id, phone_number, name")
        .in("id", participantIds);
      participantsById = Object.fromEntries((parts || []).map(p => [p.id, p]));

      // Any scheduled_calls row for these participants implies an interview
      // attempt (the scheduled_calls table is interview-only — session_number
      // CHECK constraint enforces 1/2/3).
      const { data: ic } = await supabase
        .from("scheduled_calls")
        .select("participant_id")
        .in("participant_id", participantIds)
        .neq("status", "cancelled");
      interviewCalledIds = new Set((ic || []).map(x => x.participant_id));
    }

    const out = (rows || []).map(r => {
      const p = participantsById[r.participant_id] || {};
      return {
        id: r.id,
        participantId: r.participant_id,
        phoneNumber: p.phone_number || null,
        // Name displayed is the per-call snapshot, NOT participants.name.
        // Old rows without a snapshot show blank — the user has confirmed
        // they don't care about historical accuracy.
        name: r.name_at_call || null,
        vapiCallId: r.vapi_call_id,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        durationSeconds: r.duration_seconds,
        // Responses
        aboutYou: r.about_you_text,
        englishInterviewOk: r.english_interview_ok,
        robotRecordedOk: r.robot_recorded_ok,
        whatsappPhotosOk: r.whatsapp_photos_ok,
        mainCook: r.main_cook,
        ownsEpc: r.owns_epc,
        epcUsesLastWeek: r.epc_uses_last_week,
        age: r.age,
        ownsTv: r.owns_tv,
        ownsFridge: r.owns_fridge,
        ownsCar: r.owns_car,
        pipedWater: r.piped_water,
        ppiScore: r.ppi_score,
        needsFollowup: r.needs_followup,
        followupNotes: r.followup_notes,
        // Analyst flags
        disqualified: r.disqualified,
        forceActive: r.force_active,
        analystNotes: r.analyst_notes,
        // Derived
        interviewCalled: interviewCalledIds.has(r.participant_id)
      };
    });

    return res.json({ ok: true, count: out.length, rows: out });
  } catch (err) {
    console.error("GET /prescreening-responses error:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * DELETE /prescreening-responses/:id
 * Hard-delete a prescreening row from the analyst dashboard. The
 * participant row is left alone (they may have other history). Auth:
 * same X-API-Key gate.
 */
app.delete("/prescreening-responses/:id", async (req, res) => {
  try {
    if (START_CALL_API_KEY) {
      const provided = req.header("X-API-Key");
      if (provided !== START_CALL_API_KEY) {
        return res.status(401).json({ error: "Unauthorized: missing or invalid X-API-Key header" });
      }
    }
    const { id } = req.params;
    if (!id) return res.status(400).json({ error: "Missing id" });
    const { error } = await supabase
      .from("prescreening_responses")
      .delete()
      .eq("id", id);
    if (error) throw error;
    return res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /prescreening-responses error:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * PATCH /prescreening-responses/:id
 * Analyst-controlled flags: disqualified, force_active, analyst_notes.
 * Body: any subset of those fields. Auth: same X-API-Key gate.
 */
app.patch("/prescreening-responses/:id", async (req, res) => {
  try {
    if (START_CALL_API_KEY) {
      const provided = req.header("X-API-Key");
      if (provided !== START_CALL_API_KEY) {
        return res.status(401).json({ error: "Unauthorized: missing or invalid X-API-Key header" });
      }
    }
    const { id } = req.params;
    const { disqualified, force_active, analyst_notes } = req.body || {};
    const updates = { updated_at: new Date().toISOString() };
    if (typeof disqualified === "boolean") updates.disqualified = disqualified;
    if (typeof force_active === "boolean") updates.force_active = force_active;
    if (typeof analyst_notes === "string") updates.analyst_notes = analyst_notes;
    const { error } = await supabase
      .from("prescreening_responses")
      .update(updates)
      .eq("id", id);
    if (error) throw error;
    return res.json({ ok: true });
  } catch (err) {
    console.error("PATCH /prescreening-responses error:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * DELETE /scheduled-calls/:id
 * Cancel a scheduled call: delete the Vapi-side schedule (if any),
 * mark the Supabase row as cancelled.
 */
app.delete("/scheduled-calls/:id", async (req, res) => {
  try {
    if (START_CALL_API_KEY) {
      const provided = req.header("X-API-Key");
      if (provided !== START_CALL_API_KEY) {
        return res.status(401).json({ error: "Unauthorized: missing or invalid X-API-Key header" });
      }
    }
    const { id } = req.params;
    if (!id) return res.status(400).json({ error: "Missing id" });

    const { data: row, error: fetchErr } = await supabase
      .from("scheduled_calls")
      .select("id, vapi_call_id, scheduled_at")
      .eq("id", id)
      .maybeSingle();
    if (fetchErr) throw fetchErr;
    if (!row) return res.status(404).json({ error: "scheduled_calls row not found" });

    // Best-effort Vapi delete (only for future-scheduled rows whose Vapi call
    // still exists). Past calls will not have a deletable Vapi resource.
    if (row.vapi_call_id) {
      try {
        const resp = await fetch(`https://api.vapi.ai/call/${row.vapi_call_id}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${VAPI_API_KEY}` }
        });
        if (!resp.ok && resp.status !== 404) {
          console.warn(`Vapi DELETE for ${row.vapi_call_id} returned ${resp.status}`);
        }
      } catch (e) {
        console.warn("Vapi DELETE failed (continuing):", e.message);
      }
    }

    const { error: updateErr } = await supabase
      .from("scheduled_calls")
      .update({ status: "cancelled" })
      .eq("id", id);
    if (updateErr) throw updateErr;

    return res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /scheduled-calls error:", err);
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

        // Detect call kind. Prescreening calls are short and do not need
        // the interview's three-stage close-out (wrap-up signal, force
        // close, hard cap), nor do they have a sessions row to update.
        // Skip all of that and let the bot's own end-of-flow close out
        // naturally.
        const callKind = message?.call?.assistantOverrides?.variableValues?.CALL_KIND || "interview";
        if (callKind === "prescreening") {
          console.log("status-update in-progress: prescreening call, skipping interview close-out timers", { callId });
          return res.json({});
        }

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
        const callKind = liveVars.CALL_KIND || "interview";

        const scheduled = await scheduleVapiCallback({
          assistantId: assistantIdForCallback,
          customerNumber,
          earliestAtIso: utcTarget.toISOString(),
          variableValues: buildVariableValues({
            activeSession: currentSession,
            priorSessionsContext: priorContext,
            isCallback: true,
            participantName,
            country: inferCountryFromPhone(customerNumber),
            callKind
          })
        });

        markScheduled(callId || `${customerNumber}:${suggestedTime}`);

        try {
          const { data: p } = await supabase
            .from("participants")
            .select("id")
            .eq("phone_number", customerNumber)
            .maybeSingle();
          if (p?.id && callKind === "interview") {
            // Interview callbacks get a scheduled_calls row for the
            // operator dashboard. Prescreening callbacks do not — they
            // land in prescreening_responses only when the call completes.
            await recordScheduledCall({
              participantId: p.id,
              sessionNumber: currentSession,
              scheduledAt: utcTarget.toISOString(),
              vapiCallId: scheduled?.id,
              nameAtCall: participantName
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

      // ---- prescreening_complete: end-of-prescreening close + hang up ----
      // The tool itself carries the verbatim close in request-complete +
      // endCallAfterSpokenEnabled. Server just acknowledges the invocation
      // so Vapi proceeds with the request-complete + auto-hangup. Without
      // this handler the webhook would never respond and the model would
      // loop, re-invoking prescreening_complete repeatedly until eventually
      // giving up with a plain endCall.
      if (fn?.name === "prescreening_complete") {
        return res.json({
          results: [{
            toolCallId: toolCall.toolCallId || toolCall.id,
            result: "Closing call."
          }]
        });
      }

      // ---- report_wrong_number: third party confirmed this is a wrong number ----
      if (fn?.name === "report_wrong_number") {
        const customerNumber = message?.call?.customer?.number;
        const currentVapiCallId = message?.call?.id;
        const liveVars = message?.call?.assistantOverrides?.variableValues || {};
        const currentSession = parseInt(liveVars.ACTIVE_SESSION || "1", 10);
        const callKind = liveVars.CALL_KIND || "interview";
        try {
          const { data: p } = await supabase
            .from("participants")
            .select("id")
            .eq("phone_number", customerNumber)
            .maybeSingle();
          if (p?.id && callKind === "interview") {
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
        await updateScheduledCallStatusByVapiId(currentVapiCallId, "wrong_number");
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
        const callKind = liveVars.CALL_KIND || "interview";

        const scheduled = await scheduleVapiCallback({
          assistantId: assistantIdForCallback,
          customerNumber,
          earliestAtIso: utcTarget.toISOString(),
          variableValues: buildVariableValues({
            activeSession: currentSession,
            priorSessionsContext: "",
            isCallback: false,
            participantName,
            country: inferCountryFromPhone(customerNumber),
            callKind
          })
        });

        try {
          const { data: p } = await supabase
            .from("participants")
            .select("id")
            .eq("phone_number", customerNumber)
            .maybeSingle();
          if (p?.id && callKind === "interview") {
            await recordScheduledCall({
              participantId: p.id,
              sessionNumber: currentSession,
              scheduledAt: utcTarget.toISOString(),
              vapiCallId: scheduled?.id,
              nameAtCall: participantName
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

        // Mark the CURRENT call's scheduled_calls row (not the newly-
        // scheduled future one) as rescheduled_unreached, so the dashboard
        // accurately shows what happened on this attempt.
        const currentVapiCallId = message?.call?.id;
        await updateScheduledCallStatusByVapiId(currentVapiCallId, "rescheduled_unreached");

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
              vapiCallId: scheduled?.id,
              nameAtCall: participantName
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
      const endedReason =
        message?.endedReason ||
        call?.endedReason ||
        message?.call?.endedReason ||
        "";

      // Detect prescreening calls and route the analysis output into the
      // prescreening_responses table. This runs BEFORE the regular interview
      // path so we don't try to update sessions/scheduled_calls for a call
      // that isn't an interview.
      const callKind = call?.assistantOverrides?.variableValues?.CALL_KIND
        || message?.call?.assistantOverrides?.variableValues?.CALL_KIND
        || "interview";
      if (callKind === "prescreening") {
        await handlePrescreeningEndOfCall({ message, call, customerNumber, callId });
        return res.json({});
      }
      const transcript =
        message?.artifact?.transcript ||
        call?.artifact?.transcript ||
        message?.transcript ||
        call?.transcript ||
        "";
      const transcriptStructured =
        message?.artifact?.messages || call?.artifact?.messages || null;

      if (callId) {
        // Don't overwrite tool-set terminal states (wrong_number,
        // rescheduled_unreached). For everything else, map Vapi's
        // endedReason to a richer status so the dashboard Notes column
        // can show things like "No answer" / "Invalid number".
        const { data: existing } = await supabase
          .from("sessions")
          .select("status")
          .eq("call_id", callId)
          .maybeSingle();
        const toolSetTerminals = new Set(["wrong_number", "rescheduled_unreached"]);
        let finalStatus;
        if (existing && toolSetTerminals.has(existing.status)) {
          finalStatus = existing.status;
          await updateSessionByCallId(callId, {
            completed_at: new Date().toISOString(),
            transcript: transcriptStructured || (transcript ? { plain: transcript } : null)
          });
        } else {
          finalStatus = mapEndedReasonToStatus(endedReason);
          await updateSessionByCallId(callId, {
            status: finalStatus,
            completed_at: new Date().toISOString(),
            transcript: transcriptStructured || (transcript ? { plain: transcript } : null)
          });
        }
        // Mirror the final status onto the matching scheduled_calls row so
        // the dashboard can show per-attempt outcomes accurately. Each
        // attempt has its own scheduled_calls row keyed by vapi_call_id;
        // joining sessions by (participant, session_number) would lose
        // older attempts when newer ones overwrite the sessions row.
        // Compute duration from start/end timestamps too so the dashboard
        // can flag short / prematurely-ended calls.
        const ivStartedAt = call?.startedAt || message?.call?.startedAt;
        const ivEndedAt   = call?.endedAt   || message?.call?.endedAt;
        let ivDurationSeconds = null;
        if (ivStartedAt && ivEndedAt) {
          const ms = new Date(ivEndedAt).getTime() - new Date(ivStartedAt).getTime();
          if (!isNaN(ms) && ms > 0) ivDurationSeconds = Math.round(ms / 1000);
        }
        const updates = { status: finalStatus };
        if (ivDurationSeconds != null) updates.duration_seconds = ivDurationSeconds;
        const { error: scUpdErr } = await supabase
          .from("scheduled_calls")
          .update(updates)
          .eq("vapi_call_id", callId);
        if (scUpdErr) console.warn("scheduled_calls update failed:", scUpdErr.message);
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
    const callKind = variableValues?.CALL_KIND || "interview";
    const result = await vapiPost("/call", {
      assistantId,
      phoneNumberId: PHONE_NUMBER_ID,
      customer: { number: customerNumber },
      assistantOverrides: {
        variableValues,
        model: await buildModelOverride({ isCallback, activeSession, hasName, callKind })
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
