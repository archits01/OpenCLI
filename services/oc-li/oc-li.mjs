#!/usr/bin/env node
// oc-li — control CLI for the OpenComputer LinkedIn channel service.
// Subcommands are added phase by phase. Phase 0: status/db-check.
import * as store from './db.mjs'
import { primaryAccount } from './db.mjs'

const cmd = process.argv[2] || 'status'

function status() {
  const acct = primaryAccount()
  console.log('=== oc-li-service status ===')
  if (!acct) {
    console.log('account:   <none captured yet — run `oc-li whoami`>')
  } else {
    console.log(`account:   ${acct.name || '?'}  (@${acct.public_identifier || '?'})`)
    console.log(`member_id: ${acct.member_id}`)
    console.log(`session:   ${acct.session_status}   last_authed=${acct.last_authed_at || '-'}`)
    const h = store.getHealth(acct.member_id)
    if (h) console.log(`health:    listener=${h.listener_up} push=${h.push_active} authed=${h.authed} qdepth=${h.queue_depth} last_event=${h.last_event_at || '-'} @${h.checked_at}`)
  }
  console.log(`queue:     ${store.queueDepth()} pending`)
  const recent = store.recentEvents(8)
  if (recent.length) {
    console.log('recent events:')
    for (const e of recent) {
      const who = (e.sender_urn || '').replace(/^.*fsd_profile:/, '').slice(0, 12)
      console.log(`  [${e.source}] ${who}  "${(e.body || '').slice(0, 40)}"  proc=${e.processed_at ? 'Y' : 'N'} reply=${e.reply_status || '-'}`)
    }
  }
}

function dbCheck() {
  console.log('db opened + schema applied OK')
  console.log('accounts:', store.primaryAccount() ? 1 : 0, '| queue:', store.queueDepth())
}

const table = { status, 'db-check': dbCheck }
const fn = table[cmd]
if (!fn) { console.error(`unknown command: ${cmd}\navailable: ${Object.keys(table).join(', ')}`); process.exit(1) }
try { await fn() } catch (e) { console.error('error:', e.message); process.exit(1) }
