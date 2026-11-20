import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copy } from "../scripts/copy.mjs";
import { openBrowser, safeUrl, startConnect, waitConnect } from "../scripts/connect.mjs";
import { paths, readConfig, sendReport } from "../scripts/lib.mjs";

// Made-up secrets: the tests assert neither ever reaches any output.
const KEY = "bsk_FAKE-connect-key-0123456789abcdefghijklmnopq";
const DEVICE = "ABCD2345.0123456789abcdefghijklmnopqrstuvwxyzABCDEFG";
const URL_COMPLETE = "https://worker.test/pair?code=ABCD-2345";
const DEVICE2 = "WXYZ6789.0123456789abcdefghijklmnopqrstuvwxyzABCDEFG";
const T0 = Date.parse("2026-11-20T10:00:00Z");
const PLUGIN = join(import.meta.dirname, "..");
const CTL = join(PLUGIN, "scripts", "ctl.mjs");
const FAKE_FETCH = join(import.meta.dirname, "fake-fetch.mjs");
const ESC = String.fromCharCode(27);

const START = {
  device_code: DEVICE,
  user_code: "ABCD-2345",
  verification_uri: "https://worker.test/pair",
  verification_uri_complete: URL_COMPLETE,
  expires_in: 900,
  interval: 5,
};
const pending = { status: 400, body: { error: "authorization_pending" } };
const keyAnswer = { status: 200, body: { plugin_key: KEY } };
const limited = { status: 429, body: { error: "rate_limited" }, headers: { "retry-after": "60" } };

function sandbox(t) {
  const root = mkdtempSync(join(tmpdir(), "burnstatus-connect-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const bs = join(root, "bs");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(bs, { recursive: true });
  writeFileSync(join(bs, "migrated"), "test\n"); // keeps ctl.mjs off the real Keychain
  // BURNSTATUS_HOME: the key goes to the 600 file, never the Keychain.
  const env = {
    HOME: home,
    PATH: process.env.PATH,
    BURNSTATUS_HOME: bs,
    BURNSTATUS_WORKER_URL: "https://worker.test",
  };
  let clock = T0;
  const sleeps = [];
  const requests = [];
  const lines = [];
  // Answers in order; an Error entry is thrown (network down); past the end: network down.
  const worker = (answers) => async (url, init) => {
    requests.push({
      path: new URL(url).pathname,
      body: init.body,
      at: clock,
      redirect: init.redirect,
    });
    const a = answers.shift();
    if (!a || a instanceof Error) throw a ?? new TypeError("fetch failed");
    return new Response(JSON.stringify(a.body ?? {}), {
      status: a.status,
      headers: a.headers ?? {},
    });
  };
  const deps = (answers, extra = {}) => ({
    env,
    fetchImpl: worker(answers),
    say: (l) => lines.push(l),
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    ...extra,
  });
  const pairingFile = join(bs, "pairing.json");
  return {
    root,
    home,
    bs,
    env,
    sleeps,
    requests,
    lines,
    deps,
    pairingFile,
    advance: (ms) => (clock += ms),
    keyFile: () =>
      existsSync(join(bs, "key")) ? readFileSync(join(bs, "key"), "utf8").trim() : null,
    writePairing: (over = {}) =>
      writeFileSync(
        pairingFile,
        JSON.stringify({
          device_code: DEVICE,
          interval: 5,
          expires_at: T0 + 900_000,
          last_poll_at: 0,
          not_before: 0,
          ...over,
        }),
      ),
  };
}

/** Everything written to stdout/stderr while fn runs (still forwarded). */
async function captureOutput(fn) {
  const out = [];
  const orig = { o: process.stdout.write, e: process.stderr.write };
  process.stdout.write = function (c, ...a) {
    out.push(String(c));
    return orig.o.call(this, c, ...a);
  };
  process.stderr.write = function (c, ...a) {
    out.push(String(c));
    return orig.e.call(this, c, ...a);
  };
  try {
    await fn();
  } finally {
    process.stdout.write = orig.o;
    process.stderr.write = orig.e;
  }
  return out.join("");
}

/** Every file under d, skipping directories named in skip. */
function walk(d, skip = []) {
  return readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    skip.includes(e.name) ? [] : e.isDirectory() ? walk(join(d, e.name), skip) : [join(d, e.name)],
  );
}

const slow = (body) => ({ status: 400, body: { error: "slow_down", ...body } });
const throwing = () => {
  throw new Error("ENOENT");
};

/** No file under the sandbox but the key file holds the key. */
function assertKeyOnlyInKeyFile(s) {
  for (const f of walk(s.root))
    if (f !== join(s.bs, "key")) assert.ok(!readFileSync(f, "utf8").includes(KEY), "key in " + f);
}

// ---- phase 1: start ----

test("start: POST /pair/start {}, then the code, opened, manual URL and waiting lines in order", async (t) => {
  const s = sandbox(t);
  const opened = [];
  await startConnect(s.deps([{ status: 200, body: START }], { open: (u) => opened.push(u) > 0 }));
  assert.deepEqual(
    s.requests.map((r) => [r.path, r.body]),
    [["/pair/start", "{}"]],
  );
  assert.deepEqual(opened, [URL_COMPLETE]);
  assert.deepEqual(s.lines, [
    copy("cli.connect.code", { code: "ABCD-2345" }),
    copy("cli.connect.opened"),
    copy("cli.connect.manual", { url: URL_COMPLETE }),
    copy("cli.connect.waiting"),
  ]);
  assert.ok(!s.lines.join("\n").includes(DEVICE), "device code printed");
  const p = JSON.parse(readFileSync(s.pairingFile, "utf8"));
  assert.equal(p.device_code, DEVICE);
  assert.equal(p.expires_at, T0 + 900_000);
  assert.equal(statSync(s.pairingFile).mode & 0o777, 0o600);
});

test("start: no browser could be started — no 'opened' line, the manual URL still prints", async (t) => {
  const s = sandbox(t);
  await startConnect(s.deps([{ status: 200, body: START }], { open: () => false }));
  assert.deepEqual(s.lines, [
    copy("cli.connect.code", { code: "ABCD-2345" }),
    copy("cli.connect.manual", { url: URL_COMPLETE }),
    copy("cli.connect.waiting"),
  ]);
});

test("start: 429 rate_limited waits Retry-After, then goes on", async (t) => {
  const s = sandbox(t);
  await startConnect(s.deps([limited, { status: 200, body: START }], { open: () => true }));
  assert.deepEqual(s.sleeps, [60_000]);
  assert.equal(s.lines[0], copy("cli.connect.code", { code: "ABCD-2345" }));
});

test("start: unreachable on network error, 5xx, endless 429 or a malformed answer; nothing opened", async (t) => {
  const cases = [
    [new TypeError("fetch failed")],
    [{ status: 503, body: { error: "temporarily_unavailable" } }],
    [limited, limited, limited],
    [{ status: 200, body: { ...START, user_code: ESC + "[31mHI" } }],
    [{ status: 200, body: { ...START, device_code: "nope" } }],
    [{ status: 200, body: { ...START, verification_uri_complete: "http://plain.test/pair" } }],
    [
      {
        status: 200,
        body: { ...START, verification_uri_complete: "https://worker.test/pair?a=1&b=2" },
      },
    ],
    [{ status: 200, body: { ...START, verification_uri_complete: "https://evil.example/pair" } }],
    [
      {
        status: 200,
        body: { ...START, verification_uri_complete: "https://worker.test:8443/pair" },
      },
    ],
    [{ status: 200, body: "not json at all" }],
  ];
  for (const answers of cases) {
    const s = sandbox(t);
    const opened = [];
    // oxlint-disable-next-line no-await-in-loop
    await startConnect(s.deps(answers, { open: (u) => opened.push(u) > 0 }));
    assert.deepEqual(s.lines, [copy("cli.connect.unreachable")], JSON.stringify(answers));
    assert.deepEqual(opened, []);
    assert.ok(!existsSync(s.pairingFile));
  }
});

test("start: with no override the origin pin is api.burnstatus.uk (S18); the retired workers.dev origin is refused", async (t) => {
  const at = (origin) => ({
    ...START,
    verification_uri: origin + "/pair",
    verification_uri_complete: origin + "/pair?code=ABCD-2345",
  });
  const api = "https://api.burnstatus.uk";
  const retired = "https://burnstatus-api.hutsulsoft-snagon.workers.dev";
  const cases = [
    // [BURNSTATUS_WORKER_URL, answer, opened]
    [undefined, at(api), true],
    [undefined, at(retired), false],
    // An override left over from before S18 talks to the new origin and pins it.
    [retired, at(api), true],
    [retired, at(retired), false],
  ];
  for (const [override, answer, opens] of cases) {
    const s = sandbox(t);
    delete s.env.BURNSTATUS_WORKER_URL;
    if (override) s.env.BURNSTATUS_WORKER_URL = override;
    const urls = [];
    const opened = [];
    // oxlint-disable-next-line no-await-in-loop
    await startConnect({
      ...s.deps([], { open: (u) => opened.push(u) > 0 }),
      fetchImpl: async (url) => {
        urls.push(url);
        return new Response(JSON.stringify(answer), { status: 200 });
      },
    });
    assert.deepEqual(urls, [api + "/pair/start"], String(override));
    assert.equal(opened.length, opens ? 1 : 0, answer.verification_uri);
    assert.equal(existsSync(s.pairingFile), opens);
  }
});

test("start: already connected says so and calls nothing; reconnect_required starts a new pairing", async (t) => {
  const s = sandbox(t);
  writeFileSync(join(s.bs, "key"), KEY + "\n", { mode: 0o600 });
  await startConnect(s.deps([{ status: 200, body: START }], { open: () => true }));
  assert.deepEqual(s.lines, [copy("cli.connect.already")]);
  assert.equal(s.requests.length, 0);
  writeFileSync(join(s.bs, "config.json"), JSON.stringify({ reconnect_required: true }));
  s.lines.length = 0;
  await startConnect(s.deps([{ status: 200, body: START }], { open: () => true }));
  assert.equal(s.lines[0], copy("cli.connect.code", { code: "ABCD-2345" }));
});

// ---- phase 2: wait ----

test("wait: pending, pending, slow_down, key — polls at interval, +5 s after slow_down; key stored, never printed", async (t) => {
  const s = sandbox(t);
  s.writePairing();
  const answers = [
    pending,
    pending,
    { status: 400, body: { error: "slow_down", interval: 10 } },
    keyAnswer,
  ];
  const out = await captureOutput(() => waitConnect(s.deps(answers)));
  assert.deepEqual(
    s.requests.map((r) => r.path),
    Array(4).fill("/pair/poll"),
  );
  assert.deepEqual(JSON.parse(s.requests[0].body), { device_code: DEVICE });
  // First poll at once (the user had time to click), then 5 s apart, 10 s after slow_down.
  assert.deepEqual(
    s.requests.map((r) => r.at - T0),
    [0, 5000, 10_000, 20_000],
  );
  assert.deepEqual(s.lines, [copy("cli.connect.statusline_created"), copy("cli.connect.done")]);
  assert.equal(s.keyFile(), KEY);
  assert.equal(statSync(join(s.bs, "key")).mode & 0o777, 0o600);
  assert.ok(!existsSync(s.pairingFile), "pairing state left behind");
  assert.ok(!out.includes(KEY) && !s.lines.join("\n").includes(KEY), "key written to output");
  assertKeyOnlyInKeyFile(s);
  const cfg = readConfig(s.env);
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.reconnect_required, false);
  // The S8 merge ran: settings.json points at the copied statusline.
  const settings = JSON.parse(readFileSync(join(s.home, ".claude", "settings.json"), "utf8"));
  assert.match(settings.statusLine.command, /statusline\.mjs"$/);
});

test("wait: slow_down without an interval still adds 5 s; the interval never shrinks", async (t) => {
  const s = sandbox(t);
  s.writePairing();
  await waitConnect(s.deps([slow({}), slow({ interval: 3 }), keyAnswer]));
  assert.deepEqual(
    s.requests.map((r) => r.at - T0),
    [0, 10_000, 25_000],
  );
});

test("wait: access_denied is denied; access_denied marked rejected is cancelled; nothing stored", async (t) => {
  for (const [body, line] of [
    [{ error: "access_denied" }, "cli.connect.denied"],
    [{ error: "access_denied", error_description: "rejected" }, "cli.connect.cancelled"],
  ]) {
    const s = sandbox(t);
    s.writePairing();
    // oxlint-disable-next-line no-await-in-loop
    await waitConnect(s.deps([pending, { status: 400, body }]));
    assert.deepEqual(s.lines, [copy(line)]);
    assert.equal(s.keyFile(), null);
    assert.ok(!existsSync(s.pairingFile));
  }
});

test("wait: expired_token before the key is held — expired plus the approval hint", async (t) => {
  const s = sandbox(t);
  s.writePairing();
  await waitConnect(s.deps([pending, { status: 400, body: { error: "expired_token" } }]));
  assert.deepEqual(s.lines, [copy("cli.connect.expired"), copy("cli.connect.approval_hint")]);
  assert.equal(s.keyFile(), null);
  assert.ok(!existsSync(s.pairingFile));
});

test("wait: once the key is held, polling stops — a later expired_token is never asked for", async (t) => {
  const s = sandbox(t);
  s.writePairing();
  await waitConnect(s.deps([keyAnswer, { status: 400, body: { error: "expired_token" } }]));
  assert.equal(s.requests.length, 1);
  assert.equal(s.lines.at(-1), copy("cli.connect.done"));
});

test("wait: lost mid-poll (network errors, 5xx) keeps polling until expiry, then expired + hint", async (t) => {
  const s = sandbox(t);
  s.writePairing({ expires_at: T0 + 60_000 });
  const answers = Array.from({ length: 40 }, (_, i) =>
    i % 2 ? new TypeError("fetch failed") : { status: 502, body: {} },
  );
  await waitConnect(s.deps(answers));
  assert.equal(s.requests.length, 12); // 0, 5, ..., 55 s
  assert.deepEqual(s.lines, [copy("cli.connect.expired"), copy("cli.connect.approval_hint")]);
});

test("wait: 429 rate_limited on /pair/poll waits Retry-After before the next poll", async (t) => {
  const s = sandbox(t);
  s.writePairing();
  await waitConnect(s.deps([pending, limited, pending, keyAnswer]));
  assert.deepEqual(
    s.requests.map((r) => r.at - T0),
    [0, 5000, 65_000, 70_000],
  );
  assert.equal(s.keyFile(), KEY);
});

test("wait: a 200 without a well-formed key is unreachable; nothing stored", async (t) => {
  const s = sandbox(t);
  s.writePairing();
  await waitConnect(s.deps([{ status: 200, body: { plugin_key: ESC + "]0;x" } }]));
  assert.deepEqual(s.lines, [copy("cli.connect.unreachable")]);
  assert.equal(s.keyFile(), null);
});

test("wait: an unknown 4xx answer ends with expired (no approval hint)", async (t) => {
  const s = sandbox(t);
  s.writePairing();
  await waitConnect(s.deps([{ status: 400, body: { error: "invalid_request" } }]));
  assert.deepEqual(s.lines, [copy("cli.connect.expired")]);
});

test("wait: budget spent while pending — waiting line, state kept; the next run keeps the interval", async (t) => {
  const s = sandbox(t);
  s.writePairing();
  await waitConnect(s.deps([pending, pending, pending], { budgetMs: 12_000 }));
  assert.deepEqual(s.lines, [copy("cli.connect.waiting")]);
  assert.deepEqual(
    s.requests.map((r) => r.at - T0),
    [0, 5000, 10_000],
  );
  const saved = JSON.parse(readFileSync(s.pairingFile, "utf8"));
  assert.equal(saved.last_poll_at, T0 + 10_000);
  s.advance(1000); // the skill re-runs it a second later
  s.lines.length = 0;
  await waitConnect(s.deps([keyAnswer]));
  assert.equal(s.requests.at(-1).at - T0, 15_000, "polled before the interval was over");
  assert.equal(s.lines.at(-1), copy("cli.connect.done"));
});

test("wait: no pairing in progress — expired, nothing called", async (t) => {
  const s = sandbox(t);
  await waitConnect(s.deps([keyAnswer]));
  assert.deepEqual(s.lines, [copy("cli.connect.expired")]);
  assert.equal(s.requests.length, 0);
});

test("wait: each statusLine merge outcome prints its line, and connect still finishes", async (t) => {
  const cases = [
    [{ statusLine: { type: "command", command: "bash ~/x.sh" } }, "cli.connect.statusline_wrapped"],
    [{ statusLine: { type: "static", text: "hi" } }, "cli.connect.statusline_kept"],
    ["{oops", "cli.connect.statusline_manual"],
  ];
  for (const [settings, key] of cases) {
    const s = sandbox(t);
    writeFileSync(
      join(s.home, ".claude", "settings.json"),
      typeof settings === "string" ? settings : JSON.stringify(settings),
    );
    s.writePairing();
    // oxlint-disable-next-line no-await-in-loop
    await waitConnect(s.deps([keyAnswer]));
    assert.ok(s.lines[0].startsWith(copy(key).replace(/\{path\}$/, "")), key + ": " + s.lines[0]);
    assert.equal(s.lines.at(-1), copy("cli.connect.done"));
    assert.equal(s.keyFile(), KEY);
  }
  const s = sandbox(t);
  s.writePairing();
  await waitConnect(s.deps([keyAnswer]));
  s.writePairing();
  writeFileSync(join(s.bs, "config.json"), JSON.stringify({ reconnect_required: true }));
  s.lines.length = 0;
  await waitConnect(s.deps([keyAnswer]));
  assert.deepEqual(s.lines, [copy("cli.connect.statusline_ours"), copy("cli.connect.done")]);
});

test("after a 401, connecting again clears the reconnect state and reports resume", async (t) => {
  const s = sandbox(t);
  writeFileSync(join(s.bs, "key"), "bsk_old-dead-key-000000000000000000\n", { mode: 0o600 });
  writeFileSync(
    join(s.bs, "cache.json"),
    JSON.stringify({ five_hour_pct: 9, weekly_pct: 40, weekly_resets_at: T0 / 1000 + 86400 }),
  );
  const report = (status) =>
    sendReport({ env: s.env, now: T0, fetchImpl: async () => new Response("{}", { status }) });
  assert.equal(await report(401), "http 401");
  assert.equal(readConfig(s.env).reconnect_required, true);
  s.writePairing();
  await waitConnect(s.deps([keyAnswer]));
  assert.equal(readConfig(s.env).reconnect_required, false);
  assert.equal(s.keyFile(), KEY);
  assert.equal(await report(200), "http 200");
});

test("wait: a newer connect replaced pairing.json mid-poll — the stale wait leaves it alone and says nothing", async (t) => {
  const s = sandbox(t);
  s.writePairing();
  const newer = () => s.writePairing({ device_code: DEVICE2, last_poll_at: 0 });
  const deps = s.deps([pending, pending]);
  const inner = deps.fetchImpl;
  deps.fetchImpl = async (url, init) => {
    const res = await inner(url, init);
    newer(); // `connect` ran again in another session while this poll was in flight
    return res;
  };
  await waitConnect(deps);
  assert.equal(s.requests.length, 1);
  assert.deepEqual(s.lines, []);
  assert.equal(JSON.parse(readFileSync(s.pairingFile, "utf8")).device_code, DEVICE2);
  assert.equal(JSON.parse(readFileSync(s.pairingFile, "utf8")).last_poll_at, 0);
});

test("wait: replaced during the sleep — no poll with the old code, newer pairing kept", async (t) => {
  const s = sandbox(t);
  s.writePairing();
  const deps = s.deps([pending, { status: 400, body: { error: "access_denied" } }]);
  const sleep = deps.sleep;
  deps.sleep = async (ms) => {
    await sleep(ms);
    s.writePairing({ device_code: DEVICE2 });
  };
  await waitConnect(deps);
  assert.equal(s.requests.length, 1, "polled again after the pairing was replaced");
  assert.deepEqual(s.lines, []);
  assert.ok(existsSync(s.pairingFile), "the newer pairing was deleted");
});

test("wait: the key cannot be stored — store_failed, pairing.json removed, nothing half-written", async (t) => {
  const s = sandbox(t);
  mkdirSync(join(s.bs, "key")); // writing the key file fails (EISDIR); no Keychain under BURNSTATUS_HOME
  s.writePairing();
  const out = await captureOutput(() => waitConnect(s.deps([keyAnswer])));
  assert.deepEqual(s.lines, [copy("cli.connect.store_failed")]);
  assert.ok(!existsSync(s.pairingFile));
  assert.ok(!existsSync(join(s.home, ".claude", "settings.json")), "merge ran without a key");
  assert.ok(!out.includes(KEY));
  assertKeyOnlyInKeyFile(s);
});

test("every request refuses redirects; the key file is tmp+renamed into a dir forced to 0700", async (t) => {
  const s = sandbox(t);
  chmodSync(s.bs, 0o755);
  s.writePairing();
  await waitConnect(s.deps([keyAnswer]));
  assert.deepEqual(
    s.requests.map((r) => r.redirect),
    ["error"],
  );
  assert.equal(statSync(s.bs).mode & 0o777, 0o700);
  assert.deepEqual(
    readdirSync(s.bs).filter((f) => f.endsWith(".tmp")),
    [],
  );
  assert.ok(!existsSync(join(s.bs, "pairing.lock")), "lock not released");
});

test("start: a failed /pair/start leaves a live pairing from an earlier connect running", async (t) => {
  for (const answers of [
    [new TypeError("fetch failed")],
    [{ status: 200, body: { ...START, verification_uri_complete: "https://evil.example/pair" } }],
  ]) {
    const s = sandbox(t);
    s.writePairing();
    // oxlint-disable-next-line no-await-in-loop
    await startConnect(s.deps(answers, { open: () => true }));
    assert.deepEqual(s.lines, [copy("cli.connect.unreachable")]);
    assert.equal(JSON.parse(readFileSync(s.pairingFile, "utf8")).device_code, DEVICE);
  }
});

test("wait: expired_token after a lost answer (network, 5xx) is maybe_done, not expired", async (t) => {
  for (const lost of [new TypeError("fetch failed"), { status: 502, body: {} }]) {
    const s = sandbox(t);
    s.writePairing();
    // oxlint-disable-next-line no-await-in-loop
    await waitConnect(s.deps([pending, lost, { status: 400, body: { error: "expired_token" } }]));
    assert.deepEqual(s.lines, [copy("cli.connect.maybe_done")]);
    assert.ok(!existsSync(s.pairingFile));
  }
});

test("wait: a 4xx that is not the Worker's JSON (challenge page, 404) is retried, not final", async (t) => {
  const s = sandbox(t);
  s.writePairing();
  await waitConnect(
    s.deps([{ status: 404, body: "Not Found" }, { status: 403, body: {} }, keyAnswer]),
  );
  assert.equal(s.requests.length, 3);
  assert.equal(s.lines.at(-1), copy("cli.connect.done"));
  assert.equal(s.keyFile(), KEY);
});

test("wait: a live --wait holds pairing.lock — a second one exits quietly and touches nothing", async (t) => {
  const s = sandbox(t);
  s.writePairing();
  const lockFile = join(s.bs, "pairing.lock");
  writeFileSync(lockFile, String(process.ppid)); // a live process that is not this one
  const before = readFileSync(s.pairingFile, "utf8");
  await waitConnect(s.deps([keyAnswer]));
  assert.equal(s.requests.length, 0);
  assert.deepEqual(s.lines, []);
  assert.equal(readFileSync(s.pairingFile, "utf8"), before);
  assert.equal(readFileSync(lockFile, "utf8"), String(process.ppid), "someone else's lock removed");
});

test("wait: two waits on the same pairing — only the lock holder polls and reports", async (t) => {
  const s = sandbox(t);
  s.writePairing();
  let release;
  const gate = new Promise((r) => (release = r));
  const deps = s.deps([pending, keyAnswer]);
  const inner = deps.fetchImpl;
  deps.fetchImpl = async (url, init) => {
    await gate;
    return inner(url, init);
  };
  const a = waitConnect(deps);
  await new Promise((r) => setImmediate(r));
  const bLines = [];
  await waitConnect({
    ...s.deps([{ status: 400, body: { error: "expired_token" } }]),
    say: (l) => bLines.push(l),
  });
  assert.deepEqual(bLines, [], "the second wait printed something");
  release();
  await a;
  assert.equal(s.lines.at(-1), copy("cli.connect.done"));
  assert.equal(s.keyFile(), KEY);
  assert.ok(!existsSync(join(s.bs, "pairing.lock")));
});

test("wait: a lock left by a dead process is taken over", async (t) => {
  const s = sandbox(t);
  s.writePairing();
  const dead = spawnSync(process.execPath, ["-e", ""]).pid;
  writeFileSync(join(s.bs, "pairing.lock"), String(dead));
  await waitConnect(s.deps([keyAnswer]));
  assert.equal(s.lines.at(-1), copy("cli.connect.done"));
  assert.ok(!existsSync(join(s.bs, "pairing.lock")));
});

test("wait: a stale Keychain item that can be neither replaced nor deleted — store_failed, reconnect kept", async (t) => {
  const s = sandbox(t);
  // Fake macOS security: find always answers the old key; add and delete always fail.
  const sec = join(s.root, "security");
  writeFileSync(
    sec,
    '#!/usr/bin/env node\nif (process.argv[2] === "find-generic-password") process.stdout.write("bsk_old-stale-key-00000000000000\\n");\nelse process.exit(1);\n',
  );
  chmodSync(sec, 0o755);
  const env = {
    HOME: s.home,
    PATH: process.env.PATH,
    BURNSTATUS_WORKER_URL: "https://worker.test",
  };
  const keyOpts = { platform: "darwin", securityBin: sec };
  const p = paths(env);
  mkdirSync(join(s.home, ".claude", "burnstatus"), { recursive: true });
  writeFileSync(p.config, JSON.stringify({ reconnect_required: true }));
  writeFileSync(
    p.pairing,
    JSON.stringify({ device_code: DEVICE, interval: 5, expires_at: T0 + 900_000 }),
  );
  await waitConnect({ ...s.deps([keyAnswer]), env, keyOpts });
  assert.deepEqual(s.lines, [copy("cli.connect.store_failed")]);
  assert.equal(readConfig(env).reconnect_required, true);
  assert.ok(!existsSync(p.pairing));
  assert.ok(!existsSync(join(s.home, ".claude", "settings.json")), "merge ran");
});

// ---- the real process: ctl.mjs connect --wait, real stdout ----

test("ctl.mjs connect --wait: real stdout holds the copy lines and never the key", (t) => {
  const s = sandbox(t);
  s.writePairing({ expires_at: Date.now() + 900_000 });
  const log = join(s.root, "fetch.log");
  const res = spawnSync(process.execPath, ["--import", FAKE_FETCH, CTL, "connect", "--wait"], {
    env: { ...s.env, FAKE_FETCH: JSON.stringify([keyAnswer]), FAKE_FETCH_LOG: log },
    encoding: "utf8",
  });
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(res.stdout.trim().split("\n"), [
    copy("cli.connect.statusline_created"),
    copy("cli.connect.done"),
  ]);
  assert.ok(!res.stdout.includes(KEY) && !res.stderr.includes(KEY));
  assert.equal(readFileSync(log, "utf8"), "/pair/poll\n");
  assert.equal(s.keyFile(), KEY);
  assertKeyOnlyInKeyFile(s);
});

test("ctl.mjs connect ignores a pasted key argument: it is neither stored nor echoed", (t) => {
  const s = sandbox(t);
  const res = spawnSync(process.execPath, ["--import", FAKE_FETCH, CTL, "connect", KEY], {
    env: { ...s.env, FAKE_FETCH: "[]" },
    encoding: "utf8",
  });
  assert.deepEqual(res.stdout.trim().split("\n"), [copy("cli.connect.unreachable")]);
  assert.ok(!res.stdout.includes(KEY) && !res.stderr.includes(KEY));
  assert.equal(s.keyFile(), null);
});

// ---- browser opener ----

/** A fake child process that reports 'spawn' (opener started) or 'error' (opener missing). */
function fakeChild(event) {
  const child = new EventEmitter();
  child.unref = () => {};
  process.nextTick(() => child.emit(event, ...(event === "error" ? [new Error("ENOENT")] : [])));
  return child;
}

test("the opener gets the URL as one argv entry, never a shell string; unsafe URLs are refused", async () => {
  const calls = [];
  const spawnImpl = (bin, args, opts) => {
    calls.push([bin, args, opts.shell]);
    return fakeChild("spawn");
  };
  assert.equal(await openBrowser(URL_COMPLETE, { platform: "darwin", spawnImpl }), true);
  assert.equal(await openBrowser(URL_COMPLETE, { platform: "linux", spawnImpl }), true);
  assert.equal(await openBrowser(URL_COMPLETE, { platform: "win32", spawnImpl }), true);
  assert.deepEqual(calls, [
    ["open", [URL_COMPLETE], undefined],
    ["xdg-open", [URL_COMPLETE], undefined],
    ["cmd.exe", ["/d", "/c", "start", "", URL_COMPLETE], undefined],
  ]);
  for (const bad of [
    "https://x.test/pair?code=A&calc",
    'https://x.test/"x',
    "https://x.test/%25",
    "file:///etc/passwd",
    "javascript:alert(1)",
  ])
    // oxlint-disable-next-line no-await-in-loop
    assert.equal(await openBrowser(bad, { platform: "win32", spawnImpl }), false, bad);
  assert.equal(calls.length, 3);
  assert.equal(safeUrl(URL_COMPLETE), URL_COMPLETE);
  assert.equal(await openBrowser(URL_COMPLETE, { platform: "linux", spawnImpl: throwing }), false);
});

test("a missing opener binary ('error' instead of 'spawn') is not claimed as opened", async (t) => {
  assert.equal(
    await openBrowser(URL_COMPLETE, { platform: "linux", spawnImpl: () => fakeChild("error") }),
    false,
  );
  const s = sandbox(t);
  const open = (u) => openBrowser(u, { platform: "linux", spawnImpl: () => fakeChild("error") });
  await startConnect(s.deps([{ status: 200, body: START }], { open }));
  assert.deepEqual(s.lines, [
    copy("cli.connect.code", { code: "ABCD-2345" }),
    copy("cli.connect.manual", { url: URL_COMPLETE }),
    copy("cli.connect.waiting"),
  ]);
});

// ---- the paste path is gone ----

test("no plugin file references /oauth/start or a pasted key any more", () => {
  for (const f of walk(PLUGIN, ["test", "node_modules", ".turbo"])) {
    const text = readFileSync(f, "utf8");
    assert.ok(!text.includes("/oauth/start"), f + " names /oauth/start");
    assert.ok(!/connect <key>|\$ARGUMENTS|plugin key\]/.test(text), f + " keeps the paste path");
  }
});
