namespace EpikChatBot.Core;

public static class CommandCatalog
{
  public sealed record CommandCategory(string Key, string Label, IReadOnlyList<string> Commands);

  private static readonly IReadOnlyDictionary<string, string> Aliases = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
  {
    ["more"] = "continue",
    ["rank"] = "progress",
    ["level"] = "progress",
    ["top"] = "leaderboard",
    ["bf6"] = "bf",
    ["battlefield"] = "bf",
  };

  public static IReadOnlyList<CommandCategory> ViewerCategories { get; } =
  [
    new("general", "General", ["help", "ping", "bot"]),
    new("ai", "AI & Fun", ["ask", "continue", "memory", "echo", "pet", "status", "treat"]),
    new("rewards", "Profile & Rewards", ["profile", "points", "progress", "quests", "daily", "leaderboard"]),
    new("games", "Games & Activities", ["trivia", "answer", "poll", "vote", "bf", "marbles"]),
    new("community", "Community", ["event", "season", "appeal"]),
  ];

  public static IReadOnlyList<string> ViewerCommands { get; } =
      [.. ViewerCategories.SelectMany(category => category.Commands)];

  public static IReadOnlyDictionary<string, string> PrivilegedCommands { get; } = new Dictionary<string, string>
  {
    ["question"] = "host",
    ["race"] = "host",
    ["poll"] = "moderator",
    ["mod"] = "moderator",
    ["ignore"] = "moderator",
    ["warn"] = "moderator",
    ["case"] = "moderator",
    ["schedule"] = "moderator",
    ["metrics"] = "moderator",
    ["config"] = "owner",
    ["role"] = "owner",
    ["backup"] = "owner",
    ["outbox"] = "owner",
  };

  public static string HelpText => GetHelpText();

  public static string GetHelpText(string? category = null)
  {
    var requested = category?.Trim().ToLowerInvariant();
    if (!string.IsNullOrEmpty(requested))
    {
      var viewerCategory = ViewerCategories.FirstOrDefault(item =>
          item.Key == requested || item.Label.Equals(requested, StringComparison.OrdinalIgnoreCase));
      if (viewerCategory is not null) return FormatCategory(viewerCategory) + MarblesNote(viewerCategory.Key);
      if (requested == "staff") return FormatStaffCategories();
      return $"Unknown help category '{category?.Trim()}'. Categories: {CategoryKeys}.";
    }

    return $"Commands by category: {string.Join(" | ", ViewerCategories.Select(FormatCategory))} | {FormatStaffCategories()}" +
        $"{MarblesNote("games")} Try .help <category>: {CategoryKeys}.";
  }

  private static string CategoryKeys =>
      string.Join(", ", ViewerCategories.Select(category => category.Key).Append("staff"));

  private static string FormatCategory(CommandCategory category) =>
      $"{category.Label}: {FormatCommands(category.Commands)}";

  private static string FormatStaffCategories() =>
      "Staff — " + string.Join(" | ", PrivilegedCommands
          .GroupBy(item => item.Value)
          .Select(group => $"{char.ToUpperInvariant(group.Key[0])}{group.Key[1..]}: {FormatCommands(group.Select(item => item.Key))}"));

  private static string FormatCommands(IEnumerable<string> commands) =>
      string.Join(", ", commands.Select(command => $".{command}"));

  private static string MarblesNote(string category) =>
      category == "games" ? ". Marbles also accepts !play and !leave." : ".";

  public static string Normalize(string command) =>
      Aliases.TryGetValue(command, out var canonical) ? canonical : command.ToLowerInvariant();

  public static bool IsKnown(string command) =>
      ViewerCommands.Contains(Normalize(command), StringComparer.OrdinalIgnoreCase) || PrivilegedCommands.ContainsKey(Normalize(command));
}
