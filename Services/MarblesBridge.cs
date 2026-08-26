using System.Text.Json;
using System.Text.RegularExpressions;
using EpikChatBot.Core;

namespace EpikChatBot.Services;

public sealed record MarblePlayer(string? Id, string Name);
public sealed record MarbleResult(bool Handled, string? Reply = null, bool Joined = false, bool Duplicate = false);

public sealed partial class MarblesBridge
{
  private readonly string _filePath; private readonly string _statePath; private readonly bool _enabled; private readonly bool _confirm;
  private readonly HashSet<string> _joinCommands; public Dictionary<string, MarblePlayer> Players { get; } = []; public bool RegistrationOpen { get; private set; }
  public MarblesBridge(BotConfig config)
  {
    _filePath = config.MarblesFile; _statePath = $"{_filePath}.state.json"; _enabled = config.MarblesEnabled; _confirm = config.MarblesConfirmJoins; RegistrationOpen = config.MarblesRegistrationOpen;
    _joinCommands = [.. config.MarblesJoinCommands.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).Select(x => x.ToLowerInvariant())]; if (_enabled) Load();
  }
  public static string CleanName(string? value) => MyRegex().Replace(value ?? "", " ").Replace(",", "").Trim() is var name ? name[..Math.Min(50, name.Length)] : "";
  private void Load()
  {
    Directory.CreateDirectory(Path.GetDirectoryName(_filePath)!); if (!File.Exists(_filePath)) File.WriteAllText(_filePath, "");
    if (File.Exists(_statePath)) foreach (var player in JsonStore.Read(_statePath, new List<MarblePlayer>())) { var key = string.IsNullOrWhiteSpace(player.Id) ? $"name:{player.Name.ToLowerInvariant()}" : $"id:{player.Id.ToLowerInvariant()}"; Players[key] = player; }
    else foreach (var name in File.ReadAllLines(_filePath).Select(CleanName).Where(x => x.Length > 0)) Players[$"name:{name.ToLowerInvariant()}"] = new(null, name);
  }
  public (string Type, string Command)? Parse(string content)
  {
    var text = content.Trim(); var lower = text.ToLowerInvariant(); if (_joinCommands.Contains(lower)) return ("join", ""); if (lower is "!leave" or "!unplay") return ("leave", "");
    var match = MyRegex1().Match(text); return match.Success ? ("admin", match.Groups[1].Success ? match.Groups[1].Value.Trim().ToLowerInvariant() : "status") : null;
  }
  public MarbleResult HandleMessage(string? senderId, string? senderName, string content)
  {
    if (!_enabled) return new(false); var parsed = Parse(content); if (parsed is null) return new(false); var name = CleanName(senderName ?? senderId); var id = (senderId ?? "").Trim().ToLowerInvariant(); var key = id.Length > 0 ? $"id:{id}" : $"name:{name.ToLowerInvariant()}";
    if (parsed.Value.Type == "join")
    {
      if (!RegistrationOpen) return new(true, "🔒 Marbles registration is currently closed."); if (name.Length == 0) return new(true, "I couldn't add that name to the Marbles roster.");
      if (Players.TryGetValue(key, out var old)) { Players[key] = old with { Name = name }; return new(true, _confirm ? $"🎱 {name}, you're already in the race! ({Players.Count} entered)" : null, false, true); }
      Players.Remove($"name:{name.ToLowerInvariant()}"); Players[key] = new(id.Length > 0 ? id : null, name); _ = FlushAsync(); return new(true, _confirm ? $"🎱 {name} joined the Marbles race! ({Players.Count} entered)" : null, true);
    }
    if (parsed.Value.Type == "leave") { var existed = Players.Remove(key) || Players.Remove($"name:{name.ToLowerInvariant()}"); if (existed) _ = FlushAsync(); return new(true, existed ? $"👋 {name} left the Marbles race. ({Players.Count} entered)" : $"🎱 {name}, you weren't in the current Marbles roster."); }
    return HandleAdmin(parsed.Value.Command);
  }
  public MarbleResult HandleAdmin(string command)
  {
    switch (command) { case "open": case "start": RegistrationOpen = true; return new(true, $"🎱 Marbles registration is OPEN. Type !play to join. ({Players.Count} currently entered)"); case "close": case "stop": RegistrationOpen = false; return new(true, $"🔒 Marbles registration is CLOSED with {Players.Count} player{(Players.Count == 1 ? "" : "s")}."); case "reset": case "clear": Players.Clear(); RegistrationOpen = true; _ = FlushAsync(); return new(true, "🧹 Marbles roster cleared. Registration is OPEN for a new race."); case "count": case "status": return new(true, $"🎱 Marbles: {(RegistrationOpen ? "OPEN" : "CLOSED")} • {Players.Count} player{(Players.Count == 1 ? "" : "s")} • {Path.GetFileName(_filePath)}"); case "help": return new(true, "Marbles admin: .marbles open | close | reset | count. Viewers: !play to join, !leave to leave."); default: return new(true, "Unknown Marbles command. Use .marbles help."); }
  }
  public async Task FlushAsync() { var values = Players.Values.ToList(); await Task.WhenAll(JsonStore.WriteAsync(_statePath, values), File.WriteAllTextAsync(_filePath, values.Count > 0 ? string.Join(Environment.NewLine, values.Select(x => x.Name)) + Environment.NewLine : "")); }

  [GeneratedRegex(@"[\r\n]+")]
  private static partial Regex MyRegex();
  [GeneratedRegex(@"^[.^]marbles(?:\s+(.+))?$", RegexOptions.IgnoreCase, "en-US")]
  private static partial Regex MyRegex1();
}
