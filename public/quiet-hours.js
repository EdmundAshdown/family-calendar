/* Family Board — quiet-hours.js
 *
 * Whether the board should be asleep at a given moment. Kept out of the DOM
 * and out of app.js so the time-window logic — which is fiddly because a
 * window like 23:00 → 06:30 crosses midnight — can be tested directly; see
 * tests/quiet-hours.test.js.
 *
 * The module only answers the question "is this time inside the window?". It
 * does not know about the screen, the poll, or the wake-after-touch
 * behaviour, which all live in app.js.
 */

/* "HH:MM" (or "H:MM") → minutes since midnight, or null if it is not a
 * real time. */
function parseClockMinutes(text) {
  if (typeof text !== "string") return null;
  const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(text);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isInteger(h) || !Number.isInteger(min)) return null;
  if (h < 0 || h > 23) return null;
  if (min < 0 || min > 59) return null;
  return h * 60 + min;
}

/* Is `minutesNow` inside the window [start, end)?
 *
 * When start < end the window is a normal daytime one (09:00–17:00).
 * When start > end it crosses midnight (23:00–06:30): quiet from start
 * to midnight, then again from midnight to end.
 * When start === end the window is empty — quiet never — which is the
 * sensible reading of "start at the same moment you end".
 *
 * Garbage input fails **open**: the board stays awake, because a black
 * screen at 9am is a worse mistake than a lit one at 2am. */
function isWithinQuietHours(minutesNow, startMinutes, endMinutes) {
  if (!Number.isInteger(minutesNow)) return false;
  if (!Number.isInteger(startMinutes) || !Number.isInteger(endMinutes)) return false;
  if (minutesNow < 0 || minutesNow > 1439) return false;
  if (startMinutes === endMinutes) return false;
  if (startMinutes < endMinutes) {
    return minutesNow >= startMinutes && minutesNow < endMinutes;
  }
  // crosses midnight
  return minutesNow >= startMinutes || minutesNow < endMinutes;
}

/* Apply the config to a moment. The window may be disabled, in which case
 * the board is never quiet. */
function isQuietNow(now, quietHours) {
  if (!quietHours || quietHours.enabled === false) return false;
  const start = parseClockMinutes(quietHours.start);
  const end = parseClockMinutes(quietHours.end);
  if (start === null || end === null) return false;
  const minutesNow = now.getHours() * 60 + now.getMinutes();
  return isWithinQuietHours(minutesNow, start, end);
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    parseClockMinutes,
    isWithinQuietHours,
    isQuietNow,
  };
}