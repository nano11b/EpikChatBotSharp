namespace EpikChatBot.Core;

public sealed record BotConfig
{
  public required string BaseDirectory { get; init; }
  public string ServerUrl { get; init; } = "https://ws.epikchat.com";
  public string BotToken { get; init; } = "";
  public string RoomId { get; init; } = "";
  public string BotName { get; init; } = "PHD Meowington";
  public string OpenAiApiKey { get; init; } = "";
  public string OpenAiModel { get; init; } = "gpt-4o-mini";
  public int OpenAiTimeoutMs { get; init; } = 30_000;
  public string BattlefieldApiUrl { get; init; } = "https://bfstats.nano11bravo.com";
  public int BattlefieldTimeoutMs { get; init; } = 10_000;
  public int BattlefieldCacheTtlMs { get; init; } = 30_000;
  public int CommandCooldownMs { get; init; } = 3_000;
  public int TriviaGuessCooldownMs { get; init; } = 500;
  public int MarblesCooldownMs { get; init; } = 1_000;
  public int BattlefieldCooldownMs { get; init; } = 3_000;
  public int SocketAckTimeoutMs { get; init; } = 10_000;
  public int OutboxMaxAttempts { get; init; } = 20;
  public int OutboxRetryBaseMs { get; init; } = 5_000;
  public int OutboxRetryMaxMs { get; init; } = 300_000;
  public int MessageMaxLength { get; init; } = 250;
  public int MaxReplyLength { get; init; } = 2_000;
  public int ContinuationTtlMs { get; init; } = 600_000;
  public int MinReplyLength { get; init; } = 2;
  public int UserHistoryLimit { get; init; } = 10;
  public int MaxTrackedUsers { get; init; } = 500;
  public int TriviaQuestionTimeMs { get; init; } = 30_000;
  public int TriviaAttemptsPerUser { get; init; } = 3;
  public bool TriviaAdminControls { get; init; } = true;
  public string TriviaScoreMode { get; init; } = "cumulative";
  public bool MarblesEnabled { get; init; } = true;
  public bool MarblesRegistrationOpen { get; init; } = true;
  public bool MarblesConfirmJoins { get; init; } = true;
  public string MarblesJoinCommands { get; init; } = "!play,!marbles";
  public bool DashboardEnabled { get; init; }
  public string DashboardHost { get; init; } = "127.0.0.1";
  public int DashboardPort { get; init; } = 8787;
  public string DashboardToken { get; init; } = "";
  public HashSet<string> AdminIds { get; init; } = [];
  public HashSet<string> AdminUsernames { get; init; } = [];
  public HashSet<string> IgnoredSenderIds { get; init; } = [];
  public HashSet<string> IgnoredUsernames { get; init; } = [];
  public List<string> ModerationBlockedWords { get; init; } = [];
  public int ModerationFloodLimit { get; init; } = 6;
  public int ModerationFloodWindowMs { get; init; } = 10_000;
  public int ModerationRepeatLimit { get; init; } = 3;
  public string DatabaseFile { get; init; } = "";
  public string MemoryFile { get; init; } = "";
  public string SettingsFile { get; init; } = "";
  public string LoyaltyFile { get; init; } = "";
  public string SchedulesFile { get; init; } = "";
  public string RolesFile { get; init; } = "";
  public string TriviaFile { get; init; } = "";
  public string TriviaScoreFile { get; init; } = "";
  public string TriviaStatsFile { get; init; } = "";
  public string MarblesFile { get; init; } = "";

  private static readonly string[] sourceArray = ["1", "true", "yes", "on"];

  public static BotConfig Load(string? baseDirectory = null)
  {
    var root = Path.GetFullPath(baseDirectory ?? Directory.GetCurrentDirectory());
    string Env(string key, string fallback = "") => Environment.GetEnvironmentVariable(key) ?? fallback;
    string FilePath(string key, string fallback) => Path.GetFullPath(Path.Combine(root, Env(key, fallback)));
    int Integer(string key, int fallback, int min = 0, int max = int.MaxValue) =>
        int.TryParse(Env(key), out var value) ? Math.Clamp(value, min, max) : fallback;
    bool Boolean(string key, bool fallback = false)
    {
      var value = Env(key);
      return value.Length == 0 ? fallback : sourceArray.Contains(value.Trim().ToLowerInvariant());
    }
    HashSet<string> List(string key, string fallback = "") => [.. Env(key, fallback).Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).Select(x => x.ToLowerInvariant())];

    return new BotConfig
    {
      BaseDirectory = root,
      ServerUrl = Env("SERVER_URL", "https://ws.epikchat.com"),
      BotToken = Env("BOT_TOKEN"),
      RoomId = Env("ROOM_ID"),
      BotName = Env("BOT_NAME", "PHD Meowington"),
      OpenAiApiKey = Env("OPENAI_API_KEY"),
      OpenAiModel = Env("OPENAI_MODEL", "gpt-4o-mini"),
      OpenAiTimeoutMs = Integer("OPENAI_TIMEOUT_MS", 30000, 1000, 120000),
      BattlefieldApiUrl = Env("BFSTATS_API_URL", "https://bfstats.nano11bravo.com"),
      BattlefieldTimeoutMs = Integer("BFSTATS_TIMEOUT_MS", 10000, 1000, 60000),
      BattlefieldCacheTtlMs = Integer("BFSTATS_CACHE_TTL_MS", 30000, 0, 3600000),
      CommandCooldownMs = Integer("COMMAND_COOLDOWN_MS", 3000, 0, 60000),
      TriviaGuessCooldownMs = Integer("TRIVIA_GUESS_COOLDOWN_MS", 500, 0, 10000),
      MarblesCooldownMs = Integer("MARBLES_COOLDOWN_MS", 1000, 0, 10000),
      BattlefieldCooldownMs = Integer("BFSTATS_COOLDOWN_MS", 3000, 0, 60000),
      SocketAckTimeoutMs = Integer("SOCKET_ACK_TIMEOUT_MS", 10000, 1000, 60000),
      OutboxMaxAttempts = Integer("OUTBOX_MAX_ATTEMPTS", 20, 1, 1000),
      OutboxRetryBaseMs = Integer("OUTBOX_RETRY_BASE_MS", 5000, 100, 3600000),
      OutboxRetryMaxMs = Integer("OUTBOX_RETRY_MAX_MS", 300000, 1000, 86400000),
      MessageMaxLength = Integer("MESSAGE_MAX_LENGTH", 250, 50, 250),
      MaxReplyLength = Integer("AI_MAX_REPLY_LENGTH", 2000, 250, 10000),
      ContinuationTtlMs = Integer("AI_CONTINUATION_TTL_MS", 600000, 10000, 86400000),
      MinReplyLength = Integer("MIN_REPLY_LENGTH", 2, 1, 100),
      UserHistoryLimit = Integer("USER_HISTORY_LIMIT", 10, 0, 100),
      MaxTrackedUsers = Integer("MAX_TRACKED_USERS", 500, 1, 100000),
      TriviaQuestionTimeMs = Integer("TRIVIA_QUESTION_TIME_MS", 30000, 5000, 300000),
      TriviaAttemptsPerUser = Integer("TRIVIA_ATTEMPTS_PER_USER", 3, 1, 20),
      TriviaAdminControls = Boolean("TRIVIA_ADMIN_CONTROLS", true),
      TriviaScoreMode = Env("TRIVIA_SCORE_MODE", "cumulative").Equals("session", StringComparison.InvariantCultureIgnoreCase) ? "session" : "cumulative",
      MarblesEnabled = Boolean("MARBLES_ENABLED", true),
      MarblesRegistrationOpen = Boolean("MARBLES_REGISTRATION_OPEN", true),
      MarblesConfirmJoins = Boolean("MARBLES_CONFIRM_JOINS", true),
      MarblesJoinCommands = Env("MARBLES_JOIN_COMMANDS", "!play,!marbles"),
      DashboardEnabled = Boolean("DASHBOARD_ENABLED"),
      DashboardHost = Env("DASHBOARD_HOST", "127.0.0.1"),
      DashboardPort = Integer("DASHBOARD_PORT", 8787, 0, 65535),
      DashboardToken = Env("DASHBOARD_TOKEN"),
      AdminIds = List("MARBLES_ADMIN_IDS"),
      AdminUsernames = List("MARBLES_ADMIN_USERNAMES"),
      IgnoredSenderIds = List("IGNORED_SENDER_IDS", "6a3e570003a479abf0327353"),
      IgnoredUsernames = List("IGNORED_USERNAMES", "nicknamepending"),
      ModerationBlockedWords = [.. List("MODERATION_BLOCKED_WORDS")],
      ModerationFloodLimit = Integer("MODERATION_FLOOD_LIMIT", 6, 2, 100),
      ModerationFloodWindowMs = Integer("MODERATION_FLOOD_WINDOW_MS", 10000, 1000, 60000),
      ModerationRepeatLimit = Integer("MODERATION_REPEAT_LIMIT", 3, 2, 20),
      DatabaseFile = FilePath("DATABASE_FILE", "bot-state.sqlite"),
      MemoryFile = FilePath("MEMORY_FILE", "memory.json"),
      SettingsFile = FilePath("SETTINGS_FILE", "room-settings.json"),
      LoyaltyFile = FilePath("LOYALTY_FILE", "loyalty.json"),
      SchedulesFile = FilePath("SCHEDULES_FILE", "schedules.json"),
      RolesFile = FilePath("ROLES_FILE", "roles.json"),
      TriviaFile = FilePath("TRIVIA_FILE", "trivia.json"),
      TriviaScoreFile = FilePath("TRIVIA_SCORE_FILE", "trivia-scores.json"),
      TriviaStatsFile = FilePath("TRIVIA_STATS_FILE", "trivia-stats.json"),
      MarblesFile = FilePath("MARBLES_FILE", "marbles.csv")
    };
  }
}
