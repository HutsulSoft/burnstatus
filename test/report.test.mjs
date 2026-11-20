import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfig, sendReport } from "../scripts/lib.mjs";

// A made-up key: the tests assert it never lands in the config, the debug log or any output.
const KEY = "bsk_FAKE-report-key-0123456789abcdef";
const NOW = Date.now();
const NOW_S = Math.floor(NOW / 1000);
const CTL = join(import.meta.dirname, "..", "scripts", "ctl.mjs");
const STATUSLINE = join(import.meta.dirname, "..", "scripts", "statusline.mjs");

function sandbox(t) {
  const home = mkdtempSync(join(tmpdir(), "burnstatus-report-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = {
    HOME: home,
    BURNSTATUS_HOME: home,
    BURNSTATUS_WORKER_URL: "https://worker.test",
    BURNSTATUS_DEBUG: "1",
  };
  writeFileSync(join(home, "key"), KEY + "\n", { mode: 0o600 });
  writeFileSync(join(home, "migrated"), "x\n");
  writeFileSync(
    join(home, "cache.json"),
    JSON.stringify({
      five_hour_pct: 90,
      five_hour_resets_at: NOW_S + 3600,
      weekly_pct: 40,
      weekly_resets_at: NOW_S + 86400,
    }),
  );
  const calls = [];
  const worker =
    (status, headers = {}) =>
    async (url, init) => {
      calls.push({ url, body: init.body });
      return new Response("{}", { status, headers });
    };
  const run = (status, at = NOW, headers) =>
    sendReport({ env, now: at, fetchImpl: worker(status, headers) });
  const ctl = (cmd) =>
    spawnSync(process.execPath, [CTL, cmd], { env: { ...process.env, ...env }, encoding: "utf8" });
  const noLeak = () => {
    for (const f of ["config.json", "debug.log"]) {
      let text = "";
      try {
        text = readFileSync(join(home, f), "utf8");
      } catch {}
      assert.ok(!text.includes(KEY), "key leaked into " + f);
    }
  };
  return { home, env, calls, run, ctl, noLeak };
}

test("a 200 records the send", async (t) => {
  const s = sandbox(t);
  assert.equal(await s.run(200), "http 200");
  assert.equal(s.calls.length, 1);
  assert.equal(readConfig(s.env).last_sent_at, NOW);
});

// #505: a 401 means the connection is gone; resending the same key every Stop is pointless.
test("a 401 stops reporting and status tells the user to reconnect, without the key", async (t) => {
  const s = sandbox(t);
  assert.equal(await s.run(401), "http 401");
  assert.equal(readConfig(s.env).reconnect_required, true);
  assert.equal(await s.run(200, NOW + 3600_000), "exit: reconnect required");
  assert.equal(s.calls.length, 1, "no request after a 401");

  const out = s.ctl("status");
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /Run \/burnstatus:connect/);
  assert.ok(!out.stdout.includes(KEY) && !out.stderr.includes(KEY));
  s.noLeak();
});

test("the statusline shows the reconnect hint after a 401", async (t) => {
  const s = sandbox(t);
  await s.run(401);
  const out = spawnSync(process.execPath, [STATUSLINE], {
    env: { ...process.env, ...s.env },
    input: "{}",
    encoding: "utf8",
  });
  assert.match(out.stdout, /\/burnstatus:connect/);
  assert.ok(!out.stdout.includes(KEY));
});

test("a 429 backs off for Retry-After instead of retrying on every Stop", async (t) => {
  const s = sandbox(t);
  assert.equal(await s.run(429, NOW, { "retry-after": "600" }), "http 429");
  assert.equal(readConfig(s.env).backoff_until, NOW + 600_000);
  assert.equal(await s.run(200, NOW + 120_000), "exit: backoff");
  assert.equal(s.calls.length, 1);
  assert.equal(await s.run(200, NOW + 600_000), "http 200");
  assert.equal(readConfig(s.env).backoff_until, 0);
  s.noLeak();
});

test("a 429 or 5xx without Retry-After still waits the minimum interval", async (t) => {
  const s = sandbox(t);
  await s.run(503);
  assert.equal(readConfig(s.env).backoff_until, NOW + 60_000);
  assert.equal(await s.run(200, NOW + 1_000), "exit: backoff");
  assert.equal(s.calls.length, 1);
});

// #503: after the 5h window resets, the old 90% must not reach Slack.
test("a reset window is not sent; both reset sends nothing", async (t) => {
  const s = sandbox(t);
  await s.run(200, NOW + 3601_000);
  assert.deepEqual(JSON.parse(s.calls[0].body), {
    five_hour_pct: null,
    five_hour_resets_at: null,
    weekly_pct: 40,
    weekly_resets_at: NOW_S + 86400,
  });
  assert.equal(await s.run(200, NOW + 86401_000), "exit: no current limits");
  assert.equal(s.calls.length, 1);
});
