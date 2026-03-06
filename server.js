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

  if (message?.type === "function-call" &&
      message.functionCall?.name === "schedule_callback") {

    const { customerNumber, suggestedTime } =
      message.functionCall.arguments;

    const tz = inferTimezone(customerNumber);
    const now = new Date();
    const localNow = new Date(
      now.toLocaleString("en-US", { timeZone: tz })
    );

    let target = new Date(localNow);
    if (suggestedTime.toLowerCase().includes("tomorrow"))
      target.setDate(target.getDate() + 1);

    target.setHours(9,0,0,0); // simple default time

    const offsetMs = localNow.getTime() - now.getTime();
    const utcTarget = new Date(target.getTime() - offsetMs);

    await fetch("https://api.vapi.ai/call", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${VAPI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        assistantId: ASSISTANT_ID,
        phoneNumberId: PHONE_NUMBER_ID,
        customer: { number: customerNumber },
        schedulePlan: { earliestAt: utcTarget.toISOString() },
        assistantOverrides: {
          variableValues: { IS_CALLBACK: "true" }
        }
      })
    });

    return res.json({
      results: [{
        toolCallId: message.functionCall.id,
        result: "Callback scheduled"
      }]
    });
  }

  res.json({});
});

app.listen(3000, () => console.log("Server running"));
