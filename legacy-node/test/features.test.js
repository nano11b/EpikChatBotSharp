const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { CommandRegistry } = require("../lib/command-registry");
const { loadConfig } = require("../lib/config");
const { DashboardServer } = require("../lib/dashboard-server");
const { LoyaltyService } = require("../lib/loyalty-service");
const { MemoryStore } = require("../lib/memory-store");
const { ModerationService } = require("../lib/moderation-service");
const { PollService } = require("../lib/poll-service");
const { SchedulerService } = require("../lib/scheduler-service");
const { SettingsStore } = require("../lib/settings-store");
const { TriviaService } = require("../lib/trivia");

test("command registry resolves aliases and enforces permissions", async () => {
  const registry = new CommandRegistry();
  registry.register({ name: "secret", aliases: ["s"], permission: "admin", handler: () => ({ reply: "ok" }) });
  assert.match((await registry.execute({ command: "s", isAdmin: false })).reply, /admin-only/);
  assert.equal((await registry.execute({ command: "s", isAdmin: true })).reply, "ok");
});

test("room settings persist and commands can be disabled", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "epikchat-settings-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "settings.json");
  const settings = new SettingsStore({ filePath, debounceMs: 0 });
  settings.set("room", "ai.enabled", "false");
  settings.set("room", "ai.respondToAll", "true");
  settings.set("room", "bot.persona", "a scholarly owl");
  settings.set("room", "commands.poll", "false");
  settings.set("room", "features.polls", "false");
  await settings.flush();
  const reloaded = new SettingsStore({ filePath, debounceMs: 0 });
  assert.equal(reloaded.get("room").ai.enabled, false);
  assert.equal(reloaded.get("room").ai.respondToAll, true);
  assert.equal(reloaded.get("room").bot.persona, "a scholarly owl");
  assert.equal(reloaded.isCommandEnabled("room", "poll"), false);
  assert.equal(reloaded.isFeatureEnabled("room", "polls"), false);
});

test("memory opt-out and forget are scoped to a room", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "epikchat-privacy-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const memory = new MemoryStore({ filePath: path.join(directory, "memory.json"), debounceMs: 0 });
  memory.setEnabled("a", "user", "Alice", false);
  memory.rememberMessage("a", "user", "Alice", "secret");
  memory.rememberMessage("b", "user", "Alice", "public");
  assert.equal(memory.show("a", "user", "Alice"), null);
  assert.match(memory.getContext("b", "user", "Alice").join(" "), /public/);
  memory.forget("b", "user", "Alice");
  assert.equal(memory.show("b", "user", "Alice"), null);
  await memory.flush();
});

test("polls support vote changes and loyalty supports daily quests and levels", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "epikchat-engagement-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const messages = [];
  const polls = new PollService({ sendMessage: async (_room, message) => messages.push(message) });
  const poll = polls.create("room", "Pick one", ["Cats", "Dogs"], 60000);
  assert.equal(polls.vote("room", "user", "1").option.label, "Cats");
  assert.equal(polls.vote("room", "user", "Dogs").option.label, "Dogs");
  assert.equal(poll.options[0].votes.size, 0);
  await polls.close("room");
  assert.match(messages[0], /Poll closed/);

  const loyalty = new LoyaltyService({ filePath: path.join(directory, "loyalty.json"), debounceMs: 0 });
  assert.equal(loyalty.daily("room", "user", "Alice").ok, true);
  assert.equal(loyalty.daily("room", "user", "Alice").ok, false);
  assert.equal(loyalty.get("room", "user", "Alice").points, 15, "the first daily claim includes its quest reward");
  assert.equal(loyalty.get("room", "user", "Alice").achievements.includes("first-point"), true);
  assert.equal(loyalty.quests("room", "user", "Alice").find((quest) => quest.id === "daily-claim").completed, true);
  assert.equal(loyalty.progress("room", "user", "Alice").level, 1);
  const trivia = loyalty.award("room", "user", "Alice", 90, "trivia");
  assert.equal(trivia.completedQuest.id, "trivia-win");
  assert.equal(loyalty.progress("room", "user", "Alice").level, 3);
  await loyalty.flush();
});

test("moderation filters links, blocked words, repeats, and mutes", () => {
  const moderation = new ModerationService({ blockedWords: ["forbidden"], floodLimit: 10, repeatLimit: 2 });
  const base = { roomId: "room", senderId: "user", senderName: "Alice" };
  assert.equal(moderation.check({ ...base, content: "https://example.com", linksAllowed: false }).reason, "link");
  assert.equal(moderation.check({ ...base, content: "forbidden phrase", linksAllowed: true }).reason, "blocked-word");
  assert.equal(moderation.check({ ...base, content: "repeat", linksAllowed: true }).allowed, true);
  assert.equal(moderation.check({ ...base, content: "repeat", linksAllowed: true }).allowed, true);
  assert.equal(moderation.check({ ...base, content: "repeat", linksAllowed: true }).reason, "repeat");
  moderation.mute("room", "user", 10000);
  assert.equal(moderation.check({ ...base, content: "hello", linksAllowed: true }).reason, "muted");
});

test("scheduler persists and executes activities", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "epikchat-scheduler-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const executed = [];
  const scheduler = new SchedulerService({
    filePath: path.join(directory, "schedules.json"),
    debounceMs: 0,
    execute: async (item) => executed.push(item.payload),
  });
  const item = scheduler.add({ roomId: "room", type: "announcement", payload: "hello", runAt: Date.now() + 60000 });
  await scheduler.run(item.id);
  assert.deepEqual(executed, ["hello"]);
  assert.equal(scheduler.list("room").length, 0);
  scheduler.stopAll();
  await scheduler.flush();

  const retrying = new SchedulerService({
    filePath: path.join(directory, "retry-schedules.json"),
    debounceMs: 0,
    execute: async () => { throw new Error("offline"); },
    logger: { error() {} },
  });
  const retryItem = retrying.add({ roomId: "room", type: "announcement", payload: "later", runAt: Date.now() + 60000 });
  await retrying.run(retryItem.id);
  assert.equal(retrying.items.has(retryItem.id), true, "failed activities must be retained for retry");
  retrying.stopAll();
  await retrying.flush();
});

test("enhanced trivia supports categories, choices, rounds, rewards, and question administration", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "epikchat-trivia-features-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const triviaFile = path.join(directory, "trivia.json");
  fs.writeFileSync(triviaFile, JSON.stringify([
    { question: "Red planet?", answer: "Mars", choices: ["Venus", "Mars"], category: "science", difficulty: "easy", hint: "It starts with M" },
    { question: "Capital of France?", answer: "Paris", category: "geography", difficulty: "easy" },
  ]));
  const config = loadConfig({
    BOT_TOKEN: "test",
    TRIVIA_FILE: triviaFile,
    TRIVIA_SCORE_FILE: path.join(directory, "scores.json"),
    TRIVIA_STATS_FILE: path.join(directory, "stats.json"),
    PERSIST_DEBOUNCE_MS: "0",
    TRIVIA_ADMIN_CONTROLS: "false",
  }, directory);
  const sent = [];
  const rewarded = [];
  const trivia = new TriviaService({
    config,
    isAdmin: () => true,
    sendMessage: async (_room, message) => sent.push(message),
    getRoomSettings: () => ({ trivia: { attempts: 3, timeMs: 30000, hintMs: 0, questionCount: 1, speedBonusMs: 0 } }),
    onCorrect: (reward) => rewarded.push(reward),
    random: () => 0.99,
  });
  assert.equal(trivia.start("room", "user", "Alice", "science easy 1").advanceTrivia, true);
  await trivia.advance("room");
  assert.match(sent[0], /A\) Venus/);
  assert.equal(trivia.answer("room", "user", "Alice", "B").advanceTrivia, true);
  await trivia.advance("room");
  assert.match(sent.at(-1), /round complete/i);
  assert.equal(rewarded.length, 1);
  assert.deepEqual(trivia.categories(), ["geography", "science"]);
  const added = await trivia.addQuestion("Ocean planet?|Neptune|science|medium|the blue planet|");
  assert.equal(added.answer, "Neptune");
  assert.equal((await trivia.setQuestionEnabled(3, false)).enabled, false);
  assert.equal((await trivia.removeQuestion(3)).answer, "Neptune");
  assert.match(trivia.formatStats(), /Red planet/);
  trivia.stopAll();
  await trivia.flush();
});

test("dashboard exposes public health but protects administrative APIs", async () => {
  const actions = [];
  const server = new DashboardServer({
    host: "127.0.0.1",
    port: 0,
    token: "secret",
    getStatus: async () => ({ ok: true }),
    setSetting: async (body) => ({ ok: true, body }),
    runAction: async (body) => { actions.push(body); return { ok: true }; },
    logger: { log() {}, error() {} },
  });
  server.start();
  await new Promise((resolve) => server.server.once("listening", resolve));
  const port = server.server.address().port;
  assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 200);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/status`)).status, 401);
  const response = await fetch(`http://127.0.0.1:${port}/api/action`, {
    method: "POST",
    headers: { authorization: "Bearer secret", "content-type": "application/json" },
    body: JSON.stringify({ roomId: "room", action: "trivia-start" }),
  });
  assert.equal(response.status, 200);
  assert.equal(actions.length, 1);
  await server.stop();
});
