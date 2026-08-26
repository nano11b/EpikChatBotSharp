#!/usr/bin/env node
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createBot } = require("../main");
const { loadConfig } = require("../lib/config");

function createSimulationSocket(roomId = "simulation-room") {
  const handlers = new Map();
  const sent = [];
  return {
    handlers,
    sent,
    on(event, handler) { handlers.set(event, handler); return this; },
    timeout() { return this; },
    emit(event, payload, callback) {
      if (event === "whoami") callback(null, { id: "simulation-bot" });
      else if (event === "getBotAccess") callback(null, { rooms: [{ roomId, canJoin: true }] });
      else if (event === "joinRoom") callback(null, { ok: true });
      else if (event === "userMessage") { sent.push(payload); callback(null, { ok: true }); }
    },
    close() {},
  };
}

async function simulate(events, { roomId = "simulation-room", directory = null } = {}) {
  const dataDirectory = directory || fs.mkdtempSync(path.join(os.tmpdir(), "epikchat-simulation-"));
  fs.mkdirSync(dataDirectory, { recursive: true });
  const triviaFile = path.join(dataDirectory, "trivia.json");
  if (!fs.existsSync(triviaFile)) fs.writeFileSync(triviaFile, JSON.stringify([{ question: "Simulation question?", answer: "simulation" }]));
  const config = loadConfig({
    BOT_TOKEN: "simulation",
    MARBLES_ENABLED: "false",
    COMMAND_COOLDOWN_MS: "0",
    TRIVIA_GUESS_COOLDOWN_MS: "0",
    PERSIST_DEBOUNCE_MS: "0",
    TRIVIA_ADMIN_CONTROLS: "false",
    TRIVIA_FILE: triviaFile,
    MEMORY_FILE: path.join(dataDirectory, "memory.json"),
    SETTINGS_FILE: path.join(dataDirectory, "settings.json"),
    LOYALTY_FILE: path.join(dataDirectory, "loyalty.json"),
    SCHEDULES_FILE: path.join(dataDirectory, "schedules.json"),
    TRIVIA_SCORE_FILE: path.join(dataDirectory, "scores.json"),
    TRIVIA_STATS_FILE: path.join(dataDirectory, "stats.json"),
    ROLES_FILE: path.join(dataDirectory, "roles.json"),
    AUDIT_FILE: path.join(dataDirectory, "audit.jsonl"),
    OUTBOX_FILE: path.join(dataDirectory, "outbox.json"),
    SUBMISSIONS_FILE: path.join(dataDirectory, "submissions.json"),
    USER_PREFERENCES_FILE: path.join(dataDirectory, "preferences.json"),
    MARBLES_SEASONS_FILE: path.join(dataDirectory, "seasons.json"),
    PLUGINS_DIRECTORY: path.join(dataDirectory, "plugins"),
  }, dataDirectory);
  const socket = createSimulationSocket(roomId);
  const logger = { log() {}, warn() {}, error() {} };
  const bot = createBot({ config, socket, openai: null, logger, loadPlugins: false });
  await bot.handleConnect();
  for (const [index, event] of events.entries()) {
    await bot.handleMessage({ targetId: roomId, senderId: event.senderId || `user-${index % 10}`, senderName: event.senderName || `User ${index % 10}`, content: event.content });
  }
  const result = { status: bot.getStatus(roomId), sent: [...socket.sent] };
  await bot.shutdown("simulation-complete");
  return result;
}

if (require.main === module) {
  const fixturePath = process.argv[2];
  const events = fixturePath
    ? JSON.parse(fs.readFileSync(path.resolve(fixturePath), "utf8"))
    : [{ senderId: "demo", senderName: "Demo", content: "^help" }, { senderId: "demo", senderName: "Demo", content: "^trivia start" }];
  simulate(events).then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)).catch((error) => { console.error(error); process.exitCode = 1; });
}

module.exports = { createSimulationSocket, simulate };
