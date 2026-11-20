import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  DEFAULT_WORKER_URL,
  RETIRED_WORKER_URLS,
  getKey,
  homeDir,
  paths,
  setKey,
  workerUrl,
} from "../scripts/lib.mjs";

const LIB = pathToFileURL(join(import.meta.dirname, "..", "scripts", "lib.mjs")).href;
// A made-up key: the test asserts it never reaches stdout or stderr.
const KEY = "lsk_FAKE-test-key-0123456789abcdef";

// Fake macOS `security`: generic passwords in state.json next to it, one line per call in
// calls.log (subcommand + service, never the password). Exit 44 = "item not found", as the real one.
const FAKE_SECURITY = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const dir = __dirname;
const stateFile = path.join(dir, "state.json");
const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
const [cmd, ...rest] = process.argv.slice(2);
const opt = (f) => { const i = rest.indexOf(f); return i < 0 ? undefined : rest[i + 1]; };
const id = opt("-s") + "/" + opt("-a");
fs.appendFileSync(path.join(dir, "calls.log"), cmd + " " + opt("-s") + "\\n");
const save = () => fs.writeFileSync(stateFile, JSON.stringify(state));
if (cmd === "find-generic-password") {
  if (!(id in state)) { process.stderr.write("could not be found\\n"); process.exit(44); }
  process.stdout.write(state[id] + "\\n");
} else if (cmd === "add-generic-password") {
  if (fs.existsSync(path.join(dir, "add-fails"))) process.exit(1);
  state[id] = opt("-w"); save();
} else if (cmd === "delete-generic-password") {
  if (!(id in state)) process.exit(44);
  delete state[id]; save();
} else process.exit(2);
`;

function sandbox(t, keychain = {}) {
  const root = mkdtempSync(join(tmpdir(), "burnstatus-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const bin = join(root, "bin");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(bin);
  const securityBin = join(bin, "security");
  writeFileSync(securityBin, FAKE_SECURITY);
  chmodSync(securityBin, 0o755);
  writeFileSync(join(bin, "state.json"), JSON.stringify(keychain));
  return {
    home,
    securityBin,
    claude: (f) => join(home, ".claude", f),
    keychain: () => JSON.parse(readFileSync(join(bin, "state.json"), "utf8")),
    calls: () =>
      existsSync(join(bin, "calls.log"))
        ? readFileSync(join(bin, "calls.log"), "utf8").trim().split("\n")
        : [],
  };
}

/** Runs migrate() `times` times in a child process, so its real stdout/stderr can be inspected. */
function runMigrate(s, { platform = "darwin", env = {}, times = 1 } = {}) {
  const code =
    `const { migrate } = await import(${JSON.stringify(LIB)});` +
    `const opts = { platform: ${JSON.stringify(platform)}, securityBin: ${JSON.stringify(s.securityBin)} };` +
    `const r = []; for (let i = 0; i < ${times}; i++) r.push(migrate(process.env, opts));` +
    `process.stdout.write(JSON.stringify(r));`;
  const base = { ...process.env };
  for (const k of Object.keys(base))
    if (k.startsWith("BURNSTATUS_") || k.startsWith("LIMIT_STATUS_")) delete base[k];
  const res = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    env: { ...base, HOME: s.home, ...env },
    encoding: "utf8",
  });
  assert.equal(res.status, 0, res.stderr);
  return { results: JSON.parse(res.stdout), stdout: res.stdout, stderr: res.stderr };
}

test("defaults: api.burnstatus.uk origin, files under ~/.claude/burnstatus, BURNSTATUS_* overrides", () => {
  assert.equal(DEFAULT_WORKER_URL, "https://api.burnstatus.uk");
  assert.equal(workerUrl({}), DEFAULT_WORKER_URL);
  assert.equal(workerUrl({ BURNSTATUS_WORKER_URL: "https://x.test/" }), "https://x.test");
  assert.equal(homeDir({ HOME: "/h" }), join("/h", ".claude", "burnstatus"));
  assert.equal(homeDir({ HOME: "/h", BURNSTATUS_HOME: "/b" }), "/b");
  assert.equal(paths({ HOME: "/h" }).cache, join("/h", ".claude", "burnstatus", "cache.json"));
});

test("an override naming the retired workers.dev origin reads as api.burnstatus.uk (S18)", () => {
  assert.deepEqual(RETIRED_WORKER_URLS, ["https://burnstatus-api.hutsulsoft-snagon.workers.dev"]);
  for (const old of [
    "https://burnstatus-api.hutsulsoft-snagon.workers.dev",
    "https://burnstatus-api.hutsulsoft-snagon.workers.dev/",
    "https://BurnStatus-API.hutsulsoft-snagon.workers.dev",
  ])
    assert.equal(workerUrl({ BURNSTATUS_WORKER_URL: old }), "https://api.burnstatus.uk", old);
  // Only the exact retired origin: another host on workers.dev is a deliberate override.
  const other = "https://burnstatus-api-staging.hutsulsoft-snagon.workers.dev";
  assert.equal(workerUrl({ BURNSTATUS_WORKER_URL: other }), other);
});

test("migration moves the Keychain item and files exactly once and never prints the key", (t) => {
  const s = sandbox(t, { "limit-status/plugin-key": KEY });
  writeFileSync(s.claude("limit-status-cache.json"), '{"five_hour_pct":4}\n');
  writeFileSync(s.claude("limit-status.json"), '{"enabled":false}\n');

  const run = runMigrate(s, { times: 2 });
  assert.deepEqual(run.results, [true, false]);
  assert.ok(!run.stdout.includes(KEY) && !run.stderr.includes(KEY), "key leaked to output");
  assert.equal(run.stderr, "");

  // First call: read old, check new, write new, delete old. Second call: nothing at all.
  assert.deepEqual(s.calls(), [
    "find-generic-password limit-status",
    "find-generic-password burnstatus",
    "add-generic-password burnstatus",
    "delete-generic-password limit-status",
  ]);
  assert.deepEqual(s.keychain(), { "burnstatus/plugin-key": KEY });

  assert.equal(readFileSync(s.claude("burnstatus/cache.json"), "utf8"), '{"five_hour_pct":4}\n');
  assert.equal(readFileSync(s.claude("burnstatus/config.json"), "utf8"), '{"enabled":false}\n');
  assert.equal(statSync(s.claude("burnstatus/config.json")).mode & 0o777, 0o600);
  assert.ok(!existsSync(s.claude("limit-status-cache.json")));
  assert.ok(!existsSync(s.claude("limit-status.json")));

  // A later process does not migrate again either: the marker holds, security is not called.
  assert.deepEqual(runMigrate(s).results, [false]);
  assert.equal(s.calls().length, 4);
});

test("a key already under the new name wins; the old item is still deleted", (t) => {
  const s = sandbox(t, { "limit-status/plugin-key": KEY, "burnstatus/plugin-key": "bsk_newer" });
  const run = runMigrate(s);
  assert.deepEqual(run.results, [true]);
  assert.ok(!s.calls().includes("add-generic-password burnstatus"));
  assert.deepEqual(s.keychain(), { "burnstatus/plugin-key": "bsk_newer" });
});

test("nothing to migrate still runs once", (t) => {
  const s = sandbox(t);
  assert.deepEqual(runMigrate(s, { times: 2 }).results, [true, false]);
  assert.deepEqual(s.calls(), ["find-generic-password limit-status"]);
});

test("off macOS: the 600 key file moves to ~/.claude/burnstatus/key, security is never called", (t) => {
  const s = sandbox(t);
  writeFileSync(s.claude("limit-status-key"), KEY + "\n", { mode: 0o600 });
  const run = runMigrate(s, { platform: "linux" });
  assert.deepEqual(run.results, [true]);
  assert.ok(!run.stdout.includes(KEY) && !run.stderr.includes(KEY));
  assert.deepEqual(s.calls(), []);
  assert.equal(readFileSync(s.claude("burnstatus/key"), "utf8"), KEY + "\n");
  assert.equal(statSync(s.claude("burnstatus/key")).mode & 0o777, 0o600);
  assert.ok(!existsSync(s.claude("limit-status-key")));
});

test("LIMIT_STATUS_HOME and BURNSTATUS_HOME are honoured; no Keychain under either", (t) => {
  const s = sandbox(t, { "limit-status/plugin-key": KEY });
  const oldDir = join(s.home, "old");
  const newDir = join(s.home, "new");
  mkdirSync(oldDir);
  writeFileSync(join(oldDir, "limit-status.json"), '{"enabled":true}\n');
  const run = runMigrate(s, { env: { LIMIT_STATUS_HOME: oldDir, BURNSTATUS_HOME: newDir } });
  assert.deepEqual(run.results, [true]);
  assert.deepEqual(s.calls(), []);
  assert.ok(existsSync(join(newDir, "config.json")));
  assert.ok(!existsSync(join(oldDir, "limit-status.json")));
});

test("the prototype's statusline copy is refreshed, so an un-edited settings.json feeds the new cache", (t) => {
  const s = sandbox(t);
  mkdirSync(s.claude("limit-status"));
  writeFileSync(s.claude("limit-status/statusline.mjs"), "// old\n");
  writeFileSync(s.claude("limit-status/lib.mjs"), "// old\n");
  assert.deepEqual(runMigrate(s).results, [true]);
  const scripts = join(import.meta.dirname, "..", "scripts");
  for (const f of ["statusline.mjs", "lib.mjs"])
    assert.equal(
      readFileSync(s.claude("limit-status/" + f), "utf8"),
      readFileSync(join(scripts, f), "utf8"),
    );
});

test("no prototype statusline copy: nothing is created there", (t) => {
  const s = sandbox(t);
  assert.deepEqual(runMigrate(s).results, [true]);
  assert.ok(!existsSync(s.claude("limit-status")));
});

test("Keychain write fails: the key goes to the 600 file and the stale Keychain item is deleted", (t) => {
  const s = sandbox(t, { "burnstatus/plugin-key": "bsk_old-stale-key" });
  writeFileSync(join(dirname(s.securityBin), "add-fails"), "");
  const env = { HOME: s.home };
  const opts = { platform: "darwin", securityBin: s.securityBin };
  assert.equal(setKey(KEY, env, opts), "file");
  assert.deepEqual(s.keychain(), {});
  assert.equal(getKey(env, opts), KEY);
  const f = paths(env).keyFile;
  assert.equal(statSync(f).mode & 0o777, 0o600);
  assert.equal(statSync(dirname(f)).mode & 0o777, 0o700);
});
