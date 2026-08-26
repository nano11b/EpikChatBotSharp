using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace EpikChatBot.Core;

public sealed class StateDatabase : IDisposable
{
  private readonly SqliteConnection _connection;
  private readonly object _gate = new();

  public StateDatabase(string filePath)
  {
    filePath = Path.GetFullPath(filePath);
    Directory.CreateDirectory(Path.GetDirectoryName(filePath)!);
    ApplyPendingRestore(filePath);
    _connection = new SqliteConnection($"Data Source={filePath}");
    _connection.Open();
    Execute("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    Execute("""
            CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS documents(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS records(namespace TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(namespace,key));
            INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(1,unixepoch('now')*1000);
            """);
  }

  public static bool ApplyPendingRestore(string path)
  {
    var pending = $"{Path.GetFullPath(path)}.restore-pending";
    if (!File.Exists(pending)) return false;
    Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(path))!);
    if (File.Exists(path)) File.Copy(path, $"{path}.pre-restore.bak", true);
    File.Move(pending, path, true);
    return true;
  }

  public T Get<T>(string nameSpace, string key, T fallback)
  {
    lock (_gate)
    {
      using var command = _connection.CreateCommand();
      command.CommandText = "SELECT value FROM records WHERE namespace=$namespace AND key=$key";
      command.Parameters.AddWithValue("$namespace", nameSpace); command.Parameters.AddWithValue("$key", key);
      if (command.ExecuteScalar() is not string value) return fallback;
      try { return JsonSerializer.Deserialize<T>(value, JsonStore.Options) ?? fallback; }
      catch (Exception exception) { Console.Error.WriteLine($"[database] Unable to deserialize {nameSpace}/{key}: {exception.Message}"); return fallback; }
    }
  }

  public T Set<T>(string nameSpace, string key, T value)
  {
    lock (_gate)
    {
      using var command = _connection.CreateCommand();
      command.CommandText = "INSERT INTO records(namespace,key,value,updated_at) VALUES($namespace,$key,$value,$at) ON CONFLICT(namespace,key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at";
      command.Parameters.AddWithValue("$namespace", nameSpace); command.Parameters.AddWithValue("$key", key);
      command.Parameters.AddWithValue("$value", JsonSerializer.Serialize(value, JsonStore.Options)); command.Parameters.AddWithValue("$at", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
      command.ExecuteNonQuery(); return value;
    }
  }

  public bool Delete(string nameSpace, string key)
  {
    lock (_gate)
    {
      using var command = _connection.CreateCommand(); command.CommandText = "DELETE FROM records WHERE namespace=$namespace AND key=$key";
      command.Parameters.AddWithValue("$namespace", nameSpace); command.Parameters.AddWithValue("$key", key); return command.ExecuteNonQuery() > 0;
    }
  }

  public IReadOnlyList<(string Key, T Value, long UpdatedAt)> List<T>(string nameSpace)
  {
    lock (_gate)
    {
      var result = new List<(string, T, long)>(); using var command = _connection.CreateCommand();
      command.CommandText = "SELECT key,value,updated_at FROM records WHERE namespace=$namespace ORDER BY updated_at"; command.Parameters.AddWithValue("$namespace", nameSpace);
      using var reader = command.ExecuteReader(); while (reader.Read()) { try { var value = JsonSerializer.Deserialize<T>(reader.GetString(1), JsonStore.Options); if (value is not null) result.Add((reader.GetString(0), value, reader.GetInt64(2))); } catch (Exception exception) { Console.Error.WriteLine($"[database] Unable to deserialize {nameSpace}/{reader.GetString(0)}: {exception.Message}"); } }
      return result;
    }
  }

  public void Checkpoint() => Execute("PRAGMA wal_checkpoint(TRUNCATE)");
  private void Execute(string sql) { lock (_gate) { using var command = _connection.CreateCommand(); command.CommandText = sql; command.ExecuteNonQuery(); } }
  public void Dispose() { Checkpoint(); _connection.Dispose(); }
}
