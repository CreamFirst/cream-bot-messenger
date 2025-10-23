import express from "express";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";

const app = express();
app.use(express.json());

// ENV
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Load brand voice at startup (fallback to a safe default)
let SYSTEM_PROMPT = "You are Cream Bot, a concise, friendly AI assistant. Keep replies brief (2–4 sentences).";
try {
 const p = path.join(process.cwd(), "prompt.md");
 SYSTEM_PROMPT = fs.readFileSync(p, "utf8");
 console.log("✓ Loaded prompt.md");
} catch (err) {
 console.warn("! Could not load prompt.md, using default system prompt.");
}

// --- Webhook verification (Facebook setup step) ---
app.get("/webhook", (req, res) => {
 const mode = req.query["hub.mode"];
 const token = req.query["hub.verify_token"];
 const challenge = req.query["hub.challenge"];

 if (mode === "subscribe" && token === VERIFY_TOKEN) {
   console.log("✓ Webhook verified with Facebook");
   return res.status(200).send(challenge);
 }
 console.log("✗ Webhook verification failed");
 return res.sendStatus(403);
});

// --- Receive messages from Messenger ---
app.post("/webhook", async (req, res) => {
 try {
   const body = req.body;

   if (body.object === "page") {
     for (const entry of body.entry) {
       const event = entry.messaging?.[0];
       if (event?.message?.text) {
         const senderId = event.sender.id;
         const userMessage = event.message.text?.trim() || "";

         // Simple reset command (optional)
         if (/^reset$/i.test(userMessage)) {
           await sendText(senderId, "Reset ✅ How can I help today?");
           continue;
         }

         const reply = await callOpenAI(userMessage);
         await sendText(senderId, reply);
       }
     }
     return res.sendStatus(200);
   }

   return res.sendStatus(404);
 } catch (e) {
   console.error("Webhook error:", e);
   return res.sendStatus(500);
 }
});

// --- Helpers ---
async function callOpenAI(userMessage) {
 try {
   const r = await fetch("https://api.openai.com/v1/chat/completions", {
     method: "POST",
     headers: {
       "Content-Type": "application/json",
       Authorization: `Bearer ${OPENAI_API_KEY}`
     },
     body: JSON.stringify({
       model: "gpt-3.5-turbo",              // leave as-is for now (cheap & fast)
       temperature: 0.6,
       max_tokens: 300,                     // keep answers snappy for Messenger
       messages: [
         { role: "system", content: SYSTEM_PROMPT },
         { role: "user", content: userMessage }
       ]
     })
   });

   const data = await r.json();
   const text =
     data?.choices?.[0]?.message?.content?.trim() ||
     "Sorry—something went wrong. Want me to try again?";
   return text;
 } catch (e) {
   console.error("OpenAI error:", e);
   return "Hmm, I hit a snag there. Want me to try again?";
 }
}

async function sendText(psid, text) {
 // Messenger send API
 const url = `https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`;
 const payload = {
   recipient: { id: psid },
   message: { text }
 };
 const r = await fetch(url, {
   method: "POST",
   headers: { "Content-Type": "application/json" },
   body: JSON.stringify(payload)
 });

 const j = await r.json();
 if (!r.ok) {
   console.error("Send API error:", j);
 }
}

app.listen(3000, () => console.log("Cream Bot running on port 3000"));
// --- health check route (for UptimeRobot/Render) ---
app.get("/health", (req, res) => {
 res.status(200).send("OK");
});

// --- start server ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
 console.log(`✅ Cream Bot running on port ${PORT}`);
});
