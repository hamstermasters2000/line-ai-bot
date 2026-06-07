require("dotenv").config();
const express = require("express");
const fs = require("fs");
const path = require("path");
const { Client, middleware } = require("@line/bot-sdk");
const Groq = require("groq-sdk");
const { Redis } = require("@upstash/redis");
const {
  Client: DiscordClient,
  GatewayIntentBits,
  Partials,
} = require("discord.js");

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

// Upstash Redis — persistent storage (ไม่หายตอน Render sleep)
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const BOT_NAME = process.env.BOT_NAME || "น้องAI";

// in-memory cache เพื่อลด latency (Redis เป็น source of truth)
const chatCache = new Map();

// System prompt สำหรับบอท — แก้ให้สนุกตามใจ
const SYSTEM_PROMPT = `คุณคือ "${BOT_NAME}" บอทสุดน่ารักของกลุ่มเพื่อนๆ มีนิสัยสนุกสนาน พูดภาษาไทยเป็นหลัก
ตอบแบบเพื่อนคุยกัน ไม่เป็นทางการ ใช้ emoji ได้บ้าง ตอบกระชับได้ใจความ
ถ้าไม่รู้เรื่องก็บอกตรงๆ ว่าไม่รู้ ห้ามสร้างข้อมูลเท็จ

🔑 ข้อมูลสำคัญที่ต้องจำเสมอ:
- ผู้ใช้ชื่อ "ล้วยหอม" คือ มาสเตอร์ (เจ้าของและผู้ดูแลบอทนี้) ให้ให้เกียรติและเรียกว่า "มาสเตอร์" เมื่อพูดถึงหรือตอบ`;

const LOG_FILE = path.join(__dirname, "ai_replies.txt");

function saveReply(displayName, userMessage, aiReply) {
  const timestamp = new Date().toLocaleString("th-TH", { timeZone: "Asia/Bangkok" });
  const log = `[${timestamp}] ${displayName}: ${userMessage}\n${BOT_NAME}: ${aiReply}\n---\n`;
  fs.appendFileSync(LOG_FILE, log, "utf8");
}

async function getHistory(id) {
  if (chatCache.has(id)) return chatCache.get(id);
  const data = await redis.get(`chat:${id}`);
  const history = Array.isArray(data) ? data : [];
  chatCache.set(id, history);
  return history;
}

async function saveHistory(id) {
  const history = chatCache.get(id);
  if (history) {
    await redis.set(`chat:${id}`, history);
  }
}

async function deleteHistory(id) {
  chatCache.delete(id);
  await redis.del(`chat:${id}`);
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
  const history = await getHistory(contextId);

  history.push({ role: "user", content: `${displayName}: ${userMessage}` });
  trimHistory(history);

  try {
    const { recap, recentMessages } = buildMessages(history);

    const messages = [
      { role: "system", content: SYSTEM_PROMPT + recap },
      ...recentMessages,
    ];

    const completion = await groq.chat.completions.create({
      model: "llama-3.1-8b-instant",
      messages,
      max_tokens: 512,
    });

    const reply = completion.choices[0].message.content;
    history.push({ role: "assistant", content: reply });
    await saveHistory(contextId);
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
    await deleteHistory(contextId);
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
  console.log(`🤖 ${BOT_NAME} (LINE) พร้อมแล้ว! PORT: ${PORT}`);
});

// ──────────────────────────────────────────────
//  DISCORD BOT
// ──────────────────────────────────────────────
if (process.env.DISCORD_BOT_TOKEN) {
  const discord = new DiscordClient({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel], // จำเป็นสำหรับ DM
  });

  discord.once("ready", () => {
    console.log(`🎮 ${BOT_NAME} (Discord) พร้อมแล้ว! Tag: ${discord.user.tag}`);
  });

  discord.on("messageCreate", async (message) => {
    // ไม่ตอบบอทด้วยกัน
    if (message.author.bot) return;

    const isGuild = !!message.guild;
    const text = message.content.trim();

    if (isGuild) {
      // ใน server — ตอบเมื่อ mention หรือใช้ trigger word
      const mentioned = message.mentions.has(discord.user);
      const triggerWords = ["/ai", "/ถาม", "/ask", `@${BOT_NAME}`];
      const triggered =
        mentioned || triggerWords.some((t) => text.toLowerCase().startsWith(t.toLowerCase()));

      if (!triggered) return;
    }
    // ใน DM — ตอบได้เลยไม่ต้อง trigger

    // ตัด trigger/mention ออกจากข้อความ
    let cleanText = text
      .replace(`<@${discord.user.id}>`, "")   // ตัด mention tag
      .replace(`<@!${discord.user.id}>`, "")
      .trim();

    const triggerPrefixes = ["/ai", "/ถาม", "/ask", `@${BOT_NAME}`];
    for (const t of triggerPrefixes) {
      if (cleanText.toLowerCase().startsWith(t.toLowerCase())) {
        cleanText = cleanText.slice(t.length).trim();
        break;
      }
    }

    if (!cleanText) cleanText = "สวัสดี";

    // คำสั่งพิเศษ
    if (cleanText === "!reset" || cleanText === "/reset") {
      await deleteHistory(message.channelId);
      return message.reply("ล้างความจำแล้วนะ เริ่มใหม่กันเลย! 🧹✨");
    }

    if (cleanText === "!help" || cleanText === "/help") {
      return message.reply(
        [
          `🤖 **${BOT_NAME}** — วิธีใช้งาน Discord`,
          "",
          "📌 เรียกใช้ใน server:",
          `  @${BOT_NAME} [คำถาม]`,
          "  /ai [คำถาม] หรือ /ถาม [คำถาม]",
          "",
          "📌 คำสั่งพิเศษ:",
          "  /reset — ล้างประวัติสนทนา",
          "  /help  — แสดงวิธีใช้",
          "",
          "💬 ใน DM คุยได้เลยไม่ต้อง mention!",
        ].join("\n")
      );
    }

    const displayName =
      message.member?.displayName || message.author.globalName || message.author.username;

    // context แยกตาม channel (server) หรือ user (DM)
    const contextId = isGuild
      ? `discord:channel:${message.channelId}`
      : `discord:dm:${message.author.id}`;

    // แสดง typing indicator ระหว่างรอ AI
    await message.channel.sendTyping();

    const reply = await askGroq(contextId, cleanText, displayName);
    saveReply(displayName, cleanText, reply);

    // ใน server — @mention คนที่ถาม, ใน DM — reply ธรรมดา
    if (isGuild) {
      await message.reply(reply);
    } else {
      await message.channel.send(reply);
    }
  });

  discord.login(process.env.DISCORD_BOT_TOKEN).catch((err) => {
    console.error("Discord login failed:", err.message);
  });
} else {
  console.log("⚠️  ไม่พบ DISCORD_BOT_TOKEN — ข้ามการเชื่อมต่อ Discord");
}
