using System.Net;
using System.Net.Sockets;
using EpikChatBot.Core;
using EpikChatBot.Services;
using SocketIO.Core;
using SocketIO.Serializer.MessagePack;
using Xunit;

namespace EpikChatBot.Tests;

public sealed class CoreTests : IDisposable
{
  private readonly string _directory = Path.Combine(Path.GetTempPath(), $"epikchat-csharp-{Guid.NewGuid():N}");
  public CoreTests() => Directory.CreateDirectory(_directory);

  [Fact]
  public void CommandParser_ParsesCommandsAndPlainMessages()
  {
    Assert.Equal(new ParsedCommand(true, "trivia", "start science"), CommandParser.Parse(" .Trivia start science "));
    Assert.Equal(new ParsedCommand(true, "trivia", "start"), CommandParser.Parse("^trivia start"));
    Assert.Equal(new ParsedCommand(false, "", "hello"), CommandParser.Parse(" hello "));
  }

  [Fact]
  public void MessageSplitter_RespectsTransportLimit()
  {
    var chunks = MessageTools.Split(string.Join(' ', Enumerable.Repeat("detail", 100)), 250);
    Assert.True(chunks.Count > 1); Assert.All(chunks, chunk => Assert.InRange(chunk.Length, 1, 250));
  }

  [Fact]
  public void SocketPayload_UsesMessagePackMapForEmptyAndNestedObjects()
  {
    var empty = SocketPayload.Map(); var payload = SocketPayload.Map(("roomId", "room"), ("format", SocketPayload.Map(("color", "#fff"))));
    Assert.IsAssignableFrom<IDictionary<object, object>>(empty); Assert.Empty(empty); Assert.Equal("room", payload["roomId"]); Assert.IsAssignableFrom<IDictionary<object, object>>(payload["format"]);
  }

  [Fact]
  public void SocketPayload_DecodesNestedRoomAccessWithoutSerializerObjectConversion()
  {
    var payload = SocketPayload.Map(("rooms", new object[]
    {
            SocketPayload.Map(("roomId", "room-a"), ("canJoin", true)),
            SocketPayload.Map(("roomId", "room-b"), ("canJoin", false))
    }));

    var rooms = SocketPayload.ReadRoomAccess(payload);
    Assert.Equal(2, rooms.Count); Assert.Equal(("room-a", true), rooms[0]); Assert.Equal(("room-b", false), rooms[1]);
  }

  [Fact]
  public void SocketPayload_FindsMapInsideWrappedAcknowledgementArguments()
  {
    var expected = SocketPayload.Map(("id", "bot-id"));
    Assert.Same(expected, SocketPayload.FindMap(new object[] { null!, new object[] { expected } }));
    Assert.Equal("bot-id", SocketPayload.String(expected, "id"));
  }

  [Fact]
  public void SocketPayload_DecodesIncomingMessageAliasesAndNestedSender()
  {
    var payload = SocketPayload.Map(("roomId", "room"), ("message", ".ping"), ("sender", SocketPayload.Map(("id", "user"), ("name", "Alice"))));
    var message = SocketPayload.ReadMessage(payload);
    Assert.Equal("room", message.TargetId); Assert.Equal("user", message.SenderId); Assert.Equal("Alice", message.SenderName); Assert.Equal(".ping", message.Content);
  }

  [Fact]
  public void SocketPayload_RejectsNegativeAcknowledgements()
  {
    Assert.Null(SocketPayload.AckFailure(SocketPayload.Map(("success", true), ("status", 200))));
    Assert.Null(SocketPayload.AckFailure(SocketPayload.Map(("success", "1"), ("status", "ok"), ("ok", "unexpected"))));
    Assert.Equal("invalid color", SocketPayload.AckFailure(SocketPayload.Map(("success", false), ("status", 400), ("message", "invalid color"))));
    Assert.NotNull(SocketPayload.AckFailure(SocketPayload.Map(("success", 0))));
    Assert.Equal("explicit error", SocketPayload.AckFailure(SocketPayload.Map(("error", "explicit error"))));
  }

  [Fact]
  public void MessagePackSerializer_RoundTripsSocketEventWithPatchedRuntime()
  {
    var serializer = new SocketIOMessagePackSerializer();
    var serialized = serializer.Serialize(EngineIO.V4, "message", "/", [SocketPayload.Map(("roomId", "room"), ("content", ".ping"))]);
    var binary = Assert.Single(serialized, item => item.Binary is not null).Binary;
    var message = serializer.Deserialize(EngineIO.V4, binary);
    Assert.Equal("message", message.Event);
    Assert.Contains("roomId", serializer.MessageToJson(message));
  }

  [Theory]
  [InlineData("jupter", "jupiter", true)]
  [InlineData("the planet jupiter", "jupiter", false)]
  [InlineData("ju", "jupiter", false)]
  public void TriviaMatching_IsFuzzyWithoutAcceptingVagueFragments(string guess, string answer, bool expected)
  {
    Assert.Equal(expected, TriviaService.IsAnswerMatch(guess, new TriviaQuestion { Answer = answer }));
  }

  [Fact]
  public async Task Settings_PersistInNodeCompatibleShape()
  {
    var path = Path.Combine(_directory, "settings.json"); var settings = new SettingsStore(path); settings.Set("room", "ai.enabled", "false"); settings.Set("room", "commands.poll", "false"); await settings.FlushAsync();
    var reloaded = new SettingsStore(path); Assert.False(reloaded.Get("room").Ai.Enabled); Assert.False(reloaded.IsCommandEnabled("room", "poll")); Assert.Contains("\"rooms\"", await File.ReadAllTextAsync(path));
  }

  [Fact]
  public void Settings_RepairsAndRejectsUnsupportedReplyColors()
  {
    var path = Path.Combine(_directory, "settings-colors.json");
    File.WriteAllText(path, """{"rooms":{"room":{"reply":{"color":"#ff9900"}}}}""");
    var settings = new SettingsStore(path);
    Assert.Equal(SettingsStore.DefaultReplyColor, settings.Get("room").Reply.Color);
    Assert.Throws<ArgumentException>(() => settings.Set("room", "reply.color", "#ff9900"));
    Assert.Equal("#6fa8dc", settings.Set("room", "reply.color", "#6FA8DC").Reply.Color);
  }

  [Fact]
  public async Task Memory_UsesStableIdAndPersists()
  {
    var path = Path.Combine(_directory, "memory.json"); var memory = new MemoryStore(path); memory.RememberMessage("room", "user-1", "Alice", "favorite snack is tuna"); Assert.Contains("tuna", memory.GetContext("room", "user-1", "Alicia")[0]); await memory.FlushAsync();
    var reloaded = new MemoryStore(path); Assert.Contains("tuna", reloaded.GetContext("room", "user-1", "Ally")[0]);
  }

  [Fact]
  public async Task Loyalty_DailyIncludesQuestReward()
  {
    var loyalty = new LoyaltyService(Path.Combine(_directory, "loyalty.json")); Assert.True(loyalty.Daily("room", "user", "Alice").Ok); Assert.False(loyalty.Daily("room", "user", "Alice").Ok); Assert.Equal(15, loyalty.Get("room", "user", "Alice").Points); await loyalty.FlushAsync();
  }

  [Fact]
  public void Moderation_FiltersLinksWordsRepeatsAndMutes()
  {
    var moderation = new ModerationService(["forbidden"], 10, 10000, 2); Assert.Equal("link", moderation.Check("room", "user", "https://example.com", false).Reason); Assert.Equal("blocked-word", moderation.Check("room", "user", "forbidden phrase", true).Reason);
    Assert.True(moderation.Check("room", "user", "repeat", true).Allowed); Assert.True(moderation.Check("room", "user", "repeat", true).Allowed); Assert.Equal("repeat", moderation.Check("room", "user", "repeat", true).Reason); moderation.Mute("room", "user", 10000); Assert.Equal("muted", moderation.Check("room", "user", "hello", true).Reason);
  }

  [Fact]
  public async Task Marbles_TracksStableIdsAndWritesRoster()
  {
    var config = Config() with { MarblesFile = Path.Combine(_directory, "marbles.csv") }; var marbles = new MarblesBridge(config); Assert.True(marbles.HandleMessage("id", "Alice", "!play").Joined); Assert.True(marbles.HandleMessage("id", "Alicia", "!play").Duplicate); Assert.Equal(("admin", "open"), marbles.Parse(".marbles open")); Assert.Equal(("admin", "open"), marbles.Parse("^marbles open")); await marbles.FlushAsync(); Assert.Contains("Alicia", await File.ReadAllTextAsync(config.MarblesFile));
  }

  [Fact]
  public void SqliteRecords_RoundTrip()
  {
    using var database = new StateDatabase(Path.Combine(_directory, "state.sqlite")); database.Set("test", "key", new { answer = 42 }); Assert.Equal(42, database.Get("test", "key", new Dictionary<string, int>())["answer"]); Assert.True(database.Delete("test", "key"));
  }

  [Fact]
  public void CommunityServices_PersistIgnoresCasesEventsAndSeasons()
  {
    using var database = new StateDatabase(Path.Combine(_directory, "community.sqlite"));
    var ignores = new IgnoreService(database, [], []); ignores.Add("room", "name", "Troll", "mod"); Assert.True(ignores.IsIgnored("room", null, "troll"));
    var cases = new ModerationCaseService(database); var moderationCase = cases.Create("room", "user", "mod", "Moderator", "spam", "warning"); Assert.Equal("open", cases.Get(moderationCase.Id)!.Status); Assert.Equal("resolved", cases.Resolve(moderationCase.Id, "resolved")!.Status);
    var events = new EventService(database); var game = events.Create("room", "Friday Rush|2026-08-22 20:00"); events.Join(game.Id, "user", "Alice"); Assert.Single(events.Active("room")[0].Participants);
    var seasons = new MarblesSeasonService(database); seasons.Start("room", "Summer Cup"); seasons.Record("room", ["Alice", "Bob"]); Assert.Equal(("Alice", 10), seasons.Leaderboard("room")[0]);
  }

  [Fact]
  public async Task Backup_CreatesAndVerifiesZip()
  {
    var config = Config(); await File.WriteAllTextAsync(config.TriviaFile, "[]"); var backup = new BackupService(config, () => Task.CompletedTask); var name = await backup.CreateAsync(); Assert.True(backup.Verify(name) >= 1); Assert.Contains(name, backup.List());
  }

  [Fact]
  public async Task Dashboard_IsLoopbackOnlyAndRequiresBearerToken()
  {
    Assert.Equal("127.0.0.1", DashboardServer.LoopbackHost("0.0.0.0"));
    Assert.Equal("::1", DashboardServer.LoopbackHost("::1"));
    var port = FreeTcpPort();
    var token = new string('x', 32);
    var config = Config() with { DashboardEnabled = true, DashboardHost = "127.0.0.1", DashboardPort = port, DashboardToken = token };
    await using var dashboard = new DashboardServer(config, _ => Task.FromResult<object>(new { secret = "hidden" }), (_, _, _) => Task.FromResult<object>(new { ok = true }), (_, _) => Task.FromResult<object>(new { ok = true }));
    await dashboard.StartAsync(CancellationToken.None);
    using var client = new HttpClient { BaseAddress = new Uri($"http://127.0.0.1:{port}") };
    var health = await client.GetAsync("/health");
    Assert.Equal(HttpStatusCode.OK, health.StatusCode);
    Assert.DoesNotContain("hidden", await health.Content.ReadAsStringAsync());
    Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync("/api/status")).StatusCode);
    using var request = new HttpRequestMessage(HttpMethod.Get, "/api/status");
    request.Headers.Authorization = new("Bearer", token);
    var authorized = await client.SendAsync(request);
    Assert.Equal(HttpStatusCode.OK, authorized.StatusCode);
    Assert.True(authorized.Headers.Contains("X-Content-Type-Options"));
  }

  [Fact]
  public async Task Outbox_QueuesOfflineAndDeadLettersAfterBoundedAttempts()
  {
    var config = Config() with { OutboxMaxAttempts = 2, OutboxRetryBaseMs = 100, OutboxRetryMaxMs = 1000 };
    await using var bot = new BotHost(config);
    await bot.QueueRoomMessageForTestingAsync("room", "deliver later");
    var pending = Assert.Single(bot.PendingOutboxForTesting);
    bot.RecordOutboxFailure(pending, new IOException("test failure"));
    pending = Assert.Single(bot.PendingOutboxForTesting);
    Assert.Equal(1, pending.Attempts);
    bot.RecordOutboxFailure(pending, new IOException("test failure"));
    Assert.Empty(bot.PendingOutboxForTesting);
    Assert.Single(bot.DeadLetterOutboxForTesting);
  }

  [Fact]
  public async Task CommandCatalog_CoversHelpAliasesAndProfile()
  {
    Assert.Equal("continue", CommandCatalog.Normalize("more"));
    Assert.All(CommandCatalog.ViewerCommands, command => Assert.True(CommandCatalog.IsKnown(command)));
    Assert.All(CommandCatalog.PrivilegedCommands.Keys, command => Assert.True(CommandCatalog.IsKnown(command)));
    Assert.Equal(CommandCatalog.ViewerCommands.Count, CommandCatalog.ViewerCategories.Sum(category => category.Commands.Count));
    Assert.Contains("General: .help, .ping, .bot", CommandCatalog.HelpText);
    Assert.Contains("Games & Activities: .trivia", CommandCatalog.GetHelpText("games"));
    Assert.DoesNotContain("General:", CommandCatalog.GetHelpText("games"));
    Assert.Contains("Host: .question, .race", CommandCatalog.GetHelpText("staff"));
    Assert.Contains("Categories: general, ai, rewards, games, community, staff", CommandCatalog.GetHelpText("missing"));
    await using var bot = new BotHost(Config());
    Assert.Contains(".profile", await bot.ExecuteCommandForTestingAsync("room", "user", "Alice", "help"));
    Assert.Contains("Games & Activities: .trivia", await bot.ExecuteCommandForTestingAsync("room", "user", "Alice", "help", "games"));
    Assert.Contains("Alice", await bot.ExecuteCommandForTestingAsync("room", "user", "Alice", "profile"));
  }

  [Fact]
  public async Task CorruptJson_IsQuarantinedInsteadOfSilentlyOverwritten()
  {
    var path = Path.Combine(_directory, "corrupt-settings.json");
    await File.WriteAllTextAsync(path, "{not-json");
    _ = new SettingsStore(path);
    Assert.False(File.Exists(path));
    Assert.Single(Directory.GetFiles(_directory, "corrupt-settings.json.corrupt-*"));
  }

  private BotConfig Config() => BotConfig.Load(_directory) with { BaseDirectory = _directory, BotToken = "test", TriviaFile = Path.Combine(_directory, "trivia.json"), TriviaScoreFile = Path.Combine(_directory, "scores.json"), TriviaStatsFile = Path.Combine(_directory, "stats.json"), MemoryFile = Path.Combine(_directory, "memory.json"), SettingsFile = Path.Combine(_directory, "settings.json"), LoyaltyFile = Path.Combine(_directory, "loyalty.json"), RolesFile = Path.Combine(_directory, "roles.json"), DatabaseFile = Path.Combine(_directory, "state.sqlite"), MarblesFile = Path.Combine(_directory, "marbles.csv") };
  private static int FreeTcpPort() { var listener = new TcpListener(IPAddress.Loopback, 0); listener.Start(); var port = ((IPEndPoint)listener.LocalEndpoint).Port; listener.Stop(); return port; }
  public void Dispose() { try { Directory.Delete(_directory, true); } catch { } }
}
