import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// ✅ 1. Webhook verification (Facebook setup step)
app.get("/webhook", (req, res) => {
 const mode = req.query["hub.mode"];
 const token = req.query["hub.verify_token"];
 const challenge = req.query["hub.challenge"];

 if (mode === "subscribe" && token === VERIFY_TOKEN) {
   console.log("✅ Webhook verified with Facebook");
   res.status(200).send(challenge);
 } else {
   console.log("❌ Webhook verification failed");
   res.sendStatus(403);
 }
});

// ✅ 2. Handle incoming messages from Messenger
app.post("/webhook", async (req, res) => {
 try {
   const body = req.body;

   if (body.object === "page") {
     for (const entry of body.entry) {
       const event = entry.messaging[0];
       if (event.message && event.message.text) {
         const senderId = event.sender.id;
         const userMessage = event.message.text;

         // 💬 Generate a reply using OpenAI
         const aiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
           method: "POST",
           headers: {
             "Content-Type": "application/json",
             Authorization: `Bearer ${OPENAI_API_KEY}`,
           },
           body: JSON.stringify({
             model: "gpt-3.5-turbo",
             messages: [
               { role: "system", content: "You are Cream Bot, a friendly AI assistant for Cream First AI." },
               { role: "user", content: userMessage },
             ],
             temperature: 0.7,
           }),
         });

         const data = await aiResponse.json();
         const reply =
           data.choices?.[0]?.message?.content || "Sorry, something went wrong!";

         // 💌 Send the reply back to Messenger
         await fetch(
           `https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
           {
             method: "POST",
             headers: { "Content-Type": "application/json" },
             body: JSON.stringify({
               recipient: { id: senderId },
               message: { text: reply },
             }),
           }
         );
       }
     }
     res.status(200).send("EVENT_RECEIVED");
   } else {
     res.sendStatus(404);
   }
 } catch (err) {
   console.error("❌ Error handling webhook:", err);
   res.sendStatus(500);
 }
});

// ✅ 3. Basic root endpoint (optional)
app.get("/", (req, res) => {
 res.send("Cream Bot Messenger Webhook is running ✅");
});

// ✅ 4. Start server
app.listen(3000, () => {
 console.log("🚀 Cream Bot running on port 3000");
});
