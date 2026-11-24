import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createConnection, type Socket } from "node:net";

type AgentOutcome = "completed" | "aborted" | "error";
type NotificationStatus = "completed" | "failed" | "aborted" | "needs_intervention";
type PiCommand = { name: string; description?: string; source: string };
type ControllerMessage =
  | { type: "deliver_prompt"; requestId: string; text: string }
  | { type: "deliver_command"; requestId: string; command: string };

const HEARTBEAT_INTERVAL_MS = 10_000;

/**
 * Pi Telegram Remote Monitor agent bridge.
 * Telegram receives only status metadata and user-submitted remote prompts.
 * Agent responses, tool activity, prompts originating inside Pi, and repository
 * data are never sent to Telegram.
 */
export default function (pi: ExtensionAPI) {
  let agentRole = process.env.PI_AGENT_ROLE?.trim() || "Pi";
  let modelName = "Unknown model";
  const controllerHost = process.env.PI_REMOTE_MONITOR_HOST?.trim() || "127.0.0.1";
  let controllerPort = Number(process.env.PI_REMOTE_MONITOR_PORT || "47831");
  let sharedSecret = process.env.PI_REMOTE_MONITOR_SECRET?.trim();
  let bridgeConfigured = isValidBridgeConfiguration(sharedSecret, controllerPort);
  const processId = randomUUID();

  let socket: Socket | undefined;
  let socketBuffer = "";
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let reconnectDelayMs = 1_000;
  let isWorking = false;
  let waitingForUser = false;
  let shuttingDown = false;
  let manuallyDisconnected = false;
  let lastOutcome: AgentOutcome | undefined;
  let interventionNotificationSent = false;
  let agentStartedAt: number | undefined;
  let currentSessionName = "";
  const projectName = process.cwd().split(/[\\/]/).filter(Boolean).at(-1) || "Unknown project";
  let currentCommands: PiCommand[] = [];

  function isValidBridgeConfiguration(secret: string | undefined, port: number): boolean {
    return Boolean(secret && Number.isInteger(port) && port > 0 && port <= 65535);
  }

  function readWindowsUserEnvironmentVariable(name: string): string | undefined {
    if (process.platform !== "win32") return undefined;
    try {
      const output = execFileSync("reg.exe", ["query", "HKCU\\Environment", "/v", name], {
        encoding: "utf8",
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
      const line = output.split(/\r?\n/).find((item) => item.trimStart().startsWith(name));
      const match = line?.match(new RegExp(`^\\s*${name}\\s+REG_\\w+\\s+(.+)$`, "i"));
      return match?.[1]?.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  function readUserSetting(name: string): string | undefined {
    return process.env[name]?.trim() || readWindowsUserEnvironmentVariable(name);
  }

  function loadBridgeConfiguration(): boolean {
    const configuredSecret = readUserSetting("PI_REMOTE_MONITOR_SECRET");
    const configuredPort = Number(readUserSetting("PI_REMOTE_MONITOR_PORT") || "47831");

    if (!configuredSecret) {
      bridgeConfigured = false;
      return false;
    }

    if (!Number.isInteger(configuredPort) || configuredPort < 1 || configuredPort > 65535) {
      bridgeConfigured = false;
      return false;
    }

    sharedSecret = configuredSecret;
    controllerPort = configuredPort;
    bridgeConfigured = isValidBridgeConfiguration(sharedSecret, controllerPort);
    return bridgeConfigured;
  }

  function updateModelMetadata(model?: { provider?: string; id?: string; name?: string }): void {
    const selectedProvider = model?.provider?.trim();
    const selectedModel = model?.id?.trim() || model?.name?.trim();

    agentRole = (selectedProvider || process.env.PI_AGENT_ROLE?.trim() || "Pi")
      .replace(/[\r\n\0]/g, " ")
      .slice(0, 80);
    modelName = (selectedModel || "Unknown model")
      .replace(/[\r\n\0]/g, " ")
      .slice(0, 100);
  }

  async function sendStatus(status: NotificationStatus, durationMs = 0): Promise<void> {
    if (!bridgeConfigured || !socket || socket.destroyed || socket.connecting) {
      console.warn("[pi-telegram-remote-monitor] Status event not delivered: local controller is disconnected.");
      return;
    }
    sendBridgeMessage({
      type: "status_notification",
      processId,
      agentRole,
      modelName,
      projectName,
      status,
      occurredAt: new Date().toISOString(),
      durationMs: Math.max(0, Math.floor(durationMs)),
    });
  }

  function refreshSessionMetadata(ctx: { sessionManager: { getSessionName(): string | undefined } }): void {
    currentSessionName = pi.getSessionName() || ctx.sessionManager.getSessionName() || "Unnamed session";
    currentCommands = pi.getCommands().map((command) => ({
      name: command.name,
      description: command.description,
      source: command.source,
    }));
  }

  function sendBridgeMessage(message: Record<string, unknown>): void {
    if (!socket || socket.destroyed || socket.connecting || !socket.writable) return;
    socket.write(`${JSON.stringify(message)}\n`);
  }

  function publishState(): void {
    if (!bridgeConfigured) return;
    sendBridgeMessage({
      type: "agent_state",
      processId,
      agentRole,
      modelName,
      projectName,
      sessionName: currentSessionName,
      status: waitingForUser ? "waiting" : isWorking ? "working" : "idle",
      commands: currentCommands,
    });
  }

  function sendAck(requestId: string, accepted: boolean, message: string): void {
    sendBridgeMessage({ type: "command_ack", requestId, accepted, message });
  }

  function dispatchControllerMessage(message: ControllerMessage): void {
    if (message.type === "deliver_prompt") {
      const text = message.text.trim();
      if (!text) {
        sendAck(message.requestId, false, "Il prompt è vuoto.");
        return;
      }
      try {
        if (isWorking) {
          pi.sendUserMessage(text, { deliverAs: "followUp" });
          sendAck(message.requestId, true, "Prompt accodato come follow-up.");
        } else {
          pi.sendUserMessage(text);
          sendAck(message.requestId, true, "Prompt inviato all'agente.");
        }
      } catch {
        sendAck(message.requestId, false, "Pi non ha accettato il prompt.");
      }
      return;
    }

    if (message.type === "deliver_command") {
      if (isWorking) {
        sendAck(message.requestId, false, "I comandi slash sono disponibili solo quando l'agente è Idle. Usa /prompt per accodare un follow-up.");
        return;
      }
      const commandText = message.command.trim();
      const commandName = commandText.replace(/^\//, "").split(/\s+/, 1)[0];
      const isRegistered = currentCommands.some((command) => command.name === commandName);
      if (!isRegistered) {
        sendAck(message.requestId, false, "Comando non presente nel catalogo dell'agente selezionato.");
        return;
      }
      try {
        pi.sendUserMessage(commandText.startsWith("/") ? commandText : `/${commandText}`, { expandPromptTemplates: true });
        sendAck(message.requestId, true, "Comando inviato all'agente.");
      } catch {
        sendAck(message.requestId, false, "Pi non ha accettato il comando.");
      }
    }
  }

  function connectBridge(): void {
    if (!bridgeConfigured || socket || shuttingDown || manuallyDisconnected) return;
    const connection = createConnection({ host: controllerHost, port: controllerPort });
    socket = connection;
    connection.setEncoding("utf8");

    connection.on("connect", () => {
      reconnectDelayMs = 1_000;
      sendBridgeMessage({ type: "auth", secret: sharedSecret, processId });
      publishState();
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = setInterval(publishState, HEARTBEAT_INTERVAL_MS);
    });

    connection.on("data", (chunk: string) => {
      socketBuffer += chunk;
      if (socketBuffer.length > 1_048_576) { connection.destroy(); return; }
      let newlineIndex = socketBuffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = socketBuffer.slice(0, newlineIndex).trim();
        socketBuffer = socketBuffer.slice(newlineIndex + 1);
        if (line) {
          try {
            dispatchControllerMessage(JSON.parse(line) as ControllerMessage);
          } catch {
            console.error("[pi-telegram-remote-monitor] Ignored malformed controller message.");
          }
        }
        newlineIndex = socketBuffer.indexOf("\n");
      }
    });

    connection.on("error", () => {
      // Do not print socket errors: they can contain host-specific details.
    });

    connection.on("close", () => {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
      if (socket === connection) socket = undefined;
      if (!shuttingDown && !manuallyDisconnected) {
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(connectBridge, reconnectDelayMs);
        reconnectDelayMs = Math.min(reconnectDelayMs * 2, 30_000);
      }
    });
  }

  function autoConnectSession(ctx: {
    model?: { provider?: string; id?: string; name?: string };
    sessionManager: { getSessionName(): string | undefined };
  }): void {
    refreshSessionMetadata(ctx);
    updateModelMetadata(ctx.model);

    if (manuallyDisconnected) return;

    // Reload settings on every lifecycle transition. In particular, Windows
    // user-level variables may not be present in the environment inherited by Pi.
    if (!loadBridgeConfiguration()) {
      console.warn("[pi-telegram-remote-monitor] Automatic connection skipped: configure PI_REMOTE_MONITOR_SECRET in the process or Windows user environment.");
      return;
    }

    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
    connectBridge();
    publishState();
  }

  pi.on("session_start", async (_event, ctx) => {
    // Pi replaces the extension runtime for /new and /resume. A new session
    // gets a fresh automatic-connection lifecycle, independent of the old one.
    shuttingDown = false;
    manuallyDisconnected = false;
    autoConnectSession(ctx);
  });

  pi.on("session_info_changed", async (_event, ctx) => {
    refreshSessionMetadata(ctx);
    publishState();
  });

  pi.on("model_select", async (event, ctx) => {
    updateModelMetadata(event.model);
    if (manuallyDisconnected) return;

    // Re-read the Windows user environment as well as the process environment
    // before reconnecting. Do not rely on a stale bridgeConfigured value.
    if (!loadBridgeConfiguration()) return;

    refreshSessionMetadata(ctx);
    connectBridge();
    publishState();
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    isWorking = true;
    waitingForUser = false;
    agentStartedAt ??= Date.now();
    refreshSessionMetadata(ctx);
    publishState();
  });

  pi.on("agent_start", async (_event, ctx) => {
    isWorking = true;
    waitingForUser = false;
    agentStartedAt ??= Date.now();
    lastOutcome = undefined;
    interventionNotificationSent = false;
    refreshSessionMetadata(ctx);
    publishState();
  });

  pi.on("agent_before_settle", async (event) => {
    lastOutcome = event.outcome;
  });

  pi.on("agent_settled", async (event, ctx) => {
    const finishedAt = Date.now();
    const durationMs = agentStartedAt === undefined ? 0 : finishedAt - agentStartedAt;
    const outcome: AgentOutcome = lastOutcome ?? (event.aborted ? "aborted" : "completed");
    if (outcome === "error") await sendStatus("failed", durationMs);
    else if (outcome === "aborted" || event.aborted) await sendStatus("aborted", durationMs);
    else await sendStatus("completed", durationMs);
    agentStartedAt = undefined;
    lastOutcome = undefined;
    isWorking = false;
    waitingForUser = false;
    refreshSessionMetadata(ctx);
    publishState();
  });

  pi.on("ui_prompt_start", async () => {
    waitingForUser = true;
    publishState();
    if (interventionNotificationSent) return;
    interventionNotificationSent = true;
    const durationMs = agentStartedAt === undefined ? 0 : Date.now() - agentStartedAt;
    await sendStatus("needs_intervention", durationMs);
  });

  pi.on("ui_prompt_end", async () => {
    waitingForUser = false;
    publishState();
  });

  pi.on("session_shutdown", async () => {
    shuttingDown = true;
    isWorking = false;
    waitingForUser = false;
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = undefined;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
    socket?.destroy();
    socket = undefined;
  });

  pi.registerCommand("telegram-connect", {
    description: "Connect this Pi session to Telegram Remote Monitor",
    handler: async (_args, ctx) => {
      if (!loadBridgeConfiguration()) {
        if (!readUserSetting("PI_REMOTE_MONITOR_SECRET")) {
          ctx.ui.notify(
            "Remote Monitor secret not found. Set PI_REMOTE_MONITOR_SECRET in your Windows user environment and restart Pi.",
            "error",
          );
        } else {
          ctx.ui.notify("Remote Monitor port is invalid. Expected a TCP port between 1 and 65535.", "error");
        }
        return;
      }

      updateModelMetadata(ctx.model);

      shuttingDown = false;
      manuallyDisconnected = false;
      refreshSessionMetadata(ctx);

      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = undefined;

      if (socket && !socket.destroyed && !socket.connecting) {
        publishState();
        ctx.ui.notify(
          `Telegram registration updated: "${agentRole} (${modelName})" — ${projectName}.`,
          "info",
        );
        return;
      }

      connectBridge();
      ctx.ui.notify(
        `Connecting this session to Telegram as "${agentRole} (${modelName})" — ${projectName} on 127.0.0.1:${controllerPort}...`,
        "info",
      );
    },
  });

  pi.registerCommand("telegram-disconnect", {
    description: "Disconnect this Pi session from Telegram Remote Monitor",
    handler: async (_args, ctx) => {
      manuallyDisconnected = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
      const currentSocket = socket;
      socket = undefined;
      currentSocket?.destroy();
      ctx.ui.notify("This Pi session has been disconnected from Telegram Remote Monitor.", "info");
    },
  });

  pi.registerCommand("telegram-status", {
    description: "Send a fixed Telegram test notification",
    handler: async (_args, ctx) => {
      if (!bridgeConfigured || !socket || socket.destroyed || socket.connecting) {
        ctx.ui.notify("Remote Monitor controller is disconnected.", "warning");
        return;
      }
      await sendStatus("completed", 0);
      ctx.ui.notify("Telegram test notification queued through the local controller.", "info");
    },
  });

  pi.registerCommand("telegram-remote", {
    description: "Show Telegram Remote Monitor bridge status",
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        bridgeConfigured
          ? `Remote Monitor bridge: ${socket && !socket.destroyed ? "connected" : "disconnected"}.`
          : "Remote Monitor bridge is not configured. Set PI_REMOTE_MONITOR_SECRET and start the controller.",
        bridgeConfigured && socket && !socket.destroyed ? "info" : "warning",
      );
    },
  });

  if (!readUserSetting("PI_REMOTE_MONITOR_SECRET")) console.warn("[pi-telegram-remote-monitor] Remote bridge disabled: configure PI_REMOTE_MONITOR_SECRET.");

}
