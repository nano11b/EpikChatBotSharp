using EpikChatBot.Core;

namespace EpikChatBot.Services;

public sealed class AccessControl
{
  private static readonly Dictionary<string, int> Levels = new() { ["viewer"] = 0, ["host"] = 1, ["moderator"] = 2, ["owner"] = 3 };
  private readonly string _filePath; private readonly HashSet<string> _owners; private readonly Dictionary<string, Dictionary<string, string>> _roles;
  public AccessControl(string filePath, IEnumerable<string> ownerIds, IEnumerable<string> ownerNames)
  {
    _filePath = filePath; _owners = [.. ownerIds.Concat(ownerNames).Select(Normalize)]; _roles = [];
    if (File.Exists(filePath)) try { using var document = System.Text.Json.JsonDocument.Parse(File.ReadAllText(filePath)); if (document.RootElement.TryGetProperty("rooms", out var rooms)) foreach (var room in rooms.EnumerateObject()) { _roles[room.Name] = []; foreach (var grant in room.Value.EnumerateObject()) if (grant.Value.TryGetProperty("role", out var role)) _roles[room.Name][grant.Name] = role.GetString() ?? "viewer"; } } catch { }
  }
  private static string Normalize(string? value) => (value ?? "").Trim().ToLowerInvariant();
  public string RoleFor(string room, string? id, string? name)
  {
    if (id == "__system__" || _owners.Contains(Normalize(id)) || _owners.Contains(Normalize(name))) return "owner";
    if (_roles.TryGetValue(room, out var roles)) { if (roles.TryGetValue($"id:{Normalize(id)}", out var role)) return role; if (roles.TryGetValue($"name:{Normalize(name)}", out role)) return role; }
    if (_roles.TryGetValue("*", out roles)) { if (roles.TryGetValue(Normalize(id), out var role)) return role; if (roles.TryGetValue(Normalize(name), out role)) return role; }
    return "viewer";
  }
  public bool Has(string room, string? id, string? name, string required) => Levels[RoleFor(room, id, name)] >= Levels.GetValueOrDefault(required, 0);
  public (string Identity, string Role) Grant(string room, string identity, string role) { role = role.ToLowerInvariant(); if (!Levels.ContainsKey(role) || role == "viewer") throw new ArgumentException("Role must be host, moderator, or owner."); if (!_roles.TryGetValue(room, out var roles)) _roles[room] = roles = []; var key = identity.Contains(':') ? Normalize(identity) : $"id:{Normalize(identity)}"; roles[key] = role; return (key, role); }
  public bool Revoke(string room, string identity) => _roles.TryGetValue(room, out var roles) && (roles.Remove(Normalize(identity)) || roles.Remove($"id:{Normalize(identity)}") || roles.Remove($"name:{Normalize(identity)}"));
  public IEnumerable<(string Identity, string Role)> List(string room) => _roles.GetValueOrDefault(room)?.Select(x => (x.Key, x.Value)) ?? [];
  public Task FlushAsync() => JsonStore.WriteAsync(_filePath, new { version = 1, rooms = _roles.ToDictionary(room => room.Key, room => room.Value.ToDictionary(grant => grant.Key, grant => new { role = grant.Value, name = (string?)null, grantedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() })) });
}
