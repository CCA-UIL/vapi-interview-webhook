import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const VAPI_API_KEY = process.env.VAPI_API_KEY;
const ASSISTANT_ID = process.env.ASSISTANT_ID;
// NOTE: you hard-coded this; consider moving to env var later.
const PHONE_NUMBER_ID = "6c89fc63-3d8d-4eca-98e9-ff9798ac5f9c";

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

// Prevent scheduling twice (tool-call + end-of-call-report) for the same call
const scheduledByCallId = new Map(); // callId -> timestampMs

function markScheduled(callId) {
  if (!callId) return;
  scheduledByCallId.set(callId, Date.now());
}

function wasScheduled(callId) {
  if (!callId) return false;
  // expire entries after 1 hour to prevent memory growth
  const ts = scheduledByCallId.get(callId);
  if (!ts) return false;
  if (Date.now() - ts > 60 * 60 * 1000) {
    scheduledByCallId.delete(callId);
    return false;
  }
  return true;
}


function inferTimezone(number = "") {
  const codes = Object.keys(ccToTz).sort((a, b) => b.length - a.length);
  for (const c of codes) {
    if (number.startsWith(c)) return ccToTz[c];
  }
  return "UTC";
}

/**
 * Very small parser for “tomorrow”, “in X minutes”, and “at 3pm/15:30”.
 * Returns a Date in the *customer local time basis* (represented as a JS Date),
 * plus metadata used by caller to convert to UTC.
 */
function parseSuggestedTimeToLocalDate({ suggestedTimeText, timezone, customerNumber }) {
  if (!suggestedTimeText) return null;

  const nowUtc = new Date();

  // "Local now" represented in JS Date by formatting into that TZ then parsing.
  const localNow = new Date(nowUtc.toLocaleString("en-US", { timeZone: timezone }));
  let targetLocal = new Date(localNow);

  const lower = suggestedTimeText.toLowerCase();

  // tomorrow
  if (/\btomorrow\b/.test(lower)) {
    targetLocal.setDate(targetLocal.getDate() + 1);
  }

  // in X minutes
  const inMin = lower.match(/\bin\s+(\d+)\s*minute(s)?\b/);
  if (inMin) {
    targetLocal.setMinutes(targetLocal.getMinutes() + parseInt(inMin[1], 10));
    targetLocal.setSeconds(0, 0);
    return { targetLocal, localNow, nowUtc };
  }

  // at HH:MM (24h)
  const hm24 = lower.match(/\b(at\s*)?(\d{1,2}):(\d{2})\b/);
  if (hm24) {
    const h = parseInt(hm24[2], 10);
    const m = parseInt(hm24[3], 10);
    targetLocal.setHours(h, m, 0, 0);
    // if time already passed today, assume tomorrow
    if (targetLocal.getTime() <= localNow.getTime()) targetLocal.setDate(targetLocal.getDate() + 1);
    return { targetLocal, localNow, nowUtc };
  }

  // at H am/pm
  const ampm = lower.match(/\b(at\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/);
  if (ampm) {
    let h = parseInt(ampm[2], 10);
    const m = ampm[3] ? parseInt(ampm[3], 10) : 0;
    const mer = ampm[4];
    if (mer === "pm" && h !== 12) h += 12;
    if (mer === "am" && h === 12) h = 0;
    targetLocal.setHours(h, m, 0, 0);
    if (targetLocal.getTime() <= localNow.getTime()) targetLocal.setDate(targetLocal.getDate() + 1);
    return { targetLocal, localNow, nowUtc };
  }

  // fallback: your old “X minute” pattern (without "in")
  const mins = lower.match(/(\d+)\s*minute(s)?\b/);
  if (mins) {
    targetLocal.setMinutes(targetLocal.getMinutes() + parseInt(mins[1], 10));
    targetLocal.setSeconds(0, 0);
    return { targetLocal, localNow, nowUtc };
  }

  return null;
}

/**
 * Extract a "suggested time" from transcript.
 * This is intentionally conservative; we can tighten once we see your real transcript patterns.
 */
function extractSuggestedTimeFromTranscript(transcript = "") {
  const text = transcript.replace(/\s+/g, " ").trim();
  if (!text) return null;

  // Try to find a segment near "call me", "callback", "reach me", "tomorrow", "in X minutes", "at 3pm"
  const patterns = [
    /\b(call me back|callback|call me|reach me)\b[^.?!]*?(\btomorrow\b[^.?!]*|\bin\s+\d+\s*minute[s]?\b[^.?!]*|\bat\s+\d{1,2}(:\d{2})?\s*(am|pm)\b[^.?!]*|\b\d{1,2}:\d{2}\b[^.?!]*)/i,
    /(\btomorrow\b[^.?!]*|\bin\s+\d+\s*minute[s]?\b[^.?!]*|\bat\s+\d{1,2}(:\d{2})?\s*(am|pm)\b[^.?!]*|\b\d{1,2}:\d{2}\b[^.?!]*)/i
  ];

  for (const p of patterns) {
    const m = text.match(p);
    if (m) {
      // if we used the first pattern, the time-ish chunk is capture group 2; otherwise group 1
      return (m[2] || m[1] || "").trim();
    }
  }
  return null;
}

async function scheduleCallback({ customerNumber, earliestAtIso }) {
  const response = await fetch("https://api.vapi.ai/call", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${VAPI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      assistantId: ASSISTANT_ID,
      phoneNumberId: PHONE_NUMBER_ID,
      customer: { number: customerNumber },
      schedulePlan: { earliestAt: earliestAtIso },
      assistantOverrides: {
        variableValues: { IS_CALLBACK: "true" }
      }
    })
  });

  const result = await response.json();
  if (!response.ok) {
    throw new Error(`Vapi call schedule failed: ${response.status} ${JSON.stringify(result)}`);
  }
  return result;
}

app.post("/vapi", async (req, res) => {
  try {
    const message = req.body?.message; // <-- use ONE variable name everywhere

    console.log("Webhook summary:", {
      type: message?.type,
      endedReason: message?.endedReason,
      customer: message?.customer?.number || message?.call?.customer?.number,
      transcript:
        message?.artifact?.transcript ||
        message?.call?.artifact?.transcript ||
        message?.transcript ||
        message?.call?.transcript
    });

    // Keep old tool-calls path (optional)
    if (message?.type === "tool-calls") {
      const toolCall = message.toolCallList?.[0];
      const fn = toolCall?.function;

      if (fn?.name === "schedule_callback") {
        const { customerNumber, suggestedTime } = fn.arguments;

        const timezone = inferTimezone(customerNumber);
        const parsed = parseSuggestedTimeToLocalDate({
          suggestedTimeText: suggestedTime,
          timezone,
          customerNumber
        });

        if (!parsed) {
          return res.json({
            results: [{ toolCallId: toolCall.id, result: "Could not parse suggested time" }]
          });
        }

        const { targetLocal, localNow, nowUtc } = parsed;
        const offsetMs = localNow.getTime() - nowUtc.getTime();
        const utcTarget = new Date(targetLocal.getTime() - offsetMs);

        await scheduleCallback({ customerNumber, earliestAtIso: utcTarget.toISOString() });

        const callId = message?.call?.id;
        
        if (!callId) {
          console.log("tool-calls schedule_callback: missing message.call.id; dedupe may not work");
        }
       
        const dedupeKey = callId || `${customerNumber}:${suggestedTime}`;
        markScheduled(dedupeKey);

        return res.json({
           results: [{ toolCallId: toolCall.id, result: "Callback scheduled" }]
        });
      }

      return res.json({ results: [] });
    }

// ✅ end-of-call-report path (fallback only)
if (message?.type === "end-of-call-report") {
  const callIdKey = message?.call?.id || message?.callId;
  const timeKey = `${customerNumber}:${suggestedTimeText}`;

  if (wasScheduled(callIdKey) || wasScheduled(timeKey)) {
    console.log("Skipping end-of-call scheduling; already scheduled via tool-calls", { callIdKey, timeKey });
    return res.json({});
  }

  const call = message.call;

  const customerNumber =
    call?.customer?.number ||
    message?.customer?.number;

  const transcript =
    message?.artifact?.transcript ||
    call?.artifact?.transcript ||
    message?.transcript ||
    call?.transcript ||
    "";

  if (!customerNumber) {
    console.log("end-of-call-report received but no customer number found");
    return res.json({});
  }

  const timezone = inferTimezone(customerNumber);
  const suggestedTimeText = extractSuggestedTimeFromTranscript(transcript);

  if (!suggestedTimeText) {
    console.log("No suggested time found in transcript. customer:", customerNumber);
    return res.json({});
  }

  const parsed = parseSuggestedTimeToLocalDate({
    suggestedTimeText,
    timezone,
    customerNumber
  });

  if (!parsed) {
    console.log("Found suggested time text but could not parse:", suggestedTimeText);
    return res.json({});
  }

  const { targetLocal, localNow, nowUtc } = parsed;
  const offsetMs = localNow.getTime() - nowUtc.getTime();
  const utcTarget = new Date(targetLocal.getTime() - offsetMs);

  const scheduled = await scheduleCallback({
    customerNumber,
    earliestAtIso: utcTarget.toISOString()
  });

  console.log("Callback scheduled from end-of-call-report:", {
    customerNumber,
    timezone,
    suggestedTimeText,
    utcTarget: utcTarget.toISOString(),
    scheduledCallId: scheduled?.id
  });

  return res.json({});
}

    return res.json({});
  } catch (err) {
    console.error("Webhook error:", err);
    return res.status(200).json({});
  }
});

app.listen(3000, () => console.log("Server running"));
