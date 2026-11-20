// Shared helpers. Zero dependencies. Nothing here may ever print or log the plugin key.
import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The burnstatus-api Worker on its custom domain (S18); BURNSTATUS_WORKER_URL overrides it.
export const WORKER_URL_PLACEHOLDER = "https://burnstatus.example.invalid";
export const DEFAULT_WORKER_URL = "https://api.burnstatus.uk";
// Origins the Worker no longer answers on (workers_dev: false since S18). The plugin never stores
// the URL, but an override left in a shell profile or settings.json env may still name one: it is
// read as the default instead of failing every call.
export const RETIRED_WORKER_URLS = ["https://burnstatus-api.hutsulsoft-snagon.workers.dev"];
export const KEYCHAIN_SERVICE = "burnstatus";
export const KEYCHAIN_ACCOUNT = "plugin-key";
// The prototype's names, read only by migrate().
export const LEGACY_KEYCHAIN_SERVICE = "limit-status";
const SECURITY_BIN = "/usr/bin/security";

export function workerUrl(env = process.env) {
  const u = (env.BURNSTATUS_WORKER_URL || DEFAULT_WORKER_URL).replace(/\/+$/, "");
  return RETIRED_WORKER_URLS.includes(u.toLowerCase()) ? DEFAULT_WORKER_URL : u;
}
/** True only for a real https URL that is not the placeholder. */
export function workerConfigured(env = process.env) {
  const u = workerUrl(env);
  return u.startsWith("https://") && u !== WORKER_URL_PLACEHOLDER;
}

const claudeDir = (env) => join(env.HOME || homedir(), ".claude");
/** Everything the plugin writes lives here: ~/.claude/burnstatus, or BURNSTATUS_HOME. */
export function homeDir(env = process.env) {
  return env.BURNSTATUS_HOME || join(claudeDir(env), "burnstatus");
}
export const paths = (env = process.env) => ({
  cache: join(homeDir(env), "cache.json"),
  config: join(homeDir(env), "config.json"),
  keyFile: join(homeDir(env), "key"),
  debugLog: join(homeDir(env), "debug.log"),
  bin: join(homeDir(env), "bin"),
  migrated: join(homeDir(env), "migrated"),
  // The user's previous statusLine command, run before ours (ADR 0004); settings.json backups.
  wrapped: join(homeDir(env), "wrapped.json"),
  backups: join(homeDir(env), "backups"),
  // The pairing in progress between `connect` and `connect --wait` (holds the device code).
  pairing: join(homeDir(env), "pairing.json"),
  // Held by the one `connect --wait` that polls (pid inside).
  pairingLock: join(homeDir(env), "pairing.lock"),
});
/** Where the prototype (limit-status) kept its files: ~/.claude, or LIMIT_STATUS_HOME. */
export const legacyPaths = (env = process.env) => {
  const dir = env.LIMIT_STATUS_HOME || claudeDir(env);
  return {
    cache: join(dir, "limit-status-cache.json"),
    config: join(dir, "limit-status.json"),
    keyFile: join(dir, "limit-status-key"),
    // The prototype's install-statusline copied statusline.mjs + lib.mjs here; settings.json may point at it.
    statuslineDir: join(dir, "limit-status"),
  };
};

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}
/** Atomic write with mode 600. */
export function writeJson600(file, data) {
  write600(file, JSON.stringify(data) + "\n");
}
/** The directory 0700, even when it already existed with a looser mode. */
function dir700(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}
/** tmp + rename with mode 600 from the first byte, in a 0700 directory. */
function write600(file, text) {
  dir700(dirname(file));
  const tmp = file + "." + process.pid + ".tmp";
  try {
    writeFileSync(tmp, text, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
  } finally {
    rmSync(tmp, { force: true });
  }
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const pct = (v) => {
  const n = num(v);
  return n === null ? null : Math.min(100, Math.max(0, Math.round(n)));
};

/** statusline stdin JSON -> cache object, or null when rate_limits is absent (non-subscriber / before first response). */
export function parseRateLimits(input, now = Date.now()) {
  const rl = input && typeof input === "object" ? input.rate_limits : null;
  if (!rl || typeof rl !== "object") return null;
  const five = rl.five_hour || {};
  const week = rl.seven_day || {};
  const out = {
    five_hour_pct: pct(five.used_percentage),
    five_hour_resets_at: num(five.resets_at),
    weekly_pct: pct(week.used_percentage),
    weekly_resets_at: num(week.resets_at),
  };
  if (out.five_hour_pct === null && out.weekly_pct === null) return null;
  return { ...out, updated_at: Math.floor(now / 1000) };
}

export function bar(p) {
  const filled = p > 0 ? Math.min(5, Math.max(1, Math.round(p / 20))) : 0;
  return "▓".repeat(filled) + "░".repeat(5 - filled);
}
/** "5h ▓░░░░ 4% · wk ▓▓▓▓░ 86%" */
export function formatStatusLine(c) {
  if (!c) return "";
  const parts = [];
  if (c.five_hour_pct !== null && c.five_hour_pct !== undefined)
    parts.push("5h " + bar(c.five_hour_pct) + " " + c.five_hour_pct + "%");
  if (c.weekly_pct !== null && c.weekly_pct !== undefined)
    parts.push("wk " + bar(c.weekly_pct) + " " + c.weekly_pct + "%");
  return parts.join(" · ");
}

/**
 * The cache minus any window whose resets_at has passed: that percent describes a window that no
 * longer exists, so it is not current (#503). A window with no resets_at is kept. null when neither
 * window is left.
 */
export function liveLimits(c, now = Date.now()) {
  if (!c) return null;
  const out = { ...c };
  for (const w of ["five_hour", "weekly"]) {
    const r = num(out[w + "_resets_at"]);
    if (r !== null && r * 1000 <= now) {
      out[w + "_pct"] = null;
      out[w + "_resets_at"] = null;
    }
  }
  return num(out.five_hour_pct) === null && num(out.weekly_pct) === null ? null : out;
}

/** Exact body for POST /report: only the four agreed fields, current windows only. */
export function buildReport(c, now = Date.now()) {
  const live = liveLimits(c, now);
  if (!live) return null;
  return {
    five_hour_pct: live.five_hour_pct ?? null,
    five_hour_resets_at: live.five_hour_resets_at ?? null,
    weekly_pct: live.weekly_pct ?? null,
    weekly_resets_at: live.weekly_resets_at ?? null,
  };
}

// The statusline's short form of cli.status.reconnect (copy.mjs). lib.mjs is copied to bin/ without
// copy.mjs, so it cannot import the deck.
export const RECONNECT_HINT_SHORT = "BurnStatus: reconnect with /burnstatus:connect";

const MIN_INTERVAL_MS = 60_000; // Worker throttles to 1/60s per user; do not waste calls.
const MAX_BACKOFF_MS = 6 * 3600_000;
/** Retry-After (delta seconds or HTTP date) in ms, capped at 6 h; 0 when absent or unreadable. */
export function retryAfterMs(h, now = Date.now()) {
  if (!h) return 0;
  const s = Number(h);
  const ms = Number.isFinite(s) ? s * 1000 : Date.parse(h) - now;
  return Number.isFinite(ms) ? Math.min(MAX_BACKOFF_MS, Math.max(0, ms)) : 0;
}

/**
 * Stop-hook body: send the current limits to the Worker at most once a minute. Returns a reason code
 * for the debug log (never the key, never the body). A 401 means the connection is gone: reporting
 * stops until /burnstatus:connect. A 429 or 5xx backs off for Retry-After, at least a minute (#505).
 * Every send that does not succeed (no answer, or any non-2xx) records last_failed_at for status.
 */
export async function sendReport({
  env = process.env,
  now = Date.now(),
  fetchImpl = fetch,
  keyOpts = {},
} = {}) {
  if (!workerConfigured(env)) return "exit: worker not configured";
  const cfg = readConfig(env);
  if (!cfg.enabled) return "exit: disabled";
  if (cfg.reconnect_required) return "exit: reconnect required";
  const key = getKey(env, keyOpts);
  if (!key) return "exit: no key";
  const body = buildReport(readJson(paths(env).cache), now);
  if (!body) return "exit: no current limits";
  if (now < cfg.backoff_until) return "exit: backoff";
  const json = JSON.stringify(body);
  if (now - cfg.last_sent_at < MIN_INTERVAL_MS) return "exit: throttle <60s";
  if (json === cfg.last_sent_body && now - cfg.last_sent_at < 10 * 60_000)
    return "exit: dedup same body <10min";
  let res;
  try {
    res = await fetchImpl(workerUrl(env) + "/report", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + key },
      body: json,
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    // No message: an error text is not ours to log.
    writeConfig({ last_failed_at: now }, env);
    return "error: unreachable";
  }
  if (res.ok) writeConfig({ last_sent_at: now, last_sent_body: json, backoff_until: 0 }, env);
  else if (res.status === 401)
    // reconnect_required (dead or undecryptable token) or unauthorized (record erased, e.g. the app
    // was removed in Slack): either way only /burnstatus:connect recovers.
    writeConfig({ reconnect_required: true, last_failed_at: now }, env);
  else if (res.status === 429 || res.status >= 500) {
    const wait = Math.max(MIN_INTERVAL_MS, retryAfterMs(res.headers.get("retry-after"), now));
    writeConfig({ backoff_until: now + wait, last_failed_at: now }, env);
  } else writeConfig({ last_failed_at: now }, env);
  return "http " + res.status;
}

// ---- plugin key storage: macOS Keychain, else a 600 file ----
// opts = { platform, securityBin } exists so tests can run a fake `security` on any OS.
const onMac = (opts) => (opts.platform ?? process.platform) === "darwin";
const useKeychain = (env, opts) => onMac(opts) && !env.BURNSTATUS_HOME;
function sec(args, opts) {
  return execFileSync(opts.securityBin ?? SECURITY_BIN, args, {
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 3000,
  }).toString();
}
function findPassword(service, opts) {
  try {
    return sec(["find-generic-password", "-s", service, "-a", KEYCHAIN_ACCOUNT, "-w"], opts).trim();
  } catch {
    return "";
  }
}
export function getKey(env = process.env, opts = {}) {
  if (useKeychain(env, opts)) {
    const k = findPassword(KEYCHAIN_SERVICE, opts);
    if (k) return k;
  }
  try {
    return readFileSync(paths(env).keyFile, "utf8").trim() || null;
  } catch {
    return null;
  }
}
/** Returns where the key went. NOTE: `security -w` exposes the value in argv for a few ms; the file path does not. */
export function setKey(key, env = process.env, opts = {}) {
  if (useKeychain(env, opts)) {
    try {
      sec(
        ["add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w", key],
        opts,
      );
      rmSync(paths(env).keyFile, { force: true });
      return "keychain";
    } catch {}
  }
  write600(paths(env).keyFile, key + "\n");
  // getKey prefers the Keychain: an older item there would shadow the key just written.
  if (useKeychain(env, opts)) {
    try {
      sec(["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT], opts);
    } catch {}
  }
  return "file";
}
export function deleteKey(env = process.env, opts = {}) {
  if (useKeychain(env, opts)) {
    try {
      sec(["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT], opts);
    } catch {}
  }
  rmSync(paths(env).keyFile, { force: true });
}

/**
 * One-time move from the prototype's names: ~/.claude/limit-status* files and the Keychain item
 * limit-status/plugin-key are copied to the new names, then deleted. A value already under the new
 * name wins. Runs once (marker file); on any failure the marker is not written and nothing old is
 * deleted that was not copied first. Silent: never prints, and never lets an error (whose message
 * could carry `security` argv) escape. Returns true when this call did the migration.
 */
/** tmp + rename, so a crash mid-write never leaves a truncated target; the source is untouched. */
function copy600(from, to) {
  mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
  const tmp = to + "." + process.pid + ".tmp";
  writeFileSync(tmp, readFileSync(from), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, to);
}
export function migrate(env = process.env, opts = {}) {
  const p = paths(env);
  if (existsSync(p.migrated)) return false;
  try {
    const old = legacyPaths(env);
    for (const k of ["cache", "config", "keyFile"]) {
      if (!existsSync(old[k])) continue;
      if (!existsSync(p[k])) copy600(old[k], p[k]);
      rmSync(old[k], { force: true });
    }
    // An upgrading user's settings.json still runs the old statusline copy, which would keep feeding
    // the legacy cache. Refresh that copy so the old path writes the new cache until setup is re-run.
    const here = dirname(fileURLToPath(import.meta.url));
    if (existsSync(join(old.statuslineDir, "statusline.mjs")) && here !== old.statuslineDir) {
      for (const f of ["lib.mjs", "statusline.mjs"])
        copy600(join(here, f), join(old.statuslineDir, f));
    }
    // The prototype used the Keychain only on macOS without LIMIT_STATUS_HOME.
    if (onMac(opts) && !env.LIMIT_STATUS_HOME) {
      const legacyKey = findPassword(LEGACY_KEYCHAIN_SERVICE, opts);
      if (legacyKey) {
        if (!getKey(env, opts)) setKey(legacyKey, env, opts);
        try {
          sec(
            ["delete-generic-password", "-s", LEGACY_KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT],
            opts,
          );
        } catch {}
      }
    }
    mkdirSync(homeDir(env), { recursive: true });
    writeFileSync(p.migrated, new Date().toISOString() + "\n", { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

export const WRAPPED_TIMEOUT_MS = 1000;
/**
 * Runs the wrapped (pre-BurnStatus) statusLine command with the same stdin, through the shell as
 * Claude Code runs it. Resolves its stdout without trailing newlines, or "" when there is none, it
 * fails, or it outlives the timeout (then its process group is killed). Never rejects.
 */
export function runWrapped(raw, env = process.env, timeoutMs = WRAPPED_TIMEOUT_MS) {
  const w = readJson(paths(env).wrapped);
  const command = w && typeof w.command === "string" ? w.command.trim() : "";
  // BURNSTATUS_WRAPPED guards a loop: a wrapped command that is itself our statusline.
  if (!command || env.BURNSTATUS_WRAPPED === "1") return Promise.resolve("");
  return new Promise((resolve) => {
    let out = "";
    let done = false;
    let child;
    const finish = (s) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(s.replace(/\n+$/, ""));
    };
    const timer = setTimeout(() => {
      try {
        if (process.platform === "win32") child.kill("SIGKILL");
        else process.kill(-child.pid, "SIGKILL");
      } catch {}
      finish("");
    }, timeoutMs);
    try {
      child = spawn(command, {
        shell: true,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "ignore"],
        env: { ...env, BURNSTATUS_WRAPPED: "1" },
      });
    } catch {
      return finish("");
    }
    child.on("error", () => finish(""));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d) => (out += d));
    child.on("close", () => finish(out));
    child.stdin.on("error", () => {});
    child.stdin.end(raw);
  });
}

export function readConfig(env = process.env) {
  const c = readJson(paths(env).config, {}) || {};
  return {
    enabled: c.enabled !== false,
    last_sent_at: num(c.last_sent_at) ?? 0,
    last_sent_body: typeof c.last_sent_body === "string" ? c.last_sent_body : "",
    reconnect_required: c.reconnect_required === true,
    backoff_until: num(c.backoff_until) ?? 0,
    last_failed_at: num(c.last_failed_at) ?? 0,
  };
}
export function writeConfig(patch, env = process.env) {
  writeJson600(paths(env).config, { ...readConfig(env), ...patch });
}
