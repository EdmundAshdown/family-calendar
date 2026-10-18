/* Family Board — calendar-dates.js
 *
 * Every date- and grid-related calculation, with no DOM and no network
 * access, so the whole file can be unit-tested directly by Node (see
 * tests/calendar-dates.test.js). It is loaded as a plain browser script
 * like config.js and themes.js — there is still no build step.
 *
 * The rule this file exists to enforce: **local dates in, local strings
 * out.** Google hands us two shapes of date and they are nothing alike:
 *
 *   - Timed events  -> "2026-10-18T21:00:00-04:00" (a real instant, with
 *                      an offset, which `new Date()` resolves correctly)
 *   - All-day events -> "2026-10-18" (bare, no time, no offset, and
 *                      `new Date()` parses it as UTC midnight — which is
 *                      the *previous* calendar day anywhere west of UTC)
 *
 * Mixing the two — or formatting a local Date with toISOString(), which
 * converts to UTC first — is how a board quietly puts an event on the
 * wrong day. Both directions are handled here in one place.
 */

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/* Formats a Date as "YYYY-MM-DD" using its LOCAL calendar date.
 *
 * Deliberately NOT toISOString().slice(0, 10): that converts to UTC
 * first, so a local 9pm lands on tomorrow, and a local midnight in any
 * positive-UTC-offset timezone (e.g. UTC+10) lands on yesterday. Reading
 * the components back off the Date keeps it on the day the user sees.
 */
function toIsoDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/* Builds a local-midnight Date from a bare "YYYY-MM-DD" string.
 *
 * Parsing the numbers by hand rather than passing the string to the Date
 * constructor avoids the UTC-midnight trap described at the top. Accepts
 * an out-of-range day so callers can ask for "the day after the 31st" and
 * let JavaScript roll the month over.
 */
function localDateFromIso(isoDate) {
  const [y, m, d] = isoDate.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function getMonthStart(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

// The grid always shows complete weeks, so it starts on the Sunday on or
// before the 1st of the month, and ends on the Saturday on or after the
// month's last day.
function getGridStart(monthStart) {
  const d = new Date(monthStart);
  d.setDate(d.getDate() - d.getDay());
  return d;
}

function getGridEnd(monthStart) {
  const lastOfMonth = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 0);
  const d = new Date(lastOfMonth);
  d.setDate(d.getDate() + (6 - d.getDay()) + 1); // +1 to make it an exclusive end
  return d;
}

/* Resolves an event's real start/end as local-time Dates.
 *
 * Timed events carry an offset, so the normal Date constructor is right.
 * All-day events are bare strings — see localDateFromIso. Google's
 * all-day end.date is already exclusive (the day after the event ends),
 * which is exactly what the range check below wants.
 */
function parseEventBounds(ev) {
  if (ev.start.dateTime) {
    return { start: new Date(ev.start.dateTime), end: new Date(ev.end.dateTime) };
  }
  return {
    start: localDateFromIso(ev.start.date),
    end: localDateFromIso(ev.end.date),
  };
}

function isSameLocalDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

// True if `day` (a local-midnight Date) falls anywhere within the event's
// span — not just on its start date. This is what makes multi-day events
// (a hotel stay, a multi-day trip Gmail auto-added, etc.) show up on
// every day they cover instead of disappearing after the first one.
function eventOverlapsDay(ev, day) {
  const { start, end } = parseEventBounds(ev);
  const dayEnd = new Date(day);
  dayEnd.setDate(dayEnd.getDate() + 1);
  return start < dayEnd && end > day;
}

// Google's all-day `end.date` is exclusive, so a one-day all-day event has
// end = start + 1 day. Building it locally (with JavaScript rolling the
// month over) keeps it consistent with how parseEventBounds reads it back.
function allDayEndDate(isoDate) {
  const start = localDateFromIso(isoDate);
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1);
  return toIsoDate(end);
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    DAY_NAMES,
    MS_PER_DAY,
    toIsoDate,
    localDateFromIso,
    getMonthStart,
    getGridStart,
    getGridEnd,
    parseEventBounds,
    isSameLocalDay,
    eventOverlapsDay,
    allDayEndDate,
  };
}
