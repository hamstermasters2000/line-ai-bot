require("dotenv").config();
const express = require("express");
const { Client, middleware } = require("@line/bot-sdk");
const Groq = require("groq-sdk");

const app = express();
const PORT = process.env.PORT || 3000;

// LINE Config
const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const lineClient = new Client(lineConfig);

// Groq Config (ฟรี 100%)
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const BOT_NAME = process.env.BOT_NAME || "น้องAI";

// เก็บประวัติสนทนาต่อ group/user (ใน memory, หายเมื่อ restart)
const chatHistory = new Map();

// System prompt สำหรับบอท — แก้ให้สนุกตามใจ
const SYSTEM_PROMPT = `คุณคือ "${BOT_NAME}" บอทสุดน่ารักของกลุ่มเพื่อนๆ มีนิสัยสนุกสนาน พูดภาษาไทยเป็นหลัก
ตอบแบบเพื่อนคุยกัน ไม่เป็นทางการ ใช้ emoji ได้บ้าง ตอบกระชับได้ใจความ
ถ้าไม่รู้เรื่องก็บอกตรงๆ ว่าไม่รู้ ห้ามสร้างข้อมูลเท็จ`;

function getHistory(id) {
  if (!chatHistory.has(id)) {
    chatHistory.set(id, []);
  }
  return chatHistory.get(id);
}

function trimHistory(history, maxTurns = 10) {
  // เก็บแค่ 10 รอบล่าสุด เพื่อไม่ให้ใช้ token เยอะ
  if (history.length > maxTurns * 2) {
    history.splice(0, history.length - maxTurns * 2);
  }
}

async function askGroq(contextId, userMessage, displayName) {
  const history = getHistory(contextId);

  history.push({ role: "user", content: `[${displayName}]: ${userMessage}` });
  trimHistory(history);

  try {
    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      ...history,
    ];

    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages,
      max_tokens: 1024,
    });

    const reply = completion.choices[0].message.content;
    history.push({ role: "assistant", content: reply });
    return reply;
  } catch (err) {
    console.error("Groq error:", err.message);
    return "โอ๊ะ ขอโทษนะ ตอนนี้ฉันสมองแล็ก ลองถามใหม่อีกทีได้เลย 🥲";
  }
}

// Webhook endpoint
app.post("/webhook", middleware(lineConfig), async (req, res) => {
  res.status(200).json({ status: "ok" });

  const events = req.body.events;
  await Promise.all(events.map(handleEvent));
});

async function handleEvent(event) {
  // รองรับเฉพาะข้อความ
  if (event.type !== "message" || event.message.type !== "text") return;

  const text = event.message.text.trim();
  const source = event.source;
  const isGroup = source.type === "group" || source.type === "room";

  // ถ้าอยู่ในกลุ่ม ต้อง mention บอทก่อน (@ชื่อบอท หรือ /ai หรือ /ถาม)
  if (isGroup) {
    const triggerWords = [
      `@${BOT_NAME}`,
      "/ai",
      "/ถาม",
      "/ask",
      BOT_NAME,
    ];
    const triggered = triggerWords.some((t) =>
      text.toLowerCase().startsWith(t.toLowerCase())
    );
    if (!triggered) return; // เงียบถ้าไม่ได้เรียก
  }

  // ตัด trigger word ออกจากข้อความ
  let cleanText = text;
  const triggers = [`@${BOT_NAME}`, "/ai ", "/ถาม ", "/ask ", BOT_NAME];
  for (const t of triggers) {
    if (cleanText.toLowerCase().startsWith(t.toLowerCase())) {
      cleanText = cleanText.slice(t.length).trim();
      break;
    }
  }

  if (!cleanText) {
    cleanText = "สวัสดี";
  }

  // ดึงชื่อผู้ส่ง
  let displayName = "เพื่อน";
  try {
    if (isGroup) {
      const profile = await lineClient.getGroupMemberProfile(
        source.groupId || source.roomId,
        source.userId
      );
      displayName = profile.displayName;
    } else {
      const profile = await lineClient.getProfile(source.userId);
      displayName = profile.displayName;
    }
  } catch (_) {}

  // ID สำหรับ context (แยกตาม group หรือ user)
  const contextId = source.groupId || source.roomId || source.userId;

  // คำสั่งพิเศษ
  if (cleanText === "!reset" || cleanText === "/reset") {
    chatHistory.delete(contextId);
    return lineClient.replyMessage(event.replyToken, {
      type: "text",
      text: "ล้างความจำแล้วนะ เริ่มใหม่กันเลย! 🧹✨",
    });
  }

  if (cleanText === "!help" || cleanText === "/help") {
    return lineClient.replyMessage(event.replyToken, {
      type: "text",
      text: [
        `🤖 ${BOT_NAME} — วิธีใช้งาน`,
        "",
        `📌 เรียกใช้ในกลุ่ม:`,
        `  @${BOT_NAME} [คำถาม]`,
        `  /ai [คำถาม]`,
        `  /ถาม [คำถาม]`,
        "",
        `📌 คำสั่งพิเศษ:`,
        `  /reset — ล้างประวัติสนทนา`,
        `  /help  — แสดงวิธีใช้`,
        "",
        `💬 ใน DM คุยได้เลยไม่ต้อง mention!`,
      ].join("\n"),
    });
  }

  // ถามบอท
  const reply = await askGroq(contextId, cleanText, displayName);

  return lineClient.replyMessage(event.replyToken, {
    type: "text",
    text: reply,
  });
}

// Health check
app.get("/", (req, res) => {
  res.json({ status: "running", bot: BOT_NAME, time: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`🤖 ${BOT_NAME} พร้อมแล้ว! PORT: ${PORT}`);
});
