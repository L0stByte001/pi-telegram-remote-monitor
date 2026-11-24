import net from "node:net";
import { timingSafeEqual } from "node:crypto";

const TELEGRAM_API = "https://api.telegram.org";
const token = process.env.PI_TELEGRAM_BOT_TOKEN?.trim();
const allowedChatId = process.env.PI_TELEGRAM_CHAT_ID?.trim();
const sharedSecret = process.env.PI_REMOTE_MONITOR_SECRET?.trim();
const host = process.env.PI_REMOTE_MONITOR_BIND_HOST?.trim() || "127.0.0.1";
const port = Number(process.env.PI_REMOTE_MONITOR_PORT || "47831");

if (!token || !allowedChatId || !sharedSecret) {
  console.error("Missing PI_TELEGRAM_BOT_TOKEN, PI_TELEGRAM_CHAT_ID, or PI_REMOTE_MONITOR_SECRET.");
  process.exit(1);
}
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error("PI_REMOTE_MONITOR_PORT must be a valid TCP port.");
  process.exit(1);
}

const agents = new Map();
const selectedByChat = new Map();
const awaitingInput = new Map();
const pendingAcks = new Map();
let updateOffset = 0;
let nextRequestId = 1;
let polling = false;

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

function writeJson(socket, payload) {
  if (!socket.destroyed && socket.writable) socket.write(`${JSON.stringify(payload)}\n`);
}

async function telegram(method, payload = {}, timeoutMs = 10_000) {
  const response = await fetch(`${TELEGRAM_API}/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const result = await response.json().catch(() => undefined);
  if (!response.ok || !result?.ok) {
    throw new Error(`Telegram API ${method} failed (HTTP ${response.status}).`);
  }
  return result.result;
}

async function sendMessage(chatId, text, extra = {}) {
  try {
    return await telegram("sendMessage", { chat_id: chatId, text, disable_web_page_preview: true, ...extra });
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Telegram sendMessage failed.");
    return undefined;
  }
}

function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return new Intl.DateTimeFormat("it-IT", { dateStyle: "short", timeStyle: "medium" }).format(new Date());
  return new Intl.DateTimeFormat("it-IT", {
    day: "2-digit", month: "2-digit", year: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).format(date);
}

function formatDuration(durationMs) {
  const totalSeconds = Math.max(0, Math.floor(Number(durationMs || 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

async function sendStatusNotification(agentRole, modelName, projectName, status, occurredAt, durationMs) {
  const outcomes = {
    completed: { icon: "✅", label: "Task completato" },
    failed: { icon: "❌", label: "Task terminato con errore" },
    aborted: { icon: "⛔", label: "Task interrotto" },
    needs_intervention: { icon: "⚠️", label: "Richiesto intervento" },
  };
  const outcome = outcomes[status];
  if (!outcome) return;

  const safeRole = String(agentRole || "Pi").replace(/[\r\n\0]/g, " ").slice(0, 80);
  const safeModel = String(modelName || "Unknown model").replace(/[\r\n\0]/g, " ").slice(0, 100);
  const safeProject = String(projectName || "Cartella sconosciuta").replace(/[\r\n\0]/g, " ").slice(0, 100);
  const divider = "━━━━━━━━━━━━━━━━━━━━";
  const message = [
    `${outcome.icon} ${formatDateTime(occurredAt)} ⏱ ${formatDuration(durationMs)}`,
    divider,
    `🤖 ${safeRole} (${safeModel})`,
    `📁 ${safeProject}`,
    divider,
    outcome.label,
  ].join("\n");
  await sendMessage(allowedChatId, message);
}

function escapeHtml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function getSelected(chatId) {
  const id = selectedByChat.get(String(chatId));
  const agent = id ? agents.get(id) : undefined;
  if (!agent) selectedByChat.delete(String(chatId));
  return agent;
}

function onlineAgents() {
  return [...agents.values()].sort((a, b) => (a.agentRole || "").localeCompare(b.agentRole || "") || (a.modelName || "").localeCompare(b.modelName || "") || a.sessionName.localeCompare(b.sessionName));
}

function agentLabel(agent) {
  return `${agent.agentRole || "Pi"} (${agent.modelName || "Unknown model"}) — ${agent.projectName || "Unknown project"}`;
}

async function showList(chatId) {
  const list = onlineAgents();
  if (list.length === 0) {
    await sendMessage(chatId, "Nessuna sessione Pi collegata. Avvia il controller e almeno un processo Pi con l'estensione Remote Monitor.");
    return;
  }
  const rows = list.map((agent) => [{
    text: `${agent.status === "working" ? "🟢 Working" : agent.status === "waiting" ? "🟠 Needs input" : "⚪ Idle"} · ${agentLabel(agent)}`.slice(0, 64),
    callback_data: `select:${agent.processId}`,
  }]);
  await sendMessage(chatId, `Sessioni Pi collegate: ${list.length}\nSeleziona la sessione da controllare.`, {
    reply_markup: { inline_keyboard: rows },
  });
}

async function updateCommandMenu(chatId, agent) {
  const reserved = [
    { command: "list", description: "Elenca le sessioni Pi collegate" },
    { command: "commands", description: "Comandi disponibili per la sessione selezionata" },
    { command: "prompt", description: "Invia un prompt alla sessione selezionata" },
    { command: "status", description: "Mostra lo stato della sessione selezionata" },
    { command: "cancel", description: "Annulla l'inserimento corrente" },
  ];
  const names = new Set(reserved.map((item) => item.command));
  const dynamic = (agent?.commands ?? [])
    .filter((item) => /^[a-z0-9_]{1,32}$/.test(item.name) && !names.has(item.name))
    .slice(0, Math.max(0, 100 - reserved.length))
    .map((item) => ({ command: item.name, description: (item.description || item.source || "Comando Pi").slice(0, 256) }));
  try {
    await telegram("setMyCommands", {
      commands: [...reserved, ...dynamic],
      scope: { type: "chat", chat_id: chatId },
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Telegram setMyCommands failed.");
  }
}

async function showCommands(chatId, agent) {
  if (!agent) {
    await sendMessage(chatId, "Prima seleziona una sessione con /list.");
    return;
  }
  const commands = agent.commands ?? [];
  if (commands.length === 0) {
    await sendMessage(chatId, `Nessun comando Pi disponibile per ${agentLabel(agent)}.`);
    return;
  }
  const buttons = commands.filter((command) => Buffer.byteLength(command.name, "utf8") <= 58).slice(0, 80).map((command) => ({
    text: `/${command.name}`.slice(0, 60),
    callback_data: `run:${command.name}`,
  }));
  const keyboard = [];
  for (let index = 0; index < buttons.length; index += 2) keyboard.push(buttons.slice(index, index + 2));
  await sendMessage(chatId, `Comandi di ${agentLabel(agent)}\nSeleziona un comando per eseguirlo senza argomenti. Per aggiungere argomenti, invia manualmente /nome-comando argomenti.`, {
    reply_markup: { inline_keyboard: keyboard },
  });
}

function sendToAgent(agent, message) {
  if (!agent || agent.socket.destroyed) return false;
  writeJson(agent.socket, message);
  return true;
}

async function deliverPrompt(chatId, text) {
  const agent = getSelected(chatId);
  if (!agent) {
    await sendMessage(chatId, "Nessuna sessione selezionata. Usa /list.");
    return;
  }
  const requestId = `tg-${nextRequestId++}`;
  pendingAcks.set(requestId, { chatId: String(chatId), kind: "prompt" });
  if (!sendToAgent(agent, { type: "deliver_prompt", requestId, text })) {
    pendingAcks.delete(requestId);
    await sendMessage(chatId, "La sessione selezionata non è più raggiungibile. Usa /list.");
    return;
  }
  setTimeout(() => {
    const pending = pendingAcks.get(requestId);
    if (pending) {
      pendingAcks.delete(requestId);
      void sendMessage(chatId, "Nessuna conferma dall'agente. Verifica che Pi sia ancora attivo.");
    }
  }, 8_000).unref?.();
}

async function deliverCommand(chatId, commandText) {
  const agent = getSelected(chatId);
  if (!agent) {
    await sendMessage(chatId, "Nessuna sessione selezionata. Usa /list.");
    return;
  }
  const commandName = commandText.replace(/^\//, "").split(/\s+/, 1)[0];
  if (!(agent.commands ?? []).some((item) => item.name === commandName)) {
    await sendMessage(chatId, "Comando non disponibile nella sessione selezionata. Usa /commands per aggiornare l'elenco.");
    return;
  }
  const requestId = `tg-${nextRequestId++}`;
  pendingAcks.set(requestId, { chatId: String(chatId), kind: "command" });
  if (!sendToAgent(agent, { type: "deliver_command", requestId, command: commandText })) {
    pendingAcks.delete(requestId);
    await sendMessage(chatId, "La sessione selezionata non è più raggiungibile. Usa /list.");
    return;
  }
  setTimeout(() => {
    const pending = pendingAcks.get(requestId);
    if (pending) {
      pendingAcks.delete(requestId);
      void sendMessage(chatId, "Nessuna conferma dall'agente. Verifica che Pi sia ancora attivo.");
    }
  }, 8_000).unref?.();
}

async function askForInput(chatId, mode) {
  const agent = getSelected(chatId);
  if (!agent) {
    await sendMessage(chatId, "Prima seleziona una sessione con /list.");
    return;
  }
  const prompt = mode === "prompt"
    ? `Scrivi il prompt da inviare a ${agentLabel(agent)}. Se l'agente è Working, verrà accodato come follow-up.`
    : `Scrivi gli argomenti per /${mode} su ${agentLabel(agent)}. Rispondi a questo messaggio.`;
  const sent = await sendMessage(chatId, prompt, { reply_markup: { force_reply: true, selective: true } });
  if (sent?.message_id) awaitingInput.set(String(chatId), { messageId: sent.message_id, mode });
}

async function handleMessage(message) {
  const chatId = String(message.chat?.id ?? "");
  if (!chatId || chatId !== allowedChatId || message.chat?.type !== "private" || String(message.from?.id ?? "") !== allowedChatId) return;
  const text = typeof message.text === "string" ? message.text.trim() : "";
  if (!text) return;

  const pending = awaitingInput.get(chatId);
  if (pending && message.reply_to_message?.message_id === pending.messageId) {
    awaitingInput.delete(chatId);
    if (pending.mode === "prompt") await deliverPrompt(chatId, text);
    else await deliverCommand(chatId, `/${pending.mode}${text ? ` ${text}` : ""}`);
    return;
  }

  const commandMatch = text.match(/^\/([a-zA-Z0-9_:.-]+)(?:@[a-zA-Z0-9_]+)?(?:\s+([\s\S]*))?$/);
  if (commandMatch) {
    const command = commandMatch[1].toLowerCase();
    const args = commandMatch[2] ?? "";
    if (command === "start" || command === "help") {
      await sendMessage(chatId, "Pi Telegram Remote Monitor\n/list — sessioni Pi collegate\n/commands — comandi della sessione selezionata\n/prompt — invia un prompt (follow-up se Working)\n/status — stato della sessione selezionata\n/cancel — annulla l'inserimento in corso\n\nI prompt inviati transitano tramite Telegram. Le risposte dell'agente e i contenuti dei tool non vengono inoltrati.");
      return;
    }
    if (command === "list") { await showList(chatId); return; }
    if (command === "commands") { await showCommands(chatId, getSelected(chatId)); return; }
    if (command === "prompt") { await askForInput(chatId, "prompt"); return; }
    if (command === "status") {
      const agent = getSelected(chatId);
      await sendMessage(chatId, agent ? `${agentLabel(agent)}\nStato: ${agent.status === "working" ? "Working" : agent.status === "waiting" ? "Needs input" : "Idle"}` : "Nessuna sessione selezionata. Usa /list.");
      return;
    }
    if (command === "cancel") {
      awaitingInput.delete(chatId);
      await sendMessage(chatId, "Inserimento annullato.");
      return;
    }
    await deliverCommand(chatId, `/${commandMatch[1]}${args ? ` ${args}` : ""}`);
    return;
  }

  if (pending) {
    await sendMessage(chatId, "Per sicurezza rispondi al messaggio di richiesta input oppure usa /cancel.");
  }
}

async function handleCallback(callback) {
  const chatId = String(callback.message?.chat?.id ?? "");
  const callbackId = callback.id;
  if (!chatId || chatId !== allowedChatId || String(callback.from?.id ?? "") !== allowedChatId || callback.message?.chat?.type !== "private") {
    await telegram("answerCallbackQuery", { callback_query_id: callbackId, text: "Non autorizzato." }).catch(() => undefined);
    return;
  }
  const data = String(callback.data ?? "");
  if (data.startsWith("select:")) {
    const id = data.slice("select:".length);
    const agent = agents.get(id);
    if (!agent) {
      await telegram("answerCallbackQuery", { callback_query_id: callbackId, text: "Sessione non più disponibile." }).catch(() => undefined);
      await showList(chatId);
      return;
    }
    selectedByChat.set(chatId, id);
    await updateCommandMenu(chatId, agent);
    await telegram("answerCallbackQuery", { callback_query_id: callbackId, text: "Sessione selezionata." }).catch(() => undefined);
    await sendMessage(chatId, `Sessione selezionata: ${agentLabel(agent)}\nStato: ${agent.status === "working" ? "Working" : agent.status === "waiting" ? "Needs input" : "Idle"}\nUsa /prompt per inviare un prompt o /commands per i comandi.`);
    return;
  }
  if (data.startsWith("run:")) {
    const name = data.slice("run:".length);
    const agent = getSelected(chatId);
    if (!agent || !(agent.commands ?? []).some((item) => item.name === name)) {
      await telegram("answerCallbackQuery", { callback_query_id: callbackId, text: "Comando non più disponibile." }).catch(() => undefined);
      return;
    }
    await telegram("answerCallbackQuery", { callback_query_id: callbackId, text: `Invio /${name}` }).catch(() => undefined);
    await deliverCommand(chatId, `/${name}`);
  }
}

const server = net.createServer((socket) => {
  socket.setEncoding("utf8");
  let buffer = "";
  let authenticated = false;
  let processId = "";

  socket.on("data", (chunk) => {
    buffer += chunk;
    if (buffer.length > 1_048_576) { socket.destroy(); return; }
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (!line) continue;
      let payload;
      try { payload = JSON.parse(line); } catch { socket.destroy(); return; }

      if (!authenticated) {
        if (payload.type !== "auth" || !safeEqual(payload.secret, sharedSecret) || typeof payload.processId !== "string") {
          socket.destroy();
          return;
        }
        authenticated = true;
        processId = payload.processId;
        continue;
      }

      if (payload.type === "status_notification" && payload.processId === processId) {
        const agent = agents.get(processId);
        void sendStatusNotification(
          agent?.agentRole || payload.agentRole || "Pi",
          agent?.modelName || payload.modelName || "Unknown model",
          agent?.projectName || payload.projectName || "Cartella sconosciuta",
          payload.status,
          payload.occurredAt,
          payload.durationMs,
        );
      } else if (payload.type === "agent_state" && payload.processId === processId) {
        const previous = agents.get(processId);
        agents.set(processId, {
          processId,
          agentRole: String(payload.agentRole || previous?.agentRole || "Pi").replace(/[\r\n\0]/g, " ").slice(0, 80),
          modelName: String(payload.modelName || previous?.modelName || "Unknown model").replace(/[\r\n\0]/g, " ").slice(0, 100),
          projectName: String(payload.projectName || previous?.projectName || "Unknown project").replace(/[\r\n\0]/g, " ").slice(0, 100),
          sessionName: String(payload.sessionName || "Unnamed session").replace(/[\r\n\0]/g, " ").slice(0, 120),
          status: payload.status === "working" ? "working" : payload.status === "waiting" ? "waiting" : "idle",
          commands: Array.isArray(payload.commands) ? payload.commands
            .filter((item) => item && typeof item.name === "string" && /^[a-zA-Z0-9_:.-]{1,64}$/.test(item.name))
            .slice(0, 100)
            .map((item) => ({ name: item.name, description: String(item.description || "").replace(/\s+/g, " ").trim().slice(0, 256), source: String(item.source || "") })) : [],
          socket,
          lastSeen: Date.now(),
        });
      } else if (payload.type === "command_ack" && typeof payload.requestId === "string") {
        const pending = pendingAcks.get(payload.requestId);
        if (pending) {
          pendingAcks.delete(payload.requestId);
          void sendMessage(pending.chatId, String(payload.message || (payload.accepted ? "Richiesta accettata." : "Richiesta rifiutata.")));
        }
      }
    }
  });

  socket.on("close", () => {
    if (processId && agents.get(processId)?.socket === socket) agents.delete(processId);
    let selectionRemoved = false;
    for (const [chatId, selectedId] of selectedByChat) {
      if (selectedId === processId) { selectedByChat.delete(chatId); selectionRemoved = true; }
    }
    if (selectionRemoved) void updateCommandMenu(allowedChatId, undefined);
  });
  socket.on("error", () => undefined);
});

server.listen(port, host, () => {
  console.log(`Pi Telegram Remote Monitor listening on ${host}:${port}`);
});

async function pollTelegram() {
  if (polling) return;
  polling = true;
  try {
    const updates = await telegram("getUpdates", {
      offset: updateOffset,
      timeout: 25,
      allowed_updates: ["message", "callback_query"],
    }, 35_000);
    const batch = updates ?? [];
    for (const update of batch) {
      updateOffset = Math.max(updateOffset, Number(update.update_id) + 1);
      if (update.message) await handleMessage(update.message);
      if (update.callback_query) await handleCallback(update.callback_query);
    }
    if (batch.length === 0) await new Promise((resolve) => setTimeout(resolve, 500));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Telegram polling failed.");
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  } finally {
    polling = false;
  }
}

await updateCommandMenu(allowedChatId, undefined);
try {
  const pendingUpdates = await telegram("getUpdates", {
    offset: -1,
    timeout: 0,
    allowed_updates: ["message", "callback_query"],
  }, 10_000);
  if (pendingUpdates?.length) updateOffset = Number(pendingUpdates.at(-1).update_id) + 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : "Could not initialize Telegram update offset.");
}
console.log("Telegram Remote Monitor controller started. Only the configured private chat and user are authorized.");
while (true) await pollTelegram();
