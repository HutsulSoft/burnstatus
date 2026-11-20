---
description: Pause reporting limits to Slack (keeps the connection)
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Run: node "${CLAUDE_PLUGIN_ROOT}/scripts/ctl.mjs" off

Relay its output.
