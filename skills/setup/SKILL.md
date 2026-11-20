---
description: Wire the BurnStatus statusline into ~/.claude/settings.json (local mode, no Slack); backs up settings.json and keeps an existing statusline
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Run: node "${CLAUDE_PLUGIN_ROOT}/scripts/ctl.mjs" setup

Relay the output as is. Do not edit settings.json yourself: the script changes only the `statusLine` key, after a backup, and prints a snippet instead when the file cannot be read.
