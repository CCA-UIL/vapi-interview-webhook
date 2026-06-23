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

// Optional shared token for the read-only transcript proxy endpoints
// (/transcript/:callId, /transcripts/recent). Used by Claude's
// web_fetch tool, which can't pass arbitrary auth headers — so the
// gate is a query param (?token=...). If unset, the endpoints are
// open (acceptable because they only expose data already accessible
// via the Vapi dashboard with the API key, but the URL isn't
// publicly advertised).
const TRANSCRIPT_PROXY_TOKEN = process.env.TRANSCRIPT_PROXY_TOKEN;

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

// Return just the ISO alpha-2 country code (e.g. "NG", "US") for the
// destination number, or "" if unparseable. Used by getPhoneNumberId to
// route the outbound dial to the right Vapi phone number (BYO trunk per
// country, because cost varies by carrier and country).
function inferIsoCountry(phoneNumber) {
  if (!phoneNumber) return "";
  try {
    const parsed = parsePhoneNumberFromString(phoneNumber);
    return (parsed && parsed.country) || "";
  } catch {
    return "";
  }
}

// Map from ISO alpha-2 country code → Vapi phone number ID, for
// country-specific carrier routing. Phone number IDs are NOT secrets;
// hard-coding them in the repo is fine. To add a country: look up the
// Vapi phone number ID in the Vapi dashboard (Phone Numbers tab) and
// add an entry below.
//
// Calls to countries NOT in this map fall back to PHONE_NUMBER_ID
// (the env var), so removing an entry or starting with an empty map
// preserves the previous single-trunk behaviour.
const COUNTRY_PHONE_NUMBER_IDS = {
  NG: "bb809460-d4c9-4fdf-9e9d-7a78b2a0181b",  // Nigeria (KrosAI BYO trunk)
  // US: "phnum_yyyyyyyyyyyyyyyyy",  // United States
  // KE: "phnum_zzzzzzzzzzzzzzzzz",  // Kenya
};

// Pick the right Vapi phone number ID for an outbound call based on the
// destination country. Falls back to the PHONE_NUMBER_ID env var when
// the destination country isn't in COUNTRY_PHONE_NUMBER_IDS.
function getPhoneNumberId(customerNumber) {
  const iso = inferIsoCountry(customerNumber);
  if (iso && COUNTRY_PHONE_NUMBER_IDS[iso]) {
    return COUNTRY_PHONE_NUMBER_IDS[iso];
  }
  if (iso) {
    console.log(`getPhoneNumberId: no entry for ${iso} (number=${customerNumber}); using PHONE_NUMBER_ID fallback`);
  } else {
    console.warn(`getPhoneNumberId: could not infer country from ${customerNumber}; using PHONE_NUMBER_ID fallback`);
  }
  return PHONE_NUMBER_ID;
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
  // Normalize period-bearing AM/PM markers ("p.m.", "a.m.", "P.M.")
  // BEFORE lowercasing the rest of the string so the ampm regex below
  // can match bare \bam\b / \bpm\b. Without this, "tomorrow at 7:00
  // p.m." matched the hm24 regex as "7:00" → 7am, dropping the PM
  // entirely. Real production bug: call 019eb822 scheduled the
  // callback for 6:00 UTC (7am Nigeria) instead of 18:00 UTC (7pm
  // Nigeria), participant was asleep and the call failed with SIP 480.
  const lower = suggestedTimeText
    .toLowerCase()
    .replace(/\bp\.\s*m\.?/g, "pm")
    .replace(/\ba\.\s*m\.?/g, "am");

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

  // ampm MUST be checked BEFORE hm24. "7:00 pm" matches both regexes,
  // but the hm24 pattern doesn't see the trailing "pm" and would
  // interpret it as bare 24-hour 7:00 (= 7am). Check ampm first so the
  // +12 hour shift gets applied for PM times.
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

  // hm24: bare 24-hour "14:30" with no am/pm suffix. Only reached
  // when the ampm check above failed.
  const hm24 = lower.match(/\b(at\s*)?(\d{1,2}):(\d{2})\b/);
  if (hm24) {
    targetLocal.setHours(parseInt(hm24[2], 10), parseInt(hm24[3], 10), 0, 0);
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

// Fetch summaries for all prior completed sessions of a participant and
// assemble them into the prose blob that the prompt's
// <prior_sessions_context> block expects (with "From the first
// conversation:" / "From the second conversation:" section headers). For
// Session 1 dials returns empty context (no prior sessions). For Session
// 2/3 dials, surfaces a `missing` array listing prior session_numbers
// that have no stored summary — caller uses that to enforce the
// block-on-missing-summary policy at /start-call.
async function loadPriorSessionsContext({ participantId, sessionNumber }) {
  if (!participantId || sessionNumber < 2) {
    return { context: "", warnings: [], missing: [] };
  }
  const priorSessionNumbers = [];
  for (let n = 1; n < sessionNumber; n++) priorSessionNumbers.push(n);

  const { data, error } = await supabase
    .from("sessions")
    .select("session_number, summary, status, completed_at")
    .eq("participant_id", participantId)
    .in("session_number", priorSessionNumbers);
  if (error) {
    console.warn("loadPriorSessionsContext: query failed", { error: error.message });
    return { context: "", warnings: [`Failed to load prior sessions: ${error.message}`], missing: priorSessionNumbers };
  }

  const byNum = Object.fromEntries((data || []).map(r => [r.session_number, r]));
  const orderedHeaders = {
    1: "From the first conversation:",
    2: "From the second conversation:"
  };
  const parts = [];
  const warnings = [];
  const missing = [];
  for (const n of priorSessionNumbers) {
    const row = byNum[n];
    if (!row || !row.summary || !row.summary.trim()) {
      warnings.push(`Session ${n} has no stored summary (status=${row?.status || "no row"}).`);
      missing.push(n);
      continue;
    }
    parts.push(`${orderedHeaders[n]}\n${row.summary.trim()}`);
  }
  const context = parts.join("\n\n");
  if (context.length > 20000) {
    console.warn("loadPriorSessionsContext: context unusually long", {
      participantId, sessionNumber, contextLength: context.length
    });
  }
  return { context, warnings, missing };
}

// Fetch a Vapi call's transcript-so-far via the API. Safe to call while the
// call is still in progress — Vapi returns the transcript accumulated up to
// the moment of the GET. Returns "" on any failure (network, 404, missing
// artifact). Used by buildResumedTranscript when scheduling a callback so
// the rescheduled call can resume from where the conversation left off.
async function fetchVapiCallTranscript(vapiCallId) {
  if (!vapiCallId) return "";
  try {
    const resp = await fetch(`https://api.vapi.ai/call/${vapiCallId}`, {
      headers: { Authorization: `Bearer ${VAPI_API_KEY}` }
    });
    if (!resp.ok) {
      console.warn(`fetchVapiCallTranscript: GET /call/${vapiCallId} returned ${resp.status}`);
      return "";
    }
    const data = await resp.json();
    return (data.artifact && data.artifact.transcript) || "";
  } catch (e) {
    console.warn("fetchVapiCallTranscript failed", { vapiCallId, error: String(e) });
    return "";
  }
}

// In-memory counter for auto-retries after a drop, keyed by
// `${participantId}:${sessionNumber}`. Resets on server restart (acceptable
// MVP — operator can manually retry from the dashboard). Used by the
// end-of-call-report handler to cap how many times we auto-redial after
// an unexpected call drop in the same session.
const AUTO_RETRY_CAP = 2;
const AUTO_RETRY_DELAY_SECONDS = 30;
const autoRetryCountBySession = new Map();

function autoRetryKey(participantId, sessionNumber) {
  return `${participantId}:${sessionNumber}`;
}

// Daytime retry policy for dial-time failures where the participant was
// NEVER reachable (busy, no-answer, voicemail). Different from mid-call
// drops — the participant simply wasn't around. Keep trying at hourly
// intervals during daytime only (local timezone, inferred from the
// participant's phone country code via inferTimezone) until
// DAYTIME_RETRY_CAP is hit. State persisted in the daytime_retries
// Supabase table so chains survive Render restarts.
const DAYTIME_RETRY_CAP = parseInt(process.env.DAYTIME_RETRY_CAP || "4", 10);
const DAYTIME_RETRY_INTERVAL_MINUTES = parseInt(process.env.DAYTIME_RETRY_INTERVAL_MINUTES || "60", 10);
const DAYTIME_WINDOW_START_HOUR = parseInt(process.env.DAYTIME_WINDOW_START_HOUR || "8", 10);
const DAYTIME_WINDOW_END_HOUR = parseInt(process.env.DAYTIME_WINDOW_END_HOUR || "20", 10);

// Compute the next dial time at least intervalMinutes from now, snapped
// into the participant's local daytime window [START_HOUR, END_HOUR).
// If `now + intervalMinutes` lands at night, push forward to the next
// day's START_HOUR. Returns a Date (UTC) for scheduleVapiCallback.
function nextDaytimeDialTime({ customerNumber, intervalMinutes }) {
  const tz = inferTimezone(customerNumber);
  const nowUtc = new Date();
  const proposedUtc = new Date(nowUtc.getTime() + intervalMinutes * 60 * 1000);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false
  });
  const parts = Object.fromEntries(fmt.formatToParts(proposedUtc).map(p => [p.type, p.value]));
  const localHour = parseInt(parts.hour, 10) % 24;
  if (localHour >= DAYTIME_WINDOW_START_HOUR && localHour < DAYTIME_WINDOW_END_HOUR) {
    return proposedUtc;
  }
  // Outside window — push to next-day START_HOUR. If we're already past
  // END_HOUR for today (localHour >= END), next day is +1. If we're
  // before START today (localHour < START), today's START is fine.
  let targetDayOffset = 0;
  if (localHour >= DAYTIME_WINDOW_END_HOUR) targetDayOffset = 1;
  const localProxy = new Date(proposedUtc);
  // Use the parts we already have for date arithmetic — proposedUtc's
  // date in the tz is parts.year/parts.month/parts.day.
  const y = parseInt(parts.year, 10);
  const mo = parseInt(parts.month, 10) - 1;
  const da = parseInt(parts.day, 10) + targetDayOffset;
  const hh = String(DAYTIME_WINDOW_START_HOUR).padStart(2, "0");
  // Build a naive local datetime "YYYY-MM-DDTHH:00" in the tz; reuse
  // parseLocalDatetimeInTimezone which knows how to convert local->UTC.
  const ymd = `${y}-${String(mo + 1).padStart(2, "0")}-${String(da).padStart(2, "0")}`;
  const naiveLocal = `${ymd}T${hh}:00`;
  const snapped = parseLocalDatetimeInTimezone(naiveLocal, tz);
  return snapped || proposedUtc;
}

// Decide whether a just-ended call should fire a daytime-hourly retry.
// Returns a reason string or null. Distinct from shouldAutoRetryAfterDrop
// — that handles mid-call drops with a 30-second quick retry. This one
// handles dial-time unreachable failures (busy/no-answer/voicemail).
function shouldDaytimeRetry({ endedReason, transcriptStructured, callKind }) {
  if (callKind !== "interview") return null;
  const r = String(endedReason || "").toLowerCase();
  // Exclude bot-initiated terminations and bad-number cases.
  if (r === "assistant-ended-call") return null;
  if (r === "assistant-ended-call-after-message-spoken") return null;
  if (r.includes("invalid")) return null;
  // Mid-call drops have a participant user-turn in the transcript;
  // shouldAutoRetryAfterDrop handles those. We only fire when the
  // participant was never on the line at all.
  const hadParticipantOnLine =
    Array.isArray(transcriptStructured) &&
    transcriptStructured.some(m => m.role === "user");
  if (hadParticipantOnLine) return null;
  if (r.includes("did-not-answer") || r.includes("no-answer")) return "no-answer";
  if (r.includes("voicemail")) return "voicemail";
  if (r.startsWith("customer-busy")) return "busy";
  return null;
}

// Supabase-persisted daytime retry counter. Survives Render restarts so
// the chain isn't broken by a redeploy.
async function getDaytimeRetryState({ participantId, sessionNumber }) {
  const { data, error } = await supabase
    .from("daytime_retries")
    .select("attempts, last_attempt_at, declined")
    .eq("participant_id", participantId)
    .eq("session_number", sessionNumber)
    .maybeSingle();
  if (error) {
    console.warn("getDaytimeRetryState failed:", error.message);
    return { attempts: 0, declined: false };
  }
  return data || { attempts: 0, declined: false };
}

async function incrementDaytimeRetryCount({ participantId, sessionNumber }) {
  const current = await getDaytimeRetryState({ participantId, sessionNumber });
  const attempts = (current.attempts || 0) + 1;
  const { error } = await supabase
    .from("daytime_retries")
    .upsert({
      participant_id: participantId,
      session_number: sessionNumber,
      attempts,
      last_attempt_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }, { onConflict: "participant_id,session_number" });
  if (error) console.warn("incrementDaytimeRetryCount failed:", error.message);
  return attempts;
}

async function resetDaytimeRetryCount({ participantId, sessionNumber }) {
  const { error } = await supabase
    .from("daytime_retries")
    .delete()
    .eq("participant_id", participantId)
    .eq("session_number", sessionNumber);
  if (error) console.warn("resetDaytimeRetryCount failed:", error.message);
}

// Stop a daytime-retry chain because the participant explicitly declined.
// Called when the bot's endCall fires after a callback is refused —
// the next dial-time failure for the same (participant, session) won't
// kick off another retry chain.
async function markDaytimeRetryDeclined({ participantId, sessionNumber }) {
  const { error } = await supabase
    .from("daytime_retries")
    .upsert({
      participant_id: participantId,
      session_number: sessionNumber,
      declined: true,
      updated_at: new Date().toISOString()
    }, { onConflict: "participant_id,session_number" });
  if (error) console.warn("markDaytimeRetryDeclined failed:", error.message);
}

// Pending schedule_callback intents, keyed by the current Vapi call ID.
// schedule_callback fires MID-CALL, but Vapi's artifact.transcript isn't
// populated until the call ends. To pass a complete prior-call transcript
// into the rescheduled call (the resume-from-callback mechanism), we
// store the callback intent here when the tool fires and drain it at
// end-of-call-report when the full transcript is available directly in
// the webhook payload. Resets on server restart — if the server crashes
// between schedule_callback and end-of-call-report, the participant
// won't get called back. For the pilot's scale this is acceptable;
// persist to Supabase if it becomes a real reliability issue.
const pendingCallbacksByCallId = new Map();

// Decide whether a just-ended call should be auto-redialed because it
// looks like an unexpected drop (carrier error, silence timeout, or a
// customer hangup that didn't go through the normal scheduling/closing
// flow). Returns a string reason when retry is warranted, or null when
// the call ended through a known/intended path.
function shouldAutoRetryAfterDrop({ endedReason, transcriptStructured, callKind }) {
  if (callKind !== "interview") return null;
  const r = String(endedReason || "").toLowerCase();

  // Bot-initiated endCall covers: end-of-session close, consent decline +
  // thanks, sustained refusal (including "don't call back"), wrong number
  // flow, and the schedule_next_session tool's request-complete. All of
  // these are intentional terminations — never auto-retry.
  if (r === "assistant-ended-call") return null;
  if (r === "assistant-ended-call-after-message-spoken") return null;

  // Hard cap fired: call hit max length. Natural completion.
  if (r.includes("exceeded-max-duration")) return null;

  // Dial-time failures where the participant is reachable but chose
  // not to engage (no answer, voicemail, busy) or where the number is
  // bad. Not retried by this mechanism. A separate no-answer retry
  // strategy could cover these later.
  if (r.includes("did-not-answer") || r.includes("no-answer")) return null;
  if (r.includes("voicemail")) return null;
  if (r.startsWith("customer-busy")) return null;
  if (r.includes("invalid")) return null;

  // Did the participant actually make it onto the line? Used to
  // distinguish a pre-connect SIP/provider failure (no transcript, no
  // resume context — retry like a fresh attempt) from a mid-call drop
  // (transcript exists — use the "our call dropped" greeting + resume
  // mechanism). More reliable than substring-matching the reason
  // string, which has many provider-specific shapes.
  const hadParticipantOnLine =
    Array.isArray(transcriptStructured) &&
    transcriptStructured.some(m => m.role === "user");

  // Customer hung up mid-session: only retry if they didn't go through
  // normal scheduling/closing/wrong-number paths. If schedule_callback
  // fired, they already get a follow-up via the user-initiated
  // mechanism.
  if (r === "customer-ended-call") {
    const toolNames = (transcriptStructured || [])
      .filter(m => m.role === "tool_calls")
      .flatMap(m => (m.toolCalls || []).map(tc => tc.function && tc.function.name).filter(Boolean));
    if (toolNames.includes("schedule_callback")) return null;
    if (toolNames.includes("schedule_next_session")) return null;
    if (toolNames.includes("report_wrong_number")) return null;
    return "customer-hung-up-mid-session";
  }

  // Silence timeout mid-call: participant probably stepped away or is
  // in a noisy environment. Auto-redial once gives a clean second
  // chance.
  if (r.includes("silence-timed-out")) return "silence-timed-out";

  // SIP / provider errors. Two sub-cases:
  // - participant never on the line → "failed-to-connect" (sporadic
  //   trunk/provider faults on the BYO carrier, observed in production
  //   for valid numbers).
  // - participant was on the line → "carrier-drop" (true mid-call drop).
  if (r.startsWith("call.in-progress.error-")) {
    return hadParticipantOnLine ? "carrier-drop" : "failed-to-connect";
  }

  return null;
}

// Assemble the transcript that the bot will see on a callback so it can
// resume from where it left off. Concatenates the prior chain (transcripts
// from earlier callback attempts in this same session) with the current
// call's transcript-so-far, joined by a clear separator. Caps the total
// length so a long callback chain doesn't bloat the prompt.
//
// MAX_CHARS chosen as ~30000 chars ≈ ~7500 input tokens — small relative
// to the existing 167KB system prompt, but enough to hold roughly an
// hour of dense conversation. Truncates from the FRONT (keep the most
// recent content) when over the cap.
async function buildResumedTranscript({ currentCallId, priorChainTranscript = "" }) {
  const currentTranscript = await fetchVapiCallTranscript(currentCallId);
  const parts = [priorChainTranscript, currentTranscript]
    .map(s => (s || "").trim())
    .filter(Boolean);
  if (parts.length === 0) return "";
  let combined = parts.join("\n\n--- [next call attempt] ---\n\n");
  const MAX_CHARS = 30000;
  if (combined.length > MAX_CHARS) {
    combined = "(... earlier portions of this call chain truncated for length; the most recent ~30k characters follow ...)\n\n" + combined.slice(-MAX_CHARS);
  }
  return combined;
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

// Vapi analysisPlan.summaryPlan settings for interview calls. Generates
// the prose summary that gets persisted to sessions.summary and reused
// as PRIOR_SESSIONS_CONTEXT for the participant's next session. The
// system prompt forces UPPERCASE section headers (HOUSEHOLD AND
// ENVIRONMENT:, COOKING RHYTHM:, etc.) so the prompt's
// <prior_sessions_context> block reads back consistently across
// participants. Word range keeps it dense without truncating
// cross-session bridges; the bot reads this on Session 2/3 opens.
const INTERVIEW_SUMMARY_PLAN = {
  enabled: true,
  messages: [
    {
      role: "system",
      content: "You are a research assistant summarising an ethnographic interview transcript for the same interviewer who will conduct the participant's NEXT session days later. Write in plain prose using SECTION HEADERS IN UPPERCASE (e.g., \"HOUSEHOLD AND ENVIRONMENT:\", \"COOKING RHYTHM AND DECISIONS:\", \"COOKING IDENTITY AND LEARNING:\", \"GENDER ROLES AND SOCIAL EXPECTATIONS:\", \"ELECTRIC PRESSURE COOKER USE:\", \"KEY THEMES:\"). Match these section conventions if the topics arose; omit sections that did not. Capture concrete details: household composition, kitchens, appliances, named dishes, named people, decisions, costs, and any phrases the participant said verbatim that carry distinctive language. Use the participant's own words where they used distinctive language. Length: 1500-2500 words. Do not invent details. Do not add greetings, sign-offs, or meta-commentary. Output the prose only."
    },
    {
      role: "user",
      content: "Transcript:\n\n{{transcript}}"
    }
  ],
  timeoutSeconds: 60
};

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

function loadPromptForCall({ isCallback, activeSession = 1, hasName = false, consentEnabled = true, testMilestones = null, includeClose = false, resumedFromTranscript = "" }) {
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

  // Test mode: strip everything that isn't one of the selected milestones,
  // plus all opening / consent scaffolding. The closing protocol is
  // stripped ONLY when includeClose is false (the default); when
  // includeClose is true (via the "end" keyword), the closing_protocol
  // and next_session_scheduling blocks are left intact so the operator
  // can test that schedule_next_session fires correctly. Inject a
  // <test_mode> instruction block at the top of <system_prompt>. This
  // path only runs when the operator explicitly passed testMilestones
  // on /start-call (parseTestMilestones returned a non-null list).
  if (Array.isArray(testMilestones) && testMilestones.length > 0) {
    const selected = new Set(testMilestones);

    // Strip all session-opening / consent / identity scaffolding. These
    // overlap with the per-session strips above, but we redo them
    // unconditionally here to cover all activeSession values cleanly.
    stripBlock("session_1_initial_call_flow", "stripped by test mode");
    stripBlock("session_1_callback_flow", "stripped by test mode");
    stripBlock("session_2_opening_protocol", "stripped by test mode");
    stripBlock("session_3_opening_protocol", "stripped by test mode");
    stripNestedBlock("step_0_identity_check", "stripped by test mode");

    // Only strip the closing protocol when NOT testing close. When
    // includeClose is true ("end" keyword), keep these intact — the
    // bot needs them to run the real close-out + scheduling exchange.
    if (!includeClose) {
      stripBlock("closing_protocol", "stripped by test mode — bot ends with endCall after last selected milestone");
      stripBlock("next_session_scheduling", "stripped by test mode — no scheduling on test calls");
    }

    // Strip every <milestone name="X.Y ..."> block whose X.Y is not in
    // the selected list. Replace with a one-line placeholder so the
    // surrounding phase scaffolding still reads coherently.
    prompt = prompt.replace(
      /<milestone name="(\d+\.\d+)([^"]*)">[\s\S]*?<\/milestone>/g,
      (match, id, rest) => {
        if (selected.has(id)) return match;
        return `<milestone name="${id}${rest}">(omitted in test mode)</milestone>`;
      }
    );

    // Inject a <test_mode> block at the very top of <system_prompt> so
    // it lands before any other rule the model encounters. Content
    // branches on includeClose.
    const ordered = testMilestones.join(", ");
    const closeBlock = includeClose
      ? `  - DO NOT skip the closing protocol. After the LAST selected
    milestone (${testMilestones[testMilestones.length - 1]}) exits,
    follow <closing_protocol>'s session_${activeSession}_close in
    full: the open-ended close question, the transition line, the
    scheduling question proposing the default time, the read-back-
    and-confirm exchange per <next_session_scheduling>, and the
    schedule_next_session tool invocation once the participant
    confirms. The tool's request-complete will speak "Take care
    until then. Goodbye." and end the call. Do NOT speak "Test
    call complete." in this mode — that is for the non-close
    test path. Do NOT invoke endCall — the tool handles call
    termination.`
      : `  - Skip the closing protocol entirely. The closing_protocol and
    next_session_scheduling blocks have been stripped.
  - Do NOT invoke schedule_next_session. Do NOT speak the
    "Before we go, I'd like to schedule our next conversation" line.
  - After the LAST selected milestone exits, speak one closing
    sentence: "Test call complete. Goodbye." Then invoke endCall.
    Do not attempt to schedule anything.`;
    const greetingLine = includeClose
      ? `"Test call with close. Jumping to milestone ${testMilestones[0]}."`
      : `"Test call. Jumping to milestone ${testMilestones[0]}."`;
    const testModeBlock = `<test_mode>
  YOU ARE IN TEST MODE${includeClose ? " WITH CLOSE" : ""}. The operator
  has selected specific milestones to run for this call. The normal
  call flow is suspended:

  - Skip Step 0 identity verification, Step 1 introduction, and
    Step 2 consent entirely. The session-opening blocks have been
    stripped from this prompt.
${closeBlock}

  Milestones to run, in this order: ${ordered}

  Behaviour:
  - Open the call by going DIRECTLY to the first selected
    milestone's opening probe. The platform has already spoken a
    brief test-mode greeting (${greetingLine}). Your first spoken
    turn should be the milestone's first question — no greeting,
    no introduction, no name confirmation.
  - When a milestone reaches its exit condition or hard fallback,
    transition to the next selected milestone with ONE short
    bridge sentence: "Let's switch topics." Do not summarise. Do
    not re-introduce yourself.
  - All other behavioural rules remain in effect: evaluation_rule,
    voice_and_manner, following_unexpected_depth,
    milestone_resumption_marker, handling_contradictions,
    endcall_safety, post_close_behaviour.
  - Milestones not in the selected list have been replaced with
    "(omitted in test mode)" placeholders. Do not attempt to run
    them. If the conversation drifts into one of their topics
    organically (e.g., a tangent), handle per
    <following_unexpected_depth> normally — do not try to "run"
    the omitted milestone.

  This block is present ONLY when test mode is active. In normal
  production calls it does not appear and all the stripped blocks
  are present.
</test_mode>

`;
    prompt = prompt.replace(/<system_prompt>\s*/, `<system_prompt>\n\n${testModeBlock}`);

    console.log("Test mode active for this call:", { milestones: testMilestones, includeClose });
  }

  // Resume-from-callback strip. When the rescheduled call carries
  // prior-call transcript content (RESUMED_FROM_TRANSCRIPT non-empty),
  // the bot should follow <resume_from_callback> instead of the
  // per-session callback/opening flows. Empirically the model preferred
  // the more detailed session_1_callback_flow over the pointer in
  // opening_flow_decision and re-read consent — so we strip the
  // conflicting blocks server-side rather than rely on the pointer.
  // Only applies when the standard callback flow would otherwise run
  // (not during test mode, which has its own strip behaviour).
  const hasResumeContent =
    isCallback && !Array.isArray(testMilestones) &&
    typeof resumedFromTranscript === "string" &&
    resumedFromTranscript.trim().length > 0;
  if (hasResumeContent) {
    // Strip ALL session-X opening blocks (including the initial flow,
    // not just the callback flow). The initial flow contains the
    // concrete consent-statement instructions; if left in the prompt,
    // the model prefers its concrete "read consent verbatim" wording
    // over <resume_from_callback>'s "skip if already covered" guidance,
    // and ends up re-reading consent + restarting the interview from
    // the top. The consent fallback for genuine first-time-needed
    // cases is embedded inside <resume_from_callback> itself.
    stripBlock("session_1_initial_call_flow", "resume mode: bot follows resume_from_callback instead");
    stripBlock("session_1_callback_flow", "resume mode: bot follows resume_from_callback instead");
    stripBlock("session_2_opening_protocol", "resume mode: bot follows resume_from_callback instead");
    stripBlock("session_3_opening_protocol", "resume mode: bot follows resume_from_callback instead");
    console.log("Resume mode active for this call: stripped session-X opening flows", {
      activeSession, resumedFromTranscriptLength: resumedFromTranscript.length
    });
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

// Final milestone of each session — used to resolve the "end" keyword
// in test mode. From <closing_protocol>'s session_N_close blocks.
const LAST_MILESTONE_FOR_SESSION = { 1: "4.3", 2: "9.3", 3: "14.3" };

// Test-mode milestone selector. Returns null (normal mode) or an object:
//   { milestones: string[], includeClose: boolean }
// Accepts:
//   - undefined / null / "" / "all" → null (normal mode)
//   - "end" (case-insensitive) → { milestones: [LAST_FOR_SESSION],
//       includeClose: true } — jumps to the last milestone of the current
//       session AND runs the full closing protocol + scheduling exchange,
//       so the operator can test that schedule_next_session fires
//       correctly without having to sit through the whole interview.
//       Note: when this fires for Sessions 1 or 2, a REAL future-scheduled
//       call will be created in Vapi and Supabase. The operator must
//       delete it from the dashboard afterwards (which the UI handles
//       cleanly per the artifact-preservation logic).
//   - "1.3,2.1" (comma-separated X.Y IDs) → { milestones: ["1.3","2.1"],
//       includeClose: false } — runs only those milestones, then
//       "Test call complete. Goodbye." + endCall (no scheduling).
// Whitespace is tolerated. activeSession resolves "end". Invalid format
// logs a warning and returns null (safer than shipping a half-stripped
// prompt).
function parseTestMilestones(raw, activeSession = 1) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s || s.toLowerCase() === "all") return null;
  if (s.toLowerCase() === "end") {
    const last = LAST_MILESTONE_FOR_SESSION[activeSession];
    if (!last) {
      console.warn(`parseTestMilestones: "end" requested for unknown session ${activeSession}; falling back to normal mode.`);
      return null;
    }
    return { milestones: [last], includeClose: true };
  }
  // Each segment must look like \d+\.\d+ — Phase.Milestone, no name.
  const parts = s.split(",").map(p => p.trim()).filter(Boolean);
  const valid = parts.every(p => /^\d+\.\d+$/.test(p));
  if (!valid || parts.length === 0) {
    console.warn(`parseTestMilestones: invalid value "${raw}" — falling back to normal (all) mode. Format: "1.3,2.1" or "end".`);
    return null;
  }
  return { milestones: parts, includeClose: false };
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

async function buildModelOverride({ isCallback, activeSession = 1, hasName = false, callKind = "interview", testMilestones = null, includeClose = false, resumedFromTranscript = "" }) {
  const template = await getModelTemplate();
  const content = callKind === "prescreening"
    ? loadPrescreeningPrompt({ hasName })
    : loadPromptForCall({
        isCallback, activeSession, hasName, consentEnabled: consentStatementEnabled(),
        testMilestones, includeClose, resumedFromTranscript
      });
  return {
    ...template,
    messages: [{ role: "system", content }]
  };
}

// Per-call firstMessage override. The Vapi assistant's default firstMessage
// is "Hello! May I please speak with {{PARTICIPANT_NAME}}?" which is correct
// for the common case (first attempt, name known). Returns undefined when
// the default applies — caller should omit firstMessage from
// assistantOverrides so the assistant default is used.
//
// Why these branches exist:
// - !hasName: substituting {{PARTICIPANT_NAME}} into the default would
//   produce broken speech ("Hello! May I please speak with ?"). We swap in
//   a name-agnostic greeting that asks the participant to self-identify.
// - isCallback: per the prompt's session_1_callback_flow, the opening
//   should be a brief callback acknowledgment ("calling you back as we
//   arranged"), not a fresh "may I speak with..." which would imply we
//   don't know whom we just spoke to a few minutes ago.
function buildFirstMessageOverride({ hasName, isCallback, testMilestones = null, includeClose = false, autoRetryAfterDrop = false, hasResumeContext = false }) {
  // Test mode wins over every other case: regardless of hasName /
  // isCallback, we want an audibly distinctive greeting that signals
  // "this is a test call" so the operator (and any human listener)
  // immediately knows the normal flow is not running. When the close
  // is also being tested ("end" keyword → includeClose=true), the
  // greeting says so — the operator hears "with close" and knows
  // schedule_next_session is about to fire for real.
  if (Array.isArray(testMilestones) && testMilestones.length > 0) {
    return includeClose
      ? `Test call with close. Jumping to milestone ${testMilestones[0]}.`
      : `Test call. Jumping to milestone ${testMilestones[0]}.`;
  }
  // Auto-retry after an unexpected drop: explain why we're calling back
  // (server-initiated, not because the participant asked), and immediately
  // ask if now is still a good time so they can decline cleanly. If they
  // say "don't call back", the bot uses endCall → server logs
  // assistant-ended-call → shouldAutoRetryAfterDrop excludes it from
  // further retries. Loop terminates cleanly.
  if (autoRetryAfterDrop) {
    return hasName
      ? "Hi {{PARTICIPANT_NAME}}. It looks like our call dropped. I'm calling you back to continue. Is now still a good time?"
      : "Hi. It looks like our call dropped. I'm calling you back to continue. Is now still a good time?";
  }
  // Resume callback (the participant asked us to call back mid-session
  // and we now have their prior transcript to resume from). Use a
  // greeting that signals "we are continuing" rather than the generic
  // "calling you back as we arranged" — distinct context for both the
  // participant and the model. Strip logic in loadPromptForCall removes
  // session_X_callback_flow / opening_protocol when this is true, so
  // the model must follow <resume_from_callback>.
  if (isCallback && hasResumeContext) {
    return hasName
      ? "Hi {{PARTICIPANT_NAME}}. Picking up where we left off. Is now still a good time?"
      : "Hi. Picking up where we left off. Is now still a good time?";
  }
  if (isCallback && hasName) {
    return "Hi {{PARTICIPANT_NAME}}. This is Imani from the Clean Cooking Alliance again. I'm calling you back as we arranged.";
  }
  if (isCallback && !hasName) {
    return "Hi. This is Imani from the Clean Cooking Alliance. I'm calling you back as we arranged.";
  }
  if (!hasName) {
    return "Hello. This is Imani — a robot caller from the Clean Cooking Alliance. May I ask who I'm speaking with?";
  }
  return undefined;
}

async function startVapiCall({ assistantId, customerNumber, variableValues, testMilestones = null, includeClose = false }) {
  const isCallback = variableValues?.IS_CALLBACK === "true";
  const activeSession = parseInt(variableValues?.ACTIVE_SESSION || "1", 10);
  const hasName = Boolean((variableValues?.PARTICIPANT_NAME || "").trim());
  const callKind = variableValues?.CALL_KIND || "interview";
  const resumedFromTranscript = variableValues?.RESUMED_FROM_TRANSCRIPT || "";
  const hasResumeContext = resumedFromTranscript.trim().length > 0;
  const firstMessage = buildFirstMessageOverride({ hasName, isCallback, testMilestones, includeClose, hasResumeContext });
  const assistantOverrides = {
    variableValues,
    model: await buildModelOverride({ isCallback, activeSession, hasName, callKind, testMilestones, includeClose, resumedFromTranscript })
  };
  if (firstMessage !== undefined) assistantOverrides.firstMessage = firstMessage;
  // Interview calls get the summaryPlan; prescreening calls don't run
  // through this path (they have their own analysisPlan with structuredDataPlan).
  if (callKind === "interview") {
    assistantOverrides.analysisPlan = { summaryPlan: INTERVIEW_SUMMARY_PLAN };
  }
  return vapiPost("/call", {
    assistantId,
    phoneNumberId: getPhoneNumberId(customerNumber),
    customer: { number: customerNumber },
    assistantOverrides
  });
}

// Short callbacks (under this many minutes) get routed through QStash:
// QStash holds the request, then fires our /timing/fire-callback handler
// which dials Vapi immediately. This avoids Vapi's multi-minute scheduler
// lead time, which empirically delays "in 1 minute" callbacks by 5+ min.
// Longer callbacks fall through to Vapi's native schedulePlan.
const QSTASH_CALLBACK_THRESHOLD_MINUTES = parseInt(process.env.QSTASH_CALLBACK_THRESHOLD_MINUTES || "10", 10);

async function scheduleVapiCallback({ assistantId, customerNumber, earliestAtIso, variableValues, autoRetryAfterDrop = false }) {
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
  const resumedFromTranscript = variableValues?.RESUMED_FROM_TRANSCRIPT || "";
  const hasResumeContext = resumedFromTranscript.trim().length > 0;
  const earliestMs = new Date(earliestAtIso).getTime();
  const delayMinutes = (earliestMs - Date.now()) / 60000;

  if (delayMinutes < QSTASH_CALLBACK_THRESHOLD_MINUTES && QSTASH_TOKEN && RENDER_BASE_URL) {
    // Short-fuse path: QStash holds the request, then fires fire-callback
    // at the target time, which dials Vapi immediately (no schedulePlan).
    await qstashScheduleAt({
      url: `${RENDER_BASE_URL}/timing/fire-callback`,
      notBeforeSeconds: Math.floor(earliestMs / 1000),
      body: { assistantId, customerNumber, variableValues, isCallback, autoRetryAfterDrop }
    });
    console.log("Short-fuse callback queued via QStash", {
      customerNumber, earliestAtIso, delayMinutes: delayMinutes.toFixed(2), isCallback, activeSession, autoRetryAfterDrop, hasResumeContext
    });
    return { id: null, status: "qstash-scheduled", earliestAt: earliestAtIso };
  }

  // Long-fuse path: hand off to Vapi's native scheduler.
  const firstMessage = buildFirstMessageOverride({ hasName, isCallback, autoRetryAfterDrop, hasResumeContext });
  const assistantOverrides = {
    variableValues,
    model: await buildModelOverride({ isCallback, activeSession, hasName, callKind, resumedFromTranscript })
  };
  if (firstMessage !== undefined) assistantOverrides.firstMessage = firstMessage;
  if (callKind === "interview") {
    assistantOverrides.analysisPlan = { summaryPlan: INTERVIEW_SUMMARY_PLAN };
  }
  return vapiPost("/call", {
    assistantId,
    phoneNumberId: getPhoneNumberId(customerNumber),
    customer: { number: customerNumber },
    schedulePlan: { earliestAt: earliestAtIso },
    assistantOverrides
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

function buildVariableValues({ activeSession, priorSessionsContext, isCallback, participantName, country, callKind = "interview", resumedFromTranscript = "" }) {
  return {
    ACTIVE_SESSION: String(activeSession),
    PRIOR_SESSIONS_CONTEXT: priorSessionsContext || "",
    INTERVIEW_MAX_MINUTES: String(INTERVIEW_MAX_MINUTES),
    IS_CALLBACK: isCallback ? "true" : "false",
    SCREENING_QUESTIONS_JSON,
    PARTICIPANT_NAME: participantName || "",
    COUNTRY: country || "",
    CALL_KIND: callKind,
    RESUMED_FROM_TRANSCRIPT: resumedFromTranscript || ""
  };
}

// =============================================================================
// Routes
// =============================================================================

/**
 * GET /healthz
 * Lightweight uptime probe. Returns 200 with a tiny JSON body. Intended for
 * external pingers (UptimeRobot, BetterUptime, GitHub Actions cron, etc.) to
 * hit every few minutes so Render does not spin the service down to cold.
 * No auth: must be reachable from anonymous monitors.
 */
app.get("/healthz", (req, res) => {
  res.json({ ok: true, uptimeSeconds: Math.round(process.uptime()) });
});

// ---------------------------------------------------------------------------
// Transcript proxy endpoints — read-only plain-text views of Vapi calls,
// designed to be consumed by Claude's web_fetch tool.
//
// Auth: optional shared token via ?token=... query param, enforced only
// when TRANSCRIPT_PROXY_TOKEN env var is set. web_fetch can't send
// arbitrary headers, so the token has to live in the URL.
//
// Output: text/plain, fixed format documented per endpoint. NOT JSON —
// the consumer is an LLM, not a parser.
//
// NOTE on transcript chronology: Vapi's `artifact.transcript` (string)
// and `artifact.messages` (array) are both ROLLED UP BY ROLE, not
// chronological. The output here preserves that ordering as-is — for
// strict turn-by-turn audio order, listen to artifact.recordingUrl
// instead. Documented in CLAUDE.md under "Iteration History".
// ---------------------------------------------------------------------------

function transcriptProxyAuthFails(req) {
  if (!TRANSCRIPT_PROXY_TOKEN) return false;
  return (req.query.token || "") !== TRANSCRIPT_PROXY_TOKEN;
}

// Vapi's transcript string uses "AI:" / "User:" line prefixes. Rewrite
// those to BOT: / PARTICIPANT: per the proxy's contract. Only matches
// the prefix at the start of a line followed by ":" — won't rewrite
// occurrences of "AI" or "User" mid-sentence.
function normalizeSpeakerLabels(transcriptStr) {
  if (!transcriptStr) return "";
  return transcriptStr
    .replace(/^AI:\s*/gm, "BOT: ")
    .replace(/^Bot:\s*/gm, "BOT: ")
    .replace(/^Assistant:\s*/gm, "BOT: ")
    .replace(/^User:\s*/gm, "PARTICIPANT: ")
    .replace(/^Human:\s*/gm, "PARTICIPANT: ");
}

// Fallback: assemble a transcript from artifact.messages when the
// `transcript` string is null (early in a call's life, before Vapi has
// rendered it). Drops system/tool entries since the proxy contract is
// BOT/PARTICIPANT only.
function assembleTranscriptFromMessages(messages) {
  if (!Array.isArray(messages)) return "";
  const out = [];
  for (const m of messages) {
    const role = String(m.role || "").toLowerCase();
    const text = (m.message || m.content || "").trim();
    if (!text) continue;
    let label;
    if (role === "bot" || role === "assistant") label = "BOT";
    else if (role === "user" || role === "human") label = "PARTICIPANT";
    else continue;
    out.push(`${label}: ${text}`);
  }
  return out.join("\n");
}

// Build the plain-text header + body for a single call object as
// returned by GET /call/:id. Returns the full string ready to send.
function formatCallAsPlainText(call) {
  const callId = call?.id || "unknown";
  const startedAt = call?.startedAt || call?.createdAt || "";
  const endedAt = call?.endedAt || "";
  let durationSeconds = "";
  if (startedAt && endedAt) {
    const ms = new Date(endedAt).getTime() - new Date(startedAt).getTime();
    if (!isNaN(ms) && ms > 0) durationSeconds = String(Math.round(ms / 1000));
  }
  const phone = call?.customer?.number || call?.phoneNumber?.number || "";
  const liveVars =
    call?.assistantOverrides?.variableValues
    || call?.assistant?.variableValues
    || {};
  const participantName = liveVars.PARTICIPANT_NAME || "";
  const activeSession = liveVars.ACTIVE_SESSION || "";
  const callKind = liveVars.CALL_KIND || "interview";
  const status = call?.status || call?.endedReason || "unknown";
  const participantLabel = [participantName, phone].filter(Boolean).join(" / ");

  // Prefer the rendered string transcript; fall back to assembling
  // from messages. If neither is present, the transcript hasn't been
  // generated yet (call still in progress or extraction pending).
  let transcriptText =
    call?.artifact?.transcript
    || call?.transcript
    || "";
  let transcriptSource = "artifact.transcript";
  if (!transcriptText) {
    const msgs = call?.artifact?.messages || call?.messages;
    if (Array.isArray(msgs) && msgs.length > 0) {
      transcriptText = assembleTranscriptFromMessages(msgs);
      transcriptSource = "artifact.messages";
    }
  }
  transcriptText = normalizeSpeakerLabels(transcriptText);

  const headerLines = [
    `CALL ID: ${callId}`,
    `CALL DATE: ${startedAt}`,
    `DURATION: ${durationSeconds ? durationSeconds + "s" : "unknown"}`,
    `PARTICIPANT: ${participantLabel || "unknown"}`,
    `SESSION: ${activeSession || "unknown"} (kind=${callKind})`,
    `STATUS: ${status}`
  ];

  if (!transcriptText) {
    headerLines.push(`TRANSCRIPT: NOT_AVAILABLE (reason=${status})`);
    return headerLines.join("\n") + "\n";
  }

  return [
    ...headerLines,
    `TRANSCRIPT_SOURCE: ${transcriptSource} (role-rolled-up, not chronological)`,
    "",
    "--- TRANSCRIPT ---",
    "",
    transcriptText
  ].join("\n") + "\n";
}

/**
 * GET /transcript/:callId
 * Fetches a single Vapi call and returns a plain-text transcript view.
 * Designed for Claude's web_fetch tool — text/plain, no JSON wrapping.
 */
app.get("/transcript/:callId", async (req, res) => {
  res.type("text/plain");
  try {
    if (transcriptProxyAuthFails(req)) {
      return res.status(401).send("ERROR: Unauthorized — invalid or missing ?token=\n");
    }
    if (!VAPI_API_KEY) {
      return res.status(500).send("ERROR: Server configuration error — VAPI_API_KEY not set\n");
    }
    const { callId } = req.params;
    if (!callId) return res.status(400).send("ERROR: Missing callId\n");

    const resp = await fetch(`https://api.vapi.ai/call/${encodeURIComponent(callId)}`, {
      headers: { Authorization: `Bearer ${VAPI_API_KEY}` }
    });
    if (resp.status === 404) {
      return res.status(404).send(`ERROR: Call not found — ID ${callId}\n`);
    }
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      return res.status(502).send(`ERROR: Vapi API error — ${resp.status} ${body.slice(0, 200)}\n`);
    }
    const call = await resp.json();
    return res.send(formatCallAsPlainText(call));
  } catch (e) {
    console.error("GET /transcript/:callId failed:", e);
    return res.status(500).send(`ERROR: ${String(e.message || e)}\n`);
  }
});

/**
 * GET /transcripts/recent?n=5
 * Lists the N most recent calls (default 5, capped at 10) and returns
 * their transcripts in a concatenated plain-text view.
 */
app.get("/transcripts/recent", async (req, res) => {
  res.type("text/plain");
  try {
    if (transcriptProxyAuthFails(req)) {
      return res.status(401).send("ERROR: Unauthorized — invalid or missing ?token=\n");
    }
    if (!VAPI_API_KEY) {
      return res.status(500).send("ERROR: Server configuration error — VAPI_API_KEY not set\n");
    }
    const requested = parseInt(req.query.n, 10);
    const n = Math.max(1, Math.min(10, isNaN(requested) ? 5 : requested));

    // Vapi's list endpoint returns calls newest-first by default; we
    // also pass sortOrder=desc explicitly for clarity. The list payload
    // includes artifact.transcript on completed calls.
    const listResp = await fetch(
      `https://api.vapi.ai/call?limit=${n}&sortOrder=desc`,
      { headers: { Authorization: `Bearer ${VAPI_API_KEY}` } }
    );
    if (!listResp.ok) {
      const body = await listResp.text().catch(() => "");
      return res.status(502).send(`ERROR: Vapi API error — ${listResp.status} ${body.slice(0, 200)}\n`);
    }
    const calls = await listResp.json();
    if (!Array.isArray(calls) || calls.length === 0) {
      return res.send(`RECENT CALLS — 0 results\n\nNo calls found.\n`);
    }

    const sections = calls.map((call, i) => {
      const body = formatCallAsPlainText(call);
      return `CALL ${i + 1}\n${body}`;
    });
    const out = `RECENT CALLS — ${calls.length} results\n\n---\n\n`
      + sections.join("\n---\n\n");
    return res.send(out);
  } catch (e) {
    console.error("GET /transcripts/recent failed:", e);
    return res.status(500).send(`ERROR: ${String(e.message || e)}\n`);
  }
});

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
      // Optional EXPLICIT override of the prior-sessions context. If
      // omitted, the server auto-computes from sessions.summary rows for
      // this participant. Pass a non-empty string to inject a
      // hand-written summary instead (useful for backfilling sessions
      // run before the auto-summary feature shipped).
      priorSessionsContext: priorSessionsContextOverride,
      assistantId,
      // Optional naive local datetime string ("YYYY-MM-DDTHH:MM") from the
      // operator UI's <input type="datetime-local">. If present, the call is
      // scheduled for the future in the timezone inferred from the phone
      // number's country code. If empty/missing, the call dials immediately.
      scheduledAtLocal,
      // Optional test-mode milestone selector. "all" / "" / absent → normal
      // call. "1.3,2.1" → strip intro/consent/closing, strip non-selected
      // milestones, jump straight to first selected milestone with an
      // audibly distinctive test-mode greeting. See parseTestMilestones.
      testMilestones: testMilestonesRaw,
      // When sessionNumber > 1 and any prior session lacks a stored
      // summary, /start-call returns 409 by default. Setting this flag
      // to true (via the dashboard's "Dial anyway" checkbox or an
      // explicit API call) bypasses the block; the dial proceeds with
      // whatever partial context exists (possibly empty).
      acknowledgeMissingPriorContext = false
    } = req.body || {};

    if (!customerNumber) return res.status(400).json({ error: "Missing customerNumber" });
    if (![1, 2, 3].includes(sessionNumber)) {
      return res.status(400).json({ error: "sessionNumber must be 1, 2, or 3" });
    }

    const tm = parseTestMilestones(testMilestonesRaw, sessionNumber);
    const testMilestones = tm ? tm.milestones : null;
    const includeClose = tm ? tm.includeClose : false;

    const participant = await upsertParticipant({ phoneNumber: customerNumber, name });

    // Auto-load prior session summaries when dialing Session 2/3. The
    // explicit priorSessionsContext body field (if non-empty) wins —
    // preserves the curl-based backfill workflow for sessions that
    // pre-date the auto-summary feature. Otherwise the server fetches
    // sessions.summary for all prior session_numbers and assembles the
    // prose blob the prompt's <prior_sessions_context> expects.
    let computedPriorContext = "";
    let priorContextWarnings = [];
    let priorContextMissing = [];
    const explicitOverrideContext = (priorSessionsContextOverride || "").trim();
    if (explicitOverrideContext) {
      computedPriorContext = explicitOverrideContext;
    } else {
      const loaded = await loadPriorSessionsContext({
        participantId: participant.id,
        sessionNumber
      });
      computedPriorContext = loaded.context;
      priorContextWarnings = loaded.warnings;
      priorContextMissing = loaded.missing;
    }

    // Block on missing prior context for non-Session-1 dials. Operator
    // must explicitly acknowledge (via dashboard checkbox or
    // acknowledgeMissingPriorContext:true in the body) before the dial
    // fires. Prevents accidentally dialing Session 2/3 with empty or
    // partial context, which produces a confused bot opening.
    if (
      sessionNumber > 1
      && priorContextMissing.length > 0
      && !acknowledgeMissingPriorContext
      && !explicitOverrideContext
    ) {
      return res.status(409).json({
        ok: false,
        error: "missing_prior_context",
        sessionNumber,
        missing: priorContextMissing,
        warnings: priorContextWarnings,
        message: `Cannot dial Session ${sessionNumber}: prior session(s) ${priorContextMissing.join(", ")} have no stored summary. Either run those sessions first, or check "Dial anyway without prior context" to proceed with empty/partial context.`
      });
    }

    const session = await createSessionRow({
      participantId: participant.id,
      sessionNumber,
      priorSessionsContext: computedPriorContext
    });

    if (priorContextWarnings.length > 0) {
      console.warn("Prior sessions context warnings", {
        participantId: participant.id, sessionNumber,
        contextLength: computedPriorContext.length,
        warnings: priorContextWarnings,
        acknowledged: acknowledgeMissingPriorContext
      });
    }

    // Operator-initiated fresh dial — this is a NEW attempt cycle for
    // (participant, session), so reset the auto-retry counter. Without
    // this, exhausted retries from any prior cycle (hours or days
    // earlier) would block the new cycle's retries indefinitely until
    // Render restarts. The counter is purely per-attempt-cycle now.
    const retryKey = autoRetryKey(participant.id, sessionNumber);
    if (autoRetryCountBySession.has(retryKey)) {
      const prior = autoRetryCountBySession.get(retryKey);
      autoRetryCountBySession.delete(retryKey);
      console.log("Auto-retry counter reset for new attempt cycle", {
        participantId: participant.id, sessionNumber, priorCount: prior
      });
    }

    // Same logic for the persistent daytime-retry counter. Operator
    // re-dial means "start a fresh attempt budget" — clear any prior
    // chain state for this (participant, session) so a new sequence
    // of busy/no-answer failures gets the full DAYTIME_RETRY_CAP again.
    await resetDaytimeRetryCount({
      participantId: participant.id,
      sessionNumber
    });

    // Use the SUBMITTED name (this call's name), not whatever happens to
    // be stored on participants.name from a prior call. A blank submission
    // means PARTICIPANT_NAME="" for this call, which skips the identity
    // check. This also keeps the per-row dashboard display accurate.
    const submittedName = (name || "").trim();

    const variableValues = buildVariableValues({
      activeSession: sessionNumber,
      priorSessionsContext: computedPriorContext,
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
      const firstMessage = buildFirstMessageOverride({ hasName, isCallback: false, testMilestones, includeClose });
      const overrides = {
        variableValues,
        model: await buildModelOverride({ isCallback: false, activeSession: sessionNumber, hasName, testMilestones, includeClose }),
        analysisPlan: { summaryPlan: INTERVIEW_SUMMARY_PLAN }
      };
      if (firstMessage !== undefined) overrides.firstMessage = firstMessage;
      const result = await vapiPost("/call", {
        assistantId: assistantId || ASSISTANT_ID,
        phoneNumberId: getPhoneNumberId(customerNumber),
        customer: { number: customerNumber },
        schedulePlan: { earliestAt: scheduledUtcIso },
        assistantOverrides: overrides
      });
      vapiCallId = result?.id;
      vapiStatus = result?.status;
    } else {
      const started = await startVapiCall({
        assistantId: assistantId || ASSISTANT_ID,
        customerNumber,
        variableValues,
        testMilestones,
        includeClose
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
      scheduledAt: scheduledUtcIso,
      priorContextLength: computedPriorContext.length,
      priorContextWarnings,
      acknowledgedMissingPriorContext: acknowledgeMissingPriorContext === true
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

    // Prescreening is always a first-attempt call (never a callback). Empty
    // name → swap in the name-agnostic greeting so we don't speak the
    // broken "Hello! May I please speak with ?".
    const firstMessage = buildFirstMessageOverride({ hasName, isCallback: false });
    const assistantOverrides = { variableValues, model, analysisPlan };
    if (firstMessage !== undefined) assistantOverrides.firstMessage = firstMessage;
    const baseBody = {
      assistantId: ASSISTANT_ID,
      phoneNumberId: getPhoneNumberId(customerNumber),
      customer: { number: customerNumber },
      assistantOverrides
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
      const needsStatusReconcile = isFuture || s.status === "sent";
      const needsDurationBackfill = !isFuture && s.duration_seconds == null;
      if (!needsStatusReconcile && !needsDurationBackfill) return { row: s, live: true };
      try {
        const resp = await fetch(`https://api.vapi.ai/call/${s.vapi_call_id}`, {
          headers: { Authorization: `Bearer ${VAPI_API_KEY}` }
        });
        if (resp.status === 404) return { row: s, live: false };
        if (!resp.ok) return { row: s, live: true };
        const call = await resp.json();
        if (call.status === "scheduled") return { row: s, live: true };

        // Compute duration from Vapi's startedAt/endedAt if missing.
        let backfillDur = null;
        if (needsDurationBackfill && call.startedAt && call.endedAt) {
          const ms = new Date(call.endedAt).getTime() - new Date(call.startedAt).getTime();
          if (!isNaN(ms) && ms > 0) backfillDur = Math.round(ms / 1000);
        }

        if (call.status === "ended" && s.status === "sent") {
          const derived = mapEndedReasonToStatus(call.endedReason);
          return { row: { ...s, status: derived, duration_seconds: s.duration_seconds ?? backfillDur }, live: true, backfillTo: derived, backfillDur };
        }
        // Ended call status already reconciled. Backfill duration only if missing.
        if (backfillDur != null) {
          return { row: { ...s, duration_seconds: backfillDur }, live: true, backfillDur };
        }
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

    // Persist any backfills (status and/or duration).
    const backfills = verifications.filter(v => v.live && (v.backfillTo || v.backfillDur != null));
    await Promise.all(backfills.map(v => {
      const upd = {};
      if (v.backfillTo) upd.status = v.backfillTo;
      if (v.backfillDur != null) upd.duration_seconds = v.backfillDur;
      return supabase.from("scheduled_calls").update(upd).eq("id", v.row.id);
    }));

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
 * Remove a scheduled-calls row from the operator dashboard.
 *
 * Vapi-side behavior depends on whether the call has actually run:
 * - Call still scheduled (Vapi has no startedAt yet): DELETE it on Vapi.
 *   For a scheduled-but-not-yet-fired call, Vapi DELETE is the cancel
 *   mechanism — no artifact exists yet, so nothing is lost.
 * - Call has started or ended (Vapi has startedAt): SKIP Vapi DELETE.
 *   The Vapi artifact (transcript, recording, performanceMetrics,
 *   messages) must be preserved so the operator can still review the
 *   call from Vapi's dashboard or API after the row is hidden from
 *   the UI. This was the explicit design correction: prior behavior
 *   unconditionally DELETE'd and wiped completed-call artifacts.
 *
 * Supabase: always mark the row as cancelled so it disappears from
 * GET /scheduled-calls (which filters cancelled rows out).
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

    if (row.vapi_call_id) {
      try {
        // Probe Vapi to decide: cancel (DELETE) vs. preserve (skip).
        const probe = await fetch(`https://api.vapi.ai/call/${row.vapi_call_id}`, {
          headers: { Authorization: `Bearer ${VAPI_API_KEY}` }
        });
        if (probe.status === 404) {
          // Call already gone from Vapi (e.g., previously deleted, or
          // never persisted). Nothing to do; just hide the row.
        } else if (probe.ok) {
          const call = await probe.json();
          if (call.startedAt) {
            // Call has run — preserve the artifact. NEVER DELETE.
            console.log("Preserving Vapi artifact for completed/in-progress call", {
              vapiCallId: row.vapi_call_id, status: call.status, startedAt: call.startedAt
            });
          } else {
            // Call still scheduled and hasn't fired — DELETE cancels it.
            const delResp = await fetch(`https://api.vapi.ai/call/${row.vapi_call_id}`, {
              method: "DELETE",
              headers: { Authorization: `Bearer ${VAPI_API_KEY}` }
            });
            if (!delResp.ok && delResp.status !== 404) {
              console.warn(`Vapi DELETE for ${row.vapi_call_id} returned ${delResp.status}`);
            }
          }
        } else {
          // Probe failed for an unexpected reason. Err on the side of
          // preservation — do nothing on Vapi rather than risk wiping
          // an artifact during a transient outage. The Supabase row
          // is still hidden below.
          console.warn(`Vapi probe for ${row.vapi_call_id} returned ${probe.status}; skipping Vapi DELETE to preserve any artifact`);
        }
      } catch (e) {
        console.warn("Vapi reconciliation failed (continuing with Supabase hide):", e.message);
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
        const priorChainTranscript = liveVars.RESUMED_FROM_TRANSCRIPT || "";

        // Defer the actual Vapi scheduling to end-of-call-report. This
        // tool fires MID-CALL, but Vapi's artifact.transcript isn't
        // populated until the call ends — so a fetch here would miss
        // everything the participant just said and the rescheduled call
        // would have an incomplete resume context. Instead we store the
        // intent in pendingCallbacksByCallId and drain it at end-of-call
        // when the full transcript arrives in the webhook payload (no
        // API round-trip needed). markScheduled prevents the heuristic
        // fallback paths from also trying to schedule on the same call.
        pendingCallbacksByCallId.set(callId, {
          utcTargetIso: utcTarget.toISOString(),
          suggestedTime,
          customerNumber,
          assistantId: assistantIdForCallback,
          currentSession,
          priorContext,
          participantName,
          callKind,
          priorChainTranscript,
          storedAt: new Date().toISOString()
        });
        markScheduled(callId || `${customerNumber}:${suggestedTime}`);
        console.log("schedule_callback intent stored; will dial at end-of-call-report", {
          callId, customerNumber, suggestedTime, utcTarget: utcTarget.toISOString(),
          priorChainTranscriptLength: priorChainTranscript.length
        });

        return res.json({
          results: [{
            toolCallId: toolCall.toolCallId || toolCall.id,
            result: `Got it, I'll call you back ${suggestedTime}. Take care.`
          }]
        });
      }

      // ---- log_classification: silent per-turn precedence walk ----
      // Async tool — Vapi may still POST a tool-call event to the webhook
      // for observability. Acknowledge with an empty result so nothing
      // disrupts the flow. The classification text lives in the tool args
      // (visible in artifact.messages) so the analyst can audit per-turn
      // classifications after the call.
      if (fn?.name === "log_classification") {
        // Light log for debugging — disable later if it's too noisy.
        try {
          const args = fn.arguments || {};
          console.log("log_classification:", {
            callId: message?.call?.id,
            final: args.final_classification,
            walk: (args.precedence_walk || "").slice(0, 180)
          });
        } catch {}
        return res.json({
          results: [{
            toolCallId: toolCall.toolCallId || toolCall.id,
            result: "ok"
          }]
        });
      }

      // ---- log_resumption: silent milestone-resumption inventory ----
      // Same async/silent pattern as log_classification. Invoked when
      // Imani returns to the current milestone after engaging with
      // off-milestone content for two or more probes — forces the model
      // to verbalize what's on record / what's missing / what the next
      // probe will address, so the implicit milestone tracker stops
      // drifting after sustained tangents. Args land in artifact.messages
      // for analyst review.
      if (fn?.name === "log_resumption") {
        try {
          const args = fn.arguments || {};
          console.log("log_resumption:", {
            callId: message?.call?.id,
            milestone: args.milestone_name,
            exitMet: args.exit_condition_met,
            next: (args.next_action || "").slice(0, 120),
            missing: (args.missing || "").slice(0, 180)
          });
        } catch {}
        return res.json({
          results: [{
            toolCallId: toolCall.toolCallId || toolCall.id,
            result: "ok"
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
          const hasName = Boolean(participantName.trim());
          const firstMessage = buildFirstMessageOverride({ hasName, isCallback: false });
          const assistantOverrides = {
            variableValues: nextSessionVars,
            model: await buildModelOverride({ isCallback: false, activeSession: nextSession }),
            analysisPlan: { summaryPlan: INTERVIEW_SUMMARY_PLAN }
          };
          if (firstMessage !== undefined) assistantOverrides.firstMessage = firstMessage;
          scheduled = await vapiPost("/call", {
            assistantId: assistantIdForNext,
            phoneNumberId: getPhoneNumberId(customerNumber),
            customer: { number: customerNumber },
            schedulePlan: { earliestAt: utcTarget.toISOString() },
            assistantOverrides
          });
        }

        console.log("Next session scheduled", {
          fromSession: currentSession,
          toSession: nextSession,
          customerNumber,
          scheduledAt: utcTarget.toISOString(),
          vapiCallId: scheduled?.id
        });

        // Mark the CURRENT call as scheduled so the end-of-call-report's
        // heuristic extract-from-transcript fallback doesn't ALSO create
        // a callback for the same time. Without this, when the bot
        // invokes schedule_next_session with a time like "tomorrow at
        // 7pm", the fallback path independently finds "tomorrow at 7pm"
        // in the transcript and schedules a duplicate Session 1
        // callback — observed in call 019eb82a paired with 019eb829.
        const currentCallIdForMark = message?.call?.id;
        markScheduled(currentCallIdForMark || `${customerNumber}:${suggestedTime}`);

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
        // Pull Vapi's auto-generated summary (from analysisPlan.summaryPlan
        // attached to the call's assistantOverrides). Persisted alongside
        // transcript so the participant's NEXT session can load it as
        // PRIOR_SESSIONS_CONTEXT via loadPriorSessionsContext. May be
        // null if extraction failed or timed out; that's handled by the
        // block-on-missing-summary check in /start-call.
        const analysisSummary =
          message?.analysis?.summary
          || call?.analysis?.summary
          || message?.call?.analysis?.summary
          || null;
        let finalStatus;
        if (existing && toolSetTerminals.has(existing.status)) {
          finalStatus = existing.status;
          await updateSessionByCallId(callId, {
            completed_at: new Date().toISOString(),
            transcript: transcriptStructured || (transcript ? { plain: transcript } : null),
            summary: analysisSummary
          });
        } else {
          finalStatus = mapEndedReasonToStatus(endedReason);
          await updateSessionByCallId(callId, {
            status: finalStatus,
            completed_at: new Date().toISOString(),
            transcript: transcriptStructured || (transcript ? { plain: transcript } : null),
            summary: analysisSummary
          });
        }
        if (analysisSummary) {
          console.log("Session summary persisted", {
            callId, summaryLength: analysisSummary.length
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

      // Drain any pending schedule_callback intent stored mid-call. The
      // tool fired earlier in the call but deferred the actual Vapi
      // dial to here so the resume-from-transcript blob can include the
      // FULL current-call transcript (which is in `transcript` above,
      // sourced directly from the webhook payload — no API round-trip).
      // markScheduled was already called in the tool handler, so the
      // fallback extract-from-transcript and auto-retry paths below
      // will see this call as already-scheduled and skip.
      if (callId && pendingCallbacksByCallId.has(callId)) {
        const intent = pendingCallbacksByCallId.get(callId);
        pendingCallbacksByCallId.delete(callId);
        try {
          const currentCallTranscript = (transcript || "").trim();
          const parts = [intent.priorChainTranscript, currentCallTranscript]
            .map(s => (s || "").trim())
            .filter(Boolean);
          let combined = parts.join("\n\n--- [next call attempt] ---\n\n");
          const MAX_CHARS = 30000;
          if (combined.length > MAX_CHARS) {
            combined = "(... earlier portions of this call chain truncated for length; the most recent ~30k characters follow ...)\n\n" + combined.slice(-MAX_CHARS);
          }
          const scheduled = await scheduleVapiCallback({
            assistantId: intent.assistantId,
            customerNumber: intent.customerNumber,
            earliestAtIso: intent.utcTargetIso,
            variableValues: buildVariableValues({
              activeSession: intent.currentSession,
              priorSessionsContext: intent.priorContext,
              isCallback: true,
              participantName: intent.participantName,
              country: inferCountryFromPhone(intent.customerNumber),
              callKind: intent.callKind,
              resumedFromTranscript: combined
            })
          });
          console.log("Deferred schedule_callback fired at end-of-call-report", {
            vapiCallId: scheduled?.id,
            customerNumber: intent.customerNumber,
            currentSession: intent.currentSession,
            suggestedTime: intent.suggestedTime,
            utcTarget: intent.utcTargetIso,
            resumedFromTranscriptLength: combined.length,
            priorChainLength: intent.priorChainTranscript.length,
            currentTranscriptLength: currentCallTranscript.length
          });
          if (intent.callKind === "interview") {
            try {
              const { data: p } = await supabase
                .from("participants")
                .select("id")
                .eq("phone_number", intent.customerNumber)
                .maybeSingle();
              if (p?.id) {
                await recordScheduledCall({
                  participantId: p.id,
                  sessionNumber: intent.currentSession,
                  scheduledAt: intent.utcTargetIso,
                  vapiCallId: scheduled?.id,
                  nameAtCall: intent.participantName
                });
              }
            } catch (e) {
              console.error("Deferred schedule_callback recordScheduledCall failed:", e);
            }
          }
        } catch (e) {
          console.error("Deferred schedule_callback failed:", e);
        }
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

      // Auto-retry after unexpected drop. Triggered when the call ended
      // via carrier error, mid-call silence timeout, or a customer hangup
      // that didn't go through schedule_callback / schedule_next_session /
      // report_wrong_number. Capped at AUTO_RETRY_CAP per (participant,
      // session); the cap is in-memory and resets on server restart.
      try {
        if (customerNumber && callId && !wasScheduled(callId)) {
          const liveVars = call?.assistantOverrides?.variableValues
            || message?.call?.assistantOverrides?.variableValues
            || {};
          const retryReason = shouldAutoRetryAfterDrop({
            endedReason,
            transcriptStructured,
            callKind: liveVars.CALL_KIND || "interview"
          });
          if (retryReason) {
            // Look up participant for the retry-counter key.
            const { data: p } = await supabase
              .from("participants")
              .select("id")
              .eq("phone_number", customerNumber)
              .maybeSingle();
            if (p?.id) {
              const sessionForKey = parseInt(liveVars.ACTIVE_SESSION || "1", 10);
              const key = autoRetryKey(p.id, sessionForKey);
              const priorCount = autoRetryCountBySession.get(key) || 0;
              if (priorCount >= AUTO_RETRY_CAP) {
                console.log("Auto-retry capped — not retrying", {
                  customerNumber, sessionForKey, priorCount, retryReason
                });
              } else {
                autoRetryCountBySession.set(key, priorCount + 1);
                const earliestAtIso = new Date(Date.now() + AUTO_RETRY_DELAY_SECONDS * 1000).toISOString();
                const priorChainTranscript = liveVars.RESUMED_FROM_TRANSCRIPT || "";

                // Branch on retry kind:
                // - Mid-call drop / silence / carrier-drop: participant was
                //   on the line, so the retry uses the "our call dropped"
                //   greeting (autoRetryAfterDrop=true), forces
                //   isCallback=true so the model takes the callback flow,
                //   and fetches the current call's transcript to
                //   accumulate into the resume context.
                // - failed-to-connect (pre-connect SIP/provider error):
                //   participant never on the line. Retry should look like
                //   a fresh attempt — preserve the ORIGINAL IS_CALLBACK
                //   (the call might have been an initial dial OR a prior
                //   callback that didn't connect), use the original
                //   greeting (not the drop greeting), and don't try to
                //   fetch a transcript (there isn't one; just carry
                //   forward whatever prior chain came with this attempt).
                const isPreConnectFailure = retryReason === "failed-to-connect";
                const retryIsCallback = isPreConnectFailure
                  ? (liveVars.IS_CALLBACK === "true")
                  : true;
                const retryAutoRetryAfterDrop = !isPreConnectFailure;
                const resumedFromTranscript = isPreConnectFailure
                  ? priorChainTranscript
                  : await buildResumedTranscript({
                      currentCallId: callId,
                      priorChainTranscript
                    });

                const participantName = liveVars.PARTICIPANT_NAME || "";
                const assistantIdForRetry =
                  call?.assistantId || message?.assistant?.id || ASSISTANT_ID;
                const scheduled = await scheduleVapiCallback({
                  assistantId: assistantIdForRetry,
                  customerNumber,
                  earliestAtIso,
                  variableValues: buildVariableValues({
                    activeSession: sessionForKey,
                    priorSessionsContext: liveVars.PRIOR_SESSIONS_CONTEXT || "",
                    isCallback: retryIsCallback,
                    participantName,
                    country: inferCountryFromPhone(customerNumber),
                    callKind: "interview",
                    resumedFromTranscript
                  }),
                  autoRetryAfterDrop: retryAutoRetryAfterDrop
                });
                markScheduled(callId);
                console.log("Auto-retry scheduled", {
                  vapiCallId: scheduled?.id,
                  customerNumber,
                  sessionForKey,
                  retryAttempt: priorCount + 1,
                  retryReason,
                  isPreConnectFailure,
                  retryIsCallback,
                  earliestAtIso
                });
                // Persist a scheduled_calls row so the operator dashboard
                // shows the retry attempt.
                try {
                  await recordScheduledCall({
                    participantId: p.id,
                    sessionNumber: sessionForKey,
                    scheduledAt: earliestAtIso,
                    vapiCallId: scheduled?.id,
                    nameAtCall: participantName
                  });
                } catch (e) {
                  console.error("Auto-retry scheduled_calls persist failed:", e);
                }
              }
            }
          }
        }
      } catch (e) {
        console.error("Auto-retry handler failed:", e);
      }

      // If the participant came on the line and the bot ended the call
      // (assistant-ended-call, NOT the *-after-message-spoken variant
      // which means a scheduling tool fired), treat it as an explicit
      // decline and mark the daytime-retry chain as declined. Prevents
      // any stale future-scheduled callback that fails later from
      // restarting a retry chain for the same (participant, session).
      // Operator re-dial via /start-call clears this flag.
      try {
        if (customerNumber && callId) {
          const r = String(endedReason || "").toLowerCase();
          const hadParticipantOnLine =
            Array.isArray(transcriptStructured) &&
            transcriptStructured.some(m => m.role === "user");
          if (r === "assistant-ended-call" && hadParticipantOnLine) {
            const liveVars = call?.assistantOverrides?.variableValues
              || message?.call?.assistantOverrides?.variableValues
              || {};
            if ((liveVars.CALL_KIND || "interview") === "interview") {
              const { data: p } = await supabase
                .from("participants")
                .select("id")
                .eq("phone_number", customerNumber)
                .maybeSingle();
              if (p?.id) {
                const sessionForKey = parseInt(liveVars.ACTIVE_SESSION || "1", 10);
                await markDaytimeRetryDeclined({
                  participantId: p.id,
                  sessionNumber: sessionForKey
                });
                console.log("Daytime retry chain marked declined", {
                  customerNumber, sessionForKey
                });
              }
            }
          }
        }
      } catch (e) {
        console.error("markDaytimeRetryDeclined check failed:", e);
      }

      // Daytime hourly retry for dial-time failures (busy / no-answer /
      // voicemail). Different from the auto-retry block above — that
      // handles mid-call drops with a 30-second quick retry. This one
      // covers the case where the participant was never on the line at
      // all: keep trying at hourly intervals during their local daytime
      // window until DAYTIME_RETRY_CAP is hit. State persists in the
      // daytime_retries Supabase table so Render restarts don't break
      // the chain.
      try {
        if (customerNumber && callId && !wasScheduled(callId)) {
          const liveVars = call?.assistantOverrides?.variableValues
            || message?.call?.assistantOverrides?.variableValues
            || {};
          const daytimeRetryReason = shouldDaytimeRetry({
            endedReason,
            transcriptStructured,
            callKind: liveVars.CALL_KIND || "interview"
          });
          if (daytimeRetryReason) {
            const { data: p } = await supabase
              .from("participants")
              .select("id")
              .eq("phone_number", customerNumber)
              .maybeSingle();
            if (p?.id) {
              const sessionForKey = parseInt(liveVars.ACTIVE_SESSION || "1", 10);
              const state = await getDaytimeRetryState({
                participantId: p.id,
                sessionNumber: sessionForKey
              });
              if (state.declined) {
                console.log("Daytime retry skipped — participant previously declined", {
                  customerNumber, sessionForKey, daytimeRetryReason
                });
              } else if ((state.attempts || 0) >= DAYTIME_RETRY_CAP) {
                console.log("Daytime retry cap reached — manual intervention required", {
                  customerNumber, sessionForKey,
                  attempts: state.attempts, cap: DAYTIME_RETRY_CAP,
                  daytimeRetryReason
                });
              } else {
                const earliestAt = nextDaytimeDialTime({
                  customerNumber,
                  intervalMinutes: DAYTIME_RETRY_INTERVAL_MINUTES
                });
                const earliestAtIso = earliestAt.toISOString();
                const attemptNumber = await incrementDaytimeRetryCount({
                  participantId: p.id,
                  sessionNumber: sessionForKey
                });
                const participantName = liveVars.PARTICIPANT_NAME || "";
                const assistantIdForRetry =
                  call?.assistantId || message?.assistant?.id || ASSISTANT_ID;
                // Participant was never on the line. Retry must look
                // like a fresh attempt — preserve the ORIGINAL
                // IS_CALLBACK (initial dial vs prior scheduled
                // callback), use the original greeting (no "our call
                // dropped" line), and carry forward whatever prior
                // chain came with this attempt.
                const scheduled = await scheduleVapiCallback({
                  assistantId: assistantIdForRetry,
                  customerNumber,
                  earliestAtIso,
                  variableValues: buildVariableValues({
                    activeSession: sessionForKey,
                    priorSessionsContext: liveVars.PRIOR_SESSIONS_CONTEXT || "",
                    isCallback: liveVars.IS_CALLBACK === "true",
                    participantName,
                    country: inferCountryFromPhone(customerNumber),
                    callKind: "interview",
                    resumedFromTranscript: liveVars.RESUMED_FROM_TRANSCRIPT || ""
                  }),
                  autoRetryAfterDrop: false
                });
                markScheduled(callId);
                console.log("Daytime retry scheduled", {
                  vapiCallId: scheduled?.id,
                  customerNumber,
                  sessionForKey,
                  attemptNumber,
                  cap: DAYTIME_RETRY_CAP,
                  daytimeRetryReason,
                  earliestAtIso
                });
                try {
                  await recordScheduledCall({
                    participantId: p.id,
                    sessionNumber: sessionForKey,
                    scheduledAt: earliestAtIso,
                    vapiCallId: scheduled?.id,
                    nameAtCall: participantName
                  });
                } catch (e) {
                  console.error("Daytime-retry scheduled_calls persist failed:", e);
                }
              }
            }
          }
        }
      } catch (e) {
        console.error("Daytime-retry handler failed:", e);
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
    const { assistantId, customerNumber, variableValues, isCallback = true, autoRetryAfterDrop = false } = req.body || {};
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
    const resumedFromTranscript = variableValues?.RESUMED_FROM_TRANSCRIPT || "";
    const hasResumeContext = resumedFromTranscript.trim().length > 0;
    const firstMessage = buildFirstMessageOverride({ hasName, isCallback, autoRetryAfterDrop, hasResumeContext });
    const assistantOverrides = {
      variableValues,
      model: await buildModelOverride({ isCallback, activeSession, hasName, callKind, resumedFromTranscript })
    };
    if (callKind === "interview") {
      assistantOverrides.analysisPlan = { summaryPlan: INTERVIEW_SUMMARY_PLAN };
    }
    if (firstMessage !== undefined) assistantOverrides.firstMessage = firstMessage;
    const result = await vapiPost("/call", {
      assistantId,
      phoneNumberId: getPhoneNumberId(customerNumber),
      customer: { number: customerNumber },
      assistantOverrides
    });
    console.log("Fire-callback dialed", { vapiCallId: result?.id, customerNumber, isCallback, activeSession, autoRetryAfterDrop });
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
