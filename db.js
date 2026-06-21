// SQLite persistence: schema + prepared statements + the soft blocklist
import Database from 'better-sqlite3';
import { SELFTEST } from './config.js';

const db = new Database(SELFTEST ? ':memory:' : (process.env.DB_PATH || 'data.db'));
db.exec(`CREATE TABLE IF NOT EXISTS messages(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  igsid TEXT NOT NULL,
  direction TEXT NOT NULL,        -- 'in' | 'out'
  text TEXT,
  created_at INTEGER NOT NULL     -- unix ms
)`);
db.exec(`CREATE TABLE IF NOT EXISTS threads(
  igsid TEXT PRIMARY KEY,
  thread_id INTEGER NOT NULL,     -- telegram forum topic id
  name TEXT,
  created_at INTEGER NOT NULL
)`);
db.exec(`CREATE TABLE IF NOT EXISTS blocked(
  igsid TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
)`);
try { db.exec(`ALTER TABLE threads ADD COLUMN unread INTEGER NOT NULL DEFAULT 0`); } catch { /* already added */ }
db.exec(`CREATE TABLE IF NOT EXISTS fwd(
  tg_message_id INTEGER PRIMARY KEY,   -- the forwarded message in Telegram
  igsid TEXT NOT NULL,
  ig_mid TEXT NOT NULL                 -- the IG message it represents (for reactions)
)`);
db.exec(`CREATE TABLE IF NOT EXISTS members(
  user_id INTEGER PRIMARY KEY,         -- telegram user id of a group member
  name TEXT,
  count INTEGER NOT NULL DEFAULT 0,    -- messages sent in topics (not General) — for /leaderboards
  updated_at INTEGER
)`);
db.exec(`CREATE TABLE IF NOT EXISTS saved(
  user_id INTEGER NOT NULL,            -- telegram user who bookmarked the topic
  igsid TEXT NOT NULL,                 -- the saved topic (stable key; survives topic recreation)
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, igsid)
)`);
db.exec(`CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT)`); // small key/value (e.g. last-announced version)

export const q = {
  insertIn:      db.prepare(`INSERT INTO messages(igsid,direction,text,created_at) VALUES(?, 'in', ?, ?)`),
  insertOut:     db.prepare(`INSERT INTO messages(igsid,direction,text,created_at) VALUES(?, 'out', ?, ?)`),
  igsidByThread: db.prepare(`SELECT igsid FROM threads WHERE thread_id=?`),
  threadName:    db.prepare(`SELECT name FROM threads WHERE thread_id=?`),
  threadFull:    db.prepare(`SELECT thread_id, name, unread FROM threads WHERE igsid=?`),
  setUnread:     db.prepare(`UPDATE threads SET unread=? WHERE igsid=?`),
  insertThread:  db.prepare(`INSERT OR REPLACE INTO threads(igsid,thread_id,name,created_at) VALUES(?,?,?,?)`),
  deleteThread:  db.prepare(`DELETE FROM threads WHERE thread_id=?`),
  staleThreads:  db.prepare(`SELECT igsid, thread_id, last_at FROM (
    SELECT t.igsid AS igsid, t.thread_id AS thread_id,
      COALESCE((SELECT MAX(created_at) FROM messages m WHERE m.igsid=t.igsid), t.created_at) AS last_at
    FROM threads t
  ) WHERE last_at < ?`),
  openTopics:    db.prepare(`SELECT t.igsid, t.thread_id, t.name,
    (SELECT MAX(created_at) FROM messages m WHERE m.igsid=t.igsid AND m.direction='in') AS last_in
    FROM threads t WHERE t.unread=1
    ORDER BY last_in IS NULL, last_in ASC`),   // most-urgent (oldest inbound) first; no-inbound last
  isBlocked:     db.prepare(`SELECT 1 FROM blocked WHERE igsid=?`),
  block:         db.prepare(`INSERT OR IGNORE INTO blocked(igsid,created_at) VALUES(?,?)`),
  unblock:       db.prepare(`DELETE FROM blocked WHERE igsid=?`),
  blockedList:   db.prepare(`SELECT b.igsid, t.name, t.thread_id FROM blocked b
    LEFT JOIN threads t ON t.igsid=b.igsid ORDER BY b.created_at`),
  lastInbound:   db.prepare(`SELECT MAX(created_at) AS t FROM messages WHERE direction='in'`),
  insertFwd:     db.prepare(`INSERT OR REPLACE INTO fwd(tg_message_id,igsid,ig_mid) VALUES(?,?,?)`),
  fwdByTg:       db.prepare(`SELECT igsid, ig_mid FROM fwd WHERE tg_message_id=?`),
  fwdByMid:      db.prepare(`SELECT tg_message_id FROM fwd WHERE ig_mid=?`),
  bumpMember:    db.prepare(`INSERT INTO members(user_id,name,count,updated_at) VALUES(?,?,1,?)
    ON CONFLICT(user_id) DO UPDATE SET count=count+1, name=excluded.name, updated_at=excluded.updated_at`),
  leaderboard:   db.prepare(`SELECT user_id, name, count FROM members ORDER BY count DESC, name LIMIT 10`),
  saveTopic:     db.prepare(`INSERT OR IGNORE INTO saved(user_id,igsid,created_at) VALUES(?,?,?)`),
  savedByUser:   db.prepare(`SELECT igsid FROM saved WHERE user_id=? ORDER BY created_at DESC`),
  getMeta:       db.prepare(`SELECT value FROM meta WHERE key=?`),
  setMeta:       db.prepare(`INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`),
};

// soft blocklist: env seed + runtime /block. Dropped before forwarding (NOT blocked on Instagram).
export const envBlocked = new Set((process.env.BLOCKED_IGSIDS || '').split(',').map(s => s.trim()).filter(Boolean));
export const isBlocked = (igsid) => envBlocked.has(igsid) || !!q.isBlocked.get(igsid);
