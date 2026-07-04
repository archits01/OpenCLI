# Deploying the OpenCLI fork to an OpenComputer (hermes) VM

> **What this is.** The exact, reversible procedure for putting *our fork*
> (`archits01/OpenCLI`, with LinkedIn realtime `message-listen`/`message-send`
> + the push-pipeline/CDP extension) onto an OC agent VM, replacing the
> stock npm-installed `@jackwener/opencli`. Written from the first run on the
> **maya / internal VM** so it can be repeated on the others (LMI, Saksham's).

---

## 0. Why it's not a plain `git pull`

OC VMs run the **npm-published** `@jackwener/opencli` (global install at
`/usr/lib/node_modules/@jackwener/opencli`, `/usr/bin/opencli` → its
`dist/src/main.js`). Our changes live on a **git fork**. There are three moving
parts that must all be swapped, and they're independent:

| Part | Stock (npm) | What it runs | Swap |
|---|---|---|---|
| CLI | `/usr/lib/node_modules/@jackwener/opencli` | every `opencli` command | repoint `/usr/bin/opencli` symlink → fork clone |
| Extension | `/root/.hermes/opencli-extension/dist/background.js` | Chrome's CDP capture (loaded via `--load-extension`) | replace `background.js` |
| Daemon | a **long-running** `node .../daemon.js` on :19825 | CLI↔extension bridge + SSE `/events` | kill the old one, start the fork's |

Repointing the CLI symlink does **not** touch the already-running daemon, and
Chrome only re-reads the extension on launch — so all three need explicit action.

## 1. VM layout cheat-sheet (hermes build)

- OC data dir: **`/root/.hermes/`** (not `.opencomputer`); `oc` == `hermes_cli`.
- Extension Chrome loads: **`/root/.hermes/opencli-extension/`** via
  `hermes-opencli-browser.service` (`--load-extension`, `--user-data-dir=/root/.hermes/opencli-chrome-profile`, `DISPLAY=:1`).
- The browser service is **on-demand** (`disabled`) — start for work, **stop after**.
- Daemon: auto-spawned by the CLI, persists. Port `19825`. Fork adds `GET /events` (SSE).
- Toolchain present: node 22, npm, git. ~100 G free. No bun (use npm).

## 2. The procedure (copy-paste, reversible)

All on the VM as root. `SSH` per the `oc-vm-ssh` skill.

### 2a. Back up + record revert points
```bash
STAMP=$(date +%Y%m%d-%H%M%S)
cp -r /root/.hermes/opencli-extension /root/.hermes/opencli-extension.bak-$STAMP
readlink /usr/bin/opencli | tee /root/opencli-symlink-original.txt
#   → ../lib/node_modules/@jackwener/opencli/dist/src/main.js
```

### 2b. Clone + build the fork
```bash
rm -rf /opt/opencli
git clone --depth 1 https://github.com/archits01/OpenCLI.git /opt/opencli
cd /opt/opencli
npm ci                 # installs devDeps needed for the build
npm run build          # tsc + cli-manifest.json ; ~1–2 min
ls -la dist/src/main.js   # sanity
```
The fork commits the built `extension/dist/background.js`, so **the extension
does not need building** on the VM — the clone already carries it.

### 2c. Swap the CLI (symlink)
```bash
ln -sfn /opt/opencli/dist/src/main.js /usr/bin/opencli
opencli linkedin message-listen --help   # must show our new adapter
opencli linkedin message-send  --help
```

### 2d. Swap the extension (background.js only)
Our changes are **entirely in `background.js`** — no new manifest permissions
(`chrome.debugger.getTargets` / `streamResourceContent` /
`emulateNetworkConditions` all use the existing `debugger` permission). So keep
the VM's `manifest.json` and replace only the built worker:
```bash
cp /opt/opencli/extension/dist/background.js /root/.hermes/opencli-extension/dist/background.js
stat -c '%s bytes' /root/.hermes/opencli-extension/dist/background.js   # ours ≈ 97.7 KB
```
Chrome re-reads this on its next launch — no manual "reload extension".

### 2e. Swap the daemon (the easy-to-miss part)
The running daemon is the **old npm one** and lacks `/events`, so `message-listen`
would silently fall back to polling. Replace it:
```bash
OLD=$(pgrep -f '@jackwener/opencli/dist/src/daemon.js'); [ -n "$OLD" ] && kill $OLD
sleep 2 ; ss -tlnp | grep -q ':19825' && echo 'port still held!' || echo 'port free'
nohup node /opt/opencli/dist/src/daemon.js > /var/log/opencli-daemon.log 2>&1 &
sleep 4
curl -s -H 'X-OpenCLI: 1' localhost:19825/status | grep -o '"daemonVersion":"[^"]*"'   # fork = 1.8.3
curl -s -D - -o /dev/null -H 'X-OpenCLI: 1' localhost:19825/events | head -1            # 200 = fork (npm = 404)
```

## 3. Verify (respect the on-demand Chrome rule)

Only works once the display exists (see §4). Atomic start→check→stop:
```bash
systemctl start hermes-opencli-browser ; sleep 10
opencli browser vmtest open https://example.com          # should NOT say "extension not connected"
curl -s -H 'X-OpenCLI: 1' localhost:19825/status | grep -o '"extensionConnected":[a-z]*'   # want true
opencli browser vmtest close
systemctl stop hermes-opencli-browser ; sleep 3
pkill -9 -f 'load-extension=/root/.hermes/opencli-extension'   # ensure 0 chrome left
```

## 4. Pre-existing blocker on the maya VM: no display on `:1`

`hermes-opencli-browser.service` uses `DISPLAY=:1`, but **`tigervncserver@:1` is
disabled** and only `:0` (physical Xorg) exists. Chrome launches but can't
render, so the **MV3 service worker never boots and the extension can't connect**
— this fails identically with the *old* extension, i.e. the OpenCLI browser stack
was never functional here (LinkedIn on these VMs runs via **Unipile**, not the
browser). **Fix before testing:**
```bash
systemctl start tigervncserver@:1     # brings up display :1
# then re-run §3; the extension should connect
```
(Check the other VMs for the same gap before blaming the extension.)

## 5. Rollback (full revert to stock npm)
```bash
ln -sfn ../lib/node_modules/@jackwener/opencli/dist/src/main.js /usr/bin/opencli
BAK=$(ls -d /root/.hermes/opencli-extension.bak-* | tail -1)
cp $BAK/dist/background.js /root/.hermes/opencli-extension/dist/background.js
pkill -f '/opt/opencli/dist/src/daemon.js'        # npm daemon re-spawns on next command
# (optional) rm -rf /opt/opencli
```

## 6. Repeating on the other VMs
- Same steps; only the **display blocker** (§4) and whether a daemon is already
  running may differ — always check `pgrep -f daemon.js` and `readlink /usr/bin/opencli`.
- Version note: the fork is based on **1.8.3**; VMs' npm is **1.8.4**. Our changes
  are additive (new adapters + browser infra), so the gap is cosmetic — but if a
  1.8.4-only feature is needed, rebase the fork onto upstream first.
- Kill gotcha (from `oc-vm-ssh`): never `pkill` directly inside `ssh "…"`; put it
  in a script on the VM or `kill <pid>` by id.
