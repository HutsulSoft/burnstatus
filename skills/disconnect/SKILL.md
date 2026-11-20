---
description: Disconnect Slack: revoke the token on the Worker and delete the local key
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Run: node "${CLAUDE_PLUGIN_ROOT}/scripts/ctl.mjs" disconnect

Relay its output.
