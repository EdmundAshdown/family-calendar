/* Family Board — app.js
 * Talks to the Google Calendar API using access tokens supplied by a
 * small local Flask server (server.py), which holds a refresh token for
 * EACH signed-in family member's Google account. Fetching each person's
 * calendars with their own credentials is what makes Gmail-created
 * events (hotel stays, flights) visible — Google hides those from
 * shared-calendar access, showing them only to the calendar's owner.
 */

const TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

let accounts = []; // [{email, access_token}] — every signed-in Google account
let tokenByEmail = {}; // email -> access_token, rebuilt on every sync
let pollTimer = null;
let latestEvents = []; // cached, so toggling calendar visibility doesn't need a refetch
let currentMonthDate = new Date(); // which month the person has navigated to
let displayedMonth = null; // the month the heading and grid on screen actually agree on
let calendarList = []; // merged + deduped across all signed-in accounts
let clockTimer = null; // ticks the clock, and keeps today's cell honest
let todaySignature = null; // what today's cell last drew, so time passing need not redraw the grid

// How many events a day cell shows inline — one beside the date number and
// two stacked below it. Which three it chooses is selectInlineEvents in
// calendar-dates.js, and for today that choice depends on the clock.
const MAX_INLINE_EVENTS = 3;

const el = (id) => document.getElementById(id);

// Sent on every /api/* request. This is not a secret — it is in a file the
// browser serves to anyone who asks. What it does buy is CSRF resistance:
// a cross-origin page cannot set a custom header without triggering a CORS
// preflight, and server.py refuses the preflight. So another site open in
// this browser can no longer POST /api/logout and sign the family out.
const API_HEADERS = { "X-Family-Board": "family-board" };

// ---------------------------------------------------------------------
// Calendar visibility (persisted locally per device)
//
// The persisted value is the list of HIDDEN calendars, not the visible
// ones, so that a calendar appearing later shows up on its own. The rules
// live in calendar-visibility.js; these are the localStorage wrappers.
// ---------------------------------------------------------------------

function getHiddenCalendarIds() {
  const stored = localStorage.getItem(HIDDEN_CALENDARS_KEY);
  if (stored !== null) return new Set(hiddenIdsFromStored(stored));

  // No hidden list yet. If this device has pre-2026-10-18 choices under the
  // old "visible calendars" key, convert them once so nobody's existing
  // selection is silently thrown away.
  const legacy = localStorage.getItem(LEGACY_VISIBLE_CALENDARS_KEY);
  if (legacy === null) return new Set();

  // The conversion is the complement of the old list, which needs the
  // calendar list to compute. If it isn't loaded yet, leave the legacy key
  // where it is and convert on a later call rather than guessing — guessing
  // would either hide every calendar or discard the family's choices.
  if (calendarList.length === 0) return new Set();

  const hidden = hiddenIdsFromLegacy(legacy, calendarList.map((c) => c.id));
  localStorage.setItem(HIDDEN_CALENDARS_KEY, JSON.stringify(hidden));
  localStorage.removeItem(LEGACY_VISIBLE_CALENDARS_KEY);
  return new Set(hidden);
}

function getVisibleCalendarIds() {
  return new Set(visibleIdsFrom(calendarList.map((c) => c.id), getHiddenCalendarIds()));
}

// Callers pass the calendars that should be visible — that is what the
// picker and the legend reason about. What gets written is its complement.
function setVisibleCalendarIds(idSet) {
  const hidden = hiddenIdsFor(calendarList.map((c) => c.id), [...idSet]);
  localStorage.setItem(HIDDEN_CALENDARS_KEY, JSON.stringify(hidden));
}

// ---------------------------------------------------------------------
// Custom calendar names (persisted locally per device)
// ---------------------------------------------------------------------

const CALENDAR_NAMES_KEY = "familyBoard.calendarNames";

function getCustomCalendarNames() {
  try {
    return JSON.parse(localStorage.getItem(CALENDAR_NAMES_KEY)) || {};
  } catch {
    return {};
  }
}

function setCustomCalendarName(calId, name) {
  const names = getCustomCalendarNames();
  names[calId] = name;
  localStorage.setItem(CALENDAR_NAMES_KEY, JSON.stringify(names));
}

// Applies any saved custom names over whatever label Google gave us.
function applyCustomNames(calendars) {
  const custom = getCustomCalendarNames();
  return calendars.map((cal) => (custom[cal.id] ? { ...cal, label: custom[cal.id] } : cal));
}

// Best-effort only: Google doesn't hand us a shared calendar owner's
// actual first name (that would need the separate People API and another
// consent scope, and still wouldn't work for every account). This just
// catches the common "firstname.lastname@..." pattern as a convenience
// pre-fill when renaming — anything else, the person just types the name
// themselves in the rename box.
function guessFirstNameFromEmail(label) {
  const match = label.match(/^([a-zA-Z]+)\.[a-zA-Z]+@/);
  if (!match) return null;
  const first = match[1];
  return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
}

function renderCalendarsPicker() {
  const visible = getVisibleCalendarIds();
  const list = el("calendars-list");

  if (calendarList.length === 0) {
    list.innerHTML = `<p class="calendars-empty">No calendars found for this account.</p>`;
    return;
  }

  list.innerHTML = calendarList
    .map(
      (cal) => `
    <div class="calendar-row" data-cal-row="${escapeHtml(cal.id)}">
      <label class="calendar-row-main">
        <input type="checkbox" data-cal-id="${escapeHtml(cal.id)}" ${
          visible.has(cal.id) ? "checked" : ""
        }>
        <span class="calendar-dot" style="background:${cal.color}"></span>
        <span class="label" data-role="label">${escapeHtml(cal.label)}</span>
        <span class="account-tag" title="Fetched using ${escapeHtml(cal._accountEmail || "")}">via ${escapeHtml((cal._accountEmail || "").split("@")[0])}</span>
      </label>
      ${!cal.canWrite ? `<span class="view-only-tag">view only</span>` : ""}
      <button type="button" class="rename-btn" data-rename-id="${escapeHtml(cal.id)}" title="Rename">✎</button>
    </div>`
    )
    .join("");

  list.querySelectorAll('input[type="checkbox"]').forEach((box) => {
    box.addEventListener("change", () => {
      const visible = getVisibleCalendarIds();
      const id = box.dataset.calId;
      if (box.checked) visible.add(id);
      else visible.delete(id);
      setVisibleCalendarIds(visible);
      renderMonth(latestEvents);
    });
  });

  list.querySelectorAll(".rename-btn").forEach((btn) => {
    btn.addEventListener("click", () => startRenamingCalendar(btn.dataset.renameId));
  });
}

function startRenamingCalendar(calId) {
  const row = findCalendarRow(calId);
  const cal = calendarList.find((c) => c.id === calId);
  if (!row || !cal) return;

  const labelSpan = row.querySelector('[data-role="label"]');
  const alreadyCustom = !!getCustomCalendarNames()[calId];
  const guess = alreadyCustom ? null : guessFirstNameFromEmail(cal.label);

  const input = document.createElement("input");
  input.type = "text";
  input.className = "rename-input";
  input.value = guess || cal.label;
  labelSpan.replaceWith(input);
  input.focus();
  input.select();

  const commit = () => {
    const newName = input.value.trim();
    if (newName && newName !== cal.label) {
      setCustomCalendarName(calId, newName);
      calendarList = applyCustomNames(calendarList);
      refreshWriteControls();
      renderMonth(latestEvents); // refreshes the legend too
    }
    renderCalendarsPicker(); // re-render either way, to exit edit mode
  };

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      // Cancel the rename *without* letting the press carry on to the
      // document listener that dismisses overlays — otherwise Escape would
      // both abandon the rename and close the whole Calendars panel.
      e.stopPropagation();
      renderCalendarsPicker(); // discard, no changes
    }
  });
  input.addEventListener("blur", commit);
}

function findCalendarRow(calId) {
  return document.querySelector(`.calendar-row[data-cal-row="${CSS.escape(calId)}"]`);
}

function refreshWriteControls() {
  const writable = calendarList.filter((c) => c.canWrite);
  el("ev-calendar").innerHTML = writable
    .map((cal) => `<option value="${escapeHtml(cal.id)}">${escapeHtml(cal.label)}</option>`)
    .join("");

  // With nothing writeable the form used to submit an empty calendar id and
  // fail at the far end of a round trip, which read as the board being broken.
  // Close the two doors into that form instead. The explanation goes on the
  // buttons themselves; the likelier cause — the calendar list not having
  // loaded — is already reported by the sync status line.
  const blocked = writable.length === 0;
  const reason = blocked
    ? calendarList.length === 0
      ? "Calendars haven't loaded yet."
      : "None of these calendars allow adding events."
    : null;
  for (const id of ["add-event-btn", "day-detail-add-btn"]) {
    const btn = el(id);
    btn.disabled = blocked;
    if (reason) {
      btn.title = reason;
      btn.setAttribute("aria-label", `${btn.textContent.trim()} — ${reason}`);
    } else {
      btn.removeAttribute("title");
      btn.removeAttribute("aria-label");
    }
  }
}

el("calendars-btn").addEventListener("click", () => {
  renderCalendarsPicker();
  renderAccountsList();
  openOverlay("calendars-overlay");
});

function renderAccountsList() {
  const list = el("accounts-list");
  const rows = [];

  for (const acct of accounts) {
    rows.push(`
      <div class="account-row">
        <span class="account-email">${escapeHtml(acct.email)}</span>
        <button type="button" class="signout-btn" data-signout-email="${escapeHtml(acct.email)}">Sign out</button>
      </div>`);
  }
  for (const email of staleAccounts) {
    rows.push(`
      <div class="account-row stale">
        <span class="account-email">${escapeHtml(email)}</span>
        <span class="stale-tag">needs re-sign-in</span>
        <button type="button" class="signout-btn" data-signout-email="${escapeHtml(email)}">Remove</button>
      </div>`);
  }

  list.innerHTML =
    rows.length > 0
      ? rows.join("")
      : `<p class="accounts-empty">No accounts signed in.</p>`;

  list.querySelectorAll(".signout-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const email = btn.dataset.signoutEmail;
      if (!confirm(`Sign ${email} out of the board? Their calendars will disappear until they sign in again.`)) return;
      try {
        await fetch(`/api/logout?email=${encodeURIComponent(email)}`, {
          method: "POST",
          headers: API_HEADERS,
        });
      } catch (err) {
        console.error("Sign-out failed:", err);
        return;
      }
      // Rebuild everything from the remaining accounts.
      const result = await getAccounts();
      if (result.accounts.length === 0) {
        closeOverlay("calendars-overlay");
        showSignInRequired("Signed out.");
        return;
      }
      applyAccounts(result);
      calendarList = await fetchCalendarLists();
      refreshWriteControls();
      renderCalendarsPicker();
      renderAccountsList();
      loadMonth();
    });
  });
}

el("close-calendars-btn").addEventListener("click", () => {
  closeOverlay("calendars-overlay");
});

el("add-account-btn").addEventListener("click", () => {
  // Same full-page OAuth flow as the sign-in button — Google will show the
  // account chooser, so picking a different family member's account adds
  // it alongside the ones already signed in.
  window.location.href = "/login";
});

// ---------------------------------------------------------------------
// Theme picker
// ---------------------------------------------------------------------

function renderThemePicker() {
  const activeId = getStoredThemeId();
  const list = el("theme-list");
  list.innerHTML = THEMES.map(
    (t) => `
    <div class="theme-swatch ${t.id === activeId ? "active" : ""}" data-theme-id="${t.id}">
      <div class="theme-swatch-preview" style="background:${t.vars.bg}">
        <span class="theme-swatch-dot" style="background:${t.vars.accent}"></span>
      </div>
      <div class="theme-swatch-label">${escapeHtml(t.label)}</div>
      <div class="theme-swatch-desc">${escapeHtml(t.description)}</div>
    </div>`
  ).join("");

  list.querySelectorAll(".theme-swatch").forEach((card) => {
    card.addEventListener("click", () => {
      applyTheme(card.dataset.themeId);
      renderThemePicker(); // re-render so the "active" highlight moves
    });
  });
}

el("theme-btn").addEventListener("click", () => {
  renderThemePicker();
  openOverlay("theme-overlay");
});

el("close-theme-btn").addEventListener("click", () => {
  closeOverlay("theme-overlay");
});

// ---------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------

window.addEventListener("load", init);

async function init() {
  renderDayNamesHeader();
  startBoardTick();

  const result = await getAccounts();
  if (result.accounts.length === 0) {
    showSigninScreen();
    return;
  }
  applyAccounts(result);
  await onSignedIn();
}

// Asks the local Flask server for currently-valid access tokens — one per
// signed-in Google account. Flask holds the real refresh tokens and
// silently renews them server-side as needed, so this works the same
// whether it's been 5 minutes or 5 days since the last visit. `stale`
// lists accounts whose refresh token has died and need a re-sign-in.
async function getAccounts() {
  try {
    const res = await fetch("/api/tokens", { headers: API_HEADERS });
    const data = await res.json().catch(() => ({}));
    return { accounts: data.accounts || [], stale: data.stale || [] };
  } catch (err) {
    console.error("Couldn't reach the local server for tokens:", err);
    return { accounts: [], stale: [] };
  }
}

function applyAccounts(result) {
  accounts = result.accounts;
  tokenByEmail = Object.fromEntries(accounts.map((a) => [a.email, a.access_token]));
  staleAccounts = result.stale;
}

let staleAccounts = [];

function showSigninScreen() {
  el("dashboard").classList.add("hidden");
  el("signin-screen").classList.remove("hidden");
}

el("signin-btn").addEventListener("click", () => {
  // Full navigation to Flask's /login route, which redirects to Google's
  // real consent screen and back — no popup involved, so nothing here
  // can be blocked by a popup blocker.
  window.location.href = "/login";
});

async function onSignedIn() {
  el("signin-screen").classList.add("hidden");
  el("dashboard").classList.remove("hidden");

  try {
    calendarList = await fetchCalendarLists();
  } catch (err) {
    console.error(err);
    setSyncStatus("Couldn't load your calendar list — will retry.");
  }

  refreshWriteControls();
  // Paint the heading for the current month before the first fetch, so a
  // failed first sync leaves an empty board for the right month rather
  // than no month at all. loadMonth redraws it once events arrive.
  displayedMonth = getMonthStart(currentMonthDate);
  renderMonthHeading(displayedMonth);
  loadMonth();
  schedulePolling();
}

// Curated so every color reads clearly against both light and dark
// theme backgrounds, and stays visually distinct from its neighbors —
// unlike Google's own per-calendar colors, which often clash or nearly
// match each other (several blues/purples especially).
const CALENDAR_COLOR_PALETTE = [
  "#d1574f", // coral red
  "#3f7fb3", // ocean blue
  "#c9932f", // golden amber
  "#4f8f5f", // forest green
  "#8a5aa3", // plum purple
  "#3f9c8f", // teal
  "#c9587f", // rose pink
  "#5f6fb3", // slate blue
  "#c9702f", // burnt orange
  "#7f8f4f", // sage olive
];

// Assigns each calendar a palette color, sorted by ID so the same
// calendar always gets the same color across reloads regardless of the
// order Google happens to return them in.
function assignCalendarColors(calendars) {
  const sorted = [...calendars].sort((a, b) => a.id.localeCompare(b.id));
  const colorById = new Map();
  sorted.forEach((cal, i) => {
    colorById.set(cal.id, CALENDAR_COLOR_PALETTE[i % CALENDAR_COLOR_PALETTE.length]);
  });
  return calendars.map((cal) => ({ ...cal, color: colorById.get(cal.id) }));
}

// Every calendar every signed-in account can see. The same calendar often
// appears under multiple accounts (e.g. a shared family calendar) — those
// get deduped by ID, keeping whichever account has the strongest access
// (owner > writer > reader), so event fetches and inserts go through the
// account with the most permission. Each surviving entry remembers which
// account it came from (_accountEmail) so requests use the right token.
async function fetchCalendarLists() {
  // Google reports the "Make changes and manage sharing" permission as
  // accessRole "owner" even for people who don't actually own the
  // calendar — so a spouse's calendar can tie at owner-rank under both
  // accounts. The +1 primary bonus breaks that tie toward the account the
  // calendar actually belongs to, which is the only account Google shows
  // Gmail-created ("Only me") events to.
  const rank = { owner: 3, writer: 2, reader: 1, freeBusyReader: 0 };
  const byId = new Map();

  for (const acct of accounts) {
    const url =
      "https://www.googleapis.com/calendar/v3/users/me/calendarList?showHidden=true&maxResults=250";
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${acct.access_token}` },
    });
    if (!res.ok) {
      console.error(`Calendar list fetch failed for ${acct.email}: ${res.status}`);
      continue; // one account's failure shouldn't hide everyone else's calendars
    }
    const data = await res.json();

    for (const cal of data.items || []) {
      const entry = {
        id: cal.id,
        label: cal.summaryOverride || cal.summary,
        canWrite: cal.accessRole === "owner" || cal.accessRole === "writer",
        _score: (rank[cal.accessRole] ?? 0) * 10 + (cal.primary ? 1 : 0),
        _accountEmail: acct.email,
      };
      const existing = byId.get(cal.id);
      if (!existing || entry._score > existing._score) {
        byId.set(cal.id, entry);
      }
    }
  }

  return applyCustomNames(assignCalendarColors([...byId.values()]));
}

function showSigninError(msg) {
  el("signin-status").textContent = msg;
}

// Used whenever Google itself rejects a request with a 401 despite Flask
// saying we had a token — e.g. access was revoked in the person's Google
// account settings. Stops polling and puts the person back at a clear
// "please sign in" state instead of a silently stale dashboard.
function showSignInRequired(message) {
  if (pollTimer) clearInterval(pollTimer);
  accounts = [];
  tokenByEmail = {};
  displayedMonth = null; // so the tick stops trying to render a month we can't fetch
  showSigninScreen();
  showSigninError(message);
}

function schedulePolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    // A dark board has nobody watching it; Google can wait until morning.
    if (boardIsQuiet) return;
    loadMonth();
  }, CONFIG.EVENT_POLL_MINUTES * 60 * 1000);
}

// ---------------------------------------------------------------------
// Fetching + rendering the month
// ---------------------------------------------------------------------

// DAY_NAMES, MS_PER_DAY, toIsoDate, getMonthStart/getGridStart/getGridEnd,
// parseEventBounds, isSameLocalDay and eventOverlapsDay now live in
// calendar-dates.js, which has no DOM or network access so the date logic
// can be unit-tested directly — see tests/calendar-dates.test.js.

function renderDayNamesHeader() {
  el("month-daynames").innerHTML = DAY_NAMES.map((n) => `<div>${n}</div>`).join("");
}

el("prev-month-btn").addEventListener("click", () => {
  currentMonthDate = new Date(currentMonthDate.getFullYear(), currentMonthDate.getMonth() - 1, 1);
  loadMonth();
});

el("next-month-btn").addEventListener("click", () => {
  currentMonthDate = new Date(currentMonthDate.getFullYear(), currentMonthDate.getMonth() + 1, 1);
  loadMonth();
});

el("today-btn").addEventListener("click", () => {
  currentMonthDate = new Date();
  loadMonth();
});

function renderMonthHeading(monthStart) {
  el("month-range").textContent = monthStart.toLocaleDateString(undefined, { month: "long" });
  el("year-subtitle").textContent = `Family Board · ${monthStart.getFullYear()}`;
  el("month-numeral").textContent = String(monthStart.getMonth() + 1).padStart(2, "0");
}

async function loadMonth() {
  const monthStart = getMonthStart(currentMonthDate);
  const gridStart = getGridStart(monthStart);
  const gridEnd = getGridEnd(monthStart);

  setSyncStatus("Syncing…");

  // Always ask Flask for fresh tokens rather than reusing whatever's
  // cached in the browser — Flask keeps them valid server-side, which is
  // what makes long-running sessions work without a re-click.
  const result = await getAccounts();
  if (result.accounts.length === 0) {
    showSignInRequired("Signed out — please sign in again.");
    return;
  }
  applyAccounts(result);

  try {
    const { events, failed } = await fetchAllCalendars(gridStart, gridEnd);
    latestEvents = events;

    // The heading and the grid are moved in the same breath, and only once
    // the events are in hand. The heading used to be updated *before* the
    // network calls, so any failed sync left it describing a month the
    // grid was not showing — the board looked frozen rather than broken.
    renderMonthHeading(monthStart);
    displayedMonth = monthStart;
    renderMonth(events);

    let status = `Last synced ${new Date().toLocaleTimeString()}`;
    if (failed > 0) {
      // Some calendars loaded and some didn't, so the board is showing
      // less than the family actually has. Say so.
      status += ` — ${failed} calendar${failed === 1 ? "" : "s"} couldn't be loaded`;
    }
    if (staleAccounts.length > 0) {
      status += ` — ${staleAccounts.join(", ")} needs to sign in again (Calendars → Add Google account)`;
    }
    setSyncStatus(status);
  } catch (err) {
    console.error(err);

    // Nothing was drawn, so put navigation back on the month that is
    // actually on screen. Without this, currentMonthDate would be left
    // pointing at a month we never loaded, and the next calendar
    // visibility toggle (which re-renders from currentMonthDate) would
    // silently swap the grid to it underneath the old heading.
    if (displayedMonth) currentMonthDate = new Date(displayedMonth);

    if (err.status === 401) {
      showSignInRequired("Session expired — please sign in again.");
    } else {
      // The last month that did load stays on screen, so the board is
      // never silently empty. Say plainly what happened instead.
      const shown = monthStart.toLocaleDateString(undefined, { month: "long" });
      setSyncStatus(`Couldn't load ${shown} — will retry.`);
    }
  }
}

// Fetches every calendar in parallel — each with the token of the account
// it was discovered under — and tags each event with which calendar (and
// color) it came from, so the picker can filter and the chips can be
// color-coded without re-fetching.
//
// Returns { events, failed }. `failed` is how many calendars came back
// broken, so the caller can say so rather than presenting a partial board
// as a complete one.
async function fetchAllCalendars(timeMin, timeMax) {
  const settled = await Promise.allSettled(
    calendarList.map(async (cal) => {
      const items = await fetchEvents(cal, timeMin, timeMax);
      return items.map((ev) => ({ ...ev, _calendarId: cal.id, _color: cal.color }));
    })
  );

  const failures = settled.filter((r) => r.status === "rejected");
  const successes = settled.filter((r) => r.status === "fulfilled");

  // A 401 means a token died mid-cycle (rare — Flask refreshes them every
  // sync). Surface it distinctly so the caller can force a re-sign-in
  // instead of quietly rendering an incomplete board.
  const authFailure = failures.find((r) => r.reason && r.reason.status === 401);
  if (authFailure) {
    const err = new Error("Authentication expired");
    err.status = 401;
    throw err;
  }

  // If *every* calendar failed, do not quietly return an empty list. That
  // rendered a blank month with a cheerful "Last synced" underneath it —
  // so a wifi outage looked exactly like a family with nothing on that
  // week, which is the one thing a calendar on the wall must never do.
  // Throwing instead leaves the last good month on screen and says so.
  if (settled.length > 0 && successes.length === 0) {
    throw failures[0].reason || new Error("Every calendar failed to load");
  }

  failures.forEach((r) => console.error("Failed to fetch a calendar:", r.reason)); // one bad calendar shouldn't break the whole board

  const all = successes.flatMap((r) => r.value);

  // With multiple accounts, the same event often appears on more than one
  // calendar (an invite Jamie sent Edmund lives on both of their
  // calendars, with the same event ID). Keep only the first copy so it
  // doesn't render twice on the board.
  const seen = new Set();
  const deduped = all.filter((ev) => {
    if (!ev.id) return true;
    if (seen.has(ev.id)) return false;
    seen.add(ev.id);
    return true;
  });

  // Finally, one chronological order across every calendar.
  //
  // `all` is grouped by calendar, because each calendar is fetched
  // separately and the results are concatenated. A day cell shows only the
  // first three of this list, so without the sort a single person's
  // calendar could fill the cell while everyone else's day sat behind
  // "+N more" — and the times on screen read shuffled, because the first
  // chip was whichever calendar came first rather than the earliest event.
  // See sortEventsByStart in calendar-dates.js.
  //
  // Deliberately after the dedupe, not before: the sort is stable and two
  // copies of the same invite share a start time, so deduping first keeps
  // exactly the copy — and therefore the colour — the board has always
  // shown for it.
  return { events: sortEventsByStart(deduped), failed: failures.length };
}

// Google returns a page of events and a `nextPageToken` when there are more.
// Asking for the API's maximum and then following the token is the difference
// between a complete month and one whose far end is *silently missing* — the
// events that never arrive are not there to look wrong, so the board renders
// a short month that is indistinguishable from a quiet one.
//
// This matters more than it sounds, because singleEvents=true expands a
// recurring event into one item per occurrence: a single daily event is worth
// about 42 items across the six-week grid asked for below, so a couple of
// recurring events plus ordinary family life can reach the 250 items Google
// used to return by default.
const MAX_EVENT_PAGES = 20; // 50,000 events in one six-week window — not a real state

async function fetchEvents(cal, timeMin, timeMax) {
  const headers = { Authorization: `Bearer ${tokenByEmail[cal._accountEmail]}` };
  const items = [];
  let pageToken = null;

  for (let page = 0; page < MAX_EVENT_PAGES; page += 1) {
    const url = new URL(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal.id)}/events`
    );
    url.searchParams.set("timeMin", timeMin.toISOString());
    url.searchParams.set("timeMax", timeMax.toISOString());
    url.searchParams.set("singleEvents", "true");
    url.searchParams.set("orderBy", "startTime");
    url.searchParams.set("maxResults", "2500");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const res = await fetch(url, {
      headers,
    });

    if (!res.ok) {
      const err = new Error(`Calendar fetch failed: ${res.status}`);
      err.status = res.status;
      throw err;
    }
    const data = await res.json();
    items.push(...(data.items || []));
    pageToken = data.nextPageToken || null;
    if (!pageToken) return items;
  }

  // Deliberately loud rather than a partial answer. Returning what we have
  // would hand back a truncated calendar that renders exactly like a complete
  // one — the failure this function exists to avoid. Better that the board
  // says it couldn't load this calendar than that a month quietly ends early.
  const err = new Error(`Calendar fetch exceeded ${MAX_EVENT_PAGES} pages`);
  err.status = 0;
  throw err;
}

function renderMonth(events) {
  const monthStart = getMonthStart(currentMonthDate);
  const gridStart = getGridStart(monthStart);
  const gridEnd = getGridEnd(monthStart);
  const numCells = Math.round((gridEnd - gridStart) / MS_PER_DAY);
  const numRows = numCells / 7;

  const grid = el("month-grid");
  grid.innerHTML = "";

  // Captured once, so every cell in this render agrees on what "now" is.
  // today's cell depends on it (see selectInlineEvents); the other days do
  // not, which is the point of passing it in rather than reading the clock
  // per cell.
  const now = new Date();
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);

  const visible = getVisibleCalendarIds();
  const visibleEvents = events.filter((ev) => visible.has(ev._calendarId));

  renderLegend(visible);

  for (let w = 0; w < numRows; w++) {
    const weekRow = document.createElement("div");
    weekRow.className = "week-row";

    const divider = document.createElement("div");
    divider.className = "week-divider";
    weekRow.appendChild(divider);

    const weekDays = document.createElement("div");
    weekDays.className = "week-days";

    for (let d = 0; d < 7; d++) {
      const day = new Date(gridStart);
      day.setDate(day.getDate() + (w * 7 + d));

      const dayEvents = visibleEvents.filter((ev) => eventOverlapsDay(ev, day));
      const isToday = day.getTime() === today.getTime();

      const cell = document.createElement("div");
      cell.className = "day-cell";
      if (day.getMonth() !== monthStart.getMonth()) cell.classList.add("outside-month");
      if (isToday) cell.classList.add("today");

      const isAllDay = (ev) => !ev.start.dateTime;
      const dateIso = toIsoDate(day);
      // Today's three are chosen by time of day; every other day's are
      // simply the earliest three. See selectInlineEvents.
      const visibleInline = selectInlineEvents(dayEvents, MAX_INLINE_EVENTS, now, isToday);
      const [firstEvent, ...restEvents] = visibleInline;
      const overflowCount = dayEvents.length - visibleInline.length;

      // Only show a specific clock time on the day the event actually
      // starts — showing e.g. "10:00 AM" repeated on every day of a
      // multi-day stay would be misleading past the first day.
      const chipHtml = (ev) => {
        const isStartDay = isSameLocalDay(parseEventBounds(ev).start, day);
        const showTime = !isAllDay(ev) && isStartDay;
        const title = escapeHtml(ev.summary || "(no title)");
        return `
        <div class="event-chip" style="--chip-color:${ev._color}" title="${title}">
          <span class="event-tick" style="background:${ev._color}"></span>
          <span class="event-label">${showTime ? `<span class="event-time">${formatTime(ev.start.dateTime)}</span>` : ""}${title}</span>
        </div>`;
      };

      cell.innerHTML = `
        <div class="day-top-row">
          <div class="day-number">${day.getDate()}</div>
          ${isToday ? `<span class="today-dot"></span>` : ""}
          ${firstEvent ? chipHtml(firstEvent) : ""}
        </div>
        <div class="day-events ${overflowCount > 0 ? "has-overflow" : ""}" data-date="${dateIso}">
          ${restEvents.map(chipHtml).join("")}
          ${overflowCount > 0 ? `<div class="more-chip">+${overflowCount} more</div>` : ""}
        </div>
      `;

      if (dayEvents.length > 0) {
        const clickTarget = firstEvent ? cell : cell.querySelector(".day-events");
        clickTarget.addEventListener("click", () => {
          showDayDetail(day, dateIso, dayEvents);
        });
        cell.style.cursor = "pointer";
      }

      weekDays.appendChild(cell);
    }

    weekRow.appendChild(weekDays);
    grid.appendChild(weekRow);
  }

  // One trailing divider after the last week, matching the one before each
  // of the others — completes the frame at the bottom of the grid.
  const finalDivider = document.createElement("div");
  finalDivider.className = "week-divider";
  grid.appendChild(finalDivider);

  // Remember what today's cell ended up showing, so the clock's tick can
  // tell whether the passage of time has actually changed it rather than
  // redrawing the grid for nothing. It changes a handful of times a day.
  todaySignature = todayInlineSignature(events, monthStart, now);
}

// ---------------------------------------------------------------------
// The clock — and keeping "today" honest
//
// The clock is not decoration. Today's cell shows what is still to come
// rather than the earliest events, which makes the grid a function of the
// current time; without a tick, a board left running would still be
// showing this morning's plan the next morning. The clock is also what
// makes the cell readable — "next at 5pm" only means something if you can
// see that it is half three.
// ---------------------------------------------------------------------

const CLOCK_TICK_MS = 5000; // fine enough that the displayed minute is never visibly stale

// The month that was "this month" at the previous tick. Comparing it with
// the wall clock on each tick is how the board notices the calendar rolling
// over while it sits there.
let lastSeenCurrentMonth = null;

function updateClock(now = new Date()) {
  const text = now.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  // The clock on the quiet screen is its own element so that the board's
  // clock can be hidden with the dashboard without the dark screen losing
  // its only content.
  for (const id of ["board-clock", "quiet-clock"]) {
    const node = el(id);
    if (node && node.textContent !== text) node.textContent = text;
  }
}

/* A fingerprint of what today's cell is currently showing.
 *
 * Compared on each tick: if it is unchanged, the time passing has not
 * altered anything on screen and the grid is left alone. Only when an
 * event starts or finishes — or the date rolls over — does it change.
 */
function todayInlineSignature(events, monthStart, now) {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);

  // Today need not be in the *month* being shown to be on screen: the grid
  // draws whole weeks, so the 1st can appear in the trailing days of the
  // previous month's grid. Ask the grid's real bounds, not the month's.
  if (today < getGridStart(monthStart) || today >= getGridEnd(monthStart)) return "";

  const visible = getVisibleCalendarIds();
  const dayEvents = events.filter((ev) => visible.has(ev._calendarId) && eventOverlapsDay(ev, today));
  return selectInlineEvents(dayEvents, MAX_INLINE_EVENTS, now, true)
    .map((ev) => ev.id || ev.summary || "?")
    .join("|");
}

// ---------------------------------------------------------------------
// Quiet hours
//
// An old TV left on all night is the one real cost of this board that
// isn't a bug: a lit screen nobody is looking at, burning panel hours and
// polling Google every three minutes for nothing. Quiet hours dim it to
// near-black and pause the poll. Touching the board during them wakes it
// for a few minutes, then it sleeps again.
//
// The time-window logic (including windows that cross midnight) lives in
// quiet-hours.js, where it can be tested. This file only owns the
// browser-side state.
// ---------------------------------------------------------------------

let quietWakeUntil = 0; // wake the board until this timestamp (ms)
let boardIsQuiet = false;

function isBoardQuiet(now = new Date()) {
  if (now.getTime() < quietWakeUntil) return false;
  return isQuietNow(now, CONFIG.QUIET_HOURS);
}

function applyQuietState(now = new Date()) {
  const quiet = isBoardQuiet(now);
  if (quiet === boardIsQuiet) return;
  boardIsQuiet = quiet;
  document.body.classList.toggle("quiet", quiet);
  // Polling was paused while quiet; catch up immediately on waking so the
  // board is current rather than showing whatever it had at bedtime.
  if (!quiet) loadMonth();
}

function wakeFromQuiet() {
  if (!boardIsQuiet) return;
  quietWakeUntil = Date.now() + CONFIG.QUIET_WAKE_MINUTES * 60 * 1000;
  applyQuietState();
}

// Capture phase, so the wake happens before the tap reaches anything
// underneath — the quiet screen is opaque and intercepts the first tap
// anyway, but this makes the intent explicit.
document.addEventListener("pointerdown", wakeFromQuiet, true);
document.addEventListener("keydown", wakeFromQuiet, true);

function startBoardTick() {
  updateClock();
  lastSeenCurrentMonth = getMonthStart(new Date());
  applyQuietState();
  if (clockTimer) clearInterval(clockTimer);
  clockTimer = setInterval(() => {
    const now = new Date();
    updateClock(now);
    applyQuietState(now);

    // While it is dark there is nothing to keep honest: the grid is
    // invisible and the poll is paused.
    if (boardIsQuiet) return;

    // Nothing drawn yet (or signed out) — there is no cell to keep honest.
    if (!displayedMonth) return;

    // Follow the calendar across a month boundary.
    //
    // Nothing else moves currentMonthDate: only the arrows and Today ever
    // did, and the 3-minute poll re-reads it. So a board nobody touches kept
    // showing whatever month it was on when it last loaded — on the 1st of a
    // new month, a wall calendar with last month's name at the top of it.
    //
    // Advance only when the month on screen is the one that has *just
    // ended*. Someone who deliberately paged back to look at last month's
    // events, or forward at next month's, is left where they put it.
    const nowMonth = getMonthStart(now);
    const rolledOver =
      lastSeenCurrentMonth !== null && nowMonth.getTime() !== lastSeenCurrentMonth.getTime();
    const showingTheEndedMonth =
      rolledOver && displayedMonth.getTime() === lastSeenCurrentMonth.getTime();
    lastSeenCurrentMonth = nowMonth;

    if (showingTheEndedMonth) {
      currentMonthDate = new Date();
      loadMonth(); // redraws for the new month, and refreshes the signature
      return;
    }

    const signature = todayInlineSignature(latestEvents, getMonthStart(currentMonthDate), now);
    if (signature !== todaySignature) renderMonth(latestEvents);
  }, CLOCK_TICK_MS);
}

const LEGEND_LABEL_MAX_LENGTH = 16;

function truncateLabel(label, maxLength = LEGEND_LABEL_MAX_LENGTH) {
  if (label.length <= maxLength) return label;
  return `${label.slice(0, maxLength - 1)}…`;
}

function renderLegend(visibleIds) {
  const legend = el("calendar-legend");
  const visibleCalendars = calendarList.filter((cal) => visibleIds.has(cal.id));

  legend.innerHTML = visibleCalendars
    .map(
      (cal) => `
    <div class="legend-item" data-legend-id="${escapeHtml(cal.id)}" title="${escapeHtml(cal.label)}">
      <span class="legend-dot" style="background:${cal.color}"></span>
      <span>${escapeHtml(truncateLabel(cal.label))}</span>
    </div>`
    )
    .join("");

  legend.querySelectorAll(".legend-item").forEach((item) => {
    item.addEventListener("click", () => {
      const visible = getVisibleCalendarIds();
      const id = item.dataset.legendId;
      if (visible.has(id)) visible.delete(id);
      else visible.add(id);
      setVisibleCalendarIds(visible);
      renderMonth(latestEvents);
    });
  });
}

// ---------------------------------------------------------------------
// Day detail overlay — shown when a day has more events than fit inline
// ---------------------------------------------------------------------

function showDayDetail(day, dateIso, dayEvents) {
  el("day-detail-heading").textContent = day.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  const isAllDay = (ev) => !ev.start.dateTime;

  el("day-detail-list").innerHTML = dayEvents
    .map((ev) => {
      const isStartDay = isSameLocalDay(parseEventBounds(ev).start, day);
      const showTime = !isAllDay(ev) && isStartDay;
      const cal = calendarList.find((c) => c.id === ev._calendarId);
      const editable = ev.id && cal && cal.canWrite;

      const timeLabel = showTime ? formatTime(ev.start.dateTime) : isAllDay(ev) ? "All day" : "";
      const metaParts = [timeLabel, cal ? cal.label : null].filter(Boolean);

      return `
      <div class="day-detail-row ${editable ? "editable" : ""}" ${
        editable ? `data-event-id="${escapeHtml(ev.id)}"` : ""
      }>
        <span class="detail-dot" style="background:${ev._color}"></span>
        <div class="detail-text">
          <div class="detail-title">${escapeHtml(ev.summary || "(no title)")}</div>
          <div class="detail-meta">${escapeHtml(metaParts.join(" · "))}</div>
        </div>
        ${editable ? `<span class="edit-hint">✎</span>` : ""}
      </div>`;
    })
    .join("");

  el("day-detail-list").querySelectorAll(".day-detail-row.editable").forEach((row) => {
    row.addEventListener("click", () => {
      const ev = latestEvents.find((e) => e.id === row.dataset.eventId);
      if (ev) openEditEvent(ev);
    });
  });

  el("day-detail-overlay").dataset.date = dateIso;
  openOverlay("day-detail-overlay");
}

el("close-day-detail-btn").addEventListener("click", () => {
  closeOverlay("day-detail-overlay");
});

el("day-detail-add-btn").addEventListener("click", () => {
  const dateIso = el("day-detail-overlay").dataset.date;
  resetToAddMode();
  el("ev-date").value = dateIso;
  swapOverlay("day-detail-overlay", "add-event-overlay");
});

function formatTime(dateTimeStr) {
  return new Date(dateTimeStr).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

// parseEventBounds, isSameLocalDay and eventOverlapsDay live in
// calendar-dates.js (loaded before this file) along with the reasoning
// about UTC-midnight parsing — see the comment at the top of that file.

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function setSyncStatus(msg) {
  el("sync-status").textContent = msg;
}

// ---------------------------------------------------------------------
// Add / edit event form — shared between both modes
// ---------------------------------------------------------------------

// Set while editing an existing event; null means the form is in "add
// new event" mode. { id, calendarId }
let editingEvent = null;

el("add-event-btn").addEventListener("click", () => {
  resetToAddMode();
  // toIsoDate, not toISOString — see calendar-dates.js. In the evening the
  // UTC-based version prefilled tomorrow's date.
  el("ev-date").value = toIsoDate(new Date());
  openOverlay("add-event-overlay");
});

el("cancel-add-btn").addEventListener("click", closeAddEvent);

function resetToAddMode() {
  editingEvent = null;
  el("add-event-heading").textContent = "Add event";
  el("save-event-btn").textContent = "Add to calendar";
  el("delete-event-btn").classList.add("hidden");
  el("ev-calendar").disabled = false;
  refreshWriteControls();
}

function closeAddEvent() {
  closeOverlay("add-event-overlay");
  el("add-event-form").reset();
  el("add-event-status").textContent = "";
  resetToAddMode();
}

function openEditEvent(ev) {
  const cal = calendarList.find((c) => c.id === ev._calendarId);
  if (!cal || !cal.canWrite) return; // shouldn't happen — row wasn't clickable otherwise, but don't trust the DOM

  editingEvent = { id: ev.id, calendarId: ev._calendarId };

  el("add-event-heading").textContent = "Edit event";
  el("save-event-btn").textContent = "Save changes";
  el("delete-event-btn").classList.remove("hidden");

  refreshWriteControls();
  el("ev-calendar").value = ev._calendarId;
  el("ev-calendar").disabled = true; // moving an event to a different calendar isn't supported yet

  el("ev-title").value = ev.summary || "";

  const isAllDay = !ev.start.dateTime;
  el("ev-allday").checked = isAllDay;
  el("ev-start").disabled = isAllDay;
  el("ev-end").disabled = isAllDay;

  if (isAllDay) {
    el("ev-date").value = ev.start.date;
  } else {
    const start = new Date(ev.start.dateTime);
    const end = new Date(ev.end.dateTime);
    const pad = (n) => String(n).padStart(2, "0");
    el("ev-date").value = toIsoDate(start);
    el("ev-start").value = `${pad(start.getHours())}:${pad(start.getMinutes())}`;
    el("ev-end").value = `${pad(end.getHours())}:${pad(end.getMinutes())}`;
  }

  swapOverlay("day-detail-overlay", "add-event-overlay");
}

el("ev-allday").addEventListener("change", (e) => {
  const disabled = e.target.checked;
  el("ev-start").disabled = disabled;
  el("ev-end").disabled = disabled;
});

// Builds the Google Calendar event body (summary/start/end) from the
// current form fields — shared by both the add and edit submit paths.
function buildEventBodyFromForm() {
  const title = el("ev-title").value.trim();
  const date = el("ev-date").value;
  const allDay = el("ev-allday").checked;

  if (!title || !date) return null;

  const body = { summary: title };

  if (allDay) {
    // Google's all-day end.date is exclusive, so a one-day event ends the
    // next day. Built locally and read back locally — the previous version
    // round-tripped this through UTC, which worked only by coincidence.
    body.start = { date };
    body.end = { date: allDayEndDate(date) };
  } else {
    const start = el("ev-start").value;
    const end = el("ev-end").value;
    if (!start || !end) return { error: "Please set a start and end time, or check All day." };
    body.start = { dateTime: `${date}T${start}:00`, timeZone: TIMEZONE };
    body.end = { dateTime: `${date}T${end}:00`, timeZone: TIMEZONE };
  }

  return body;
}

// Refreshes accounts from Flask and returns the access token for the
// account that owns/can-write the given calendar, or null if that
// account needs to sign in again.
async function getWritableToken(calendarId) {
  const result = await getAccounts();
  if (result.accounts.length === 0) return null;
  applyAccounts(result);
  const targetCal = calendarList.find((c) => c.id === calendarId);
  return targetCal ? tokenByEmail[targetCal._accountEmail] || null : null;
}

el("add-event-form").addEventListener("submit", async (e) => {
  e.preventDefault();

  const statusEl = el("add-event-status");
  const calendarId = editingEvent ? editingEvent.calendarId : el("ev-calendar").value;

  // The buttons into this form are disabled when nothing is writeable, but
  // the form has other ways in (an existing event's row). Don't send an empty
  // calendar id to Google and report whatever comes back.
  if (!calendarId) {
    statusEl.textContent = "No calendar is available to add this event to.";
    return;
  }

  const body = buildEventBodyFromForm();
  if (!body) return;
  if (body.error) {
    statusEl.textContent = body.error;
    return;
  }

  statusEl.style.color = "";
  statusEl.textContent = editingEvent ? "Saving…" : "Adding…";

  const token = await getWritableToken(calendarId);
  if (!token) {
    statusEl.textContent = "That calendar's account needs to sign in again.";
    return;
  }

  const isEdit = !!editingEvent;
  const url = isEdit
    ? `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(editingEvent.id)}`
    : `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;

  try {
    const res = await fetch(url, {
      method: isEdit ? "PATCH" : "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error?.message || `Request failed: ${res.status}`);
    }

    closeAddEvent();
    loadMonth(); // refresh immediately so the change shows up right away
  } catch (err) {
    console.error(err);
    statusEl.textContent = `Couldn't ${isEdit ? "save" : "add"} event: ${err.message}`;
  }
});

el("delete-event-btn").addEventListener("click", async () => {
  if (!editingEvent) return;
  const title = el("ev-title").value || "this event";
  if (!confirm(`Delete "${title}"? This can't be undone from the board.`)) return;

  const statusEl = el("add-event-status");
  statusEl.style.color = "";
  statusEl.textContent = "Deleting…";

  const token = await getWritableToken(editingEvent.calendarId);
  if (!token) {
    statusEl.textContent = "That calendar's account needs to sign in again.";
    return;
  }

  try {
    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(editingEvent.calendarId)}/events/${encodeURIComponent(editingEvent.id)}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      }
    );

    // Google returns 204 No Content on success, and 410 Gone if it was
    // already deleted elsewhere (e.g. from a phone) — treat both as success.
    if (!res.ok && res.status !== 410) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error?.message || `Request failed: ${res.status}`);
    }

    closeAddEvent();
    loadMonth();
  } catch (err) {
    console.error(err);
    statusEl.textContent = `Couldn't delete event: ${err.message}`;
  }
});

// ---------------------------------------------------------------------
// Overlays: opening, closing, dismissing, and focus
//
// Every overlay used to be closable only by finding its button. On a
// touch TV the thing people actually try is tapping the dimmed area
// outside the card, so that works now; Escape works too, for anyone with
// a keyboard attached.
//
// The add-event form is the deliberate exception. Closing it throws away
// whatever has been typed, so a stray tap outside an untouched form
// dismisses it, but an entry in progress needs an explicit Cancel — the
// board should not quietly lose an event to a mistimed tap.
//
// All opening and closing goes through openOverlay/closeOverlay, which is
// what makes the focus handling possible: a panel that is visually modal
// but leaves Tab walking around the grid behind it is only half a dialog.
// ---------------------------------------------------------------------

const OVERLAY_IDS = [
  "day-detail-overlay",
  "theme-overlay",
  "calendars-overlay",
  "add-event-overlay",
];

// Which panels are open, in the order they were opened, and what had focus
// before the first one did. Only used for focus — the DOM stays the source
// of truth for what is actually visible (see topmostVisibleOverlayId).
const overlayStack = [];
let focusBeforeOverlays = null;

function overlayCard(id) {
  return el(id).querySelector(".overlay-card");
}

function openOverlay(id) {
  const node = el(id);
  node.classList.remove("hidden");
  overlayStack.push(id);

  // Captured only when the *first* panel opens, so closing a chain of them
  // (day detail → add event) returns focus to the thing that started it
  // rather than to a panel that has since been hidden.
  if (overlayStack.length === 1) focusBeforeOverlays = document.activeElement;

  // Focus the card rather than the first field: predictable, and it can't
  // pop a keyboard up on a touch panel. tabindex is set here instead of in
  // the markup because the card is not otherwise focusable.
  const card = overlayCard(id);
  card.tabIndex = -1;
  card.focus();
}

function closeOverlay(id) {
  el(id).classList.add("hidden");
  const at = overlayStack.lastIndexOf(id);
  if (at !== -1) overlayStack.splice(at, 1);

  if (overlayStack.length === 0 && focusBeforeOverlays) {
    const target = focusBeforeOverlays;
    focusBeforeOverlays = null;
    // The opener may have been re-rendered away (a day cell after a month
    // change, say). Focus falling to the body is fine; throwing is not.
    if (document.contains(target) && typeof target.focus === "function") target.focus();
  }
}

// Hand over from one panel to another without focus falling back to the
// page in between — the day-detail panel closes as the add-event form
// opens, and the stack should survive that as one move, not two.
function swapOverlay(fromId, toId) {
  el(fromId).classList.add("hidden");
  const at = overlayStack.lastIndexOf(fromId);
  if (at !== -1) overlayStack.splice(at, 1);
  openOverlay(toId);
}

function isAddEventFormDirty() {
  // Editing an existing event always requires a deliberate exit: there are
  // loaded values to lose, and Cancel or Save are the honest ways out. A
  // new event only counts as started once a title has been typed — it is
  // a required field, so below that there is nothing worth keeping.
  if (editingEvent) return true;
  const title = el("ev-title");
  return Boolean(title && title.value.trim());
}

function canDismissOverlay(id) {
  if (id === "add-event-overlay") return !isAddEventFormDirty();
  return true;
}

// Closing the add-event form means something different from hiding a
// panel: the form has to be reset as well, or the next open starts from a
// half-filled event.
function dismissOverlay(id) {
  if (id === "add-event-overlay") closeAddEvent();
  else closeOverlay(id);
}

function topmostVisibleOverlayId() {
  // Derived from the DOM rather than the stack, deliberately: this answers
  // "what would the user see?", and stays right even if a panel was hidden
  // by something that bypassed closeOverlay.
  for (let i = OVERLAY_IDS.length - 1; i >= 0; i -= 1) {
    const id = OVERLAY_IDS[i];
    if (!el(id).classList.contains("hidden")) return id;
  }
  return null;
}

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(", ");

function focusableWithin(root) {
  return [...root.querySelectorAll(FOCUSABLE_SELECTOR)].filter(
    (node) => node.offsetWidth > 0 || node.offsetHeight > 0
  );
}

for (const id of OVERLAY_IDS) {
  const node = el(id);
  if (!node) continue;

  // Whether this press began on the dimmed backdrop rather than inside the
  // card. Tracking the press as well as the click means a drag that starts
  // on a selected line of text and finishes outside does not dismiss the
  // panel — a text selection in the calendar list was otherwise closing it.
  let pressedBackdrop = false;
  node.addEventListener("pointerdown", (e) => {
    pressedBackdrop = e.target === node;
  });
  node.addEventListener("click", (e) => {
    if (e.target === node && pressedBackdrop && canDismissOverlay(id)) dismissOverlay(id);
    pressedBackdrop = false;
  });
}

document.addEventListener("keydown", (e) => {
  const open = topmostVisibleOverlayId();

  if (e.key === "Escape") {
    // Overlays are modal: normally only the visible one can be open.
    if (open && canDismissOverlay(open)) dismissOverlay(open);
    return;
  }

  if (e.key !== "Tab" || !open) return;

  // Keep Tab inside the open panel. Handled here rather than on the panel
  // itself because once focus has escaped to the page, keydown no longer
  // reaches a listener bound to the panel — which is exactly the case this
  // is meant to prevent.
  const card = overlayCard(open);
  const stops = focusableWithin(card);
  if (stops.length === 0) {
    e.preventDefault();
    card.focus();
    return;
  }

  const first = stops[0];
  const last = stops[stops.length - 1];
  const active = document.activeElement;

  if (!card.contains(active)) {
    e.preventDefault();
    (e.shiftKey ? last : first).focus();
  } else if (e.shiftKey && active === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && active === last) {
    e.preventDefault();
    first.focus();
  }
});
