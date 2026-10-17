// ---- EDIT THIS THING ----
//
// Google OAuth settings (CLIENT_ID, CLIENT_SECRET) now live in
// server_config.py instead of here — Flask handles sign-in, not the
// browser, so nothing secret needs to be in a file the browser can see.

const CONFIG = {
  // How often to re-pull events from Google so new entries from phones
  // show up on the TV without a manual reload, in minutes.
  EVENT_POLL_MINUTES: 3,
};
