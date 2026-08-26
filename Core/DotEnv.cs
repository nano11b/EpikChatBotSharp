namespace EpikChatBot.Core;

public static class DotEnv
{
  public static void Load(string path)
  {
    if (!File.Exists(path)) return;
    foreach (var raw in File.ReadLines(path))
    {
      var line = raw.Trim();
      if (line.Length == 0 || line.StartsWith('#')) continue;
      var separator = line.IndexOf('=');
      if (separator < 1) continue;
      var key = line[..separator].Trim();
      var value = line[(separator + 1)..].Trim();
      if (value.Length >= 2 && value[0] == value[^1] && value[0] is '\'' or '"') value = value[1..^1];
      if (Environment.GetEnvironmentVariable(key) is null) Environment.SetEnvironmentVariable(key, value);
    }
  }
}
