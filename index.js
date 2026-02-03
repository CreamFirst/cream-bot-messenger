import express from "express";
import fetch from "node-fetch";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(express.static("public"));
app.use(express.json());

/* =========================
  ENV + SUPABASE
========================= */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Prompt fetching
const PROMPT_BASE_URL = process.env.PROMPT_BASE_URL || "https://raw.githubusercontent.com/CreamFirst/cream-bot-messenger/refs/heads/main/"; // must end with /
const PROMPT_CACHE_TTL_MS = Number(process.env.PROMPT_CACHE_TTL_MS || String(10 * 60 * 1000)); // 10 mins

// Handoff
const HANDOFF_MINUTES = Number(process.env.HANDOFF_MINUTES || "60");

// WhatsApp (explicit env exception)
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;

// OAuth (unchanged)
const FB_APP_ID = process.env.FB_APP_ID;
const FB_APP_SECRET = process.env.FB_APP_SECRET;
const OAUTH_REDIRECT_URI = process.env.OAUTH_REDIRECT_URI;

function requireEnv(name, value) {
 if (!value) throw new Error(`Missing env var: ${name}`);
}

const supabase =
 SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
   ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
   : null;

/* =========================
  HANDOFF / PAUSE
========================= */

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
 pausedUntil.set(pauseKey(channel, accountId, userId), Date.now() + HANDOFF_MINUTES * 60 * 1000);
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

/* =========================
  PROMPT LOADER (GitHub)
========================= */

const promptCache = new Map(); // key -> { text, expiresAt }

async function getPromptText(promptKey) {
 if (!promptKey) return "You are a helpful assistant.";

 const cached = promptCache.get(promptKey);
 if (cached && Date.now() < cached.expiresAt) return cached.text;

 if (!PROMPT_BASE_URL) {
   console.warn("PROMPT_BASE_URL missing; using fallback prompt.");
   return "You are a helpful assistant.";
 }

 // You can store prompt_key as "cream" OR "cream.md"
 const filename = promptKey.endsWith(".md") ? promptKey : `${promptKey}.md`;
 const url = `${PROMPT_BASE_URL}${filename}`;

 const r = await fetch(url);
 if (!r.ok) {
   const body = await r.text().catch(() => "");
   throw new Error(`PROMPT_FETCH_FAILED (${r.status}) for ${filename}: ${body.slice(0, 200)}`);
 }

 const text = await r.text();
 promptCache.set(promptKey, { text, expiresAt: Date.now() + PROMPT_CACHE_TTL_MS });
 return text;
}

/* =========================
  SUPABASE RESOLVER
========================= */

async function getClientByMessengerPageId(pageId) {
 const { data, error } = await supabase
   .from("clients")
   .select("*")
   .eq("page_id", String(pageId))
   .limit(1)
   .maybeSingle();

 if (error) throw error;
 return data || null;
}

async function getClientByIgAccountId(igAccountId) {
 const { data, error } = await supabase
   .from("clients")
   .select("*")
   .eq("ig_account_id", String(igAccountId))
   .limit(1)
   .maybeSingle();

 if (error) throw error;
 return data || null;
}

function isActiveClientRow(row) {
 // Using your existing 'status' field as the on/off switch.
 // active = enabled; anything else = off.
 return String(row?.status || "").toLowerCase() === "active";
}

/* =========================
  OAUTH (store page + IG ids/tokens)
  - keeps your existing behavior
  - NOTE: /me/accounts page token is usually sufficient for IG messaging too.
  - ig_access_token column can be kept null OR set equal to page_access_token.
========================= */

async function upsertClientRow({ row }) {
 // upsert by page_id
 const existing = await supabase
   .from("clients")
   .select("id")
   .eq("page_id", row.page_id)
   .limit(1)
   .maybeSingle();

 if (existing?.data?.id) {
   const { error } = await supabase
     .from("clients")
     .update({ ...row, updated_at: new Date().toISOString() })
     .eq("id", existing.data.id);

   if (error) throw error;
   return { mode: "updated", id: existing.data.id };
 } else {
   const { data, error } = await supabase
     .from("clients")
     .insert({ ...row, created_at: new Date().toISOString(), updated_at: new Date().toISOString() })
     .select("id")
     .single();

   if (error) throw error;
   return { mode: "inserted", id: data.id };
 }
}

async function getLongLivedUserToken(shortUserToken) {
 const longResp = await fetch(
   "https://graph.facebook.com/v18.0/oauth/access_token" +
     `?grant_type=fb_exchange_token` +
     `&client_id=${encodeURIComponent(FB_APP_ID)}` +
     `&client_secret=${encodeURIComponent(FB_APP_SECRET)}` +
     `&fb_exchange_token=${encodeURIComponent(shortUserToken)}`
 );
 return longResp.json();
}

async function getIgAccountIdForPage(pageId, pageAccessToken) {
 if (!pageId || !pageAccessToken) return null;

 const igResp = await fetch(
   `https://graph.facebook.com/v18.0/${encodeURIComponent(pageId)}` +
     `?fields=instagram_business_account{id},connected_instagram_account{id}` +
     `&access_token=${encodeURIComponent(pageAccessToken)}`
 );

 const igJson = await igResp.json();
 return (
   igJson?.instagram_business_account?.id ||
   igJson?.connected_instagram_account?.id ||
   null
 );
}

app.get("/auth", async (req, res) => {
 try {
   requireEnv("FB_APP_ID", FB_APP_ID);
   requireEnv("FB_APP_SECRET", FB_APP_SECRET);
   requireEnv("OAUTH_REDIRECT_URI", OAUTH_REDIRECT_URI);
   if (!supabase) return res.status(500).send("Supabase not configured");

   const code = req.query.code;
   if (!code) return res.status(400).send("Missing auth code");

   // 1) code -> short-lived user token
   const tokenResp = await fetch(
     "https://graph.facebook.com/v18.0/oauth/access_token" +
       `?client_id=${encodeURIComponent(FB_APP_ID)}` +
       `&redirect_uri=${encodeURIComponent(OAUTH_REDIRECT_URI)}` +
       `&client_secret=${encodeURIComponent(FB_APP_SECRET)}` +
       `&code=${encodeURIComponent(code)}`
   );

   const tokenJson = await tokenResp.json();
   const shortUserToken = tokenJson?.access_token;

   if (!shortUserToken) {
     console.error("OAuth token exchange failed:", tokenJson);
     return res.status(500).send("OAuth token exchange failed");
   }

   // 2) short -> long-lived user token
   const longJson = await getLongLivedUserToken(shortUserToken);
   const userAccessToken = longJson?.access_token || shortUserToken;

   // 3) who connected
   const meResp = await fetch(
     `https://graph.facebook.com/v18.0/me?fields=id,name&access_token=${encodeURIComponent(userAccessToken)}`
   );
   const meJson = await meResp.json();

   // 4) pages
   const pagesResp = await fetch(
     `https://graph.facebook.com/v18.0/me/accounts?access_token=${encodeURIComponent(userAccessToken)}`
   );
   const pagesJson = await pagesResp.json();
   const pages = Array.isArray(pagesJson?.data) ? pagesJson.data : [];

   if (!pages.length) {
     console.error("No pages returned:", pagesJson);
     return res.status(500).send("No pages returned from /me/accounts");
   }

   for (const p of pages) {
     const pageId = p.id;
     const pageName = p.name;
     const pageAccessToken = p.access_token;

     const igAccountId = await getIgAccountIdForPage(pageId, pageAccessToken);

     const row = {
       business_name: pageName || "Connected Client",
       channel: "messenger",
       meta_user_id: meJson?.id || null,
       page_id: String(pageId),
       page_name: pageName || null,
       page_access_token: pageAccessToken || null,

       // Optional: if you want, you can mirror page token into ig_access_token:
       ig_account_id: igAccountId,
       ig_access_token: null,

       connected_at: new Date().toISOString(),
       status: "active",
     };

     const result = await upsertClientRow({ row });
     console.log("✅ Supabase saved:", {
       pageId,
       pageName,
       igAccountId,
       mode: result.mode,
       id: result.id,
     });
   }

   return res.send(`
     <div style="font-family: system-ui; text-align:center; margin-top:80px;">
       <h2>✅ Connected</h2>
       <p>Saved ${pages.length} page(s) to Supabase.</p>
       <p>You can close this tab.</p>
     </div>
   `);
 } catch (err) {
   console.error("Auth handler error:", err);
   return res.status(500).send(`Auth error: ${err.message}`);
 }
});

/* =========================
  WEBHOOK VERIFY
========================= */

app.get("/webhook", (req, res) => {
 if (
   req.query["hub.mode"] === "subscribe" &&
   req.query["hub.verify_token"] === VERIFY_TOKEN
 ) {
   return res.status(200).send(req.query["hub.challenge"]);
 }
 return res.sendStatus(403);
});

/* =========================
  WEBHOOK RECEIVE (v2)
========================= */

app.post("/webhook", async (req, res) => {
 try {
   const body = req.body;

   // ----- FACEBOOK MESSENGER (Supabase-only) -----
   if (body.object === "page") {
     for (const entry of body.entry || []) {
       const pageId = entry.id;

       if (!supabase) {
         console.error("SUPABASE_NOT_CONFIGURED");
         continue;
       }

       const client = await getClientByMessengerPageId(pageId);

       if (!client) {
         console.warn(`UNROUTED messenger page_id=${pageId}`);
         continue;
       }
       if (!isActiveClientRow(client)) continue;

       const token = client.page_access_token;
       if (!token) {
         console.error(`MISSING_TOKEN messenger page_id=${pageId} business=${client.business_name}`);
         continue;
       }

       const promptText = await getPromptText(client.prompt_key).catch((e) => {
         console.error(`PROMPT_FETCH_FAILED messenger page_id=${pageId} key=${client.prompt_key}:`, e.message);
         return "You are a helpful assistant.";
       });

       for (const event of entry.messaging || []) {
         const userId = event.sender?.id;
         if (!userId) continue;

         // OWNER / PAGE REPLY → PAUSE BOT
         if (event.message?.is_echo) {
           const customerId = event.recipient?.id;
           if (customerId && !isOurBotEcho(event.message)) {
             pauseConversation("msg", String(pageId), String(customerId));
           }
           continue;
         }

         if (isPaused("msg", String(pageId), String(userId))) continue;

         const text = event.message?.text?.trim();
         if (!text) continue;

         if (/^reset$/i.test(text)) {
           await sendMessengerText(token, userId, "Reset ✅ How can I help?");
           continue;
         }

         const reply = await callOpenAI(text, promptText);
         await sendMessengerText(token, userId, reply);
       }
     }
     return res.sendStatus(200);
   }

   // ----- WHATSAPP (explicit env exception; Cream-only lane) -----
   if (body.object === "whatsapp_business_account") {
     // Keep WhatsApp exactly as env-based (as agreed).
     if (!WHATSAPP_ACCESS_TOKEN || !WHATSAPP_PHONE_NUMBER_ID) {
       console.error("WA_ENV_MISSING");
       return res.sendStatus(200);
     }

     for (const entry of body.entry ?? []) {
       for (const change of entry.changes ?? []) {
         const value = change.value || {};
         const msgs = value.messages ?? [];

         for (const msg of msgs) {
           if (msg.type !== "text") continue;

           const reply = await callOpenAI(msg.text.body, CREAM_PROMPT);
      await sendWhatsAppText(msg.from, reply);
         }
       }
     }

     return res.sendStatus(200);
   }

   // ----- INSTAGRAM (Supabase-only) -----
   if (body.object === "instagram") {
     for (const entry of body.entry || []) {
       const igAccountId = entry.id;

       if (!supabase) {
         console.error("SUPABASE_NOT_CONFIGURED");
         continue;
       }

       const client = await getClientByIgAccountId(igAccountId);

       if (!client) {
         console.warn(`UNROUTED instagram ig_account_id=${igAccountId}`);
         continue;
       }
       if (!isActiveClientRow(client)) continue;

       const token = client.ig_access_token || client.page_access_token;
       if (!token) {
         console.error(`MISSING_TOKEN instagram ig_account_id=${igAccountId} business=${client.business_name}`);
         continue;
       }

       const promptText = await getPromptText(client.prompt_key).catch((e) => {
         console.error(`PROMPT_FETCH_FAILED instagram ig_account_id=${igAccountId} key=${client.prompt_key}:`, e.message);
         return "You are a helpful assistant.";
       });

       for (const event of entry.messaging || []) {
         const userId = event.sender?.id;
         if (!userId) continue;

         // OWNER / HUMAN REPLY → PAUSE BOT
         if (event.message?.is_echo) {
           const customerId = event.recipient?.id;
           if (customerId && !isOurBotEcho(event.message)) {
             pauseConversation("ig", String(igAccountId), String(customerId));
           }
           continue;
         }

         if (isPaused("ig", String(igAccountId), String(userId))) continue;

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

         const reply = await callOpenAI(text, promptText);
         await sendInstagramText(token, userId, reply);
       }
     }
     return res.sendStatus(200);
   }

   return res.sendStatus(404);
 } catch (err) {
   console.error("Webhook error:", err);
   // Still return 200 or 500? Meta will retry on 500.
   // For stability, you can return 200 after logging, but keeping 500 is okay while testing.
   return res.sendStatus(500);
 }
});

/* =========================
  OPENAI
========================= */

async function callOpenAI(userMessage, systemPrompt) {
 try {
   const model = process.env.OPENAI_MODEL || "gpt-3.5-turbo"; // keep your existing default

   const r = await fetch("https://api.openai.com/v1/chat/completions", {
     method: "POST",
     headers: {
       "Content-Type": "application/json",
       Authorization: `Bearer ${OPENAI_API_KEY}`,
     },
     body: JSON.stringify({
       model,
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

/* =========================
  SENDERS
========================= */

async function sendMessengerText(token, psid, text) {
 const r = await fetch(`https://graph.facebook.com/v20.0/me/messages?access_token=${token}`, {
   method: "POST",
   headers: { "Content-Type": "application/json" },
   body: JSON.stringify({ recipient: { id: psid }, message: { text } }),
 });
 try {
   const data = await r.json();
   rememberBotMsgId(data?.message_id || data?.message?.mid);
 } catch {}
}

async function sendInstagramText(token, psid, text) {
 const r = await fetch(`https://graph.facebook.com/v20.0/me/messages?access_token=${token}`, {
   method: "POST",
   headers: { "Content-Type": "application/json" },
   body: JSON.stringify({ recipient: { id: psid }, message: { text } }),
 });
 try {
   const data = await r.json();
   rememberBotMsgId(data?.message_id || data?.message?.mid);
 } catch {}
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

 if (!r.ok) {
   const body = await r.text().catch(() => "");
   throw new Error(`WhatsApp send failed (${r.status}): ${body}`);
 }
}

/* =========================
  HEALTH + SUPABASE TEST
========================= */

app.get("/health", (_, res) => res.send("OK"));

app.get("/supabase-ping", async (req, res) => {
 try {
   if (!supabase) return res.status(500).send("Supabase not configured");
   const { data, error } = await supabase.from("clients").select("id, business_name, status, prompt_key").limit(1);
   if (error) return res.status(500).send(error.message);
   res.json({ ok: true, rows: data.length, sample: data?.[0] || null });
 } catch (err) {
   res.status(500).send(err.message);
 }
});

app.listen(process.env.PORT || 3000, () => console.log("✅ Bot running (v2)"));
