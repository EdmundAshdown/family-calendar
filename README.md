# Family Board

A view + add-event dashboard for a TV, backed by Google Calendar, with a
small local Flask server handling sign-in so the kiosk stays signed in
indefinitely — no repeated logins.

## Files

- `public/index.html` — page structure
- `public/style.css` — layout and component styling (colors come from `themes.js` at runtime)
- `public/app.js` — event fetching/rendering, add-event form, theme/calendar pickers
- `public/calendar-dates.js` — all the date and month-grid maths, with no DOM access, so it can be unit-tested on its own
- `public/calendar-visibility.js` — which calendars the board shows; also DOM-free and unit-tested
- `public/themes.js` — the 8 built-in color themes, picked from the **Theme** button
- `public/config.js` — display settings (poll interval)
- `server.py` — the Flask server: serves the files above, and owns the Google OAuth flow
- `server_config.py` — **the only file with secrets in it** — Client ID, Client Secret, redirect URI (never commit this)
- `server_config.example.py` — the template for the above; copy it and fill it in
- `tests/` — unit tests for `calendar-dates.js` and `calendar-visibility.js` (`npm test`, no dependencies)
- `requirements.txt` — Python dependencies (`pip install -r requirements.txt`)

## Why there's a server — and why multiple accounts

Browser-only Google sign-in can only ever get a short-lived (~1 hour)
access token, which is what caused repeated sign-in prompts in early
versions. Flask does the real "Authorization Code" OAuth flow, which
gets a long-lived refresh token — sign in once, stay signed in.

The server holds a refresh token for **each family member's Google
account**, not just one. This matters because of a Google privacy rule:
events Gmail auto-creates from confirmation emails (hotel stays,
flights, reservations) are marked visible to "Only me" — the calendar
owner — no matter how the calendar is shared. Fetching a spouse's
calendar through sharing silently omits them. Fetching with the owner's
own credentials is the only way they show up, which is exactly what
commercial calendar frames like Skylight do.

**To add a family member's account:** open **Calendars** on the
dashboard → **+ Add Google account** → pick their account in Google's
chooser and approve. Their account must be on the OAuth test users list
in Google Cloud Console (Google Auth Platform → Audience → Test users),
same as yours.

When the same calendar is visible from multiple signed-in accounts, the
board dedupes it, keeping the copy with the strongest access. Events
that live on more than one person's calendar (invites between family
members) are deduped too, so they only render once.

If someone's sign-in ever expires or gets revoked, the board keeps
working for everyone else and notes in the bottom-right status line
which account needs to sign in again.

## 1. Install Python dependencies

```
cd family-calendar
pip install -r requirements.txt
```

## 2. Get your Client Secret from Google Cloud Console

You already have a Client ID from earlier setup. Now you need its
secret too:

1. Google Cloud Console → **Google Auth Platform** → **Clients**
2. Click your existing web client
3. Copy the **Client Secret** shown there (click "Add secret" if none
   exists yet)
4. Add a new **Authorized redirect URI**: `http://localhost:5000/oauth2callback`
   (this is different from the JavaScript origin you added before —
   redirect URIs are a separate list on the same page)

## 3. Fill in server_config.py

```
cp server_config.example.py server_config.py
```

Then open `server_config.py` and paste in:
- `CLIENT_ID` (same one as before)
- `CLIENT_SECRET` (from step 2)
- `REDIRECT_URI` should already match — leave it as
  `http://localhost:5000/oauth2callback` unless you changed the port

This file is in `.gitignore` — it never gets committed, since it holds
a real secret unlike `config.js`. That is also why the repo ships
`server_config.example.py` instead: the repo itself contains no secrets,
so nothing starts until you make one. If you forget, `python server.py`
says exactly that rather than throwing a traceback.

`server_config.py` takes two optional settings as well, both commented
out because the defaults are the safe ones. `HOST` defaults to
`127.0.0.1`, so the server is reachable **only from this machine** — and
that matters, because `/api/tokens` needs no credentials and hands back a
live Google access token for every signed-in account. Only set `HOST` to
`0.0.0.0` if a second display on your network genuinely needs this server,
and read the comment next to it first.

## 4. Run it

```
python server.py
```

Open **http://localhost:5000** (not `:8000` — that was the old plain
file server; this replaces it). Click "Sign in with Google," go through
the consent screen once, and you're in. Refresh the page a few times to
confirm it doesn't ask again.

A couple of things worth knowing:

- Since the app is still in Testing mode in Google Cloud Console, only
  accounts added as test users can sign in.
- You'll see Google's "unverified app" warning the first time — click
  **Advanced** → **Go to (your app name)**. Expected and fine for
  personal use.
- The `prompt: consent` in the login flow means every fresh `/login`
  re-issues a refresh token, so re-authorizing (e.g. after revoking
  access) always works cleanly.

## 5. Calendars are discovered automatically

Same as before — no calendar IDs to configure. After signing in, the
app asks Google for every calendar the account can see and shows them
all in the **Calendars** picker with their real Google Calendar colors.
Read-only calendars display but won't appear in the add-event dropdown
(tagged "view only" instead).

## 6. Kiosk mode (Windows)

Use the included `start-kiosk.bat` and `stop-kiosk.bat` — don't hand-type
the Chrome command, since a couple of details matter:

- **Chrome needs its own dedicated profile** (`--user-data-dir`). If
  Chrome is already open anywhere on the machine, launching a plain
  `chrome.exe --kiosk` just hands the URL to that *existing* window as a
  new tab and silently ignores `--kiosk` entirely — you'll get a normal
  windowed Chrome with a title bar and the taskbar still visible instead
  of true full-screen kiosk mode. A dedicated profile forces a genuinely
  separate Chrome process that actually honors the flag, and as a bonus
  it also becomes a stable home for the dashboard's saved theme and
  calendar selections, isolated from your regular browsing profile.
- **The server runs in its own titled console window** ("Family Board
  Server") rather than fully hidden, so you can actually see it and stop
  or restart it — closing that window, or clicking into it and pressing
  Ctrl+C, stops Flask cleanly.

**To start:** edit `CHROME_PATH` near the top of `start-kiosk.bat` if
Chrome isn't in the default install location, then double-click it (or
run `.\start-kiosk.bat` from a terminal). It'll print what it's doing as
it goes.

**To stop/restart:** run `stop-kiosk.bat`. It closes the server window
and only the kiosk-profile Chrome window — any other Chrome windows
you have open for regular use are left alone.

For auto-launch on boot, drop a shortcut to `start-kiosk.bat` in
`shell:startup`, or wire it into a separate Windows kiosk account
(Settings → Accounts → Family & other users → Set up a kiosk).

Once everything's solid and you're ready for this to run as a true
invisible background service (no visible server console at all), swap
the launch line in `start-kiosk.bat` for the `pythonw` version noted in
a comment at the bottom of that file — at that point, stopping it means
using `stop-kiosk.bat` or Task Manager instead of closing a window.

## Notes on the auth flow

- The one-time `/login` click is the *only* time anyone should need to
  interact with sign-in. After that, Flask renews the access token
  server-side, transparently, whenever the dashboard asks for one.
- If Google access is ever revoked (e.g. from your Google Account's
  "Third-party access" security settings), `/api/tokens` starts
  returning 401, the dashboard falls back to the sign-in screen, and a
  single click on `/login` fixes it — same recovery path as before, it
  should just be needed far less often now.
- New events added from anyone's phone (or from the dashboard itself)
  show up within `EVENT_POLL_MINUTES` (set in `config.js`, default 3
  min) without needing a manual refresh.

## Themes

Click **Theme** in the header to pick from 8 built-in color themes —
Ledger (warm paper), Dusk (indigo night), Chalkboard, Chambray, Sage
kitchen, Harbor, Berry frost, and Newspaper. The choice is saved
per-device (`localStorage`), same as calendar visibility.

Want to tweak one, or add your own? Open `public/themes.js` — each
theme is just a set of hex values.

## Tests

```
npm test
```

Runs the unit tests for `public/calendar-dates.js` (the date and month-grid
maths) and `public/calendar-visibility.js` (which calendars the board
shows), using Node's built-in test runner, so there is nothing to install
and no build step. Node 18 or newer.

Both files are deliberately free of DOM and network access so they can be
tested directly. Neither split is an aesthetic choice — each one is where a
real bug lived:

- `calendar-dates.js`: the date formatter used `toISOString()`, which
  converts to UTC first, so an event at 9pm opened in the edit form dated
  *tomorrow* and saving it moved the event a day.
- `calendar-visibility.js`: the picker stored the *visible* calendar list,
  so the first time anyone ticked a box, a calendar added later was
  invisible with nothing on screen to explain it.

## Known rough edges

- Recurring events can be edited, but only the single instance you
  clicked — the board doesn't offer "this and following" or "all
  events".
- Every sync re-downloads the whole visible month for every calendar on
  every signed-in account. Fine for a couple of phones, but it is the
  first thing to look at if a Pi ever feels warm.
- `token_store.json` (created automatically after your first sign-in)
  holds a real refresh token per family member in plain text on disk. It
  is written `chmod 0600`, and it is the only copy — back it up if you'd
  rather not re-consent every account, and don't copy it anywhere you
  wouldn't put a password.
