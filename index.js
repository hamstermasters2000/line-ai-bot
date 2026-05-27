require("dotenv").config();
const express = require("express");
const { Client, middleware } = require("@line/bot-sdk");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
const PORT = process.env.PORT || 3000;

// LINE Config
const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const lineClient = new Client(lineConfig);

// Gemini Config
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

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

async function askGemini(contextId, userMessage, displayName) {
  const history = getHistory(contextId);

  // เพิ่มข้อความ user
  history.push({
    role: "user",
    parts: [{ text: `[${displayName}]: ${userMessage}` }],
  });

  trimHistory(history);

  try {
    const chat = model.startChat({
      history: [
        {
          role: "user",
          parts: [{ text: SYSTEM_PROMPT }],
        },
        {
          role: "model",
          parts: [{ text: `โอเค! ฉันพร้อมแล้วนะ 😊` }],
        },
        ...history.slice(0, -1), // ทุก message ยกเว้นล่าสุด
      ],
    });

    const result = await chat.sendMessage(userMessage);
    const reply = result.response.text();

    // เก็บ reply ของ bot
    history.push({
      role: "model",
      parts: [{ text: reply }],
    });

    return reply;
  } catch (err) {
    console.error("Gemini error:", err.message);
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
  const reply = await askGemini(contextId, cleanText, displayName);

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
