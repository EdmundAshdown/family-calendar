// ---- EDIT THIS THING ----
//
// Google OAuth settings (CLIENT_ID, CLIENT_SECRET) now live in
// server_config.py instead of here — Flask handles sign-in, not the
// browser, so nothing secret needs to be in a file the browser can see.

const CONFIG = {
  // How often to re-pull events from Google so new entries from phones
  // show up on the TV without a manual reload, in minutes.
  EVENT_POLL_MINUTES: 3,

  // Quiet hours: dim the board to near-black and pause the Google poll
  // overnight, when nobody is looking at it. Touching the board during
  // them wakes it for QUIET_WAKE_MINUTES minutes, then it sleeps again.
  // Set enabled:false to keep the screen lit around the clock.
  QUIET_HOURS: {
    enabled: true,
    start: "23:00",
    end: "06:30",
  },
  QUIET_WAKE_MINUTES: 5,
};
