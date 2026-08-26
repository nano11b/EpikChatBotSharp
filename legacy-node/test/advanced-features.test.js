const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { AccessControl } = require("../lib/access-control");
const { BackupService } = require("../lib/backup-service");
const { BattlefieldCommunityService, meaningfulChanges } = require("../lib/battlefield-community-service");
const { CommandRegistry } = require("../lib/command-registry");
const { DeliveryService } = require("../lib/delivery-service");
const { DashboardAuthService } = require("../lib/dashboard-auth-service");
const { DashboardServer } = require("../lib/dashboard-server");
const { EventService } = require("../lib/event-service");
const { IgnoreService } = require("../lib/ignore-service");
const { MarblesSeasonService } = require("../lib/marbles-season-service");
const { PluginLoader } = require("../lib/plugin-loader");
const { ModerationCaseService } = require("../lib/moderation-case-service");
const { QuestionSubmissionService } = require("../lib/question-submission-service");
const { UserPreferenceService } = require("../lib/user-preference-service");
const { StateDatabase } = require("../lib/state-database");
const { MIGRATIONS } = require("../lib/database-migrations");
const { simulate } = require("../scripts/simulate");

function temporaryDirectory(t, prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("SQLite applies numbered schema migrations exactly once", (t) => {
  const directory = temporaryDirectory(t, "epikchat-migrations-");
  const filePath = path.join(directory, "state.sqlite");
  const first = new StateDatabase({ filePath, logger: { log() {}, error() {} } });
  assert.equal(first.getSchemaVersion(), MIGRATIONS.at(-1).version);
  assert.equal(first.db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get().count, MIGRATIONS.length);
  first.close();

  const reopened = new StateDatabase({ filePath, logger: { log() {}, error() {} } });
  assert.equal(reopened.db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get().count, MIGRATIONS.length);
  reopened.close();
});

test("room roles are hierarchical, persistent, and revocable", async (t) => {
  const directory = temporaryDirectory(t, "epikchat-roles-");
  const filePath = path.join(directory, "roles.json");
  const access = new AccessControl({ filePath, ownerIds: new Set(["root"]), debounceMs: 0 });
  assert.equal(access.roleFor("room", "root", "Root"), "owner");
  access.grant("room", "host-1", "host");
  assert.equal(access.has("room", "host-1", "Host", "host"), true);
  assert.equal(access.has("room", "host-1", "Host", "moderator"), false);
  assert.equal(access.revoke("room", "missing"), false);
  await access.flush();
  const reloaded = new AccessControl({ filePath, debounceMs: 0 });
  assert.equal(reloaded.roleFor("room", "host-1", "Host"), "host");
});

test("durable outbox retains failures and drains them after reconnect", async (t) => {
  const directory = temporaryDirectory(t, "epikchat-outbox-");
  const filePath = path.join(directory, "outbox.json");
  let online = false;
  const delivered = [];
  const delivery = new DeliveryService({ filePath, debounceMs: 0, logger: { error() {} }, deliver: async (item) => {
    if (!online) throw new Error("offline");
    delivered.push(item.id);
  } });
  const queued = await delivery.send({ roomId: "room", message: "hello" });
  assert.equal(queued.queued, true);
  await delivery.flush();
  assert.equal(delivery.status().pending, 1);
  online = true;
  const reloaded = new DeliveryService({ filePath, debounceMs: 0, deliver: async (item) => delivered.push(item.id) });
  await reloaded.drain();
  assert.equal(reloaded.status().pending, 0);
  assert.equal(delivered.length, 1);
  await reloaded.flush();
});

test("encrypted backups verify checksums and restore exact bytes", async (t) => {
  const directory = temporaryDirectory(t, "epikchat-backup-");
  const source = path.join(directory, "settings.json");
  const databaseFile = path.join(directory, "state.sqlite");
  fs.writeFileSync(source, "original");
  fs.writeFileSync(databaseFile, "database-original");
  const backup = new BackupService({ directory: path.join(directory, "backups"), files: { settings: source, database: databaseFile }, deferredFiles: ["database"], encryptionKey: "test secret" });
  const created = await backup.create();
  assert.equal(created.encrypted, true);
  assert.deepEqual(backup.inspect(created.name).files, ["settings", "database"]);
  fs.writeFileSync(source, "changed");
  fs.writeFileSync(databaseFile, "database-changed");
  await backup.restore(created.name);
  assert.equal(fs.readFileSync(source, "utf8"), "original");
  assert.equal(fs.readFileSync(databaseFile, "utf8"), "database-changed");
  assert.equal(fs.readFileSync(`${databaseFile}.restore-pending`, "utf8"), "database-original");
});

test("question submissions detect duplicates and require review", async (t) => {
  const directory = temporaryDirectory(t, "epikchat-submissions-");
  const added = [];
  const service = new QuestionSubmissionService({ filePath: path.join(directory, "submissions.json"), debounceMs: 0, existingQuestions: () => [{ question: "Existing?", answer: "Yes" }] });
  assert.equal(service.submit({ roomId: "room", specification: "Existing?|Yes" }).reason, "duplicate");
  const result = service.submit({ roomId: "room", senderId: "user", senderName: "Alice", specification: "New?|Answer|general|easy" });
  assert.equal(service.pending("room").length, 1);
  await service.approve(result.item.id, "moderator", async (spec) => added.push(spec));
  assert.equal(added.length, 1);
  assert.equal(service.pending("room").length, 0);
  await service.flush();
});

test("Marbles seasons calculate standings and preserve ended history", async (t) => {
  const directory = temporaryDirectory(t, "epikchat-seasons-");
  const seasons = new MarblesSeasonService({ filePath: path.join(directory, "seasons.json"), debounceMs: 0 });
  seasons.start("room", "Summer Cup");
  seasons.record("room", ["Alice", "Bob", "Cara"]);
  seasons.record("room", ["Bob", "Alice"]);
  assert.equal(seasons.leaderboard("room")[0].name, "Alice");
  seasons.end("room");
  assert.equal(seasons.historyFor("room").length, 1);
  await seasons.flush();
});

test("trusted plugins register commands and profiles validate preferences", async (t) => {
  const directory = temporaryDirectory(t, "epikchat-plugins-");
  fs.writeFileSync(path.join(directory, "hello.js"), "module.exports={name:'hello',version:'1.2.0',register(api){api.registerCommand({name:'wave',handler:()=>({reply:'hi'})})}}");
  const registry = new CommandRegistry();
  const loader = new PluginLoader({ directory, registry, logger: { error() {} } });
  assert.equal(loader.loadAll()[0].ok, true);
  assert.equal((await registry.execute({ command: "wave" })).reply, "hi");
  assert.equal(loader.reloadAll()[0].ok, true);
  assert.equal((await registry.execute({ command: "wave" })).reply, "hi");

  const preferences = new UserPreferenceService({ filePath: path.join(directory, "preferences.json"), debounceMs: 0 });
  preferences.set("room", "user", "Alice", "language", "es");
  preferences.set("room", "user", "Alice", "timezone", "America/New_York");
  preferences.set("room", "user", "Alice", "concise", "on");
  assert.equal(preferences.get("room", "user", "Alice").language, "es");
  assert.equal(preferences.format("🎱 Hello • world", { concise: true }), "Hello; world");
  assert.throws(() => preferences.set("room", "user", "Alice", "timezone", "Not/AZone"), /IANA/);
  await preferences.flush();
});

test("offline simulator replays chat events without a live account", async (t) => {
  const directory = temporaryDirectory(t, "epikchat-simulator-");
  const result = await simulate([{ senderId: "user", senderName: "Alice", content: "^help" }], { directory });
  assert.equal(result.status.ok, true);
  assert.match(result.sent[0].content, /Commands/);
});

test("SQLite imports legacy JSON and persists transactional records", (t) => {
  const directory = temporaryDirectory(t, "epikchat-sqlite-");
  const legacy = path.join(directory, "settings.json");
  fs.writeFileSync(legacy, JSON.stringify({ rooms: { one: { enabled: true } } }));
  const database = new StateDatabase({ filePath: path.join(directory, "state.sqlite"), logger: { log() {}, error() {} } });
  assert.equal(database.readDocument(legacy, {}).rooms.one.enabled, true);
  database.transaction(() => { database.set("test", "a", { value: 1 }); database.set("test", "b", { value: 2 }); });
  assert.equal(database.list("test").length, 2);
  database.close();
  assert.equal(fs.existsSync(path.join(directory, "state.sqlite")), true);
});

test("runtime ignores can override defaults and moderation cases support appeals", (t) => {
  const directory = temporaryDirectory(t, "epikchat-community-state-");
  const database = new StateDatabase({ filePath: path.join(directory, "state.sqlite"), logger: { log() {}, error() {} } });
  const ignores = new IgnoreService({ database, defaultUsernames: new Set(["NicknamePending"]) });
  assert.equal(ignores.isIgnored("room", "id", "NicknamePending"), true);
  ignores.remove("room", "name", "NicknamePending", "mod");
  assert.equal(ignores.isIgnored("room", "id", "NicknamePending"), false);
  ignores.add("room", "id", "user-2", "mod");
  assert.equal(ignores.isIgnored("room", "user-2", "Someone"), true);

  const cases = new ModerationCaseService({ database });
  const item = cases.create({ roomId: "room", userId: "user-2", actorId: "mod", reason: "spam" });
  assert.equal(cases.appeal("room", "user-2", "Please review").id, item.id);
  assert.equal(cases.resolve(item.id, "owner", "overturned").status, "overturned");
  database.close();
});

test("community events balance teams and Battlefield watches announce changes", async (t) => {
  const directory = temporaryDirectory(t, "epikchat-events-");
  const database = new StateDatabase({ filePath: path.join(directory, "state.sqlite"), logger: { log() {}, error() {} } });
  const events = new EventService({ database });
  const event = events.create("room", "host", "Friday Rush|2026-08-22 20:00");
  events.join(event.id, "a", "Alice"); events.join(event.id, "b", "Bob"); events.join(event.id, "c", "Cara");
  const ratings = { a: 3, b: 2, c: 1 };
  const teams = await events.balance(event.id, async (player) => ratings[player.id]);
  assert.equal(teams.a.length + teams.b.length, 3);

  const sent = []; let kills = 10;
  const battlefield = { validateEaId: (value) => value, stats: async () => ({ fields: { kills, wins: 1, xp: 1000, kd_ratio: 1, win_rate_percent: 10, hours_played: 1 } }) };
  const community = new BattlefieldCommunityService({ database, battlefield, sendMessage: async (_room, message) => sent.push(message), intervalMs: 60000 });
  const link = community.link("room", "a", "Alice", "AliceEA"); community.verify(link.code, "mod"); community.watch("room", "a", "Alice");
  await community.poll(); kills = 15; await community.poll();
  assert.match(sent[0], /Kills 10→15/);
  assert.deepEqual(meaningfulChanges({ kills: 1 }, { kills: 2 }), ["Kills 1→2"]);
  database.close();
});

test("dashboard named sessions enforce CSRF on administrative actions", async (t) => {
  const directory = temporaryDirectory(t, "epikchat-dashboard-auth-");
  const database = new StateDatabase({ filePath: path.join(directory, "state.sqlite"), logger: { log() {}, error() {} } });
  const auth = new DashboardAuthService({ database, bootstrapUsername: "admin", bootstrapPassword: "a-strong-test-password" });
  let actions = 0;
  const server = new DashboardServer({ host: "127.0.0.1", port: 0, token: "", auth, getStatus: async () => ({ ok: true }), setSetting: async () => ({}), runAction: async () => { actions += 1; return { ok: true }; }, logger: { log() {}, error() {} } });
  server.start(); await new Promise((resolve) => server.server.once("listening", resolve)); const port = server.server.address().port;
  const login = await fetch(`http://127.0.0.1:${port}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "admin", password: "a-strong-test-password" }) });
  assert.equal(login.status, 200); const loginBody = await login.json(); const cookie = login.headers.get("set-cookie").split(";")[0];
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/status`, { headers: { cookie } })).status, 200);
  const body = JSON.stringify({ roomId: "room", action: "trivia-start" });
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/action`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body })).status, 403);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/action`, { method: "POST", headers: { cookie, "content-type": "application/json", "x-csrf-token": loginBody.csrf }, body })).status, 200);
  assert.equal(actions, 1); await server.stop(); database.close();
});
