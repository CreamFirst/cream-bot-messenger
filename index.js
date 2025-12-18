import express from "express";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";

const app = express();
app.use(express.static("public"));
app.use(express.json());

// ===== ENV =====
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;       // Cream
const PAGE_TOKEN_TANSEA = process.env.PAGE_TOKEN_TANSEA;       // Tansea
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const INSTAGRAM_PAGE_TOKEN = process.env.INSTAGRAM_PAGE_TOKEN;

// ===== PAGE TOKEN ROUTER =====
function getMessengerToken(pageId) {
 if (pageId === "760257793839940") return PAGE_ACCESS_TOKEN; // Cream
 if (pageId === "191735510682679") return PAGE_TOKEN_TANSEA; // Tansea
 return null;
}

// ===== LOAD PROMPT =====
let SYSTEM_PROMPT =
 "You are Cream Bot, a concise, friendly AI assistant. Keep replies brief (2–4 sentences).";

try {
 const p = path.join(process.cwd(), "prompt.md");
 SYSTEM_PROMPT = fs.readFileSync(p, "utf8");
 console.log("✓ Loaded prompt.md");
} catch {
 console.log("! Using default prompt");
}

// =====================================================
// === TANSEA TYPEBOT (Messenger) =======================
// =====================================================

// Store Messenger → Typebot sessions
const typebotSessions = new Map();

// ✅ MUST include /startChat AND use api.typebot.io
const TANSEA_TYPEBOT_START_URL =
 "https://api.typebot.io/api/v1/typebots/my-typebot-7hozva1/startChat";

function safeExtractTypebotReply(data) {
 // Be defensive: Typebot payloads can vary by version/config.
 // Try common shapes:
 // - { messages: [{ type:"text", content:"..." }] }
 // - { messages: [{ type:"text", content: { text: "..." } }] }
 // - { messages: [{ type:"text", text: "..." }] }
 const msgs = Array.isArray(data?.messages) ? data.messages : [];
 const texts = msgs
   .filter((m) => m && m.type === "text")
   .map((m) => {
     if (typeof m.content === "string") return m.content;
     if (typeof m.text === "string") return m.text;
     if (typeof m.content?.text === "string") return m.content.text;
     return "";
   })
   .filter(Boolean);

 return texts.join("\n").trim();
}

async function fetchJsonOrText(url, options) {
 const r = await fetch(url, options);
 const raw = await r.text(); // never JSON.parse blindly
 let json = null;
 try {
   json = JSON.parse(raw);
 } catch {}
 return { ok: r.ok, status: r.status, raw, json };
}

async function callTypebot(psid, message) {
 let sessionId = typebotSessions.get(psid);

 // 1) Start session
 if (!sessionId) {
   const start = await fetchJsonOrText(TANSEA_TYPEBOT_START_URL, {
     method: "POST",
     headers: { "Content-Type": "application/json" },
     body: JSON.stringify({ message }),
   });

   if (!start.ok || !start.json) {
     console.error(
       "Typebot startChat error:",
       start.status,
       start.raw?.slice?.(0, 300)
     );
     return "Sorry — I’m having trouble loading the booking checker right now. Please try again in a moment.";
   }

   sessionId = start.json.sessionId;
   if (sessionId) typebotSessions.set(psid, sessionId);

   const reply = safeExtractTypebotReply(start.json);
   return reply || "No problem — what dates are you thinking of?";
 }

 // 2) Continue session
 const cont = await fetchJsonOrText(
   `https://api.typebot.io/api/v1/sessions/${sessionId}`,
   {
     method: "POST",
     headers: { "Content-Type": "application/json" },
     body: JSON.stringify({ message }),
   }
 );

 // Session expired / invalid → restart once
 if (!cont.ok || !cont.json) {
   console.warn(
     "Typebot session error (resetting):",
     cont.status,
     cont.raw?.slice?.(0, 300)
   );
   typebotSessions.delete(psid);

   const restart = await fetchJsonOrText(TANSEA_TYPEBOT_START_URL, {
     method: "POST",
     headers: { "Content-Type": "application/json" },
     body: JSON.stringify({ message }),
   });

   if (!restart.ok || !restart.json) {
     console.error(
       "Typebot restart error:",
       restart.status,
       restart.raw?.slice?.(0, 300)
     );
     return "Sorry — I’m having trouble right now. Please try again shortly.";
   }

   const newSessionId = restart.json.sessionId;
   if (newSessionId) typebotSessions.set(psid, newSessionId);

   const reply = safeExtractTypebotReply(restart.json);
   return reply || "No problem — what dates are you thinking of?";
 }

 const reply = safeExtractTypebotReply(cont.json);
 return reply || "Sorry — I didn’t quite catch that. What dates are you thinking of?";
}

// =====================================================
// === END TANSEA TYPEBOT ===============================
// =====================================================

// ===== WEBHOOK VERIFY =====
app.get("/webhook", (req, res) => {
 if (
   req.query["hub.mode"] === "subscribe" &&
   req.query["hub.verify_token"] === VERIFY_TOKEN
 ) {
   return res.status(200).send(req.query["hub.challenge"]);
 }
 return res.sendStatus(403);
});

// ===== WEBHOOK RECEIVE =====
app.post("/webhook", async (req, res) => {
 try {
   const body = req.body;

   // ----- FACEBOOK MESSENGER -----
   if (body.object === "page") {
     for (const entry of body.entry || []) {
       const pageId = entry.id;
       const token = getMessengerToken(pageId);
       if (!token) continue;

       const event = entry.messaging?.[0];
       const psid = event?.sender?.id;
       const text = event?.message?.text?.trim();
       if (!psid || !text) continue;

       // Reset: also clear Typebot session if it's Tansea
       if (/^reset$/i.test(text)) {
         if (pageId === "191735510682679") typebotSessions.delete(psid);
         await sendMessengerText(token, psid, "Reset ✅ How can I help?");
         continue;
       }

       let reply;

       // --- Tansea ALWAYS uses Typebot ---
       if (pageId === "191735510682679") {
         reply = await callTypebot(psid, text);
       }
       // --- Cream uses OpenAI ---
       else {
         reply = await callOpenAI(text);
       }

       await sendMessengerText(token, psid, reply);
     }
     return res.sendStatus(200);
   }

   // ----- WHATSAPP -----
   if (body.object === "whatsapp_business_account") {
     for (const entry of body.entry ?? []) {
       for (const change of entry.changes ?? []) {
         for (const msg of change.value?.messages ?? []) {
           if (msg.type !== "text") continue;
           const reply = await callOpenAI(msg.text.body);
           await sendWhatsAppText(msg.from, reply);
         }
       }
     }
     return res.sendStatus(200);
   }

   // ----- INSTAGRAM -----
   if (body.object === "instagram") {
     for (const entry of body.entry || []) {
       for (const event of entry.messaging || []) {
         if (event.message?.is_echo) continue;
         const psid = event.sender?.id;
         const text = event.message?.text?.trim();
         if (!psid || !text) continue;

         const reply = await callOpenAI(text);
         await sendInstagramText(psid, reply);
       }
     }
     return res.sendStatus(200);
   }

   return res.sendStatus(404);
 } catch (err) {
   console.error("Webhook error:", err);
   return res.sendStatus(500);
 }
});

// ===== OPENAI =====
async function callOpenAI(userMessage) {
 try {
   const r = await fetch("https://api.openai.com/v1/chat/completions", {
     method: "POST",
     headers: {
       "Content-Type": "application/json",
       Authorization: `Bearer ${OPENAI_API_KEY}`,
     },
     body: JSON.stringify({
       model: "gpt-3.5-turbo",
       temperature: 0.6,
       max_tokens: 300,
       messages: [
         { role: "system", content: SYSTEM_PROMPT },
         { role: "user", content: userMessage },
       ],
     }),
   });
   const data = await r.json();
   return data?.choices?.[0]?.message?.content?.trim() || "Sorry — try again?";
 } catch {
   return "I hit a snag — want me to try again?";
 }
}

// ===== SENDERS =====
async function sendMessengerText(token, psid, text) {
 const url = `https://graph.facebook.com/v20.0/me/messages?access_token=${token}`;
 await fetch(url, {
   method: "POST",
   headers: { "Content-Type": "application/json" },
   body: JSON.stringify({
     recipient: { id: psid },
     message: { text },
   }),
 });
}

async function sendInstagramText(psid, text) {
 const url = `https://graph.facebook.com/v20.0/me/messages?access_token=${INSTAGRAM_PAGE_TOKEN}`;
 await fetch(url, {
   method: "POST",
   headers: { "Content-Type": "application/json" },
   body: JSON.stringify({
     recipient: { id: psid },
     message: { text },
   }),
 });
}

async function sendWhatsAppText(to, text) {
 const url = `https://graph.facebook.com/v20.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`;
 await fetch(url, {
   method: "POST",
   headers: {
     "Content-Type": "application/json",
     Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
   },
   body: JSON.stringify({
     messaging_product: "whatsapp",
     to,
     text: { body: text },
   }),
 });
}

// ===== HEALTH =====
app.get("/health", (_, res) => res.send("OK"));
app.listen(process.env.PORT || 3000, () => console.log("✅ Bot running"));

