# Testing `linkedin message-listen`

## Prerequisites

### Chrome Profiles

Two Chrome profiles with active LinkedIn sessions are needed for end-to-end testing:

| Role | Profile ID | LinkedIn Account | Purpose |
|------|-----------|-----------------|---------|
| Listener (engagement) | `afcne57r` | Maya Solanki | Runs `message-listen`, receives messages |
| Sender (lead) | `6mvwk8eh` | Archit Sakri | Sends messages via `safe-send` |

### Conversation Thread

Both accounts must share an existing conversation thread:

```
Thread URL: https://www.linkedin.com/messaging/thread/2-NWZkMDkzNDYtNDUxNC00ZGJiLWE5NDMtMzlhYzBjOGEyMjFkXzEwMA==/
Thread ID:  2-NWZkMDkzNDYtNDUxNC00ZGJiLWE5NDMtMzlhYzBjOGEyMjFkXzEwMA==
```

### Expected Names for safe-send

When sending from one profile, `--expected-name` must match how the OTHER person appears in the thread header:

- Sending from `6mvwk8eh` (Archit) -> `--expected-name "Maya Solanki"`
- Sending from `afcne57r` (Maya) -> `--expected-name "Archit Sakri"`

### Build

Always build before testing:

```bash
cd /Users/architsakri/OpenCLI
npm run build
```

---

## Unit Tests

```bash
npm test -- clis/linkedin/message-listen.test.js
```

Covers: adapter registration, args, columns, parseDuration, parseLinkedInRealtimeFrame, parseNetworkCaptureEntry, extractThreadId, extractSenderUrn, extractBody, extractTimestamp.

---

## End-to-End Tests

### Test 1: Basic single message capture (batch mode)

Verifies the core ACK-detect -> API-fetch pipeline works.

```bash
# Terminal 1: start listener (waits for one message then exits)
node dist/src/main.js --profile afcne57r linkedin message-listen --duration 0 -f json

# Terminal 2: send a message (after listener is set up, ~20s)
node dist/src/main.js --profile 6mvwk8eh linkedin safe-send \
  --thread-url "https://www.linkedin.com/messaging/thread/2-NWZkMDkzNDYtNDUxNC00ZGJiLWE5NDMtMzlhYzBjOGEyMjFkXzEwMA==/" \
  --expected-name "Maya Solanki" \
  --message "test message $(date +%s)" --send -f json
```

**Expected**: Terminal 1 outputs a JSON array with one message object containing:
- `event_type: "message"`
- `thread_id: "2-NWZkMDkzNDYt..."`
- `sender_urn: "urn:li:fsd_profile:ACoAAC4I9rMBl782BWL1txUsRjJrdyF_Hubrao8"` (Archit's profile)
- `body: "test message ..."` (exact match)
- `message_urn: "urn:li:messagingMessage:..."` (non-empty)
- `timestamp: "2026-..."` (recent ISO timestamp)

### Test 2: Bidirectional capture

Verifies message-listen works on BOTH profiles (not just one direction).

```bash
# Round 1: Archit sends, Maya captures
node dist/src/main.js --profile afcne57r linkedin message-listen --duration 0 -f json &
sleep 20
node dist/src/main.js --profile 6mvwk8eh linkedin safe-send \
  --thread-url "..." --expected-name "Maya Solanki" \
  --message "bidir test A->M" --send -f json
wait

# Round 2: Maya sends, Archit captures
node dist/src/main.js --profile 6mvwk8eh linkedin message-listen --duration 0 -f json &
sleep 20
node dist/src/main.js --profile afcne57r linkedin safe-send \
  --thread-url "..." --expected-name "Archit Sakri" \
  --message "bidir test M->A" --send -f json
wait
```

**Expected**: Both rounds capture the message with correct sender_urn (different URN for each direction).

### Test 3: Stream mode (JSONL)

Verifies `--stream` emits events as JSONL lines in real-time instead of batch.

```bash
# Terminal 1: start streaming listener
node dist/src/main.js --profile afcne57r linkedin message-listen \
  --stream --duration 0 --include-self

# Terminal 2: send multiple messages with gaps
node dist/src/main.js --profile 6mvwk8eh linkedin safe-send \
  --thread-url "..." --expected-name "Maya Solanki" \
  --message "stream test 1" --send -f json
# wait 10s
node dist/src/main.js --profile 6mvwk8eh linkedin safe-send \
  --thread-url "..." --expected-name "Maya Solanki" \
  --message "stream test 2" --send -f json
# wait 10s
node dist/src/main.js --profile 6mvwk8eh linkedin safe-send \
  --thread-url "..." --expected-name "Maya Solanki" \
  --message "stream test 3" --send -f json
```

**Expected**:
- Terminal 1 shows each message as a separate JSON line immediately upon delivery
- Listener keeps running between messages (does NOT exit after first)
- Each line is valid JSON parseable independently
- Ctrl+C to stop

### Test 4: Self-message filtering

```bash
# Without --include-self: own messages should be filtered out
node dist/src/main.js --profile afcne57r linkedin message-listen --duration 30 -f json &
sleep 20
# Send from SAME profile
node dist/src/main.js --profile afcne57r linkedin safe-send \
  --thread-url "..." --expected-name "Archit Sakri" \
  --message "self test" --send -f json
wait
```

**Expected**: Listener returns `[]` (self-message filtered out).

```bash
# With --include-self: own messages should appear
node dist/src/main.js --profile afcne57r linkedin message-listen --duration 30 --include-self -f json &
sleep 20
node dist/src/main.js --profile afcne57r linkedin safe-send \
  --thread-url "..." --expected-name "Archit Sakri" \
  --message "self test included" --send -f json
wait
```

**Expected**: Listener returns array with the self-sent message.

### Test 5: Multi-message stress test (scripted conversation)

Full 6-round sales conversation between both accounts. Tests sustained capture under load.

```bash
bash clis/linkedin/test-conversation.sh
```

See `test-conversation.sh` for the full script. Pattern per round:
1. Start listener on engagement profile (afcne57r)
2. Send lead message from sender profile (6mvwk8eh)
3. Wait for listener to capture
4. Send engagement reply from afcne57r
5. Verify lead receives reply via message-listen on 6mvwk8eh
6. Repeat

**Expected**: All 6 lead messages captured on engagement side (100% detection rate).

### Test 6: API send via `message-send` command

Verifies the new fast API-based message sending.

```bash
# Send via API (~11s total, vs 60-90s with safe-send)
time node dist/src/main.js --profile afcne57r linkedin message-send \
  --thread-id "2-NWZkMDkzNDYtNDUxNC00ZGJiLWE5NDMtMzlhYzBjOGEyMjFkXzEwMA==" \
  --message "API send test $(date +%s)" -f json

# Also accepts full thread URL
node dist/src/main.js --profile afcne57r linkedin message-send \
  --thread-id "https://www.linkedin.com/messaging/thread/2-NWZkMDkzNDYtNDUxNC00ZGJiLWE5NDMtMzlhYzBjOGEyMjFkXzEwMA==/" \
  --message "URL format test" -f json
```

**Expected**: `{"ok": true, "status": 200, "messageUrn": "urn:li:messagingMessage:..."}` — completes in ~11s.

### Test 7: Stream mode with stdin sends (production engagement loop)

The full production flow: listen for incoming messages + send replies via stdin, all on the SAME profile/tab.

```bash
THREAD='2-NWZkMDkzNDYtNDUxNC00ZGJiLWE5NDMtMzlhYzBjOGEyMjFkXzEwMA=='

# Start stream listener with stdin pipe for sends
(
  sleep 25  # wait for setup
  echo '{"action":"send","thread_id":"'"$THREAD"'","message":"Hello from stdin!"}'
  sleep 30  # keep pipe open
) | node dist/src/main.js --profile afcne57r linkedin message-listen \
  --stream --duration 60 --include-self

# In parallel from another terminal, send from the other profile:
node dist/src/main.js --profile 6mvwk8eh linkedin message-send \
  --thread-id "$THREAD" --message "Incoming message test" -f json
```

**Expected**: Three types of JSONL output:
- `{"event_type":"send_result","ok":true,...}` — confirms stdin send succeeded
- `{"event_type":"message","sender_urn":"...Maya...","body":"Hello from stdin!",...}` — self-sent detected
- `{"event_type":"message","sender_urn":"...Archit...","body":"Incoming message test",...}` — incoming detected

### Stdin send protocol

When `--stream` is active and stdin is piped (not a terminal), message-listen reads JSONL commands from stdin:

```json
{"action":"send","thread_id":"2-NWZk...","message":"Reply text here"}
```

- `action` must be `"send"`
- `thread_id` can be omitted if `--thread` filter is set (uses that as default)
- Response is emitted on stdout as `{"event_type":"send_result","ok":true,"status":200,"messageUrn":"..."}`

---

## Key timing notes

- `message-listen` takes ~15s to set up (8s page load + 5s drain + 2s first poll)
- The listener MUST be running BEFORE the message is sent
- If the listener starts AFTER the message arrives, the ACK is missed
- For `--duration 0` (batch): exits after capturing first message
- For `--stream --duration 0`: runs forever, emitting each message as JSONL

## How message detection works

Detection is **push-based** (no polling) with a reliable fetch path and an
opportunistic zero-fetch fast path. Full internals + the reverse-engineering
story are in [LINKEDIN-REALTIME-INTERNALS.md](LINKEDIN-REALTIME-INTERNALS.md).

1. `message-listen` navigates to `/messaging/`, starts CDP network capture, and
   enables the **push pipeline** via `page.addBinding('__oc_netcapture_push')`.
   The extension pushes every messaging/realtime network entry to the CLI over
   SSE the instant CDP sees it — the old ~2 s poll wait is gone.
2. When a new message arrives, LinkedIn delivers the body over its
   `/realtime/connect` SSE stream and POSTs a **delivery ACK**
   (`voyagerMessagingDashMessengerMessageDeliveryAcknowledgements`) containing the
   message URN (no body). The ACK is captured 100% reliably.
3. **Fast path (opportunistic, ~300 ms):** if we captured LinkedIn's own message
   body (a `messengerMessages` fetch after a resync, or a `/realtime/connect`
   `DecoratedEvent`), `parseLinkedInOwnMessages()` reads it inline and emits —
   zero fetch. Deduped against the ACK path.
4. **Reliable path (~1.2–1.4 s):** on the ACK we fetch the body ourselves
   (`messengerConversations` GraphQL), parse the message (sender via `*actor` /
   `actor.hostIdentityUrn`, thread via URN decode), and emit. Guarantees delivery.
5. Event is emitted (JSONL in stream mode, or accumulated for batch return).
   Latency: **~1.2–1.4 s** reliably (down from ~2–3 s polling).

## How API message sending works

1. Discover API config from the page: CSRF token (from `JSESSIONID` cookie), mailbox URN (from performance entries)
2. Build conversation URN: `urn:li:msg_conversation:(mailboxUrn, threadId)`
3. POST to `/voyager/api/voyagerMessagingDashMessengerMessages?action=createMessage`
4. Required headers: `Csrf-Token`, `x-restli-protocol-version: 2.0.0`, `X-LI-Track` (client info JSON)
5. Payload: `{message: {body: {text, attributes:[]}, conversationUrn, originToken}, mailboxUrn, trackingId}`
6. Response: `{value: {backendUrn: "urn:li:messagingMessage:..."}}` on success

Speed: ~1s for the API call (vs 60-90s for safe-send browser automation). Total with page load: ~11s.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Empty results `[]` | Listener started after message arrived | Start listener 20s before sending |
| `sender_urn` empty | Old code without `*actor` resolution | Update to latest version |
| API returns empty `included:[]` | Stored URL has `nextCursor` pagination token | Fixed: code strips `nextCursor` automatically |
| CSRF 403 | Double `ajax:` prefix on CSRF token | Fixed: raw CSRF value used |
| safe-send `recipient_header_mismatch` | Wrong `--expected-name` | Use full name as shown in thread header |
| safe-send timeout | Browser daemon in bad state | Restart the browser/extension for that profile |
| `--duration 0` exits immediately | No `--stream` flag, captured a message | Expected batch behavior; use `--stream` for continuous |
| `message-send` returns 400 | Missing required headers (X-LI-Track, etc.) | Code handles this; if recurring, LinkedIn may have changed API |
| `message-send` on same profile kills listener | Tab reuse conflict | Use stdin sends in stream mode instead of separate `message-send` command |
| stdin sends not processed | stdin is a terminal (not piped) | Pipe stdin: `echo '...' \| message-listen --stream` or use named pipe |
