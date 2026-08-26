const path = require("path");

function parseBoolean(value, defaultValue = false) {
  if (value === undefined || value === null || value === "") return defaultValue;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function parseInteger(value, defaultValue, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return defaultValue;
  return Math.min(max, Math.max(min, parsed));
}

function parseList(value) {
  return new Set(
    String(value || "")
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean)
  );
}

function loadConfig(env = process.env, baseDir = path.join(__dirname, "..")) {
  const resolveFile = (value, defaultName) => path.resolve(baseDir, value || defaultName);
  return {
    serverUrl: env.SERVER_URL || "https://ws.epikchat.com",
    botToken: env.BOT_TOKEN || "",
    roomId: env.ROOM_ID || "",
    botName: env.BOT_NAME || "PHD Meowington",
    openaiApiKey: env.OPENAI_API_KEY || "",
    openaiModel: env.OPENAI_MODEL || "gpt-4o-mini",
    battlefieldApiUrl: env.BFSTATS_API_URL || "https://bfstats.nano11bravo.com",
    battlefieldTimeoutMs: parseInteger(env.BFSTATS_TIMEOUT_MS, 10000, { min: 1000, max: 60000 }),
    battlefieldCacheTtlMs: parseInteger(env.BFSTATS_CACHE_TTL_MS, 30000, { min: 0, max: 3600000 }),
    battlefieldWatchIntervalMs: parseInteger(env.BFSTATS_WATCH_INTERVAL_MS, 900000, { min: 60000, max: 86400000 }),
    ignoredSenderIds: parseList(env.IGNORED_SENDER_IDS || "6a3e570003a479abf0327353"),
    ignoredUsernames: parseList(env.IGNORED_USERNAMES || "nicknamepending"),
    minReplyLength: parseInteger(env.MIN_REPLY_LENGTH, 2, { min: 1, max: 100 }),
    commandCooldownMs: parseInteger(env.COMMAND_COOLDOWN_MS, 3000, { min: 0, max: 60000 }),
    triviaGuessCooldownMs: parseInteger(env.TRIVIA_GUESS_COOLDOWN_MS, 500, { min: 0, max: 10000 }),
    marblesCooldownMs: parseInteger(env.MARBLES_COOLDOWN_MS, 1000, { min: 0, max: 10000 }),
    battlefieldCooldownMs: parseInteger(env.BFSTATS_COOLDOWN_MS, 3000, { min: 0, max: 60000 }),
    socketAckTimeoutMs: parseInteger(env.SOCKET_ACK_TIMEOUT_MS, 10000, { min: 1000, max: 60000 }),
    persistDebounceMs: parseInteger(env.PERSIST_DEBOUNCE_MS, 100, { min: 0, max: 5000 }),
    messageMaxLength: parseInteger(env.MESSAGE_MAX_LENGTH, 250, { min: 50, max: 250 }),
    maxReplyLength: parseInteger(env.AI_MAX_REPLY_LENGTH || env.MAX_REPLY_LENGTH, 2000, { min: 250, max: 10000 }),
    continuationTtlMs: parseInteger(env.AI_CONTINUATION_TTL_MS, 600000, { min: 10000, max: 86400000 }),
    maxRecentReplies: parseInteger(env.MAX_RECENT_REPLIES, 5, { min: 1, max: 100 }),
    userHistoryLimit: parseInteger(env.USER_HISTORY_LIMIT, 10, { min: 0, max: 100 }),
    maxTrackedUsers: parseInteger(env.MAX_TRACKED_USERS, 500, { min: 1, max: 100000 }),
    memoryFile: resolveFile(env.MEMORY_FILE, "memory.json"),
    databaseFile: resolveFile(env.DATABASE_FILE, "bot-state.sqlite"),
    settingsFile: resolveFile(env.SETTINGS_FILE, "room-settings.json"),
    loyaltyFile: resolveFile(env.LOYALTY_FILE, "loyalty.json"),
    schedulesFile: resolveFile(env.SCHEDULES_FILE, "schedules.json"),
    rolesFile: resolveFile(env.ROLES_FILE, "roles.json"),
    auditFile: resolveFile(env.AUDIT_FILE, "audit.jsonl"),
    outboxFile: resolveFile(env.OUTBOX_FILE, "outbox.json"),
    submissionsFile: resolveFile(env.SUBMISSIONS_FILE, "question-submissions.json"),
    userPreferencesFile: resolveFile(env.USER_PREFERENCES_FILE, "user-preferences.json"),
    marblesSeasonsFile: resolveFile(env.MARBLES_SEASONS_FILE, "marbles-seasons.json"),
    backupDirectory: resolveFile(env.BACKUP_DIRECTORY, "backups"),
    backupEncryptionKey: env.BACKUP_ENCRYPTION_KEY || "",
    pluginsDirectory: resolveFile(env.PLUGINS_DIRECTORY, "plugins"),
    retentionDays: parseInteger(env.RETENTION_DAYS, 90, { min: 1, max: 3650 }),
    outboxMaxAttempts: parseInteger(env.OUTBOX_MAX_ATTEMPTS, 20, { min: 1, max: 100 }),
    operationsAlertsEnabled: parseBoolean(env.OPERATIONS_ALERTS_ENABLED, true),
    operationsCheckIntervalMs: parseInteger(env.OPERATIONS_CHECK_INTERVAL_MS, 300000, { min: 60000, max: 86400000 }),
    triviaStatsFile: resolveFile(env.TRIVIA_STATS_FILE, "trivia-stats.json"),
    logFile: resolveFile(env.LOG_FILE, "bot.log.jsonl"),
    logMaxBytes: parseInteger(env.LOG_MAX_BYTES, 5_000_000, { min: 10000, max: 100_000_000 }),
    logConsole: parseBoolean(env.LOG_CONSOLE, true),
    triviaFile: resolveFile(env.TRIVIA_FILE, "trivia.json"),
    triviaScoreFile: resolveFile(env.TRIVIA_SCORE_FILE, "trivia-scores.json"),
    triviaQuestionTimeMs: parseInteger(env.TRIVIA_QUESTION_TIME_MS, 30000, { min: 5000, max: 300000 }),
    triviaAttemptsPerUser: parseInteger(env.TRIVIA_ATTEMPTS_PER_USER, 3, { min: 1, max: 20 }),
    triviaScoreMode: String(env.TRIVIA_SCORE_MODE || "cumulative").trim().toLowerCase() === "session" ? "session" : "cumulative",
    triviaAdminControls: parseBoolean(env.TRIVIA_ADMIN_CONTROLS, true),
    marblesEnabled: parseBoolean(env.MARBLES_ENABLED, true),
    marblesFile: resolveFile(env.MARBLES_FILE, "marbles.csv"),
    marblesRegistrationOpen: parseBoolean(env.MARBLES_REGISTRATION_OPEN, true),
    marblesConfirmJoins: parseBoolean(env.MARBLES_CONFIRM_JOINS, true),
    marblesJoinCommands: env.MARBLES_JOIN_COMMANDS || "!play,!marbles",
    adminIds: parseList(env.MARBLES_ADMIN_IDS),
    adminUsernames: parseList(env.MARBLES_ADMIN_USERNAMES),
    moderationBlockedWords: [...parseList(env.MODERATION_BLOCKED_WORDS)],
    moderationFloodLimit: parseInteger(env.MODERATION_FLOOD_LIMIT, 6, { min: 2, max: 100 }),
    moderationFloodWindowMs: parseInteger(env.MODERATION_FLOOD_WINDOW_MS, 10000, { min: 1000, max: 60000 }),
    moderationRepeatLimit: parseInteger(env.MODERATION_REPEAT_LIMIT, 3, { min: 1, max: 20 }),
    dashboardEnabled: parseBoolean(env.DASHBOARD_ENABLED, false),
    dashboardHost: env.DASHBOARD_HOST || "127.0.0.1",
    dashboardPort: parseInteger(env.DASHBOARD_PORT, 8787, { min: 1, max: 65535 }),
    dashboardToken: env.DASHBOARD_TOKEN || "",
    dashboardUsername: env.DASHBOARD_USERNAME || "",
    dashboardPassword: env.DASHBOARD_PASSWORD || "",
    dashboardSessionTtlMs: parseInteger(env.DASHBOARD_SESSION_TTL_MS, 43200000, { min: 300000, max: 604800000 }),
    dashboardTlsKeyFile: env.DASHBOARD_TLS_KEY_FILE ? resolveFile(env.DASHBOARD_TLS_KEY_FILE, "") : null,
    dashboardTlsCertFile: env.DASHBOARD_TLS_CERT_FILE ? resolveFile(env.DASHBOARD_TLS_CERT_FILE, "") : null,
  };
}

module.exports = { loadConfig, parseBoolean, parseInteger, parseList };
