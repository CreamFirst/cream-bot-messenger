import express from "express";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";

const app = express();
app.use(express.static("public"));
app.use(express.json());

// ===== ENV =====
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN; // Cream (Messenger Page Token)
const PAGE_TOKEN_TANSEA = process.env.PAGE_TOKEN_TANSEA; // Tansea (Messenger Page Token)

const INSTAGRAM_PAGE_TOKEN = process.env.INSTAGRAM_PAGE_TOKEN; // Cream (Instagram Page Token)
const INSTAGRAM_TOKEN_TANSEA = process.env.INSTAGRAM_TOKEN_TANSEA; // Tansea (Instagram Page Token) ✅ add in Render env

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;

// ===== PAGE IDS (MESSENGER) =====
const CREAM_PAGE_ID = "760257793839940";
const TANSEA_PAGE_ID = "191735510682679";

// ===== IG ACCOUNT IDS (INSTAGRAM) =====
// IMPORTANT: Instagram webhooks route by Instagram Account ID (entry.id), not Facebook Page ID.
// Put these in Render env to avoid hardcoding:
//   IG_ID_CREAM=xxxxxxxxxxxxx
//   IG_ID_TANSEA=yyyyyyyyyyyyy
const IG_ID_CREAM = process.env.IG_ID_CREAM || "";   // Instagram Account ID for Cream
const IG_ID_TANSEA = process.env.IG_ID_TANSEA || ""; // Instagram Account ID for Tansea

// ===== TOKEN ROUTERS =====
function getMessengerToken(pageId) {
 if (pageId === CREAM_PAGE_ID) return PAGE_ACCESS_TOKEN;
 if (pageId === TANSEA_PAGE_ID) return PAGE_TOKEN_TANSEA;
 return null;
}

function getInstagramToken(igAccountId) {
 if (igAccountId && igAccountId === IG_ID_CREAM) return INSTAGRAM_PAGE_TOKEN;
 if (igAccountId && igAccountId === IG_ID_TANSEA) return INSTAGRAM_TOKEN_TANSEA;
 return null;
}

// ===== LOAD PROMPTS =====
function loadPrompt(filename, fallback) {
 try {
   const p = path.join(process.cwd(), filename);
   const txt = fs.readFileSync(p, "utf8");
   console.log(`✓ Loaded ${filename}`);
   return txt;
 } catch {
   console.log(`! Using fallback for ${filename}`);
   return fallback;
 }
}

const CREAM_PROMPT = loadPrompt(
 "prompt.md",
 "You are Cream Bot, a concise, friendly AI assistant."
);

const TANSEA_PROMPT = loadPrompt(
 "sunny-prompt.md",
 "You are Sunny, a friendly holiday let concierge."
);

// ===== PROMPT ROUTERS =====
function getMessengerPrompt(pageId) {
 if (pageId === TANSEA_PAGE_ID) return TANSEA_PROMPT;
 return CREAM_PROMPT;
}

function getInstagramPrompt(igAccountId) {
 if (igAccountId && igAccountId === IG_ID_TANSEA) return TANSEA_PROMPT;
 return CREAM_PROMPT;
}

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

       if (/^reset$/i.test(text)) {
         await sendMessengerText(token, psid, "Reset ✅ How can I help?");
         continue;
       }

       const systemPrompt = getMessengerPrompt(pageId);
       const reply = await callOpenAI(text, systemPrompt);
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
           const reply = await callOpenAI(msg.text.body, CREAM_PROMPT);
           await sendWhatsAppText(msg.from, reply);
         }
       }
     }
     return res.sendStatus(200);
   }

   // ----- INSTAGRAM -----
   if (body.object === "instagram") {
     for (const entry of body.entry || []) {
       const igAccountId = entry.id; // ✅ THIS is the key difference
       const token = getInstagramToken(igAccountId);

       // Helpful log so you can grab the IDs once, then set IG_ID_CREAM / IG_ID_TANSEA
       if (!token) {
         console.log("📸 IG event for unrecognised igAccountId (set IG_ID_* env):", igAccountId);
         continue;
       }

       for (const event of entry.messaging || []) {
         // ignore echo
         if (event.message?.is_echo) continue;

         const psid = event.sender?.id;
         const text = event.message?.text?.trim();

         // If it’s an attachment/image with no text, reply politely (optional)
         const hasAttachments = Array.isArray(event.message?.attachments) && event.message.attachments.length > 0;

         if (!psid) continue;

         if (/^reset$/i.test(text || "")) {
           await sendInstagramText(token, psid, "Reset ✅ How can I help?");
           continue;
         }

         if (!text && hasAttachments) {
           // quick “image reply” behaviour (keeps you from looking broken)
           await sendInstagramText(token, psid, "Nice 🙂 What can I help you with?");
           continue;
         }

         if (!text) continue;

         const systemPrompt = getInstagramPrompt(igAccountId);
         const reply = await callOpenAI(text, systemPrompt);
         await sendInstagramText(token, psid, reply);
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
async function callOpenAI(userMessage, systemPrompt) {
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
         { role: "system", content: systemPrompt },
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

async function sendInstagramText(token, psid, text) {
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

