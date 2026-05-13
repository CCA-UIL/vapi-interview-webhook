import express from "express";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
// Vapi webhook bodies include the assistant config (system prompt + tools)
// plus the running transcript, so payloads can easily exceed Express's
// default 100kb limit. Bumping to 10mb to comfortably absorb that.
app.use(express.json({ limit: "10mb" }));

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

  if (/\btomorrow\b/.test(lower)) targetLocal.setDate(targetLocal.getDate() + 1);

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
  "Eric_system_prompt_phase1.xml"
);

function loadPromptForCall({ isCallback }) {
  let prompt = fs.readFileSync(PROMPT_PATH, "utf8");
  // The regex must anchor to top-level tags (column 0) — both flow blocks
  // contain inline prose references to the *other* flow's tag name (e.g.,
  // session_1_initial_call_flow's description mentions "use
  // <session_1_callback_flow>"), and an unanchored regex would lazily
  // match from that inline mention through the end of the actual block,
  // wiping most of the wrong block.
  if (isCallback) {
    prompt = prompt.replace(
      /^<session_1_initial_call_flow>[\s\S]*?^<\/session_1_initial_call_flow>$/m,
      "<session_1_initial_call_flow>(omitted: this call is a callback, so the initial flow does not apply)</session_1_initial_call_flow>"
    );
  } else {
    prompt = prompt.replace(
      /^<session_1_callback_flow>[\s\S]*?^<\/session_1_callback_flow>$/m,
      "<session_1_callback_flow>(omitted: this call is not a callback)</session_1_callback_flow>"
    );
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

async function buildModelOverride({ isCallback }) {
  const template = await getModelTemplate();
  return {
    ...template,
    messages: [{ role: "system", content: loadPromptForCall({ isCallback }) }]
  };
}

async function startVapiCall({ assistantId, customerNumber, variableValues }) {
  const isCallback = variableValues?.IS_CALLBACK === "true";
  return vapiPost("/call", {
    assistantId,
    phoneNumberId: PHONE_NUMBER_ID,
    customer: { number: customerNumber },
    assistantOverrides: {
      variableValues,
      model: await buildModelOverride({ isCallback })
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
  const callbackVars = { ...variableValues, IS_CALLBACK: "true" };
  const earliestMs = new Date(earliestAtIso).getTime();
  const delayMinutes = (earliestMs - Date.now()) / 60000;

  if (delayMinutes < QSTASH_CALLBACK_THRESHOLD_MINUTES && QSTASH_TOKEN && RENDER_BASE_URL) {
    // Short-fuse path: QStash holds the request, then fires fire-callback
    // at the target time, which dials Vapi immediately (no schedulePlan).
    await qstashScheduleAt({
      url: `${RENDER_BASE_URL}/timing/fire-callback`,
      notBeforeSeconds: Math.floor(earliestMs / 1000),
      body: { assistantId, customerNumber, variableValues: callbackVars }
    });
    console.log("Short-fuse callback queued via QStash", {
      customerNumber, earliestAtIso, delayMinutes: delayMinutes.toFixed(2)
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
      variableValues: callbackVars,
      model: await buildModelOverride({ isCallback: true })
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

function buildVariableValues({ activeSession, priorSessionsContext, isCallback, participantName }) {
  return {
    ACTIVE_SESSION: String(activeSession),
    PRIOR_SESSIONS_CONTEXT: priorSessionsContext || "",
    INTERVIEW_MAX_MINUTES: String(INTERVIEW_MAX_MINUTES),
    IS_CALLBACK: isCallback ? "true" : "false",
    SCREENING_QUESTIONS_JSON,
    PARTICIPANT_NAME: participantName || ""
  };
}

// =============================================================================
// Routes
// =============================================================================

/**
 * POST /start-call
 * Body: { customerNumber (req), name?, sessionNumber?=1, priorSessionsContext?, assistantId? }
 */
app.post("/start-call", async (req, res) => {
  try {
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
      participantName: participant.name
    });

    const started = await startVapiCall({
      assistantId: assistantId || ASSISTANT_ID,
      customerNumber,
      variableValues
    });

    await setSessionCallId(session.id, started?.id);

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
        //   soft (T - WRAPUP_OFFSET_MINUTES): system message asks Eric to
        //       wrap after the participant's NEXT response. Lets the
        //       conversation finish its current turn naturally.
        //   force (T - FORCE_CLOSE_OFFSET_SECONDS): Vapi force-speaks
        //       the closing line and auto-hangs up. Fail-safe if Eric
        //       didn't comply with the soft signal.
        //   hard cap (T): final fallback — endVapiCall via controlUrl.
        const FORCE_CLOSE_OFFSET_SECONDS = parseInt(process.env.FORCE_CLOSE_OFFSET_SECONDS || "30", 10);
        const softWrapupAt = Math.floor((startMs + (INTERVIEW_MAX_MINUTES - WRAPUP_OFFSET_MINUTES) * 60 * 1000) / 1000);
        const forceCloseAt = Math.floor((startMs + INTERVIEW_MAX_MINUTES * 60 * 1000 - FORCE_CLOSE_OFFSET_SECONDS * 1000) / 1000);
        const hardCapAt = Math.floor((startMs + INTERVIEW_MAX_MINUTES * 60 * 1000) / 1000);

        // Fallback closing if Eric doesn't invoke schedule_next_session.
        // Force-close speaks this verbatim and hangs up.
        // TODO: branch on ACTIVE_SESSION when Sessions 2 and 3 are wired.
        const closingSentence =
          `Well, that wraps up today's interview session. ` +
          `Thank you so much for everything you've shared today. ` +
          `Take care until then.`;

        // Soft signal: force Eric to SAY the scheduling question verbatim
        // via Vapi's say action. Bypasses the model's tendency to ignore
        // system-message wrap-up directives. After the say, the participant
        // responds in a normal turn, and the model is much more reliable
        // at invoking schedule_next_session in response to a natural Q->A
        // exchange than at responding to a mid-conversation system message.
        const softWrapupContent =
          `Before we go, I'd like to schedule our next conversation. ` +
          `I was thinking three days from now at this same time. ` +
          `Does that work for you, or would another time be better?`;

        try {
          if (controlUrl && RENDER_BASE_URL && QSTASH_TOKEN) {
            await qstashScheduleAt({
              url: `${RENDER_BASE_URL}/timing/wrap-up`,
              notBeforeSeconds: softWrapupAt,
              body: { callId, controlUrl, content: softWrapupContent }
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

    if (type === "tool-calls") {
      const toolCall = message.toolCallList?.[0];
      const fn = toolCall?.function;
      console.log("tool-calls:", { callId: message?.call?.id, name: fn?.name, arguments: fn?.arguments });
      if (fn?.name === "schedule_callback") {
        const { suggestedTime } = fn.arguments || {};
        // Trust the call's customer number (always E.164) over the model's
        // tool argument, which can be malformed (missing country code,
        // spelled out, etc.).
        const customerNumber =
          message?.call?.customer?.number ||
          fn.arguments?.customerNumber;
        const timezone = inferTimezone(customerNumber);
        const parsed = parseSuggestedTimeToLocalDate({ suggestedTimeText: suggestedTime, timezone });
        if (!parsed) {
          return res.json({
            results: [{ toolCallId: toolCall.id, result: "Could not parse suggested time" }]
          });
        }
        const { targetLocal, localNow, nowUtc } = parsed;
        const offsetMs = localNow.getTime() - nowUtc.getTime();
        const utcTarget = new Date(targetLocal.getTime() - offsetMs);

        const assistantIdForCallback =
          message?.call?.assistantId || message?.assistant?.id || ASSISTANT_ID;
        const callId = message?.call?.id;

        const scheduled = await scheduleVapiCallback({
          assistantId: assistantIdForCallback,
          customerNumber,
          earliestAtIso: utcTarget.toISOString(),
          variableValues: buildVariableValues({
            activeSession: 1,
            priorSessionsContext: "",
            isCallback: true,
            participantName: ""
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
              sessionNumber: 1,
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
        const parsed = parseSuggestedTimeToLocalDate({
          suggestedTimeText: suggestedTime,
          timezone
        });
        if (!parsed) {
          return res.json({
            results: [{
              toolCallId: toolCall.toolCallId || toolCall.id,
              result: "Could not parse suggested time"
            }]
          });
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
          participantName
        });

        const scheduled = await vapiPost("/call", {
          assistantId: assistantIdForNext,
          phoneNumberId: PHONE_NUMBER_ID,
          customer: { number: customerNumber },
          schedulePlan: { earliestAt: utcTarget.toISOString() },
          assistantOverrides: {
            variableValues: nextSessionVars,
            model: await buildModelOverride({ isCallback: false })
          }
        });

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
                participantName: ""
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
    const { callId, controlUrl, content } = req.body || {};
    if (!controlUrl || !content) return res.status(400).json({ error: "Missing controlUrl/content" });
    if (callId && !timersScheduledForCallId.has(callId)) {
      console.log("Skipping wrap-up: call already ended", { callId });
      return res.json({ ok: true, skipped: true });
    }
    // Force Eric to SAY the scheduling question verbatim (no auto-end —
    // the conversation continues so the participant can answer and Eric
    // can invoke schedule_next_session). interruptAssistantEnabled=false
    // makes Vapi wait for Eric to finish his current speech before doing
    // the say, instead of barging in mid-question. System-message
    // wrap-up signals were unreliable; a natural Q->A turn is far more
    // likely to trigger the tool call.
    await forceSpeakViaControlUrl({
      controlUrl,
      content,
      endCallAfterSpoken: false,
      interruptAssistantEnabled: false
    });
    console.log("Soft wrap-up scheduling question forced", { callId });
    return res.json({ ok: true });
  } catch (e) {
    console.error("/timing/wrap-up error", e);
    return res.status(500).json({ ok: false });
  }
});

/**
 * POST /timing/force-close
 * QStash trigger ~30 seconds before hard cap. If the call is still live
 * at this point, Eric did not comply with the soft wrap-up signal — Vapi
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
    const { assistantId, customerNumber, variableValues } = req.body || {};
    if (!assistantId || !customerNumber) {
      return res.status(400).json({ error: "Missing assistantId or customerNumber" });
    }
    const result = await vapiPost("/call", {
      assistantId,
      phoneNumberId: PHONE_NUMBER_ID,
      customer: { number: customerNumber },
      assistantOverrides: {
        variableValues,
        model: await buildModelOverride({ isCallback: true })
      }
    });
    console.log("Fire-callback dialed", { vapiCallId: result?.id, customerNumber });
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
