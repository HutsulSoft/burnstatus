---
description: Connect your Slack workspace so Claude Code limits show in your Slack status
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Pairing by code, nothing to copy or paste. Two commands, in this order:

1. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/ctl.mjs" connect`. Relay its output as is, right away: it holds the pairing code the user compares with the browser page, and the link to open if no browser opened. If it says already connected or could not reach BurnStatus, stop there.
2. Otherwise run `node "${CLAUDE_PLUGIN_ROOT}/scripts/ctl.mjs" connect --wait` with a Bash timeout of 600000 ms. It waits until Slack is connected, stores the connection (Keychain, else a 600 file), adds the statusline, and prints the result. If its whole output is the "Waiting for Slack…" line again, run the same command once more. Relay the final output as is.

Do not open the link yourself, and do not edit settings.json yourself.
