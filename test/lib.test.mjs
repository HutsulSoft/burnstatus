import test from "node:test";
import assert from "node:assert/strict";
import {
  bar,
  buildReport,
  formatStatusLine,
  liveLimits,
  parseRateLimits,
  retryAfterMs,
} from "../scripts/lib.mjs";

// Fixtures are relative to an injected now, so they never age into the past (#503).
const NOW = Date.now();
const NOW_S = Math.floor(NOW / 1000);
const FIVE_RESETS = NOW_S + 2 * 3600;
const WEEK_RESETS = NOW_S + 3 * 86400;
const input = {
  rate_limits: {
    five_hour: { used_percentage: 4.2, resets_at: FIVE_RESETS },
    seven_day: { used_percentage: 85.6, resets_at: WEEK_RESETS },
  },
};

test("parseRateLimits maps docs fields and rounds", () => {
  const c = parseRateLimits(input, 1_000_000);
  assert.deepEqual(c, {
    five_hour_pct: 4,
    five_hour_resets_at: FIVE_RESETS,
    weekly_pct: 86,
    weekly_resets_at: WEEK_RESETS,
    updated_at: 1000,
  });
});
test("absent or empty rate_limits yields null", () => {
  assert.equal(parseRateLimits({}), null);
  assert.equal(parseRateLimits({ rate_limits: {} }), null);
  assert.equal(parseRateLimits(null), null);
});
test("clamps and ignores non-numbers", () => {
  const c = parseRateLimits({
    rate_limits: {
      five_hour: { used_percentage: 130, resets_at: "x" },
      seven_day: { used_percentage: "a" },
    },
  });
  assert.equal(c.five_hour_pct, 100);
  assert.equal(c.five_hour_resets_at, null);
  assert.equal(c.weekly_pct, null);
});
test("bar and line match the agreed example", () => {
  assert.equal(bar(0), "░░░░░");
  assert.equal(bar(4), "▓░░░░");
  assert.equal(bar(100), "▓▓▓▓▓");
  assert.equal(formatStatusLine(parseRateLimits(input)), "5h ▓░░░░ 4% · wk ▓▓▓▓░ 86%");
});
test("partial cache prints only what exists; null prints nothing", () => {
  assert.equal(formatStatusLine({ five_hour_pct: 10, weekly_pct: null }), "5h ▓░░░░ 10%");
  assert.equal(formatStatusLine(null), "");
});
test("report body has exactly the four agreed fields", () => {
  assert.deepEqual(Object.keys(buildReport(parseRateLimits(input, NOW), NOW)), [
    "five_hour_pct",
    "five_hour_resets_at",
    "weekly_pct",
    "weekly_resets_at",
  ]);
});

// #503: a window whose resets_at has passed no longer exists; its cached percent is not current.
test("a window past its resets_at is dropped from the report and the line", () => {
  const cache = parseRateLimits(input, NOW);
  const afterFive = (FIVE_RESETS + 1) * 1000;
  assert.deepEqual(buildReport(cache, afterFive), {
    five_hour_pct: null,
    five_hour_resets_at: null,
    weekly_pct: 86,
    weekly_resets_at: WEEK_RESETS,
  });
  assert.equal(formatStatusLine(liveLimits(cache, afterFive)), "wk ▓▓▓▓░ 86%");
  // resets_at exactly now counts as reset.
  assert.equal(buildReport(cache, FIVE_RESETS * 1000).five_hour_pct, null);
});
test("both windows reset: nothing is sent and nothing is shown", () => {
  const cache = parseRateLimits(input, NOW);
  const later = (WEEK_RESETS + 1) * 1000;
  assert.equal(buildReport(cache, later), null);
  assert.equal(liveLimits(cache, later), null);
  assert.equal(formatStatusLine(liveLimits(cache, later)), "");
});
test("an unknown resets_at keeps the window: there is nothing to compare", () => {
  const c = { five_hour_pct: 40, five_hour_resets_at: null, weekly_pct: null };
  assert.equal(buildReport(c, NOW).five_hour_pct, 40);
});
test("retryAfterMs reads seconds and HTTP dates, caps, and is 0 when absent or junk", () => {
  assert.equal(retryAfterMs(null, NOW), 0);
  assert.equal(retryAfterMs("abc", NOW), 0);
  assert.equal(retryAfterMs("120", NOW), 120_000);
  assert.equal(retryAfterMs("-5", NOW), 0);
  // HTTP dates carry whole seconds only.
  assert.equal(retryAfterMs(new Date(NOW_S * 1000 + 300_000).toUTCString(), NOW_S * 1000), 300_000);
  assert.equal(retryAfterMs("999999", NOW), 6 * 3600_000);
});
