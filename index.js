import express from "express";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import { createClient } from "@supabase/supabase-js"; 


const app = express();
app.use(express.static("public"));
app.use(express.json());

/ ===== OAUTH (new clients) =====

const FB_APP_ID = process.env.FB_APP_ID;

const FB_APP_SECRET = process.env.FB_APP_SECRET;

const OAUTH_REDIRECT_URI = process.env.OAUTH_REDIRECT_URI;



// tiny in-memory session store for multi-page picker

// NOTE: resets on redeploy (fine). Only used for a few minutes.

const oauthSessions = new Map(); // sessionId -> { token, me, pages, createdAt }

const OAUTH_SESSION_TTL_MS = 10 * 60 * 1000;



function requireEnv(name, value) {

  if (!value) throw new Error(`Missing env var: ${name}`);

}



function cleanupOauthSessions() {

  const now = Date.now();

  for (const [key, val] of oauthSessions.entries()) {

    if (!val?.createdAt || now - val.createdAt > OAUTH_SESSION_TTL_MS) {

      oauthSessions.delete(key);

    }

  }

}



function makeSessionId() {

  return `${Date.now()}_${Math.random().toString(16).slice(2)}`;

}



function htmlEscape(s) {

  return String(s ?? "")

    .replaceAll("&", "&amp;")

    .replaceAll("<", "&lt;")

    .replaceAll(">", "&gt;")

    .replaceAll('"', "&quot;")

    .replaceAll("'", "&#039;");

}



async function storeClientConfig({

  supabase,

  businessName,

  metaUserId,

  pageId,

  pageName,

  pageAccessToken,

  igAccountId,

}) {

  if (!supabase) throw new Error("Supabase not configured");



  // Try update by page_id first (no unique constraint needed)

  const existing = await supabase

    .from("clients")

    .select("id")

    .eq("page_id", pageId)

    .limit(1)

    .maybeSingle();



  const payload = {

    business_name: businessName || pageName || "Connected Client",

    channel: "messenger", // keep within your allowed set; IG is inferred via ig_account_id

    meta_user_id: metaUserId || null,

    page_id: pageId || null,

    page_name: pageName || null,

    page_access_token: pageAccessToken || null,

    ig_account_id: igAccountId || null,

    connected_at: new Date().toISOString(),

    status: "active",

    updated_at: new Date().toISOString(),

  };



  if (existing?.data?.id) {

    const { error } = await supabase

      .from("clients")

      .update(payload)

      .eq("id", existing.data.id);

    if (error) throw error;

    return { mode: "updated", id: existing.data.id };

  } else {

    const { data, error } = await supabase.from("clients").insert(payload).select("id").single();

    if (error) throw error;

    return { mode: "inserted", id: data.id };

  }

}



app.get("/connect", (req, res) => {

  try {

    requireEnv("FB_APP_ID", FB_APP_ID);

    requireEnv("OAUTH_REDIRECT_URI", OAUTH_REDIRECT_URI);



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



    return res.redirect(authUrl);

  } catch (err) {

    console.error("Connect handler error:", err);

    return res.status(500).send(`Connect error: ${err.message}`);

  }

});



app.get("/auth", async (req, res) => {

  try {

    requireEnv("FB_APP_ID", FB_APP_ID);

    requireEnv("FB_APP_SECRET", FB_APP_SECRET);

    requireEnv("OAUTH_REDIRECT_URI", OAUTH_REDIRECT_URI);



    if (!supabase) return res.status(500).send("Supabase not configured");



    const code = req.query.code;

    if (!code) return res.status(400).send("Missing auth code");



    // 1) Exchange code -> short-lived user access token

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



    // 2) Exchange short-lived -> long-lived user token

    const longResp = await fetch(

      "https://graph.facebook.com/v18.0/oauth/access_token" +

        `?grant_type=fb_exchange_token` +

        `&client_id=${encodeURIComponent(FB_APP_ID)}` +

        `&client_secret=${encodeURIComponent(FB_APP_SECRET)}` +

        `&fb_exchange_token=${encodeURIComponent(shortUserToken)}`

    );



    const longJson = await longResp.json();

    const userAccessToken = longJson?.access_token || shortUserToken;



    // 3) Who connected?

    const meResp = await fetch(

      `https://graph.facebook.com/v18.0/me?fields=id,name&access_token=${encodeURIComponent(

        userAccessToken

      )}`

    );

    const meJson = await meResp.json();



    // 4) Pages list (includes page access_token per page)

    const pagesResp = await fetch(

      `https://graph.facebook.com/v18.0/me/accounts?access_token=${encodeURIComponent(

        userAccessToken

      )}`

    );

    const pagesJson = await pagesResp.json();



    const pages = Array.isArray(pagesJson?.data) ? pagesJson.data : [];



    console.log("OAuth connected user:", meJson);

    console.log(

      "Pages available:",

      pages.map((p) => ({ id: p.id, name: p.name }))

    );



    if (!pages.length) {

      return res.status(500).send("No pages returned from /me/accounts");

    }



    // If only 1 page, auto-select it (no picker)

    if (pages.length === 1) {

      const chosen = pages[0];

      const pageId = chosen.id;

      const pageName = chosen.name;

      const pageAccessToken = chosen.access_token;



      // 5) Get IG account id (if present)

      let igAccountId = null;

      if (pageAccessToken && pageId) {

        const igResp = await fetch(

          `https://graph.facebook.com/v18.0/${encodeURIComponent(

            pageId

          )}?fields=instagram_business_account{id},connected_instagram_account{id}&access_token=${encodeURIComponent(

            pageAccessToken

          )}`

        );

        const igJson = await igResp.json();

        igAccountId =

          igJson?.instagram_business_account?.id ||

          igJson?.connected_instagram_account?.id ||

          null;

      }



      const result = await storeClientConfig({

        supabase,

        businessName: pageName,

        metaUserId: meJson?.id,

        pageId,

        pageName,

        pageAccessToken,

        igAccountId,

      });



      console.log("✅ Supabase client config saved:", result);



      return res.send(`

        <div style="font-family: system-ui; text-align:center; margin-top:80px;">

          <h2>✅ Connected</h2>

          <p>Page: <b>${htmlEscape(pageName)}</b></p>

          <p>You can close this tab.</p>

        </div>

      `);

    }



    // Multi-page: show tiny picker

    cleanupOauthSessions();

    const sessionId = makeSessionId();

    oauthSessions.set(sessionId, {

      token: userAccessToken,

      me: meJson,

      pages,

      createdAt: Date.now(),

    });



    const optionsHtml = pages

      .map(

        (p, idx) => `

          <label style="display:block; padding:10px 0;">

            <input type="radio" name="page_id" value="${htmlEscape(p.id)}" ${

          idx === 0 ? "checked" : ""

        } />

            <span style="margin-left:8px;">${htmlEscape(p.name)} (${htmlEscape(p.id)})</span>

          </label>`

      )

      .join("");



    return res.send(`

      <div style="font-family: system-ui; max-width:720px; margin:60px auto; padding:0 16px;">

        <h2>✅ Connected</h2>

        <p>Select the Page to connect:</p>

        <form method="GET" action="/auth/choose-page">

          <input type="hidden" name="session" value="${htmlEscape(sessionId)}" />

          <div style="border:1px solid #ddd; border-radius:12px; padding:16px;">

            ${optionsHtml}

          </div>

          <button style="margin-top:16px; padding:10px 14px; border-radius:10px; border:1px solid #000; background:#000; color:#fff; cursor:pointer;">

            Connect this Page

          </button>

        </form>

      </div>

    `);

  } catch (err) {

    console.error("Auth handler error:", err);

    return res.status(500).send(`Auth error: ${err.message}`);

  }

});



app.get("/auth/choose-page", async (req, res) => {

  try {

    if (!supabase) return res.status(500).send("Supabase not configured");



    cleanupOauthSessions();



    const sessionId = req.query.session;

    const pageId = req.query.page_id;



    if (!sessionId || !pageId) return res.status(400).send("Missing session or page_id");



    const sess = oauthSessions.get(sessionId);

    if (!sess) return res.status(400).send("Session expired. Please /connect again.");



    const { me, pages } = sess;

    const chosen = pages.find((p) => String(p.id) === String(pageId));

    if (!chosen) return res.status(400).send("Invalid page selection");



    const pageName = chosen.name;

    const pageAccessToken = chosen.access_token;



    // IG account id (if present)

    let igAccountId = null;

    if (pageAccessToken && pageId) {

      const igResp = await fetch(

        `https://graph.facebook.com/v18.0/${encodeURIComponent(

          pageId

        )}?fields=instagram_business_account{id},connected_instagram_account{id}&access_token=${encodeURIComponent(

          pageAccessToken

        )}`

      );

      const igJson = await igResp.json();

      igAccountId =

        igJson?.instagram_business_account?.id ||

        igJson?.connected_instagram_account?.id ||

        null;

    }



    const result = await storeClientConfig({

      supabase,

      businessName: pageName,

      metaUserId: me?.id,

      pageId,

      pageName,

      pageAccessToken,

      igAccountId,

    });



    console.log("✅ Supabase client config saved:", result);

    oauthSessions.delete(sessionId);



    return res.send(`

      <div style="font-family: system-ui; text-align:center; margin-top:80px;">

        <h2>✅ Connected</h2>

        <p>Page: <b>${htmlEscape(pageName)}</b></p>

        <p>You can close this tab.</p>

      </div>

    `);

  } catch (err) {

    console.error("Choose-page error:", err);

    return res.status(500).send(`Choose-page error: ${err.message}`);

  }

});

// ==== SUPABASE CLIENT ====
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase =
 SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
   ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
   : null;


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

// ===== SUPABASE TEST ROUTE =====
app.get("/supabase-ping", async (req, res) => {
    try {
    const { data, error } = await supabase
     .from("clients")
     .select("id, business_name, channel")
     .limit(1);
    if (error) {
     return res.status(500).send(error.message);
    }

   console.log("supabase client test:", data);
     
    res.json({ ok: true, rows: data.length });
    } catch (err) {
    res.status(500).send(err.message);
    }
    });

app.listen(process.env.PORT || 3000, () => console.log("✅ Bot running"));
