# LinkedIn Messaging Realtime — Internals, Reverse-Engineering, and Implementation

> **What this is.** A complete, evidence-backed map of how LinkedIn delivers
> messages in real time to a logged-in web session, how we reverse-engineered it
> through Chrome DevTools Protocol (CDP), and how `linkedin message-listen`
> detects incoming messages. Every format below was captured live from a real
> session (profiles: Archit `6mvwk8eh` ← receives, Maya `afcne57r` → sends).
>
> This is reference-grade context. If LinkedIn changes their internals, the
> *methodology* section is how you re-derive the new reality.

---

## 0. TL;DR

- LinkedIn's web client receives new messages over a **long-lived Server-Sent
  Events (SSE) stream**: `GET https://www.linkedin.com/realtime/connect?rc=1`.
  Each event is a `com.linkedin.realtimefrontend.DecoratedEvent` envelope.
- That connection lives **in the main page** (not a SharedWorker, not a
  WebSocket), and is **established at page load — before** any automation network
  capture is armed, so its in-flight bytes are normally invisible.
- When a message arrives, the client also fires
  `POST /voyager/api/voyagerMessagingDashMessengerMessageDeliveryAcknowledgements`
  — the **delivery ACK**. It contains the message **URN only, no body**. This is
  the single signal we can capture 100% reliably.
- To render the body, the client reads it straight from the SSE push. It does
  **not** re-fetch in steady state. (It *does* fetch `messengerMessages` right
  after a reconnect/resync — which is a capturable but non-steady-state event.)
- **Consequence for us:** the reliable detection path is
  `capture ACK → fetch the body ourselves` (~1.2–1.4 s, RTT-bound). A true
  zero-fetch read of the SSE push is *possible* (we proved the format and
  captured live events) but **not reliable** because `/realtime/connect` cycles
  connections and CDP's streaming read is uneven. We ship the reliable path plus
  an opportunistic fast-path that emits from the SSE/own-fetch when we do catch
  it (deduped, never worse).
- **Two-way engagement loop works end-to-end** (§6): human sends from one profile,
  agent detects on the other and replies in-voice via the same tab. Measured live:
  **~2.0 s detect, ~1.2 s reply, per round.** Most of the effort was environment
  wrangling, not the feature — see §7 for the traps (kill patterns, daemon death,
  a tab stranded offline by the reverse-engineering toggles) so you can skip them.

---

## 1. LinkedIn's realtime + messaging architecture

### 1.1 The endpoints (all under `https://www.linkedin.com`)

| Endpoint | Method | Role | Body carries the message? |
|---|---|---|---|
| `/realtime/connect?rc=1` | GET (SSE, `text/event-stream`, gzip) | **The realtime push channel.** Long-lived; streams `DecoratedEvent`s for every subscribed topic. | **YES** — `messagesTopic` events carry the full message |
| `/realtime/realtimeFrontendSubscriptions?ids=List(...)` | GET/PUT | Registers which topics this client connection subscribes to | no |
| `/realtime/realtimeFrontendClientConnectivityTracking?action=sendHeartbeat` | POST | Heartbeat that monitors the realtime connection's health | no |
| `/voyager/api/voyagerMessagingDashMessengerMessageDeliveryAcknowledgements` | POST | **Delivery ACK** — client tells the server "I received these message URNs via REALTIME" | no — URNs only |
| `/voyager/api/voyagerMessagingGraphQL/graphql?queryId=messengerMessages.<hash>` | GET (gzip, `application/vnd.linkedin.normalized+json`) | Fetch messages for a thread. Fired by the client on **thread open / resync**, not per-message in steady state | **YES** |
| `/voyager/api/voyagerMessagingGraphQL/graphql?queryId=messengerConversations.<hash>` | GET | Fetch the conversation list (inbox). What *our* fallback fetch calls. | YES (last message per convo) |
| `/voyager/api/voyagerMessagingDashMessengerMessages?action=createMessage` | POST | **Send** a message (used by `linkedin message-send`) | — |

### 1.2 The message-delivery flow (steady state)

```
Maya sends ──▶ LinkedIn server
                    │
                    ├─(a) pushes a DecoratedEvent down Archit's open
                    │      /realtime/connect SSE stream  ── contains the FULL message
                    │
      Archit tab ◀──┘
        │
        ├─(b) client renders the message straight from the SSE payload (no fetch)
        │
        └─(c) client POSTs a delivery ACK  ── "got urn:li:msg_message:(...,2-XXX) via REALTIME"
```

Key facts we proved by capture:
- **(a) is the only place the body appears** in steady state.
- **(b)** means there is **no follow-up fetch** to piggyback on in steady state.
- **(c)** is the reliable, always-present signal — but body-less.

After a **reconnect/resync**, the client instead pulls
`messengerMessages` (small, ~20 KB) to reconcile — that response *does* carry the
body, which is why forcing a reconnect briefly surfaces a capturable fetch.

### 1.3 The realtime envelope: `DecoratedEvent`

Each SSE frame on `/realtime/connect` is one line: `data: {json}\n`. The JSON:

```json
{"com.linkedin.realtimefrontend.DecoratedEvent":{
  "topic":"urn:li-realtime:messagesTopic:urn:li-realtime:myself",
  "publisherTrackingId":"ByteString(length=16,bytes=...)",
  "leftServerAt":1783018287473,
  "id":"ae796989-9254-45a4-9d0a-73c87a46165d",
  "payload":{ /* topic-specific; for messagesTopic → a messenger.Message */ }
}}
```

Topics observed (from the ClientConnection handshake `personalTopics` list):
`conversationsTopic`, `messagesTopic`, `messageSeenReceiptsTopic`,
`replySuggestionTopicV2`, `typingIndicatorsTopic`, `tabBadgeUpdateTopic`,
`messageReactionSummariesTopic`, `messagingDataSyncTopic`, … The first frame on a
fresh connection is the handshake:
`data: {"com.linkedin.realtimefrontend.ClientConnection":{"personalTopics":[...]}}`.

> We captured a live `replySuggestionTopicV2` DecoratedEvent (quick-reply
> suggestions generated for an incoming message). The `messagesTopic` event uses
> the identical envelope with a `com.linkedin.messenger.Message` in the payload.

### 1.4 The message object — two shapes

LinkedIn serializes the *same* `com.linkedin.messenger.Message` two ways
depending on the endpoint:

**Decorated** (`_type`, everything inlined — used by realtime & `messengerMessages`):
```json
{
  "_type":"com.linkedin.messenger.Message",
  "body":{"_type":"com.linkedin.pemberly.text.AttributedText","text":"the message text"},
  "backendUrn":"urn:li:messagingMessage:2-<base64>",
  "deliveredAt":1783015934053,
  "actor":{
    "_type":"com.linkedin.messenger.MessagingParticipant",
    "hostIdentityUrn":"urn:li:fsd_profile:ACoAAGn0Vs8B...",   // <- sender profile
    "entityUrn":"urn:li:msg_messagingParticipant:urn:li:fsd_profile:ACoAAGn0Vs8B...",
    "participantType":{"member":{"firstName":{"text":"Maya"},"lastName":{"text":"Solanki"}}}
  }
}
```

**Normalized** (`$type`, `included[]` array, `*actor` URN references — used by
`messengerConversations`, `accept: application/vnd.linkedin.normalized+json+2.1`):
the message has `*actor` pointing into an `included[]` entity you must resolve via
a `entityUrn → object` map.

Our parser handles both: the decorated shape needs **no** resolution (sender is
inline at `actor.hostIdentityUrn`); the normalized shape resolves `*actor`.

### 1.5 URN formats (and the thread-id encoding trick)

| URN | Example | Notes |
|---|---|---|
| Message (ACK form) | `urn:li:msg_message:(urn:li:fsd_profile:ACoAAC4I9rMB,2-MTc4…==)` | profile + short id |
| Message (backendUrn) | `urn:li:messagingMessage:2-MTc4…==` | the `2-…` short id |
| Sender profile | `urn:li:fsd_profile:ACoAAGn0Vs8B…` | what we filter "self" on |
| Thread | `2-NWZkMDkzNDYt…==` | passed to `--thread` |

**The short id `2-<base64>` embeds the thread.** Decode it:

```
"2-MTc4MzAxNTkzNDA1M2IyMzMyMy0xMDAmNWZkMDkzNDYtNDUxNC00ZGJiLWE5NDMtMzlhYzBjOGEyMjFkXzEwMA=="
   └─ base64-decode the part after "2-" ─▶
"1783015934053b23323-100&5fd09346-4514-4dbb-a943-39ac0c8a221d_100"
                              └─ thread guid after the final '&' ─┘
   └─ re-base64 that tail, prepend "2-" ─▶
"2-NWZkMDkzNDYtNDUxNC00ZGJiLWE5NDMtMzlhYzBjOGEyMjFkXzEwMA=="   ✓ the thread id
```

This is how `reconstructThreadIdFromMessageUrn()` derives `thread_id` from a
decorated message that has no inline `conversationUrn`.

### 1.6 Required headers to talk to the messaging API (used by our fallback + send)

- `Csrf-Token: <JSESSIONID cookie value>` (raw, no `ajax:` double-prefix)
- `x-restli-protocol-version: 2.0.0`
- Read: `accept: application/vnd.linkedin.normalized+json+2.1`
- Send: `X-LI-Track: {clientVersion,mpName:"voyager-web",…}` + `X-LI-Lang: en_US`

---

## 2. How we reverse-engineered it (methodology)

The whole investigation was: **make an invisible transport visible, one layer at
a time, using CDP** — then read the bytes and diff against a known marker message
(`RECON-MARKER-<n>-<epoch>`) sent from the other account.

### Layer 1 — CDP network capture (the baseline)
`Network.enable` + `Network.requestWillBeSent/responseReceived/loadingFinished`
buffers request/response bodies. This catches ordinary requests but **misses
long-lived streams** (`loadingFinished` never fires) and **anything opened before
capture armed**. Finding: we saw the delivery ACK and our own fetches, never the
realtime channel.

### Layer 2 — reading in-flight streams (`Network.streamResourceContent`)
`getResponseBody` fails on an in-progress request. `Network.streamResourceContent`
(Chrome ≥124) returns the buffered bytes so far and (nominally) makes subsequent
`dataReceived` carry inline `data`. **This is what turned unreadable
`STREAM_SIGNAL`s into real bytes.** Finding: LinkedIn's messaging streams are
`content-encoding: gzip` on the wire but CDP hands back **decompressed JSON** —
compression is a non-issue.

### Layer 3 — finding the SharedWorker (`chrome.debugger.getTargets`)
We suspected a SharedWorker. CDP `Target.getTargets` (tab-scoped) returned **0**
workers — because SharedWorkers are **browser-level** targets. The extension API
`chrome.debugger.getTargets()` sees them all (72 targets across the browser).
Finding: there was **no LinkedIn SharedWorker** — realtime is in the **main
page**. (This ruled out a whole class of complexity.)

### Layer 4 — WebSocket frames (`Network.webSocketFrameReceived`)
Added handling for `webSocketCreated` / `webSocketFrameReceived`. Finding:
**zero** WS frames — LinkedIn realtime is **not** a WebSocket. (WS would actually
have been *easier* — live frames fire even on a pre-existing socket once Network
is enabled.)

### Layer 5 — capturing a pre-established connection (forced reconnect)
The realtime connection opened at page load, before capture, so we never saw its
`requestWillBeSent` and couldn't arm streaming on it. Fix: **force it to
reconnect under capture** via `Network.emulateNetworkConditions {offline:true}`
then `{offline:false}` on the tab (and any workers). Finding: this finally
surfaced `GET /realtime/connect?rc=1` and its handshake — **the realtime channel,
made visible.**

### Layer 6 — reading the SSE deltas (re-poll)
Even armed, `/realtime/connect`'s per-event `dataReceived` didn't reliably carry
inline data. Fix: **re-poll `streamResourceContent` on each `dataReceived`** — it
returns the whole buffer, so we diff against a consumed-length watermark and emit
the delta. Finding: this captured a **live `DecoratedEvent`** off the stream —
proving the format and that the body *is* readable there — but coverage was
**spotty (~1 event per 4 messages)** because the connection cycles and CDP
`dataReceived` timing is uneven.

### The marker technique
Every run sent `RECON-MARKER-<n>-<ts>` from Maya and searched each captured body
for it, classifying `_oc=1` (our own fetches) vs genuine LinkedIn traffic. This
is what let us definitively say *"the body appears HERE and only here."*

---

## 3. The OpenCLI implementation

### 3.1 Push pipeline (built to kill polling latency)
Page/CDP event → extension → daemon → CLI, with **zero polling**:

```
CDP Network.* (extension/src/cdp.ts)
  └─ maybePushNetworkEntry() ─▶ background.ts safeSend({type:'push-event'})
       └─ daemon.ts WS handler ─▶ SSE forward to subscribers (per contextId)
            └─ daemon-client.ts subscribeToPushEvents() (fetch SSE stream)
                 └─ page.ts onPushEvent() ─▶ message-listen callback
```
Enabled by `page.addBinding('__oc_netcapture_push')`; the extension then pushes
every messaging/realtime network entry to the CLI the instant CDP sees it.

New CDP capabilities added to the extension (all reusable, gated on an active
push listener):
- `Network.streamResourceContent` arming + **re-poll delta extraction** for
  long-lived streams (`STREAM_BUFFERED` / `STREAM_CHUNK` entries).
- `Network.webSocket*` frame capture (`WS_CREATED` / `WS_RECV` / `WS_SENT`).
- `chrome.debugger.getTargets()`-based SharedWorker discovery + attach.
- `enumerateTargets()` and `forceRealtimeReconnect()` (reserved binding names
  `__oc_recon_targets` / `__oc_force_reconnect`), used for diagnostics.

### 3.2 Detection logic (`clis/linkedin/message-listen.js`)
Per captured entry, in order:
1. **Fast path (opportunistic, zero-fetch):** if the entry is a
   `messengerMessages` / `messengerConversations` / `realtime/connect` body,
   `parseLinkedInOwnMessages()` extracts the message inline and emits it
   (deduped). Fires when we happen to capture LinkedIn's own fetch or an SSE
   event. ~300 ms when it hits.
2. **Realtime frames:** `parseNetworkCaptureEntry()` for typing/seen/presence.
3. **Delivery ACK (reliable trigger):** extract the message id, and if not
   already emitted, **fetch the body ourselves** (`fetchLatestIncomingMessage`)
   and emit (deduped). ~1.2–1.4 s. This guarantees delivery.

Dedup is by `message_urn` and by the short `2-…` id, so the fast path and the ACK
fetch never double-emit.

### 3.3 The parser (`parseLinkedInOwnMessages`)
- Collects JSON roots: the whole body **plus** each SSE `data: {…}` frame.
- `findMessageObjects()` walks for `_type`/`$type === com.linkedin.messenger.Message`.
- Extracts `body.text`, `actor.hostIdentityUrn` (sender), `backendUrn`,
  `deliveredAt`; reconstructs `thread_id` from the message URN (§1.5).
- Filters by `sinceMs` (listen start) so history never leaks; skips body-less
  reference envelopes (e.g. reply-suggestion).

Unit-tested against the **real captured structures** in `message-listen.test.js`.

---

## 4. Latency & reliability findings

| Path | Latency | Reliability |
|---|---|---|
| Old poll loop | ~2–3 s | 100% (but slow — polling wait dominated) |
| **Push + ACK→fetch (shipped default)** | **~1.2–1.4 s** | **100%** |
| Zero-fetch fast path (SSE / own-fetch) | ~300 ms | **opportunistic (~1 in 4)** |

Where the ~1 s in the ACK→fetch path goes: it's the **round-trip to fetch the
body** — CLI → daemon → extension → CDP `Runtime.evaluate` → in-page `fetch` to
LinkedIn → back. It's RTT-bound, not payload-bound (dropping the fetch from 162 KB
to a single conversation changed nothing).

**Why reliable zero-fetch isn't achievable today:** in steady state the body
exists *only* in the `/realtime/connect` SSE push, and that connection (a) is
established before capture, (b) cycles connections, and (c) yields uneven CDP
`dataReceived` timing — so we cannot guarantee reading every `messagesTopic`
event. LinkedIn also does not re-fetch the message after the realtime push, so
there is no reliable request to piggyback on.

---

## 5. Future work — making the fast path reliable

To turn the opportunistic ~300 ms path into the default, the realtime SSE read
must become reliable:
1. **Timer-driven re-poll.** Instead of re-polling on `dataReceived`, re-poll
   `streamResourceContent` for every armed `/realtime/connect` on a fixed ~200 ms
   cadence (extension-side interval, kept alive by the active daemon WS). This
   decouples capture from CDP event timing.
2. **Reconnect tracking.** Re-arm streaming on every new `/realtime/connect`
   `requestWillBeSent` (they rotate), and force one reconnect at startup to bring
   the initial connection under capture.
3. **Parse `messagesTopic` envelopes** directly (the parser already finds the
   `Message` inside a `DecoratedEvent`; just needs reliable delivery of the
   frame).
4. Validate zero-fetch output byte-for-byte against the ACK→fetch path across
   emoji / long / multi-line / rapid-fire / cross-thread messages before making
   it the default. Keep ACK→fetch as the ever-present fallback.

Toggle for experimenting today: `OC_LISTEN_REALTIME=1` forces a startup reconnect
and enables the fast path opportunistically. `OC_LISTEN_RECON=<file>` +
`OC_LISTEN_FORCE_RECONNECT=1` reproduce the capture harness used above;
`OC_LISTEN_DEBUG=1` prints the `[lat]` / `[push]` traces.

---

## 6. Two-way engagement loop (detect → reply → measure)

Goal: a human sends from one profile (Maya, the "lead"); the agent listens on the
other (Archit) and replies **in Archit's own voice**, reporting latency per round.
Proven live over multiple rounds: **~2.0 s to detect an inbound message, ~1.2 s to
fire back a reply.**

### 6.1 Same-tab replies (why not just `message-send`)
Listener and replier are the **same profile** (Archit). Running a separate
`linkedin message-send` on that profile fights the listener for the owned
automation tab (page reload + tab-lease conflict). So replies go **through the
listener's own tab** via `sendMessageViaApi` — the fast `createMessage` POST,
< 1 s, no navigation.

### 6.2 Feeding replies to a long-running listener
`message-listen --stream` reads reply commands two ways:
- **stdin** (original): `{"action":"send","thread_id":"…","message":"…"}` per line.
- **`OC_LISTEN_SENDFILE=<path>`** (added this session): the listener polls an
  append-only file every 200 ms for the same JSON commands. This exists because
  the stdin/FIFO approach is fragile to drive from an orchestrator (a FIFO needs a
  live writer holding it open; killing/relaunching leaks holder processes). A
  plain file has none of that — `echo '{...}' >> sendfile` and it's picked up.

Emitted `send_result` line confirms the reply: `{event_type:"send_result", ok,
status:200, messageUrn}`.

### 6.3 Robust body-fetch (decorated vs normalized — a real bug we hit)
The ACK→fetch fallback (`fetchLatestIncomingMessage`) originally only parsed the
**normalized** shape (`data.included[]` with `$type`/`*actor`). Live, LinkedIn
returned the **decorated** shape (`_type`/`_recipeType`, inline `actor`), so
`data.included` was undefined and the fetch returned `null` → nothing emitted,
even though the ACK fired and the 162 KB response *contained* the message. Fix:
the fetch now runs `parseLinkedInOwnMessages(raw)` (handles both shapes) first and
picks the message matching the ACK's `2-…` id, falling back to the legacy
conversations parse. **Lesson: never assume one serialization — LinkedIn ships the
same entity two ways and which one you get isn't stable.**

### 6.4 Latency instrumentation (`OC_LISTEN_MEASURE=1`)
Adds three fields to each emitted message so you can measure without guessing:
- `_ack_at` — local time we captured the delivery ACK (≈ when the tab received
  the realtime push). Recorded in the ACK branch, keyed by the `2-…` id.
- `_detected_at` — local time we emitted (after the body fetch).
- `_delivered_at` — `deliveredAt` from the message (LinkedIn server time).

Derived: `_lat_ack_to_emit_ms` (our detection cost, **skew-free** — both local),
`_lat_delivered_to_emit_ms` (end-to-end, includes realtime delivery + any
client↔server clock skew), `_lat_delivered_to_ack_ms` (realtime delivery speed).

### 6.5 Self-message filtering (the feedback-loop trap)
Archit's *own* replies come back through the realtime stream. They must not be
re-emitted or the agent replies to itself forever. `--include-self` is off by
default, but the built-in self-filter compares `sender_urn === selfUrn` — and it
**misses**, because the sender arrives as a *participant* URN
(`urn:li:msg_messagingParticipant:urn:li:fsd_profile:ACoAA…`) while `selfUrn` is
the bare `urn:li:fsd_profile:ACoAA…`. In the loop we filtered by the embedded
`fsd_profile:` id in orchestration; the proper fix is to match on that contained
id in `passesFilters` (TODO — noted, not yet baked in).

---

## 7. Operational lessons (the hour of pain, so you skip it)

Most of this session's time went to **environment/process management**, not the
feature. The traps, and the rules:

1. **`pkill -f 'main.js'` is a footgun.** The background task runner's own shell
   has `main.js` in its command line, so `pkill -f 'main.js'` kills *the task that
   is running the pkill*, aborting the launch right after. **Only ever kill the
   specific process:** `pkill -9 -f 'linkedin message-listen'`.

2. **Don't `&`-background node inside a background task, and don't `exec`-wrap it
   oddly.** `node … &` inside a wrapper orphans the child when the wrapper exits →
   the listener dies seconds after launch. Run node as the **main foreground
   process** of the background task (plain `node …`, no `&`). (`exec node …` also
   misbehaved here.) A single `node dist/src/main.js` shows as **2 processes**
   (parent + child) — that's one logical listener, not a conflict.

3. **`timeout` doesn't exist on macOS** (it's `gtimeout`). A command starting with
   `timeout …` silently fails with "command not found" and the real command never
   runs — which looked exactly like "my code isn't loading." Use a bash
   `until … do sleep; done` loop instead.

4. **The daemon can die and not respawn.** If `message-listen` hangs at startup
   with **zero** output and `/status` doesn't answer, the micro-daemon is down.
   It normally auto-spawns, but after heavy killing it may not. Start it yourself
   as its own persistent background process: `node dist/src/daemon.js`, wait for
   `/ping`, and for the extension to reconnect (`/status?contextId=<id>` →
   `extensionConnected:true`). Both profiles must show connected.

5. **`Network.emulateNetworkConditions {offline:true}` persists on the tab** until
   restored or the debugger detaches. The realtime reverse-engineering (§2, forced
   reconnect) left the Archit tab **offline**, which then hung every `goto` (a
   navigation needs the network the emulation is blocking) — with no error, just a
   hang. Symptoms: setup never reaches `push pipeline: ACTIVE`, and even the
   body-fetch throws after a fixed retry. Fixes applied:
   - `forceRealtimeReconnect` now restores online in a `finally` (+ retry).
   - New `ensureOnline(tabId)` (tab-only, can't hang on dead workers) + reserved
     binding `__oc_ensure_online`, which `message-listen` calls **before** `goto`
     to self-heal a stranded tab. CDP travels over the debugger, so it works even
     while the tab's network is emulated-offline.
   - Nuclear reset if all else fails: **reload the extension** (detaches the
     debugger → clears all emulation) or close the wedged automation tab.

6. **Foreground works when background doesn't → suspect process/tab lifecycle,
   not code.** The tell that finally cracked it: a foreground run detected in
   ~1.3 s while background runs hung. That isolates the problem to the *launch
   mechanism* (points 1–2), not the adapter. When debugging "is my code even
   loading," add a marker as the **first line of the function** and confirm it
   prints; if `ACTIVE` (deep in the function) prints but the marker doesn't,
   you're looking at output from a *different* (zombie) process on the same log
   file — check `ps` for strays and `lsof` the log.

### Known-good launch recipe (single listener + reply channel + measurement)
```bash
# 1. daemon up (persistent background process), extension reconnected
node dist/src/daemon.js &            # wait for /ping + extensionConnected:true

# 2. exactly one listener, plain node as the background task's main process
pkill -9 -f 'linkedin message-listen'; sleep 2
: > /tmp/eng.jsonl; : > /tmp/eng.err; : > /tmp/eng-send.jsonl
OC_LISTEN_MEASURE=1 OC_LISTEN_SENDFILE=/tmp/eng-send.jsonl \
  node dist/src/main.js --profile <LISTENER> linkedin message-listen \
  --stream --duration 3000 --timeout 0 --type message \
  </dev/null > /tmp/eng.jsonl 2> /tmp/eng.err
# wait for 'push pipeline: ACTIVE' in eng.err

# 3. reply as the listener profile
echo '{"action":"send","thread_id":"<THREAD>","message":"…"}' >> /tmp/eng-send.jsonl
```
