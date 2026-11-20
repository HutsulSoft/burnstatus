#!/usr/bin/env node
// Control script behind the slash commands: connect [--wait] | on | off | disconnect | status | setup
import {
  deleteKey,
  formatStatusLine,
  getKey,
  liveLimits,
  migrate,
  paths,
  readConfig,
  readJson,
  workerConfigured,
  DEFAULT_WORKER_URL,
  workerUrl,
  writeConfig,
} from "./lib.mjs";
import { EMPTY, copy } from "./copy.mjs";
import { startConnect, waitConnect } from "./connect.mjs";
import { mergeLines, mergeStatusline } from "./setup.mjs";

const say = (s) => process.stdout.write(s + "\n");
const cmd = process.argv[2];
const arg = process.argv[3];

// Device flow (ADR 0002): `connect` prints the pairing code and opens the browser, `connect --wait`
// polls until Slack is connected. There is no key argument: the key never passes through the chat.
async function connect(wait) {
  if (!workerConfigured())
    // Only an override can fail this (the default is https): the 03 deck has no line for it.
    return say(
      "BURNSTATUS_WORKER_URL is not a usable https address. Fix it, or unset it to use " +
        DEFAULT_WORKER_URL +
        ".",
    );
  return wait ? waitConnect({ say }) : startConnect({ say });
}

// The Worker clears the status, revokes and erases (S4) and answers 2xx. A 401 means it holds no
// record for this key any more (already erased, e.g. the app was removed in Slack): disconnected too.
// No answer or any other status still removes the key here and sends the user to Slack's Apps page.
async function disconnect() {
  const key = getKey();
  if (!key) return say(copy("cli.not_connected"));
  let ok = false;
  if (workerConfigured()) {
    try {
      const res = await fetch(workerUrl() + "/disconnect", {
        method: "POST",
        headers: { authorization: "Bearer " + key },
        redirect: "error",
        signal: AbortSignal.timeout(3000),
      });
      ok = res.ok || res.status === 401;
    } catch {}
  }
  deleteKey();
  writeConfig({ reconnect_required: false, last_failed_at: 0, backoff_until: 0 });
  say(copy(ok ? "cli.disconnect.done" : "cli.disconnect.unreachable"));
}

// on/off are local: they work offline and keep the connection. off sends no clear; the Worker set
// status_expiration on every update (S4), so Slack drops the status within 3 hours.
function setEnabled(on) {
  if (!getKey()) return say(copy("cli.not_connected"));
  writeConfig({ enabled: on });
  say(copy(on ? "cli.on" : "cli.off"));
}

function setup() {
  // ADR 0004: the merge edits only statusLine, after a backup; it never writes an unreadable file.
  const r = mergeStatusline();
  for (const line of mergeLines(r)) say(line);
  if (r.result !== "manual" && r.result !== "kept") say(copy("cli.setup.done"));
}

const pad = (n) => String(n).padStart(2, "0");
/** {time}: local wall-clock time to the minute, "2026-11-20 10:04". */
function formatTime(ms) {
  const d = new Date(ms);
  const day = d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  return day + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
}
/** {age}: "45 s", "3 min", "2 h", "4 d" (rounded down). */
function formatAge(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return s + " s";
  if (s < 3600) return Math.floor(s / 60) + " min";
  if (s < 86400) return Math.floor(s / 3600) + " h";
  return Math.floor(s / 86400) + " d";
}

// Reads local files only, never calls the Worker (03 § status).
function status(now = Date.now()) {
  const cfg = readConfig();
  const cache = readJson(paths().cache);
  const connected = Boolean(getKey());
  if (!connected) say(copy("cli.status.local"));
  else if (cfg.reconnect_required) say(copy("cli.status.reconnect"));
  else say(copy("cli.status.connected", { on_off: cfg.enabled ? "on" : "off" }));
  // A cache without updated_at cannot be dated; the statusline rewrites it on the next refresh.
  const live = liveLimits(cache, now);
  const at = cache && Number.isFinite(cache.updated_at) ? cache.updated_at * 1000 : null;
  say(
    live && at !== null
      ? copy("cli.status.limits", { limits: formatStatusLine(live), age: formatAge(now - at) })
      : EMPTY["cli.status.limits"],
  );
  if (!connected) return;
  say(
    cfg.last_sent_at
      ? copy("cli.status.sent", { time: formatTime(cfg.last_sent_at) })
      : EMPTY["cli.status.sent"],
  );
  if (!cfg.reconnect_required && cfg.last_failed_at > cfg.last_sent_at)
    say(copy("cli.status.failed", { time: formatTime(cfg.last_failed_at) }));
}

try {
  migrate(); // one-time move from the prototype's limit-status names; silent
  if (cmd === "connect") await connect(arg === "--wait");
  else if (cmd === "disconnect") await disconnect();
  else if (cmd === "on") setEnabled(true);
  else if (cmd === "off") setEnabled(false);
  else if (cmd === "status") status();
  else if (cmd === "setup" || cmd === "install-statusline") setup();
  else say("usage: ctl.mjs connect [--wait]|on|off|disconnect|status|setup");
} catch (e) {
  say("error: " + (e && e.message ? e.message : "unknown"));
}
