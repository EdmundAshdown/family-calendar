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
  sortEventsByStart,
  selectInlineEvents,
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

// ---------------------------------------------------------------------
// Ordering the chips inside a day cell
//
// Google sorts events within a single calendar, but the board concatenates
// whole calendars together. A day cell only shows three, so without a
// global sort one person's calendar could fill the cell while everyone
// else's sat behind "+N more" — and the displayed times read shuffled,
// because the first chip was whichever calendar came first in the list
// rather than the earliest event.
//
// Everything below uses absolute (Z) offsets, so it means the same thing
// wherever the suite runs.
// ---------------------------------------------------------------------

const timed = (summary, startIso, endIso) => ({
  summary,
  start: { dateTime: startIso },
  end: { dateTime: endIso },
});

test("events from several calendars sort into one chronological order", () => {
  // Input order here is calendar order, which is what fetchAllCalendars
  // produces: all of A's events, then B's, then C's.
  const byCalendar = [
    timed("A: School run", "2026-10-18T09:00:00Z", "2026-10-18T09:30:00Z"),
    timed("A: Dentist", "2026-10-18T11:30:00Z", "2026-10-18T12:00:00Z"),
    timed("A: Swimming", "2026-10-18T14:00:00Z", "2026-10-18T15:00:00Z"),
    timed("B: Doctor", "2026-10-18T08:00:00Z", "2026-10-18T08:45:00Z"),
    timed("C: Football", "2026-10-18T18:00:00Z", "2026-10-18T19:30:00Z"),
  ];

  assert.deepEqual(
    sortEventsByStart(byCalendar).map((e) => e.summary),
    ["B: Doctor", "A: School run", "A: Dentist", "A: Swimming", "C: Football"]
  );
});

test("sorting leaves the caller's array alone", () => {
  const input = [
    timed("later", "2026-10-18T14:00:00Z", "2026-10-18T15:00:00Z"),
    timed("earlier", "2026-10-18T09:00:00Z", "2026-10-18T10:00:00Z"),
  ];
  const sorted = sortEventsByStart(input);

  assert.equal(input[0].summary, "later", "the original array should be untouched");
  assert.equal(sorted[0].summary, "earlier");
});

test("an all-day event sorts above a timed one on the same day", () => {
  // All-day events parse to local midnight, so they land at the top of the
  // day — the conventional place for a birthday or a trip marker.
  withTimezone("America/New_York", () => {
    const input = [
      timed("9am meeting", "2026-10-18T09:00:00-04:00", "2026-10-18T10:00:00-04:00"),
      allDayEvent("2026-10-18", "2026-10-19"),
    ];
    assert.equal(sortEventsByStart(input)[0].start.date, "2026-10-18");
  });
});

test("events at the same instant order deterministically", () => {
  // Otherwise the order would depend on which calendar Google answered
  // first, which is exactly the instability this is here to remove.
  const pair = [
    timed("Zebra", "2026-10-18T09:00:00Z", "2026-10-18T09:30:00Z"),
    timed("Apple", "2026-10-18T09:00:00Z", "2026-10-18T09:30:00Z"),
  ];
  const expected = ["Apple", "Zebra"];

  assert.deepEqual(sortEventsByStart(pair).map((e) => e.summary), expected);
  assert.deepEqual(sortEventsByStart([...pair].reverse()).map((e) => e.summary), expected);
});

// A day with more events than the cell can show.
const busyDay = () => [
  timed("08:00 gym", "2026-10-18T08:00:00Z", "2026-10-18T09:00:00Z"),
  timed("10:00 call", "2026-10-18T10:00:00Z", "2026-10-18T11:00:00Z"),
  timed("14:00 dentist", "2026-10-18T14:00:00Z", "2026-10-18T15:00:00Z"),
  timed("17:00 football", "2026-10-18T17:00:00Z", "2026-10-18T18:00:00Z"),
];

test("a day that fits shows all of it", () => {
  const two = busyDay().slice(0, 2);
  const picked = selectInlineEvents(two, 3, new Date("2026-10-18T15:30:00Z"), true);
  assert.equal(picked.length, 2);
});

test("any day but today just shows the earliest events", () => {
  // Time is irrelevant for a day you are not on — a past or future day
  // must not start hiding its morning because of the current clock.
  const picked = selectInlineEvents(busyDay(), 3, new Date("2026-10-18T15:30:00Z"), false);
  assert.deepEqual(picked.map((e) => e.summary), ["08:00 gym", "10:00 call", "14:00 dentist"]);
});

test("today keeps the evening visible instead of the morning's finished errands", () => {
  // The bug this exists for: at half three, showing the *earliest* three
  // would end the day displaying 8am, 10am and 2pm while the football at
  // 5pm was the only thing left and sat behind "+1 more".
  const picked = selectInlineEvents(busyDay(), 3, new Date("2026-10-18T15:30:00Z"), true);

  assert.ok(
    picked.some((e) => e.summary === "17:00 football"),
    "the only remaining event of the day must be on screen"
  );
  assert.deepEqual(picked.map((e) => e.summary), ["10:00 call", "14:00 dentist", "17:00 football"]);
});

test("an event still in progress counts as not finished", () => {
  const day = [
    timed("08:00 gym", "2026-10-18T08:00:00Z", "2026-10-18T09:00:00Z"),
    timed("10:00 call", "2026-10-18T10:00:00Z", "2026-10-18T11:00:00Z"),
    timed("14:00 dentist", "2026-10-18T14:00:00Z", "2026-10-18T16:00:00Z"),
    timed("17:00 football", "2026-10-18T17:00:00Z", "2026-10-18T18:00:00Z"),
  ];
  // At 3pm the dentist appointment is half over, so it stays on screen.
  const picked = selectInlineEvents(day, 3, new Date("2026-10-18T15:00:00Z"), true);

  assert.deepEqual(picked.map((e) => e.summary), ["10:00 call", "14:00 dentist", "17:00 football"]);
});

test("enough upcoming events fill the cell without any finished ones", () => {
  const day = [
    timed("08:00 gym", "2026-10-18T08:00:00Z", "2026-10-18T09:00:00Z"),
    timed("10:00 call", "2026-10-18T10:00:00Z", "2026-10-18T11:00:00Z"),
    timed("14:00 dentist", "2026-10-18T14:00:00Z", "2026-10-18T15:00:00Z"),
    timed("16:00 piano", "2026-10-18T16:00:00Z", "2026-10-18T17:00:00Z"),
    timed("17:00 football", "2026-10-18T17:00:00Z", "2026-10-18T18:00:00Z"),
  ];
  const picked = selectInlineEvents(day, 3, new Date("2026-10-18T09:30:00Z"), true);

  assert.deepEqual(picked.map((e) => e.summary), ["10:00 call", "14:00 dentist", "16:00 piano"]);
});

test("a day that is over still shows its events, not an empty cell", () => {
  // The failure mode this guards: at ten past midnight a cell that
  // renders nothing looks identical to a cell whose events were lost.
  const picked = selectInlineEvents(busyDay(), 3, new Date("2026-10-18T20:00:00Z"), true);

  assert.equal(picked.length, 3, "a day with events must never render empty");
  assert.deepEqual(picked.map((e) => e.summary), ["10:00 call", "14:00 dentist", "17:00 football"]);
});

test("today's selection is chronological whatever the time of day", () => {
  const day = busyDay();
  for (const hour of [6, 8, 9, 12, 15, 19, 22, 23]) {
    const now = new Date(`2026-10-18T${String(hour).padStart(2, "0")}:30:00Z`);
    const picked = selectInlineEvents(day, 3, now, true);
    const starts = picked.map((e) => new Date(e.start.dateTime).getTime());

    assert.deepEqual(starts, [...starts].sort((a, b) => a - b), `should be in time order at ${hour}:30`);
    assert.equal(picked.length, 3, `should fill the cell at ${hour}:30`);
  }
});
