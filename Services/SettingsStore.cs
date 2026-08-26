using System.Text.Json;
using EpikChatBot.Core;

namespace EpikChatBot.Services;

public sealed record RoomSettings
{
  public AiSettings Ai { get; init; } = new(); public BotIdentitySettings Bot { get; init; } = new(); public ReplySettings Reply { get; init; } = new(); public TriviaSettings Trivia { get; init; } = new();
  public ModerationSettings Moderation { get; init; } = new(); public WelcomeSettings Welcome { get; init; } = new(); public LocaleSettings Locale { get; init; } = new();
  public AccessibilitySettings Accessibility { get; init; } = new(); public string ReleaseChannel { get; set; } = "stable";
  public Dictionary<string, bool> Commands { get; init; } = []; public Dictionary<string, bool> Features { get; init; } = [];
}
public sealed record AiSettings { public bool Enabled { get; set; } = true; public bool RespondToAll { get; set; } }
public sealed record BotIdentitySettings { public string? Name { get; set; } public string Persona { get; set; } = "a friendly male cat in an EpikChat community"; }
public sealed record ReplySettings { public string Color { get; set; } = SettingsStore.DefaultReplyColor; }
public sealed record TriviaSettings { public int Attempts { get; set; } = 3; public int TimeMs { get; set; } = 30000; public int HintMs { get; set; } public int QuestionCount { get; set; } = 10; public int SpeedBonusMs { get; set; } }
public sealed record ModerationSettings { public bool Enabled { get; set; } = true; public bool LinksAllowed { get; set; } = true; }
public sealed record WelcomeSettings { public bool Enabled { get; set; } public string Message { get; set; } = "Welcome to the room, {name}!"; }
public sealed record LocaleSettings { public string Language { get; set; } = "en"; }
public sealed record AccessibilitySettings { public bool Concise { get; set; } }

public sealed class SettingsStore
{
  public const string DefaultReplyColor = "#e69138";
  private static readonly HashSet<string> AllowedReplyColors = new(StringComparer.OrdinalIgnoreCase)
  {
    "#ea9999", "#dd7e6b", "#f9cb9c", "#e2cb88", "#b6d7a8", "#a2c4c9", "#9fc5e8", "#a4c2f4", "#b4a7d6", "#efabc1",
    "#e06666", "#cc4125", "#f6b26b", "#ffd966", "#93c47d", "#76a5af", "#6fa8dc", "#e69138", "#8e7cc3", "#f778a1",
    "#b20000", "#a61c00", "#e69138", "#f1c232", "#6aa84f", "#45818e", "#3d85c6", "#3c78d8", "#6d51b6", "#a64d79",
    "#bf3f3f", "#bf7f3f", "#bf9000", "#bfbf3f", "#38761d", "#1d6f80", "#1562a7", "#1155cc", "#832ed5", "#912f5f",
    "#202324", "#606060", "#818181", "#7fbf3f", "#3fbf3f", "#3fbf7f", "#3fbfbf", "#3f7fbf", "#3f3fbf", "#bf3fbf"
  };
  private readonly string _filePath; private readonly Dictionary<string, RoomSettings> _rooms;
  private static readonly string[] sourceArray = ["1", "true", "yes", "on"];

  public SettingsStore(string filePath)
  {
    _filePath = filePath; _rooms = [];
    if (File.Exists(filePath)) try { using var document = JsonDocument.Parse(File.ReadAllText(filePath)); var root = document.RootElement; var rooms = root.TryGetProperty("rooms", out var nested) ? nested : root; _rooms = JsonSerializer.Deserialize<Dictionary<string, RoomSettings>>(rooms, JsonStore.Options) ?? []; } catch (Exception exception) { JsonStore.QuarantineCorruptFile(filePath, exception); }
    foreach (var (room, settings) in _rooms)
    {
      if (IsAllowedReplyColor(settings.Reply.Color)) continue;
      Console.Error.WriteLine($"[settings] Room '{room}' has unsupported reply color '{settings.Reply.Color}'; using {DefaultReplyColor}.");
      settings.Reply.Color = DefaultReplyColor;
    }
  }
  public static bool IsAllowedReplyColor(string? color) => color is not null && AllowedReplyColors.Contains(color);
  public RoomSettings Get(string room) { if (!_rooms.TryGetValue(room, out var value)) _rooms[room] = value = new(); return value; }
  public bool IsCommandEnabled(string room, string command) => !Get(room).Commands.TryGetValue(command, out var enabled) || enabled;
  public bool IsFeatureEnabled(string room, string feature) => !Get(room).Features.TryGetValue(feature, out var enabled) || enabled;
  public RoomSettings Reset(string room) => _rooms[room] = new();
  public RoomSettings Set(string room, string path, object? value)
  {
    var settings = Get(room); var text = Convert.ToString(value) ?? ""; var boolean = sourceArray.Contains(text.ToLowerInvariant());
    switch (path.ToLowerInvariant())
    {
      case "ai.enabled": settings.Ai.Enabled = boolean; break;
      case "ai.respondtoall": settings.Ai.RespondToAll = boolean; break;
      case "bot.name": settings.Bot.Name = text; break;
      case "bot.persona": settings.Bot.Persona = text; break;
      case "reply.color": settings.Reply.Color = IsAllowedReplyColor(text) ? text.ToLowerInvariant() : throw new ArgumentException($"Unsupported EpikChat reply color: {text}"); break;
      case "trivia.attempts": settings.Trivia.Attempts = int.Parse(text); break;
      case "trivia.timems": settings.Trivia.TimeMs = int.Parse(text); break;
      case "trivia.hintms": settings.Trivia.HintMs = int.Parse(text); break;
      case "trivia.questioncount": settings.Trivia.QuestionCount = int.Parse(text); break;
      case "welcome.enabled": settings.Welcome.Enabled = boolean; break;
      case "welcome.message": settings.Welcome.Message = text; break;
      case "locale.language": settings.Locale.Language = text; break;
      case "accessibility.concise": settings.Accessibility.Concise = boolean; break;
      case "releasechannel": settings.ReleaseChannel = text; break;
      case "moderation.enabled": settings.Moderation.Enabled = boolean; break;
      case "moderation.linksallowed": settings.Moderation.LinksAllowed = boolean; break;
      default:
        if (path.StartsWith("commands.", StringComparison.OrdinalIgnoreCase)) settings.Commands[path[9..].ToLowerInvariant()] = boolean;
        else if (path.StartsWith("features.", StringComparison.OrdinalIgnoreCase)) settings.Features[path[9..].ToLowerInvariant()] = boolean;
        else throw new ArgumentException($"Unknown setting: {path}");
        break;
    }
    return settings;
  }
  public Task FlushAsync() => JsonStore.WriteAsync(_filePath, new { version = 1, rooms = _rooms });
}
