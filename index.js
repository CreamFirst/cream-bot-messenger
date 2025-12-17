import express from "express";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";

const app = express();
app.use(express.static("public"));
app.use(express.json());

// --- Remember last IG sender for demo ---
let lastIgSenderId = null;

// --- Instagram OAuth callback (exchanges code for access token) ---
app.get("/auth", async (req, res) => {
 const code = req.query.code;
 console.log("➡️ Instagram OAuth callback hit!");
 console.log("Received code:", code);

 if (!code) {
   return res.status(400).send("Missing OAuth code");
 }

 const params = new URLSearchParams({
   client_id: "1114345447122158", // your App ID
   client_secret: process.env.FB_APP_SECRET,
   redirect_uri: "https://cream-bot-messenger.onrender.com/auth",
   code: code,
 });

 try {
   const response = await fetch(
     `https://graph.facebook.com/v18.0/oauth/access_token?${params}`
   );
   const data = await response.json();
   console.log("✅ Access Token Response:", data);
   res.send("✅ Access token received! Check Render logs for details.");
 } catch (err) {
   console.error("❌ Token exchange failed:", err);
   res.status(500).send("Token exchange failed");
 }
});

// ===== ENV =====
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const PAGE_TOKEN_TANSEA = process.env.PAGE_TOKEN_TANSEA;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const INSTAGRAM_ACCESS_TOKEN = process.env.INSTAGRAM_ACCESS_TOKEN;
const INSTAGRAM_PAGE_TOKEN = process.env.INSTAGRAM_PAGE_TOKEN;

function getMessengerToken(pageId) {
 if (pageId === "760257793839940") return PAGE_ACCESS_TOKEN; // Cream
 if (pageId === "191735510682679") return PAGE_TOKEN_TANSEA; // Tansea

 throw new Error(`No token for pageId ${pageId}`);
}



// ===== Load brand voice at startup =====
let SYSTEM_PROMPT =
 "You are Cream Bot, a concise, friendly AI assistant. Keep replies brief (2–4 sentences).";
try {
 const p = path.join(process.cwd(), "prompt.md");
 SYSTEM_PROMPT = fs.readFileSync(p, "utf8");
 console.log("✓ Loaded prompt.md");
} catch (err) {
 console.warn("! Could not load prompt.md, using default system prompt.");
}

// ===== Webhook verification =====
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

// ===== Receive messages =====
app.post("/webhook", async (req, res) => {
 try {
   const body = req.body;

   // ----- Messenger -----
   if (body.object === "page") {
     for (const entry of body.entry || []) {
       console.log("📘 Incoming Messenger pageId:", entry.id);
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

   // ----- Instagram -----
   if (body.object === "instagram") {
     for (const entry of body.entry || []) {
       for (const event of entry.messaging || []) {
         const senderId = event.sender?.id;
         const text = event.message?.text?.trim();

         if (event.message?.is_echo) {
           console.log("Ignoring echo event from IG");
           continue;
         }
         if (!senderId || !text) continue;

         // store last sender for demo
         lastIgSenderId = senderId;
         console.log("📩 IG message:", text);

         if (/^reset$/i.test(text)) {
           await sendInstagramText(senderId, "Reset ✅ How can I help today?");
           continue;
         }

         const reply = await callOpenAI(text);
         await sendInstagramText(senderId, reply);
       }
     }
     return res.sendStatus(200);
   }

   // ----- WhatsApp -----
   if (body.object === "whatsapp_business_account") {
     for (const entry of body.entry ?? []) {
       for (const change of entry.changes ?? []) {
         const value = change.value || {};
         const messages = value.messages || [];
         for (const msg of messages) {
           if (msg.type !== "text") continue;

           const from = msg.from;
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
     return res.sendStatus(200);
   }

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
 const token = getMessengerToken(pageId);
const url = `https://graph.facebook.com/v20.0/me/messages?access_token=${token}`;
 const payload = { recipient: { id: psid }, message: { text } };
 const r = await fetch(url, {
   method: "POST",
   headers: { "Content-Type": "application/json" },
   body: JSON.stringify(payload),
 });
 if (!r.ok) console.error("Messenger Send API error:", await r.text());
}

async function sendInstagramText(igUserId, text) {
 text = text.replace(/https:\/\//g, "https://\u200B");
 const url = `https://graph.facebook.com/v20.0/me/messages?access_token=${INSTAGRAM_PAGE_TOKEN}`;
 const payload = { recipient: { id: igUserId }, message: { text } };
 const r = await fetch(url, {
   method: "POST",
   headers: { "Content-Type": "application/json" },
   body: JSON.stringify(payload),
 });
 if (!r.ok) console.error("Instagram Send API error:", await r.text());
}

async function sendWhatsAppText(to, text) {
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

// --- Instagram Basic JSON route --- //
app.get("/ig-basic", async (_req, res) => {
 try {
   const token = INSTAGRAM_ACCESS_TOKEN;
   const response = await fetch(
     `https://graph.instagram.com/me?fields=id,username,account_type,media_count&access_token=${token}`
   );
   const data = await response.json();
   res.json(data);
 } catch (err) {
   console.error("Error fetching IG basic info:", err);
   res.status(500).send("Error retrieving IG basic info");
 }
});

// --- Instagram Basic UI route (reviewer-friendly) --- //
app.get("/ig-basic-ui", async (_req, res) => {
 try {
   const p = await fetch(
     `https://graph.instagram.com/me?fields=id,username,account_type,media_count&access_token=${INSTAGRAM_ACCESS_TOKEN}`
   );
   const profile = await p.json();

   const m = await fetch(
     `https://graph.instagram.com/me/media?fields=id,caption,media_url,permalink,timestamp&limit=5&access_token=${INSTAGRAM_ACCESS_TOKEN}`
   );
   const media = await m.json();

   const cards = (media.data || [])
     .map(
       (item) => `
     <div style="margin:12px 0;padding:12px;border:1px solid #ddd;border-radius:8px">
       <div><b>ID:</b> ${item.id}</div>
       <div><b>Caption:</b> ${item.caption ?? "(no caption)"}</div>
       <div><b>When:</b> ${item.timestamp || ""}</div>
       <div><a href="${item.permalink}" target="_blank">Open on Instagram</a></div>
       ${
         item.media_url
           ? `<div style="margin-top:8px"><img src="${item.media_url}" style="max-width:320px;max-height:320px;object-fit:cover"/></div>`
           : ``
       }
     </div>`
     )
     .join("");

   res.send(`
     <html>
     <body style="font-family:Arial,Helvetica,sans-serif;padding:24px;line-height:1.4">
       <h2>Meta Review Demo – Instagram Basic Data</h2>
       <p><b>Username:</b> ${profile.username} &nbsp; | &nbsp; 
          <b>Type:</b> ${profile.account_type} &nbsp; | &nbsp; 
          <b>Media count:</b> ${profile.media_count}</p>
       <h3>Recent Media</h3>
       ${cards || "<p>No media found.</p>"}
     </body>
     </html>
   `);
 } catch (err) {
   console.error("Error fetching IG basic data:", err);
   res.status(500).send("Error retrieving IG basic info");
 }
});

// --- Demo send page --- //
app.get("/demo-send", (_req, res) => {
 res.send(`
   <html><body style="font-family:Arial,Helvetica,sans-serif;padding:24px">
     <h2>Meta Review Demo – Send from App UI</h2>
     <p>Last Instagram sender id: <b>${lastIgSenderId ?? "none yet – DM your IG first"}</b></p>
     <button style="padding:10px 14px;border-radius:6px" onclick="send()">Send test message</button>
     <script>
       async function send(){
         const r = await fetch('/demo-send', { method:'POST' });
         const t = await r.text();
         alert(t);
       }
     </script>
   </body></html>
 `);
});

app.post("/demo-send", async (_req, res) => {
 try {
   if (!lastIgSenderId)
     return res
       .status(400)
       .send("No IG sender yet. DM your Instagram business account first.");
   await sendInstagramText(lastIgSenderId, "Demo: message from Cream Bot");
   res.send("Sent! Check Instagram.");
 } catch (e) {
   console.error("Demo send error:", e);
   res.status(500).send("Error sending message.");
 }
});

// ===== Health check & server =====
app.get("/health", (_req, res) => res.status(200).send("OK"));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Cream Bot running on port ${PORT}`)); 
