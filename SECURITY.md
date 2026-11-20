# Security policy

## Reporting a vulnerability

Please report privately. Do not open a public issue, discussion or pull request for a security problem.

- GitHub private vulnerability reporting: the **Security** tab of this repository, then **Report a vulnerability**
  (https://github.com/HutsulSoft/burnstatus/security/advisories/new).
- Or email support@burnstatus.uk.

Include what you found, how to reproduce it, the plugin version (`.claude-plugin/plugin.json`) and what an attacker could do with it.
Do not include a real plugin key, Slack token or device code; redact them.

## Scope

In scope:

- This plugin: how the plugin key is stored (macOS Keychain or the 0600 file under `~/.claude/burnstatus/`), read, logged or deleted.
- What the plugin sends: the four numbers posted to `/report`, the pairing requests, and anything else that leaves the machine.
- Edits the plugin makes to `~/.claude/settings.json` (statusLine merge, backups, the wrapped command).
- The hosted Worker at https://api.burnstatus.uk: pairing (`/pair`), `/report`, `/disconnect`, and how it stores and uses the Slack token.

Out of scope:

- Slack itself, and Claude Code itself. Report those to Slack and Anthropic.
- A self-hosted Worker set via `BURNSTATUS_WORKER_URL`.
- Issues that need an attacker who already controls your user account or machine.
- Denial of service by volume, missing headers without a concrete impact, and automated scanner output without a working case.

## What to expect

This project has one maintainer.

- Acknowledgement within 7 days.
- An assessment and a plan after that, and a fix as soon as one is ready. Fixes ship through the source repository and appear here on the next sync.
- Credit in the advisory if you want it.

There is no bug bounty.

Only the latest release is supported.
