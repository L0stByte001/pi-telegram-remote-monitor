# Security Notes

- Never commit `.env`; it contains Telegram credentials and the shared bridge secret.
- Keep Docker's published bridge bound to `127.0.0.1` on the Windows host.
- The controller binds `0.0.0.0` only inside the container network namespace. Do not change the Compose host binding to `0.0.0.0`.
- The bridge secret must match the Windows Pi user secret exactly.
- The Telegram bot token is used only by the controller container.
- Telegram bot chats are not end-to-end encrypted. Prompts submitted through Telegram transit Telegram infrastructure.
- Do not expose the controller TCP port to the LAN or Internet.
- Protect `.env` and any proxy URL containing credentials with appropriate Windows filesystem permissions.
- Docker healthcheck validates only the local TCP listener, not Telegram API reachability.
