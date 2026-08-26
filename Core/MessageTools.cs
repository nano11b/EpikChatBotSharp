namespace EpikChatBot.Core;

public static class MessageTools
{
  public static IReadOnlyList<string> Split(string? value, int maxLength = 250, string suffix = "")
  {
    var remaining = (value ?? "").Trim(); var chunks = new List<string>(); var available = Math.Max(1, maxLength - suffix.Length);
    while (remaining.Length > available)
    {
      var cut = remaining.LastIndexOfAny([' ', '\n'], available - 1); if (cut < available / 2) cut = available;
      chunks.Add(remaining[..cut].TrimEnd() + suffix); remaining = remaining[cut..].TrimStart();
    }
    if (remaining.Length > 0 || chunks.Count == 0) chunks.Add(remaining);
    return chunks;
  }
}

public static class SocketPayload
{
  public static Dictionary<object, object> Map(params (string Key, object Value)[] fields) =>
      fields.ToDictionary(field => (object)field.Key, field => field.Value);

  public static IReadOnlyList<(string RoomId, bool CanJoin)> ReadRoomAccess(IDictionary<object, object> payload)
  {
    if (!payload.TryGetValue("rooms", out var value) || value is not object[] rooms) return [];
    var result = new List<(string RoomId, bool CanJoin)>();
    foreach (var room in rooms.OfType<IDictionary<object, object>>())
    {
      var roomId = room.TryGetValue("roomId", out var id) ? Convert.ToString(id) : null;
      var canJoin = room.TryGetValue("canJoin", out var allowed) && Convert.ToBoolean(allowed);
      if (!string.IsNullOrWhiteSpace(roomId)) result.Add((roomId, canJoin));
    }
    return result;
  }

  public static IDictionary<object, object>? FindMap(object? value)
  {
    if (value is IDictionary<object, object> map) return map;
    if (value is object[] array) foreach (var item in array) if (FindMap(item) is { } nested) return nested;
    return null;
  }

  public static string? String(IDictionary<object, object> payload, string key) =>
      payload.TryGetValue(key, out var value) ? Convert.ToString(value) : null;

  public static string? AckFailure(IDictionary<object, object> payload)
  {
    if (String(payload, "error") is { Length: > 0 } error) return error;
    var failed = payload.TryGetValue("success", out var success) && IsExplicitFalse(success);
    var badStatus = payload.TryGetValue("status", out var status) &&
        int.TryParse(Convert.ToString(status), out var statusCode) && statusCode >= 400;
    var notOk = payload.TryGetValue("ok", out var ok) && IsExplicitFalse(ok);
    if (!failed && !badStatus && !notOk) return null;
    return String(payload, "message") ?? $"Server rejected the message (status {String(payload, "status") ?? "unknown"}).";
  }

  private static bool IsExplicitFalse(object? value)
  {
    var text = Convert.ToString(value);
    return bool.TryParse(text, out var boolean) ? !boolean : text == "0";
  }

  public static MessagePayload ReadMessage(IDictionary<object, object> payload) => new()
  {
    TargetId = String(payload, "targetId") ?? String(payload, "roomId") ?? "",
    SenderId = String(payload, "senderId") ?? ReadNestedString(payload, "sender", "id"),
    SenderName = String(payload, "senderName") ?? String(payload, "username") ?? ReadNestedString(payload, "sender", "name"),
    Content = String(payload, "content") ?? String(payload, "message") ?? ""
  };

  public static UserJoinedPayload ReadUserJoined(IDictionary<object, object> payload) => new()
  {
    RoomId = String(payload, "roomId"),
    TargetId = String(payload, "targetId"),
    SenderName = String(payload, "senderName") ?? ReadNestedString(payload, "sender", "name"),
    Username = String(payload, "username")
  };

  private static string? ReadNestedString(IDictionary<object, object> payload, string objectKey, string valueKey) =>
      payload.TryGetValue(objectKey, out var nested) && FindMap(nested) is { } map ? String(map, valueKey) : null;
}

public sealed class RateLimiter(Func<long>? clock = null)
{
  private readonly Dictionary<string, long> _last = [];
  private readonly Func<long> _clock = clock ?? (() => Environment.TickCount64);
  public bool Consume(string key, int cooldownMs)
  {
    var now = _clock(); if (_last.TryGetValue(key, out var previous) && now - previous < cooldownMs) return false;
    _last[key] = now; return true;
  }
  public void Clear() => _last.Clear();
}

public sealed class ContinuationService(int maxLength, int ttlMs)
{
  private sealed record Pending(Queue<string> Pages, long ExpiresAt);
  private readonly Dictionary<string, Pending> _items = [];
  private static string Key(string room, string? id, string? name) => $"{room}:{(id ?? name ?? "unknown").ToLowerInvariant()}";
  public string Start(string room, string? id, string? name, string text)
  {
    var pages = new Queue<string>(MessageTools.Split(text, maxLength, " (.continue)")); var first = pages.Dequeue();
    if (pages.Count > 0) _items[Key(room, id, name)] = new(pages, Environment.TickCount64 + ttlMs); return first;
  }
  public string Next(string room, string? id, string? name)
  {
    var key = Key(room, id, name); if (!_items.TryGetValue(key, out var pending) || Environment.TickCount64 > pending.ExpiresAt) { _items.Remove(key); return "There is no AI response waiting for you."; }
    var page = pending.Pages.Dequeue(); if (pending.Pages.Count == 0) _items.Remove(key); return page;
  }
  public void ClearAll() => _items.Clear();
}
