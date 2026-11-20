# BurnStatus — Claude Code plugin

Shows your Claude Code 5-hour and weekly limits in your Slack status, e.g. `5h ▓░░░░ 4% · wk ▓▓▓▓░ 86%`.
Without a connection the plugin does nothing. The Slack token never reaches your machine: the plugin only holds its own key and sends four numbers to our Worker, which sets the status.

## Install

This repository is a mirror published from the HutsulSoft monorepo on every change. Commits made here are overwritten by the next sync, so please report problems as issues.

```
/plugin marketplace add HutsulSoft/burnstatus
/plugin install burnstatus@burnstatus
```

Shell form: `claude plugin marketplace add HutsulSoft/burnstatus`, then `claude plugin install burnstatus@burnstatus`.
From a local clone: `claude plugin marketplace add <path to this folder>`.

## Setup

1. Optional: the plugin talks to `https://api.burnstatus.uk` by default; `export BURNSTATUS_WORKER_URL=https://<worker-host>` overrides it (https only; the placeholder keeps every call a no-op). An override still naming the retired `burnstatus-api` workers.dev origin is read as the default.
2. `/burnstatus:setup` copies the statusLine scripts to `~/.claude/burnstatus/bin/` and points `statusLine` in `~/.claude/settings.json` at them. It changes only that key, writes atomically, and backs the file up first to `~/.claude/burnstatus/backups/`. An existing statusline is kept: its command is saved to `~/.claude/burnstatus/wrapped.json` and runs first with the same input, BurnStatus prints its line after it. The wrapped command gets 1 s per refresh: one that takes longer is killed (with its child processes) and shows nothing for that refresh, while the BurnStatus line still prints — a slow statusline tool such as one that calls the network can disappear this way. An unreadable or invalid `settings.json` is never written; setup prints the snippet to add instead.
3. `/burnstatus:connect` pairs by code (RFC 8628 device flow, ADR 0002): it prints a pairing code and opens the Worker's `/pair` page on it (the link is printed too). Check that the page shows the same code, press Connect Slack, approve (user scope `users.profile:write`). Meanwhile `connect --wait` polls; once Slack approves, the plugin stores its key and runs the same statusLine merge as `/burnstatus:setup`. Nothing is copied or pasted.

A plugin manifest cannot set `statusLine` (the plugin docs list no such key), which is why setup edits `settings.json` itself (ADR 0004). The statusLine script is what caches the limits; the Stop hook has no limit data and only sends the cache.

## Commands

| Command                   | Effect                                                                                                        |
| :------------------------ | :------------------------------------------------------------------------------------------------------------ |
| `/burnstatus:connect`     | Pairs by code with Slack; stores the key in macOS Keychain, else `~/.claude/burnstatus/key` (600), then setup |
| `/burnstatus:off` / `:on` | Slack updates off or on, connection kept; after off the status clears by itself within 3 h                    |
| `/burnstatus:disconnect`  | Worker clears the status, revokes the Slack token and erases it; local key deleted even if unreachable        |
| `/burnstatus:status`      | Connected or local mode, on/off, last limits and their age, last send, last failed send; local files only     |

## Files and privacy

- Everything lives in `~/.claude/burnstatus/` (`BURNSTATUS_HOME` overrides it): `cache.json`, `config.json`, `wrapped.json`, `pairing.json` and `pairing.lock` (only while connect waits), `backups/`, `key` when there is no Keychain, all mode 600; `bin/` holds the statusline scripts. `BURNSTATUS_DEBUG=1` writes reason codes (never the key) to `debug.log` there.
- Upgrading from the prototype (`limit-status`): the first command or Stop hook copies `~/.claude/limit-status*.json`, `~/.claude/limit-status-key` and the Keychain item `limit-status`/`plugin-key` to the names above, then deletes the old ones, and refreshes the old statusline copy in `~/.claude/limit-status/` so an un-edited `settings.json` keeps working. It runs once and prints nothing. `/burnstatus:setup` then points `statusLine` at the new path and moves `~/.claude/limit-status/` to `~/.claude/burnstatus/backups/`.
- The Stop hook (`scripts/report.mjs`) posts `{five_hour_pct, five_hour_resets_at, weekly_pct, weekly_resets_at}` to `$BURNSTATUS_WORKER_URL/report`, timeout 3s, at most once a minute, silent on any error. A window whose `resets_at` has passed is sent as `null`; nothing is sent when both have. A 401 stops reporting until `/burnstatus:connect` (`/burnstatus:status` and the statusline say so); a 429 or 5xx waits for `Retry-After`, at least a minute. The key is never logged.
- Worker contract: `POST /pair/start`, `POST /pair/poll` (the key once, in the poll answer), `POST /report` and `POST /disconnect` with `Authorization: Bearer <key>`. The key never appears in the session: it goes from the poll answer straight to storage and is never printed or logged. On macOS, `security add-generic-password -w` puts it in that process's argv for a few milliseconds. The device code waits in `pairing.json` (600) until the pairing ends. 429 and `slow_down` answers are honoured (Retry-After, +5 s).

## Develop

`node --test test/*.test.mjs` (also run by `pnpm test` from the repo root) and `claude plugin validate .`. Zero dependencies, Node 22.
