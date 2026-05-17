import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, "data");
mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(join(dataDir, "therapy.db"));
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at TEXT NOT NULL,
    ended_at TEXT
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('user','assistant')),
    content TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    summary TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, id);
  CREATE INDEX IF NOT EXISTS idx_notes_created ON notes(created_at DESC);
`);

const now = () => new Date().toISOString();
const toNum = (v) => (typeof v === "bigint" ? Number(v) : v);

const stmts = {
  openSession: db.prepare("INSERT INTO sessions (started_at) VALUES (?)"),
  closeSession: db.prepare("UPDATE sessions SET ended_at = ? WHERE id = ?"),
  currentSession: db.prepare(
    "SELECT id, started_at, ended_at FROM sessions ORDER BY id DESC LIMIT 1"
  ),
  insertMessage: db.prepare(
    "INSERT INTO messages (session_id, role, content, created_at) VALUES (?,?,?,?)"
  ),
  sessionMessages: db.prepare(
    "SELECT role, content, created_at FROM messages WHERE session_id = ? ORDER BY id ASC"
  ),
  recentMessages: db.prepare(
    "SELECT role, content FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?"
  ),
  insertNote: db.prepare(
    "INSERT INTO notes (session_id, summary, created_at) VALUES (?,?,?)"
  ),
  recentNotes: db.prepare(
    "SELECT summary, created_at FROM notes ORDER BY id DESC LIMIT ?"
  ),
};

export function getOrStartSession() {
  const last = stmts.currentSession.get();
  if (last && !last.ended_at) return { ...last, id: toNum(last.id) };
  const info = stmts.openSession.run(now());
  return { id: toNum(info.lastInsertRowid), started_at: now(), ended_at: null };
}

export function startNewSession() {
  const last = stmts.currentSession.get();
  if (last && !last.ended_at) {
    stmts.closeSession.run(now(), last.id);
  }
  const info = stmts.openSession.run(now());
  return { id: toNum(info.lastInsertRowid), started_at: now(), ended_at: null };
}

export function endSession(sessionId) {
  stmts.closeSession.run(now(), sessionId);
}

export function saveMessage(sessionId, role, content) {
  stmts.insertMessage.run(sessionId, role, content, now());
}

export function getSessionMessages(sessionId) {
  return stmts.sessionMessages.all(sessionId);
}

export function getRecentMessagesForContext(sessionId, limit = 40) {
  const rows = stmts.recentMessages.all(sessionId, limit);
  return rows.reverse();
}

export function saveNote(sessionId, summary) {
  stmts.insertNote.run(sessionId, summary, now());
}

export function getRecentNotes(limit = 5) {
  return stmts.recentNotes.all(limit);
}

export default db;
