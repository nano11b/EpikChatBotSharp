const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { loadConfig } = require("../lib/config");
const { MemoryStore } = require("../lib/memory-store");
const { RateLimiter } = require("../lib/rate-limiter");
const { createBot } = require("../main");

function createSocket() {
  const handlers = new Map();
  const sent = [];
  const socket = {
    handlers,
    sent,
    closed: false,
    on(event, handler) {
      handlers.set(event, handler);
      return this;
    },
    timeout() {
      return this;
    },
    emit(event, payload, callback) {
      if (event === "whoami") callback(null, { id: "bot-id" });
      else if (event === "getBotAccess") callback(null, {
        rooms: [{ roomId: "room-a", canJoin: true }, { roomId: "room-b", canJoin: true }],
      });
      else if (event === "joinRoom" && payload.roomId === "room-b") callback(new Error("join failed"));
      else if (event === "joinRoom") callback(null, { ok: true });
      else if (event === "userMessage") {
        sent.push(payload);
        callback(null, { ok: true });
      }
    },
    close() {
      this.closed = true;
    },
  };
  return socket;
}

function makeConfig(directory, overrides = {}) {
  fs.writeFileSync(path.join(directory, "trivia.json"), JSON.stringify([
    { question: "Largest planet?", answer: "jupiter", acceptedAnswers: ["the planet jupiter"] },
  ]));
  return {
    ...loadConfig({
      BOT_TOKEN: "test-token",
      MARBLES_ENABLED: "false",
      TRIVIA_ADMIN_CONTROLS: "false",
      COMMAND_COOLDOWN_MS: "0",
      TRIVIA_GUESS_COOLDOWN_MS: "500",
      PERSIST_DEBOUNCE_MS: "0",
      MEMORY_FILE: path.join(directory, "memory.json"),
      TRIVIA_FILE: path.join(directory, "trivia.json"),
      TRIVIA_SCORE_FILE: path.join(directory, "scores.json"),
      MARBLES_FILE: path.join(directory, "marbles.csv"),
    }, directory),
    ...overrides,
  };
}

const quietLogger = { log() {}, warn() {}, error() {} };

test("cooldown blocks trivia mutation before an attempt is consumed", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "epikchat-bot-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let now = 1000;
  const socket = createSocket();
  const bot = createBot({
    config: makeConfig(directory),
    socket,
    openai: null,
    logger: quietLogger,
    rateLimiter: new RateLimiter(() => now),
  });

  await bot.handleConnect();
  assert.deepEqual([...bot.joinedRoomIds], ["room-a"], "a failed room join must not discard successful joins");

  await bot.handleMessage({ targetId: "room-a", senderId: "admin", senderName: "Admin", content: "^trivia start" });
  const state = bot.trivia.getState("room-a");
  assert.equal(state.active, true);

  await bot.handleMessage({ targetId: "room-a", senderId: "user-1", senderName: "Alice", content: "^answer mars" });
  assert.equal(state.attempts.get("user-1"), 1);
  const messageCount = socket.sent.length;

  await bot.handleMessage({ targetId: "room-a", senderId: "user-1", senderName: "Alice", content: "^answer saturn" });
  assert.equal(state.attempts.get("user-1"), 1, "a rate-limited guess must not consume an attempt");
  assert.equal(socket.sent.length, messageCount);

  now += 500;
  await bot.handleMessage({ targetId: "room-a", senderId: "user-1", senderName: "Alice", content: "^answer jupter" });
  assert.match(socket.sent.at(-2).content, /^Correct, Alice!/);
  assert.match(socket.sent.at(-1).content, /^Trivia time!/);

  await bot.shutdown("test");
  assert.equal(socket.closed, true);
  assert.equal(fs.existsSync(path.join(directory, "scores.json")), true, "shutdown must flush pending scores");
});

test("memory follows a stable sender ID when the display name changes", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "epikchat-memory-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const bot = createBot({ config: makeConfig(directory), socket: createSocket(), openai: null, logger: quietLogger });

  bot.memory.rememberMessage("room-a", "user-1", "Alice", "my favorite snack is tuna");
  assert.match(bot.memory.getContext("room-a", "user-1", "Alicia").join(" "), /favorite snack is tuna/);
  const keys = [...bot.memory.users.keys()];
  assert.deepEqual(keys, ["room:room-a:id:user-1"]);
  assert.equal(bot.memory.users.get("room:room-a:id:user-1").name, "Alicia");
  await bot.shutdown("test");

  const reloaded = new MemoryStore({ filePath: path.join(directory, "memory.json"), debounceMs: 0 });
  assert.match(reloaded.getContext("room-a", "user-1", "Ally").join(" "), /favorite snack is tuna/);
  assert.equal(reloaded.users.get("room:room-a:id:user-1").name, "Ally");
  await reloaded.flush();
});

test("an acknowledgement failure leaves the bot unready", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "epikchat-ack-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const socket = createSocket();
  socket.emit = (_event, _payload, callback) => callback(new Error("timeout"));
  const errors = [];
  const logger = { log() {}, warn() {}, error(...args) { errors.push(args.join(" ")); } };
  const bot = createBot({ config: makeConfig(directory), socket, openai: null, logger });

  await bot.handleConnect();
  assert.equal(bot.isReady(), false);
  assert.equal(errors.some((entry) => entry.includes("connect error")), true);
  await bot.shutdown("test");
});

test("long AI responses are paged with a per-user continue command", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "epikchat-continue-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const socket = createSocket();
  const longReply = Array.from({ length: 100 }, (_, index) => `detail${index}`).join(" ");
  const openai = { responses: { create: async () => ({ output_text: longReply }) } };
  const bot = createBot({ config: makeConfig(directory), socket, openai, logger: quietLogger, loadPlugins: false });

  await bot.handleConnect();
  await bot.handleMessage({ targetId: "room-a", senderId: "user-1", senderName: "Alice", content: "^ask explain this" });
  assert.ok(socket.sent[0].content.length <= 250);
  assert.match(socket.sent[0].content, /\^continue/);

  await bot.handleMessage({ targetId: "room-a", senderId: "user-2", senderName: "Bob", content: "^continue" });
  assert.match(socket.sent[1].content, /no AI response/i);
  await bot.handleMessage({ targetId: "room-a", senderId: "user-1", senderName: "Alice", content: "^continue" });
  assert.ok(socket.sent[2].content.length <= 250);
  assert.notEqual(socket.sent[2].content, socket.sent[0].content);

  await bot.shutdown("test");
});

test("ping measures an acknowledged EpikChat socket round trip", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "epikchat-ping-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const socket = createSocket();
  const originalEmit = socket.emit.bind(socket);
  let whoamiCalls = 0;
  socket.emit = function emit(event, payload, callback) {
    if (event === "whoami") whoamiCalls += 1;
    return originalEmit(event, payload, callback);
  };
  const bot = createBot({ config: makeConfig(directory), socket, openai: null, logger: quietLogger, loadPlugins: false });

  await bot.handleConnect();
  await bot.handleMessage({ targetId: "room-a", senderId: "user-1", senderName: "Alice", content: "^ping" });

  assert.equal(whoamiCalls, 2, "one whoami call joins the bot and a second performs the ping");
  assert.match(socket.sent.at(-1).content, /^EpikChat pong: \d+\.\dms\.$/);
  await bot.shutdown("test");
});

test("Battlefield command saves an EA ID and retrieves compact stats", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "epikchat-bfstats-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const socket = createSocket();
  const requested = [];
  const battlefield = {
    validateEaId(value) { if (!value) throw new Error("missing"); return value; },
    async stats(eaId) { requested.push(eaId); return { text: `${eaId} | K/D 1.25` }; },
    formatStats(data) { return data.text; },
  };
  const bot = createBot({ config: makeConfig(directory, { battlefieldCooldownMs: 0 }), socket, openai: null, battlefield, logger: quietLogger, loadPlugins: false });

  await bot.handleConnect();
  await bot.handleMessage({ targetId: "room-a", senderId: "user-1", senderName: "Alice", content: "^bf set AliceEA" });
  await bot.handleMessage({ targetId: "room-a", senderId: "user-1", senderName: "Alice", content: "^bf" });
  assert.deepEqual(requested, ["AliceEA"]);
  assert.equal(socket.sent.at(-1).content, "AliceEA | K/D 1.25");
  await bot.shutdown("test");
});

test("community progress commands and dashboard status share loyalty data", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "epikchat-progress-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const socket = createSocket();
  const bot = createBot({ config: makeConfig(directory), socket, openai: null, logger: quietLogger, loadPlugins: false });

  await bot.handleConnect();
  await bot.handleMessage({ targetId: "room-a", senderId: "user-1", senderName: "Alice", content: "^daily" });
  await bot.handleMessage({ targetId: "room-a", senderId: "user-1", senderName: "Alice", content: "^progress" });
  assert.match(socket.sent.at(-1).content, /Alice: level 1 Newcomer/);
  await bot.handleMessage({ targetId: "room-a", senderId: "user-1", senderName: "Alice", content: "^quests" });
  assert.match(socket.sent.at(-1).content, /Claim the daily bonus/);

  const status = bot.getStatus("room-a");
  assert.deepEqual(status.community.leaderboard[0], { name: "Alice", points: 15, level: 1, title: "Newcomer" });
  await bot.shutdown("test");
});
