import express from "express";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";

const app = express();
app.use(express.json());

app.use(express.json());

// Temporary Instagram auth route
app.get('/auth', (req, res) => {
 console.log('Instagram OAuth callback hit!');
 res.send('✅ Instagram login successful — you can close this tab.');
});

// ===== ENV =====
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;              // Messenger
const VERIFY_TOKEN      = process.env.VERIFY_TOKEN;                   // Used by both webhooks
const OPENAI_API_KEY    = process.env.OPENAI_API_KEY;

// WhatsApp Cloud API
const WHATSAPP_ACCESS_TOKEN   = process.env.WHATSAPP_ACCESS_TOKEN;    // Bearer token from API Setup
const WHATSAPP_PHONE_NUMBER_ID= process.env.WHATSAPP_PHONE_NUMBER_ID; // digits-only ID

// ===== Load brand voice at startup (fallback safe) =====
let SYSTEM_PROMPT = "You are Cream Bot, a concise, friendly AI assistant. Keep replies brief (2–4 sentences).";
try {
 const p = path.join(process.cwd(), "prompt.md");
 SYSTEM_PROMPT = fs.readFileSync(p, "utf8");
 console.log("✓ Loaded prompt.md");
} catch (err) {
 console.warn("! Could not load prompt.md, using default system prompt.");
}

// ===== Webhook verification (Facebook & WhatsApp) =====
app.get("/webhook", (req, res) => {
 const mode = req.query["hub.mode"];
 const token = req.query["hub.verify_token"];
 const challenge = req.query["hub.challenge"];

 if (mode === "subscribe" && token === VERIFY_TOKEN) {
   console.log("✓ Webhook verified");
   return res.status(200).send(challenge);
 }
 console.log("✗ Webhook verification failed");
 return res.sendStatus(403);
});

// ===== Receive messages (Messenger & WhatsApp share the same POST) =====
app.post("/webhook", async (req, res) => {
 try {
   const body = req.body;

   // ----- Messenger: body.object === "page"
   if (body.object === "page") {
     for (const entry of body.entry) {
       const event = entry.messaging?.[0];
       const userMessage = event?.message?.text?.trim();
       const senderId = event?.sender?.id;
       if (!userMessage || !senderId) continue;

       if (/^reset$/i.test(userMessage)) {
         await sendMessengerText(senderId, "Reset ✅ How can I help today?");
         continue;
       }
       const reply = await callOpenAI(userMessage);
       await sendMessengerText(senderId, reply);
     }
     return res.sendStatus(200);
   }

   // ----- WhatsApp Cloud API: body.object === "whatsapp_business_account"
   if (body.object === "whatsapp_business_account") {
     for (const entry of body.entry ?? []) {
       for (const change of entry.changes ?? []) {
         const value = change.value || {};
         const messages = value.messages || [];
         for (const msg of messages) {
           // only respond to text messages
           if (msg.type !== "text") continue;

           const from = msg.from;                    // user's phone (E.164 without +)
           const userMessage = msg.text?.body?.trim();
           if (!from || !userMessage) continue;

           if (/^reset$/i.test(userMessage)) {
             await sendWhatsAppText(from, "Reset ✅ How can I help today?");
             continue;
           }

           const reply = await callOpenAI(userMessage);
           await sendWhatsAppText(from, reply);
         }
       }
     }
     // WhatsApp requires a fast 200
     return res.sendStatus(200);
   }

   // Unknown payload
   return res.sendStatus(404);
 } catch (e) {
   console.error("Webhook error:", e);
   return res.sendStatus(500);
 }
});

// ===== OpenAI helper =====
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
   const text =
     data?.choices?.[0]?.message?.content?.trim() ||
     "Sorry—something went wrong. Want me to try again?";
   return text;
 } catch (e) {
   console.error("OpenAI error:", e);
   return "Hmm, I hit a snag there. Want me to try again?";
 }
}

// ===== Senders =====
async function sendMessengerText(psid, text) {
 const url = `https://graph.facebook.com/v20.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`;
 const payload = { recipient: { id: psid }, message: { text } };
 const r = await fetch(url, {
   method: "POST",
   headers: { "Content-Type": "application/json" },
   body: JSON.stringify(payload),
 });
 if (!r.ok) console.error("Messenger Send API error:", await r.text());
}

async function sendWhatsAppText(to, text) {
 // to = phone number string without '+'
 const url = `https://graph.facebook.com/v20.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`;
 const payload = {
   messaging_product: "whatsapp",
   to,
   text: { body: text },
 };
 const r = await fetch(url, {
   method: "POST",
   headers: {
     "Content-Type": "application/json",
     Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
   },
   body: JSON.stringify(payload),
 });
 if (!r.ok) console.error("WhatsApp Send error:", await r.text());
}

// ===== Health check & server =====
app.get("/health", (_req, res) => res.status(200).send("OK"));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Cream Bot running on port ${PORT}`));

