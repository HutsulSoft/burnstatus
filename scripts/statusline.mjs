#!/usr/bin/env node
// statusLine command: reads Claude Code JSON from stdin, caches rate_limits (mode 600), prints a short line.
// Docs: https://code.claude.com/docs/en/statusline (rate_limits.five_hour/seven_day.used_percentage, resets_at = epoch seconds).
// A statusLine that was there before BurnStatus (wrapped.json, ADR 0004) runs first with the same
// stdin and a 1-s timeout; its output is printed above ours.
import {
  RECONNECT_HINT_SHORT,
  formatStatusLine,
  liveLimits,
  paths,
  parseRateLimits,
  readConfig,
  readJson,
  runWrapped,
  writeJson600,
} from "./lib.mjs";

function ownLine(raw) {
  try {
    const parsed = parseRateLimits(JSON.parse(raw));
    const file = paths().cache;
    let shown = parsed;
    if (parsed) {
      const old = readJson(file);
      const same =
        old &&
        ["five_hour_pct", "five_hour_resets_at", "weekly_pct", "weekly_resets_at"].every(
          (k) => old[k] === parsed[k],
        );
      if (!same) writeJson600(file, parsed);
    } else {
      shown = readJson(file); // rate_limits absent right now: show the last known values
    }
    // A window past its resets_at is not shown as current (#503); a 401 asks for a reconnect (#505).
    const parts = [formatStatusLine(liveLimits(shown))];
    if (readConfig().reconnect_required) parts.push(RECONNECT_HINT_SHORT);
    return parts.filter(Boolean).join(" · ");
  } catch {
    return ""; // never break the statusline
  }
}

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (raw += d));
process.stdin.on("end", async () => {
  try {
    // Cache first: a slow or killed wrapped command must never cost us the limits update.
    const own = ownLine(raw);
    const wrapped = await runWrapped(raw);
    const lines = [wrapped, own].filter(Boolean);
    if (lines.length) process.stdout.write(lines.join("\n") + "\n");
  } catch {}
  process.exit(0);
});
