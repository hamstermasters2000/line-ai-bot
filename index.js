require("dotenv").config();
const express = require("express");
const fs = require("fs");
const path = require("path");
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

// เก็บประวัติสนทนาต่อ group/user (บันทึกลงไฟล์ด้วย)
const chatHistory = new Map();
const HISTORY_DIR = path.join(__dirname, "chat_history");
if (!fs.existsSync(HISTORY_DIR)) fs.mkdirSync(HISTORY_DIR);

// System prompt สำหรับบอท — แก้ให้สนุกตามใจ
const SYSTEM_PROMPT = `คุณคือ "${BOT_NAME}" บอทสุดน่ารักของกลุ่มเพื่อนๆ มีนิสัยสนุกสนาน พูดภาษาไทยเป็นหลัก
ตอบแบบเพื่อนคุยกัน ไม่เป็นทางการ ใช้ emoji ได้บ้าง ตอบกระชับได้ใจความ
ถ้าไม่รู้เรื่องก็บอกตรงๆ ว่าไม่รู้ ห้ามสร้างข้อมูลเท็จ`;

const LOG_FILE = path.join(__dirname, "ai_replies.txt");

function saveReply(displayName, userMessage, aiReply) {
  const timestamp = new Date().toLocaleString("th-TH", { timeZone: "Asia/Bangkok" });
  const log = `[${timestamp}] ${displayName}: ${userMessage}\n${BOT_NAME}: ${aiReply}\n---\n`;
  fs.appendFileSync(LOG_FILE, log, "utf8");
}

function getHistoryFile(id) {
  return path.join(HISTORY_DIR, `${id}.json`);
}

function getHistory(id) {
  if (!chatHistory.has(id)) {
    // โหลดจากไฟล์ถ้ามี
    const file = getHistoryFile(id);
    try {
      if (fs.existsSync(file)) {
        chatHistory.set(id, JSON.parse(fs.readFileSync(file, "utf8")));
      } else {
        chatHistory.set(id, []);
      }
    } catch {
      chatHistory.set(id, []);
    }
  }
  return chatHistory.get(id);
}

function saveHistoryToFile(id) {
  const history = chatHistory.get(id);
  if (history) {
    fs.writeFileSync(getHistoryFile(id), JSON.stringify(history), "utf8");
  }
}

function trimHistory(history, maxTurns = 250) {
  // เก็บ 250 รอบในไฟล์
  if (history.length > maxTurns * 2) {
    history.splice(0, history.length - maxTurns * 2);
  }
}

function buildMessages(history) {
  const MAX_RECENT = 20; // 20 รอบล่าสุด ส่งแบบเต็ม
  const recentCount = MAX_RECENT * 2;

  if (history.length <= recentCount) {
    return { recap: "", recentMessages: history };
  }

  // ประวัติเก่า → สรุปย่อให้ AI recheck
  const older = history.slice(0, -recentCount);
  const lines = older.map((msg) => {
    const short = msg.content.length > 80
      ? msg.content.substring(0, 80) + "..."
      : msg.content;
    return msg.role === "user" ? `ผู้ใช้: ${short}` : `บอท: ${short}`;
  });

  const recap = `\n\n📌 สรุปบทสนทนาก่อนหน้า (recheck):\n${lines.join("\n")}`;
  const recentMessages = history.slice(-recentCount);

  return { recap, recentMessages };
}

async function askGroq(contextId, userMessage, displayName) {
  const history = getHistory(contextId);

  history.push({ role: "user", content: `[${displayName}]: ${userMessage}` });
  trimHistory(history);

  try {
    // recheck — แยกประวัติเก่า (recap) กับล่าสุด (เต็ม)
    const { recap, recentMessages } = buildMessages(history);

    const messages = [
      { role: "system", content: SYSTEM_PROMPT + recap },
      ...recentMessages,
    ];

    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages,
      max_tokens: 1024,
    });

    const reply = completion.choices[0].message.content;
    history.push({ role: "assistant", content: reply });
    saveHistoryToFile(contextId);
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
    const hFile = getHistoryFile(contextId);
    if (fs.existsSync(hFile)) fs.unlinkSync(hFile);
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
  saveReply(displayName, cleanText, reply);

  // ถ้าอยู่กลุ่ม — @mention คนที่ถาม
  if (isGroup && source.userId) {
    return lineClient.replyMessage(event.replyToken, {
      type: "textV2",
      text: "{mentionUser} " + reply,
      substitution: {
        mentionUser: {
          type: "mention",
          mentionee: {
            type: "user",
            userId: source.userId,
          },
        },
      },
    });
  }

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
