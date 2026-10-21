# Pondy Fleet — web dashboard

Fleet control add-on for the FB-poster server at `/opt/off1` (Express + Caddy).
Wired from `server.js`: `require('./fleet').setupFleet(app, server, sessionMiddleware)`.

- `fleet.js` — `/agent` WebSocket (phones register, receive commands, push status +
  per-account stats) + `/fleet` dashboard (own login) + per-device commands.
- `public/fleet.html` — v2 dashboard: per-device cards (v1/v2), account panel,
  looppost/loop/post/switchaccount, daily-clip leaderboard, live price ticker.
- `public/fleet-login.html` — dashboard login.

Deploy: copy to `/opt/off1/` (+ `public/`). HTML is static (no restart);
`fleet.js` logic changes need `sudo systemctl restart off1`.

NOTE: contains default secrets/URLs — set FLEET_PASSWORD / FLEET_SECRET via env in prod.

## Or run standalone on your own machine (e.g. instead of /opt/off1)

`server.js` boots its own Express + session + `fleet.js`, binds `0.0.0.0` (so phones on the
same WiFi/LAN can reach it directly by IP), and auto-generates `FLEET_PASSWORD` /
`FLEET_SECRET` / `SESSION_SECRET` into `config.json` on first run if you haven't set them
via `.env` — no manual setup needed to get going.

```powershell
npm install                                          # once
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned   # once, if PowerShell blocks scripts
winget install --id Cloudflare.cloudflared            # once, only if you also want access from outside the LAN
.\start-all.ps1                                       # every time: starts Node server + cloudflared, each in its own window
```

Check the Node server window for the LAN URL (`http://<lan-ip>:<port>/fleet`) and the
auto-generated login password. The port is `PORT` (default in `server.js` is 8788, but the
scripts — `start-all.ps1`, `tunnel.ps1`, `install-service.ps1` — all use **18788**, because 8788 falls
in a Windows excluded port range on some machines).

**Tunnel.** `tunnel.ps1` uses a token-based *named* tunnel when `data\tunnel-token.txt` exists, so the
public URL is stable (hostname is in `data\tunnel-url.txt`) and phones don't need re-pointing after a
restart. Without a token it falls back to a Quick Tunnel (`*.trycloudflare.com`) whose URL changes on
every restart — phones would then need `settings.fleetServer` edited by hand.

Want just the local server without a tunnel? `.\start.ps1` alone is enough.

## Run as a Windows service (recommended on the always-on PC)

```powershell
.\install-service.ps1             # asks for admin (UAC); NSSM service "PondyFleet", delayed auto-start,
                                  # restarts 5 s after any exit, logs\fleet.log rotates at 5 MB
.\install-service.ps1 -Uninstall
Restart-Service PondyFleet        # after changing fleet.js / server.js / config.json (admin shell)
```

HTML in `public/` is static and picked up without a restart. Only one copy may run at a time — a second
`node server.js` from another folder will fight for port 18788.

`server.js` exits on `uncaughtException` so the service manager restarts it. Set `BIND_HOST=127.0.0.1`
if only the tunnel needs to reach it (default `0.0.0.0` so LAN phones can connect by IP).

## Health check

`GET /healthz` (no login) → `{ ok, uptimeSec, online, total }` — numbers only, no device data.
Use it for an uptime monitor / watchdog, locally and through the tunnel hostname.

## Backups and recovery

```powershell
.\backup-data.ps1                 # zips data\*.json + config.json into backups\yyyyMMdd-HHmm.zip, keeps 14 days
.\backup-data.ps1 -CopyTo D:\bk   # also copies the zip elsewhere
```

Schedule it hourly with the `schtasks` line at the top of the script. `config.json` holds the secrets, so
`backups\` is gitignored and must not be shared.

Recovery: stop the service → unzip a backup over `data\` (and `config.json` if lost) → start the service →
check `/healthz`. Note: if `config.json` changes, every phone's `FLEET_SECRET` must match the new value.

## Behaviour worth knowing

- **Offline commands.** A command sent to a device that is offline is kept (latest one per device, in memory)
  and delivered when it re-registers, if within 10 minutes; older ones are dropped. `switchwebaccount` is never queued.
  There is no ack from the phone yet — that needs an app change.
- **History.** `data/events.jsonl` (append-only, last 500 kept in memory, trimmed at ~1 MB) logs online / offline / cmd /
  queued-command delivery / stalled / recovered; `data/hourly.json` keeps clips generated and posted per Thai-time hour
  per device for 14 days. The dashboard's "ประวัติ" section shows the last 24 h as bars plus recent events. "Posted" comes from
  the v2 per-account counters, so v1 phones only show generated clips. Both files are included in the backup zip.
- **Festival keywords panel (2026-10-19).** The header button "🎉 เทศกาล" in `public/fleet.html` opens a panel listing
  upcoming Thai festivals (within 100 days; lunar-calendar ones are marked approximate) with product search keywords for each.
  Pick a device, then **☆ บันทึกเข้าคลัง** saves the words into that device's keyword library (`kwsave`, 50 words/device quota
  applies) or **＋ ต่อคิว** appends them to the running device's queue (`kwadd`). Words already in the library (own or shared)
  or in the device's queue are marked and skipped. It is a self-contained block at the end of `fleet.html` — it only reads
  `devices` / `kwLib` and uses the existing `send()`, so no server change or restart is needed. The festival list lives in
  that block (edit it yearly). The pre-change page is kept at `fleet.html.bak-20261019`.
- **Hardening.** Messages must be JSON objects; `deviceId` must match `[\w.:-]{1,64}`; `/agent` payloads are
  capped at 4 MiB and dashboard payloads at 256 KiB; the lock PIN is checked server-side only (`pincheck`),
  with a per-socket attempt limit; login throttling uses the real client IP behind cloudflared (`trust proxy` = loopback).
- **Default secrets.** `server.js` prints a warning at start if the password/secret are weak. Changing them
  means editing `config.json`, restarting, and updating `FLEET_SECRET` on every phone.

`config.json` and `data/*.json` (except `data/selector-presets.json`, which is checked-in
config) hold generated secrets and runtime state — gitignored on purpose, don't commit them.
