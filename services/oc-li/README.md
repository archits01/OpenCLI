# oc-li — managed LinkedIn engagement service

The OpenComputer-native, self-hosted replacement for Unipile in the sales-agent
loop. Realtime capture + durable queue + in-band send + reconcile + supervision,
handing each inbound to the account's **existing reply engine**. One instance per
logged-in account (one per VM). See [DEPLOY.md](DEPLOY.md) to replicate.

## Flow

```
LinkedIn ──(realtime push)──▶ message-listen ──stdout──▶ agent.mjs
                                    ▲                         │ ingest → durable queue (node:sqlite)
             in-band send  ────────┘                         │ gate: baseline-seed · authed · allowlist/policy
             (sendfile, {action:send})                       ▼
                                                     oc_li_engage.py (glue)
                                                     → engagement.on_message_received (CRM/BANT/intent)
                                                     → auto_reply.generate_reply (LLM via OC router)
                                                     ← reply text ──▶ sendfile ──▶ LinkedIn
        reconcile: {action:backfill} (post-restart + periodic) recovers anything missed while down
```

## Files

| File | Role |
|---|---|
| `agent.mjs` | per-account worker: supervises the listener, ingests, gates, calls the engine, sends in-band, health watchdog, orphan-reaping |
| `db.mjs` | durable state (`node:sqlite`): accounts / events (idempotent on `message_urn`) / cursors / health |
| `config.mjs` | paths + loads per-VM `account.json` (label, reply_policy, allowlist, engine binding) |
| `oc_li_engage.py` | thin glue: oc-li event → the existing `engagement.py` + `auto_reply` engine → `{reply,action}` |
| `oc-li.mjs` | `status` / `db-check` CLI |
| `oc-li-agent.service` | systemd unit (Restart=always, graceful SIGTERM) |
| `account.example.json` | per-VM deploy config template |

## Guarantees (proven on the maya VM)

- **Nothing lost across downtime** — realtime for speed + backfill for completeness (a message sent during a 30-min outage was caught on recovery and engaged).
- **Crash recovery** — hard `kill -9` → ~25s back to engine-ready, automatic.
- **Safety** — baseline-seed (no inbox-spam on boot), reply allowlist / engine-gated policy, never forwards LLM error strings. Real leads untouched.

## Related

- Fork additions it depends on: `clis/linkedin/message-listen.js` (realtime + `[self]` + in-band `backfill`), `clis/linkedin/whoami.js`.
- Memories: `oc-li-service-build`, `linkedin-test-send-safety`, `linkedin-realtime-internals`, `maya-vm-opencli-deploy`.
