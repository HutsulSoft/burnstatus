// Preload for child processes (node --import): replaces fetch with the answers in FAKE_FETCH, a
// JSON array of { status, body, headers } served in order, and logs each request path to
// FAKE_FETCH_LOG. Lets a test run ctl.mjs for real and read its real stdout.
import { appendFileSync } from "node:fs";

const answers = JSON.parse(process.env.FAKE_FETCH || "[]");
globalThis.fetch = async (url) => {
  if (process.env.FAKE_FETCH_LOG)
    appendFileSync(process.env.FAKE_FETCH_LOG, new URL(url).pathname + "\n");
  const a = answers.shift();
  if (!a) throw new TypeError("fetch failed");
  return new Response(JSON.stringify(a.body ?? {}), { status: a.status, headers: a.headers ?? {} });
};
