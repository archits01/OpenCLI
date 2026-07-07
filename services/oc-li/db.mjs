// Durable state store (node:sqlite — zero external deps on Node 22.22).
// All service state lives here so a crash resumes from disk, never from zero.
import { DatabaseSync } from 'node:sqlite'
import { DB_PATH } from './config.mjs'

const db = new DatabaseSync(DB_PATH)
db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;')

db.exec(`
  CREATE TABLE IF NOT EXISTS accounts (
    member_id         TEXT PRIMARY KEY,   -- self fsd_profile ACoAA…  (the account_id equivalent)
    public_identifier TEXT,               -- vanity /in/<handle>
    name              TEXT,
    session_status    TEXT DEFAULT 'unknown', -- authed | logged_out | challenge | unknown
    last_authed_at    TEXT,
    created_at        TEXT DEFAULT (datetime('now')),
    updated_at        TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS events (
    message_urn   TEXT PRIMARY KEY,        -- idempotency key (dedupes realtime vs reconcile)
    account_id    TEXT,                    -- receiving account member_id (tenant tag)
    thread_id     TEXT NOT NULL,           -- full conversation URN as delivered
    thread_native TEXT,                    -- extracted 2-…  (feeds the reply)
    sender_urn    TEXT,
    body          TEXT,
    event_ts      TEXT,                    -- LinkedIn message timestamp
    source        TEXT,                    -- realtime | reconcile
    received_at   TEXT DEFAULT (datetime('now')),
    processed_at  TEXT,                    -- NULL = pending
    reply_status  TEXT,                    -- sent | failed | skipped | NULL
    reply_note    TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_events_pending ON events(processed_at) WHERE processed_at IS NULL;

  CREATE TABLE IF NOT EXISTS cursors (
    account_id      TEXT,
    thread_id       TEXT,                  -- native 2-…
    last_message_urn TEXT,
    last_event_ts   TEXT,
    updated_at      TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (account_id, thread_id)
  );

  CREATE TABLE IF NOT EXISTS health (
    account_id    TEXT PRIMARY KEY,
    listener_up   INTEGER,
    push_active   INTEGER,
    authed        INTEGER,
    last_event_at TEXT,
    queue_depth   INTEGER,
    note          TEXT,
    checked_at    TEXT DEFAULT (datetime('now'))
  );
`)

// ---- accounts ----
export function upsertAccount({ member_id, public_identifier, name, session_status }) {
  db.prepare(`
    INSERT INTO accounts (member_id, public_identifier, name, session_status, last_authed_at, updated_at)
    VALUES (?, ?, ?, ?, CASE WHEN ?='authed' THEN datetime('now') ELSE NULL END, datetime('now'))
    ON CONFLICT(member_id) DO UPDATE SET
      public_identifier=COALESCE(excluded.public_identifier, accounts.public_identifier),
      name=COALESCE(excluded.name, accounts.name),
      session_status=COALESCE(excluded.session_status, accounts.session_status),
      last_authed_at=CASE WHEN excluded.session_status='authed' THEN datetime('now') ELSE accounts.last_authed_at END,
      updated_at=datetime('now')
  `).run(member_id, public_identifier ?? null, name ?? null, session_status ?? 'unknown', session_status ?? '')
  return getAccount(member_id)
}
export function getAccount(member_id) {
  return db.prepare('SELECT * FROM accounts WHERE member_id=?').get(member_id)
}
export function primaryAccount() {
  return db.prepare('SELECT * FROM accounts ORDER BY created_at ASC LIMIT 1').get()
}
export function setSessionStatus(member_id, status) {
  db.prepare(`UPDATE accounts SET session_status=?, last_authed_at=CASE WHEN ?='authed' THEN datetime('now') ELSE last_authed_at END, updated_at=datetime('now') WHERE member_id=?`).run(status, status, member_id)
}

// ---- events (idempotent) ----
export function insertEvent(evt) {
  const info = db.prepare(`
    INSERT OR IGNORE INTO events
      (message_urn, account_id, thread_id, thread_native, sender_urn, body, event_ts, source)
    VALUES (@message_urn, @account_id, @thread_id, @thread_native, @sender_urn, @body, @event_ts, @source)
  `).run({
    message_urn: evt.message_urn,
    account_id: evt.account_id ?? null,
    thread_id: evt.thread_id,
    thread_native: evt.thread_native ?? null,
    sender_urn: evt.sender_urn ?? null,
    body: evt.body ?? null,
    event_ts: evt.event_ts ?? null,
    source: evt.source ?? 'realtime',
  })
  return { inserted: info.changes > 0 }
}
export function nextPending(limit = 20) {
  return db.prepare('SELECT * FROM events WHERE processed_at IS NULL ORDER BY received_at ASC LIMIT ?').all(limit)
}
export function markProcessed(message_urn, { reply_status, reply_note } = {}) {
  db.prepare(`UPDATE events SET processed_at=datetime('now'), reply_status=?, reply_note=? WHERE message_urn=?`)
    .run(reply_status ?? null, reply_note ?? null, message_urn)
}
export function queueDepth() {
  return db.prepare('SELECT COUNT(*) c FROM events WHERE processed_at IS NULL').get().c
}
// True once we've ever processed anything. On a restart this is true, so the
// baseline was already established on a prior run — dedup on message_urn handles
// inbox history, and genuinely-new messages (those that arrived during downtime)
// become reply-eligible. Only a truly fresh DB (first-ever boot) seed-suppresses.
export function hasPriorState() {
  return db.prepare('SELECT COUNT(*) c FROM events').get().c > 0
}
export function recentEvents(limit = 10) {
  return db.prepare('SELECT message_urn, sender_urn, substr(body,1,50) body, source, processed_at, reply_status FROM events ORDER BY received_at DESC LIMIT ?').all(limit)
}

// ---- cursors ----
export function upsertCursor(account_id, thread_id, last_message_urn, last_event_ts) {
  db.prepare(`
    INSERT INTO cursors (account_id, thread_id, last_message_urn, last_event_ts, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(account_id, thread_id) DO UPDATE SET
      last_message_urn=excluded.last_message_urn,
      last_event_ts=excluded.last_event_ts,
      updated_at=datetime('now')
  `).run(account_id, thread_id, last_message_urn ?? null, last_event_ts ?? null)
}
export function getCursor(account_id, thread_id) {
  return db.prepare('SELECT * FROM cursors WHERE account_id=? AND thread_id=?').get(account_id, thread_id)
}

// ---- health ----
export function setHealth(h) {
  db.prepare(`
    INSERT INTO health (account_id, listener_up, push_active, authed, last_event_at, queue_depth, note, checked_at)
    VALUES (@account_id,@listener_up,@push_active,@authed,@last_event_at,@queue_depth,@note, datetime('now'))
    ON CONFLICT(account_id) DO UPDATE SET
      listener_up=excluded.listener_up, push_active=excluded.push_active, authed=excluded.authed,
      last_event_at=excluded.last_event_at, queue_depth=excluded.queue_depth, note=excluded.note,
      checked_at=datetime('now')
  `).run({
    account_id: h.account_id, listener_up: h.listener_up ? 1 : 0, push_active: h.push_active ? 1 : 0,
    authed: h.authed ? 1 : 0, last_event_at: h.last_event_at ?? null, queue_depth: h.queue_depth ?? 0,
    note: h.note ?? null,
  })
}
export function getHealth(account_id) {
  return db.prepare('SELECT * FROM health WHERE account_id=?').get(account_id)
}

export default db
