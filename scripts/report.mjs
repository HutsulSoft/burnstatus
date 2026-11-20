#!/usr/bin/env node
// Stop hook: send the cached limits to the Worker (lib.mjs sendReport). Silent no-op without key / network / enabled flag. Never throws, never logs the key.
import { appendFileSync, chmodSync, mkdirSync } from "node:fs";
import { homeDir, migrate, paths, sendReport } from "./lib.mjs";

// Opt-in diagnostics (BURNSTATUS_DEBUG=1): reason codes only, never the key, never the body.
function dbg(reason) {
  if (process.env.BURNSTATUS_DEBUG !== "1") return;
  try {
    mkdirSync(homeDir(), { recursive: true });
    const file = paths().debugLog;
    appendFileSync(file, new Date().toISOString() + " pid=" + process.pid + " " + reason + "\n", {
      mode: 0o600,
    });
    chmodSync(file, 0o600);
  } catch {}
}

async function main() {
  if (migrate()) dbg("migrated from limit-status");
  dbg("start");
  dbg(await sendReport());
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
