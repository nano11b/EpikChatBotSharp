using System.Diagnostics;
using System.Text.Json;
using System.Threading.Channels;
using EpikChatBot.Services;
using MessagePack;
using SocketIO.Serializer.MessagePack;
using SocketIOClient;
using SocketIOClient.Transport;

namespace EpikChatBot.Core;

public sealed class BotHost : IAsyncDisposable
{
  private readonly BotConfig _config; private readonly SocketIOClient.SocketIO _socket; private readonly StateDatabase _database; private readonly SettingsStore _settings; private readonly AccessControl _access;
  private readonly MemoryStore _memory; private readonly LoyaltyService _loyalty; private readonly ModerationService _moderation; private readonly MarblesBridge _marbles; private readonly PollService _polls;
  private readonly TriviaService _trivia; private readonly OpenAiReplyService _replies; private readonly BattlefieldStatsService _battlefield; private readonly ContinuationService _continuations; private readonly RateLimiter _rateLimiter = new();
  private readonly IgnoreService _ignores; private readonly ModerationCaseService _cases; private readonly EventService _events; private readonly MarblesSeasonService _seasons; private readonly SchedulerService _scheduler; private readonly BackupService _backup;
  private readonly DashboardServer _dashboard; private readonly HashSet<string> _joinedRooms = []; private readonly Stopwatch _uptime = Stopwatch.StartNew();
  private readonly Channel<Func<Task>> _workQueue = Channel.CreateUnbounded<Func<Task>>(new UnboundedChannelOptions { SingleReader = true, SingleWriter = false });
  private readonly CancellationTokenSource _backgroundCancellation = new(); private readonly Task _workPump; private readonly Task _outboxPump;
  private string? _selfUserId; private volatile bool _ready; private bool _disposed;

  public BotHost(BotConfig config)
  {
    _config = config; if (string.IsNullOrWhiteSpace(config.BotToken)) throw new InvalidOperationException("BOT_TOKEN is required. Copy .env.example to .env and configure it.");
    _database = new(config.DatabaseFile); _settings = new(config.SettingsFile); _access = new(config.RolesFile, config.AdminIds, config.AdminUsernames); _memory = new(config.MemoryFile, config.UserHistoryLimit, config.MaxTrackedUsers);
    _loyalty = new(config.LoyaltyFile); _moderation = new(config.ModerationBlockedWords, config.ModerationFloodLimit, config.ModerationFloodWindowMs, config.ModerationRepeatLimit); _marbles = new(config); _continuations = new(config.MessageMaxLength, config.ContinuationTtlMs);
    _ignores = new(_database, config.IgnoredSenderIds, config.IgnoredUsernames); _cases = new(_database); _events = new(_database); _seasons = new(_database);
    _workPump = RunWorkQueueAsync(_backgroundCancellation.Token); _outboxPump = RunOutboxPumpAsync(_backgroundCancellation.Token);
    _polls = new(SendRoomMessageAsync, EnqueueAsync); _replies = new(config, _memory); _battlefield = new(config);
    _trivia = new(config, (room, id, name) => _access.Has(room, id, name, "host"), SendRoomMessageAsync, _settings.Get, (room, id, name, points) => _loyalty.Award(room, id, name, points, "trivia"), dispatch: EnqueueAsync);
    _scheduler = new(_database, ExecuteScheduledAsync, EnqueueAsync); _backup = new(config, FlushAsync);
    _socket = new SocketIOClient.SocketIO(config.ServerUrl, new SocketIOOptions { Path = "/chat/", Transport = TransportProtocol.WebSocket, ExtraHeaders = new Dictionary<string, string> { ["Authorization"] = $"Bot {config.BotToken}", ["User-Agent"] = "Meowington-CSharp/3.0" } })
    {
      Serializer = new SocketIOMessagePackSerializer()
    };
    _socket.OnConnected += async (_, _) => await EnqueueAsync(HandleConnectAsync);
    _socket.OnDisconnected += (_, reason) => QueueWork(() => { HandleDisconnect(reason); return Task.CompletedTask; });
    _socket.OnError += (_, error) => Console.Error.WriteLine($"[socket] {error}");
    _socket.On("message", response =>
    {
      try
      {
        var payload = SocketPayload.ReadMessage(ReadEventMap(response));
        var parsed = CommandParser.Parse(payload.Content);
        if (parsed.IsCommand) Console.WriteLine($"[command] room={payload.TargetId} sender={payload.SenderId ?? payload.SenderName ?? "unknown"} name={parsed.Command}");
        QueueWork(() => HandleMessageSafeAsync(payload));
      }
      catch (Exception exception) { Console.Error.WriteLine($"[receive decode error] {exception.Message}; payload={SafeResponseText(response)}"); }
    });
    _socket.On("userJoined", response =>
    {
      try { var payload = SocketPayload.ReadUserJoined(ReadEventMap(response)); QueueWork(() => HandleUserJoinedAsync(payload)); }
      catch (Exception exception) { Console.Error.WriteLine($"[userJoined decode error] {exception.Message}; payload={SafeResponseText(response)}"); }
    });
    _dashboard = new(
        config,
        room => EnqueueAsync(() => Task.FromResult(GetStatus(room))),
        (room, path, value) => EnqueueAsync(() => Task.FromResult<object>(new { ok = true, settings = _settings.Set(room, path, value) })),
        (room, action) => EnqueueAsync(() => RunDashboardActionAsync(room, action)));
  }

  public async Task StartAsync(CancellationToken cancellationToken = default)
  {
    await _dashboard.StartAsync(cancellationToken); Console.WriteLine($"[startup] Connecting to {_config.ServerUrl}");
    var connecting = _socket.ConnectAsync(); var cancelled = Task.Delay(Timeout.Infinite, cancellationToken); if (await Task.WhenAny(connecting, cancelled) == cancelled) { try { await _socket.DisconnectAsync(); } catch { } return; }
    await connecting;
  }

  private bool QueueWork(Func<Task> action)
  {
    if (_workQueue.Writer.TryWrite(action)) return true;
    if (!_disposed) Console.Error.WriteLine("[queue] Unable to enqueue bot work.");
    return false;
  }
  private Task EnqueueAsync(Func<Task> action)
  {
    var completion = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
    if (!QueueWork(async () => { try { await action(); completion.TrySetResult(); } catch (Exception exception) { completion.TrySetException(exception); } })) completion.TrySetException(new ObjectDisposedException(nameof(BotHost)));
    return completion.Task;
  }
  private Task<T> EnqueueAsync<T>(Func<Task<T>> action)
  {
    var completion = new TaskCompletionSource<T>(TaskCreationOptions.RunContinuationsAsynchronously);
    if (!QueueWork(async () => { try { completion.TrySetResult(await action()); } catch (Exception exception) { completion.TrySetException(exception); } })) completion.TrySetException(new ObjectDisposedException(nameof(BotHost)));
    return completion.Task;
  }
  private async Task RunWorkQueueAsync(CancellationToken cancellationToken)
  {
    try
    {
      await foreach (var action in _workQueue.Reader.ReadAllAsync(cancellationToken))
      {
        try { await action(); } catch (Exception exception) { Console.Error.WriteLine($"[queue] {exception}"); }
      }
    }
    catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { }
  }
  private async Task RunOutboxPumpAsync(CancellationToken cancellationToken)
  {
    using var timer = new PeriodicTimer(TimeSpan.FromSeconds(5));
    try { while (await timer.WaitForNextTickAsync(cancellationToken)) await EnqueueAsync(DrainOutboxAsync); }
    catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { }
  }

  private async Task<T> EmitAckAsync<T>(string eventName, object payload)
  {
    var completion = new TaskCompletionSource<T>(TaskCreationOptions.RunContinuationsAsynchronously);
    await _socket.EmitAsync(eventName, response => { try { completion.TrySetResult(response.GetValue<T>()); } catch (Exception exception) { completion.TrySetException(exception); } }, payload);
    return await completion.Task.WaitAsync(TimeSpan.FromMilliseconds(_config.SocketAckTimeoutMs));
  }
  private async Task<IDictionary<object, object>> EmitMapAckAsync(string eventName, object payload)
  {
    var completion = new TaskCompletionSource<IDictionary<object, object>>(TaskCreationOptions.RunContinuationsAsynchronously);
    await _socket.EmitAsync(eventName, response =>
    {
      try { completion.TrySetResult(response.GetValue<Dictionary<object, object>>()); }
      catch (InvalidCastException)
      {
        try { completion.TrySetResult(SocketPayload.FindMap(response.GetValue<object[]>()) ?? throw new InvalidDataException($"{eventName} acknowledgement did not contain a map.")); }
        catch (Exception exception) { completion.TrySetException(exception); }
      }
      catch (Exception exception) { completion.TrySetException(exception); }
    }, payload);
    return await completion.Task.WaitAsync(TimeSpan.FromMilliseconds(_config.SocketAckTimeoutMs));
  }
  private static IDictionary<object, object> ReadEventMap(SocketIOResponse response)
  {
    try { return response.GetValue<Dictionary<object, object>>(); }
    catch (InvalidCastException) { return SocketPayload.FindMap(response.GetValue<object[]>()) ?? throw new InvalidDataException("Event did not contain a MessagePack map."); }
  }
  private static string SafeResponseText(SocketIOResponse response) { try { return response.ToString(); } catch { return "<unavailable>"; } }
  private async Task HandleConnectAsync()
  {
    _ready = false; _joinedRooms.Clear();
    try
    {
      _selfUserId = SocketPayload.String(await EmitMapAckAsync("whoami", SocketPayload.Map()), "id");
      var accessPayload = await EmitMapAckAsync("getBotAccess", SocketPayload.Map());
      foreach (var (RoomId, CanJoin) in SocketPayload.ReadRoomAccess(accessPayload).Where(x => x.CanJoin)) { try { var joined = await EmitMapAckAsync("joinRoom", SocketPayload.Map(("roomId", RoomId))); if (SocketPayload.String(joined, "error") is null) _joinedRooms.Add(RoomId); } catch (Exception exception) { Console.Error.WriteLine($"[joinRoom] {RoomId}: {exception.Message}"); } }
      _ready = _joinedRooms.Count > 0; Console.WriteLine(_ready ? $"[connect] Joined {string.Join(", ", _joinedRooms)}" : "[connect] Could not join any rooms."); if (_ready) await DrainOutboxAsync();
    }
    catch (Exception exception) { Console.Error.WriteLine($"[connect error] {exception.Message}"); }
  }
  private void HandleDisconnect(string reason) { _ready = false; _joinedRooms.Clear(); _trivia.StopAll(); _polls.StopAll(); _rateLimiter.Clear(); Console.WriteLine($"[disconnect] {reason}"); }
  private async Task SendRoomMessageAsync(string room, string message)
  {
    foreach (var chunk in MessageTools.Split(message, _config.MessageMaxLength))
    {
      var item = new OutboxItem(Guid.NewGuid().ToString("N"), room, chunk);
      _database.Set("outbox", item.Id, item);
      if (_ready && _joinedRooms.Contains(room)) await TrySendOutboxItemAsync(item);
    }
  }
  private async Task SendOutboxItemAsync(OutboxItem item)
  {
    var ack = await EmitMapAckAsync("userMessage", SocketPayload.Map(("targetId", item.RoomId), ("targetType", "room"), ("messageType", "text"), ("content", item.Message), ("format", SocketPayload.Map(("color", _settings.Get(item.RoomId).Reply.Color))), ("clientMessageId", item.Id)));
    if (SocketPayload.AckFailure(ack) is { } error) throw new InvalidOperationException($"userMessage failed: {error}");
    _database.Delete("outbox", item.Id);
    Console.WriteLine($"[send] room={item.RoomId} message={item.Id} length={item.Message.Length}");
  }
  private async Task<bool> TrySendOutboxItemAsync(OutboxItem item)
  {
    try { await SendOutboxItemAsync(item); return true; }
    catch (Exception exception) { RecordOutboxFailure(item, exception); return false; }
  }
  internal void RecordOutboxFailure(OutboxItem item, Exception exception)
  {
    var attempts = item.Attempts + 1; var error = exception.Message.Length > 500 ? exception.Message[..500] : exception.Message;
    if (attempts >= _config.OutboxMaxAttempts)
    {
      var dead = item with { Attempts = attempts, LastError = error, NextAttemptAt = 0 }; _database.Set("outbox-dead-letter", item.Id, dead); _database.Delete("outbox", item.Id);
      Console.Error.WriteLine($"[outbox] Moved {item.Id} to dead-letter storage after {attempts} attempts: {error}"); return;
    }
    var exponent = Math.Min(attempts - 1, 20); var delay = Math.Min((long)_config.OutboxRetryMaxMs, (long)_config.OutboxRetryBaseMs * (1L << exponent));
    _database.Set("outbox", item.Id, item with { Attempts = attempts, LastError = error, NextAttemptAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + delay });
    Console.Error.WriteLine($"[outbox] Delivery attempt {attempts} failed; retrying in {delay}ms: {error}");
  }
  private async Task DrainOutboxAsync()
  {
    if (!_ready) return; var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    foreach (var (_, item, _) in _database.List<OutboxItem>("outbox").Where(x => _joinedRooms.Contains(x.Value.RoomId) && x.Value.NextAttemptAt <= now)) await TrySendOutboxItemAsync(item);
  }
  private async Task RetryOutboxAsync()
  {
    foreach (var (_, item, _) in _database.List<OutboxItem>("outbox")) _database.Set("outbox", item.Id, item with { NextAttemptAt = 0 });
    await DrainOutboxAsync();
  }
  internal Task QueueRoomMessageForTestingAsync(string room, string message) => SendRoomMessageAsync(room, message);
  internal IReadOnlyList<OutboxItem> PendingOutboxForTesting => [.. _database.List<OutboxItem>("outbox").Select(x => x.Value)];
  internal IReadOnlyList<OutboxItem> DeadLetterOutboxForTesting => [.. _database.List<OutboxItem>("outbox-dead-letter").Select(x => x.Value)];
  private async Task HandleMessageSafeAsync(MessagePayload payload) { try { await HandleMessageAsync(payload); } catch (Exception exception) { Console.Error.WriteLine($"[message] {exception}"); } }
  public async Task HandleMessageAsync(MessagePayload payload)
  {
    var room = payload.TargetId; var id = payload.SenderId; var name = payload.SenderName; var content = payload.Content;
    if (!_ready || !_joinedRooms.Contains(room) || string.IsNullOrWhiteSpace(content) || id == _selfUserId || _ignores.IsIgnored(room, id, name)) return;
    var settings = _settings.Get(room); if (settings.Moderation.Enabled && !_access.Has(room, id, name, "moderator") && !_moderation.Check(room, id, content, settings.Moderation.LinksAllowed).Allowed) return;
    var marble = _marbles.Parse(content); if (marble is not null)
    {
      if (!_settings.IsFeatureEnabled(room, "marbles") || !_rateLimiter.Consume($"marbles:{room}:{id ?? name}", _config.MarblesCooldownMs)) return;
      var result = marble.Value.Type == "admin" ? (_access.Has(room, id, name, "host") ? _marbles.HandleAdmin(marble.Value.Command) : new MarbleResult(true, "⛔ That Marbles control is streamer/admin only.")) : _marbles.HandleMessage(id, name, content);
      if (result.Joined) _loyalty.Award(room, id, name, 2, "marbles"); if (result.Reply is not null) await SendRoomMessageAsync(room, result.Reply); return;
    }
    var parsed = CommandParser.Parse(content); if (content.Trim().Length < _config.MinReplyLength || (!parsed.IsCommand && !settings.Ai.RespondToAll)) return;
    var cooldown = parsed.Command == "answer" ? _config.TriviaGuessCooldownMs : parsed.Command is "bf" or "bf6" or "battlefield" ? _config.BattlefieldCooldownMs : _config.CommandCooldownMs;
    if (!_rateLimiter.Consume($"{parsed.Command}:{room}:{id ?? name}", cooldown) || (parsed.IsCommand && !_settings.IsCommandEnabled(room, parsed.Command))) return;
    var resultMessage = await ExecuteCommandAsync(room, id, name, parsed, settings);
    if (resultMessage is not null) await SendRoomMessageAsync(room, resultMessage);
  }

  private async Task<string?> ExecuteCommandAsync(string room, string? id, string? name, ParsedCommand parsed, RoomSettings settings)
  {
    var command = CommandCatalog.Normalize(parsed.Command);
    if (command is "trivia" or "answer") { if (!_settings.IsFeatureEnabled(room, "trivia")) return "This feature is disabled in this room."; var result = _trivia.Handle(room, id, name, command, parsed.Text); if (result.AdvanceTrivia) await _trivia.AdvanceAsync(room); return result.Reply; }
    switch (command)
    {
      case "help": return CommandCatalog.GetHelpText(parsed.Text);
      case "ping": var timer = Stopwatch.StartNew(); try { await EmitMapAckAsync("whoami", SocketPayload.Map()); return $"EpikChat pong: {timer.Elapsed.TotalMilliseconds:F1}ms."; } catch { return "EpikChat ping failed: the server did not acknowledge the request."; }
      case "bot": return $"Bot: {(_ready ? "online" : "offline")}, {_joinedRooms.Count} room(s), trivia {(_trivia.GetState(room).Active ? "running" : "stopped")}, uptime {(int)_uptime.Elapsed.TotalMinutes}m.";
      case "continue": return _continuations.Next(room, id, name);
      case "profile": return ProfileReply(room, id, name);
      case "points": return PointsReply(room, id, name);
      case "progress": var (User, Level, Title, NextLevelAt) = _loyalty.Progress(room, id, name); return $"{User.Name}: level {Level} {Title}. {User.Points}/{NextLevelAt} points toward level {Level + 1}.";
      case "quests": return $"Daily quests: {string.Join(" • ", _loyalty.Quests(room, id, name).Select(x => $"{(x.Completed ? "✓" : $"{x.Progress}/{x.Target}")} {x.Label} (+{x.Reward})"))}";
      case "daily": return _loyalty.Daily(room, id, name).Ok ? $"Daily bonus claimed! {PointsReply(room, id, name)}" : "You already claimed today's bonus.";
      case "leaderboard": var leaders = _loyalty.Leaderboard(room); return leaders.Count > 0 ? $"Points: {string.Join(" • ", leaders.Select((x, i) => $"{i + 1}) {x.Name} {x.Points}"))}" : "No loyalty points yet.";
      case "memory": return MemoryCommand(room, id, name, parsed.Text);
      case "vote": var (Ok, Reason, Option) = _polls.Vote(room, id ?? name ?? "unknown", parsed.Text); return Ok ? $"Vote recorded for {Option!.Label}." : Reason == "no-poll" ? "There is no active poll." : "Invalid poll choice.";
      case "poll": return await PollCommandAsync(room, id, name, parsed.Text);
      case "bf": return await BattlefieldCommandAsync(room, id, name, parsed.Text);
      case "config": return ConfigCommand(room, id, name, parsed.Text);
      case "question": return await QuestionCommandAsync(room, id, name, parsed.Text);
      case "mod": return ModCommand(room, id, name, parsed.Text);
      case "role": return RoleCommand(room, id, name, parsed.Text);
      case "ignore": return IgnoreCommand(room, id, name, parsed.Text);
      case "warn": return WarnCommand(room, id, name, parsed.Text);
      case "case": return CaseCommand(room, id, name, parsed.Text);
      case "appeal": var appeal = _cases.Appeal(room, id ?? "", parsed.Text); return appeal is null ? "You have no open moderation case to appeal." : $"Appeal added to {appeal.Id}.";
      case "event": return EventCommand(room, id, name, parsed.Text);
      case "season": return SeasonCommand(room, id, name, parsed.Text);
      case "race": return RaceCommand(room, id, name, parsed.Text);
      case "schedule": return ScheduleCommand(room, id, name, parsed.Text);
      case "backup": return await BackupCommandAsync(room, id, name, parsed.Text);
      case "outbox": if (!_access.Has(room, id, name, "owner")) return "This command requires the owner role."; if (parsed.Text.Trim() == "retry") await RetryOutboxAsync(); return $"Outbox: {_database.List<OutboxItem>("outbox").Count} pending, {_database.List<OutboxItem>("outbox-dead-letter").Count} dead-lettered.";
      case "metrics": return _access.Has(room, id, name, "moderator") ? JsonSerializer.Serialize(new { uptimeSeconds = (long)_uptime.Elapsed.TotalSeconds, joinedRooms = _joinedRooms.Count, memoryUsers = _memory.Users.Count, scheduled = _scheduler.List(room).Count, outbox = _database.List<OutboxItem>("outbox").Count }) : "This command requires the moderator role.";
      case "echo": case "pet": case "status": case "treat": var (Text, _) = await _replies.GenerateAsync(room, id, name, command, command, settings); return Text;
      case "ask": break;
    }
    _memory.RememberMessage(room, id, name, parsed.IsCommand ? parsed.Text : parsed.Text); _memory.RememberPreference(room, id, name, parsed.Text); if (!_settings.IsFeatureEnabled(room, "ai")) return null;
    var generated = await _replies.GenerateAsync(room, id, name, parsed.Text, parsed.IsCommand ? parsed.Command : null, settings); return generated.Ai ? _continuations.Start(room, id, name, generated.Text) : generated.Text;
  }
  internal Task<string?> ExecuteCommandForTestingAsync(string room, string? id, string? name, string command, string text = "") => ExecuteCommandAsync(room, id, name, new ParsedCommand(true, command, text), _settings.Get(room));

  private string PointsReply(string room, string? id, string? name)
  {
    var (User, Level, Title, _) = _loyalty.Progress(room, id, name); return $"{User.Name}: level {Level} {Title}, {User.Points} points, {User.TriviaWins} trivia wins.{(User.Achievements.Count > 0 ? $" Achievements: {string.Join(", ", User.Achievements)}." : "")}";
  }
  private string ProfileReply(string room, string? id, string? name)
  {
    var (User, Level, Title, _) = _loyalty.Progress(room, id, name); var memory = _memory.Show(room, id, name); return $"{User.Name}: level {Level} {Title}, {User.Points} points, {User.TriviaWins} trivia wins, {User.Achievements.Count} achievement(s), memory {((memory?.Enabled ?? true) ? "on" : "off")}.";
  }
  private string MemoryCommand(string room, string? id, string? name, string text) { switch (text.Trim().ToLowerInvariant()) { case "off": _memory.SetEnabled(room, id, name, false); return "Memory is off for you in this room."; case "on": _memory.SetEnabled(room, id, name, true); return "Memory is on for you in this room."; case "forget": _memory.Forget(room, id, name); return "I forgot your saved history and preferences in this room."; case "export": return JsonSerializer.Serialize(_memory.ExportUser(room, id, name)); default: var data = _memory.Show(room, id, name); return data is null ? "I do not have saved memory for you in this room." : $"I remember {data.History.Count} recent message(s) and {data.Preferences.Count} preference(s). Memory is {(_memory.IsEnabled(room, id, name) ? "on" : "off")}."; } }
  private async Task<string> PollCommandAsync(string room, string? id, string? name, string text) { if (!_access.Has(room, id, name, "moderator")) return "This command requires the moderator role."; var split = text.Split(' ', 2, StringSplitOptions.RemoveEmptyEntries); var action = split.ElementAtOrDefault(0)?.ToLowerInvariant(); if (action == "close") return await _polls.CloseAsync(room) is null ? "There is no active poll." : "Poll closed."; if (action == "status") return _polls.Polls.TryGetValue(room, out var current) ? _polls.Format(current) : "There is no active poll."; if (action == "create") { var parts = (split.ElementAtOrDefault(1) ?? "").Split('|', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).ToList(); var duration = parts.Count > 0 && int.TryParse(parts[^1], out var seconds) ? seconds * 1000 : 60000; if (int.TryParse(parts.ElementAtOrDefault(parts.Count - 1), out _)) parts.RemoveAt(parts.Count - 1); if (parts.Count < 3) return "Use: .poll create Question|Option 1|Option 2|60"; return $"Poll opened: {_polls.Format(_polls.Create(room, parts[0], parts.Skip(1), duration))}"; } return "Poll commands: create, status, close."; }
  private async Task<string> BattlefieldCommandAsync(string room, string? id, string? name, string text) { var parts = text.Split(' ', StringSplitOptions.RemoveEmptyEntries); try { if (parts.FirstOrDefault()?.ToLowerInvariant() == "set") { var ea = BattlefieldStatsService.Validate(parts.ElementAtOrDefault(1) ?? ""); _database.Set("battlefield-links", $"{room}:{id}", ea); return $"Saved Battlefield EA ID {ea}."; } if (parts.FirstOrDefault()?.ToLowerInvariant() == "unlink") { _database.Delete("battlefield-links", $"{room}:{id}"); return "Battlefield account unlinked."; } var eaId = parts.FirstOrDefault()?.ToLowerInvariant() is "stats" or "badges" ? parts.ElementAtOrDefault(1) : parts.FirstOrDefault(); eaId ??= _database.Get("battlefield-links", $"{room}:{id}", ""); if (eaId.Length == 0) return "Use .bf set <EA-ID> first, or .bf <EA-ID>."; return parts.FirstOrDefault()?.ToLowerInvariant() == "badges" ? await _battlefield.BadgesAsync(eaId) : await _battlefield.StatsAsync(eaId); } catch (Exception exception) { return $"Battlefield stats unavailable: {exception.Message}"; } }
  private string ConfigCommand(string room, string? id, string? name, string text) { if (!_access.Has(room, id, name, "owner")) return "This command requires the owner role."; var parts = text.Split(' ', 3, StringSplitOptions.RemoveEmptyEntries); if (parts.Length == 0 || parts[0] == "show") return JsonSerializer.Serialize(_settings.Get(room)); if (parts[0] == "reset") { _settings.Reset(room); return "Room settings reset."; } if (parts.Length == 3 && parts[0] == "set") { _settings.Set(room, parts[1], parts[2]); return $"Updated {parts[1]}."; } return "Use: .config set ai.enabled false (or .config show / reset)."; }
  private async Task<string> QuestionCommandAsync(string room, string? id, string? name, string text) { if (!_access.Has(room, id, name, "host")) return "This command requires the host role."; var parts = text.Split(' ', 2, StringSplitOptions.RemoveEmptyEntries); var action = parts.ElementAtOrDefault(0); var arg = parts.ElementAtOrDefault(1) ?? ""; if (action == "list") return string.Join(" • ", _trivia.Questions.Take(5).Select((x, i) => $"{i + 1}) [{(x.Enabled ? "on" : "off")}] {x.Question} → {x.Answer}")); if (action == "add") return $"Added: {(await _trivia.AddQuestionAsync(arg)).Question}"; if (action == "remove" && int.TryParse(arg, out var remove)) return await _trivia.RemoveQuestionAsync(remove) is { } removed ? $"Removed: {removed.Question}" : "Question not found."; if ((action == "enable" || action == "disable") && int.TryParse(arg, out var change)) return await _trivia.SetEnabledAsync(change, action == "enable") is { } changed ? $"{action}d: {changed.Question}" : "Question not found."; return "Question commands: list, add, remove, enable, disable."; }
  private string ModCommand(string room, string? id, string? name, string text) { if (!_access.Has(room, id, name, "moderator")) return "This command requires the moderator role."; var parts = text.Split(' ', StringSplitOptions.RemoveEmptyEntries); if (parts.Length >= 2 && parts[0] == "mute") { var minutes = parts.Length > 2 && int.TryParse(parts[2], out var value) ? value : 5; _moderation.Mute(room, parts[1], minutes * 60000); return $"{parts[1]} muted for {minutes} minute(s)."; } if (parts.Length >= 2 && parts[0] == "unmute") { _moderation.Unmute(room, parts[1]); return $"{parts[1]} unmuted."; } return "Use: .mod mute <userId> [minutes] or .mod unmute <userId>."; }
  private string RoleCommand(string room, string? id, string? name, string text) { if (!_access.Has(room, id, name, "owner")) return "This command requires the owner role."; var parts = text.Split(' ', StringSplitOptions.RemoveEmptyEntries); if (parts.Length == 0 || parts[0] == "list") { var list = _access.List(room).ToList(); return list.Count > 0 ? string.Join(" • ", list.Select(x => $"{x.Identity}={x.Role}")) : "No delegated roles."; } if (parts.Length == 3 && parts[0] == "grant") { var (Identity, Role) = _access.Grant(room, parts[1], parts[2]); return $"Granted {Role} to {Identity}."; } if (parts.Length == 2 && parts[0] == "revoke") return _access.Revoke(room, parts[1]) ? "Role revoked." : "Role not found."; return "Use: .role grant <user-id> <host|moderator|owner>, .role revoke <user-id>, or .role list."; }
  private string IgnoreCommand(string room, string? id, string? name, string text) { if (!_access.Has(room, id, name, "moderator")) return "This command requires the moderator role."; var parts = text.Split(' ', 3, StringSplitOptions.RemoveEmptyEntries); var action = parts.ElementAtOrDefault(0) ?? "list"; if (action == "list") { var list = _ignores.List(room); return list.Count > 0 ? $"Ignored: {string.Join(" • ", list.Select(x => $"{x.Type}:{x.Value}"))}" : "No ignored users."; } if (parts.Length < 3) return "Use: .ignore add|remove|status <id|name> <value>, or .ignore list."; if (action == "add") { var rule = _ignores.Add(room, parts[1], parts[2], id); return $"Ignoring {rule.Type}:{rule.Value} in this room."; } if (action == "remove") return _ignores.Remove(room, parts[1], parts[2]) ? "Ignore removed." : "Ignore rule not found."; if (action == "status") return $"{parts[1]}:{parts[2]} is {(_ignores.Status(room, parts[1], parts[2]) ? "ignored" : "not ignored")}."; return "Unknown ignore action."; }
  private string WarnCommand(string room, string? id, string? name, string text) { if (!_access.Has(room, id, name, "moderator")) return "This command requires the moderator role."; var parts = text.Split(' ', 2, StringSplitOptions.RemoveEmptyEntries); if (parts.Length < 2) return "Use: .warn <user-id> <reason>."; var item = _cases.Create(room, parts[0], id, name, parts[1], "warning"); return $"Warning recorded as {item.Id} for {parts[0]}."; }
  private string CaseCommand(string room, string? id, string? name, string text) { if (!_access.Has(room, id, name, "moderator")) return "This command requires the moderator role."; var parts = text.Split(' ', 3, StringSplitOptions.RemoveEmptyEntries); var action = parts.ElementAtOrDefault(0) ?? "list"; if (action == "list") { var list = _cases.List(room, parts.ElementAtOrDefault(1)); return list.Count > 0 ? string.Join(" • ", list.Select(x => $"{x.Id} {x.UserId} [{x.Status}] {x.Reason}")) : "No moderation cases."; } if (parts.Length < 2) return "Use: .case list|show|note|resolve."; var item = _cases.Get(parts[1]); if (action == "show") return item is null ? "Case not found." : $"{item.Id}: {item.UserId}, {item.Action}, {item.Status}, {item.Reason}{(item.Appeal is null ? "" : $"; appeal: {item.Appeal}")}"; if (action == "note") return _cases.Note(parts[1], id, parts.ElementAtOrDefault(2) ?? "") is null ? "Case not found." : "Case note added."; if (action == "resolve") return _cases.Resolve(parts[1], parts.ElementAtOrDefault(2) ?? "resolved") is { } resolved ? $"Case marked {resolved.Status}." : "Case not found."; return "Unknown case action."; }
  private string EventCommand(string room, string? id, string? name, string text) { var parts = text.Split(' ', 3, StringSplitOptions.RemoveEmptyEntries); var action = parts.ElementAtOrDefault(0) ?? "list"; if (action == "list") { var list = _events.Active(room); return list.Count > 0 ? string.Join(" • ", list.Select(x => $"{x.Id}: {x.Title} ({x.Participants.Count} joined)")) : "No open community events."; } if (action == "create") { if (!_access.Has(room, id, name, "host")) return "Creating events requires the host role."; var separator = text.IndexOf(' '); if (separator < 0 || string.IsNullOrWhiteSpace(text[(separator + 1)..])) return "Use: .event create Title|2026-08-22 20:00"; var item = _events.Create(room, text[(separator + 1)..]); return $"Created {item.Id}: {item.Title}. Join with .event join {item.Id}."; } if (parts.Length < 2) return "Use: .event create|list|join|leave|teams|close."; if (action == "join") { var item = _events.Join(parts[1], id ?? name ?? "", name ?? id ?? "friend"); if (item is not null) _loyalty.Award(room, id, name, 3, "event"); return item is null ? "Event not found or closed." : $"Joined {item.Title}."; } if (action == "leave") return _events.Leave(parts[1], id ?? "") is { } left ? $"Left {left.Title}." : "Event not found."; if (action == "teams") { if (!_access.Has(room, id, name, "host")) return "Team generation requires the host role."; var teams = _events.Teams(parts[1]); return teams is null ? "Event not found." : $"Team A: {string.Join(", ", teams.Value.A)} | Team B: {string.Join(", ", teams.Value.B)}"; } if (action == "close") { if (!_access.Has(room, id, name, "host")) return "Closing events requires the host role."; return _events.Close(parts[1]) is { } closed ? $"Closed {closed.Title}." : "Event not found."; } return "Unknown event action."; }
  private string SeasonCommand(string room, string? id, string? name, string text) { var parts = text.Split(' ', 2, StringSplitOptions.RemoveEmptyEntries); var action = parts.ElementAtOrDefault(0) ?? "status"; if (action is "status" or "leaderboard") { var season = _seasons.Get(room); var leaders = _seasons.Leaderboard(room); return season is null ? "No Marbles season." : $"{season.Name} ({(season.Active ? "active" : "ended")}, {season.Races.Count} races): {string.Join(" • ", leaders.Select((x, i) => $"{i + 1}) {x.Name} {x.Points}"))}"; } if (!_access.Has(room, id, name, "host")) return "Season controls require the host role."; if (action == "start") return $"Started {_seasons.Start(room, parts.ElementAtOrDefault(1)).Name}."; if (action == "end") return _seasons.End(room) is { } ended ? $"Ended {ended.Name}." : "No active season."; return "Use: .season start [name]|status|leaderboard|end."; }
  private string RaceCommand(string room, string? id, string? name, string text) { if (!_access.Has(room, id, name, "host")) return "This command requires the host role."; if (!text.StartsWith("result ", StringComparison.OrdinalIgnoreCase)) return "Use: .race result Winner|Second|Third."; var finishers = _seasons.Record(room, text[7..].Split('|')); return $"Race {_seasons.Get(room)!.Races.Count} recorded: {string.Join(" → ", finishers)}."; }
  private string ScheduleCommand(string room, string? id, string? name, string text) { if (!_access.Has(room, id, name, "moderator")) return "This command requires the moderator role."; var parts = text.Split(' ', 4, StringSplitOptions.RemoveEmptyEntries); var action = parts.ElementAtOrDefault(0) ?? "list"; if (action == "list") { var list = _scheduler.List(room); return list.Count > 0 ? string.Join(" • ", list.Select(x => $"{x.Id}: {x.Type} @ {DateTimeOffset.FromUnixTimeMilliseconds(x.RunAt):g}")) : "No scheduled activities."; } if (action == "remove") return parts.Length > 1 && _scheduler.Remove(parts[1]) ? "Schedule removed." : "Schedule not found."; if (action is "add" or "every" && parts.Length >= 3 && int.TryParse(parts[1], out var minutes) && minutes > 0) { if (parts[2] is not ("announcement" or "trivia" or "marbles-open" or "marbles-close")) return "Unknown schedule type."; var item = _scheduler.Add(room, parts[2], parts.ElementAtOrDefault(3) ?? "", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + minutes * 60000L, action == "every" ? minutes * 60000L : 0); return $"Scheduled {item.Type} ({item.Id})."; } return "Use: .schedule add <minutes> announcement <message>."; }
  private async Task<string> BackupCommandAsync(string room, string? id, string? name, string text) { if (!_access.Has(room, id, name, "owner")) return "This command requires the owner role."; var parts = text.Split(' ', StringSplitOptions.RemoveEmptyEntries); if (parts.ElementAtOrDefault(0) == "create") return $"Backup created: {await _backup.CreateAsync()}."; if (parts.ElementAtOrDefault(0) == "list") return string.Join(" • ", _backup.List().Take(5)) is { Length: > 0 } list ? list : "No backups."; if (parts.ElementAtOrDefault(0) == "verify" && parts.Length > 1) return $"Verified {parts[1]}: {_backup.Verify(parts[1])} files."; return "Use: .backup create|list|verify <name>."; }
  private object GetStatus(string? room) => new { ok = _ready, uptimeSeconds = (long)_uptime.Elapsed.TotalSeconds, joinedRooms = _joinedRooms, memoryUsers = _memory.Users.Count, activePolls = _polls.Polls.Count, community = room is null ? null : new { leaderboard = _loyalty.Leaderboard(room).Select(x => new { x.Name, x.Points, level = LoyaltyService.LevelFor(x.Points), title = LoyaltyService.TitleFor(LoyaltyService.LevelFor(x.Points)) }) }, room = room is null ? null : new { id = room, settings = _settings.Get(room), trivia = new { active = _trivia.GetState(room).Active, question = _trivia.GetState(room).Current?.Question }, marblesPlayers = _marbles.Players.Count } };
  private async Task<object> RunDashboardActionAsync(string room, string action) { if (action == "trivia-start") { var result = _trivia.Start(room, "__system__", "Dashboard"); if (result.AdvanceTrivia) await _trivia.AdvanceAsync(room); } else if (action == "trivia-stop") await SendOptionalAsync(room, _trivia.Stop(room, "__system__", "Dashboard").Reply); else if (action == "marbles-open") await SendOptionalAsync(room, _marbles.HandleAdmin("open").Reply); else if (action == "marbles-close") await SendOptionalAsync(room, _marbles.HandleAdmin("close").Reply); else throw new ArgumentException("Unknown action"); return new { ok = true }; }
  private Task SendOptionalAsync(string room, string? message) => message is null ? Task.CompletedTask : SendRoomMessageAsync(room, message);
  private async Task HandleUserJoinedAsync(UserJoinedPayload payload) { var room = payload.RoomId ?? payload.TargetId ?? ""; var settings = _settings.Get(room); if (_ready && _joinedRooms.Contains(room) && settings.Welcome.Enabled && _settings.IsFeatureEnabled(room, "welcome")) await SendRoomMessageAsync(room, settings.Welcome.Message.Replace("{name}", payload.SenderName ?? payload.Username ?? "friend")); }

  public async ValueTask DisposeAsync()
  {
    if (_disposed) return; _disposed = true; _ready = false; await _dashboard.DisposeAsync(); _scheduler.Dispose();
    if (_socket.Connected) await _socket.DisconnectAsync(); _socket.Dispose(); _backgroundCancellation.Cancel(); _workQueue.Writer.TryComplete();
    try { await Task.WhenAll(_workPump, _outboxPump); } catch (OperationCanceledException) { }
    _trivia.StopAll(); _polls.StopAll(); _continuations.ClearAll(); await FlushAsync(); _backgroundCancellation.Dispose(); _replies.Dispose(); _battlefield.Dispose(); _database.Dispose();
  }
  private Task FlushAsync() => Task.WhenAll(_memory.FlushAsync(), _loyalty.FlushAsync(), _settings.FlushAsync(), _access.FlushAsync(), _trivia.FlushAsync(), _marbles.FlushAsync());
  private async Task ExecuteScheduledAsync(ScheduledItem item) { if (item.Type == "announcement") await SendRoomMessageAsync(item.RoomId, item.Payload); else if (item.Type == "trivia") { var result = _trivia.Start(item.RoomId, "__system__", "Scheduler", item.Payload); if (result.AdvanceTrivia) await _trivia.AdvanceAsync(item.RoomId); } else if (item.Type == "marbles-open") await SendOptionalAsync(item.RoomId, _marbles.HandleAdmin("open").Reply); else if (item.Type == "marbles-close") await SendOptionalAsync(item.RoomId, _marbles.HandleAdmin("close").Reply); }
}

public sealed record OutboxItem(string Id, string RoomId, string Message, int Attempts = 0, long NextAttemptAt = 0, string? LastError = null);

[MessagePackObject] public sealed class MessagePayload { [Key("targetId")] public string TargetId { get; set; } = ""; [Key("senderId")] public string? SenderId { get; set; } [Key("senderName")] public string? SenderName { get; set; } [Key("content")] public string Content { get; set; } = ""; }
[MessagePackObject] public sealed class UserJoinedPayload { [Key("roomId")] public string? RoomId { get; set; } [Key("targetId")] public string? TargetId { get; set; } [Key("senderName")] public string? SenderName { get; set; } [Key("username")] public string? Username { get; set; } }
[MessagePackObject] public sealed class WhoAmI { [Key("id")] public string? Id { get; set; } }
[MessagePackObject] public sealed class Ack { [Key("ok")] public bool Ok { get; set; } [Key("error")] public string? Error { get; set; } }
[MessagePackObject] public sealed class BotAccess { [Key("rooms")] public List<RoomAccess> Rooms { get; set; } = []; }
[MessagePackObject] public sealed class RoomAccess { [Key("roomId")] public string RoomId { get; set; } = ""; [Key("canJoin")] public bool CanJoin { get; set; } }
