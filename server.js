import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const VAPI_API_KEY = process.env.VAPI_API_KEY;
const ASSISTANT_ID = process.env.ASSISTANT_ID;
const PHONE_NUMBER_ID = "6c89fc63-3d8d-4eca-98e9-ff9798ac5f9c";

const ccToTz = {
  "+1": "America/New_York",   // Add relevant codes and locations, using official IANA database label for geographic location.
  "+254": "Africa/Nairobi",
  "+256": "Africa/Kampala",
  "+255": "Africa/Dar_es_Salaam",
  "+234": "Africa/Lagos",
  "+233": "Africa/Accra",
  "+27": "Africa/Johannesburg",
  "+44": "Europe/London",
  "+91": "Asia/Kolkata"
};

function inferTimezone(number) {
  const codes = Object.keys(ccToTz).sort((a,b)=>b.length-a.length);
  for (const c of codes) {
    if (number.startsWith(c)) return ccToTz[c];
  }
  return "UTC";
}

app.post("/vapi", async (req, res) => {
  const { message } = req.body;

  // Handle tool-calls (this is what Vapi is sending)
  if (message?.type === "tool-calls") {
    const toolCall = message.toolCallList?.[0];
    const fn = toolCall?.function;

    if (fn?.name === "schedule_callback") {
      const { customerNumber, suggestedTime } = fn.arguments;

      // ... your existing timezone + parsing logic ...
      // ... then POST https://api.vapi.ai/call ...

      return res.json({
        results: [
          {
            toolCallId: toolCall.id,
            result: "Callback scheduled"
          }
        ]
      });
    }
  }

  // Keep compatibility if function-call ever arrives
  if (message?.type === "function-call" &&
      message?.functionCall?.name === "schedule_callback") {
    // (optional) handle this variant too
  }

  return res.json({});
});

app.listen(3000, () => console.log("Server running"));
