import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, CommandExecutionError } from '@jackwener/opencli/errors';
import { createInterface } from 'node:readline';
import {
  unwrapEvaluateResult,
  requireLinkedInCookie,
  assertLinkedInAuthenticated,
  LINKEDIN_DOMAIN,
  normalizeWhitespace,
} from './shared.js';

const MESSAGING_URL = 'https://www.linkedin.com/messaging/';
const MIN_DURATION = 0;
const MAX_DURATION = 86400;
const DEFAULT_DURATION = 60;
const DEFAULT_TIMEOUT = 0;
const POLL_INTERVAL_MS = 200;

// URL pattern for network capture — empty string captures ALL requests.
// Filtering is done in parseNetworkCaptureEntry() instead.
const CAPTURE_PATTERN = '';

// ── LinkedIn realtime frame parser ─────────────────────────────────────
//
// LinkedIn delivers messaging events via HTTP (fetch/XHR), NOT WebSocket.
// Key endpoints:
//   - /realtime/realtimeFrontendSubscriptions — SSE-style subscriptions
//   - /voyagerMessagingGraphQL/graphql — message data (messengerMessages, etc.)
//   - /realtime/realtimeFrontendClientConnectivityTracking — heartbeats
//
// We use page.startNetworkCapture() (CDP Network.enable) to capture response
// bodies at the browser level — no JS injection needed. This catches ALL
// network traffic including requests fired before any JS could be injected.
//
// Responses are normalized JSON with $type markers in `included` arrays:
//   - com.linkedin.messenger.Message
//   - com.linkedin.messenger.TypingIndicator
//   - com.linkedin.messenger.MessageSeenReceipt
//   - com.linkedin.realtimeConnect.PresenceStatus

function parseNetworkCaptureEntry(entry) {
  if (!entry || !entry.responsePreview) return null;
  // Only process JSON responses from realtime/messaging endpoints
  const url = entry.url || '';
  if (!/realtime|messaging|messengerMessage|messengerConversation/i.test(url)) return null;
  // Skip non-message endpoints (settings, badges, nudges, quick replies, etc.)
  if (/MessagingSettings|markAllMessages|messagingBadge|ConversationNudge|AwayStatus|SecondaryInbox/i.test(url)) return null;

  const data = entry.responsePreview;
  // Skip base64-encoded binary responses
  if (typeof data === 'string' && data.startsWith('base64:')) return null;

  let parsed;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }

  const events = [];
  const candidates = extractCandidates(parsed);
  const ts = entry.timestamp || Date.now();

  for (const obj of candidates) {
    const type = getType(obj);

    if (/TypingIndicator/i.test(type) || obj.topic === 'typingIndicatorsTopic') {
      events.push({
        event_type: 'typing',
        thread_id: extractThreadId(obj),
        sender_urn: extractSenderUrn(obj),
        body: '',
        message_urn: '',
        timestamp: extractTimestamp(obj, ts),
        raw: '',
      });
    } else if (/MessageSeenReceipt|messageSeenReceipt/i.test(type) || obj.topic === 'messageSeenReceiptsTopic') {
      events.push({
        event_type: 'seen',
        thread_id: extractThreadId(obj),
        sender_urn: extractSenderUrn(obj),
        body: '',
        message_urn: obj.messageUrn || obj.lastSeenMessageUrn || '',
        timestamp: extractTimestamp(obj, ts),
        raw: '',
      });
    } else if (/PresenceStatus|presenceStatus/i.test(type)) {
      events.push({
        event_type: 'presence',
        thread_id: '',
        sender_urn: obj.entityUrn || obj.memberUrn || '',
        body: obj.status || '',
        message_urn: '',
        timestamp: extractTimestamp(obj, ts),
        raw: '',
      });
    } else if (/com\.linkedin\.messenger\.Message$/i.test(type) || obj.topic === 'messagesTopic') {
      events.push({
        event_type: 'message',
        thread_id: extractThreadId(obj),
        sender_urn: extractSenderUrn(obj),
        body: extractBody(obj),
        message_urn: obj.backendUrn || obj.entityUrn || obj.dashEntityUrn || '',
        timestamp: extractTimestamp(obj, ts),
        raw: '',
      });
    } else if (type || obj.topic) {
      const rawStr = JSON.stringify(obj);
      events.push({
        event_type: 'unknown',
        thread_id: extractThreadId(obj),
        sender_urn: extractSenderUrn(obj),
        body: '',
        message_urn: '',
        timestamp: extractTimestamp(obj, ts),
        raw: rawStr.length > 500 ? rawStr.slice(0, 500) + '...' : rawStr,
      });
    }
  }

  return events.length > 0 ? events : null;
}

// Kept for backward compatibility with tests that use the old name
function parseLinkedInRealtimeFrame(frame) {
  if (!frame || typeof frame.data !== 'string') return null;
  let parsed;
  try {
    parsed = JSON.parse(frame.data);
  } catch {
    return null;
  }
  const events = [];
  const candidates = extractCandidates(parsed);
  for (const obj of candidates) {
    const type = getType(obj);
    if (/TypingIndicator/i.test(type) || obj.topic === 'typingIndicatorsTopic') {
      events.push({ event_type: 'typing', thread_id: extractThreadId(obj), sender_urn: extractSenderUrn(obj), body: '', message_urn: '', timestamp: extractTimestamp(obj, frame.ts), raw: '' });
    } else if (/MessageSeenReceipt|messageSeenReceipt/i.test(type) || obj.topic === 'messageSeenReceiptsTopic') {
      events.push({ event_type: 'seen', thread_id: extractThreadId(obj), sender_urn: extractSenderUrn(obj), body: '', message_urn: obj.messageUrn || obj.lastSeenMessageUrn || '', timestamp: extractTimestamp(obj, frame.ts), raw: '' });
    } else if (/PresenceStatus|presenceStatus/i.test(type)) {
      events.push({ event_type: 'presence', thread_id: '', sender_urn: obj.entityUrn || obj.memberUrn || '', body: obj.status || '', message_urn: '', timestamp: extractTimestamp(obj, frame.ts), raw: '' });
    } else if (/com\.linkedin\.messenger\.Message$/i.test(type) || obj.topic === 'messagesTopic') {
      events.push({ event_type: 'message', thread_id: extractThreadId(obj), sender_urn: extractSenderUrn(obj), body: extractBody(obj), message_urn: obj.backendUrn || obj.entityUrn || obj.dashEntityUrn || '', timestamp: extractTimestamp(obj, frame.ts), raw: '' });
    } else if (type || obj.topic) {
      const rawStr = JSON.stringify(obj);
      events.push({ event_type: 'unknown', thread_id: extractThreadId(obj), sender_urn: extractSenderUrn(obj), body: '', message_urn: '', timestamp: extractTimestamp(obj, frame.ts), raw: rawStr.length > 500 ? rawStr.slice(0, 500) + '...' : rawStr });
    }
  }
  return events.length > 0 ? events : null;
}

function getType(obj) {
  return obj.$type || obj._type || obj.type || '';
}

function hasType(obj) {
  return !!(obj.$type || obj._type || obj.type || obj.topic);
}

function extractCandidates(parsed) {
  const candidates = [];

  function collect(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
    if (hasType(obj)) candidates.push(obj);
    // Recurse into known wrapper shapes
    if (obj.data && typeof obj.data === 'object' && !Array.isArray(obj.data)) collect(obj.data);
    if (obj.payload && typeof obj.payload === 'object') collect(obj.payload);
    if (obj.event && typeof obj.event === 'object') collect(obj.event);
    if (obj.value && typeof obj.value === 'object') collect(obj.value);
    // LinkedIn GraphQL: messengerMessagesBySyncToken.elements, messengerConversations.elements, etc.
    for (const key of Object.keys(obj)) {
      const val = obj[key];
      if (val && typeof val === 'object' && !Array.isArray(val) && Array.isArray(val.elements)) {
        for (const el of val.elements) {
          if (el && typeof el === 'object' && hasType(el)) candidates.push(el);
        }
      }
    }
    // included array (older response format)
    if (Array.isArray(obj.included)) {
      for (const item of obj.included) {
        if (item && typeof item === 'object' && hasType(item)) candidates.push(item);
      }
    }
    // data as array
    if (Array.isArray(obj.data)) {
      for (const item of obj.data) {
        if (item && typeof item === 'object' && hasType(item)) candidates.push(item);
      }
    }
  }

  collect(parsed);

  if (candidates.length === 0 && parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    if (parsed.topic || parsed.entityUrn || parsed.backendUrn) {
      candidates.push(parsed);
    }
  }

  return candidates;
}

function extractThreadId(obj) {
  const urn = obj.conversationUrn || obj.threadUrn || obj['*conversation'] || '';
  if (urn) {
    const match = String(urn).match(/messagingThread:(.+)/);
    return match ? match[1] : String(urn);
  }
  if (obj.backendConversationUrn) {
    const match = String(obj.backendConversationUrn).match(/messagingThread:(.+)/);
    return match ? match[1] : String(obj.backendConversationUrn);
  }
  // Extract from backendUrn of a message: urn:li:messagingMessage:2-XXXX==
  if (obj.backendUrn) {
    const match = String(obj.backendUrn).match(/messagingMessage:(.+)/);
    if (match) return match[1].replace(/==$/, '==');
  }
  return '';
}

function extractSenderUrn(obj, byUrn) {
  // LinkedIn GraphQL wraps actor as object: { actor: { hostIdentityUrn: "...", entityUrn: "..." } }
  if (obj.actor && typeof obj.actor === 'object') {
    return obj.actor.hostIdentityUrn || obj.actor.entityUrn || '';
  }
  if (obj.actorUrn || obj.senderUrn || obj.fromUrn) return obj.actorUrn || obj.senderUrn || obj.fromUrn;
  if (typeof obj.actor === 'string') return obj.actor;
  // Normalized format: *actor is a URN reference to a participant entity
  if (obj['*actor']) {
    if (byUrn) {
      const actor = byUrn.get(obj['*actor']);
      if (actor) return actor.hostIdentityUrn || actor.entityUrn || obj['*actor'];
    }
    return obj['*actor'];
  }
  return obj['*from'] || '';
}

// Extract the stable member profile id (the ACoAA… token) from any URN shape:
//   urn:li:fsd_profile:ACoAA…                                  → ACoAA…
//   urn:li:msg_messagingParticipant:urn:li:fsd_profile:ACoAA…  → ACoAA…
// Used to match "self" regardless of whether the sender came through as a bare
// profile URN or wrapped in a messagingParticipant URN (which broke ===).
function extractProfileId(urn) {
  const m = String(urn || '').match(/fsd_profile:([A-Za-z0-9_-]+)/);
  return m ? m[1] : '';
}

function extractBody(obj) {
  // LinkedIn uses AttributedText: { _type: "com.linkedin.pemberly.text.AttributedText", text: "..." }
  if (obj.body && typeof obj.body === 'object' && typeof obj.body.text === 'string') return obj.body.text;
  if (typeof obj.body === 'string') return obj.body;
  if (typeof obj.text === 'string') return obj.text;
  // displayText for quick replies
  if (obj.displayText && typeof obj.displayText === 'object' && typeof obj.displayText.text === 'string') return obj.displayText.text;
  return '';
}

function extractTimestamp(obj, fallbackTs) {
  const ms = obj.createdAt || obj.deliveredAt || obj.lastActivityAt || obj.timestamp || fallbackTs || 0;
  if (!ms) return '';
  try {
    return new Date(Number(ms)).toISOString();
  } catch {
    return '';
  }
}

function parseDuration(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_DURATION;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < MIN_DURATION || parsed > MAX_DURATION) {
    throw new ArgumentError(`--duration must be an integer between ${MIN_DURATION} and ${MAX_DURATION} (0 = listen until a message arrives)`);
  }
  return parsed;
}

// ── Long-poll interceptor (injected into the page via page.evaluate) ──
// Patches fetch to detect delivery ACKs and messaging events. Instead of
// pushing to an array that gets polled, stores a resolver function that
// the long-poll promise can resolve instantly when an event fires.
const REALTIME_INTERCEPTOR_SCRIPT = String.raw`(() => {
  if (window.__opencli_lp_patched) return 'already_patched';
  window.__opencli_lp_patched = true;
  window.__opencli_lp_resolver = null;
  window.__opencli_lp_queue = [];
  window.__opencli_rt = [];

  function pushEvent(evt, isAck) {
    window.__opencli_rt.push(evt);
    if (!isAck) return;
    if (window.__opencli_lp_resolver) {
      var resolve = window.__opencli_lp_resolver;
      window.__opencli_lp_resolver = null;
      resolve(JSON.stringify(evt));
    } else {
      window.__opencli_lp_queue.push(evt);
      if (window.__opencli_lp_queue.length > 100) window.__opencli_lp_queue.shift();
    }
  }

  // 1. Intercept ReadableStream chunks — catches streaming fetch data
  try {
    var origRead = ReadableStreamDefaultReader.prototype.read;
    ReadableStreamDefaultReader.prototype.read = function() {
      return origRead.call(this).then(function(result) {
        if (!result.done && result.value) {
          try {
            var text = new TextDecoder().decode(result.value);
            if (text.length > 20 && /messag|thread|typing|conversation|mercury|realtime/i.test(text)) {
              pushEvent({ ts: Date.now(), src: 'stream', data: text.substring(0, 8000) });
            }
          } catch(e) {}
        }
        return result;
      });
    };
  } catch(e) {}

  // 2. Intercept fetch for messaging endpoints — captures request + response bodies
  try {
    var origFetch = window.fetch;
    window.fetch = function() {
      var url = typeof arguments[0] === 'string' ? arguments[0] : (arguments[0] && arguments[0].url ? arguments[0].url : '');
      var opts = arguments[1] || {};
      var p = origFetch.apply(this, arguments);

      if (/deliveryAck|messaging|realtime/i.test(url) && !/[?&]_oc=1/.test(url)) {
        var isAck = /deliveryAck/i.test(url);
        var reqBody = '';
        if (opts.body) {
          try { reqBody = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body); } catch(e) {}
        }
        p.then(function(resp) {
          return resp.clone().text().then(function(body) {
            pushEvent({
              ts: Date.now(),
              src: 'fetch',
              url: url.substring(0, 500),
              reqBody: reqBody.substring(0, 2000),
              data: body.substring(0, 8000)
            }, isAck);
          });
        }).catch(function() {});
      }

      return p;
    };
  } catch(e) {}

  return 'interceptor_installed';
})()`;


async function discoverApiConfig(page) {
  const script = String.raw`(() => {
    try {
      var csrfMatch = document.cookie.match(/JSESSIONID="?([^";]+)/);
      var csrf = csrfMatch ? csrfMatch[1] : '';
      var urls = performance.getEntriesByType('resource').map(function(e) { return e.name; });

      // Find messengerMessages queryId (for fetching individual thread messages)
      var msgUrl = '';
      var messagesQueryId = '';
      for (var i = 0; i < urls.length; i++) {
        if (/messengerMessages\.[a-f0-9]+/i.test(urls[i])) {
          msgUrl = urls[i];
          var m = urls[i].match(/queryId=([^&]+)/);
          if (m) messagesQueryId = m[1];
          break;
        }
      }

      // Find messengerConversations queryId (fallback — contains latest message snippet)
      var convQueryId = '';
      for (var j = 0; j < urls.length; j++) {
        if (/messengerConversations\.[a-f0-9]+/i.test(urls[j])) {
          var cm = urls[j].match(/queryId=([^&]+)/);
          if (cm) convQueryId = cm[1];
          break;
        }
      }

      // Extract mailbox URN
      var mailboxUrn = '';
      for (var k = 0; k < urls.length; k++) {
        var mbm = urls[k].match(/mailboxUrn:(urn[^,)&]+)/i);
        if (mbm) { mailboxUrn = decodeURIComponent(mbm[1]); break; }
      }

      // Find full conversations URL for later re-use (performance entries may rotate)
      // Prefer URLs WITHOUT nextCursor (first page), WITH mailboxUrn
      var convFullUrl = '';
      for (var ci = 0; ci < urls.length; ci++) {
        if (/messengerConversations\.[a-f0-9]+/i.test(urls[ci]) && /mailboxUrn/i.test(urls[ci]) && !/nextCursor/i.test(urls[ci])) {
          convFullUrl = urls[ci]; break;
        }
      }
      if (!convFullUrl) {
        for (var cj = 0; cj < urls.length; cj++) {
          if (/messengerConversations\.[a-f0-9]+/i.test(urls[cj]) && /mailboxUrn/i.test(urls[cj])) {
            convFullUrl = urls[cj]; break;
          }
        }
      }

      return JSON.stringify({ csrf: csrf, messagesQueryId: messagesQueryId, convQueryId: convQueryId, mailboxUrn: mailboxUrn, msgUrl: (msgUrl || '').substring(0, 500), convFullUrl: convFullUrl });
    } catch (e) {
      return JSON.stringify({ error: e.message });
    }
  })()`;

  try {
    const raw = unwrapEvaluateResult(await page.evaluate(script));
    return JSON.parse(raw || '{}');
  } catch {
    return {};
  }
}

function extractMessageUrnsFromAck(entry) {
  const body = entry.requestBodyPreview || '';
  try {
    const parsed = JSON.parse(body);
    if (Array.isArray(parsed.messageUrns) && parsed.messageUrns.length > 0) return parsed.messageUrns;
  } catch {}
  const matches = body.match(/urn:li:msg_message:\([^)]+\)/g);
  return matches || [];
}

// ── Piggyback parser: read the body from LinkedIn's OWN message fetch ───
//
// When a message arrives, LinkedIn's client immediately fetches a compact
// `messengerMessages` GraphQL response (decorated format) to render it. That
// response is fully self-contained — body, sender, urn, timestamp all inline —
// so we read it directly instead of firing our own (slower) fetch. See
// clis/linkedin/LINKEDIN-REALTIME-INTERNALS.md for the full format map.
//
// Extract the short message id (the `2-...` token) shared by both the delivery
// ACK urn `urn:li:msg_message:(profile,2-XXX)` and the message `backendUrn`
// `urn:li:messagingMessage:2-XXX`. Used to match an ACK to its message.
function extractMessageId(urn) {
  const m = String(urn || '').match(/2-[A-Za-z0-9+/=_-]+/);
  return m ? m[0].replace(/[),]+$/, '') : '';
}

// LinkedIn's decorated message urn embeds the thread id. Decode it:
//   urn:li:messagingMessage:2-<b64>   where b64 → "<ts>b<seq>-100&<threadGuid>_<suffix>"
// The thread id is `2-` + base64(everything after the final `&`).
function reconstructThreadIdFromMessageUrn(backendUrn) {
  const m = String(backendUrn || '').match(/messagingMessage:2-([A-Za-z0-9+/=]+)/);
  if (!m) return '';
  try {
    const decoded = Buffer.from(m[1], 'base64').toString('utf-8');
    if (decoded.indexOf('&') === -1) return '';
    const threadPart = decoded.slice(decoded.lastIndexOf('&') + 1);
    if (!threadPart) return '';
    return '2-' + Buffer.from(threadPart, 'utf-8').toString('base64');
  } catch {
    return '';
  }
}

// Recursively collect every com.linkedin.messenger.Message object in a response,
// handling both decorated (`_type`) and normalized (`$type`) shapes.
function findMessageObjects(root) {
  const out = [];
  const walk = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 14) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    const type = node._type || node.$type;
    if (type === 'com.linkedin.messenger.Message' && (node.body || node.backendUrn)) out.push(node);
    for (const key in node) {
      const val = node[key];
      if (val && typeof val === 'object') walk(val, depth + 1);
    }
  };
  walk(root, 0);
  return out;
}

// Parse message events from a raw LinkedIn messaging response body. Handles two
// shapes with one code path:
//   1. A plain GraphQL response (LinkedIn's own `messengerMessages` fetch), and
//   2. The `/realtime/connect` Server-Sent Events stream, whose frames are
//      `data: {"com.linkedin.realtimefrontend.DecoratedEvent":{...payload...}}`.
// findMessageObjects walks whatever JSON it's given for com.linkedin.messenger.
// Message objects, so the same extractor serves both. Sender resolves inline via
// the decorated actor object (actor.hostIdentityUrn) — no byUrn map required.
function parseLinkedInOwnMessages(raw, sinceMs) {
  if (!raw || typeof raw !== 'string' || raw.startsWith('base64:')) return [];
  if (raw.indexOf('com.linkedin.messenger.Message') === -1) return [];

  // Collect candidate JSON roots: the whole body, plus each SSE `data:` frame.
  const roots = [];
  try { roots.push(JSON.parse(raw)); } catch { /* not a single JSON doc */ }
  if (raw.indexOf('data:') !== -1) {
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const json = trimmed.slice(5).trim();
      if (!json.startsWith('{')) continue;
      try { roots.push(JSON.parse(json)); } catch { /* partial frame */ }
    }
  }
  if (roots.length === 0) return [];

  const events = [];
  const seen = new Set();
  for (const root of roots) {
    for (const msg of findMessageObjects(root)) {
      const urn = msg.backendUrn || msg.entityUrn || msg.dashEntityUrn || '';
      // A realtime DecoratedEvent may reference a message by urn only (e.g. a
      // reply-suggestion envelope) with no body — skip those.
      const body = extractBody(msg);
      if (!body && !msg.body) continue;
      if (urn && seen.has(urn)) continue;
      if (urn) seen.add(urn);
      const ts = Number(msg.deliveredAt || msg.createdAt || 0);
      if (sinceMs && ts && ts < sinceMs) continue;
      let thread = '';
      if (msg.conversationUrn || msg.threadUrn || msg.backendConversationUrn) {
        thread = extractThreadId(msg);
      } else if (urn) {
        thread = reconstructThreadIdFromMessageUrn(urn);
      }
      events.push({
        event_type: 'message',
        thread_id: thread,
        sender_urn: extractSenderUrn(msg),
        body,
        message_urn: urn,
        timestamp: ts ? new Date(ts).toISOString() : extractTimestamp(msg, ts),
        raw: '',
      });
    }
  }
  return events;
}

async function fetchLatestIncomingMessage(page, ackMessageUrns, apiConfig) {
  const convUrl = apiConfig.convFullUrl || '';
  if (!convUrl || !apiConfig.csrf) return null;

  const safeConvUrl = JSON.stringify(convUrl);
  const safeCsrf = JSON.stringify(apiConfig.csrf);
  const script = `(async () => {
    try {
      var convUrl = ${safeConvUrl};
      var modUrl = convUrl.replace(/,nextCursor:[^)]*/, '');
      modUrl = modUrl.replace(/count:\\d+/, 'count:3');
      if (modUrl.indexOf('_oc=1') === -1) modUrl += (modUrl.indexOf('?') >= 0 ? '&' : '?') + '_oc=1';

      var csrf = ${safeCsrf};
      var resp = await fetch(modUrl, {
        credentials: 'include',
        headers: {
          'csrf-token': csrf,
          'accept': 'application/vnd.linkedin.normalized+json+2.1',
          'x-restli-protocol-version': '2.0.0'
        }
      });
      if (!resp.ok) return JSON.stringify({ _error: resp.status });
      return await resp.text();
    } catch (e) {
      return JSON.stringify({ _error: e.message || String(e) });
    }
  })()`;

  // Ack message ids we're trying to resolve (for matching either response shape)
  const wantIds = (ackMessageUrns || []).map(extractMessageId).filter(Boolean);
  const pickWanted = (list) => {
    if (!list.length) return null;
    if (wantIds.length) {
      const match = list.find((e) => wantIds.includes(extractMessageId(e.message_urn)));
      if (match) return match;
    }
    // else newest by timestamp
    return list.slice().sort((a, b) => (Date.parse(b.timestamp) || 0) - (Date.parse(a.timestamp) || 0))[0];
  };

  try {
    const raw = unwrapEvaluateResult(await page.evaluate(script));
    if (process.env.OC_LISTEN_DEBUG === '1') {
      const s = typeof raw === 'string' ? raw : JSON.stringify(raw);
      process.stderr.write(`[fetchdbg] convUrl=${convUrl.slice(0, 70)} | rawLen=${(s||'').length} | hasMsg=${(s||'').indexOf('com.linkedin.messenger.Message') !== -1} | wantIds=${wantIds.join(',')} | head=${(s||'').slice(0, 200).replace(/\n/g, ' ')}\n`);
    }
    if (!raw) return null;
    let data;
    try { data = JSON.parse(raw); } catch { data = null; }
    if (data && data._error) { if (process.env.OC_LISTEN_DEBUG === '1') process.stderr.write(`[fetchdbg] _error=${JSON.stringify(data._error)}\n`); return null; }

    // Robust path: LinkedIn may return the DECORATED shape (`_type`, no
    // `included[]`). parseLinkedInOwnMessages handles both — try it first and
    // return the message matching the ACK.
    const own = parseLinkedInOwnMessages(raw, 0);
    if (process.env.OC_LISTEN_DEBUG === '1') {
      const matched = wantIds.length ? own.some((e) => wantIds.includes(extractMessageId(e.message_urn))) : true;
      process.stderr.write(`[fetchdbg] parsed ${own.length} msgs; wanted_id_matched=${matched}\n`);
    }
    const wanted = pickWanted(own);
    if (wanted) return wanted;

    // Legacy path: normalized `included[]` conversations shape.
    if (!data || !data.included || !Array.isArray(data.included)) return null;

    const byUrn = new Map();
    for (const o of data.included) {
      if (o && o.entityUrn) byUrn.set(o.entityUrn, o);
    }

    // Find conversations sorted by most recently active
    const conversations = data.included
      .filter((o) => o && o.$type === 'com.linkedin.messenger.Conversation')
      .sort((a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0));

    if (conversations.length === 0) return null;

    // Take the most recently active conversation's last message
    const latestConv = conversations[0];
    const msgRefs = (latestConv.messages && latestConv.messages['*elements']) || [];
    const lastMsg = msgRefs.length > 0 ? byUrn.get(msgRefs[0]) : null;

    const threadId = String(latestConv.backendUrn || '').replace(/^urn:li:messagingThread:/, '');

    if (!lastMsg) {
      // Fall back to conversation description
      return {
        event_type: 'message',
        thread_id: threadId,
        sender_urn: '',
        body: normalizeWhitespace(latestConv.descriptionText || ''),
        message_urn: '',
        timestamp: latestConv.lastActivityAt ? new Date(latestConv.lastActivityAt).toISOString() : new Date().toISOString(),
        raw: '',
      };
    }

    return {
      event_type: 'message',
      thread_id: threadId,
      sender_urn: extractSenderUrn(lastMsg, byUrn),
      body: extractBody(lastMsg),
      message_urn: lastMsg.backendUrn || lastMsg.entityUrn || lastMsg.dashEntityUrn || '',
      timestamp: extractTimestamp(lastMsg, latestConv.lastActivityAt || Date.now()),
      raw: '',
    };
  } catch (e) {
    if (process.env.OC_LISTEN_DEBUG === '1') process.stderr.write(`[fetchdbg] THREW: ${e && e.message ? e.message : String(e)}\n`);
    return null;
  }
}

async function sendMessageViaApi(page, threadId, messageText, apiConfig) {
  const csrf = apiConfig.csrf || '';
  const mailboxUrn = apiConfig.mailboxUrn || '';
  if (!csrf || !mailboxUrn || !threadId || !messageText) {
    return { ok: false, error: 'missing_config', detail: `csrf=${!!csrf} mailbox=${!!mailboxUrn} thread=${!!threadId} text=${!!messageText}` };
  }

  const conversationUrn = `urn:li:msg_conversation:(${mailboxUrn},${threadId})`;
  const safeCsrf = JSON.stringify(csrf);
  const safeConvUrn = JSON.stringify(conversationUrn);
  const safeMailbox = JSON.stringify(mailboxUrn);
  const safeText = JSON.stringify(messageText);

  const script = `(async () => {
    try {
      var token = crypto.randomUUID ? crypto.randomUUID() : (Date.now().toString(36) + Math.random().toString(36).slice(2));
      var trackBytes = new Uint8Array(16);
      crypto.getRandomValues(trackBytes);
      var trackingId = String.fromCharCode.apply(null, trackBytes);
      var payload = {
        message: {
          body: { attributes: [], text: ${safeText} },
          renderContentUnions: [],
          conversationUrn: ${safeConvUrn},
          originToken: token
        },
        mailboxUrn: ${safeMailbox},
        trackingId: trackingId,
        dedupeByClientGeneratedToken: false
      };

      var liTrack = JSON.stringify({
        clientVersion: "1.13.45152",
        mpVersion: "1.13.45152",
        osName: "web",
        timezoneOffset: 5.5,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Calcutta",
        deviceFormFactor: "DESKTOP",
        mpName: "voyager-web",
        displayDensity: window.devicePixelRatio || 1,
        displayWidth: window.screen.width * (window.devicePixelRatio || 1),
        displayHeight: window.screen.height * (window.devicePixelRatio || 1)
      });

      var resp = await fetch('/voyager/api/voyagerMessagingDashMessengerMessages?action=createMessage', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'accept': 'application/json',
          'x-restli-protocol-version': '2.0.0',
          'X-LI-Lang': 'en_US',
          'X-LI-Track': liTrack,
          'Csrf-Token': ${safeCsrf}
        },
        body: JSON.stringify(payload)
      });

      if (!resp.ok) {
        var errText = '';
        try { errText = await resp.text(); } catch(e) {}
        return JSON.stringify({ ok: false, status: resp.status, error: errText.substring(0, 500) });
      }

      var data = {};
      try { data = await resp.json(); } catch(e) {}
      return JSON.stringify({ ok: true, status: resp.status, messageUrn: (data.value && data.value.backendUrn) || '' });
    } catch(e) {
      return JSON.stringify({ ok: false, error: e.message || String(e) });
    }
  })()`;

  try {
    const raw = unwrapEvaluateResult(await page.evaluate(script));
    return JSON.parse(raw || '{}');
  } catch (e) {
    return { ok: false, error: 'evaluate_failed', detail: String(e) };
  }
}

// ── message-send command ──────────────────────────────────────────────
cli({
  site: 'linkedin',
  name: 'message-send',
  access: 'write',
  description: 'Send a LinkedIn message via API (fast, no browser automation)',
  domain: LINKEDIN_DOMAIN,
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    { name: 'thread-id', type: 'string', required: true, help: 'Thread ID (e.g. 2-NWZk... or full thread URL)' },
    { name: 'message', type: 'string', required: true, help: 'Message text to send' },
  ],
  columns: ['ok', 'status', 'messageUrn', 'error'],
  func: async (page, kwargs) => {
    let threadId = normalizeWhitespace(kwargs['thread-id'] || '');
    const message = kwargs.message || '';

    if (!threadId) throw new ArgumentError('--thread-id is required');
    if (!message) throw new ArgumentError('--message is required');

    // Support full thread URL as input
    const urlMatch = threadId.match(/\/messaging\/thread\/([^/]+)\/?/);
    if (urlMatch) threadId = urlMatch[1];

    await page.goto(MESSAGING_URL);
    await page.wait(5);
    await assertLinkedInAuthenticated(page, 'linkedin message-send');
    await requireLinkedInCookie(page, 'linkedin message-send');

    const apiConfig = await discoverApiConfig(page);
    if (!apiConfig.csrf) throw new CommandExecutionError('Could not discover CSRF token. Is the LinkedIn session active?');
    if (!apiConfig.mailboxUrn) throw new CommandExecutionError('Could not discover mailbox URN. Try refreshing the messaging page.');

    const result = await sendMessageViaApi(page, threadId, message, apiConfig);
    return [result];
  },
});

// ── message-listen command ────────────────────────────────────────────
cli({
  site: 'linkedin',
  name: 'message-listen',
  access: 'read',
  description: 'Listen for realtime LinkedIn messaging events (messages, typing, read receipts, presence) via network capture',
  domain: LINKEDIN_DOMAIN,
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    { name: 'duration', type: 'int', default: DEFAULT_DURATION, help: `Listen duration in seconds (${MIN_DURATION}-${MAX_DURATION}, 0 = wait until a message arrives)` },
    { name: 'timeout', type: 'int', default: DEFAULT_TIMEOUT, help: 'Maximum runtime in seconds (0 = no timeout, run forever)' },
    { name: 'thread', type: 'string', help: 'Filter events to a specific thread ID' },
    { name: 'type', type: 'string', default: 'all', help: 'Event type filter: message, typing, seen, presence, or all', choices: ['message', 'typing', 'seen', 'presence', 'all'] },
    { name: 'include-self', type: 'bool', default: false, help: 'Include messages sent by you (excluded by default)' },
    { name: 'stream', type: 'bool', default: false, help: 'Stream events as JSONL (one JSON object per line) instead of batch output' },
  ],
  columns: ['event_type', 'thread_id', 'sender_urn', 'body', 'message_urn', 'timestamp', 'raw'],
  func: async (page, kwargs) => {
    const duration = parseDuration(kwargs.duration);
    const threadFilter = normalizeWhitespace(kwargs.thread || '');
    const typeFilter = normalizeWhitespace(kwargs.type || 'all').toLowerCase();
    const includeSelf = Boolean(kwargs['include-self']);
    const streaming = Boolean(kwargs.stream);

    // 0. Self-heal: clear any leftover tab network emulation (a prior forced
    // reconnect could have left the tab offline, which would hang goto). Tab-only
    // + best-effort; CDP travels over the debugger so this works even offline.
    if (page.addBinding) {
      try { await page.addBinding('__oc_ensure_online'); } catch {}
    }

    // 1. Navigate to messaging
    await page.goto(MESSAGING_URL);
    await page.wait(8);
    await assertLinkedInAuthenticated(page, 'linkedin message-listen');
    await requireLinkedInCookie(page, 'linkedin message-listen');

    // Detect the logged-in user's profile URN to filter out self-sent messages
    let selfUrn = '';
    if (!includeSelf) {
      try {
        const selfResult = unwrapEvaluateResult(await page.evaluate(String.raw`(() => {
          try {
            const meta = document.querySelector('meta[name="userId"]');
            if (meta) return 'urn:li:fsd_profile:' + meta.content;
            const urls = performance.getEntriesByType('resource').map(e => e.name);
            for (const u of urls) {
              const m = u.match(/fsd_profile(?:%3A|:)(ACoAA[^,)&%]+)/);
              if (m) return 'urn:li:fsd_profile:' + decodeURIComponent(m[1]);
            }
            return '';
          } catch { return ''; }
        })()`));
        selfUrn = normalizeWhitespace(selfResult || '');
      } catch {}
    }

    // 2. Start CDP network capture
    if (page.startNetworkCapture) {
      const started = await page.startNetworkCapture(CAPTURE_PATTERN);
      if (!started) throw new CommandExecutionError('Failed to start network capture.');
    } else {
      throw new CommandExecutionError('Network capture not available.');
    }

    // 2b. RECON: reload the page AFTER capture is armed so the long-lived
    // realtime subscription connection re-opens under CDP and we can see it.
    if (process.env.OC_LISTEN_RECON_RELOAD === '1') {
      process.stderr.write('[message-listen] RECON: reloading page under capture to catch realtime subscription\n');
      await page.goto(MESSAGING_URL);
      await page.wait(8);
    }

    // 3. Discover API config (CSRF token, query IDs) from the page's own requests
    const apiConfig = await discoverApiConfig(page);
    if (process.env.OC_LISTEN_DEBUG === '1') {
      process.stderr.write(`[cfgdbg] csrf=${!!apiConfig.csrf} mailbox=${!!apiConfig.mailboxUrn} convFullUrl.len=${(apiConfig.convFullUrl||'').length} convHead=${(apiConfig.convFullUrl||'').slice(0,90)}\n`);
    }

    // 4. Inject realtime data interceptor (ReadableStream + fetch patching)
    try { unwrapEvaluateResult(await page.evaluate(REALTIME_INTERCEPTOR_SCRIPT)); } catch {}

    // 5. Drain initial page-load captures so we only process new events
    if (page.readNetworkCapture) { await page.readNetworkCapture(); }
    await new Promise((r) => setTimeout(r, 5000));
    if (page.readNetworkCapture) { await page.readNetworkCapture(); }
    try { unwrapEvaluateResult(await page.evaluate('(() => { window.__opencli_rt = []; window.__opencli_lp_queue = []; window.__opencli_lp_resolver = null; return 1; })()')); } catch {}
    const listenStartMs = Date.now();

    // 6. Event loop — push-based (preferred) or poll-based (fallback)
    const indefinite = duration === 0;
    const events = [];
    let eventCount = 0;
    const seenUrns = new Set();
    const endTime = indefinite ? Infinity : Date.now() + duration * 1000;
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    // Match self by member profile id, not raw URN — the sender can arrive as a
    // messagingParticipant URN that wraps the same fsd_profile id, so a raw ===
    // misses it and self-sent messages leak through (feedback loop in a
    // reply-bot). See extractProfileId().
    const selfProfileId = extractProfileId(selfUrn);
    const passesFilters = (msg) => {
      if (!includeSelf && selfProfileId && extractProfileId(msg.sender_urn) === selfProfileId) return false;
      if (threadFilter && msg.thread_id !== threadFilter) return false;
      if (typeFilter !== 'all' && msg.event_type !== typeFilter) return false;
      return true;
    };

    // Message ids we've already surfaced (via the fast path or a fetch), so the
    // ACK path never fetches a body we've already emitted. Keyed by the short
    // `2-...` message id shared between the ACK urn and the message backendUrn.
    const emittedMsgIds = new Set();

    // Latency measurement (OC_LISTEN_MEASURE=1): local time we captured the
    // delivery ACK for each message id, so we can report skew-free ack→emit
    // latency alongside the server-timestamp end-to-end.
    const MEASURE = process.env.OC_LISTEN_MEASURE === '1';
    const ackAtByMsgId = new Map();

    const addEvent = (msg) => {
      const urn = msg.message_urn || '';
      const mid = msg.event_type === 'message' ? extractMessageId(urn) : '';
      if (mid) emittedMsgIds.add(mid);
      if (urn && seenUrns.has(urn)) return false;
      if (urn) seenUrns.add(urn);
      if (!passesFilters(msg)) return false;
      if (MEASURE && msg.event_type === 'message') {
        const now = Date.now();
        const delivered = Date.parse(msg.timestamp) || 0;
        const ackAt = mid ? (ackAtByMsgId.get(mid) || 0) : 0;
        msg._detected_at = now;
        if (delivered) { msg._delivered_at = delivered; msg._lat_delivered_to_emit_ms = now - delivered; }
        if (ackAt) { msg._ack_at = ackAt; msg._lat_ack_to_emit_ms = now - ackAt; }
        if (ackAt && delivered) msg._lat_delivered_to_ack_ms = ackAt - delivered;
      }
      if (streaming) {
        console.log(JSON.stringify(msg));
        eventCount++;
        return true;
      }
      events.push(msg);
      return true;
    };

    // In stream mode, read stdin for send commands: {"action":"send","thread_id":"...","message":"..."}
    const stdinQueue = [];
    let stdinReader = null;
    if (streaming && process.stdin.isTTY === undefined) {
      try {
        const rl = createInterface({ input: process.stdin, terminal: false });
        rl.on('line', (line) => {
          try {
            const cmd = JSON.parse(line);
            if (cmd && cmd.action === 'send' && cmd.message) stdinQueue.push(cmd);
          } catch {}
        });
        rl.on('close', () => {});
        stdinReader = rl;
      } catch {}
    }

    // Robust alternative to stdin: poll an append-only file for send commands.
    // Avoids FIFO/holder-process fragility. Set OC_LISTEN_SENDFILE=<path>; append
    // one JSON send command per line and it's picked up within ~200ms.
    const sendFile = process.env.OC_LISTEN_SENDFILE || '';
    if (streaming && sendFile) {
      try {
        const fs = await import('node:fs');
        let processedLines = 0;
        try { processedLines = fs.existsSync(sendFile) ? fs.readFileSync(sendFile, 'utf8').split('\n').filter(Boolean).length : 0; } catch {}
        setInterval(() => {
          try {
            if (!fs.existsSync(sendFile)) return;
            const lines = fs.readFileSync(sendFile, 'utf8').split('\n').filter(Boolean);
            for (let i = processedLines; i < lines.length; i++) {
              try { const cmd = JSON.parse(lines[i]); if (cmd && cmd.action === 'send' && cmd.message) stdinQueue.push(cmd); } catch {}
            }
            processedLines = lines.length;
          } catch {}
        }, 200);
      } catch {}
    }

    const DEBUG_LATENCY = process.env.OC_LISTEN_DEBUG === '1';
    // Helper: process network capture entries (used by both push and poll paths)
    const processCaptures = async (captures) => {
      for (const entry of (Array.isArray(captures) ? captures : [])) {
        if (entry.timestamp && entry.timestamp < listenStartMs) continue;
        if (entry.url && /[?&]_oc=1/.test(entry.url)) continue;

        // (1) Opportunistic fast path (zero fetch): LinkedIn's OWN messaging
        // response — its `messengerMessages` fetch (fired on resync) OR a
        // `/realtime/connect` SSE DecoratedEvent — carries the full message
        // inline. When present, this emits at ~300ms. Deduped against the ACK
        // fetch below so a message is never emitted twice.
        if (entry.responsePreview && /messengerMessages|messengerConversations|voyagerMessagingGraphQL|realtime\/connect/i.test(entry.url || '')) {
          const own = parseLinkedInOwnMessages(entry.responsePreview, listenStartMs);
          if (DEBUG_LATENCY && typeof entry.responsePreview === 'string' && entry.responsePreview.indexOf('com.linkedin.messenger.Message') !== -1) {
            const all = parseLinkedInOwnMessages(entry.responsePreview, 0);
            process.stderr.write(`[synced] ${(entry.method||'net')} ${(entry.url||'').slice(0,42)} hasMsg parsed_since=${own.length} parsed_all=${all.length}` + (all.length ? ` bodies=${JSON.stringify(all.map((a)=>({b:(a.body||'').slice(0,18),d:Date.parse(a.timestamp)||0,t:(a.thread_id||'').slice(0,10)})))}` : '') + ` listenStart=${listenStartMs}\n`);
          }
          if (own.length) {
            let emittedAny = false;
            for (const evt of own) { if (addEvent(evt)) emittedAny = true; }
            if (DEBUG_LATENCY && emittedAny) process.stderr.write(`[lat] fast-path: emitted from LinkedIn's own ${(entry.method||'net')} ${(entry.url||'').slice(0,50)}\n`);
            if (emittedAny) continue;
          }
        }

        // (2) Realtime frames (typing/seen/presence, and any message the generic
        // parser can surface directly).
        const parsed = parseNetworkCaptureEntry(entry);
        if (parsed && parsed.length) {
          let emittedAny = false;
          for (const evt of parsed) {
            if (evt.timestamp && new Date(evt.timestamp).getTime() < listenStartMs) continue;
            if (evt.event_type === 'message' && !evt.body) continue;
            if (addEvent(evt)) emittedAny = true;
          }
          if (emittedAny) continue;
        }

        // (3) Delivery ACK — always fires, carries only the message id (no body).
        // This is the reliable trigger: fetch the body immediately. If the fast
        // path above already emitted this message, addEvent() dedupes it away.
        if (entry.url && /deliveryAcknowledgement/i.test(entry.url)) {
          const ackUrns = extractMessageUrnsFromAck(entry);
          if (MEASURE) {
            const ackNow = Date.now();
            for (const u of ackUrns) { const mid = extractMessageId(u); if (mid && !ackAtByMsgId.has(mid)) ackAtByMsgId.set(mid, ackNow); }
          }
          const fresh = ackUrns.filter((u) => { const mid = extractMessageId(u); return mid && !emittedMsgIds.has(mid); });
          if (fresh.length === 0) continue;
          const t0 = Date.now();
          const msg = await fetchLatestIncomingMessage(page, fresh, apiConfig);
          if (DEBUG_LATENCY) process.stderr.write(`[lat] ack→fetch: ${Date.now() - t0}ms\n`);
          if (msg) addEvent(msg);
          continue;
        }
      }
    };

    // Try push-based pipeline: extension pushes CDP-captured network entries
    // instantly via SSE. This uses the SAME reliable source as the poll loop
    // (CDP Network.* events), so it catches LinkedIn's delivery ACKs that a
    // page-JS fetch interceptor would miss — just delivered with ~0 latency.
    const NET_PUSH_BINDING = '__oc_netcapture_push';
    let pushActive = false;
    let pushUnsub = null;

    // Recon mode: dump every pushed entry's full detail to a file for offline
    // frame-format analysis (transport, content-type, content-encoding, body).
    const RECON_FILE = process.env.OC_LISTEN_RECON || '';
    let reconWrite = null;
    if (RECON_FILE) {
      const fs = await import('node:fs');
      reconWrite = (obj) => { try { fs.appendFileSync(RECON_FILE, JSON.stringify(obj) + '\n'); } catch {} };
      process.stderr.write(`[message-listen] RECON mode → ${RECON_FILE}\n`);
    }

    if (page.addBinding && page.onPushEvent) {
      try {
        // Subscribe to SSE BEFORE enabling push so we don't miss events.
        pushUnsub = page.onPushEvent(NET_PUSH_BINDING, async (payload) => {
          try {
            const entry = JSON.parse(payload);
            if (reconWrite) {
              const h = entry.responseHeaders || {};
              const hget = (k) => { for (const kk of Object.keys(h)) { if (kk.toLowerCase() === k) return h[kk]; } return ''; };
              const rp = typeof entry.responsePreview === 'string' ? entry.responsePreview : '';
              reconWrite({
                t: Date.now(),
                method: entry.method || '',
                url: entry.url || '',
                status: entry.responseStatus || '',
                contentType: entry.responseContentType || hget('content-type'),
                contentEncoding: hget('content-encoding'),
                transferEncoding: hget('transfer-encoding'),
                reqBodyLen: (entry.requestBodyPreview || '').length,
                reqBody: (entry.requestBodyPreview || '').slice(0, 1200),
                respLen: rp.length,
                respFullSize: entry.responseBodyFullSize || 0,
                looksJson: /^\s*[[{]/.test(rp) || /"\$type"|messagingMessage|com\.linkedin\.messenger/.test(rp),
                resp: rp.slice(0, 220000),
              });
            }
            if (DEBUG_LATENCY) {
              const rp = typeof entry.responsePreview === 'string' ? entry.responsePreview : '';
              process.stderr.write(`[push] ${entry.method || '?'} ${(entry.url||'').slice(0,70)} req=${(entry.requestBodyPreview||'').length}b resp=${rp.length}b :: ${rp.slice(0,160).replace(/\n/g,' ')}\n`);
            }
            await processCaptures([entry]);
          } catch {}
        });

        await page.addBinding(NET_PUSH_BINDING);
        pushActive = true;
        process.stderr.write('[message-listen] push pipeline: ACTIVE (CDP network capture → SSE)\n');

        // Fast-path mode (opt-in): force one realtime reconnect at startup. This
        // flips LinkedIn's client into sync-fetch mode (each incoming message
        // triggers a small messengerMessages fetch we read directly) AND brings
        // /realtime/connect under CDP capture — both feed the zero-fetch fast
        // path. The ACK→fetch fallback still guarantees delivery regardless.
        if (process.env.OC_LISTEN_REALTIME === '1' && !RECON_FILE) {
          try {
            const rr = await page.addBinding('__oc_force_reconnect');
            process.stderr.write(`[message-listen] realtime fast-path: forced reconnect (${rr && rr.toggledTargets} targets)\n`);
          } catch (e) { process.stderr.write(`[message-listen] realtime fast-path setup failed: ${e}\n`); }
        }

        // RECON (dev only): enumerate targets + force the realtime connection to
        // reconnect under capture, used to reverse-engineer the transport. Gated
        // behind OC_LISTEN_RECON; never runs in normal operation.
        if (RECON_FILE) {
          try {
            const tgt = await page.addBinding('__oc_recon_targets');
            const targets = (tgt && tgt.targets) || [];
            process.stderr.write(`[recon] targets (${targets.length})\n`);
            if (reconWrite) reconWrite({ t: Date.now(), _targets: targets });
          } catch (e) { process.stderr.write(`[recon] target enum failed: ${e}\n`); }
          if (process.env.OC_LISTEN_FORCE_RECONNECT === '1') {
            try {
              const rr = await page.addBinding('__oc_force_reconnect');
              process.stderr.write(`[recon] reconnect toggled ${rr && rr.toggledTargets} targets\n`);
            } catch (e) { process.stderr.write(`[recon] force reconnect failed: ${e}\n`); }
          }
        }
      } catch (e) {
        pushActive = false;
        process.stderr.write(`[message-listen] push pipeline setup failed: ${String(e)} → poll fallback\n`);
      }
    } else {
      process.stderr.write(`[message-listen] push pipeline: unavailable (addBinding=${!!page.addBinding} onPushEvent=${!!page.onPushEvent}) → poll fallback\n`);
    }

    if (pushActive) {
      // Push mode: message events arrive instantly via the SSE callback. This
      // loop keeps stdin sends + the ACK fallback responsive (200ms) and runs a
      // periodic network-capture drain (~5s) as a backstop for anything missed.
      const SAFETY_DRAIN_MS = 5000;
      let lastDrain = Date.now();
      while (Date.now() < endTime) {
        while (stdinQueue.length > 0) {
          const cmd = stdinQueue.shift();
          const tid = cmd.thread_id || threadFilter || '';
          if (!tid || !cmd.message) {
            console.log(JSON.stringify({ event_type: 'send_error', error: 'missing thread_id or message' }));
            continue;
          }
          const result = await sendMessageViaApi(page, tid, cmd.message, apiConfig);
          console.log(JSON.stringify({ event_type: 'send_result', thread_id: tid, ...result }));
        }

        await sleep(200);

        if (Date.now() - lastDrain >= SAFETY_DRAIN_MS) {
          lastDrain = Date.now();
          try {
            const captures = page.readNetworkCapture ? await page.readNetworkCapture() : [];
            await processCaptures(captures);
          } catch {}
        }

        if (!streaming && indefinite && events.length > 0) break;
      }

      // Cleanup
      if (pushUnsub) pushUnsub();
      try { if (page.removeBinding) await page.removeBinding(NET_PUSH_BINDING); } catch {}
    } else {
      // Fallback: poll mode (original behavior)
      while (Date.now() < endTime) {
        while (stdinQueue.length > 0) {
          const cmd = stdinQueue.shift();
          const tid = cmd.thread_id || threadFilter || '';
          if (!tid || !cmd.message) {
            console.log(JSON.stringify({ event_type: 'send_error', error: 'missing thread_id or message' }));
            continue;
          }
          const result = await sendMessageViaApi(page, tid, cmd.message, apiConfig);
          console.log(JSON.stringify({ event_type: 'send_result', thread_id: tid, ...result }));
        }

        await sleep(POLL_INTERVAL_MS);

        let captures;
        try {
          captures = page.readNetworkCapture ? await page.readNetworkCapture() : [];
        } catch { captures = []; }

        await processCaptures(captures);

        if (!streaming && indefinite && events.length > 0) break;
      }
    }

    return streaming ? null : events;
  },
});

export const __test__ = {
  parseLinkedInRealtimeFrame,
  parseNetworkCaptureEntry,
  parseDuration,
  extractCandidates,
  extractThreadId,
  extractSenderUrn,
  extractBody,
  extractTimestamp,
  sendMessageViaApi,
  extractMessageId,
  reconstructThreadIdFromMessageUrn,
  findMessageObjects,
  parseLinkedInOwnMessages,
  extractProfileId,
};
