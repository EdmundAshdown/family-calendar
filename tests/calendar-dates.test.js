/* Tests for public/calendar-dates.js — the date and month-grid maths.
 *
 * Run with `npm test` (Node's built-in runner; no dependencies, no build
 * step, same shape as Iron Log's suite).
 *
 * These exist because the app shipped a real off-by-one date bug that a
 * five-line test would have caught: toIsoDate had been implemented with
 * toISOString(), which converts to UTC first, so a local 9pm came back as
 * tomorrow and a local midnight east of UTC came back as yesterday.
 *
 * The cases below build Dates from *local* components and assert their
 * *local* representation, so the first two timezone-independent tests are
 * meaningful wherever they run. The timezone-specific block then pins the
 * behaviour on both sides of UTC, which is where the bug lived.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  toIsoDate,
  localDateFromIso,
  getMonthStart,
  getGridStart,
  getGridEnd,
  parseEventBounds,
  isSameLocalDay,
  eventOverlapsDay,
  allDayEndDate,
} = require("../public/calendar-dates.js");

// ---------------------------------------------------------------------
// toIsoDate — local date in, local date out
// ---------------------------------------------------------------------

test("toIsoDate keeps an evening local time on its own day", () => {
  // The original bug: 9pm local went to UTC, which is tomorrow, so the
  // edit form opened with the wrong date and saving moved the event.
  const evening = new Date(2026, 9, 18, 21, 0, 0);
  assert.equal(toIsoDate(evening), "2026-10-18");
});

test("toIsoDate keeps local midnight on its own day", () => {
  const midnight = new Date(2026, 9, 18, 0, 0, 0);
  assert.equal(toIsoDate(midnight), "2026-10-18");
});

test("toIsoDate zero-pads months and days", () => {
  assert.equal(toIsoDate(new Date(2026, 0, 5)), "2026-01-05");
  assert.equal(toIsoDate(new Date(2026, 11, 31)), "2026-12-31");
});

test("toIsoDate round-trips through localDateFromIso", () => {
  for (const iso of ["2026-01-01", "2026-02-28", "2026-06-15", "2026-12-31"]) {
    assert.equal(toIsoDate(localDateFromIso(iso)), iso);
  }
});

test("localDateFromIso does not shift the day in either direction", () => {
  // The all-day trap: new Date("2026-10-18") is UTC midnight, which reads
  // as the 17th anywhere west of UTC.
  const d = localDateFromIso("2026-10-18");
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 9);
  assert.equal(d.getDate(), 18);
  assert.equal(d.getHours(), 0);
});

// ---------------------------------------------------------------------
// Timezone-specific: the bug only appears off UTC
// ---------------------------------------------------------------------

test("toIsoDate is correct west of UTC (America/New_York)", () => {
  const previous = process.env.TZ;
  process.env.TZ = "America/New_York";
  try {
    // 8:30pm local on the 18th is 00:30 UTC on the 19th — the exact case
    // that prefilled tomorrow's date in the add-event form.
    assert.equal(toIsoDate(new Date(2026, 9, 18, 20, 30)), "2026-10-18");
    assert.equal(toIsoDate(new Date(2026, 9, 18, 23, 59)), "2026-10-18");
    assert.equal(localDateFromIso("2026-10-18").getDate(), 18);
  } finally {
    process.env.TZ = previous;
  }
});

test("toIsoDate is correct east of UTC (Australia/Sydney)", () => {
  const previous = process.env.TZ;
  process.env.TZ = "Australia/Sydney";
  try {
    // Local midnight on the 18th is 14:00 UTC on the 17th — the case that
    // made the day-detail "add event" prefill yesterday.
    assert.equal(toIsoDate(new Date(2026, 9, 18, 0, 0)), "2026-10-18");
    assert.equal(toIsoDate(new Date(2026, 9, 18, 21, 0)), "2026-10-18");
    assert.equal(localDateFromIso("2026-10-18").getDate(), 18);
  } finally {
    process.env.TZ = previous;
  }
});

// ---------------------------------------------------------------------
// The month grid: complete weeks, Sunday to Saturday
// ---------------------------------------------------------------------

test("grid covers whole weeks and starts on a Sunday", () => {
  // October 2026 starts on a Thursday and ends on a Saturday, so the grid
  // needs a leading partial week and no trailing one.
  const start = getGridStart(getMonthStart(new Date(2026, 9, 15)));
  const end = getGridEnd(getMonthStart(new Date(2026, 9, 15)));

  assert.equal(start.getDay(), 0, "grid should start on Sunday");
  assert.equal(end.getDay(), 0, "exclusive end should be a Sunday");
  assert.equal(toIsoDate(start), "2026-09-27");
  assert.equal(toIsoDate(end), "2026-11-01");
});

test("grid contains the whole month it is for", () => {
  // Every month of a year, including Februaries and 31-day months.
  for (let month = 0; month < 12; month++) {
    const monthStart = getMonthStart(new Date(2026, month, 1));
    const start = getGridStart(monthStart);
    const end = getGridEnd(monthStart);

    assert.ok(start <= monthStart, `grid should begin on or before the 1st of month ${month + 1}`);
    assert.ok(end > monthStart, `grid should extend past the 1st of month ${month + 1}`);

    // The last day of the month must fall inside the grid.
    const lastOfMonth = new Date(2026, month + 1, 0);
    assert.ok(lastOfMonth < end, `grid should contain the end of month ${month + 1}`);

    // Whole weeks only.
    const days = Math.round((end - start) / (24 * 60 * 60 * 1000));
    assert.equal(days % 7, 0, `month ${month + 1} grid should be whole weeks`);
  }
});

test("grid spans 6 weeks for a month that needs it", () => {
  // August 2026 starts on a Saturday and has 31 days -> 6 weeks.
  const start = getGridStart(getMonthStart(new Date(2026, 7, 1)));
  const end = getGridEnd(getMonthStart(new Date(2026, 7, 1)));
  const days = Math.round((end - start) / (24 * 60 * 60 * 1000));
  assert.equal(days, 42);
});

// ---------------------------------------------------------------------
// Event bounds and day overlap
// ---------------------------------------------------------------------

// Timed-event assertions read back *local* hours, so they only mean
// anything with the timezone pinned. Nothing here may depend on whatever
// timezone the machine running the tests happens to be in.
function withTimezone(tz, fn) {
  const previous = process.env.TZ;
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    process.env.TZ = previous;
  }
}

const timedEvent = (startIso, endIso) => ({
  start: { dateTime: startIso },
  end: { dateTime: endIso },
});

const allDayEvent = (startIso, endIso) => ({
  start: { date: startIso },
  end: { date: endIso },
});

test("timed events resolve to the exact instant Google sent", () => {
  // Offsets are absolute, so this holds in any timezone.
  const { start, end } = parseEventBounds(timedEvent("2026-10-18T21:00:00-04:00", "2026-10-18T22:30:00-04:00"));
  assert.equal(start.getTime(), Date.parse("2026-10-18T21:00:00-04:00"));
  assert.equal(end.getTime(), Date.parse("2026-10-18T22:30:00-04:00"));
});

test("timed events land on the right local hour", () => {
  withTimezone("America/New_York", () => {
    const { start, end } = parseEventBounds(timedEvent("2026-10-18T21:00:00-04:00", "2026-10-18T22:30:00-04:00"));
    assert.equal(start.getHours(), 21);
    assert.equal(end.getHours(), 22);
  });
});

test("an all-day event lands on the right day", () => {
  const ev = allDayEvent("2026-10-18", "2026-10-19");
  assert.equal(isSameLocalDay(parseEventBounds(ev).start, new Date(2026, 9, 18)), true);
});

test("a one-day all-day event covers exactly one day", () => {
  const ev = allDayEvent("2026-10-18", "2026-10-19");
  assert.equal(eventOverlapsDay(ev, new Date(2026, 9, 18)), true);
  assert.equal(eventOverlapsDay(ev, new Date(2026, 9, 17)), false);
  assert.equal(eventOverlapsDay(ev, new Date(2026, 9, 19)), false);
});

test("a multi-day all-day event covers every day it spans", () => {
  // "Google's end.date is exclusive, which is exactly what a range check wants."
  const stay = allDayEvent("2026-10-18", "2026-10-21");
  assert.equal(eventOverlapsDay(stay, new Date(2026, 9, 17)), false);
  assert.equal(eventOverlapsDay(stay, new Date(2026, 9, 18)), true);
  assert.equal(eventOverlapsDay(stay, new Date(2026, 9, 19)), true);
  assert.equal(eventOverlapsDay(stay, new Date(2026, 9, 20)), true);
  assert.equal(eventOverlapsDay(stay, new Date(2026, 9, 21)), false);
});

test("a timed event covers the local days it actually touches", () => {
  withTimezone("America/New_York", () => {
    const ev = timedEvent("2026-10-18T22:00:00-04:00", "2026-10-18T23:30:00-04:00");
    assert.equal(eventOverlapsDay(ev, new Date(2026, 9, 18)), true);
    assert.equal(eventOverlapsDay(ev, new Date(2026, 9, 19)), false);
  });
});

test("an event crossing midnight covers both days", () => {
  withTimezone("America/New_York", () => {
    const ev = timedEvent("2026-10-18T22:00:00-04:00", "2026-10-19T02:00:00-04:00");
    assert.equal(eventOverlapsDay(ev, new Date(2026, 9, 18)), true);
    assert.equal(eventOverlapsDay(ev, new Date(2026, 9, 19)), true);
    assert.equal(eventOverlapsDay(ev, new Date(2026, 9, 20)), false);
  });
});

// ---------------------------------------------------------------------
// Writing an all-day event back to Google
// ---------------------------------------------------------------------

test("all-day end is the next day, and rolls the month over", () => {
  assert.equal(allDayEndDate("2026-10-18"), "2026-10-19");
  assert.equal(allDayEndDate("2026-10-31"), "2026-11-01");
  assert.equal(allDayEndDate("2026-12-31"), "2027-01-01");
  assert.equal(allDayEndDate("2026-02-28"), "2026-03-01");
});

test("what we write for an all-day event is what we read back", () => {
  // The round trip is the property that matters: build end with
  // allDayEndDate, then feed the pair through parseEventBounds and
  // eventOverlapsDay, and the event must cover exactly one day.
  for (const day of ["2026-10-18", "2026-10-31", "2026-12-31", "2026-02-28"]) {
    const ev = allDayEvent(day, allDayEndDate(day));
    assert.equal(eventOverlapsDay(ev, localDateFromIso(day)), true, `${day} should cover itself`);
    const next = new Date(localDateFromIso(day).getFullYear(), localDateFromIso(day).getMonth(), localDateFromIso(day).getDate() + 1);
    assert.equal(eventOverlapsDay(ev, next), false, `${day} should not spill into the next day`);
  }
});
