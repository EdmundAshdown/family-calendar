"""
Family Board — server.py  (multi-account)

Serves the dashboard's static files and owns the Google OAuth flow for
MULTIPLE Google accounts. Each account that signs in via /login gets its
own refresh token stored server-side, and the dashboard fetches each
person's calendars with that person's own credentials.

Why multiple accounts matter: Google marks events it auto-creates from
Gmail (hotel stays, flights, reservations) as visible to "Only me" — the
calendar owner — regardless of how the calendar is shared. Fetching a
spouse's calendar through sharing will silently omit those events. The
only way to see them is to fetch as the owner, which means holding a
token for each family member's account.

Run it with:
    python server.py

Then open http://localhost:5000.
"""

import json
import time
from pathlib import Path
from urllib.parse import urlencode

import requests
from flask import Flask, jsonify, redirect, request, send_from_directory

import server_config as cfg

BASE_DIR = Path(__file__).parent
PUBLIC_DIR = BASE_DIR / "public"
TOKEN_FILE = BASE_DIR / "token_store.json"

GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
SCOPES = "https://www.googleapis.com/auth/calendar"

app = Flask(__name__, static_folder=None)


# ---------------------------------------------------------------------
# Token storage — a JSON file mapping account email -> token entry:
#   { "person@gmail.com": {access_token, refresh_token, expires_at}, ... }
#
# The pre-multi-account version of this file was a single bare token
# entry; load_store() detects that and tags it for migration on the next
# /api/tokens call (we need a live network call to learn which email it
# belongs to, so it can't be migrated at load time).
# ---------------------------------------------------------------------

LEGACY_KEY = "__legacy__"


def load_store():
    if not TOKEN_FILE.exists():
        return {}
    data = json.loads(TOKEN_FILE.read_text())
    if "access_token" in data:  # old single-account format
        return {LEGACY_KEY: data}
    return data


def save_store(store):
    TOKEN_FILE.write_text(json.dumps(store))


def refresh_access_token(entry):
    """Exchange an entry's refresh_token for a new access_token."""
    resp = requests.post(
        GOOGLE_TOKEN_URL,
        data={
            "client_id": cfg.CLIENT_ID,
            "client_secret": cfg.CLIENT_SECRET,
            "refresh_token": entry["refresh_token"],
            "grant_type": "refresh_token",
        },
    )
    resp.raise_for_status()
    data = resp.json()
    entry["access_token"] = data["access_token"]
    # 60-second safety margin so we never hand out a token that expires
    # mid-request.
    entry["expires_at"] = time.time() + data.get("expires_in", 3600) - 60
    return entry


def identify_account_email(access_token):
    """Which Google account does this token belong to? The calendarList's
    primary calendar has the account's email as its ID — this avoids
    needing an extra userinfo/openid scope just to learn the email."""
    resp = requests.get(
        "https://www.googleapis.com/calendar/v3/users/me/calendarList",
        headers={"Authorization": f"Bearer {access_token}"},
        params={"maxResults": 250},
    )
    resp.raise_for_status()
    for item in resp.json().get("items", []):
        if item.get("primary"):
            return item["id"]
    return None


# ---------------------------------------------------------------------
# Static file serving
# ---------------------------------------------------------------------

@app.route("/")
def index():
    return send_from_directory(PUBLIC_DIR, "index.html")


@app.route("/<path:filename>")
def static_files(filename):
    return send_from_directory(PUBLIC_DIR, filename)


# ---------------------------------------------------------------------
# OAuth
# ---------------------------------------------------------------------

@app.route("/login")
def login():
    params = {
        "client_id": cfg.CLIENT_ID,
        "redirect_uri": cfg.REDIRECT_URI,
        "response_type": "code",
        "scope": SCOPES,
        "access_type": "offline",
        # consent: forces Google to hand back a refresh_token every time.
        # select_account: always show the account chooser, so adding a
        # second family member's account works even when the first is
        # already signed in to the browser.
        "prompt": "consent select_account",
    }
    return redirect(f"{GOOGLE_AUTH_URL}?{urlencode(params)}")


@app.route("/oauth2callback")
def oauth2callback():
    code = request.args.get("code")
    error = request.args.get("error")
    if error:
        return f"Google returned an error: {error}", 400
    if not code:
        return "Missing authorization code", 400

    resp = requests.post(
        GOOGLE_TOKEN_URL,
        data={
            "client_id": cfg.CLIENT_ID,
            "client_secret": cfg.CLIENT_SECRET,
            "code": code,
            "grant_type": "authorization_code",
            "redirect_uri": cfg.REDIRECT_URI,
        },
    )
    resp.raise_for_status()
    data = resp.json()

    entry = {
        "access_token": data["access_token"],
        "refresh_token": data.get("refresh_token"),
        "expires_at": time.time() + data.get("expires_in", 3600) - 60,
    }

    try:
        email = identify_account_email(entry["access_token"])
    except requests.HTTPError:
        email = None
    if not email:
        return "Signed in, but couldn't identify the Google account.", 500

    store = load_store()

    # Google only reliably sends a refresh_token when prompt=consent (which
    # we set), but belt-and-suspenders: never clobber an existing refresh
    # token for this account with nothing.
    if not entry["refresh_token"] and email in store:
        entry["refresh_token"] = store[email].get("refresh_token")

    store[email] = entry
    save_store(store)
    return redirect("/")


@app.route("/api/tokens")
def api_tokens():
    """Returns a currently-valid access token for every signed-in account,
    refreshing server-side as needed. Accounts whose refresh token has
    died (revoked, expired) are reported in `stale` so the dashboard can
    say so instead of silently dropping their events."""
    store = load_store()
    changed = False

    # One-time migration of the old single-account token file: refresh it,
    # ask Google whose it is, and re-file it under that email.
    if LEGACY_KEY in store:
        legacy = store.pop(LEGACY_KEY)
        changed = True
        try:
            legacy = refresh_access_token(legacy)
            email = identify_account_email(legacy["access_token"])
            if email:
                store[email] = legacy
                print(f"Migrated legacy token to account: {email}")
        except requests.HTTPError as err:
            print(f"Legacy token migration failed (sign in again): {err}")

    accounts = []
    stale = []
    for email, entry in list(store.items()):
        if not entry.get("refresh_token"):
            stale.append(email)
            continue
        if entry.get("expires_at", 0) <= time.time():
            try:
                store[email] = refresh_access_token(entry)
                changed = True
            except requests.HTTPError as err:
                print(f"Token refresh failed for {email}: {err}")
                stale.append(email)
                continue
        accounts.append({"email": email, "access_token": store[email]["access_token"]})

    if changed:
        save_store(store)

    if not accounts:
        return jsonify({"error": "not_authenticated", "accounts": [], "stale": stale}), 401
    return jsonify({"accounts": accounts, "stale": stale})


@app.route("/api/logout", methods=["POST"])
def logout():
    """Remove one account (?email=...) or all accounts (no param)."""
    email = request.args.get("email")
    if email:
        store = load_store()
        store.pop(email, None)
        save_store(store)
    elif TOKEN_FILE.exists():
        TOKEN_FILE.unlink()
    return jsonify({"ok": True})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=False)
