// User-facing CLI strings, verbatim from the copy deck in apps/burnstatus/docs/03-ux.md.
// {name} placeholders are runtime values filled by say(); never put a key or token in one.
export const COPY = {
  "cli.setup.done":
    "Local mode ready: your limits show in the statusline. Nothing is sent anywhere.",
  "cli.connect.code": "Your pairing code: {code}",
  "cli.connect.opened":
    "Opened your browser. Check that it shows the same code, then connect Slack.",
  "cli.connect.manual": "If no browser opened, go to {url}",
  "cli.connect.waiting": "Waiting for Slack… (the code works for 15 minutes)",
  "cli.connect.done": "Connected. Your Slack status will show your limits after your next reply.",
  "cli.connect.statusline_new": "Statusline added to ~/.claude/settings.json. Backup: {path}",
  "cli.connect.statusline_created":
    "Statusline added to ~/.claude/settings.json, a new file, so there was nothing to back up.",
  "cli.connect.statusline_wrapped":
    "Your existing statusline was kept: it runs first, BurnStatus adds its line after. Backup: {path}",
  "cli.connect.statusline_ours":
    "BurnStatus is already your statusline in ~/.claude/settings.json. Nothing changed.",
  "cli.connect.statusline_kept":
    "Your statusline in ~/.claude/settings.json has no command BurnStatus can run first, so it was left as is. To show your limits, set it to this:",
  "cli.connect.statusline_manual":
    "Could not read ~/.claude/settings.json, so it was not changed. Add this yourself:",
  "cli.connect.expired":
    "The pairing code expired before Slack was connected. Run /burnstatus:connect for a new one.",
  "cli.connect.denied":
    "Slack access was not granted, so nothing was connected. Run /burnstatus:connect to try again.",
  "cli.connect.cancelled":
    "You said the code did not match, so nothing was connected. Run /burnstatus:connect to start over.",
  "cli.connect.approval_hint":
    "If Slack asked you to request approval, a workspace owner must approve BurnStatus first. Run /burnstatus:connect again once they do.",
  "cli.connect.unreachable":
    "Could not reach BurnStatus. Check your connection and run /burnstatus:connect again.",
  "cli.connect.store_failed":
    "Slack was connected, but this machine could not save the connection. Run /burnstatus:connect again.",
  "cli.connect.maybe_done":
    "The connection may have completed while BurnStatus was hard to reach. Run /burnstatus:status to check, or /burnstatus:connect again.",
  "cli.connect.already":
    "Already connected. To switch workspaces, run /burnstatus:disconnect first.",
  "cli.status.connected": "Connected to Slack. Updates: {on_off}.",
  "cli.status.local":
    "Local mode: your limits show in this terminal only. Run /burnstatus:connect to share them in Slack.",
  "cli.status.limits": "Last limits: {limits} ({age} ago)",
  "cli.status.sent": "Last sent to Slack: {time}",
  "cli.status.reconnect":
    "Slack disconnected BurnStatus (the app was removed or access revoked). Run /burnstatus:connect.",
  "cli.status.failed": "The last send failed at {time}. Your Slack status may be out of date.",
  "cli.on": "Slack updates are on.",
  "cli.off":
    "Slack updates are off. Your Slack status clears by itself within 3 hours of the last update.",
  "cli.disconnect.done":
    "Disconnected. Your Slack status was cleared, BurnStatus can no longer change it, and its copy of your access is erased.",
  "cli.disconnect.unreachable":
    "Could not reach BurnStatus. Removed locally; to be sure, remove BurnStatus in Slack under Apps.",
  "cli.not_connected": "Not connected. Run /burnstatus:connect first.",
};

// What a line reads when it has nothing to show, from the deck's notes column.
export const EMPTY = {
  "cli.status.limits": "Last limits: none yet",
  "cli.status.sent": "Last sent to Slack: never",
};

/** The copy-deck string for key with {placeholders} filled; throws on an unknown key. */
export function copy(key, vars = {}) {
  const s = COPY[key];
  if (s === undefined) throw new Error("unknown copy key: " + key);
  return s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}
