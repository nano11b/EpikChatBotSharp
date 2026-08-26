using System.Text.Json;

namespace EpikChatBot.Core;

public static class JsonStore
{
  public static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web)
  {
    WriteIndented = true,
    PropertyNameCaseInsensitive = true
  };

  public static T Read<T>(string path, T fallback)
  {
    try { return File.Exists(path) ? JsonSerializer.Deserialize<T>(File.ReadAllText(path), Options) ?? fallback : fallback; }
    catch (Exception exception) { QuarantineCorruptFile(path, exception); return fallback; }
  }

  public static string? QuarantineCorruptFile(string path, Exception exception)
  {
    Console.Error.WriteLine($"[persistence] Unable to read {path}: {exception.Message}");
    if (!File.Exists(path)) return null;
    try
    {
      var quarantine = $"{path}.corrupt-{DateTime.UtcNow:yyyyMMdd-HHmmssfff}";
      File.Move(path, quarantine);
      Console.Error.WriteLine($"[persistence] Moved corrupt data to {quarantine}.");
      return quarantine;
    }
    catch (Exception moveException)
    {
      Console.Error.WriteLine($"[persistence] Unable to quarantine {path}: {moveException.Message}");
      return null;
    }
  }

  public static async Task WriteAsync<T>(string path, T value, CancellationToken cancellationToken = default)
  {
    Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(path))!);
    var temporary = $"{path}.{Guid.NewGuid():N}.tmp";
    await File.WriteAllTextAsync(temporary, JsonSerializer.Serialize(value, Options), cancellationToken);
    File.Move(temporary, path, true);
  }
}
