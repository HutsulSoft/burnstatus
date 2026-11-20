import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COPY, EMPTY, copy } from "../scripts/copy.mjs";
import { waitConnect } from "../scripts/connect.mjs";
import { readConfig, sendReport } from "../scripts/lib.mjs";

// A made-up key: the tests assert it never reaches any output.
const KEY = "bsk_FAKE-ctl-key-0123456789abcdefghijklmnopqrst";
const NEW_KEY = "bsk_FAKE-ctl-new-key-0123456789abcdefghijklmn";
const PLUGIN = join(import.meta.dirname, "..");
const CTL = join(PLUGIN, "scripts", "ctl.mjs");
const FAKE_FETCH = join(import.meta.dirname, "fake-fetch.mjs");
const DECK = join(PLUGIN, "..", "docs", "03-ux.md");
const SENT = Date.parse("2026-11-20T10:04:00Z");
const FAILED = Date.parse("2026-11-20T11:30:00Z");
const worker = (status) => async () => new Response("{}", { status });
const r401 = async () =>
  new Response(JSON.stringify({ error: "reconnect_required" }), { status: 401 });

function sandbox(t, { key = true } = {}) {
  const home = mkdtempSync(join(tmpdir(), "burnstatus-ctl-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  // BURNSTATUS_HOME keeps the key in the 600 file, never the Keychain; TZ pins {time}.
  const env = { HOME: home, BURNSTATUS_HOME: home, BURNSTATUS_WORKER_URL: "https://worker.test" };
  writeFileSync(join(home, "migrated"), "test\n");
  if (key) writeFileSync(join(home, "key"), KEY + "\n", { mode: 0o600 });
  const log = join(home, "fetch.log");
  const ctl = (cmd, answers = []) => {
    const out = spawnSync(process.execPath, ["--import", FAKE_FETCH, CTL, cmd], {
      env: {
        PATH: process.env.PATH,
        TZ: "UTC",
        ...env,
        FAKE_FETCH: JSON.stringify(answers),
        FAKE_FETCH_LOG: log,
      },
      encoding: "utf8",
    });
    assert.equal(out.status, 0, out.stderr);
    assert.ok(!out.stdout.includes(KEY) && !out.stderr.includes(KEY), "key printed");
    return out.stdout.trimEnd().split("\n");
  };
  const requests = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);
  const cache = (agoS, five = 4, week = 86) => {
    const now = Math.floor(Date.now() / 1000);
    writeFileSync(
      join(home, "cache.json"),
      JSON.stringify({
        five_hour_pct: five,
        five_hour_resets_at: now + 3600,
        weekly_pct: week,
        weekly_resets_at: now + 86400,
        updated_at: now - agoS,
      }),
    );
  };
  const config = (c) => writeFileSync(join(home, "config.json"), JSON.stringify(c));
  return { home, env, ctl, requests, cache, config };
}

test("status in local mode: says so and how to connect, never a send line", (t) => {
  const s = sandbox(t, { key: false });
  assert.deepEqual(s.ctl("status"), [copy("cli.status.local"), EMPTY["cli.status.limits"]]);
  s.cache(180);
  assert.deepEqual(s.ctl("status"), [
    copy("cli.status.local"),
    "Last limits: 5h ▓░░░░ 4% · wk ▓▓▓▓░ 86% (3 min ago)",
  ]);
  assert.deepEqual(s.requests(), [], "status never calls the Worker");
});

test("status when connected: on/off, limits with their age, last send time", (t) => {
  const s = sandbox(t);
  assert.deepEqual(s.ctl("status"), [
    "Connected to Slack. Updates: on.",
    EMPTY["cli.status.limits"],
    EMPTY["cli.status.sent"],
  ]);
  s.cache(7200, 50, 10);
  s.config({ enabled: false, last_sent_at: SENT });
  assert.deepEqual(s.ctl("status"), [
    "Connected to Slack. Updates: off.",
    "Last limits: 5h ▓▓▓░░ 50% · wk ▓░░░░ 10% (2 h ago)",
    "Last sent to Slack: 2026-11-20 10:04",
  ]);
  assert.deepEqual(s.requests(), []);
});

test("a failed send is recorded and shown by status until a send succeeds", async (t) => {
  const s = sandbox(t);
  s.cache(30);
  const env = s.env;
  assert.equal(await sendReport({ env, now: SENT, fetchImpl: worker(200) }), "http 200");
  assert.equal(await sendReport({ env, now: FAILED, fetchImpl: worker(502) }), "http 502");
  assert.equal(readConfig(env).last_failed_at, FAILED);
  assert.deepEqual(s.ctl("status").slice(2), [
    "Last sent to Slack: 2026-11-20 10:04",
    copy("cli.status.failed", { time: "2026-11-20 11:30" }),
  ]);
  const later = FAILED + 3600_000; // past the 502's backoff
  assert.equal(await sendReport({ env, now: later, fetchImpl: worker(200) }), "http 200");
  assert.equal(s.ctl("status").length, 3, "no failed line after a success");
});

test("no answer at all also records the failure time, without the error text", async (t) => {
  const s = sandbox(t);
  s.cache(30);
  const down = async () => {
    throw new TypeError("fetch failed " + KEY);
  };
  assert.equal(
    await sendReport({ env: s.env, now: FAILED, fetchImpl: down }),
    "error: unreachable",
  );
  assert.equal(readConfig(s.env).last_failed_at, FAILED);
  assert.ok(!readFileSync(join(s.home, "config.json"), "utf8").includes(KEY));
  assert.equal(s.ctl("status").at(-1), copy("cli.status.failed", { time: "2026-11-20 11:30" }));
});

test("a 401 reconnect_required is remembered: status shows the reconnect line instead", async (t) => {
  const s = sandbox(t);
  s.cache(30);
  assert.equal(await sendReport({ env: s.env, now: FAILED, fetchImpl: r401 }), "http 401");
  const cfg = readConfig(s.env);
  assert.equal(cfg.reconnect_required, true);
  assert.equal(cfg.last_failed_at, FAILED);
  const out = s.ctl("status");
  assert.equal(out[0], copy("cli.status.reconnect"));
  assert.ok(!out.some((l) => l.startsWith("Connected")), "not shown as connected");
  assert.ok(!out.includes(copy("cli.status.failed", { time: "2026-11-20 11:30" })));
  assert.equal(out.at(-1), EMPTY["cli.status.sent"]);
});

test("a fresh connect after a 401 drops the old connection's failure from status", async (t) => {
  const s = sandbox(t);
  s.cache(30);
  assert.equal(await sendReport({ env: s.env, now: FAILED, fetchImpl: r401 }), "http 401");
  writeFileSync(
    join(s.home, "pairing.json"),
    JSON.stringify({
      device_code: "ABCD2345.0123456789abcdefghijklmnopqrstuvwxyzABCDEFG",
      interval: 5,
      expires_at: Date.now() + 900_000,
      last_poll_at: 0,
      not_before: 0,
    }),
  );
  const lines = [];
  const keyAnswer = async () =>
    new Response(JSON.stringify({ plugin_key: NEW_KEY }), { status: 200 });
  await waitConnect({ env: s.env, fetchImpl: keyAnswer, say: (l) => lines.push(l) });
  assert.equal(lines.at(-1), copy("cli.connect.done"));
  const cfg = readConfig(s.env);
  assert.equal(cfg.reconnect_required, false);
  assert.equal(cfg.last_failed_at, 0);
  const out = s.ctl("status");
  assert.equal(out[0], "Connected to Slack. Updates: on.");
  assert.ok(!out.some((l) => l.startsWith("The last send failed")), "old failure shown");
  assert.ok(!out.join("\n").includes(NEW_KEY));
});

test("on and off flip Slack updates locally; off says the status clears within 3 hours", (t) => {
  const s = sandbox(t);
  assert.deepEqual(s.ctl("off"), [copy("cli.off")]);
  assert.match(copy("cli.off"), /within 3 hours of the last update/);
  assert.equal(readConfig(s.env).enabled, false);
  assert.deepEqual(s.ctl("on"), [copy("cli.on")]);
  assert.equal(readConfig(s.env).enabled, true);
  assert.deepEqual(s.requests(), [], "on/off work offline");
});

test("on, off and disconnect without a connection say not connected and change nothing", (t) => {
  const s = sandbox(t, { key: false });
  for (const cmd of ["on", "off", "disconnect"])
    assert.deepEqual(s.ctl(cmd), [copy("cli.not_connected")], cmd);
  assert.ok(!existsSync(join(s.home, "config.json")), "no config written");
  assert.deepEqual(s.requests(), []);
});

test("disconnect: the Worker's ok gives the done line; key and reconnect flag are gone", (t) => {
  const s = sandbox(t);
  s.config({ reconnect_required: true, last_failed_at: FAILED });
  const answer = { status: 200, body: { ok: true, cleared: true, revoked: true } };
  assert.deepEqual(s.ctl("disconnect", [answer]), [copy("cli.disconnect.done")]);
  assert.deepEqual(s.requests(), ["/disconnect"]);
  assert.ok(!existsSync(join(s.home, "key")));
  const cfg = readConfig(s.env);
  assert.equal(cfg.reconnect_required, false);
  assert.equal(cfg.last_failed_at, 0);
  assert.deepEqual(s.ctl("status")[0], copy("cli.status.local"));
});

test("disconnect: a Worker 401 (record already erased) is disconnected too", (t) => {
  const s = sandbox(t);
  s.config({ reconnect_required: true });
  const gone = { status: 401, body: { error: "unauthorized" } };
  assert.deepEqual(s.ctl("disconnect", [gone]), [copy("cli.disconnect.done")]);
  assert.deepEqual(s.requests(), ["/disconnect"]);
  assert.ok(!existsSync(join(s.home, "key")));
  assert.equal(readConfig(s.env).reconnect_required, false);
});

test("disconnect with the Worker unreachable or failing still removes the key locally", (t) => {
  for (const answers of [[], [{ status: 500, body: { error: "x" } }]]) {
    const s = sandbox(t);
    assert.deepEqual(s.ctl("disconnect", answers), [copy("cli.disconnect.unreachable")]);
    assert.deepEqual(s.requests(), ["/disconnect"]);
    assert.ok(!existsSync(join(s.home, "key")));
  }
});

test("connect with an unusable override says so in plain words and calls nothing", (t) => {
  for (const bad of ["http://plain.test", "https://burnstatus.example.invalid"]) {
    const s = sandbox(t, { key: false });
    s.env.BURNSTATUS_WORKER_URL = bad;
    assert.deepEqual(s.ctl("connect"), [
      "BURNSTATUS_WORKER_URL is not a usable https address. Fix it, or unset it to use https://api.burnstatus.uk.",
    ]);
    assert.deepEqual(s.requests(), []);
  }
});

// The deck in 03-ux.md is the source; copy.mjs holds its cli.* strings verbatim. The deck is not
// in the public plugin repo (S20), so the check runs only where it exists.
test("every cli.* string is the 03 copy deck's text, verbatim", { skip: !existsSync(DECK) }, () => {
  const deck = {};
  for (const line of readFileSync(DECK, "utf8").split("\n")) {
    const m = line.match(/^\|\s*(cli\.[\w.]+)\s*\|[^|]*\|\s*(.*?)\s*\|[^|]*\|\s*$/);
    if (m) deck[m[1]] = m[2];
  }
  for (const k of [
    "cli.status.connected",
    "cli.status.local",
    "cli.status.limits",
    "cli.status.sent",
    "cli.status.reconnect",
    "cli.status.failed",
    "cli.on",
    "cli.off",
    "cli.disconnect.done",
    "cli.disconnect.unreachable",
    "cli.not_connected",
  ])
    assert.ok(k in deck, k + " missing from the deck");
  for (const [k, text] of Object.entries(deck)) assert.equal(COPY[k], text, k);
});
