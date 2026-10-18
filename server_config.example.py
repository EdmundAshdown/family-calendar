"""Copy this to server_config.py and fill it in — see README steps 2 and 3:

    cp server_config.example.py server_config.py

server_config.py is listed in .gitignore and must never be committed: it is
the only file in this project that holds a real secret.
"""

# ---- Required ------------------------------------------------------------

# Google Cloud Console -> Google Auth Platform -> Clients -> your web client.
CLIENT_ID = "PASTE-YOUR-CLIENT-ID.apps.googleusercontent.com"
CLIENT_SECRET = "PASTE-YOUR-CLIENT-SECRET"

# Must appear in that same client's list of Authorized redirect URIs.
REDIRECT_URI = "http://localhost:5000/oauth2callback"


# ---- Optional ------------------------------------------------------------
# The defaults below are the safe ones for the usual setup: one kiosk, on
# the machine that is running this server.

# HOST defaults to "127.0.0.1" — loopback only.
#
# Set it to "0.0.0.0" ONLY if a second display on the network needs to reach
# this server, and understand what that opens up: /api/tokens takes no
# credentials and returns a live Google access token for every signed-in
# account, so anyone on the same wifi will be able to read every family
# member's calendar.
# HOST = "127.0.0.1"

# PORT defaults to 5000, which must match REDIRECT_URI above and the URL
# start-kiosk.bat opens.
# PORT = 5000
