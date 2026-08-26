require("dotenv").config();

const { io } = require("socket.io-client");
const msgpackParser = require("socket.io-msgpack-parser");
const OpenAI = require("openai");
const { AccessControl } = require("./lib/access-control");
const { AuditService } = require("./lib/audit-service");
const { BackupService } = require("./lib/backup-service");
const { BattlefieldCommunityService } = require("./lib/battlefield-community-service");
const { createBattlefieldCommandHandlers } = require("./lib/battlefield-command-handlers");
const { BattlefieldStatsService } = require("./lib/battlefield-stats-service");
const { parseCommand } = require("./lib/command-parser");
const { CommandRegistry } = require("./lib/command-registry");
const { loadConfig } = require("./lib/config");
const { ContinuationService, splitMessage } = require("./lib/continuation-service");
const { DashboardServer } = require("./lib/dashboard-server");
const { DashboardAuthService } = require("./lib/dashboard-auth-service");
const { DeliveryService } = require("./lib/delivery-service");
const { LoyaltyService } = require("./lib/loyalty-service");
const { IgnoreService } = require("./lib/ignore-service");
const { translate } = require("./lib/localizer");
const { MarblesSeasonService } = require("./lib/marbles-season-service");
const { MemoryStore } = require("./lib/memory-store");
const { ModerationService } = require("./lib/moderation-service");
const { ModerationCaseService } = require("./lib/moderation-case-service");
const { PluginLoader } = require("./lib/plugin-loader");
const { PollService } = require("./lib/poll-service");
const { QuestionSubmissionService } = require("./lib/question-submission-service");
const { RateLimiter } = require("./lib/rate-limiter");
const { ReplyService } = require("./lib/reply-service");
const { RetentionService } = require("./lib/retention-service");
const { EventService } = require("./lib/event-service");
const { MetricsService } = require("./lib/metrics-service");
const { OperationalMonitor } = require("./lib/operational-monitor");
const { SchedulerService } = require("./lib/scheduler-service");
const { SettingsStore } = require("./lib/settings-store");
const { StateDatabase } = require("./lib/state-database");
const { StructuredLogger } = require("./lib/structured-logger");
const { TriviaService } = require("./lib/trivia");
const { UserPreferenceService } = require("./lib/user-preference-service");
const { MarblesBridge } = require("./marbles");

function createBot(options = {}) {
  const config = options.config || loadConfig(options.env || process.env);
  const logger = options.logger || new StructuredLogger({
    filePath: config.logFile,
    maxBytes: config.logMaxBytes,
    consoleOutput: config.logConsole,
  });
  if (!config.botToken) throw new Error("BOT_TOKEN is required. Copy .env.example to .env and configure it.");
  StateDatabase.applyPendingRestore(config.databaseFile, logger);
  const database = options.database || new StateDatabase({ filePath: config.databaseFile, logger });

  const socket = options.socket || (options.ioFactory || io)(config.serverUrl, {
    path: "/chat/",
    addTrailingSlash: false,
    transports: ["websocket"],
    parser: msgpackParser,
    extraHeaders: { Authorization: `Bot ${config.botToken}`, "User-Agent": "Meowington/2.0" },
  });
  const openai = options.openai !== undefined
    ? options.openai
    : config.openaiApiKey ? new (options.OpenAIClass || OpenAI)({ apiKey: config.openaiApiKey }) : null;
  if (!openai) logger.warn("[openai] OPENAI_API_KEY is not configured; deterministic features remain available.");

  const settings = options.settings || new SettingsStore({ filePath: config.settingsFile, debounceMs: config.persistDebounceMs, logger, database });
  const access = options.access || new AccessControl({ filePath: config.rolesFile, ownerIds: config.adminIds, ownerUsernames: config.adminUsernames, debounceMs: config.persistDebounceMs, logger, database });
  const audit = options.audit || new AuditService({ filePath: config.auditFile, logger });
  const memory = options.memory || new MemoryStore({
    filePath: config.memoryFile,
    historyLimit: config.userHistoryLimit,
    maxUsers: config.maxTrackedUsers,
    maxRecentReplies: config.maxRecentReplies,
    debounceMs: config.persistDebounceMs,
    logger,
    database,
  });
  const loyalty = options.loyalty || new LoyaltyService({ filePath: config.loyaltyFile, debounceMs: config.persistDebounceMs, logger, database });
  const preferences = options.preferences || new UserPreferenceService({ filePath: config.userPreferencesFile, debounceMs: config.persistDebounceMs, logger, database });
  const continuations = options.continuations || new ContinuationService({ maxLength: config.messageMaxLength, ttlMs: config.continuationTtlMs });
  const seasons = options.seasons || new MarblesSeasonService({ filePath: config.marblesSeasonsFile, debounceMs: config.persistDebounceMs, logger, database });
  const marbles = options.marbles || new MarblesBridge({
    enabled: config.marblesEnabled,
    filePath: config.marblesFile,
    registrationOpen: config.marblesRegistrationOpen,
    confirmJoins: config.marblesConfirmJoins,
    joinCommands: config.marblesJoinCommands,
    adminIds: config.adminIds,
    adminUsernames: config.adminUsernames,
    persistDebounceMs: config.persistDebounceMs,
    logger,
  });
  const moderation = options.moderation || new ModerationService({
    blockedWords: config.moderationBlockedWords,
    floodLimit: config.moderationFloodLimit,
    floodWindowMs: config.moderationFloodWindowMs,
    repeatLimit: config.moderationRepeatLimit,
  });
  const ignores = options.ignores || new IgnoreService({ database, defaultIds: config.ignoredSenderIds, defaultUsernames: config.ignoredUsernames });
  const moderationCases = options.moderationCases || new ModerationCaseService({ database });
  const events = options.events || new EventService({ database });
  const metrics = options.metrics || new MetricsService({ database });
  const rateLimiter = options.rateLimiter || new RateLimiter();
  const replyService = options.replyService || new ReplyService({
    openai,
    model: config.openaiModel,
    botName: config.botName,
    maxReplyLength: config.maxReplyLength,
    memory,
    logger,
  });
  const battlefield = options.battlefield || new BattlefieldStatsService({
    baseUrl: config.battlefieldApiUrl,
    timeoutMs: config.battlefieldTimeoutMs,
    cacheTtlMs: config.battlefieldCacheTtlMs,
    logger,
  });

  const startedAt = Date.now();
  let selfUserId;
  let ready = false;
  let shuttingDown = false;
  let restorePending = false;
  let lastMessageAt = null;
  let lastSuccessfulSendAt = null;
  const joinedRoomIds = new Set();

  function isAdmin(senderId, senderName, roomId = config.roomId || "*") {
    return access.has(roomId, senderId, senderName, "moderator") || senderId === "__system__";
  }

  function emitAsync(event, payload) {
    return new Promise((resolve, reject) => {
      socket.timeout(config.socketAckTimeoutMs).emit(event, payload, (error, response) => {
        if (error) return reject(new Error(`${event} acknowledgement timed out after ${config.socketAckTimeoutMs}ms`));
        resolve(response);
      });
    });
  }

  async function deliverRoomMessage(item) {
    if (!ready || !joinedRoomIds.has(item.roomId)) throw new Error(`Room ${item.roomId} is not connected.`);
    const sendStartedAt = Date.now();
    const roomSettings = settings.get(item.roomId);
    const response = await emitAsync("userMessage", {
      targetId: item.roomId,
      targetType: "room",
      messageType: "text",
      content: String(item.message),
      format: { color: roomSettings.reply.color },
      clientMessageId: item.id,
    });
    if (response?.error) throw new Error(`userMessage failed: ${JSON.stringify(response)}`);
    lastSuccessfulSendAt = Date.now();
    metrics.increment("messages.sent");
    metrics.timing("epikchat.send", Date.now() - sendStartedAt);
    logger.log("[send]", { roomId: item.roomId, messageId: item.id, contentLength: String(item.message).length });
    return response;
  }

  const delivery = options.delivery || new DeliveryService({ filePath: config.outboxFile, deliver: deliverRoomMessage, debounceMs: config.persistDebounceMs, logger, maxAttempts: config.outboxMaxAttempts, database });

  async function sendRoomMessage(roomId, message) {
    const chunks = splitMessage(message, config.messageMaxLength);
    let result = null;
    for (const chunk of chunks) result = await delivery.send({ roomId, message: chunk });
    return result;
  }

  const battlefieldCommunity = options.battlefieldCommunity || new BattlefieldCommunityService({
    database, battlefield, sendMessage: sendRoomMessage, intervalMs: config.battlefieldWatchIntervalMs, logger,
  });
  if (options.startBackgroundServices !== false) battlefieldCommunity.start();

  const trivia = options.trivia || new TriviaService({
    config,
    isAdmin: (senderId, senderName, roomId) => access.has(roomId || config.roomId || "*", senderId, senderName, "host"),
    sendMessage: sendRoomMessage,
    getRoomSettings: (roomId) => settings.get(roomId),
    onCorrect: ({ roomId, senderId, senderName, points }) => loyalty.award(roomId, senderId, senderName, points, "trivia"),
    logger,
    database,
  });
  const polls = options.polls || new PollService({ sendMessage: sendRoomMessage, logger });

  async function executeScheduled(item) {
    if (item.type === "announcement") return sendRoomMessage(item.roomId, item.payload);
    if (item.type === "trivia") {
      const result = trivia.start(item.roomId, "__system__", "Scheduler", item.payload || "");
      return sendCommandResult(item.roomId, result);
    }
    if (item.type === "marbles-open") return sendRoomMessage(item.roomId, marbles.handleAdmin("open").reply);
    if (item.type === "marbles-close") return sendRoomMessage(item.roomId, marbles.handleAdmin("close").reply);
    throw new Error(`Unknown scheduled activity: ${item.type}`);
  }

  const scheduler = options.scheduler || new SchedulerService({
    filePath: config.schedulesFile,
    execute: executeScheduled,
    debounceMs: config.persistDebounceMs,
    logger,
    database,
  });
  const submissions = options.submissions || new QuestionSubmissionService({
    filePath: config.submissionsFile,
    existingQuestions: () => trivia.questions,
    debounceMs: config.persistDebounceMs,
    logger,
    database,
  });
  const backupFiles = {
    database: config.databaseFile,
    settings: config.settingsFile,
    memory: config.memoryFile,
    loyalty: config.loyaltyFile,
    schedules: config.schedulesFile,
    triviaQuestions: config.triviaFile,
    triviaScores: config.triviaScoreFile,
    triviaStats: config.triviaStatsFile,
    roles: config.rolesFile,
    audit: config.auditFile,
    submissions: config.submissionsFile,
    userPreferences: config.userPreferencesFile,
    marblesRoster: config.marblesFile,
    marblesIdentity: `${config.marblesFile}.state.json`,
    marblesSeasons: config.marblesSeasonsFile,
  };
  const backup = options.backup || new BackupService({
    directory: config.backupDirectory,
    files: backupFiles,
    deferredFiles: ["database"],
    encryptionKey: config.backupEncryptionKey,
    flush: async () => { await Promise.all([settings.flush(), memory.flush(), loyalty.flush(), scheduler.flush(), trivia.flush(), marbles.flush(), access.flush(), audit.flush(), preferences.flush(), seasons.flush(), submissions.flush()]); database.checkpoint(); },
    logger,
  });
  const retention = options.retention || new RetentionService({
    retentionDays: config.retentionDays,
    logger,
    run: async (cutoff) => ({
      memoryUsers: memory.pruneBefore(cutoff),
      submissions: submissions.purgeBefore(cutoff),
      auditEvents: await audit.purgeBefore(cutoff),
      logEvents: typeof logger.purgeBefore === "function" ? await logger.purgeBefore(cutoff) : 0,
    }),
  });
  const registry = new CommandRegistry();

  async function sendCommandResult(roomId, result, context = null) {
    if (result?.reply) {
      const userPreferences = context ? preferences.get(roomId, context.senderId, context.senderName) : settings.get(roomId).accessibility;
      await sendRoomMessage(roomId, preferences.format(result.reply, userPreferences));
    }
    if (result?.advanceTrivia) await trivia.advance(roomId);
  }

  function userPointsReply(roomId, senderId, senderName) {
    const { user, level, title } = loyalty.progress(roomId, senderId, senderName);
    const achievements = user.achievements.length ? ` Achievements: ${user.achievements.join(", ")}.` : "";
    return `${user.name}: level ${level} ${title}, ${user.points} points, ${user.triviaWins} trivia wins.${achievements}`;
  }

  const { handleAskBattlefield, handleBattlefield } = createBattlefieldCommandHandlers({
    battlefield,
    battlefieldCommunity,
    config,
    continuations,
    logger,
    openai,
    preferences,
  });

  registry
    .register({ name: "help", aliases: ["commands", "ayuda"], usage: "[category|command]", description: "Browse command help", handler: ({ role, t, text }) => {
      const query = String(text || "").trim().toLowerCase();
      if (!query) return { reply: `${t("commands")} categories: ${registry.categories({ role }).join(", ")}. Use ^help <category> or ^help <command>.` };
      const command = registry.resolve(query);
      if (command) return { reply: `^${command.name}${command.usage ? ` ${command.usage}` : ""}: ${command.description || "No description"} [${command.category}]` };
      const lines = registry.help({ role, category: query });
      return { reply: lines.length ? `${query}: ${lines.map((line) => line.split(" — ")[0]).join(", ")}` : "Help category or command not found." };
    } })
    .register({ name: "bf", aliases: ["bf6", "battlefield"], usage: "[stats|set|badges|compare|top]", feature: "battlefield", cooldown: "battlefield", description: "Battlefield 6 player statistics", handler: handleBattlefield })
    .register({ name: "askbf", usage: "<question>", feature: "battlefield", cooldown: "battlefield", description: "Ask a grounded question about your Battlefield stats", handler: handleAskBattlefield })
    .register({ name: "bfverify", usage: "<code>", feature: "battlefield", permission: "moderator", description: "Confirm a Battlefield account link", handler: ({ senderId, text }) => {
      const link = battlefieldCommunity.verify(String(text).trim(), senderId);
      return { reply: link ? `Verified ${link.userName || link.userId} as ${link.eaId}.` : "Verification code not found." };
    } })
    .register({ name: "ignore", usage: "add|remove|list|status", permission: "moderator", description: "Manage room ignore rules", handler: ({ roomId, senderId, text }) => {
      const [action = "list", type = "name", ...valueParts] = String(text).trim().split(/\s+/); const value = valueParts.join(" ");
      if (action === "list") { const rows = ignores.list(roomId); return { reply: rows.length ? `Ignored: ${rows.map((rule) => `${rule.type}:${rule.value}`).join(" • ")}` : "No ignored users." }; }
      if (action === "add") { const rule = ignores.add(roomId, type, value, senderId); return { reply: `Ignoring ${rule.type}:${rule.value} in this room.` }; }
      if (action === "remove") { ignores.remove(roomId, type, value, senderId); return { reply: `No longer ignoring ${type}:${value} in this room.` }; }
      if (action === "status") return { reply: `${type}:${value} is ${ignores.status(roomId, type, value) ? "ignored" : "not ignored"}.` };
      return { reply: "Use: ^ignore add|remove|status <id|name> <value>, or ^ignore list." };
    } })
    .register({ name: "warn", usage: "<user-id> <reason>", permission: "moderator", description: "Create a moderation warning", handler: ({ roomId, senderId, senderName, text }) => {
      const [userId, ...reason] = String(text).trim().split(/\s+/); const item = moderationCases.create({ roomId, userId, actorId: senderId, actorName: senderName, reason: reason.join(" "), action: "warning" });
      return { reply: `Warning recorded as ${item.id} for ${userId}.` };
    } })
    .register({ name: "case", usage: "list|show|note|resolve", permission: "moderator", description: "Manage moderation cases", handler: ({ roomId, senderId, text }) => {
      const [action = "list", value, ...rest] = String(text).trim().split(/\s+/);
      if (action === "list") { const rows = moderationCases.list(roomId, value || null, 5); return { reply: rows.length ? rows.map((item) => `${item.id} ${item.userId} [${item.status}] ${item.reason}`).join(" • ") : "No moderation cases." }; }
      if (action === "show") { const item = moderationCases.get(value); return { reply: item ? `${item.id}: ${item.userId}, ${item.action}, ${item.status}, ${item.reason}${item.appeal ? `; appeal: ${item.appeal.text}` : ""}` : "Case not found." }; }
      if (action === "note") { const item = moderationCases.note(value, senderId, rest.join(" ")); return { reply: item ? "Case note added." : "Case not found." }; }
      if (action === "resolve") { const item = moderationCases.resolve(value, senderId, rest[0] || "resolved"); return { reply: item ? `Case marked ${item.status}.` : "Case not found." }; }
      return { reply: "Use: ^case list [user-id]|show <id>|note <id> <text>|resolve <id> [decision]." };
    } })
    .register({ name: "appeal", usage: "<message>", description: "Appeal your latest open moderation case", handler: ({ roomId, senderId, text }) => {
      const item = moderationCases.appeal(roomId, senderId, text); return { reply: item ? `Appeal added to ${item.id}.` : "You have no open moderation case to appeal." };
    } })
    .register({ name: "event", usage: "create|list|join|leave|teams|close", description: "Organize community game nights", handler: async ({ roomId, senderId, senderName, text, hasPermission }) => {
      const [action = "list", id, ...rest] = String(text).trim().split(/\s+/);
      if (action === "list") { const rows = events.active(roomId); return { reply: rows.length ? rows.map((event) => `${event.id}: ${event.title} (${Object.keys(event.participants).length} joined)${event.startsAt ? ` @ ${new Date(event.startsAt).toLocaleString()}` : ""}`).join(" • ") : "No open community events." }; }
      if (action === "create") { if (!hasPermission("host")) return { reply: "Creating events requires the host role." }; const event = events.create(roomId, senderId, [id, ...rest].join(" ")); if (event.startsAt && event.startsAt > Date.now()) { const runAt = Math.max(Date.now() + 1000, event.startsAt - 3600000); const reminder = scheduler.add({ roomId, type: "announcement", payload: `Game night reminder: ${event.title} starts at ${new Date(event.startsAt).toLocaleString()}. Join with ^event join ${event.id}.`, runAt }); event.reminderId = reminder.id; events.save(event); } return { reply: `Created ${event.id}: ${event.title}. Join with ^event join ${event.id}.` }; }
      if (action === "join") { const existing = events.get(id); const alreadyJoined = Boolean(existing?.participants[String(senderId).toLowerCase()]); const event = events.join(id, senderId, senderName); if (event && !alreadyJoined) loyalty.award(roomId, senderId, senderName, 3, "event"); return { reply: event ? `Joined ${event.title}.` : "Event not found or closed." }; }
      if (action === "leave") { const event = events.leave(id, senderId); return { reply: event ? `Left ${event.title}.` : "Event not found." }; }
      if (action === "teams") { if (!hasPermission("host")) return { reply: "Team generation requires the host role." }; const teams = await events.balance(id, async (player) => { const link = battlefieldCommunity.getLink(roomId, player.id); if (!link) return 0; const stats = await battlefield.stats(link.eaId); return stats.fields?.kd_ratio || 0; }); return { reply: teams ? `Team A: ${teams.a.map((p) => p.name).join(", ") || "none"} | Team B: ${teams.b.map((p) => p.name).join(", ") || "none"}` : "Event not found." }; }
      if (action === "remind") { if (!hasPermission("host")) return { reply: "Event reminders require the host role." }; const event = events.get(id); if (!event) return { reply: "Event not found." }; return { reply: `Reminder: ${event.title}${event.startsAt ? ` starts ${new Date(event.startsAt).toLocaleString()}` : ""}. Join with ^event join ${event.id}.` }; }
      if (action === "close") { if (!hasPermission("host")) return { reply: "Closing events requires the host role." }; const event = events.close(id); if (event?.reminderId) scheduler.remove(event.reminderId); return { reply: event ? `Closed ${event.title}.` : "Event not found." }; }
      return { reply: "Use: ^event create Title|date, list, join <id>, leave <id>, teams <id>, or close <id>." };
    } })
    .register({ name: "metrics", permission: "moderator", description: "Show operational bot metrics", handler: () => ({ reply: JSON.stringify(metrics.snapshot()).slice(0, 1500) }) })
    .register({ name: "continue", aliases: ["more"], feature: "ai", description: "Continue your previous AI response", handler: ({ roomId, senderId, senderName }) => ({ reply: continuations.next(roomId, senderId, senderName).message }) })
    .register({ name: "bot", usage: "status|help", description: "Bot status", handler: ({ roomId, text }) => {
      if (!text || text.toLowerCase() === "help") return { reply: "Use ^help for commands or ^bot status for health." };
      if (text.toLowerCase() !== "status") return { reply: "Bot command not recognized." };
      const status = trivia.status(roomId);
      return { reply: `Bot: ${ready ? "online" : "offline"}, ${joinedRoomIds.size} room(s), trivia ${status.active ? "running" : "stopped"}, uptime ${Math.floor((Date.now() - startedAt) / 60000)}m.` };
    } })
    .register({ name: "trivia", usage: "start|stop|score|categories|stats", feature: "trivia", description: "Trivia controls", handler: (context) => trivia.handleCommand(context) })
    .register({ name: "answer", aliases: ["respuesta"], usage: "<guess>", feature: "trivia", cooldown: "answer", description: "Answer trivia", handler: (context) => trivia.handleCommand(context) })
    .register({ name: "memory", usage: "show|export|forget|on|off", feature: "memory", description: "Manage your memory", handler: ({ roomId, senderId, senderName, text }) => {
      const action = String(text || "show").trim().toLowerCase();
      if (action === "off") { memory.setEnabled(roomId, senderId, senderName, false); return { reply: "Memory is off for you in this room." }; }
      if (action === "on") { memory.setEnabled(roomId, senderId, senderName, true); return { reply: "Memory is on for you in this room." }; }
      if (action === "forget") { memory.forget(roomId, senderId, senderName); return { reply: "I forgot your saved history and preferences in this room." }; }
      if (action === "export") return { reply: JSON.stringify(memory.exportUser(roomId, senderId, senderName)).slice(0, 1500) };
      const data = memory.show(roomId, senderId, senderName);
      return { reply: data ? `I remember ${data.history.length} recent message(s) and ${Object.keys(data.preferences).length} preference(s). Memory is ${memory.isEnabled(roomId, senderId, senderName) ? "on" : "off"}.` : "I do not have saved memory for you in this room." };
    } })
    .register({ name: "points", aliases: ["puntos"], feature: "loyalty", description: "Show loyalty points", handler: ({ roomId, senderId, senderName }) => ({ reply: userPointsReply(roomId, senderId, senderName) }) })
    .register({ name: "progress", aliases: ["rank", "level"], feature: "loyalty", description: "Show your community level and next milestone", handler: ({ roomId, senderId, senderName }) => {
      const progress = loyalty.progress(roomId, senderId, senderName);
      return { reply: `${progress.user.name}: level ${progress.level} ${progress.title}. ${progress.user.points}/${progress.nextLevelAt} points toward level ${progress.level + 1}.` };
    } })
    .register({ name: "quests", feature: "loyalty", description: "Show today's community quests", handler: ({ roomId, senderId, senderName }) => {
      const quests = loyalty.quests(roomId, senderId, senderName);
      return { reply: `Daily quests: ${quests.map((quest) => `${quest.completed ? "✓" : `${quest.progress}/${quest.target}`} ${quest.label} (+${quest.reward})`).join(" • ")}` };
    } })
    .register({ name: "daily", aliases: ["diario"], feature: "loyalty", description: "Claim daily points", handler: ({ roomId, senderId, senderName }) => {
      const result = loyalty.daily(roomId, senderId, senderName);
      return { reply: result.ok ? `Daily bonus claimed! ${userPointsReply(roomId, senderId, senderName)}` : "You already claimed today's bonus." };
    } })
    .register({ name: "leaderboard", aliases: ["top", "clasificacion"], feature: "loyalty", description: "Points leaderboard", handler: ({ roomId }) => {
      const leaders = loyalty.leaderboard(roomId);
      return { reply: leaders.length ? `Points: ${leaders.map((user, index) => `${index + 1}) ${user.name} ${user.points}`).join(" • ")}` : "No loyalty points yet." };
    } })
    .register({ name: "vote", usage: "<number>", feature: "polls", description: "Vote in a poll", handler: ({ roomId, senderId, text }) => {
      const result = polls.vote(roomId, senderId, text);
      return { reply: result.ok ? `Vote recorded for ${result.option.label}.` : result.reason === "no-poll" ? "There is no active poll." : "Invalid poll choice." };
    } })
    .register({ name: "poll", usage: "create|status|close", feature: "polls", permission: "moderator", description: "Manage polls", handler: async ({ roomId, text }) => {
      const [action, ...rest] = String(text).trim().split(/\s+/);
      if (action === "close") { const poll = await polls.close(roomId); return { reply: poll ? null : "There is no active poll." }; }
      if (action === "status") { const poll = polls.polls.get(String(roomId)); return { reply: poll ? polls.format(poll) : "There is no active poll." }; }
      if (action === "create") {
        const parts = rest.join(" ").split("|").map((part) => part.trim()).filter(Boolean);
        const duration = /^\d+$/.test(parts.at(-1) || "") ? Number(parts.pop()) * 1000 : 60000;
        if (parts.length < 3) return { reply: "Use: ^poll create Question|Option 1|Option 2|60" };
        const poll = polls.create(roomId, parts[0], parts.slice(1), duration);
        return { reply: `Poll opened: ${polls.format(poll)}` };
      }
      return { reply: "Poll commands: create, status, close." };
    } })
    .register({ name: "config", usage: "show|set|reset", permission: "owner", description: "Room settings", handler: ({ roomId, text }) => {
      const [action, settingPath, ...valueParts] = String(text).trim().split(/\s+/);
      if (!action || action === "show") return { reply: JSON.stringify(settings.get(roomId)).slice(0, 1000) };
      if (action === "reset") { settings.reset(roomId); return { reply: "Room settings reset." }; }
      if (action === "set" && settingPath && valueParts.length) {
        settings.set(roomId, settingPath, valueParts.join(" "));
        return { reply: `Updated ${settingPath}.` };
      }
      return { reply: "Use: ^config set ai.enabled false (or ^config show / reset)." };
    } })
    .register({ name: "question", usage: "list|add|remove|enable|disable|reload|stats", feature: "trivia", permission: "host", description: "Manage questions", handler: async ({ text }) => {
      const [action, ...args] = String(text).trim().split(/\s+/);
      if (action === "list") return { reply: trivia.listQuestions().slice(0, 5).join(" • ") || "No questions." };
      if (action === "add") { const question = await trivia.addQuestion(args.join(" ")); return { reply: `Added: ${question.question}` }; }
      if (action === "remove") { const question = await trivia.removeQuestion(args[0]); return { reply: question ? `Removed: ${question.question}` : "Question not found." }; }
      if (action === "enable" || action === "disable") { const question = await trivia.setQuestionEnabled(args[0], action === "enable"); return { reply: question ? `${action}d: ${question.question}` : "Question not found." }; }
      if (action === "reload") return { reply: `Reloaded ${trivia.reloadQuestions()} questions.` };
      if (action === "stats") return { reply: trivia.formatStats() };
      return { reply: "Question commands: list, add, remove, enable, disable, reload, stats." };
    } })
    .register({ name: "schedule", usage: "add|every|list|remove", permission: "moderator", description: "Schedule activities", handler: ({ roomId, text }) => {
      const [action, timeText, type, ...payload] = String(text).trim().split(/\s+/);
      if (action === "list") {
        const items = scheduler.list(roomId);
        return { reply: items.length ? items.map((item) => `${item.id}: ${item.type} @ ${new Date(item.runAt).toLocaleString()}`).join(" • ") : "No scheduled activities." };
      }
      if (action === "remove") return { reply: scheduler.remove(timeText) ? "Schedule removed." : "Schedule not found." };
      if (["add", "every"].includes(action) && Number(timeText) > 0 && type) {
        if (!["announcement", "trivia", "marbles-open", "marbles-close"].includes(type)) return { reply: "Unknown schedule type." };
        const minutes = Number(timeText);
        const item = scheduler.add({ roomId, type, payload: payload.join(" "), runAt: Date.now() + minutes * 60000, repeatMs: action === "every" ? minutes * 60000 : 0 });
        return { reply: `Scheduled ${type} (${item.id}).` };
      }
      return { reply: "Use: ^schedule add <minutes> announcement <message> (types: announcement, trivia, marbles-open, marbles-close)." };
    } })
    .register({ name: "mod", usage: "mute|unmute", permission: "moderator", description: "Moderation controls", handler: ({ roomId, senderId, senderName, text }) => {
      const [action, userId, minutes = "5", ...reasonParts] = String(text).trim().split(/\s+/);
      if (action === "mute" && userId) { moderation.mute(roomId, userId, Number(minutes) * 60000); const item = moderationCases.create({ roomId, userId, actorId: senderId, actorName: senderName, reason: reasonParts.join(" ") || "Temporary mute", action: "mute", durationMs: Number(minutes) * 60000 }); return { reply: `${userId} muted for ${minutes} minute(s) (${item.id}).` }; }
      if (action === "unmute" && userId) { moderation.unmute(roomId, userId); return { reply: `${userId} unmuted.` }; }
      return { reply: "Use: ^mod mute <userId> [minutes] or ^mod unmute <userId>." };
    } })
    .register({ name: "role", usage: "list|grant|revoke", permission: "owner", description: "Manage room roles", handler: ({ roomId, senderId, senderName, text }) => {
      const [action, identity, role] = String(text).trim().split(/\s+/);
      if (!action || action === "list") {
        const rows = access.list(roomId);
        return { reply: rows.length ? rows.map((entry) => `${entry.identity}=${entry.role}`).join(" • ") : "No delegated roles." };
      }
      if (action === "grant" && identity && role) { const grant = access.grant(roomId, identity, role); audit.record({ roomId, actorId: senderId, actorName: senderName, action: "role.grant", target: grant.identity, role: grant.role }); return { reply: `Granted ${grant.role} to ${grant.identity}.` }; }
      if (action === "revoke" && identity) { const removed = access.revoke(roomId, identity); audit.record({ roomId, actorId: senderId, actorName: senderName, action: "role.revoke", target: identity }); return { reply: removed ? "Role revoked." : "Role not found." }; }
      return { reply: "Use: ^role grant <user-id> <host|moderator|owner>, ^role revoke <user-id>, or ^role list." };
    } })
    .register({ name: "audit", usage: "[count]", permission: "moderator", description: "Show administrative audit history", handler: ({ roomId, text }) => {
      const entries = audit.recent(roomId, Math.min(20, Math.max(1, Number(text) || 5)));
      return { reply: entries.length ? entries.map((entry) => `${entry.at}: ${entry.actorName || entry.actorId || "system"} ${entry.action}`).join(" • ") : "No audit events." };
    } })
    .register({ name: "backup", usage: "create|list|verify|restore", permission: "owner", description: "Back up or restore bot data", handler: async ({ text }) => {
      const [action, name, confirmation] = String(text).trim().split(/\s+/);
      if (action === "create") { const result = await backup.create(); return { reply: `Backup created: ${result.name} (${result.files.length} files${result.encrypted ? ", encrypted" : ""}).` }; }
      if (action === "list") return { reply: backup.list().slice(0, 5).join(" • ") || "No backups." };
      if (action === "verify" && name) { const info = backup.inspect(name); return { reply: `Verified ${info.name}: ${info.files.length} files.` }; }
      if (action === "restore" && name && confirmation === "CONFIRM") { const info = await backup.restore(name); restorePending = true; scheduler.stopAll(); retention.stop(); return { reply: `Restored ${info.files.length} files. Restart the bot now; new commands are paused.` }; }
      return { reply: "Use: ^backup create|list|verify <name>|restore <name> CONFIRM." };
    } })
    .register({ name: "submit", usage: "Question|answer|category|difficulty|aliases|choices", feature: "submissions", description: "Submit a trivia question", handler: ({ roomId, senderId, senderName, text }) => {
      const result = submissions.submit({ roomId, senderId, senderName, specification: text });
      return { reply: result.ok ? `Question submitted for review (${result.item.id}).` : "That question is already present or pending." };
    } })
    .register({ name: "review", usage: "list|approve|reject", feature: "submissions", permission: "host", description: "Review submitted questions", handler: async ({ roomId, senderId, text }) => {
      const [action, id] = String(text).trim().split(/\s+/);
      if (!action || action === "list") { const items = submissions.pending(roomId); return { reply: items.length ? items.slice(0, 5).map((item) => `${item.id}: ${item.question} → ${item.answer}`).join(" • ") : "No pending submissions." }; }
      if (action === "approve" && id) { const item = await submissions.approve(id, senderId, (spec) => trivia.addQuestion(spec)); return { reply: item ? `Approved: ${item.question}` : "Submission not found." }; }
      if (action === "reject" && id) { const item = submissions.reject(id, senderId); return { reply: item ? `Rejected: ${item.question}` : "Submission not found." }; }
      return { reply: "Use: ^review list|approve <id>|reject <id>." };
    } })
    .register({ name: "profile", usage: "show|language|timezone|concise", description: "Set language and accessibility preferences", handler: ({ roomId, senderId, senderName, text, t }) => {
      const [action = "show", ...values] = String(text).trim().split(/\s+/);
      if (action === "forget") { preferences.forget(roomId, senderId, senderName); return { reply: "Profile preferences deleted." }; }
      if (["language", "timezone", "concise"].includes(action) && values.length) preferences.set(roomId, senderId, senderName, action, values.join(" "));
      const profile = preferences.get(roomId, senderId, senderName);
      return { reply: t("profile", { language: profile.language || settings.get(roomId).locale.language, timezone: profile.timezone, concise: profile.concise ? "on" : "off" }) };
    } })
    .register({ name: "season", usage: "start|status|leaderboard|end", feature: "marbles", description: "Marbles season standings", handler: ({ roomId, text, hasPermission }) => {
      const [action = "status", ...rest] = String(text).trim().split(/\s+/);
      if (action === "leaderboard" || action === "status") { const season = seasons.get(roomId); const leaders = seasons.leaderboard(roomId); return { reply: season ? `${season.name} (${season.active ? "active" : "ended"}, ${season.races.length} races): ${leaders.map((player, index) => `${index + 1}) ${player.name} ${player.points}`).join(" • ") || "no results"}` : "No Marbles season." }; }
      if (!hasPermission("host")) return { reply: "Season controls require the host role." };
      if (action === "start") { const season = seasons.start(roomId, rest.join(" ")); return { reply: `Started ${season.name}.` }; }
      if (action === "end") { const season = seasons.end(roomId); return { reply: season ? `Ended ${season.name}.` : "No active season." }; }
      return { reply: "Use: ^season start [name]|status|leaderboard|end." };
    } })
    .register({ name: "race", usage: "result name1|name2|name3", feature: "marbles", permission: "host", description: "Record Marbles race results", handler: ({ roomId, text }) => {
      const match = String(text).match(/^result\s+(.+)$/i);
      if (!match) return { reply: "Use: ^race result Winner|Second|Third." };
      const race = seasons.record(roomId, match[1].split("|"));
      return { reply: `Race ${seasons.get(roomId).races.length} recorded: ${race.finishers.join(" → ")}.` };
    } })
    .register({ name: "outbox", usage: "status|retry", permission: "owner", description: "Inspect reliable delivery", handler: async ({ text }) => {
      if (String(text).trim() === "retry") await delivery.retryFailed();
      const state = delivery.status();
      return { reply: `Outbox: ${state.pending} pending, ${state.failed} failed.` };
    } })
    .register({ name: "retention", usage: "status|run", permission: "owner", description: "Manage data retention", handler: async ({ text }) => {
      if (String(text).trim() === "run") await retention.run();
      const state = retention.status();
      return { reply: `Retention: ${state.retentionDays} days; last run ${state.lastRunAt ? new Date(state.lastRunAt).toISOString() : "never"}.` };
    } });

  registry.register({
    name: "ping",
    description: "Measure the EpikChat socket round-trip time",
    handler: async () => {
      const started = process.hrtime.bigint();
      try {
        const response = await emitAsync("whoami", {});
        if (response?.error) throw new Error(String(response.error));
        const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;
        return { reply: `EpikChat pong: ${elapsedMs.toFixed(1)}ms.` };
      } catch (error) {
        logger.warn("[ping] EpikChat acknowledgement failed", error?.message || error);
        return { reply: "EpikChat ping failed: the server did not acknowledge the request." };
      }
    },
  });

  for (const builtin of ["echo", "pet", "status", "treat"]) {
    registry.register({
      name: builtin,
      description: `${builtin[0].toUpperCase()}${builtin.slice(1)} command`,
      handler: async ({ roomId, senderId, senderName }) => ({
        reply: await replyService.generate({
          roomId,
          message: builtin,
          senderId,
          senderName,
          command: builtin,
          startedAt: Date.now(),
          roomSettings: settings.get(roomId),
        }),
      }),
    });
  }

  const pluginLoader = options.pluginLoader || new PluginLoader({
    directory: config.pluginsDirectory,
    registry,
    services: { access, audit, battlefield, battlefieldCommunity, database, events, ignores, loyalty, marbles, memory, metrics, moderationCases, polls, scheduler, seasons, settings, submissions, trivia },
    logger,
  });
  registry.register({ name: "plugins", usage: "list|reload", permission: "owner", description: "Manage trusted local plugins", handler: ({ text }) => {
    if (String(text).trim() === "reload") pluginLoader.reloadAll();
    const loaded = pluginLoader.list();
    return { reply: loaded.length ? loaded.map((plugin) => `${plugin.name}@${plugin.version}`).join(" • ") : "No plugins loaded." };
  } });
  if (options.loadPlugins !== false) pluginLoader.loadAll();

  function cooldownKey(scope, roomId, senderId, senderName) {
    return `${scope}:${roomId}:${String(senderId || senderName || "unknown").toLowerCase()}`;
  }

  async function handleMessage(payload) {
    try {
      const roomId = payload?.targetId;
      const senderId = payload?.senderId;
      const senderName = payload?.senderName;
      const content = payload?.content;
      const normalizedName = typeof senderName === "string" ? senderName.trim().toLowerCase() : "";
      if (restorePending || !ready || !joinedRoomIds.has(roomId) || typeof content !== "string" || !content.trim()) return;
      if (senderId === selfUserId || ignores.isIgnored(roomId, senderId, normalizedName)) return;
      lastMessageAt = Date.now();
      metrics.increment("messages.received");

      const roomSettings = settings.get(roomId);
      if (roomSettings.moderation.enabled && !isAdmin(senderId, senderName, roomId)) {
        const moderationResult = moderation.check({ roomId, senderId, senderName, content, linksAllowed: roomSettings.moderation.linksAllowed });
        if (!moderationResult.allowed) {
          logger.warn("[moderation]", { roomId, senderId, reason: moderationResult.reason });
          return;
        }
      }

      const marbleCommand = marbles.parse(content);
      if (marbleCommand) {
        if (!settings.isFeatureEnabled(roomId, "marbles")) return;
        if (!rateLimiter.consume(cooldownKey("marbles", roomId, senderId, senderName), config.marblesCooldownMs)) return;
        const result = marbleCommand.type === "admin" && access.has(roomId, senderId, senderName, "host")
          ? marbles.handleAdmin(marbleCommand.command)
          : marbles.handleMessage({ senderId, senderName, content });
        if (result.joined) loyalty.award(roomId, senderId, senderName, 2, "marbles");
        if (result.reply) await sendRoomMessage(roomId, result.reply);
        return;
      }

      const parsed = parseCommand(content);
      if (content.trim().length < config.minReplyLength) return;
      if (!parsed.isCommand && !roomSettings.ai.respondToAll) return;
      const definition = registry.resolve(parsed.command);
      if (definition && !settings.isCommandEnabled(roomId, definition.name)) return;
      const userPreferences = preferences.get(roomId, senderId, senderName);
      const language = userPreferences.language || roomSettings.locale.language || "en";
      const context = {
        roomId,
        senderId,
        senderName,
        command: parsed.command,
        text: parsed.text,
        role: access.roleFor(roomId, senderId, senderName),
        isAdmin: isAdmin(senderId, senderName, roomId),
        hasPermission: (required) => access.has(roomId, senderId, senderName, required),
        t: (key, variables) => translate(language, key, variables),
      };
      if (definition?.feature && !settings.isFeatureEnabled(roomId, definition.feature)) {
        await sendRoomMessage(roomId, context.t("disabled"));
        return;
      }
      const cooldownType = definition?.cooldown || "command";
      const cooldownMs = cooldownType === "answer"
        ? config.triviaGuessCooldownMs
        : cooldownType === "battlefield" ? config.battlefieldCooldownMs : config.commandCooldownMs;
      if (!rateLimiter.consume(cooldownKey(cooldownType, roomId, senderId, senderName), cooldownMs)) return;

      if (definition) {
        const commandStartedAt = Date.now();
        const result = await registry.execute(context);
        metrics.increment(`commands.${definition.name}`);
        metrics.timing("commands.total", Date.now() - commandStartedAt);
        if (definition.permission !== "viewer") {
          const required = definition.permission === "admin" ? "moderator" : definition.permission;
          audit.record({ roomId, actorId: senderId, actorName: senderName, role: context.role, action: `command.${definition.name}`, authorized: context.hasPermission(required) });
        }
        await sendCommandResult(roomId, result, context);
        return;
      }

      memory.rememberMessage(roomId, senderId, senderName, content);
      memory.rememberPreference(roomId, senderId, senderName, content);
      if (!settings.isFeatureEnabled(roomId, "ai")) return;
      const generated = await replyService.generate({
        roomId,
        message: parsed.text || parsed.command || content,
        senderId,
        senderName: senderName || senderId,
        command: parsed.command,
        startedAt: Date.now(),
        roomSettings,
        detailed: true,
      });
      const reply = generated.source === "ai"
        ? continuations.start(roomId, senderId, senderName, generated.text)
        : generated.text;
      await sendRoomMessage(roomId, reply);
    } catch (error) {
      logger.error("[message handler error]", error);
    }
  }

  async function handleConnect() {
    ready = false;
    joinedRoomIds.clear();
    try {
      selfUserId = (await emitAsync("whoami", {}))?.id;
      metrics.increment("socket.connects");
      const access = await emitAsync("getBotAccess", {});
      const rooms = (access?.rooms || []).filter((entry) => entry?.roomId && entry?.canJoin);
      const results = await Promise.allSettled(rooms.map((entry) => emitAsync("joinRoom", { roomId: entry.roomId })));
      results.forEach((result, index) => {
        const roomId = rooms[index].roomId;
        if (result.status === "fulfilled" && !result.value?.error) joinedRoomIds.add(roomId);
        else logger.error(`[joinRoom] failed for ${roomId}`, result.status === "rejected" ? result.reason : result.value?.error);
      });
      ready = joinedRoomIds.size > 0;
      if (!ready) logger.error("[connect] Could not join any rooms.");
      else {
        logger.log("[connect]", { rooms: [...joinedRoomIds] });
        await delivery.drain();
      }
    } catch (error) {
      logger.error("[connect error]", error);
    }
  }

  function handleDisconnect(reason) {
    ready = false;
    joinedRoomIds.clear();
    trivia.stopAll();
    polls.stopAll();
    rateLimiter.clear();
    metrics.increment("socket.disconnects");
    logger.log("[disconnect]", reason);
  }

  const operationalMonitor = options.operationalMonitor || new OperationalMonitor({
    enabled: config.operationsAlertsEnabled,
    intervalMs: config.operationsCheckIntervalMs,
    logger,
    inspect: async () => ({ outbox: delivery.status(), openai: replyService.status(), battlefieldErrorAt: battlefield.status?.().lastOperationalErrorAt || null }),
    notify: async (message) => Promise.all([...joinedRoomIds].map((roomId) => sendRoomMessage(roomId, message))),
  });
  if (options.startBackgroundServices !== false) operationalMonitor.start();

  function getStatus(roomId = null) {
    return {
      ok: ready,
      restartRequired: restorePending,
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      joinedRooms: [...joinedRoomIds],
      openai: typeof replyService.status === "function" ? replyService.status() : { configured: Boolean(openai) },
      battlefield: battlefield.status?.() || { configured: true },
      lastMessageAt,
      lastSuccessfulSendAt,
      memoryUsers: memory.users.size,
      scheduledActivities: roomId ? scheduler.list(roomId).length : scheduler.items.size,
      activePolls: polls.polls.size,
      outbox: delivery.status(),
      plugins: pluginLoader.list(),
      retention: retention.status(),
      operations: operationalMonitor.status(),
      metrics: metrics.snapshot(),
      ignoredRules: roomId ? ignores.list(roomId).length : null,
      openEvents: roomId ? events.active(roomId).length : null,
      community: roomId ? {
        leaderboard: loyalty.leaderboard(roomId, 10).map((user) => {
          const progress = loyalty.progress(roomId, user.id, user.name);
          return { name: user.name, points: user.points, level: progress.level, title: progress.title };
        }),
      } : null,
      errors: logger.errorCount || 0,
      lastErrorAt: logger.lastErrorAt || null,
      room: roomId ? { id: roomId, settings: settings.get(roomId), trivia: trivia.status(roomId), marblesPlayers: marbles.players.size } : null,
    };
  }

  async function runDashboardAction({ roomId, action }) {
    if (!roomId) throw new Error("roomId is required");
    if (action === "trivia-start") await sendCommandResult(roomId, trivia.start(roomId, "__system__", "Dashboard"));
    else if (action === "trivia-stop") await sendCommandResult(roomId, trivia.stop(roomId, "__system__", "Dashboard"));
    else if (action === "marbles-open") await sendRoomMessage(roomId, marbles.handleAdmin("open").reply);
    else if (action === "marbles-close") await sendRoomMessage(roomId, marbles.handleAdmin("close").reply);
    else throw new Error("Unknown action");
    audit.record({ roomId, actorId: "dashboard", actorName: "Dashboard", role: "owner", action: `dashboard.${action}`, authorized: true });
    return { ok: true };
  }

  const dashboardAuth = options.dashboardAuth || new DashboardAuthService({
    database,
    bootstrapUsername: config.dashboardUsername,
    bootstrapPassword: config.dashboardPassword,
    sessionTtlMs: config.dashboardSessionTtlMs,
    logger,
  });

  const dashboard = options.dashboard || new DashboardServer({
    host: config.dashboardHost,
    port: config.dashboardPort,
    token: config.dashboardToken,
    auth: dashboardAuth,
    tlsKeyFile: config.dashboardTlsKeyFile,
    tlsCertFile: config.dashboardTlsCertFile,
    getStatus: async (roomId) => getStatus(roomId),
    setSetting: async ({ roomId, path, value }) => {
      if (!roomId) throw new Error("roomId is required");
      audit.record({ roomId, actorId: "dashboard", actorName: "Dashboard", role: "owner", action: `settings.${path}`, authorized: true });
      return { ok: true, settings: settings.set(roomId, path, value) };
    },
    runAction: runDashboardAction,
    logger,
  });
  if (config.dashboardEnabled) {
    if (!config.dashboardToken && !config.dashboardUsername) logger.error("[dashboard] Configure DASHBOARD_TOKEN or DASHBOARD_USERNAME/DASHBOARD_PASSWORD.");
    else {
      if (!["127.0.0.1", "::1", "localhost"].includes(config.dashboardHost) && !(config.dashboardTlsKeyFile && config.dashboardTlsCertFile)) {
        logger.warn("[dashboard] Non-local binding should be protected by authenticated HTTPS.");
      }
      dashboard.start();
    }
  }

  async function shutdown(reason = "shutdown") {
    if (shuttingDown) return;
    shuttingDown = true;
    ready = false;
    trivia.stopAll();
    polls.stopAll();
    scheduler.stopAll();
    retention.stop();
    battlefieldCommunity.stop();
    operationalMonitor.stop();
    continuations.clearAll();
    logger.log("[shutdown]", reason);
    await dashboard.stop();
    if (!restorePending) await Promise.all([memory.flush(), trivia.flush(), marbles.flush(), loyalty.flush(), settings.flush(), scheduler.flush(), access.flush(), preferences.flush(), seasons.flush(), submissions.flush()]);
    await Promise.all([audit.flush(), delivery.flush()]);
    if (typeof socket.close === "function") socket.close();
    if (typeof logger.flush === "function") await logger.flush();
    if (typeof database.close === "function") database.close();
  }

  socket.on("connect", handleConnect);
  socket.on("connect_error", (error) => logger.error("[connect_error]", error?.message || error));
  socket.on("disconnect", handleDisconnect);
  socket.on("message", handleMessage);
  socket.on("closeReason", (reason) => logger.log("[closeReason]", reason));
  socket.on("userJoined", async (payload) => {
    const roomId = payload?.roomId || payload?.targetId;
    const roomSettings = settings.get(roomId);
    if (!ready || !joinedRoomIds.has(roomId) || !roomSettings.welcome.enabled || !settings.isFeatureEnabled(roomId, "welcome")) return;
    const name = payload?.senderName || payload?.username || "friend";
    await sendRoomMessage(roomId, String(roomSettings.welcome.message).replaceAll("{name}", name)).catch((error) => logger.error("[welcome]", error));
  });

  if (options.installSignalHandlers) {
    const onSignal = (signal) => shutdown(signal).then(() => process.exit(0)).catch((error) => {
      logger.error("[shutdown error]", error);
      process.exit(1);
    });
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  }

  return {
    config, dashboard, getStatus, handleConnect, handleDisconnect, handleMessage, isReady: () => ready,
    access, audit, backup, battlefield, continuations, database, delivery, joinedRoomIds, loyalty, marbles, memory, moderation, pluginLoader, polls,
    preferences, rateLimiter, registry, retention, scheduler, seasons, settings, shutdown, socket, submissions, trivia,
    battlefieldCommunity, dashboardAuth, events, ignores, metrics, moderationCases, operationalMonitor,
  };
}

if (require.main === module) {
  try { createBot({ installSignalHandlers: true }); }
  catch (error) { console.error("[startup error]", error.message || error); process.exit(1); }
}

module.exports = { createBot, parseCommand };
