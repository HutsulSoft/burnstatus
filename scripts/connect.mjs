// /burnstatus:connect as an RFC 8628 device flow (ADR 0002, 04-plan.md S9). Zero dependencies.
// Two phases in two processes: `connect` asks for a pairing code, prints it and opens the browser;
// `connect --wait` polls until Slack is connected. Claude Code shows a command's output only when
// it ends and stops one command after 10 minutes, so the code must be printed before the wait, and
// the wait (15-minute code) runs in slices of at most WAIT_BUDGET_MS, resumed from pairing.json.
// Nothing here prints the plugin key or the device code, or puts either in argv.
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { copy } from "./copy.mjs";
import {
  getKey,
  homeDir,
  paths,
  readConfig,
  readJson,
  retryAfterMs,
  setKey,
  workerUrl,
  writeConfig,
  writeJson600,
} from "./lib.mjs";
import { mergeLines, mergeStatusline, snippet } from "./setup.mjs";

// The Worker's formats (worker/src/pairing.ts): 32 symbols, no 0/O/1/I.
const SYM = "[2-9A-HJ-NP-Z]";
const USER_CODE_RE = new RegExp(`^${SYM}{4}-${SYM}{4}$`);
const DEVICE_CODE_RE = new RegExp(`^${SYM}{8}\\.[A-Za-z0-9_-]{43}$`);
const KEY_RE = /^bsk_[A-Za-z0-9_-]{20,200}$/;
// The URL goes to a platform opener (cmd.exe on Windows): https only, and no character a shell or
// cmd.exe would reinterpret (no &, %, ^, quotes, spaces, |, <, >).
const SAFE_URL_RE = /^https:\/\/[A-Za-z0-9.-]+(:\d+)?\/[A-Za-z0-9\-._~/?=#@+,;:]*$/;

export const WAIT_BUDGET_MS = 540_000;
const REQUEST_TIMEOUT_MS = 10_000;
const START_ATTEMPTS = 3;
const SLOW_DOWN_STEP_S = 5;
const clampInterval = (s) =>
  Math.min(60, Math.max(1, typeof s === "number" && Number.isFinite(s) ? s : 5));
const clampTtl = (s) =>
  Math.min(1800, Math.max(60, typeof s === "number" && Number.isFinite(s) ? s : 900));

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** A URL safe to hand to the platform opener, or null. */
export function safeUrl(u) {
  if (typeof u !== "string") return null;
  try {
    const href = new URL(u).href;
    return SAFE_URL_RE.test(href) ? href : null;
  } catch {
    return null;
  }
}

/**
 * Opens url in the default browser with argv only, never a shell string. Resolves true once the
 * opener process started, false when it could not (missing binary, unsafe URL).
 */
export function openBrowser(url, { platform = process.platform, spawnImpl = spawn } = {}) {
  if (safeUrl(url) !== url) return Promise.resolve(false);
  const [bin, args] =
    platform === "darwin"
      ? ["open", [url]]
      : platform === "win32"
        ? ["cmd.exe", ["/d", "/c", "start", "", url]]
        : ["xdg-open", [url]];
  return new Promise((resolve) => {
    try {
      const child = spawnImpl(bin, args, { stdio: "ignore", detached: true });
      child.once("spawn", () => resolve(true));
      child.once("error", () => resolve(false));
      child.unref();
    } catch {
      resolve(false);
    }
  });
}

/** POST a JSON body; { status, data, retryAfter }, or null when the Worker could not be reached. */
async function post(env, fetchImpl, path, body) {
  try {
    const res = await fetchImpl(workerUrl(env) + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      // A redirect is never followed: the device code and the key only travel to the Worker itself.
      redirect: "error",
    });
    let data = null;
    try {
      data = await res.json();
    } catch {}
    return {
      status: res.status,
      data: data && typeof data === "object" ? data : {},
      retryAfter: res.headers.get("retry-after"),
    };
  } catch {
    return null;
  }
}

/** Phase 1: a pairing code from POST /pair/start, printed, and the browser opened on it. */
export async function startConnect({
  env = process.env,
  fetchImpl = fetch,
  say,
  open = openBrowser,
  now = Date.now,
  sleep = delay,
  keyOpts = {},
} = {}) {
  if (getKey(env, keyOpts) && !readConfig(env).reconnect_required)
    return say(copy("cli.connect.already"));
  const file = paths(env).pairing;
  let res = null;
  for (let i = 0; i < START_ATTEMPTS; i++) {
    // oxlint-disable-next-line no-await-in-loop -- retries are sequential by nature
    res = await post(env, fetchImpl, "/pair/start", {});
    // Two plugins behind one NAT can exceed the per-IP limit: wait as told, then try again.
    if (!res || res.status !== 429 || i === START_ATTEMPTS - 1) break;
    // oxlint-disable-next-line no-await-in-loop
    await sleep(Math.min(60_000, Math.max(1000, retryAfterMs(res.retryAfter))));
  }
  const d = res && res.status === 200 ? res.data : null;
  const url = d ? safeUrl(d.verification_uri_complete) : null;
  // The /pair page is served by the same Worker: a link anywhere else is not followed or shown.
  if (
    !d ||
    !url ||
    new URL(url).origin !== new URL(workerUrl(env)).origin ||
    typeof d.device_code !== "string" ||
    !DEVICE_CODE_RE.test(d.device_code) ||
    typeof d.user_code !== "string" ||
    !USER_CODE_RE.test(d.user_code)
  )
    return say(copy("cli.connect.unreachable"));
  // Only now is a live pairing from an earlier connect replaced (tmp + rename, no gap): a failed
  // /pair/start above leaves it running.
  writeJson600(file, {
    device_code: d.device_code,
    interval: clampInterval(d.interval),
    expires_at: now() + clampTtl(d.expires_in) * 1000,
    last_poll_at: 0,
    not_before: 0,
  });
  say(copy("cli.connect.code", { code: d.user_code }));
  if (await open(url)) say(copy("cli.connect.opened"));
  say(copy("cli.connect.manual", { url }));
  say(copy("cli.connect.waiting"));
}

/** pid is alive (EPERM: alive, someone else's). */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e && e.code === "EPERM";
  }
}

/**
 * pairing.lock, created exclusively ('wx') and holding the pid: one --wait at a time. A lock whose
 * pid is dead is taken over. Returns a release function, or null when a live --wait holds it.
 */
function lock(file, pid) {
  for (let i = 0; i < 2; i++) {
    try {
      const fd = openSync(file, "wx", 0o600);
      writeSync(fd, String(pid));
      closeSync(fd);
      return () => {
        try {
          if (readFileSync(file, "utf8") === String(pid)) rmSync(file, { force: true });
        } catch {}
      };
    } catch (e) {
      if (!e || e.code !== "EEXIST") throw e;
    }
    let holder = NaN;
    try {
      holder = Number.parseInt(readFileSync(file, "utf8"), 10);
    } catch {}
    if (Number.isInteger(holder) && holder > 0 && alive(holder)) return null;
    rmSync(file, { force: true });
  }
  return null;
}

/**
 * Phase 2: poll POST /pair/poll at `interval` until the key, a final answer, expiry, or the budget
 * (then the waiting line again, and the state stays for the next run). Lost mid-poll (network error,
 * 5xx) keeps polling until expiry; 429 waits Retry-After; slow_down adds 5 s (RFC 8628 §3.5).
 */
export async function waitConnect(opts = {}) {
  const env = opts.env ?? process.env;
  mkdirSync(homeDir(env), { recursive: true, mode: 0o700 });
  const release = lock(paths(env).pairingLock, opts.pid ?? process.pid);
  if (!release) return; // another --wait is polling this pairing; it reports the outcome
  try {
    return await pollPairing(opts);
  } finally {
    release();
  }
}

async function pollPairing({
  env = process.env,
  fetchImpl = fetch,
  say,
  now = Date.now,
  sleep = delay,
  budgetMs = WAIT_BUDGET_MS,
  keyOpts = {},
}) {
  const file = paths(env).pairing;
  const p = readJson(file);
  if (!p || typeof p.device_code !== "string" || !DEVICE_CODE_RE.test(p.device_code)) {
    rmSync(file, { force: true });
    return say(copy("cli.connect.expired"));
  }
  const st = {
    interval: clampInterval(p.interval),
    expires_at: num(p.expires_at),
    last_poll_at: num(p.last_poll_at),
    not_before: num(p.not_before),
  };
  // pairing.json belongs to whichever connect wrote it last: a newer `connect` replaces it, and this
  // (stale) wait then neither writes nor deletes it and stops without a word.
  const owned = () => readJson(file)?.device_code === p.device_code;
  const save = () => {
    if (!owned()) return false;
    writeJson600(file, { device_code: p.device_code, ...st });
    return true;
  };
  const finish = (...lines) => {
    if (owned()) rmSync(file, { force: true });
    for (const l of lines) say(l);
  };
  const expired = () => finish(copy("cli.connect.expired"), copy("cli.connect.approval_hint"));
  const until = now() + budgetMs;
  // An answer lost on the way (network, 5xx, a 4xx that is not the Worker's JSON) could have been
  // the one carrying the key: a later expired_token then may mean "delivered", not "expired".
  let lost = false;
  for (;;) {
    if (!owned()) return;
    const t = now();
    if (t >= st.expires_at) return expired();
    const due = Math.max(t, st.last_poll_at + st.interval * 1000, st.not_before);
    const wake = Math.min(due, st.expires_at);
    if (wake > until) return save() ? say(copy("cli.connect.waiting")) : undefined;
    // oxlint-disable-next-line no-await-in-loop -- polling is sequential by nature
    if (wake > t) await sleep(wake - t);
    if (!owned()) return;
    if (now() >= st.expires_at) return expired();
    st.last_poll_at = now();
    // oxlint-disable-next-line no-await-in-loop
    const res = await post(env, fetchImpl, "/pair/poll", { device_code: p.device_code });
    if (res && res.status === 200) {
      // The key is delivered exactly once, so it is kept even if a newer connect started meanwhile.
      const key = res.data.plugin_key;
      if (typeof key !== "string" || !KEY_RE.test(key))
        return finish(copy("cli.connect.unreachable"));
      // Held from here on: polling stops, so a later expired_token (the spent code) is never seen.
      try {
        setKey(key, env, keyOpts);
        // A stale Keychain item that could not be replaced or deleted would still be read first.
        if (getKey(env, keyOpts) !== key) throw new Error("stored key is shadowed");
        // A fresh connection: the old one's failure is not this one's.
        writeConfig(
          { enabled: true, reconnect_required: false, backoff_until: 0, last_failed_at: 0 },
          env,
        );
      } catch {
        // The error may name paths but never the key; it is not printed either way.
        return finish(copy("cli.connect.store_failed"));
      }
      let merged = { result: "manual", snippet: snippet(env) };
      try {
        merged = mergeStatusline({ env });
      } catch {} // e.g. bin/ not writable: connected anyway, the snippet says what to add
      return finish(...mergeLines(merged), copy("cli.connect.done"));
    }
    if (!save()) return;
    const err = res ? res.data.error : undefined;
    if (!res || res.status >= 500 || (res.status !== 429 && typeof err !== "string")) {
      lost = true;
      continue;
    }
    if (res.status === 429) {
      st.not_before = now() + Math.max(st.interval * 1000, retryAfterMs(res.retryAfter));
      continue;
    }
    if (err === "authorization_pending") continue;
    if (err === "slow_down") {
      const asked = typeof res.data.interval === "number" ? res.data.interval : 0;
      st.interval = clampInterval(Math.max(st.interval + SLOW_DOWN_STEP_S, asked));
      continue;
    }
    if (err === "access_denied")
      // "Not my code" (or the /pair lockout) arrives with S6 as error_description "rejected";
      // a plain access_denied is Slack declining.
      return finish(
        copy(
          res.data.error_description === "rejected"
            ? "cli.connect.cancelled"
            : "cli.connect.denied",
        ),
      );
    if (err === "expired_token") return lost ? finish(copy("cli.connect.maybe_done")) : expired();
    return finish(copy("cli.connect.expired"));
  }
}
