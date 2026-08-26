namespace EpikChatBot.Core;

public readonly record struct ParsedCommand(bool IsCommand, string Command, string Text);

public static class CommandParser
{
  public static ParsedCommand Parse(string? content)
  {
    var text = (content ?? "").Trim();
    if (!text.StartsWith('.') && !text.StartsWith('^')) return new(false, "", text);
    var split = text[1..].Split((char[]?)null, 2, StringSplitOptions.RemoveEmptyEntries);
    return split.Length == 0 ? new(true, "", "") : new(true, split[0].ToLowerInvariant(), split.Length > 1 ? split[1].Trim() : "");
  }
}
