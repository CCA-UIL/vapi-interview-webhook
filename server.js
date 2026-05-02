import express from "express";
import fetch from "node-fetch";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(express.json());

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

function parseSuggestedTimeToLocalDate({ suggestedTimeText, timezone }) {
  if (!suggestedTimeText) return null;
  const nowUtc = new Date();
  const localNow = new Date(nowUtc.toLocaleString("en-US", { timeZone: timezone }));
  let targetLocal = new Date(localNow);
  const lower = suggestedTimeText.toLowerCase();

  if (/\btomorrow\b/.test(lower)) targetLocal.setDate(targetLocal.getDate() + 1);

  const inMin = lower.match(/\bin\s+(\d+)\s*minute(s)?\b/);
  if (inMin) {
    targetLocal.setMinutes(targetLocal.getMinutes() + parseInt(inMin[1], 10));
    targetLocal.setSeconds(0, 0);
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

async function startVapiCall({ assistantId, customerNumber, variableValues }) {
  return vapiPost("/call", {
    assistantId,
    phoneNumberId: PHONE_NUMBER_ID,
    customer: { number: customerNumber },
    assistantOverrides: { variableValues }
  });
}

async function scheduleVapiCallback({ assistantId, customerNumber, earliestAtIso, variableValues }) {
  return vapiPost("/call", {
    assistantId,
    phoneNumberId: PHONE_NUMBER_ID,
    customer: { number: customerNumber },
    schedulePlan: { earliestAt: earliestAtIso },
    assistantOverrides: { variableValues: { ...variableValues, IS_CALLBACK: "true" } }
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

async function endVapiCall(callId) {
  try {
    const resp = await fetch(`https://api.vapi.ai/call/${callId}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${VAPI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ status: "ended" })
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
        const wrapupAt = Math.floor((startMs + (INTERVIEW_MAX_MINUTES - WRAPUP_OFFSET_MINUTES) * 60 * 1000) / 1000);
        const hardCapAt = Math.floor((startMs + INTERVIEW_MAX_MINUTES * 60 * 1000) / 1000);

        const wrapupContent =
          `Wrap-up signal: We are approaching the time cap for this conversation. ` +
          `Per <time_management>, stop opening new milestones. Wind down the current ` +
          `milestone with at most one closing follow-up, then deliver the open-ended ` +
          `close question for your active session as defined in <closing_protocol>. ` +
          `Acknowledge the participant's response in three words or fewer. Then ` +
          `deliver the closing line for your active session and call endCall.`;

        try {
          if (controlUrl && RENDER_BASE_URL && QSTASH_TOKEN) {
            await qstashScheduleAt({
              url: `${RENDER_BASE_URL}/timing/wrap-up`,
              notBeforeSeconds: wrapupAt,
              body: { callId, controlUrl, content: wrapupContent }
            });
            await qstashScheduleAt({
              url: `${RENDER_BASE_URL}/timing/hard-cap`,
              notBeforeSeconds: hardCapAt,
              body: { callId }
            });
            console.log("Scheduled wrap-up + hard-cap timers", { callId, wrapupAt, hardCapAt });
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
      if (fn?.name === "schedule_callback") {
        const { customerNumber, suggestedTime } = fn.arguments || {};
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
            result: `Callback scheduled. Confirm to the user: "Got it — I'll call you back ${suggestedTime}."`
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
    await injectSystemMessageViaControlUrl({ controlUrl, content });
    console.log("Injected wrap-up signal", { callId });
    return res.json({ ok: true });
  } catch (e) {
    console.error("/timing/wrap-up error", e);
    return res.status(500).json({ ok: false });
  }
});

/**
 * POST /timing/hard-cap
 * QStash trigger at INTERVIEW_MAX_MINUTES. Forcibly ends the Vapi call.
 */
app.post("/timing/hard-cap", async (req, res) => {
  try {
    const { callId } = req.body || {};
    if (!callId) return res.status(400).json({ error: "Missing callId" });
    await endVapiCall(callId);
    console.log("Hard cap fired", { callId });
    return res.json({ ok: true });
  } catch (e) {
    console.error("/timing/hard-cap error", e);
    return res.status(500).json({ ok: false });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on ${PORT}`));
