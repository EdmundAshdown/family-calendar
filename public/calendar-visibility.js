/* Family Board — calendar-visibility.js
 *
 * Which calendars the board shows. Kept out of the DOM and out of
 * localStorage so the rules can be unit-tested directly — see
 * tests/calendar-visibility.test.js.
 *
 * ---------------------------------------------------------------------
 * **The value persisted is the exception list — the calendars that are
 * HIDDEN — not the calendars that are shown.** That is the entire point of
 * this file, and it is worth being explicit about why.
 *
 * The board used to store the *visible* set. So the moment anyone ticked a
 * box in the Calendars picker, that set was frozen, and a calendar that
 * appeared afterwards — a new shared calendar, a family member joining one
 * of the signed-in accounts, a subscription — simply was not in it. It
 * rendered hidden, and nothing on screen explained why. The symptom a
 * family would report is "the board can't see the new calendar", which
 * points you at Google rather than at this.
 *
 * Storing the hidden set inverts the default: anything not deliberately
 * hidden is shown, so new calendars arrive visible with no interaction and
 * the bug cannot come back.
 * ---------------------------------------------------------------------
 *
 * Unreadable or corrupt storage always fails **open** (everything shown).
 * A blank family calendar is a much worse failure than a crowded one.
 */

const HIDDEN_CALENDARS_KEY = "familyBoard.hiddenCalendars";

// The pre-2026-10-18 key, which held the *visible* list. Read once, to
// convert the family's existing choices, then removed.
const LEGACY_VISIBLE_CALENDARS_KEY = "familyBoard.visibleCalendars";

/* Turns a raw localStorage string into an array of calendar IDs, or null
 * if it is absent or unusable. */
function parseIdList(raw) {
  if (raw === null || raw === undefined) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  return parsed.filter((id) => typeof id === "string");
}

// The stored exception list. Anything unreadable means "nothing is hidden".
function hiddenIdsFromStored(storedRaw) {
  return parseIdList(storedRaw) || [];
}

/* Converts the legacy "these are the calendars that were visible" list into
 * the hidden list that replaces it: everything they could see at the time,
 * inverted. A calendar in the legacy list that no longer exists just drops
 * out, and anything the legacy list never mentioned counts as hidden —
 * which is what "not visible" meant under the old scheme.
 *
 * An absent or unreadable legacy value converts to **nothing hidden**,
 * because that is exactly what the old code did with it: it fell back to
 * "everything visible". Treating it as "nothing was visible" instead would
 * hide every calendar the first time this ran on such a device.
 *
 * Keyed on ids rather than objects so it can be reasoned about in tests.
 */
function hiddenIdsFromLegacy(legacyRaw, allIds) {
  const legacyVisible = parseIdList(legacyRaw);
  if (legacyVisible === null) return [];

  const wasVisible = new Set(legacyVisible);
  return allIds.filter((id) => !wasVisible.has(id));
}

function visibleIdsFrom(allIds, hiddenIds) {
  const hidden = new Set(hiddenIds);
  return allIds.filter((id) => !hidden.has(id));
}

/* The inverse of visibleIdsFrom: what a caller means by "these should be
 * visible" expressed as the exception list that actually gets stored. */
function hiddenIdsFor(allIds, visibleIds) {
  const visible = new Set(visibleIds);
  return allIds.filter((id) => !visible.has(id));
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    HIDDEN_CALENDARS_KEY,
    LEGACY_VISIBLE_CALENDARS_KEY,
    parseIdList,
    hiddenIdsFromStored,
    hiddenIdsFromLegacy,
    visibleIdsFrom,
    hiddenIdsFor,
  };
}
