import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COPY, copy } from "../scripts/copy.mjs";
import {
  classify,
  isLegacyCommand,
  mergeStatusline,
  ourCommand,
  settingsPath,
} from "../scripts/setup.mjs";

const SCRIPTS = join(import.meta.dirname, "..", "scripts");
const NOW = Date.parse("2026-11-20T10:00:00Z");
const FOREIGN = "bash ~/.claude/my-statusline.sh";

function sandbox(t) {
  const root = mkdtempSync(join(tmpdir(), "burnstatus-setup-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  mkdirSync(join(home, ".claude"), { recursive: true });
  const env = { HOME: home, PATH: process.env.PATH }; // no CLAUDE_CONFIG_DIR / BURNSTATUS_*
  const claude = (f) => join(home, ".claude", f);
  const bs = (f) => claude("burnstatus/" + f);
  return {
    root,
    home,
    env,
    claude,
    bs,
    settings: () => readFileSync(claude("settings.json"), "utf8"),
    writeSettings: (v) =>
      writeFileSync(
        claude("settings.json"),
        typeof v === "string" ? v : JSON.stringify(v, null, 2),
      ),
    backups: () => (existsSync(bs("backups")) ? readdirSync(bs("backups")).toSorted() : []),
    merge: (now = NOW, opts = {}) => mergeStatusline({ env, now, ...opts }),
  };
}

function assertBinCopied(s) {
  for (const f of ["statusline.mjs", "lib.mjs"])
    assert.equal(readFileSync(s.bs("bin/" + f), "utf8"), readFileSync(join(SCRIPTS, f), "utf8"));
}

test("copy keys are the 03-ux.md copy deck strings", () => {
  const deck = readFileSync(join(import.meta.dirname, "..", "..", "docs", "03-ux.md"), "utf8");
  const rows = new Map(
    [...deck.matchAll(/^\| (cli\.[\w.]+) +\| [^|]+\| (.+?) +\|/gm)].map((m) => [m[1], m[2]]),
  );
  for (const [k, v] of Object.entries(COPY)) assert.equal(v, rows.get(k), k + " differs from 03");
  for (const k of rows.keys())
    if (k.startsWith("cli.connect.") || k === "cli.setup.done")
      assert.ok(k in COPY, k + " missing");
  assert.equal(
    copy("cli.connect.statusline_new", { path: "/b" }),
    "Statusline added to ~/.claude/settings.json. Backup: /b",
  );
  assert.throws(() => copy("cli.nope"));
});

test("absent settings.json: created with statusLine only, nothing to back up", (t) => {
  const s = sandbox(t);
  const r = s.merge();
  assert.equal(r.result, "new");
  assert.equal(r.backup, null);
  assert.deepEqual(JSON.parse(s.settings()), {
    statusLine: { type: "command", command: ourCommand(s.env) },
  });
  assert.equal(ourCommand(s.env), 'node "' + s.bs("bin/statusline.mjs") + '"');
  assertBinCopied(s);
  assert.ok(!existsSync(s.bs("wrapped.json")));
});

test("no statusLine: only that key is added, other keys kept in order, backup first", (t) => {
  const s = sandbox(t);
  const before = { model: "opus", env: { FOO: "1" }, permissions: { allow: ["Bash(ls:*)"] } };
  s.writeSettings(before);
  chmodSync(s.claude("settings.json"), 0o644);
  const original = s.settings();
  const r = s.merge();
  assert.equal(r.result, "new");
  const after = JSON.parse(s.settings());
  assert.deepEqual(Object.keys(after), ["model", "env", "permissions", "statusLine"]);
  assert.deepEqual({ ...after, statusLine: undefined }, { ...before, statusLine: undefined });
  assert.equal(readFileSync(r.backup, "utf8"), original);
  assert.equal(statSync(r.backup).mode & 0o777, 0o600);
  assert.equal(statSync(s.claude("settings.json")).mode & 0o777, 0o644, "mode kept");
  // atomic write leaves no temp file behind
  assert.deepEqual(
    readdirSync(s.claude("")).filter((f) => f.includes(".tmp")),
    [],
  );
});

test("already ours: no write at all", (t) => {
  const s = sandbox(t);
  s.writeSettings({ statusLine: { type: "command", command: ourCommand(s.env) }, x: 1 });
  const original = s.settings();
  const mtime = statSync(s.claude("settings.json")).mtimeMs;
  const r = s.merge();
  assert.equal(r.result, "ours");
  assert.equal(r.backup, null);
  assert.equal(s.settings(), original);
  assert.equal(statSync(s.claude("settings.json")).mtimeMs, mtime);
  assert.deepEqual(s.backups(), []);
  assertBinCopied(s);
});

test("foreign statusLine: saved to wrapped.json, replaced by ours, padding kept, backup holds the original", (t) => {
  const s = sandbox(t);
  s.writeSettings({ statusLine: { type: "command", command: FOREIGN, padding: 0 }, theme: "dark" });
  const original = s.settings();
  const r = s.merge();
  assert.equal(r.result, "wrapped");
  assert.deepEqual(JSON.parse(s.settings()), {
    statusLine: { type: "command", command: ourCommand(s.env), padding: 0 },
    theme: "dark",
  });
  const w = JSON.parse(readFileSync(s.bs("wrapped.json"), "utf8"));
  assert.equal(w.command, FOREIGN);
  assert.equal(statSync(s.bs("wrapped.json")).mode & 0o777, 0o600);
  assert.equal(readFileSync(r.backup, "utf8"), original);
});

test("idempotent re-run after a wrap: no second write, wrapped.json and backups unchanged", (t) => {
  const s = sandbox(t);
  s.writeSettings({ statusLine: { type: "command", command: FOREIGN } });
  assert.equal(s.merge(NOW).result, "wrapped");
  const settings = s.settings();
  const wrapped = readFileSync(s.bs("wrapped.json"), "utf8");
  const backups = s.backups();
  assert.equal(backups.length, 1);
  for (const later of [NOW + 1000, NOW + 2000]) assert.equal(s.merge(later).result, "ours");
  assert.equal(s.settings(), settings);
  assert.equal(readFileSync(s.bs("wrapped.json"), "utf8"), wrapped);
  assert.deepEqual(s.backups(), backups);
});

test("unreadable settings.json: nothing written, snippet returned", (t) => {
  if (process.getuid?.() === 0) return t.skip("root reads mode-000 files");
  const s = sandbox(t);
  s.writeSettings({ statusLine: { type: "command", command: FOREIGN } });
  chmodSync(s.claude("settings.json"), 0o000);
  const r = s.merge();
  assert.equal(r.result, "manual");
  assert.deepEqual(r.snippet, { statusLine: { type: "command", command: ourCommand(s.env) } });
  chmodSync(s.claude("settings.json"), 0o600);
  assert.deepEqual(JSON.parse(s.settings()).statusLine.command, FOREIGN);
  assert.deepEqual(s.backups(), []);
  assert.ok(!existsSync(s.bs("wrapped.json")));
});

test("settings.json that is a directory counts as unreadable", (t) => {
  const s = sandbox(t);
  mkdirSync(s.claude("settings.json"));
  assert.equal(s.merge().result, "manual");
  assert.ok(lstatSync(s.claude("settings.json")).isDirectory());
});

for (const [name, text] of [
  ["malformed JSON", '{ "statusLine": { "type": "command", '],
  ["a JSON array", "[1, 2]"],
  ["JSON with comments", '// mine\n{ "model": "opus" }'],
]) {
  test(`${name}: nothing written, byte for byte`, (t) => {
    const s = sandbox(t);
    s.writeSettings(text);
    const r = s.merge();
    assert.equal(r.result, "manual");
    assert.equal(s.settings(), text);
    assert.deepEqual(s.backups(), []);
  });
}

test("a statusLine with no command to wrap is left alone", (t) => {
  const s = sandbox(t);
  s.writeSettings({ statusLine: { type: "static", text: "hi" } });
  const original = s.settings();
  assert.equal(s.merge().result, "kept");
  assert.equal(s.settings(), original);
});

test("prototype statusLine (~/.claude/limit-status): replaced, not wrapped; its directory moved to backups", (t) => {
  const s = sandbox(t);
  mkdirSync(s.claude("limit-status"));
  writeFileSync(s.claude("limit-status/statusline.mjs"), "// prototype\n");
  writeFileSync(s.claude("limit-status/lib.mjs"), "// prototype\n");
  s.writeSettings({
    statusLine: { type: "command", command: "node " + s.claude("limit-status/statusline.mjs") },
  });
  const r = s.merge();
  assert.equal(r.result, "legacy");
  assert.equal(JSON.parse(s.settings()).statusLine.command, ourCommand(s.env));
  assert.ok(!existsSync(s.bs("wrapped.json")), "the prototype must not be wrapped");
  assert.ok(!existsSync(s.claude("limit-status")));
  assert.ok(r.legacyBackup.startsWith(s.bs("backups/limit-status.")));
  assert.equal(readFileSync(join(r.legacyBackup, "statusline.mjs"), "utf8"), "// prototype\n");
  assert.ok(r.backup && existsSync(r.backup));
});

const cmd = (c) => ({ type: "command", command: c });

test("classify knows ~ and $HOME spellings of ours and the prototype", () => {
  const env = { HOME: "/h" };
  assert.equal(classify(undefined, env), "none");
  assert.equal(classify(cmd("node ~/.claude/burnstatus/bin/statusline.mjs"), env), "ours");
  assert.equal(classify(cmd('node "$HOME/.claude/limit-status/statusline.mjs"'), env), "legacy");
  assert.equal(classify(cmd("npx ccstatusline"), env), "foreign");
  assert.equal(classify(cmd("  "), env), "unknown");
  assert.equal(settingsPath(env), join("/h", ".claude", "settings.json"));
  assert.equal(settingsPath({ ...env, CLAUDE_CONFIG_DIR: "/c" }), join("/c", "settings.json"));
});

test("a symlinked settings.json stays a symlink; its target is updated", (t) => {
  const s = sandbox(t);
  const real = join(s.root, "dotfiles-settings.json");
  writeFileSync(real, JSON.stringify({ model: "opus" }));
  symlinkSync(real, s.claude("settings.json"));
  assert.equal(s.merge().result, "new");
  assert.ok(lstatSync(s.claude("settings.json")).isSymbolicLink());
  assert.equal(JSON.parse(readFileSync(real, "utf8")).statusLine.command, ourCommand(s.env));
});

// ---- the commands, as the skill runs them ----

function ctl(s, ...args) {
  // The migration marker keeps ctl.mjs off the real Keychain (migrate() calls `security` on macOS).
  mkdirSync(s.bs(""), { recursive: true });
  writeFileSync(s.bs("migrated"), "test\n");
  return spawnSync(process.execPath, [join(SCRIPTS, "ctl.mjs"), ...args], {
    env: s.env,
    encoding: "utf8",
  });
}

test("/burnstatus:setup prints the copy deck lines", (t) => {
  const s = sandbox(t);
  s.writeSettings({ statusLine: { type: "command", command: FOREIGN } });
  const out = ctl(s, "setup").stdout.trim().split("\n");
  const backup = s.backups()[0];
  assert.deepEqual(out, [
    copy("cli.connect.statusline_wrapped", { path: s.bs("backups/" + backup) }),
    copy("cli.setup.done"),
  ]);
  assert.deepEqual(
    ctl(s, "setup").stdout.trim().split("\n"),
    [copy("cli.connect.statusline_ours"), copy("cli.setup.done")],
    "re-run: ours",
  );
});

test("/burnstatus:setup on malformed settings prints the manual snippet", (t) => {
  const s = sandbox(t);
  s.writeSettings("{oops");
  const out = ctl(s, "setup").stdout;
  assert.ok(out.startsWith(copy("cli.connect.statusline_manual") + "\n"));
  assert.deepEqual(JSON.parse(out.slice(out.indexOf("\n") + 1)), {
    statusLine: { type: "command", command: ourCommand(s.env) },
  });
  assert.equal(s.settings(), "{oops");
});

test("/burnstatus:setup with no settings.json: the new line without a backup path", (t) => {
  const s = sandbox(t);
  assert.deepEqual(ctl(s, "setup").stdout.trim().split("\n"), [
    copy("cli.connect.statusline_created"),
    copy("cli.setup.done"),
  ]);
});

test("/burnstatus:setup with a statusLine that has no command: left alone, kept line and snippet", (t) => {
  const s = sandbox(t);
  s.writeSettings({ statusLine: { type: "static", text: "hi" } });
  const out = ctl(s, "setup").stdout;
  assert.ok(out.startsWith(copy("cli.connect.statusline_kept") + "\n"));
  assert.ok(!out.includes(copy("cli.setup.done")));
  assert.deepEqual(JSON.parse(out.slice(out.indexOf("\n") + 1)), {
    statusLine: { type: "command", command: ourCommand(s.env) },
  });
});

// ---- the installed statusline running a wrapped command ----

function statusline(s, input, timeout = 10_000) {
  const t0 = Date.now();
  const res = spawnSync(process.execPath, [s.bs("bin/statusline.mjs")], {
    env: s.env,
    input,
    encoding: "utf8",
    timeout,
  });
  return { ...res, ms: Date.now() - t0 };
}

const INPUT = JSON.stringify({
  rate_limits: {
    five_hour: { used_percentage: 4, resets_at: Math.floor(Date.now() / 1000) + 3600 },
    seven_day: { used_percentage: 86, resets_at: Math.floor(Date.now() / 1000) + 86400 },
  },
});

test("wrapped command runs first with the same stdin; ours prints after it", (t) => {
  const s = sandbox(t);
  const seen = join(s.root, "seen.json");
  s.writeSettings({
    statusLine: { type: "command", command: "cat > '" + seen + "'; echo 'theirs: ok'" },
  });
  assert.equal(s.merge().result, "wrapped");
  const res = statusline(s, INPUT);
  assert.equal(res.status, 0);
  assert.equal(res.stdout, "theirs: ok\n5h ▓░░░░ 4% · wk ▓▓▓▓░ 86%\n");
  assert.equal(readFileSync(seen, "utf8"), INPUT);
});

test("a hanging wrapped command is cut off after 1 s; our line still prints", (t) => {
  const s = sandbox(t);
  s.writeSettings({ statusLine: { type: "command", command: "echo partial; sleep 5" } });
  assert.equal(s.merge().result, "wrapped");
  const res = statusline(s, INPUT);
  assert.equal(res.status, 0);
  assert.equal(res.stdout, "5h ▓░░░░ 4% · wk ▓▓▓▓░ 86%\n");
  assert.ok(res.ms < 3000, "took " + res.ms + " ms");
});

test("a failing wrapped command prints nothing of its own", (t) => {
  const s = sandbox(t);
  s.writeSettings({ statusLine: { type: "command", command: "exit 3" } });
  s.merge();
  assert.equal(statusline(s, INPUT).stdout, "5h ▓░░░░ 4% · wk ▓▓▓▓░ 86%\n");
});

test("a wrapped command that is our own statusline does not loop", (t) => {
  const s = sandbox(t);
  s.merge();
  writeFileSync(s.bs("wrapped.json"), JSON.stringify({ command: ourCommand(s.env) }));
  const res = statusline(s, INPUT);
  assert.equal(res.stdout, "5h ▓░░░░ 4% · wk ▓▓▓▓░ 86%\n5h ▓░░░░ 4% · wk ▓▓▓▓░ 86%\n");
  assert.ok(res.ms < 3000);
});

// ---- review fixes ----

test("backups dir is forced to 0700 even when it pre-exists looser; the backup is 600", (t) => {
  const s = sandbox(t);
  mkdirSync(s.bs("backups"), { recursive: true, mode: 0o755 });
  chmodSync(s.bs("backups"), 0o755);
  s.writeSettings({ statusLine: { type: "command", command: FOREIGN } });
  const r = s.merge();
  assert.equal(statSync(s.bs("backups")).mode & 0o777, 0o700);
  assert.equal(statSync(r.backup).mode & 0o777, 0o600);
});

test("backups dir is forced to 0700 before limit-status moves into it (no settings write)", (t) => {
  const s = sandbox(t);
  mkdirSync(s.bs("backups"), { recursive: true });
  chmodSync(s.bs("backups"), 0o777);
  mkdirSync(s.claude("limit-status"));
  s.writeSettings({ statusLine: { type: "command", command: ourCommand(s.env) } });
  const r = s.merge();
  assert.equal(r.result, "ours");
  assert.ok(r.legacyBackup);
  assert.equal(statSync(s.bs("backups")).mode & 0o777, 0o700);
});

test("the cache is written before the wrapped command runs", (t) => {
  const s = sandbox(t);
  s.writeSettings({ statusLine: { type: "command", command: "cat '" + s.bs("cache.json") + "'" } });
  assert.equal(s.merge().result, "wrapped");
  const [theirs, ours] = statusline(s, INPUT).stdout.trim().split("\n");
  assert.equal(JSON.parse(theirs).five_hour_pct, 4, "wrapped saw this refresh's cache");
  assert.equal(ours, "5h ▓░░░░ 4% · wk ▓▓▓▓░ 86%");
});

test("the cache is written even when the wrapped command is killed at the timeout", (t) => {
  const s = sandbox(t);
  s.writeSettings({ statusLine: { type: "command", command: "sleep 5" } });
  s.merge();
  statusline(s, INPUT);
  assert.equal(JSON.parse(readFileSync(s.bs("cache.json"), "utf8")).weekly_pct, 86);
});

test("settings.json changed before the rename: nothing replaced, tmp gone, wrapped.json restored", (t) => {
  const s = sandbox(t);
  s.writeSettings({ statusLine: { type: "command", command: FOREIGN } });
  const concurrent = JSON.stringify({ statusLine: { type: "command", command: "other" } });
  const r = s.merge(NOW, { beforeRename: () => s.writeSettings(concurrent) });
  assert.equal(r.result, "manual");
  assert.equal(s.settings(), concurrent);
  assert.ok(!existsSync(s.bs("wrapped.json")));
  assert.deepEqual(
    readdirSync(s.claude("")).filter((f) => f.includes(".tmp")),
    [],
  );
});

test("settings.json created by someone else while it was absent: not replaced", (t) => {
  const s = sandbox(t);
  const r = s.merge(NOW, { beforeRename: () => s.writeSettings("{}") });
  assert.equal(r.result, "manual");
  assert.equal(s.settings(), "{}");
});

test("a failing write leaves no tmp file, settings.json untouched, the previous wrapped.json back", (t) => {
  const s = sandbox(t);
  mkdirSync(s.bs(""), { recursive: true });
  const prev = '{"command":"earlier"}\n';
  writeFileSync(s.bs("wrapped.json"), prev);
  s.writeSettings({ statusLine: { type: "command", command: FOREIGN } });
  const original = s.settings();
  const r = s.merge(NOW, {
    beforeRename: () => {
      throw new Error("disk full");
    },
  });
  assert.equal(r.result, "manual");
  assert.equal(s.settings(), original);
  assert.equal(readFileSync(s.bs("wrapped.json"), "utf8"), prev);
  assert.deepEqual(
    readdirSync(s.claude("")).filter((f) => f.includes(".tmp")),
    [],
  );
});

test("the old statusLine's other fields are kept", (t) => {
  const s = sandbox(t);
  s.writeSettings({
    statusLine: { type: "command", command: FOREIGN, padding: 2, refreshInterval: 5, x: "y" },
  });
  s.merge();
  assert.deepEqual(JSON.parse(s.settings()).statusLine, {
    type: "command",
    command: ourCommand(s.env),
    padding: 2,
    refreshInterval: 5,
    x: "y",
  });
});

test("legacy only for the exact prototype invocation; a command containing it is wrapped", (t) => {
  const env = { HOME: "/h" };
  for (const c of [
    "node /h/.claude/limit-status/statusline.mjs",
    'node "/h/.claude/limit-status/statusline.mjs"',
    "  node '/h/.claude/limit-status/statusline.mjs'  ",
    'node "$HOME/.claude/limit-status/statusline.mjs"',
  ])
    assert.ok(isLegacyCommand(c, env), c);
  for (const c of [
    "node /h/.claude/limit-status/statusline.mjs | head -1",
    "my-wrapper && node /h/.claude/limit-status/statusline.mjs",
    'node "/h/.claude/limit-status/statusline.mjs',
    "node /other/.claude/limit-status/statusline.mjs --x",
  ])
    assert.equal(classify(cmd(c), env), "foreign", c);

  const s = sandbox(t);
  mkdirSync(s.claude("limit-status"));
  const piped = "node " + s.claude("limit-status/statusline.mjs") + " | tr a-z A-Z";
  s.writeSettings({ statusLine: { type: "command", command: piped } });
  assert.equal(s.merge().result, "wrapped");
  assert.equal(JSON.parse(readFileSync(s.bs("wrapped.json"), "utf8")).command, piped);
});

for (const ch of ['"', "$", "`", "\\"]) {
  test(`a bin path containing ${ch} is never written into settings.json`, (t) => {
    const s = sandbox(t);
    const env = { ...s.env, BURNSTATUS_HOME: join(s.root, "bs" + ch + "x") };
    s.writeSettings({ model: "opus" });
    const original = s.settings();
    const r = mergeStatusline({ env, now: NOW });
    assert.equal(r.result, "manual");
    assert.equal(s.settings(), original);
    assert.ok(!existsSync(join(s.root, "bs" + ch + "x")), "nothing created");
  });
}
