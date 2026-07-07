#!/usr/bin/env node
// oc-li agent — the per-account worker. One process owns one logged-in account:
//   • spawns + supervises the message-listen child (the single adapter owner)
//   • rides the cold-start "Navigation rejected" warm-up via restart-on-exit
//   • captures the [self] record at startup  → upserts the account (account_id equiv)
//   • ingests listener stdout events → durable, idempotent events queue
//   • replies in-band via the sendfile (no separate adapter process → no contention)
//   • reconciles via in-band {action:backfill} (post-restart + periodic) so nothing
//     is lost across gaps/crashes — the pull safety net beside the realtime push
//   • health watchdog: functional-stuck restart, session-suspect alert, PAUSE
//     OUTBOUND when not authed (never send into a dead session)
// Graceful shutdown SIGTERMs the listener so its adapter tab cleans up (SIGKILL
// strands the tab and breaks the next navigation).
import { spawn, execFile } from 'node:child_process'
import { appendFileSync, writeFileSync, existsSync } from 'node:fs'
import * as store from './db.mjs'
import {
  OPENCLI, OC_CWD, OC_ENV, SENDFILE, LISTEN_DURATION,
  RECONCILE_EVERY_MS, HEALTH_EVERY_MS, nativeThreadId, extractProfileId,
  isReplyAllowed, DRY_RUN, ENGINE_CMD, ENGINE_ARGS, ACCOUNT_LABEL, REPLY_POLICY,
} from './config.mjs'

const STUCK_MS = 90_000          // spawned but no push-active within this → restart
const MAX_FAILED_SPAWNS = 5      // consecutive warm-up failures → session suspect + alert
const DRAIN_EVERY_MS = 10_000    // retry deferred (auth-paused) replies

let account = null
let listenerProc = null
let restartCount = 0
let failedSpawns = 0
let spawnedAt = 0
let pushActive = false
let lastEventAt = null
let shuttingDown = false
// Until the baseline is seeded, every ingested message is treated as HISTORY:
// recorded + marked processed, but NEVER replied. Only messages that arrive
// after the baseline are reply-eligible. Prevents echoing a whole inbox on boot.
let baselineSeeded = false

const log = (...a) => console.log(new Date().toISOString(), ...a)
const short = (urn) => (urn || '').replace(/.*fsd_profile:/, '').slice(0, 10)
const authed = () => account && account.session_status === 'authed'

// ---- reply engine: the EXISTING sales engine (engagement + auto_reply via the
//      OC router), invoked through the thin Python glue. oc-li only ferries the
//      inbound in and the reply out — the brain is unchanged. ----
function generateReply(ev, cb) {
  const input = JSON.stringify({
    member_id: extractProfileId(ev.sender_urn),
    chat_id: ev.thread_native,
    thread_id: ev.thread_native,
    text: ev.body,
  })
  const child = execFile(ENGINE_CMD, ENGINE_ARGS, { timeout: 60_000, cwd: '/root' }, (err, stdout) => {
    if (err) { log(`engine error: ${err.message}`); cb(null, 'engine_error'); return }
    let out = null
    for (const line of String(stdout).trim().split('\n')) { try { const j = JSON.parse(line); if ('reply' in j) out = j } catch {} }
    if (!out) { cb(null, 'no_json'); return }
    cb(out.reply || null, out.action || 'none')
  })
  try { child.stdin.write(input); child.stdin.end() } catch {}
}

// ---- ingest: insert one inbound message into the durable queue (idempotent) ----
function ingestLine(line, source = 'realtime') {
  let e; try { e = JSON.parse(line) } catch { return }
  if (e.event_type === 'send_result' || e.event_type === 'send_error') { if (e.error) log(`send_result err: ${e.error}`); return }
  if (e.event_type !== 'message' || !e.body || !e.message_urn) return
  lastEventAt = new Date().toISOString()
  const rec = {
    message_urn: e.message_urn,
    account_id: account?.member_id || extractProfileId(e.thread_id), // conv-owner = self fallback
    thread_id: e.thread_id,
    thread_native: nativeThreadId(e.thread_id),
    sender_urn: e.sender_urn,
    body: e.body,
    event_ts: e.timestamp,
    source,
  }
  const { inserted } = store.insertEvent(rec)
  if (!inserted) return
  if (!baselineSeeded) {
    // History: record + cursor, but NEVER reply (prevents echoing the inbox on boot).
    store.markProcessed(rec.message_urn, { reply_status: 'seeded', reply_note: source })
    store.upsertCursor(rec.account_id || '', rec.thread_native || '', rec.message_urn, rec.event_ts)
    return
  }
  log(`● new msg urn=…${e.message_urn.slice(-10)} sender=${short(e.sender_urn)} src=${source} "${(e.body || '').slice(0, 40)}"`)
  drainPending()
}

// ---- reply to pending events. Gated (in order) by: baseline seeded, authed
//      (pause on logout), the SAFETY allowlist (only Maya), then the engine.
//      Engine call is async (LLM latency), so we track in-flight to avoid
//      double-processing across ingest + periodic drains.
const inFlight = new Set()
function drainPending() {
  if (!baselineSeeded || !authed()) return
  for (const ev of store.nextPending(50)) {
    if (inFlight.has(ev.message_urn)) continue
    const native = ev.thread_native
    if (!native) { store.markProcessed(ev.message_urn, { reply_status: 'skipped', reply_note: 'no_native_thread' }); continue }
    // SAFETY: only allowlisted senders (Maya) ever reach the engine / a real
    // reply. Every real lead on Archit's production account is ingested + blocked.
    if (!isReplyAllowed(ev.sender_urn)) {
      store.markProcessed(ev.message_urn, { reply_status: 'blocked_not_allowlist', reply_note: short(ev.sender_urn) })
      log(`⛔ blocked (not allowlisted) sender=${short(ev.sender_urn)} thr=${native.slice(0, 12)} "${(ev.body || '').slice(0, 28)}"`)
      continue
    }
    inFlight.add(ev.message_urn)
    log(`🧠 engaging via engine — thread=${native.slice(0, 14)} sender=${short(ev.sender_urn)} "${(ev.body || '').slice(0, 32)}"`)
    generateReply(ev, (reply, action) => {
      inFlight.delete(ev.message_urn)
      if (!reply) { store.markProcessed(ev.message_urn, { reply_status: 'no_reply', reply_note: action }); log(`… engine: no reply (action=${action})`); return }
      if (DRY_RUN) {
        store.markProcessed(ev.message_urn, { reply_status: 'dryrun', reply_note: 'engine' })
        log(`🧪 DRY-RUN engine reply (${action}) → "${reply.slice(0, 80)}"`)
        return
      }
      try { appendFileSync(SENDFILE, JSON.stringify({ action: 'send', thread_id: native, message: reply }) + '\n') }
      catch (err) { log('sendfile write failed: ' + err.message); return }
      store.markProcessed(ev.message_urn, { reply_status: 'sent', reply_note: `engine:${action}` })
      store.upsertCursor(ev.account_id || '', native, ev.message_urn, ev.event_ts)
      log(`↩ ENGINE reply → thread=${native.slice(0, 16)} (${action}) : "${reply.slice(0, 80)}"`)
    })
  }
}

// ---- in-band reconcile: ask the listener to re-fetch recent convos ----
function triggerBackfill(reason) {
  if (!existsSync(SENDFILE)) return
  try { appendFileSync(SENDFILE, JSON.stringify({ action: 'backfill', count: 20 }) + '\n'); log(`⟳ backfill (${reason})`) } catch {}
}

// ---- listener stderr: [self] record, push status, warm-up failures ----
function onErrLine(line) {
  if (line.includes('[self]')) {
    const m = line.match(/\[self\] member_id=(\S*) public_id=(\S*) name=("(?:[^"\\]|\\.)*"|\S*)/)
    if (m && m[1]) {
      let name = m[3] || ''
      try { name = JSON.parse(name) } catch {}
      account = store.upsertAccount({ member_id: m[1], public_identifier: m[2] || null, name: name || null, session_status: 'authed' })
      log(`✓ account: ${account.name || '?'} @${account.public_identifier || '?'} (${m[1].slice(0, 12)}…)`)
    }
  } else if (line.includes('push pipeline: ACTIVE')) {
    pushActive = true; failedSpawns = 0
    if (account) { store.setSessionStatus(account.member_id, 'authed'); account.session_status = 'authed' }
    log('▶ push pipeline ACTIVE')
    triggerBackfill('post-activate')   // seed baseline (history recorded, NOT replied)
    // Fallback: if the backfill yields no summary line, still seed after 20s so
    // the agent doesn't stay frozen in seeding mode forever.
    setTimeout(() => { if (!baselineSeeded && !shuttingDown) { baselineSeeded = true; log('✓ baseline seeded (fallback timer)') } }, 20_000)
  } else if (line.includes('[backfill]')) {
    log('  ' + line.trim().slice(0, 80))
    if (!baselineSeeded && line.includes('fetched=')) {
      baselineSeeded = true
      log('✓ baseline seeded — inbox history recorded (no replies); now reply-eligible for NEW allowlisted msgs only')
    }
  } else if (/Navigation rejected|poll fallback|push pipeline setup failed/.test(line)) {
    log('… listener startup: ' + line.trim().slice(0, 70))
  }
}

// ---- supervise the listener child ----
function startListener() {
  if (shuttingDown) return
  if (!existsSync(SENDFILE)) writeFileSync(SENDFILE, '')
  pushActive = false
  spawnedAt = Date.now()
  const args = ['linkedin', 'message-listen', '--stream', '--duration', String(LISTEN_DURATION), '--timeout', '0', '--type', 'message']
  const env = { ...OC_ENV, OC_LISTEN_DEBUG: '1', OC_LISTEN_MEASURE: '1', OC_LISTEN_SENDFILE: SENDFILE }
  listenerProc = spawn(OPENCLI, args, { cwd: OC_CWD, env, stdio: ['ignore', 'pipe', 'pipe'] })
  log(`listener spawned pid=${listenerProc.pid} (restart #${restartCount})`)

  let outBuf = ''
  listenerProc.stdout.on('data', (d) => {
    outBuf += d
    let i; while ((i = outBuf.indexOf('\n')) >= 0) { const l = outBuf.slice(0, i).trim(); outBuf = outBuf.slice(i + 1); if (l) ingestLine(l) }
  })
  let errBuf = ''
  listenerProc.stderr.on('data', (d) => {
    errBuf += d
    let i; while ((i = errBuf.indexOf('\n')) >= 0) { const l = errBuf.slice(0, i); errBuf = errBuf.slice(i + 1); if (l.trim()) onErrLine(l) }
  })
  listenerProc.on('exit', (code, sig) => {
    listenerProc = null
    if (shuttingDown) return
    if (!pushActive) {
      failedSpawns++
      if (failedSpawns >= MAX_FAILED_SPAWNS) {
        log(`🔔 ALERT: ${failedSpawns} consecutive listener failures without push — session SUSPECT (paused outbound)`)
        if (account) { store.setSessionStatus(account.member_id, 'suspect'); account.session_status = 'suspect' }
      }
    }
    restartCount++
    log(`listener exited code=${code} sig=${sig}; restart in 3s`)
    setTimeout(startListener, 3000)
  })
}

// ---- health watchdog ----
setInterval(() => {
  if (shuttingDown) return
  const listener_up = !!listenerProc
  // functional-stuck: spawned, didn't die, but never reached push → restart
  if (listener_up && !pushActive && spawnedAt && (Date.now() - spawnedAt > STUCK_MS)) {
    log('⚠ listener stuck (no push in 90s) — SIGTERM to restart')
    try { listenerProc.kill('SIGTERM') } catch {}
  }
  if (account) {
    store.setHealth({
      account_id: account.member_id, listener_up, push_active: pushActive,
      authed: authed(), last_event_at: lastEventAt, queue_depth: store.queueDepth(),
      note: !listener_up ? 'listener_down' : (pushActive ? 'ok' : 'warming'),
    })
  }
}, HEALTH_EVERY_MS)

// ---- periodic reconcile + deferred-reply drain ----
setInterval(() => { if (!shuttingDown && pushActive) triggerBackfill('periodic') }, RECONCILE_EVERY_MS)
setInterval(() => { if (!shuttingDown) drainPending() }, DRAIN_EVERY_MS)

// ---- graceful shutdown ----
function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  log('shutdown: SIGTERM listener')
  if (listenerProc) { try { listenerProc.kill('SIGTERM') } catch {} }
  setTimeout(() => process.exit(0), 4000)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

// On (re)start, reap any orphaned listener left by a hard-crashed predecessor.
// A SIGKILL'd agent can't clean up its child, so the orphan keeps holding the
// adapter window and the fresh listener would hit "Navigation rejected". Reaping
// first = clean warm-up on recovery.
function reapOrphansThen(done) {
  execFile('pkill', ['-9', '-f', 'message-listen --stream --duration'], () => setTimeout(done, 1500))
}

log(`oc-li agent starting — account="${ACCOUNT_LABEL}" reply_policy=${REPLY_POLICY}${DRY_RUN ? ' [DRY-RUN]' : ''}`)
// Restart with prior state → gap-recovery mode (missed messages reply-eligible;
// dedup handles history). Fresh DB → first backfill seeds the inbox as history.
baselineSeeded = store.hasPriorState()
log(baselineSeeded
  ? '↺ prior state found — gap-recovery mode: history is deduped, new/missed messages ARE reply-eligible'
  : '⊙ fresh DB — first backfill will seed the inbox as history (no replies)')
reapOrphansThen(startListener)
