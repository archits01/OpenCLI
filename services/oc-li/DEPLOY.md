# Deploying oc-li (the managed LinkedIn engagement service) to a VM

> **What this is.** oc-li is the OpenComputer-native, self-hosted replacement for
> Unipile in the sales-agent loop: it captures inbound LinkedIn messages in
> realtime (via the OpenCLI `message-listen` push pipeline), keeps a durable
> queue, replies **in-band**, reconciles anything missed during downtime, and
> supervises itself — then hands each inbound to the **existing reply engine**
> (`engagement.py` + `auto_reply.generate_reply` via the OC router) and sends the
> reply back. No Unipile on either end.
>
> First deployed on the **maya VM** (`100.124.164.84`, member `ACoAAC4I9rMB…` /
> Archit). This is the guide to replicate on the other VMs (LMI, Saksham's, …).

---

## 0. Model: one account per VM

An OpenCLI adapter window is **single-owner** — one `message-listen` holds it, and
all browser ops (send, backfill) go through that one listener's control channel.
So **one oc-li instance = one logged-in LinkedIn account**. Scale by running one
instance per VM (matches the current fleet: each client has its own VM + login).

The account **identity is auto-derived** at login (the listener's `[self]` emit →
`member_id`/`public_identifier`/`name`). You never configure it. Only the
deploy-specific **policy** goes in `account.json`.

> Running >1 account on a single VM would need N Chrome profiles + N daemons +
> per-account paths — not supported yet; out of scope here.

## 1. Prerequisites on the target VM

| Need | Check | Notes |
|---|---|---|
| OpenCLI fork deployed | `readlink /usr/bin/opencli` → `/opt/opencli/dist/src/main.js` | see `clis/linkedin/DEPLOY-TO-OC-VM.md` |
| `whoami` + realtime `message-listen` in the fork | `opencli linkedin whoami --help` | needs the fork build (`npm run build`) |
| Browser + daemon persistent | `systemctl is-enabled hermes-opencli-browser opencli-daemon` → enabled | both `Restart=always` |
| Display `:1` up | `systemctl is-active tigervncserver@:1` | else the extension can't connect |
| **LinkedIn logged in** | `opencli linkedin whoami -f json` returns `member_id` | log in once via the VM's Chrome (noVNC) |
| Node ≥ 22.5 (`node:sqlite`) | `node -e "require('node:sqlite')"` | zero-dep durable store |
| The reply engine on the VM | `/root/engagement.py`, `/root/auto_reply.py`, `/root/oc_li_engage.py` | the account's existing engine + the oc-li glue |

## 2. Install

```bash
# 2a. service code
mkdir -p /opt/oc-li-service
scp services/oc-li/{config.mjs,db.mjs,agent.mjs,oc-li.mjs} root@VM:/opt/oc-li-service/
scp services/oc-li/oc_li_engage.py root@VM:/root/            # the engine glue

# 2b. per-VM policy (START IN ALLOWLIST MODE — see §4)
scp services/oc-li/account.example.json root@VM:/opt/oc-li-service/account.json
#   then edit: label, reply_policy, allowlist, engine cmd/args

# 2c. systemd unit
scp services/oc-li/oc-li-agent.service root@VM:/etc/systemd/system/
ssh root@VM 'systemctl daemon-reload && systemctl enable --now oc-li-agent'
```

## 3. Verify

```bash
ssh root@VM 'grep -E "agent starting|push pipeline ACTIVE|baseline seeded" /opt/oc-li-service/agent.log | tail -3'
#  → account="…" reply_policy=… ; ▶ push pipeline ACTIVE ; ✓ baseline seeded
ssh root@VM 'cd /opt/oc-li-service && NODE_NO_WARNINGS=1 node oc-li.mjs status'
```
Then send a test message **from an allowlisted account only** → expect
`● new msg → 🧠 engaging via engine → ↩ ENGINE reply` in `agent.log`.

## 4. Safety rollout (non-negotiable)

Archit's LinkedIn is a **real production account**; a bad broadcast is unrecoverable.

1. **Always deploy in `"reply_policy": "allowlist"`** with `allowlist` set to a
   single test contact. Confirm real leads show `⛔ blocked`.
2. The service **baseline-seeds** the inbox on a truly-fresh DB (marks history,
   never replies) and **never forwards LLM/infra error strings** as a message.
3. Only once you've watched it behave, flip to `"reply_policy": "all_leads"`
   (engine-gated: unknown senders get no reply) and `systemctl restart oc-li-agent`.

See the `linkedin-test-send-safety` memory for the incident that motivated this.

## 5. Operate

```bash
systemctl status oc-li-agent            # health
journalctl -u oc-li-agent -n 50         # (logs also append to /opt/oc-li-service/agent.log)
node /opt/oc-li-service/oc-li.mjs status
systemctl restart oc-li-agent           # graceful (SIGTERM → listener cleanup → orphan-reap on start)
```

**Recovery, proven on maya:**
- hard `kill -9` of the agent → systemd restarts → **~25s** to engine-ready
- **30-min outage** with a message sent during it → backfill catches it on
  startup → engaged with a real reply. Nothing lost.

Two supervision layers: **systemd → agent**, **agent → listener** (restart-on-exit
rides the cold-start warm-up). Orphan-reaping on start clears a crashed
predecessor's listener so warm-up is clean.

## 6. Rollback

```bash
systemctl disable --now oc-li-agent
# the browser/daemon stay; nothing else touched. Re-enable Unipile webhook_receiver if needed.
```
