// The statusLine merge (ADR 0004), shared by /burnstatus:setup and (S9) /burnstatus:connect.
// Only the statusLine key of settings.json is ever changed, atomically, after a backup. An unreadable
// or unparsable settings.json is never written. Zero dependencies; never touches the plugin key.
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { copy } from "./copy.mjs";
import { legacyPaths, paths, writeJson600 } from "./lib.mjs";

// What the statusline needs at runtime; copied because the plugin root moves on every update.
export const BIN_FILES = ["statusline.mjs", "lib.mjs"];
const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));

// Claude Code reads CLAUDE_CONFIG_DIR when set, else ~/.claude.
export const settingsPath = (env = process.env) =>
  join(env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), ".claude"), "settings.json");
export const ourCommand = (env = process.env) =>
  'node "' + join(paths(env).bin, "statusline.mjs") + '"';
/** A path the shell would reinterpret inside double quotes; such a command is never written. */
const unsafeForShell = (path) => /["$`\\]/.test(path);
export const snippet = (env = process.env) => ({
  statusLine: { type: "command", command: ourCommand(env) },
});

/** "ours" | "legacy" (the prototype's ~/.claude/limit-status copy) | "foreign" | "unknown" | "none". */
export function classify(statusLine, env = process.env) {
  if (statusLine === undefined || statusLine === null) return "none";
  const cmd =
    statusLine && typeof statusLine === "object" && typeof statusLine.command === "string"
      ? statusLine.command
      : null;
  if (cmd === null || !cmd.trim()) return "unknown";
  if (
    cmd.includes(join(paths(env).bin, "statusline.mjs")) ||
    /burnstatus[\\/]bin[\\/]statusline\.mjs/.test(cmd)
  )
    return "ours";
  return isLegacyCommand(cmd, env) ? "legacy" : "foreign";
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/**
 * Exactly the prototype's invocation, `node <home>/.claude/limit-status/statusline.mjs`, quoted or
 * not. A command that only contains that path (a pipeline, a wrapper) is foreign and gets wrapped.
 */
export function isLegacyCommand(cmd, env = process.env) {
  const abs = escapeRe(join(legacyPaths(env).statuslineDir, "statusline.mjs"));
  const home = "(?:~|\\$HOME|\\$\\{HOME\\})/\\.claude/limit-status/statusline\\.mjs";
  return new RegExp("^\\s*node\\s+([\"']?)(?:" + abs + "|" + home + ")\\1\\s*$").test(cmd);
}

const stamp = (now) => new Date(now).toISOString().replace(/[:.]/g, "-");

function copyBin(env, srcDir) {
  const dest = paths(env).bin;
  mkdirSync(dest, { recursive: true });
  for (const f of BIN_FILES) {
    const tmp = join(dest, f + "." + process.pid + ".tmp");
    copyFileSync(join(srcDir, f), tmp);
    renameSync(tmp, join(dest, f));
  }
}

/** Raw bytes of settings.json, null when absent; throws when unreadable. */
function readRaw(file) {
  try {
    return readFileSync(file);
  } catch (e) {
    if (e && e.code === "ENOENT") return null;
    throw e;
  }
}

/** { raw, data } (raw null and data {} when absent), or null when unreadable / not a JSON object. */
function readSettings(file) {
  let raw;
  try {
    raw = readRaw(file);
  } catch {
    return null;
  }
  if (raw === null) return { raw: null, data: {} };
  try {
    const data = JSON.parse(raw.toString("utf8"));
    return data && typeof data === "object" && !Array.isArray(data) ? { raw, data } : null;
  } catch {
    return null;
  }
}

const sameBytes = (a, b) => (a === null || b === null ? a === b : a.equals(b));

/** The backups dir, 0700 even when it pre-existed with a looser mode. */
function backupsDir(p) {
  mkdirSync(p.backups, { recursive: true, mode: 0o700 });
  chmodSync(p.backups, 0o700);
  return p.backups;
}

/**
 * temp file + rename in the real file's directory (a symlinked settings.json stays a symlink).
 * Just before the rename settings.json is read again: if it no longer matches `snapshot` (someone
 * else wrote it meanwhile), nothing is replaced and false is returned. The temp file never survives.
 */
function writeSettingsAtomic(file, data, snapshot, beforeRename) {
  let target = file;
  let mode = 0o600;
  try {
    target = realpathSync(file);
    mode = statSync(target).mode & 0o777;
  } catch {}
  const tmp = target + ".burnstatus-" + process.pid + ".tmp";
  try {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode });
    chmodSync(tmp, mode);
    if (beforeRename) beforeRename();
    if (!sameBytes(readRaw(file), snapshot)) return false;
    renameSync(tmp, target);
    return true;
  } finally {
    rmSync(tmp, { force: true });
  }
}

/**
 * Wires the BurnStatus statusline. Returns { result, backup, snippet, legacyBackup } where result is
 * "new" | "wrapped" | "legacy" (prototype command replaced) | "ours" (no write) | "kept" (a
 * statusLine with no command to wrap: left alone) | "manual" (nothing written: unreadable or
 * unparsable settings.json, a bin path the shell would reinterpret, settings.json changed while we
 * worked, or the write failed).
 * `beforeRename` is a test hook only.
 */
export function mergeStatusline({
  env = process.env,
  now = Date.now(),
  srcDir = SCRIPTS_DIR,
  beforeRename,
} = {}) {
  const p = paths(env);
  const file = settingsPath(env);
  const out = { result: "manual", backup: null, snippet: snippet(env), legacyBackup: null };
  if (unsafeForShell(p.bin)) return out;
  copyBin(env, srcDir);
  const read = readSettings(file);
  if (!read) return out;
  const old = read.data.statusLine;
  const kind = classify(old, env);
  if (kind === "unknown") return { ...out, result: "kept" };
  if (kind !== "ours") {
    if (read.raw !== null) {
      out.backup = join(backupsDir(p), "settings.json." + stamp(now));
      // settings.json can hold env values: the backup is 600 from its first byte.
      writeFileSync(out.backup, read.raw, { mode: 0o600 });
      chmodSync(out.backup, 0o600);
    }
    // wrapped.json first: once settings.json points at us, the old command must already be saved.
    let prevWrapped = null;
    try {
      prevWrapped = readFileSync(p.wrapped);
    } catch {}
    if (kind === "foreign") writeJson600(p.wrapped, { command: old.command, saved_at: now });
    const base = old && typeof old === "object" ? old : {};
    const statusLine = { ...base, type: "command", command: ourCommand(env) };
    let written = false;
    try {
      written = writeSettingsAtomic(file, { ...read.data, statusLine }, read.raw, beforeRename);
    } catch {}
    if (!written) {
      // Put wrapped.json back as it was: settings.json still runs whatever it ran before.
      if (kind === "foreign") {
        if (prevWrapped) writeFileSync(p.wrapped, prevWrapped, { mode: 0o600 });
        else rmSync(p.wrapped, { force: true });
      }
      return out;
    }
    if (kind !== "foreign") rmSync(p.wrapped, { force: true });
  }
  out.result = { none: "new", foreign: "wrapped", legacy: "legacy", ours: "ours" }[kind];
  // The prototype's copy is no longer referenced: keep it as a backup instead of deleting it.
  const legacyDir = legacyPaths(env).statuslineDir;
  if (existsSync(legacyDir)) {
    try {
      const to = join(backupsDir(p), "limit-status." + stamp(now));
      renameSync(legacyDir, to);
      out.legacyBackup = to;
    } catch {}
  }
  return out;
}

/** The copy-deck lines for a mergeStatusline() result; "kept" and "manual" end with the snippet. */
export function mergeLines(r) {
  const snippetText = JSON.stringify(r.snippet, null, 2);
  switch (r.result) {
    case "new":
    case "legacy":
      return [
        r.backup
          ? copy("cli.connect.statusline_new", { path: r.backup })
          : copy("cli.connect.statusline_created"),
      ];
    case "wrapped":
      return [copy("cli.connect.statusline_wrapped", { path: r.backup })];
    case "ours":
      return [copy("cli.connect.statusline_ours")];
    case "kept":
      return [copy("cli.connect.statusline_kept"), snippetText];
    default:
      return [copy("cli.connect.statusline_manual"), snippetText];
  }
}
