using EpikChatBot.Core;

namespace EpikChatBot.Services;

public sealed record LoyaltyUser { public string Id { get; set; } = ""; public string Name { get; set; } = ""; public int Points { get; set; } public int TriviaWins { get; set; } public List<string> Achievements { get; set; } = []; public string LastDaily { get; set; } = ""; public Dictionary<string, int> DailyProgress { get; set; } = []; }
public sealed record Quest(string Id, string Label, int Target, int Reward, int Progress, bool Completed);

public sealed class LoyaltyService
{
  private readonly string _filePath; private readonly Dictionary<string, Dictionary<string, LoyaltyUser>> _rooms;
  public LoyaltyService(string filePath)
  {
    _filePath = filePath; _rooms = [];
    if (File.Exists(filePath)) try { using var document = System.Text.Json.JsonDocument.Parse(File.ReadAllText(filePath)); var users = document.RootElement.TryGetProperty("users", out var nested) ? nested : document.RootElement; foreach (var entry in users.EnumerateObject()) { var split = entry.Name.Split(':', 2); if (split.Length != 2) continue; if (!_rooms.TryGetValue(split[0], out var room)) _rooms[split[0]] = room = []; room[split[1]] = System.Text.Json.JsonSerializer.Deserialize<LoyaltyUser>(entry.Value, JsonStore.Options) ?? new LoyaltyUser { Id = split[1], Name = split[1] }; } } catch (Exception exception) { JsonStore.QuarantineCorruptFile(filePath, exception); }
  }
  public LoyaltyUser Get(string room, string? id, string? name)
  {
    if (!_rooms.TryGetValue(room, out var users)) _rooms[room] = users = []; var key = (id ?? name ?? "unknown").ToLowerInvariant();
    if (!users.TryGetValue(key, out var user)) users[key] = user = new() { Id = key, Name = name ?? id ?? "friend" }; if (!string.IsNullOrWhiteSpace(name)) user.Name = name; return user;
  }
  public LoyaltyUser Award(string room, string? id, string? name, int points, string source)
  {
    var user = Get(room, id, name); user.Points += points; if (source == "trivia") user.TriviaWins++; if (!user.Achievements.Contains("first-point")) user.Achievements.Add("first-point");
    var day = DateTime.UtcNow.ToString("yyyy-MM-dd"); var progressKey = $"{day}:{source}"; user.DailyProgress[progressKey] = user.DailyProgress.GetValueOrDefault(progressKey) + 1;
    var quest = Quests(room, id, name).FirstOrDefault(x => x.Id == $"{source}-win" && x.Completed); if (quest is not null && user.DailyProgress.GetValueOrDefault($"{day}:reward:{quest.Id}") == 0) { user.Points += quest.Reward; user.DailyProgress[$"{day}:reward:{quest.Id}"] = 1; }
    return user;
  }
  public (bool Ok, LoyaltyUser User) Daily(string room, string? id, string? name)
  {
    var user = Get(room, id, name); var day = DateTime.UtcNow.ToString("yyyy-MM-dd"); if (user.LastDaily == day) return (false, user);
    user.LastDaily = day; user.Points += 10; user.DailyProgress[$"{day}:daily"] = 1; user.Points += 5; user.DailyProgress[$"{day}:reward:daily-claim"] = 1; if (!user.Achievements.Contains("first-point")) user.Achievements.Add("first-point"); return (true, user);
  }
  public IReadOnlyList<Quest> Quests(string room, string? id, string? name)
  {
    var user = Get(room, id, name); var day = DateTime.UtcNow.ToString("yyyy-MM-dd");
    return [new("daily-claim", "Claim the daily bonus", 1, 5, user.DailyProgress.GetValueOrDefault($"{day}:daily"), user.LastDaily == day), new("trivia-win", "Win a trivia question", 1, 10, user.DailyProgress.GetValueOrDefault($"{day}:trivia"), user.DailyProgress.GetValueOrDefault($"{day}:trivia") >= 1), new("marbles-win", "Join Marbles", 1, 5, user.DailyProgress.GetValueOrDefault($"{day}:marbles"), user.DailyProgress.GetValueOrDefault($"{day}:marbles") >= 1), new("event-win", "Join an event", 1, 5, user.DailyProgress.GetValueOrDefault($"{day}:event"), user.DailyProgress.GetValueOrDefault($"{day}:event") >= 1)];
  }
  public static int LevelFor(int points) => Math.Max(1, (int)Math.Floor(Math.Sqrt(Math.Max(0, points) / 25d)) + 1);
  public static string TitleFor(int level) => level switch { >= 10 => "Legend", >= 7 => "Champion", >= 5 => "Veteran", >= 3 => "Regular", _ => "Newcomer" };
  public (LoyaltyUser User, int Level, string Title, int NextLevelAt) Progress(string room, string? id, string? name) { var user = Get(room, id, name); var level = LevelFor(user.Points); return (user, level, TitleFor(level), level * level * 25); }
  public IReadOnlyList<LoyaltyUser> Leaderboard(string room, int limit = 10) => _rooms.GetValueOrDefault(room)?.Values.OrderByDescending(x => x.Points).Take(limit).ToList() ?? [];
  public Task FlushAsync() => JsonStore.WriteAsync(_filePath, new { version = 1, users = _rooms.SelectMany(room => room.Value.Select(user => new KeyValuePair<string, LoyaltyUser>($"{room.Key}:{user.Key}", user.Value))).ToDictionary() });
}
