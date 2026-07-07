// oc-li-service — shared config / paths.
// The OpenComputer-native managed LinkedIn channel service: the "Unipile
// equivalent" we ship by default. Realtime (message-listen push) + reconcile
// (inbox backfill) + durable state + supervision, all owned on the VM.
//
// One instance = one logged-in LinkedIn account (adapter windows are single-
// owner, so one browser session per instance). Scale = one instance per VM.
// The account IDENTITY is auto-derived at login (the [self] record); only the
// deploy-specific POLICY lives in account.json.
import { readFileSync, existsSync } from 'node:fs'

export const SERVICE_DIR   = '/opt/oc-li-service'
export const DB_PATH       = `${SERVICE_DIR}/state.db`
export const SENDFILE      = `${SERVICE_DIR}/replies.jsonl`
export const EVENTS_FILE   = `${SERVICE_DIR}/listener.jsonl`
export const LISTENER_ERR  = `${SERVICE_DIR}/listener.err`
export const ACCOUNT_CFG   = `${SERVICE_DIR}/account.json`

export const OPENCLI       = '/usr/bin/opencli'
export const OC_CWD        = '/opt/opencli'
export const OC_ENV        = { ...process.env, HOME: '/root' }

// ── per-deployment account config (account.json) ───────────────────────────
// {
//   "label": "archit-maya (test)",
//   "reply_policy": "allowlist" | "all_leads",
//   "allowlist": ["ACoAA…"],           // members that may receive a real reply (test mode)
//   "engine": { "cmd": "/usr/bin/python3", "args": ["/root/oc_li_engage.py"] },
//   "listen_duration": 3600
// }
let _acct = {}
try { if (existsSync(ACCOUNT_CFG)) _acct = JSON.parse(readFileSync(ACCOUNT_CFG, 'utf8')) } catch (e) { console.error('account.json parse error:', e.message) }

export const ACCOUNT_LABEL = _acct.label || 'unnamed-account'
export const REPLY_POLICY  = _acct.reply_policy || 'allowlist'          // default to the SAFE mode
export const REPLY_ALLOWLIST = new Set(_acct.allowlist || [])
export const ENGINE_CMD    = _acct.engine?.cmd  || '/usr/bin/python3'
export const ENGINE_ARGS   = _acct.engine?.args || ['/root/oc_li_engage.py']
export const LISTEN_DURATION = _acct.listen_duration || 3600
export const DRY_RUN       = process.env.OC_LI_DRYRUN === '1'

export const RECONCILE_EVERY_MS = 90_000   // pull-backfill cadence
export const HEALTH_EVERY_MS    = 30_000

// ── reply gate ─────────────────────────────────────────────────────────────
// allowlist : only listed members get a real reply (test / a real production
//             account we don't want auto-engaged except for specific people).
// all_leads : reply to anyone the ENGINE engages — the engine's CRM lead-lookup
//             already gates (unknown senders → no reply), so this is the normal
//             production mode once an account is cleared for full auto-engagement.
export function isReplyAllowed(senderUrn) {
  if (REPLY_POLICY === 'all_leads') return true
  return REPLY_ALLOWLIST.has(extractProfileId(senderUrn))
}

// Native "2-…" thread id (what message-send wants) from a full conversation URN
// urn:li:msg_conversation:(urn:li:fsd_profile:SELF,2-XXXX) or a bare 2-… id.
export function nativeThreadId(threadId) {
  const m = String(threadId || '').match(/(2-[A-Za-z0-9_+/=-]+)/)
  return m ? m[1] : ''
}

// Stable member id (ACoAA… token) from any URN shape.
export function extractProfileId(urn) {
  const m = String(urn || '').match(/fsd_profile:([A-Za-z0-9_-]+)/)
  return m ? m[1] : ''
}

// The conversation URN embeds the mailbox owner (self) as the first fsd_profile.
export function selfFromThreadId(threadId) {
  return extractProfileId(threadId)
}
