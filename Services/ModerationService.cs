using System.Text.RegularExpressions;

namespace EpikChatBot.Services;

public readonly record struct ModerationResult(bool Allowed, string? Reason = null);

public sealed partial class ModerationService(IEnumerable<string> blockedWords, int floodLimit = 6, int floodWindowMs = 10000, int repeatLimit = 3)
{
  private readonly string[] _blocked = [.. blockedWords.Select(x => x.ToLowerInvariant())]; private readonly Dictionary<string, List<(long At, string Content)>> _history = []; private readonly Dictionary<string, long> _mutes = [];
  public ModerationResult Check(string room, string? senderId, string content, bool linksAllowed)
  {
    var key = $"{room}:{senderId}"; var now = Environment.TickCount64; if (_mutes.GetValueOrDefault(key) > now) return new(false, "muted");
    var lower = content.ToLowerInvariant(); if (!linksAllowed && MyRegex().IsMatch(content)) return new(false, "link");
    if (_blocked.Any(word => lower.Contains(word, StringComparison.Ordinal))) return new(false, "blocked-word");
    if (!_history.TryGetValue(key, out var entries)) _history[key] = entries = []; entries.RemoveAll(x => now - x.At > floodWindowMs);
    if (entries.Count >= floodLimit) return new(false, "flood"); var repeats = entries.Count(x => x.Content == lower); entries.Add((now, lower));
    return repeats >= repeatLimit ? new(false, "repeat") : new(true);
  }
  public void Mute(string room, string user, int durationMs) => _mutes[$"{room}:{user}"] = Environment.TickCount64 + durationMs;
  public void Unmute(string room, string user) => _mutes.Remove($"{room}:{user}");
  [GeneratedRegex(@"https?://|www\.", RegexOptions.IgnoreCase, "en-US")]
  private static partial Regex MyRegex();
}
