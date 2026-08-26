using EpikChatBot.Core;

namespace EpikChatBot.Services;

public sealed record MemoryUser
{
  public string Name { get; set; } = "";
  public List<string> History { get; set; } = [];
  public Dictionary<string, string> Preferences { get; set; } = [];
  public bool Enabled { get; set; } = true;
  public long UpdatedAt { get; set; } = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
}

public sealed class MemoryStore
{
  private readonly string _filePath; private readonly int _historyLimit; private readonly int _maxUsers;
  public Dictionary<string, MemoryUser> Users { get; }
  public MemoryStore(string filePath, int historyLimit = 10, int maxUsers = 500)
  {
    _filePath = filePath; _historyLimit = historyLimit; _maxUsers = maxUsers;
    Users = [];
    if (File.Exists(filePath)) try
      {
        using var document = System.Text.Json.JsonDocument.Parse(File.ReadAllText(filePath)); var root = document.RootElement;
        if (root.TryGetProperty("users", out var users)) Users = System.Text.Json.JsonSerializer.Deserialize<Dictionary<string, MemoryUser>>(users, JsonStore.Options) ?? [];
        else if (root.TryGetProperty("userHistory", out var history)) foreach (var entry in history.EnumerateObject()) Users[$"name:{entry.Name.ToLowerInvariant()}"] = new MemoryUser { Name = entry.Name, History = System.Text.Json.JsonSerializer.Deserialize<List<string>>(entry.Value, JsonStore.Options) ?? [] };
      }
      catch (Exception exception) { Console.Error.WriteLine($"[memory] Unable to import {filePath}: {exception.Message}"); }
  }
  private static string Key(string room, string? id, string? name) => $"room:{room}:{(string.IsNullOrWhiteSpace(id) ? $"name:{name}" : $"id:{id}").ToLowerInvariant()}";
  private MemoryUser GetOrCreate(string room, string? id, string? name)
  {
    var key = Key(room, id, name); if (!Users.TryGetValue(key, out var user))
    {
      var legacy = $"name:{(name ?? id ?? "unknown").ToLowerInvariant()}"; if (Users.Remove(legacy, out user)) Users[key] = user; else Users[key] = user = new MemoryUser { Name = name ?? id ?? "friend" };
    }
    if (!string.IsNullOrWhiteSpace(name)) user.Name = name; user.UpdatedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    while (Users.Count > _maxUsers) Users.Remove(Users.OrderBy(x => x.Value.UpdatedAt).First().Key); return user;
  }
  public void RememberMessage(string room, string? id, string? name, string message)
  {
    var user = GetOrCreate(room, id, name); if (!user.Enabled || _historyLimit == 0) return; user.History.Add(message);
    if (user.History.Count > _historyLimit) user.History.RemoveRange(0, user.History.Count - _historyLimit);
  }
  public void RememberPreference(string room, string? id, string? name, string message)
  {
    var lower = message.ToLowerInvariant(); var user = GetOrCreate(room, id, name); if (!user.Enabled) return;
    if (lower.Contains("my favorite ")) user.Preferences["favorite"] = message;
  }
  public IReadOnlyList<string> GetContext(string room, string? id, string? name) { var user = GetOrCreate(room, id, name); return user.Enabled ? user.History : []; }
  public MemoryUser? Show(string room, string? id, string? name) => Users.GetValueOrDefault(Key(room, id, name));
  public object ExportUser(string room, string? id, string? name) => Show(room, id, name) ?? new MemoryUser { Name = name ?? id ?? "friend" };
  public bool IsEnabled(string room, string? id, string? name) => Show(room, id, name)?.Enabled ?? true;
  public void SetEnabled(string room, string? id, string? name, bool enabled) => GetOrCreate(room, id, name).Enabled = enabled;
  public bool Forget(string room, string? id, string? name) => Users.Remove(Key(room, id, name));
  public Task FlushAsync() => JsonStore.WriteAsync(_filePath, new { version = 3, treatCount = 0, recentReplies = Array.Empty<string>(), users = Users, optedOut = Users.Where(x => !x.Value.Enabled).Select(x => x.Key).ToArray() });
}
