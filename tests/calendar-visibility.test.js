/* Tests for public/calendar-visibility.js.
 *
 * Run with `npm test`.
 *
 * The rule under test is that the persisted value is the list of HIDDEN
 * calendars, not the visible ones. Getting that backwards is not a
 * cosmetic bug: storing the visible list meant a calendar added later —
 * a new shared calendar, someone joining one of the signed-in accounts —
 * became invisible the first time anyone ticked a box, with nothing on
 * screen to explain it.
 *
 * The other half is the migration off the old key, which needs the same
 * care in the opposite direction: converting it wrongly loses a family's
 * existing choices, and that failure is silent too.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  HIDDEN_CALENDARS_KEY,
  LEGACY_VISIBLE_CALENDARS_KEY,
  parseIdList,
  hiddenIdsFromStored,
  hiddenIdsFromLegacy,
  visibleIdsFrom,
  hiddenIdsFor,
} = require("../public/calendar-visibility.js");

const ALL = ["primary@gmail.com", "family@group.calendar.google.com", "sports@group.calendar.google.com"];

// ---------------------------------------------------------------------
// Parsing stored values
// ---------------------------------------------------------------------

test("an absent value parses to null", () => {
  assert.equal(parseIdList(null), null);
  assert.equal(parseIdList(undefined), null);
});

test("unusable values parse to null rather than throwing", () => {
  for (const raw of ["", "{", "not json", '{"a":1}', "null", "42"]) {
    assert.equal(parseIdList(raw), null, `${JSON.stringify(raw)} should be unusable`);
  }
});

test("an array parses, and non-string entries are dropped", () => {
  assert.deepEqual(parseIdList('["a","b"]'), ["a", "b"]);
  assert.deepEqual(parseIdList('["a",1,null,{"x":1},"b"]'), ["a", "b"]);
});

// ---------------------------------------------------------------------
// Reading the hidden list
// ---------------------------------------------------------------------

test("nothing stored means nothing hidden — every calendar shows", () => {
  const hidden = hiddenIdsFromStored(null);
  assert.deepEqual(hidden, []);
  assert.deepEqual(visibleIdsFrom(ALL, hidden), ALL);
});

test("a stored hidden list is respected", () => {
  const hidden = hiddenIdsFromStored('["sports@group.calendar.google.com"]');
  assert.deepEqual(visibleIdsFrom(ALL, hidden), [
    "primary@gmail.com",
    "family@group.calendar.google.com",
  ]);
});

test("corrupt storage fails open, showing everything", () => {
  // A blank family calendar is a far worse failure than a crowded one.
  const hidden = hiddenIdsFromStored("{{{ not json");
  assert.deepEqual(hidden, []);
  assert.deepEqual(visibleIdsFrom(ALL, hidden), ALL);
});

// ---------------------------------------------------------------------
// The bug this file exists to prevent
// ---------------------------------------------------------------------

test("a calendar discovered later is visible by default", () => {
  // Someone hides one calendar out of three...
  const stored = JSON.stringify(hiddenIdsFor(ALL, ["primary@gmail.com", "family@group.calendar.google.com"]));
  assert.deepEqual(JSON.parse(stored), ["sports@group.calendar.google.com"]);

  // ...and a new calendar turns up on one of the accounts.
  const withNew = [...ALL, "new@group.calendar.google.com"];
  const visible = visibleIdsFrom(withNew, hiddenIdsFromStored(stored));

  assert.ok(
    visible.includes("new@group.calendar.google.com"),
    "the new calendar must be visible without anyone re-ticking it"
  );
  assert.deepEqual(visible, [
    "primary@gmail.com",
    "family@group.calendar.google.com",
    "new@group.calendar.google.com",
  ]);
});

test("hiding and showing round-trips through storage", () => {
  let stored = null;
  // Hide the middle one.
  stored = JSON.stringify(hiddenIdsFor(ALL, ["primary@gmail.com", "sports@group.calendar.google.com"]));
  assert.deepEqual(visibleIdsFrom(ALL, hiddenIdsFromStored(stored)), [
    "primary@gmail.com",
    "sports@group.calendar.google.com",
  ]);

  // Show everything again — the exception list must come back empty, not
  // hold the ids that were merely "not hidden last time".
  stored = JSON.stringify(hiddenIdsFor(ALL, ALL));
  assert.deepEqual(JSON.parse(stored), []);
  assert.deepEqual(visibleIdsFrom(ALL, hiddenIdsFromStored(stored)), ALL);

  // Hide everything.
  stored = JSON.stringify(hiddenIdsFor(ALL, []));
  assert.deepEqual(visibleIdsFrom(ALL, hiddenIdsFromStored(stored)), []);
});

test("hiddenIdsFor ignores calendars that are no longer listed", () => {
  const hidden = hiddenIdsFor(ALL, ["primary@gmail.com", "gone@group.calendar.google.com"]);
  assert.deepEqual(hidden, [
    "family@group.calendar.google.com",
    "sports@group.calendar.google.com",
  ]);
});

// ---------------------------------------------------------------------
// Migrating the old visible-calendars key
// ---------------------------------------------------------------------

test("the legacy visible list converts to its complement", () => {
  // Under the old scheme this device could see two of the three.
  const legacy = '["primary@gmail.com","family@group.calendar.google.com"]';
  const hidden = hiddenIdsFromLegacy(legacy, ALL);

  assert.deepEqual(hidden, ["sports@group.calendar.google.com"]);
  assert.deepEqual(visibleIdsFrom(ALL, hidden), [
    "primary@gmail.com",
    "family@group.calendar.google.com",
  ]);
});

test("a legacy list of everything converts to nothing hidden", () => {
  const legacy = JSON.stringify(ALL);
  assert.deepEqual(hiddenIdsFromLegacy(legacy, ALL), []);
  assert.deepEqual(visibleIdsFrom(ALL, hiddenIdsFromLegacy(legacy, ALL)), ALL);
});

test("a legacy list holding a removed calendar still converts sensibly", () => {
  // The device could see a calendar that has since been unshared.
  const legacy = '["primary@gmail.com","gone@group.calendar.google.com"]';
  const hidden = hiddenIdsFromLegacy(legacy, ALL);
  assert.deepEqual(hidden, [
    "family@group.calendar.google.com",
    "sports@group.calendar.google.com",
  ]);
});

test("corrupt legacy storage fails open rather than hiding everything", () => {
  for (const legacy of ["{{{ not json", "{}", ""]) {
    assert.deepEqual(hiddenIdsFromLegacy(legacy, ALL), [], `${JSON.stringify(legacy)} should hide nothing`);
  }
});

test("the migration is the inverse of the old default", () => {
  // A device that never touched the picker had no legacy key at all, and
  // under the old code that meant "everything visible". Converting it must
  // land on the same answer it would have had before.
  const hidden = hiddenIdsFromLegacy(null, ALL);
  assert.deepEqual(hidden, []);
  assert.deepEqual(visibleIdsFrom(ALL, hidden), ALL);
});

// ---------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------

test("the new key is not the old key", () => {
  // Guards against a copy-paste that would make every read look like a
  // migration and every write invisible.
  assert.notEqual(HIDDEN_CALENDARS_KEY, LEGACY_VISIBLE_CALENDARS_KEY);
  assert.match(HIDDEN_CALENDARS_KEY, /hidden/i);
});
