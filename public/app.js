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
let currentMonthDate = new Date(); // which month is currently displayed
let calendarList = []; // merged + deduped across all signed-in accounts

const el = (id) => document.getElementById(id);

// ---------------------------------------------------------------------
// Calendar visibility (persisted locally per device)
// ---------------------------------------------------------------------

const VISIBILITY_KEY = "familyBoard.visibleCalendars";

function getVisibleCalendarIds() {
  const stored = localStorage.getItem(VISIBILITY_KEY);
  if (stored === null) {
    // Default: everything visible.
    return new Set(calendarList.map((c) => c.id));
  }
  try {
    return new Set(JSON.parse(stored));
  } catch {
    return new Set(calendarList.map((c) => c.id));
  }
}

function setVisibleCalendarIds(idSet) {
  localStorage.setItem(VISIBILITY_KEY, JSON.stringify([...idSet]));
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
      populateCalendarSelect();
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
      renderCalendarsPicker(); // discard, no changes
    }
  });
  input.addEventListener("blur", commit);
}

function findCalendarRow(calId) {
  return document.querySelector(`.calendar-row[data-cal-row="${CSS.escape(calId)}"]`);
}

function populateCalendarSelect() {
  const writable = calendarList.filter((c) => c.canWrite);
  el("ev-calendar").innerHTML = writable
    .map((cal) => `<option value="${escapeHtml(cal.id)}">${escapeHtml(cal.label)}</option>`)
    .join("");
}

el("calendars-btn").addEventListener("click", () => {
  renderCalendarsPicker();
  renderAccountsList();
  el("calendars-overlay").classList.remove("hidden");
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
        await fetch(`/api/logout?email=${encodeURIComponent(email)}`, { method: "POST" });
      } catch (err) {
        console.error("Sign-out failed:", err);
        return;
      }
      // Rebuild everything from the remaining accounts.
      const result = await getAccounts();
      if (result.accounts.length === 0) {
        el("calendars-overlay").classList.add("hidden");
        showSignInRequired("Signed out.");
        return;
      }
      applyAccounts(result);
      calendarList = await fetchCalendarLists();
      populateCalendarSelect();
      renderCalendarsPicker();
      renderAccountsList();
      loadMonth();
    });
  });
}

el("close-calendars-btn").addEventListener("click", () => {
  el("calendars-overlay").classList.add("hidden");
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
  el("theme-overlay").classList.remove("hidden");
});

el("close-theme-btn").addEventListener("click", () => {
  el("theme-overlay").classList.add("hidden");
});

// ---------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------

window.addEventListener("load", init);

async function init() {
  renderDayNamesHeader();

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
    const res = await fetch("/api/tokens");
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

  populateCalendarSelect();
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
  showSigninScreen();
  showSigninError(message);
}

function schedulePolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(loadMonth, CONFIG.EVENT_POLL_MINUTES * 60 * 1000);
}

// ---------------------------------------------------------------------
// Fetching + rendering the month
// ---------------------------------------------------------------------

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function renderDayNamesHeader() {
  el("month-daynames").innerHTML = DAY_NAMES.map((n) => `<div>${n}</div>`).join("");
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

async function loadMonth() {
  const monthStart = getMonthStart(currentMonthDate);
  const gridStart = getGridStart(monthStart);
  const gridEnd = getGridEnd(monthStart);

  el("month-range").textContent = monthStart.toLocaleDateString(undefined, { month: "long" });
  el("year-subtitle").textContent = `Family Board · ${monthStart.getFullYear()}`;
  el("month-numeral").textContent = String(monthStart.getMonth() + 1).padStart(2, "0");

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
    const events = await fetchAllCalendars(gridStart, gridEnd);
    latestEvents = events;
    renderMonth(events);

    let status = `Last synced ${new Date().toLocaleTimeString()}`;
    if (staleAccounts.length > 0) {
      status += ` — ${staleAccounts.join(", ")} needs to sign in again (Calendars → Add Google account)`;
    }
    setSyncStatus(status);
  } catch (err) {
    console.error(err);
    if (err.status === 401) {
      showSignInRequired("Session expired — please sign in again.");
    } else {
      setSyncStatus("Sync failed — will retry.");
    }
  }
}

// Fetches every calendar in parallel — each with the token of the account
// it was discovered under — and tags each event with which calendar (and
// color) it came from, so the picker can filter and the chips can be
// color-coded without re-fetching.
async function fetchAllCalendars(timeMin, timeMax) {
  const settled = await Promise.allSettled(
    calendarList.map(async (cal) => {
      const items = await fetchEvents(cal, timeMin, timeMax);
      return items.map((ev) => ({ ...ev, _calendarId: cal.id, _color: cal.color }));
    })
  );

  // A 401 means a token died mid-cycle (rare — Flask refreshes them every
  // sync). Surface it distinctly so the caller can force a re-sign-in
  // instead of quietly rendering an incomplete board.
  const authFailure = settled.find(
    (r) => r.status === "rejected" && r.reason && r.reason.status === 401
  );
  if (authFailure) {
    const err = new Error("Authentication expired");
    err.status = 401;
    throw err;
  }

  const all = settled.flatMap((r) => {
    if (r.status === "fulfilled") return r.value;
    console.error("Failed to fetch a calendar:", r.reason); // one bad calendar shouldn't break the whole board
    return [];
  });

  // With multiple accounts, the same event often appears on more than one
  // calendar (an invite Jamie sent Edmund lives on both of their
  // calendars, with the same event ID). Keep only the first copy so it
  // doesn't render twice on the board.
  const seen = new Set();
  return all.filter((ev) => {
    if (!ev.id) return true;
    if (seen.has(ev.id)) return false;
    seen.add(ev.id);
    return true;
  });
}

async function fetchEvents(cal, timeMin, timeMax) {
  const url = new URL(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal.id)}/events`
  );
  url.searchParams.set("timeMin", timeMin.toISOString());
  url.searchParams.set("timeMax", timeMax.toISOString());
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("orderBy", "startTime");

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${tokenByEmail[cal._accountEmail]}` },
  });

  if (!res.ok) {
    const err = new Error(`Calendar fetch failed: ${res.status}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  return data.items || [];
}

function renderMonth(events) {
  const monthStart = getMonthStart(currentMonthDate);
  const gridStart = getGridStart(monthStart);
  const gridEnd = getGridEnd(monthStart);
  const numCells = Math.round((gridEnd - gridStart) / MS_PER_DAY);
  const numRows = numCells / 7;

  const grid = el("month-grid");
  grid.innerHTML = "";

  const today = new Date();
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

      const cell = document.createElement("div");
      cell.className = "day-cell";
      if (day.getMonth() !== monthStart.getMonth()) cell.classList.add("outside-month");
      if (day.getTime() === today.getTime()) cell.classList.add("today");

      const isAllDay = (ev) => !ev.start.dateTime;
      const dateIso = toIsoDate(day);
      const MAX_TOTAL = 3; // 1 beside the date number + 2 stacked below
      const visibleInline = dayEvents.slice(0, MAX_TOTAL);
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

      const isToday = day.getTime() === today.getTime();

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
}

function toIsoDate(date) {
  return date.toISOString().slice(0, 10);
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
  el("day-detail-overlay").classList.remove("hidden");
}

el("close-day-detail-btn").addEventListener("click", () => {
  el("day-detail-overlay").classList.add("hidden");
});

el("day-detail-add-btn").addEventListener("click", () => {
  const dateIso = el("day-detail-overlay").dataset.date;
  el("day-detail-overlay").classList.add("hidden");
  resetToAddMode();
  el("ev-date").value = dateIso;
  el("add-event-overlay").classList.remove("hidden");
});

function formatTime(dateTimeStr) {
  return new Date(dateTimeStr).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

// Timed events (start.dateTime/end.dateTime) include a real UTC offset, so
// the normal Date constructor resolves them correctly. All-day events
// (start.date/end.date) are bare "YYYY-MM-DD" strings with no time or
// offset — JavaScript's Date constructor treats those as UTC midnight,
// which lands on the *previous* calendar day once read back in any
// negative-UTC-offset timezone (i.e. anywhere in the US). Parsing the
// numbers directly and building local-midnight Dates avoids that.
function parseEventBounds(ev) {
  if (ev.start.dateTime) {
    return { start: new Date(ev.start.dateTime), end: new Date(ev.end.dateTime) };
  }
  const [sy, sm, sd] = ev.start.date.split("-").map(Number);
  const [ey, em, ed] = ev.end.date.split("-").map(Number);
  return {
    start: new Date(sy, sm - 1, sd),
    // Google's all-day end.date is already exclusive (the day after the
    // event actually ends), which is exactly what we want for a range
    // check below.
    end: new Date(ey, em - 1, ed),
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
  el("ev-date").value = new Date().toISOString().slice(0, 10);
  el("add-event-overlay").classList.remove("hidden");
});

el("cancel-add-btn").addEventListener("click", closeAddEvent);

function resetToAddMode() {
  editingEvent = null;
  el("add-event-heading").textContent = "Add event";
  el("save-event-btn").textContent = "Add to calendar";
  el("delete-event-btn").classList.add("hidden");
  el("ev-calendar").disabled = false;
  populateCalendarSelect();
}

function closeAddEvent() {
  el("add-event-overlay").classList.add("hidden");
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

  populateCalendarSelect();
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

  el("day-detail-overlay").classList.add("hidden");
  el("add-event-overlay").classList.remove("hidden");
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
    const end = new Date(date);
    end.setDate(end.getDate() + 1);
    body.start = { date };
    body.end = { date: end.toISOString().slice(0, 10) };
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
