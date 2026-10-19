const test = require("node:test");
const assert = require("node:assert/strict");

const { parseClockMinutes, isWithinQuietHours, isQuietNow } = require("../public/quiet-hours.js");

test("parseClockMinutes: valid times", () => {
  assert.equal(parseClockMinutes("23:00"), 1380);
  assert.equal(parseClockMinutes("06:30"), 390);
  assert.equal(parseClockMinutes("7:05"), 425);
  assert.equal(parseClockMinutes("00:00"), 0);
  assert.equal(parseClockMinutes("23:59"), 1439);
});

test("parseClockMinutes: invalid input fails open", () => {
  for (const v of ["24:00", "23:60", "-1:00", "23:0", "abc", "", null, undefined, 1380]) {
    assert.equal(parseClockMinutes(v), null, `expected null for ${JSON.stringify(v)}`);
  }
});

test("isWithinQuietHours: crossing-midnight window", () => {
  // 23:00 -> 06:30
  assert.equal(isWithinQuietHours(1380, 1380, 390), true,  "start inclusive");
  assert.equal(isWithinQuietHours(0, 1380, 390), true,     "midnight");
  assert.equal(isWithinQuietHours(389, 1380, 390), true,   "just before end");
  assert.equal(isWithinQuietHours(390, 1380, 390), false,  "end exclusive");
  assert.equal(isWithinQuietHours(720, 1380, 390), false,  "noon");
});

test("isWithinQuietHours: daytime window", () => {
  // 09:00 -> 17:00
  assert.equal(isWithinQuietHours(540, 540, 1020), true,   "start inclusive");
  assert.equal(isWithinQuietHours(1019, 540, 1020), true,  "just before end");
  assert.equal(isWithinQuietHours(1020, 540, 1020), false, "end exclusive");
  assert.equal(isWithinQuietHours(539, 540, 1020), false,  "before start");
});

test("isWithinQuietHours: empty window is never quiet", () => {
  assert.equal(isWithinQuietHours(600, 600, 600), false);
});

test("isWithinQuietHours: garbage fails open (not quiet)", () => {
  assert.equal(isWithinQuietHours(600, NaN, 1020), false);
  assert.equal(isWithinQuietHours("x", 540, 1020), false);
});

test("isQuietNow: disabled window", () => {
  const d = new Date("2026-10-18T02:00:00");
  assert.equal(isQuietNow(d, { enabled: false, start: "23:00", end: "06:30" }), false);
});

test("isQuietNow: missing config", () => {
  const d = new Date("2026-10-18T02:00:00");
  assert.equal(isQuietNow(d, null), false);
  assert.equal(isQuietNow(d, {}), false);
});

test("isQuietNow: applies the window in local time", () => {
  const night = new Date("2026-10-18T02:00:00");
  const day = new Date("2026-10-18T12:00:00");
  const cfg = { enabled: true, start: "23:00", end: "06:30" };
  assert.equal(isQuietNow(night, cfg), true);
  assert.equal(isQuietNow(day, cfg), false);
});

test("isQuietNow: misconfigured times leave the board on", () => {
  const night = new Date("2026-10-18T02:00:00");
  assert.equal(isQuietNow(night, { enabled: true, start: "25:00", end: "06:30" }), false);
  assert.equal(isQuietNow(night, { enabled: true, start: "23:00", end: "nope" }), false);
});