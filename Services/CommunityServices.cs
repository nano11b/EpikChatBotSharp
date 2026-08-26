using System.IO.Compression;
using EpikChatBot.Core;

namespace EpikChatBot.Services;

public sealed record IgnoreRule(string Type, string Value, string? ActorId, long CreatedAt);
public sealed class IgnoreService(StateDatabase database, IEnumerable<string> defaultIds, IEnumerable<string> defaultNames)
{
  private static string Normalize(string? value) => (value ?? "").Trim().ToLowerInvariant(); private static string Namespace(string room) => $"ignore:{room}";
  public bool IsIgnored(string room, string? id, string? name) => Status(room, "id", id ?? "") || Status(room, "name", name ?? "") || defaultIds.Contains(Normalize(id)) || defaultNames.Contains(Normalize(name));
  public IgnoreRule Add(string room, string type, string value, string? actor) { type = type == "id" ? "id" : "name"; var rule = new IgnoreRule(type, Normalize(value), actor, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()); return database.Set(Namespace(room), $"{type}:{rule.Value}", rule); }
  public bool Remove(string room, string type, string value) => database.Delete(Namespace(room), $"{type}:{Normalize(value)}");
  public bool Status(string room, string type, string value) => database.Get<IgnoreRule?>(Namespace(room), $"{type}:{Normalize(value)}", null) is not null;
  public IReadOnlyList<IgnoreRule> List(string room) => [.. database.List<IgnoreRule>(Namespace(room)).Select(x => x.Value)];
}

public sealed record ModerationCase(string Id, string RoomId, string UserId, string ActorId, string ActorName, string Reason, string Action, string Status, long CreatedAt, List<string> Notes, string? Appeal = null);
public sealed class ModerationCaseService(StateDatabase database)
{
  public ModerationCase Create(string room, string user, string? actorId, string? actorName, string reason, string action) { var item = new ModerationCase($"case-{Guid.NewGuid():N}"[..13], room, user, actorId ?? "", actorName ?? "", reason, action, "open", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), []); return database.Set("moderation-cases", item.Id, item); }
  public ModerationCase? Get(string id) => database.Get<ModerationCase?>("moderation-cases", id, null);
  public IReadOnlyList<ModerationCase> List(string room, string? user = null, int limit = 5) => [.. database.List<ModerationCase>("moderation-cases").Select(x => x.Value).Where(x => x.RoomId == room && (user is null || x.UserId == user)).OrderByDescending(x => x.CreatedAt).Take(limit)];
  public ModerationCase? Note(string id, string? actor, string text) { var item = Get(id); if (item is null) return null; item.Notes.Add($"{actor}: {text}"); return database.Set("moderation-cases", id, item); }
  public ModerationCase? Resolve(string id, string status) { var item = Get(id); return item is null ? null : database.Set("moderation-cases", id, item with { Status = status }); }
  public ModerationCase? Appeal(string room, string user, string text) { var item = List(room, user, 20).FirstOrDefault(x => x.Status == "open"); return item is null ? null : database.Set("moderation-cases", item.Id, item with { Appeal = text }); }
}

public sealed record CommunityEvent(string Id, string RoomId, string Title, long? StartsAt, bool Open, Dictionary<string, string> Participants);
public sealed class EventService(StateDatabase database)
{
  public CommunityEvent Create(string room, string specification) { var parts = specification.Split('|', 2, StringSplitOptions.TrimEntries); long? at = parts.Length > 1 && DateTimeOffset.TryParse(parts[1], out var date) ? date.ToUnixTimeMilliseconds() : null; var item = new CommunityEvent($"event-{Guid.NewGuid():N}"[..14], room, parts[0], at, true, []); return database.Set("events", item.Id, item); }
  public CommunityEvent? Get(string id) => database.Get<CommunityEvent?>("events", id, null);
  public IReadOnlyList<CommunityEvent> Active(string room) => [.. database.List<CommunityEvent>("events").Select(x => x.Value).Where(x => x.RoomId == room && x.Open)];
  public CommunityEvent? Join(string id, string user, string name) { var item = Get(id); if (item is null || !item.Open) return null; item.Participants[user.ToLowerInvariant()] = name; return database.Set("events", id, item); }
  public CommunityEvent? Leave(string id, string user) { var item = Get(id); if (item is null) return null; item.Participants.Remove(user.ToLowerInvariant()); return database.Set("events", id, item); }
  public CommunityEvent? Close(string id) { var item = Get(id); return item is null ? null : database.Set("events", id, item with { Open = false }); }
  public (List<string> A, List<string> B)? Teams(string id) { var item = Get(id); if (item is null) return null; var a = new List<string>(); var b = new List<string>(); foreach (var name in item.Participants.Values.Order()) (a.Count <= b.Count ? a : b).Add(name); return (a, b); }
}

public sealed record MarbleSeason(string Name, bool Active, long StartedAt, long? EndedAt, List<List<string>> Races, Dictionary<string, int> Players);
public sealed class MarblesSeasonService(StateDatabase database)
{
  public MarbleSeason? Get(string room) => database.Get<MarbleSeason?>("marbles-seasons", room, null);
  public MarbleSeason Start(string room, string? name) { if (Get(room)?.Active == true) throw new InvalidOperationException("A Marbles season is already active."); return database.Set("marbles-seasons", room, new MarbleSeason(string.IsNullOrWhiteSpace(name) ? $"Season {DateTime.UtcNow:yyyy-MM-dd}" : name, true, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), null, [], [])); }
  public MarbleSeason? End(string room) { var season = Get(room); return season is null ? null : database.Set("marbles-seasons", room, season with { Active = false, EndedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() }); }
  public List<string> Record(string room, IEnumerable<string> names) { var season = Get(room); if (season?.Active != true) throw new InvalidOperationException("Start a season before recording a race."); var finishers = names.Select(x => x.Trim()).Where(x => x.Length > 0).Distinct(StringComparer.OrdinalIgnoreCase).ToList(); season.Races.Add(finishers); var points = new[] { 10, 6, 4, 3, 2, 1 }; for (var i = 0; i < finishers.Count; i++) season.Players[finishers[i]] = season.Players.GetValueOrDefault(finishers[i]) + (i < points.Length ? points[i] : 1); database.Set("marbles-seasons", room, season); return finishers; }
  public IReadOnlyList<(string Name, int Points)> Leaderboard(string room) => Get(room)?.Players.OrderByDescending(x => x.Value).Select(x => (x.Key, x.Value)).ToList() ?? [];
}

public sealed record ScheduledItem(string Id, string RoomId, string Type, string Payload, long RunAt, long RepeatMs);
public sealed class SchedulerService : IDisposable
{
  private readonly StateDatabase _database; private readonly Func<ScheduledItem, Task> _execute; private readonly Func<Func<Task>, Task> _dispatch; private readonly Dictionary<string, Timer> _timers = [];
  public SchedulerService(StateDatabase database, Func<ScheduledItem, Task> execute, Func<Func<Task>, Task>? dispatch = null) { _database = database; _execute = execute; _dispatch = dispatch ?? (action => action()); foreach (var item in ListAll()) Arm(item); }
  public ScheduledItem Add(string room, string type, string payload, long runAt, long repeatMs = 0) { var item = new ScheduledItem($"schedule-{Guid.NewGuid():N}"[..17], room, type, payload, runAt, repeatMs); _database.Set("schedules", item.Id, item); Arm(item); return item; }
  public bool Remove(string id) { if (_timers.Remove(id, out var timer)) timer.Dispose(); return _database.Delete("schedules", id); }
  public IReadOnlyList<ScheduledItem> List(string room) => [.. ListAll().Where(x => x.RoomId == room).OrderBy(x => x.RunAt)];
  private IReadOnlyList<ScheduledItem> ListAll() => [.. _database.List<ScheduledItem>("schedules").Select(x => x.Value)];
  private void Arm(ScheduledItem item) { if (_timers.Remove(item.Id, out var old)) old.Dispose(); var delay = Math.Max(1, item.RunAt - DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()); _timers[item.Id] = new Timer(_ => _ = DispatchRunAsync(item.Id), null, delay, Timeout.Infinite); }
  private async Task DispatchRunAsync(string id) { try { await _dispatch(() => RunAsync(id)); } catch (Exception exception) { Console.Error.WriteLine($"[scheduler] Unable to dispatch {id}: {exception.Message}"); } }
  private async Task RunAsync(string id) { var item = _database.Get<ScheduledItem?>("schedules", id, null); if (item is null) return; try { await _execute(item); if (item.RepeatMs > 0) { item = item with { RunAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + item.RepeatMs }; _database.Set("schedules", id, item); Arm(item); } else Remove(id); } catch (Exception exception) { Console.Error.WriteLine($"[scheduler] {exception.Message}"); item = item with { RunAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 60000 }; _database.Set("schedules", id, item); Arm(item); } }
  public void Dispose() { foreach (var timer in _timers.Values) timer.Dispose(); _timers.Clear(); }
}

public sealed class BackupService(BotConfig config, Func<Task> flush)
{
  private string DirectoryPath => Path.Combine(config.BaseDirectory, "backups");
  public async Task<string> CreateAsync() { await flush(); Directory.CreateDirectory(DirectoryPath); var name = $"epikchat-{DateTime.UtcNow:yyyyMMdd-HHmmssfff}-{Guid.NewGuid():N}"[..39] + ".zip"; var target = Path.Combine(DirectoryPath, name); using var archive = ZipFile.Open(target, ZipArchiveMode.Create); foreach (var path in new[] { config.DatabaseFile, config.SettingsFile, config.MemoryFile, config.LoyaltyFile, config.SchedulesFile, config.TriviaFile, config.TriviaScoreFile, config.RolesFile, config.MarblesFile, $"{config.MarblesFile}.state.json" }.Where(File.Exists).Distinct()) archive.CreateEntryFromFile(path, Path.GetFileName(path), CompressionLevel.Optimal); return name; }
  public IReadOnlyList<string> List() => Directory.Exists(DirectoryPath) ? Directory.GetFiles(DirectoryPath, "*.zip").Select(Path.GetFileName).Where(x => x is not null).Cast<string>().OrderDescending().ToList() : [];
  public int Verify(string name) { var path = SafePath(name); using var archive = ZipFile.OpenRead(path); foreach (var entry in archive.Entries) using (entry.Open()) { } return archive.Entries.Count; }
  private string SafePath(string name) { if (Path.IsPathRooted(name) || Path.GetFileName(name) != name) throw new ArgumentException("Invalid backup name."); var path = Path.GetFullPath(Path.Combine(DirectoryPath, name)); if (!string.Equals(Path.GetDirectoryName(path), Path.GetFullPath(DirectoryPath), StringComparison.OrdinalIgnoreCase)) throw new ArgumentException("Invalid backup name."); return path; }
}
