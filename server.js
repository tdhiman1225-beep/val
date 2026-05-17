import "dotenv/config";
import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getOrStartSession,
  startNewSession,
  endSession,
  saveMessage,
  getSessionMessages,
  getRecentMessagesForContext,
  saveNote,
  getRecentNotes,
} from "./db.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const MODEL = "claude-opus-4-7";
const SYSTEM_PROMPT = readFileSync(join(__dirname, "prompts/orna.md"), "utf8");

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("Missing ANTHROPIC_API_KEY. Copy .env.example to .env and set it.");
  process.exit(1);
}

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(join(__dirname, "public")));

function buildSystemBlocks() {
  const notes = getRecentNotes(5);
  const blocks = [
    {
      type: "text",
      text: SYSTEM_PROMPT,
      cache_control: { type: "ephemeral" },
    },
  ];
  if (notes.length > 0) {
    const notesBlock = notes
      .slice()
      .reverse()
      .map(
        (n, i) =>
          `## Session note ${i + 1} (${n.created_at.slice(0, 10)})\n${n.summary}`
      )
      .join("\n\n");
    blocks.push({
      type: "text",
      text: `# Prior session notes\n\nThese are your private notes from prior sessions with this patient, oldest first. Carry them in lightly. Reference them only when alive in the moment.\n\n${notesBlock}`,
    });
  }
  return blocks;
}

function buildMessagesForContext(sessionId) {
  const rows = getRecentMessagesForContext(sessionId, 40);
  return rows.map((r) => ({ role: r.role, content: r.content }));
}

app.get("/api/history", (_req, res) => {
  const session = getOrStartSession();
  const messages = getSessionMessages(session.id);
  res.json({ sessionId: session.id, messages });
});

app.post("/api/session/new", (_req, res) => {
  const session = startNewSession();
  res.json({ sessionId: session.id });
});

app.post("/api/chat", async (req, res) => {
  const { message } = req.body || {};
  if (!message || typeof message !== "string") {
    return res.status(400).json({ error: "message is required" });
  }

  const session = getOrStartSession();
  saveMessage(session.id, "user", message);

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  const send = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  let full = "";
  try {
    const stream = anthropic.messages.stream({
      model: MODEL,
      max_tokens: 1024,
      system: buildSystemBlocks(),
      messages: buildMessagesForContext(session.id),
    });

    stream.on("text", (delta) => {
      full += delta;
      send("delta", { text: delta });
    });

    await stream.finalMessage();
    saveMessage(session.id, "assistant", full);
    send("done", { text: full });
    res.end();
  } catch (err) {
    console.error("chat error:", err);
    send("error", { message: err?.message || "stream failed" });
    res.end();
  }
});

app.post("/api/session/end", async (_req, res) => {
  const session = getOrStartSession();
  const messages = getSessionMessages(session.id);

  if (messages.length < 2) {
    endSession(session.id);
    return res.json({ ok: true, summarized: false });
  }

  const transcript = messages
    .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
    .join("\n\n");

  try {
    const result = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 700,
      system:
        "You are a psychoanalytically-trained clinician writing private session notes after a therapy session. Write in the first person as the therapist. Be concise, specific, clinically honest. No bullet points unless genuinely useful. Five sections, in this order:\n\n**Themes** — what the patient brought.\n**Patterns I noticed** — what's repeating, projecting, defending.\n**What we didn't get to** — what I'd want to return to.\n**My countertransference** — what I noticed in myself.\n**Where I'd pick up next time** — one or two sentences.\n\nKeep the whole note under 300 words. Markdown formatting fine.",
      messages: [
        {
          role: "user",
          content: `Session transcript:\n\n${transcript}`,
        },
      ],
    });
    const summary = result.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n")
      .trim();
    if (summary) saveNote(session.id, summary);
    endSession(session.id);
    res.json({ ok: true, summarized: true });
  } catch (err) {
    console.error("summary error:", err);
    endSession(session.id);
    res.status(500).json({ ok: false, error: err?.message });
  }
});

app.post("/api/tts", async (req, res) => {
  if (!process.env.OPENAI_API_KEY) {
    return res.status(503).json({ error: "OPENAI_API_KEY not set; use browser TTS" });
  }
  const { text } = req.body || {};
  if (!text || typeof text !== "string") {
    return res.status(400).json({ error: "text is required" });
  }
  try {
    const r = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "tts-1",
        voice: process.env.TTS_VOICE || "shimmer",
        input: text,
        speed: 0.95,
      }),
    });
    if (!r.ok) {
      const errText = await r.text();
      console.error("OpenAI TTS error:", errText);
      return res.status(r.status).send(errText);
    }
    res.setHeader("Content-Type", "audio/mpeg");
    const buf = Buffer.from(await r.arrayBuffer());
    res.end(buf);
  } catch (err) {
    console.error("tts error:", err);
    res.status(500).json({ error: err?.message });
  }
});

app.get("/api/config", (_req, res) => {
  res.json({
    serverTts: Boolean(process.env.OPENAI_API_KEY),
  });
});

app.listen(PORT, () => {
  console.log(`Therapist listening on http://localhost:${PORT}`);
});
