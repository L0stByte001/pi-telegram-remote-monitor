# Pi Telegram Remote Monitor v1.3.2

Pi Telegram Remote Monitor connects existing [Pi Coding Agent](https://github.com/badlogic/pi-mono) processes to a private Telegram bot. It provides task status notifications and lets you inspect and send prompts to a Pi process that is already running.

The project has two components:

- **Pi extension** (`telegram-remote-monitor.ts`), loaded by each Pi process.
- **Telegram controller** (`controller.mjs`), a Node.js service running in Docker. It communicates with Pi extensions through an authenticated TCP bridge and with Telegram through the Bot API.

The controller does not start Pi, create agents, or create Pi sessions. It only interacts with Pi processes that have loaded the extension and connected to the bridge.

## Features

- Telegram notifications when a task completes, fails, is interrupted, or requires human intervention.
- Notifications include the local date and time, elapsed duration, agent role, model identifier, and project folder name.
- View connected Pi processes and their current state (`Working`, `Idle`, or `Needs input`).
- Select a connected Pi process from inline Telegram buttons and send it prompts.
- Queue prompts as follow-ups while the selected process is working.
- Inspect the commands registered by a selected Pi process.
- Automatically connect when a Pi session starts, including restored sessions.
- Automatically refresh role and model metadata when a model is selected or changed.
- Manually connect or disconnect a Pi process when needed.
- Restrict bot access to the configured private Telegram chat and matching Telegram user.

The extension does not send agent responses, conversation history, tool calls, tool outputs, session IDs, or full filesystem paths to Telegram.

## Requirements

- Docker Engine with the Docker Compose plugin (Compose v2).
- Node.js 24 or later on the machine running Pi.
- Pi Coding Agent with extension support.
- A Telegram bot created with [@BotFather](https://t.me/BotFather).
- The numeric ID of the private Telegram chat authorized to use the bot.
- A shared bridge secret configured for the controller and the Pi extension.

The controller can run on Windows or Linux. The Pi extension must be installed on the host running Pi and must be able to reach the controller at `127.0.0.1:47831`.

## Configuration and installation

The Docker controller setup is the same on Windows and Linux. Only the Pi extension installation path differs between the two operating systems.

### 1. Create the Telegram bot

1. Open Telegram and start a conversation with [@BotFather](https://t.me/BotFather).
2. Create a bot with `/newbot` and follow the instructions.
3. Copy the bot token and keep it private.
4. Obtain the numeric ID of the private Telegram chat that will be allowed to use the bot.

### 2. Configure the `.env` file

In the project directory, create `.env` from the example file.

**Windows PowerShell:**

```powershell
Copy-Item .env.example .env
notepad .env
```

**Linux:**

```bash
cp .env.example .env
nano .env
```

Set these values in `.env`:

```dotenv
PI_TELEGRAM_BOT_TOKEN=YOUR_TELEGRAM_BOT_TOKEN
PI_TELEGRAM_CHAT_ID=YOUR_NUMERIC_PRIVATE_CHAT_ID
PI_REMOTE_MONITOR_SECRET=YOUR_SHARED_BRIDGE_SECRET
```

Use the same `PI_REMOTE_MONITOR_SECRET` value for the controller and the Pi extension. If you already have a configured secret, keep using that value rather than generating a different one.

The `.env` file is read by Docker Compose and supplies the controller configuration. The Pi extension does **not** read the controller's `.env` file, so configure `PI_REMOTE_MONITOR_SECRET` in the host environment as well. Use exactly the same value in both places. The extension uses port `47831` and host `127.0.0.1` by default.

**Windows PowerShell (run once):**

```powershell
[Environment]::SetEnvironmentVariable("PI_REMOTE_MONITOR_SECRET", "YOUR_SHARED_BRIDGE_SECRET", "User")
```

The extension can read the value from the Windows user environment registry. Close and reopen Pi (and its terminal) after setting it.

**Linux (add to `~/.profile`):**

```bash
echo 'export PI_REMOTE_MONITOR_SECRET="YOUR_SHARED_BRIDGE_SECRET"' >> ~/.profile
. ~/.profile
```

Replace `YOUR_SHARED_BRIDGE_SECRET` with the exact value configured in `.env`. Start Pi from a shell that has loaded `~/.profile`, or log out and back in before starting it.

### 3. Start the Docker controller

Run the following commands from the project directory on either Windows or Linux:

```bash
docker compose up -d --build
docker compose ps
docker compose logs -f
```

The first command builds and starts the controller. The second checks the container status, and the third follows its logs (press `Ctrl+C` to stop following logs; the container keeps running).

The controller is published on `127.0.0.1:47831`. It listens on `0.0.0.0:47831` inside the container so Docker can forward traffic, while the host port remains bound to loopback and is not exposed to the LAN.

### 4. Install the Pi extension

Copy `telegram-remote-monitor.ts` into Pi's extensions directory. Create the directory if it does not exist.

**Windows PowerShell:**

```powershell
New-Item -ItemType Directory -Force "$HOME\.pi\agent\extensions"
Copy-Item .\telegram-remote-monitor.ts "$HOME\.pi\agent\extensions\telegram-remote-monitor.ts"
```

**Linux:**

```bash
mkdir -p "$HOME/.pi/agent/extensions"
cp telegram-remote-monitor.ts "$HOME/.pi/agent/extensions/telegram-remote-monitor.ts"
```

Ensure that `PI_REMOTE_MONITOR_SECRET` is available to the Pi process, then restart Pi so it loads the extension.

## Commands

### Telegram bot commands

| Command | Description |
|---|---|
| `/start` | Shows the bot welcome message and usage. |
| `/help` | Shows the available Telegram commands. |
| `/list` | Lists connected Pi processes and their state. |
| Select a process button | Selects the Pi process targeted by subsequent commands. |
| `/status` | Shows the selected process status. |
| `/commands` | Lists commands registered by the selected Pi process. |
| `/prompt` | Sends a prompt to the selected Pi process. If it is working, the prompt is queued as a follow-up. |
| `/cancel` | Cancels pending input for the selected process. |

### Pi commands

| Command | Description |
|---|---|
| `/telegram-connect` | Connects or reconnects the current Pi process and refreshes its registration. |
| `/telegram-disconnect` | Disconnects the current Pi process and disables its automatic reconnection. |
| `/telegram-remote` | Checks the bridge connection. |

## Connection lifecycle

- On `session_start`, the extension reads the active model and attempts to connect to the controller automatically.
- On `model_select`, it refreshes the role and model metadata for the existing process registration.
- When a Pi session is replaced (for example, with `/new`), the extension initializes the connection lifecycle for the new session.
- If the controller is temporarily unavailable, the extension retries the connection with backoff.
- `/telegram-disconnect` disables automatic reconnection for the current Pi process. Run `/telegram-connect` to connect it again.
- The controller keeps connected Pi processes in memory. The list is repopulated as Pi processes reconnect; it is not a persistent session history.

## Privacy and security

Telegram bot chats are not end-to-end encrypted. In hybrid mode, text explicitly submitted through `/prompt` is sent to Telegram before being forwarded to the selected Pi process. Do not send passwords, API keys, private keys, confidential source code, or sensitive personal information through Telegram.

**Information sent to Telegram:**

- Fixed task status, agent role, model identifier, local date and time, elapsed duration, and project folder name.
- Connected process display information and state shown by `/list`.
- Command names and descriptions shown by `/commands`.
- Fixed acknowledgements. The bot does not echo prompt text in its replies.

**Information not sent to Telegram:**

- Agent responses or conversation history.
- Tool names, arguments, or outputs.
- Pi session IDs or full filesystem paths.
- Prompts generated internally by the agent.

**Security controls:**

- The Docker host port is bound to `127.0.0.1` only.
- The controller authenticates Pi bridge connections using `PI_REMOTE_MONITOR_SECRET`.
- Telegram updates are accepted only from the configured private chat and matching user ID.
- The container runs as the unprivileged `node` user, with a read-only root filesystem, dropped Linux capabilities, and `no-new-privileges` enabled.
- Keep the `.env` file private and never commit it to source control.

## Changelog

### 1.3.2

- Reinitialize automatic bridge connection after `/new` and other session replacements.
- Reload bridge settings on `model_select` before attempting to reconnect.
- Keep manual disconnect scoped to the current session.

### 1.3.1

- Connect automatically when a Pi session starts.
- Initialize model metadata from the active session and refresh it on `model_select`.
- Preserve `/telegram-connect` and `/telegram-disconnect` manual controls.
