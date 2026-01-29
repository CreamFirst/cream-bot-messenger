import express from "express";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";

const app = express();
app.use(express.static("public"));
app.use(express.json());

// ===== SIMPLE OAUTH (safe / no tokens shown) =====
const FB_APP_ID = process.env.FB_APP_ID;
const FB_APP_SECRET = process.env.FB_APP_SECRET;
const OAUTH_REDIRECT_URI = process.env.OAUTH_REDIRECT_URI;

app.get("/connect", (req, res) => {
 const scope = [
   "pages_show_list",
   "pages_manage_metadata",
   "pages_messaging",
   "instagram_basic",
   "instagram_manage_messages",
 ].join(",");

 const authUrl =
   "https://www.facebook.com/v18.0/dialog/oauth" +
   `?client_id=${encodeURIComponent(FB_APP_ID)}` +
   `&redirect_uri=${encodeURIComponent(OAUTH_REDIRECT_URI)}` +
   `&response_type=code` +
   `&scope=${encodeURIComponent(scope)}`;

 res.redirect(authUrl);
});

app.get("/auth", async (req, res) => {
 if (!req.query.code) {
   return res.status(400).send("Missing auth code");
 }

 // Exchange code → token (we do NOT store or show it)
 await fetch(
   `https://graph.facebook.com/v18.0/oauth/access_token` +
     `?client_id=${FB_APP_ID}` +
     `&redirect_uri=${encodeURIComponent(OAUTH_REDIRECT_URI)}` +
     `&client_secret=${FB_APP_SECRET}` +
     `&code=${req.query.code}`
 );

 // Clean confirmation page
 res.send(`
   <div style="font-family: system-ui; text-align:center; margin-top:80px;">
     <h2>✅ Connected</h2>
     <p>You can close this tab.</p>
   </div>
 `);
});



// ===== ENV =====
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN; // Cream
const PAGE_TOKEN_TANSEA = process.env.PAGE_TOKEN_TANSEA; // Tansea
const PAGE_TOKEN_COVE = process.env.PAGE_TOKEN_COVE;     // Cove

const INSTAGRAM_PAGE_TOKEN = process.env.INSTAGRAM_PAGE_TOKEN; // Cream
const INSTAGRAM_TOKEN_TANSEA = process.env.INSTAGRAM_TOKEN_TANSEA;
const INSTAGRAM_TOKEN_COVE = process.env.INSTAGRAM_TOKEN_COVE;

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;

// ===== PAGE IDS (MESSENGER) =====
const CREAM_PAGE_ID = "760257793839940";
const TANSEA_PAGE_ID = "191735510682679";
const COVE_PAGE_ID = "388076394663263";

// ===== IG ACCOUNT IDS =====
const IG_ID_CREAM = process.env.IG_ID_CREAM || "";
const IG_ID_TANSEA = process.env.IG_ID_TANSEA || "";
const IG_ID_COVE = process.env.IG_ID_COVE || "";

// ===== HANDOFF / PAUSE =====
const HANDOFF_MINUTES = Number(process.env.HANDOFF_MINUTES || "60");

// key = channel:accountId:userId -> pause expiry
const pausedUntil = new Map();

// Track bot message IDs so echoes don’t pause us
const recentBotMsgIds = new Map();
const BOT_MSG_TTL_MS = 2 * 60 * 1000;

function rememberBotMsgId(id) {
 if (!id) return;
 recentBotMsgIds.set(id, Date.now() + BOT_MSG_TTL_MS);
}

function isOurBotEcho(message) {
 if (message?.app_id) return true;
 if (message?.mid && recentBotMsgIds.has(message.mid)) return true;
 return false;
}

function pauseKey(channel, accountId, userId) {
 return `${channel}:${accountId}:${userId}`;
}

function pauseConversation(channel, accountId, userId) {
 pausedUntil.set(
   pauseKey(channel, accountId, userId),
   Date.now() + HANDOFF_MINUTES * 60 * 1000
 );
}

function isPaused(channel, accountId, userId) {
 const key = pauseKey(channel, accountId, userId);
 const until = pausedUntil.get(key);
 if (!until) return false;
 if (Date.now() >= until) {
   pausedUntil.delete(key);
   return false;
 }
 return true;
}

// ===== TOKEN ROUTERS =====
function getMessengerToken(pageId) {
 if (pageId === CREAM_PAGE_ID) return PAGE_ACCESS_TOKEN;
 if (pageId === TANSEA_PAGE_ID) return PAGE_TOKEN_TANSEA;
 if (pageId === COVE_PAGE_ID) return PAGE_TOKEN_COVE;
 return null;
}

function getInstagramToken(igAccountId) {
 if (igAccountId === IG_ID_CREAM) return INSTAGRAM_PAGE_TOKEN;
 if (igAccountId === IG_ID_TANSEA) return INSTAGRAM_TOKEN_TANSEA;
 if (igAccountId === IG_ID_COVE) return INSTAGRAM_TOKEN_COVE;
 return null;
}

// ===== LOAD PROMPTS =====
function loadPrompt(filename, fallback) {
 try {
   return fs.readFileSync(path.join(process.cwd(), filename), "utf8");
 } catch {
   return fallback;
 }
}

const CREAM_PROMPT = loadPrompt("prompt.md", "You are Cream Bot.");
const TANSEA_PROMPT = loadPrompt("sunny-prompt.md", "You are Sunny.");
const COVE_PROMPT = loadPrompt("cove-prompt.md", "You are Cove Bro.");

// ===== PROMPT ROUTERS =====
function getMessengerPrompt(pageId) {
 if (pageId === TANSEA_PAGE_ID) return TANSEA_PROMPT;
 if (pageId === COVE_PAGE_ID) return COVE_PROMPT;
 return CREAM_PROMPT;
}

function getInstagramPrompt(igId) {
 if (igId === IG_ID_TANSEA) return TANSEA_PROMPT;
 if (igId === IG_ID_COVE) return COVE_PROMPT;
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

       for (const event of entry.messaging || []) {
         const userId = event.sender?.id;
         if (!userId) continue;

         // OWNER / PAGE REPLY → PAUSE BOT
         if (event.message?.is_echo) {
           const customerId = event.recipient?.id;
           if (customerId && !isOurBotEcho(event.message)) {
             pauseConversation("msg", pageId, customerId);
           }
           continue;
         }

         if (isPaused("msg", pageId, userId)) continue;

         const text = event.message?.text?.trim();
         if (!text) continue;

         if (/^reset$/i.test(text)) {
           await sendMessengerText(token, userId, "Reset ✅ How can I help?");
           continue;
         }

         const reply = await callOpenAI(text, getMessengerPrompt(pageId));
         await sendMessengerText(token, userId, reply);
       }
     }
     return res.sendStatus(200);
   }

// ----- WHATSAPP (Cream only) -----
if (body.object === "whatsapp_business_account") {
 console.log("🟢 WhatsApp webhook received");

 for (const entry of body.entry ?? []) {
   for (const change of entry.changes ?? []) {
     const value = change.value || {};
     const msgs = value.messages ?? [];

     console.log("WA change:", {
       hasMessages: msgs.length,
       phone_number_id: value.metadata?.phone_number_id,
     });

     for (const msg of msgs) {
       console.log("WA msg:", { from: msg.from, type: msg.type });

       if (msg.type !== "text") continue;

       const reply = await callOpenAI(msg.text.body, CREAM_PROMPT);
       await sendWhatsAppText(msg.from, reply);
     }
   }
 }

 return res.sendStatus(200);
}

async function sendWhatsAppText(to, text) {
 const url = `https://graph.facebook.com/v20.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`;

 const r = await fetch(url, {
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

 const body = await r.text();
 console.log("📤 WA send status:", r.status, body);

 if (!r.ok) {
   throw new Error(`WhatsApp send failed (${r.status}): ${body}`);
 }
}


   // ----- INSTAGRAM -----
   if (body.object === "instagram") {
     for (const entry of body.entry || []) {
       const igAccountId = entry.id;
       const token = getInstagramToken(igAccountId);
       if (!token) continue;

       for (const event of entry.messaging || []) {
         const userId = event.sender?.id;
         if (!userId) continue;

         // OWNER / HUMAN REPLY → PAUSE BOT
         if (event.message?.is_echo) {
           const customerId = event.recipient?.id;
           if (customerId && !isOurBotEcho(event.message)) {
             pauseConversation("ig", igAccountId, customerId);
           }
           continue;
         }

         if (isPaused("ig", igAccountId, userId)) continue;

         const text = event.message?.text?.trim();
         const hasAttachments =
           Array.isArray(event.message?.attachments) &&
           event.message.attachments.length > 0;

         if (/^reset$/i.test(text || "")) {
           await sendInstagramText(token, userId, "Reset ✅ How can I help?");
           continue;
         }

         if (!text && hasAttachments) {
           await sendInstagramText(token, userId, "Nice one 😃 Thanks for the tag!");
           continue;
         }

         if (!text) continue;

         const reply = await callOpenAI(text, getInstagramPrompt(igAccountId));
         await sendInstagramText(token, userId, reply);
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
 const r = await fetch(
   `https://graph.facebook.com/v20.0/me/messages?access_token=${token}`,
   {
     method: "POST",
     headers: { "Content-Type": "application/json" },
     body: JSON.stringify({ recipient: { id: psid }, message: { text } }),
   }
 );
 try {
   const data = await r.json();
   rememberBotMsgId(data?.message_id || data?.message?.mid);
 } catch {}
}

async function sendInstagramText(token, psid, text) {
 const r = await fetch(
   `https://graph.facebook.com/v20.0/me/messages?access_token=${token}`,
   {
     method: "POST",
     headers: { "Content-Type": "application/json" },
     body: JSON.stringify({ recipient: { id: psid }, message: { text } }),
   }
 );
 try {
   const data = await r.json();
   rememberBotMsgId(data?.message_id || data?.message?.mid);
 } catch {}
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
