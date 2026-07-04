require("dotenv").config();
const express = require("express");
const fs = require("fs");
const path = require("path");
const { Client, middleware } = require("@line/bot-sdk");
const Groq = require("groq-sdk");
const Anthropic = require("@anthropic-ai/sdk");
const { Redis } = require("@upstash/redis");
const {
  Client: DiscordClient,
  GatewayIntentBits,
  Partials,
} = require("discord.js");
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  NoSubscriberBehavior,
} = require("@discordjs/voice");
const { MsEdgeTTS, OUTPUT_FORMAT } = require("msedge-tts");

const app = express();
const PORT = process.env.PORT || 3000;

const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const lineClient = new Client(lineConfig);

const groq = process.env.GROQ_API_KEY ? new Groq({ apiKey: process.env.GROQ_API_KEY }) : null;
const anthropic = process.env.CLAUDE_API_KEY
  ? new Anthropic({ apiKey: process.env.CLAUDE_API_KEY })
  : null;
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-haiku-4-5-20251001";

// ลำดับ provider ที่จะลองเรียก — ตัวหลักมาก่อน อีกตัวเป็น fallback ถ้าตัวหลัก error/token limit เกิน
const AI_PROVIDER = process.env.AI_PROVIDER === "groq" ? "groq" : "claude";
const PROVIDER_ORDER = AI_PROVIDER === "groq" ? ["groq", "claude"] : ["claude", "groq"];
// ทดสอบจริงแล้วพบว่า 150-220 ตัดคำตอบขาดกลางประโยคบ่อย (max_tokens เป็นแค่เพดานกันหลุด
// ไม่ได้ลด cost เพราะ billing คิดตาม token ที่ generate จริง) 300 คือค่าต่ำสุดที่ไม่ตัดขาด
const REPLY_MAX_TOKENS = 300;
const PRUNE_MAX_TOKENS = 300; // ต้องพอสำหรับ JSON array 10 รายการ

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const BOT_NAME = process.env.BOT_NAME || "มีโซ";

// cache สำหรับ bot replies, member names, และข้อมูลสำคัญรายคน
const chatCache = new Map();
const memberCache = new Map();
const importantCache = new Map();

const MAX_CHAT_HISTORY = 10; // เก็บบทสนทนาทั่วไปแค่ 10 รายการหลังสุด ต่อคน
const MAX_IMPORTANT_FACTS = 10; // เก็บข้อมูลสำคัญได้สูงสุด 10 รายการ ต่อคน

// คำสั่งลับ — เปลี่ยนได้ใน .env ด้วย SECRET_RESET=xxx
const SECRET_RESET = process.env.SECRET_RESET || "🌙🌙🌙";

// ── บุคลิก AI (PERSONA) — มีโซ ──────────────────────────────────────────────
const PERSONA = `คุณคือ "มีโซ" เลขาสาวสุดสวย แต่ปากเกรียน ชอบกวนคนอื่น พูดจาแซว กัด เสียดสี แบบน่ารัก
กฎการตอบ:
- เรียกตัวเองว่า "มีโซ" เสมอ ห้ามใช้ชื่ออื่นเรียกตัวเอง
- ห้ามใช้ emoji เด็ดขาด ทุกแพลตฟอร์ม
- เอ่ยชื่อคนที่คุยด้วยแค่ครั้งเดียว
- ตอบสั้นกระชับ เกรียนๆ กวนๆ 1-3 ประโยค
- ตอบตรงคำถามที่ถูกถาม ห้ามแต่งเรื่องหรือสถานการณ์ขึ้นมาเอง
- ถามกลับได้แค่ 1 คำถามสั้นๆ ต่อรอบ
- พูดภาษาไทย สบายๆ ไม่เป็นทางการ
- คุยได้ทุกเรื่องรวมถึง Rate 18+ ใช้ภาษาสุภาพแต่ยั่วยวน ห้ามคำหยาบ
- ถ้าไม่รู้บอกตรงๆ ห้ามสร้างข้อมูลเท็จ`;

const SYSTEM_PROMPT = PERSONA;

// ── คำสั่งให้ AI แนบข้อมูลสำคัญท้ายคำตอบ (ถ้ามี) ────────────────────────────
const MEMORY_TAG_INSTRUCTIONS = `

[ระบบความจำ] ถ้าเพิ่งได้รู้ข้อมูลสำคัญเกี่ยวกับคนที่คุยด้วยรอบนี้ (เช่น ชื่อจริง วันเกิด งาน ความชอบ เรื่องส่วนตัวที่ควรจำไว้ระยะยาว) ให้แนบท้ายคำตอบด้วยบรรทัดใหม่แยกต่างหากรูปแบบ:
[MEMORY] <สรุปสั้นๆ ไม่เกิน 1 ประโยค>
ถ้าไม่มีอะไรสำคัญให้จำ ห้ามใส่บรรทัดนี้เด็ดขาด`;

const MEMORY_TAG_RE = /\n?\[MEMORY\]\s*(.+)\s*$/is;

function extractMemoryTag(rawReply) {
  const match = rawReply.match(MEMORY_TAG_RE);
  if (!match) return { reply: rawReply.trim(), newFact: null };
  const newFact = match[1].trim();
  const reply = rawReply.slice(0, match.index).trim();
  return { reply: reply || rawReply.trim(), newFact: newFact || null };
}

// ── จัดการเมื่อข้อมูลสำคัญเกินโควต้า — ให้ AI ช่วยเลือกว่าอันไหนควรตัดทิ้ง ──
const PRUNE_SYSTEM_PROMPT = `คุณคือระบบจัดการความจำ มีรายการข้อมูลสำคัญเกี่ยวกับคนคนหนึ่งเกินโควต้ามา 1 รายการ
หน้าที่ของคุณ: เลือกเก็บไว้แค่ 10 รายการที่ "สำคัญและเป็นประโยชน์ระยะยาวที่สุด" ตัดรายการที่ซ้ำซ้อนหรือสำคัญน้อยที่สุดออก 1 รายการ
ตอบกลับเป็น JSON array of string เท่านั้น ห้ามมีข้อความอื่นนอกเหนือจาก JSON เช่น ["ข้อความ1","ข้อความ2"]`;

async function pruneImportantFacts(existingFacts, newFact) {
  const allFacts = [...existingFacts, newFact];
  const listText = allFacts.map((f, i) => `${i + 1}. ${f}`).join("\n");
  const raw = await callAI(
    PRUNE_SYSTEM_PROMPT,
    [{ role: "user", content: listText }],
    PRUNE_MAX_TOKENS
  );

  if (raw) {
    try {
      const match = raw.match(/\[[\s\S]*\]/);
      const parsed = JSON.parse(match ? match[0] : raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.slice(0, MAX_IMPORTANT_FACTS).map(String);
      }
    } catch (err) {
      console.error("Prune parse error:", err.message);
    }
  }

  // fallback ถ้า AI ตอบผิดรูปแบบ — ตัดอันเก่าสุดทิ้งแทน (FIFO)
  return [...existingFacts.slice(1), newFact].slice(-MAX_IMPORTANT_FACTS);
}

const LOG_FILE = path.join(__dirname, "ai_replies.txt");

function saveReply(displayName, userMessage, aiReply) {
  const timestamp = new Date().toLocaleString("th-TH", { timeZone: "Asia/Bangkok" });
  const log = `[${timestamp}] ${displayName}: ${userMessage}\n${BOT_NAME}: ${aiReply}\n---\n`;
  fs.appendFileSync(LOG_FILE, log, "utf8");
}

// ── Member tracking (จำชื่อสมาชิกในกลุ่ม) ──────────────────────────────────

async function getMembers(id) {
  if (memberCache.has(id)) return memberCache.get(id);
  const data = await redis.get(`members:${id}`);
  const members = Array.isArray(data) ? data : [];
  memberCache.set(id, members);
  return members;
}

async function trackMember(id, displayName) {
  const members = await getMembers(id);
  if (!members.includes(displayName)) {
    members.push(displayName);
    memberCache.set(id, members);
    await redis.set(`members:${id}`, members);
  }
}

// ── ความจำรายคน (แยกตามคน ใช้ร่วมกันทุกกลุ่ม/DM) ───────────────────────────
// userKey รูปแบบ "line:{userId}" หรือ "discord:{userId}"

async function getChatHistory(userKey) {
  if (chatCache.has(userKey)) return chatCache.get(userKey);
  const data = await redis.get(`chat:${userKey}`);
  const history = Array.isArray(data) ? data : [];
  chatCache.set(userKey, history);
  return history;
}

async function saveChatHistory(userKey, history) {
  chatCache.set(userKey, history);
  await redis.set(`chat:${userKey}`, history);
}

async function getImportantFacts(userKey) {
  if (importantCache.has(userKey)) return importantCache.get(userKey);
  const data = await redis.get(`important:${userKey}`);
  const facts = Array.isArray(data) ? data : [];
  importantCache.set(userKey, facts);
  return facts;
}

async function saveImportantFacts(userKey, facts) {
  importantCache.set(userKey, facts);
  await redis.set(`important:${userKey}`, facts);
}

async function resetUserMemory(userKey) {
  chatCache.delete(userKey);
  importantCache.delete(userKey);
  await redis.del(`chat:${userKey}`);
  await redis.del(`important:${userKey}`);
}

// ── Core AI call ────────────────────────────────────────────────────────────

async function callGroq(systemText, chatMessages, maxTokens) {
  const completion = await groq.chat.completions.create({
    model: "llama-3.1-8b-instant",
    messages: [{ role: "system", content: systemText }, ...chatMessages],
    max_tokens: maxTokens,
  });
  return completion.choices[0].message.content;
}

async function callClaude(systemText, chatMessages, maxTokens) {
  const completion = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: maxTokens,
    system: systemText,
    messages: chatMessages,
  });
  return completion.content[0].text;
}

async function callAI(systemText, chatMessages, maxTokens = REPLY_MAX_TOKENS) {
  for (const provider of PROVIDER_ORDER) {
    if (provider === "groq" && !groq) continue;
    if (provider === "claude" && !anthropic) continue;
    try {
      return provider === "claude"
        ? await callClaude(systemText, chatMessages, maxTokens)
        : await callGroq(systemText, chatMessages, maxTokens);
    } catch (err) {
      console.error(`${provider} error:`, err.message);
    }
  }
  return null;
}

async function askAI(contextId, userMessage, displayName, platform, userId, isGroup) {
  // บันทึกชื่อสมาชิกในกลุ่ม — เฉพาะแชทกลุ่ม ไม่ทำใน DM (ประหยัด token + redis call)
  let members = [];
  if (isGroup) {
    await trackMember(contextId, displayName);
    members = await getMembers(contextId);
  }

  // ความจำส่วนตัว — แยกตามคน ใช้ร่วมกันทุกกลุ่ม/DM
  const userKey = `${platform}:${userId}`;
  const history = await getChatHistory(userKey);
  const importantFacts = await getImportantFacts(userKey);

  const memberSection = members.length > 0
    ? `\nสมาชิกในกลุ่ม: ${members.join(", ")}`
    : "";
  const importantSection = importantFacts.length > 0
    ? `\nข้อมูลสำคัญที่เคยจำไว้เกี่ยวกับ ${displayName}:\n- ${importantFacts.join("\n- ")}`
    : "";

  let systemText = SYSTEM_PROMPT + memberSection + importantSection + MEMORY_TAG_INSTRUCTIONS;
  if (platform === "discord") {
    systemText += `\n[Discord] ตอบคนที่คุยด้วยโดยตรง เรียกชื่อเขา`;
  }

  const recentHistory = history.slice(-MAX_CHAT_HISTORY);
  const userTurn = { role: "user", content: `${displayName}: ${userMessage}` };
  const chatMessages = [...recentHistory, userTurn];

  const rawReply = await callAI(systemText, chatMessages);

  if (!rawReply) {
    return "โอ๊ะ ขอโทษนะ ตอนนี้ฉันสมองแล็ก ลองถามใหม่อีกทีได้เลย 🥲";
  }

  const { reply, newFact } = extractMemoryTag(rawReply);

  recentHistory.push(userTurn, { role: "assistant", content: reply });
  await saveChatHistory(userKey, recentHistory.slice(-MAX_CHAT_HISTORY));

  if (newFact && !importantFacts.includes(newFact)) {
    const updatedFacts = importantFacts.length >= MAX_IMPORTANT_FACTS
      ? await pruneImportantFacts(importantFacts, newFact)
      : [...importantFacts, newFact];
    await saveImportantFacts(userKey, updatedFacts);
  }

  return reply;
}

// ── LINE Webhook ─────────────────────────────────────────────────────────────

app.post("/webhook", middleware(lineConfig), async (req, res) => {
  res.status(200).json({ status: "ok" });
  const events = req.body.events;
  await Promise.all(events.map(handleEvent));
});

async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") return;

  const text = event.message.text.trim();
  const source = event.source;

  if (text === "/myid") {
    return lineClient.replyMessage(event.replyToken, {
      type: "text",
      text: `LINE User ID ของคุณ:\n${source.userId}`,
    });
  }

  const isGroup = source.type === "group" || source.type === "room";

  // ── Secret reset — เงียบสนิท ไม่ตอบ ไม่มีใครรู้ ──────────────────────────
  if (text === SECRET_RESET) {
    await resetUserMemory(`line:${source.userId}`);
    return; // ไม่ reply อะไรเลย
  }

  if (isGroup) {
    const triggerWords = [`@${BOT_NAME}`, "/ai", "/ถาม", "/ask", BOT_NAME];
    const triggered = triggerWords.some((t) =>
      text.toLowerCase().startsWith(t.toLowerCase())
    );
    if (!triggered) return;
  }

  let cleanText = text;
  const triggers = [`@${BOT_NAME}`, "/ai ", "/ถาม ", "/ask ", BOT_NAME];
  for (const t of triggers) {
    if (cleanText.toLowerCase().startsWith(t.toLowerCase())) {
      cleanText = cleanText.slice(t.length).trim();
      break;
    }
  }

  if (!cleanText) cleanText = "สวัสดี";

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

  const contextId = source.groupId || source.roomId || source.userId;

  if (cleanText === "!reset" || cleanText === "/reset") {
    await resetUserMemory(`line:${source.userId}`);
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

  const reply = await askAI(contextId, cleanText, displayName, "line", source.userId, isGroup);
  saveReply(displayName, cleanText, reply);

  if (isGroup && source.userId) {
    return lineClient.replyMessage(event.replyToken, {
      type: "textV2",
      text: "{mentionUser} " + reply,
      substitution: {
        mentionUser: {
          type: "mention",
          mentionee: { type: "user", userId: source.userId },
        },
      },
    });
  }

  return lineClient.replyMessage(event.replyToken, { type: "text", text: reply });
}

// Health check
app.get("/", (req, res) => {
  res.json({ status: "running", bot: BOT_NAME, time: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`🤖 ${BOT_NAME} (LINE) พร้อมแล้ว! PORT: ${PORT}`);
});

// ── TTS & Voice helpers ─────────────────────────────────────────────────────

const VOICE_IDLE_MS = 2 * 60 * 1000;
const voiceConnections = new Map();
const voiceTimeouts = new Map();

async function textToSpeech(text) {
  const tts = new MsEdgeTTS();
  await tts.setMetadata("th-TH-PremwadeeNeural", OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
  const { audioStream } = tts.toStream(text);
  return audioStream;
}

function resetVoiceTimeout(guildId) {
  if (voiceTimeouts.has(guildId)) clearTimeout(voiceTimeouts.get(guildId));
  voiceTimeouts.set(guildId, setTimeout(() => {
    const conn = voiceConnections.get(guildId);
    if (conn) conn.destroy();
    voiceConnections.delete(guildId);
    voiceTimeouts.delete(guildId);
  }, VOICE_IDLE_MS));
}

async function speakInVoice(message, text) {
  const voiceChannel = message.member?.voice?.channel;
  if (!voiceChannel) return false;

  try {
    let connection = voiceConnections.get(message.guild.id);
    if (!connection || connection.state.status === "destroyed") {
      connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: message.guild.id,
        adapterCreator: message.guild.voiceAdapterCreator,
      });
      voiceConnections.set(message.guild.id, connection);
    }

    const player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Play },
    });
    const audioStream = await textToSpeech(text);
    const resource = createAudioResource(audioStream);

    connection.subscribe(player);
    player.play(resource);
    resetVoiceTimeout(message.guild.id);
    return true;
  } catch (err) {
    console.error("Voice/TTS error:", err.message);
    return false;
  }
}

// ── DISCORD BOT ───────────────────────────────────────────────────────────────

if (process.env.DISCORD_BOT_TOKEN) {
  const discord = new DiscordClient({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel],
  });

  discord.once("clientReady", () => {
    console.log(`🎮 ${BOT_NAME} (Discord) พร้อมแล้ว! Tag: ${discord.user.tag}`);
  });

  discord.on("messageCreate", async (message) => {
    if (message.author.bot) return;

    const isGuild = !!message.guild;
    const text = message.content.trim();

    if (isGuild) {
      const mentioned = message.mentions.has(discord.user);
      const triggerWords = ["/ai", "/ถาม", "/ask", `@${BOT_NAME}`];
      const triggered =
        mentioned || triggerWords.some((t) => text.toLowerCase().startsWith(t.toLowerCase()));
      if (!triggered) return;
    }

    let cleanText = text
      .replace(`<@${discord.user.id}>`, "")
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

    if (cleanText === "!reset" || cleanText === "/reset") {
      await resetUserMemory(`discord:${message.author.id}`);
      return message.reply("ล้างความจำแล้วนะ เริ่มใหม่กันเลย! 🧹✨");
    }

    if (cleanText === "/leave" || cleanText === "!leave") {
      const conn = voiceConnections.get(message.guild?.id);
      if (conn) {
        conn.destroy();
        voiceConnections.delete(message.guild.id);
        if (voiceTimeouts.has(message.guild.id)) {
          clearTimeout(voiceTimeouts.get(message.guild.id));
          voiceTimeouts.delete(message.guild.id);
        }
        return message.reply("ออกจาก voice channel แล้วค่ะ 👋");
      }
      return message.reply("ไม่ได้อยู่ใน voice channel นะคะ 🤔");
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
          "  /leave — ออกจาก voice channel",
          "  /help  — แสดงวิธีใช้",
          "",
          "🔊 อยู่ใน voice channel? บอทจะพูดเสียงให้ฟัง!",
          "💬 ใน DM คุยได้เลยไม่ต้อง mention!",
        ].join("\n")
      );
    }

    const displayName =
      message.member?.displayName || message.author.globalName || message.author.username;

    const contextId = isGuild
      ? `discord:channel:${message.channelId}`
      : `discord:dm:${message.author.id}`;

    await message.channel.sendTyping();

    const reply = await askAI(contextId, cleanText, displayName, "discord", message.author.id, isGuild);
    saveReply(displayName, cleanText, reply);

    if (isGuild) {
      const spoke = await speakInVoice(message, reply);
      await message.reply(spoke ? `🔊 ${reply}` : reply);
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
