# Startup: Senpi Trading Bot

On startup, follow these steps exactly:

1) Read `USER.md` to get the user's Telegram chat ID.

2) Get the user's display name by fetching their Senpi profile.

   **If this fails with an auth error:** Send a message to the chat ID saying:
   "Your Senpi token has expired. Please provide a fresh token to reconnect."
   Then respond with: NO_REPLY

3) Send a greeting message to the user's Telegram chat ID (e.g. "Hey! I'm online 👋"). Keep it short and natural — vary it so it doesn't feel robotic.

4) Respond with: NO_REPLY
   
