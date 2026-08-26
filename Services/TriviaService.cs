using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;
using EpikChatBot.Core;

namespace EpikChatBot.Services;

public sealed record TriviaQuestion
{
  public string Question { get; set; } = ""; public string Answer { get; set; } = ""; public List<string> AcceptedAnswers { get; set; } = [];
  public string Category { get; set; } = ""; public string Difficulty { get; set; } = "medium"; public List<string> Choices { get; set; } = []; public string Hint { get; set; } = ""; public bool Enabled { get; set; } = true;
}
public sealed record TriviaScore { public string Name { get; set; } = ""; public int Score { get; set; } public long? FastestMs { get; set; } public int MaxStreak { get; set; } }
public sealed record CommandResult(string? Reply = null, bool AdvanceTrivia = false);

public sealed partial class TriviaService
{
  public sealed class State
  {
    public bool Active; public TriviaQuestion? Current; public long AskedAt; public Dictionary<string, TriviaScore> Scores = []; public Queue<TriviaQuestion> Pool = [];
    public Dictionary<string, int> Attempts = []; public Dictionary<string, int> Streaks = []; public int Limit = 10; public int Asked; public string? Category; public string? Difficulty; public CancellationTokenSource? Timer;
  }
  private readonly BotConfig _config; private readonly Func<string, string?, string?, bool> _isAdmin; private readonly Func<string, string, Task> _send;
  private readonly Func<string, RoomSettings> _settings; private readonly Action<string, string?, string?, int> _reward; private readonly Random _random; private readonly Func<Func<Task>, Task> _dispatch;
  private readonly Dictionary<string, State> _states = []; public List<TriviaQuestion> Questions { get; private set; }

  public TriviaService(BotConfig config, Func<string, string?, string?, bool> isAdmin, Func<string, string, Task> send, Func<string, RoomSettings> settings, Action<string, string?, string?, int> reward, Random? random = null, Func<Func<Task>, Task>? dispatch = null)
  { _config = config; _isAdmin = isAdmin; _send = send; _settings = settings; _reward = reward; _random = random ?? Random.Shared; _dispatch = dispatch ?? (action => action()); Questions = LoadQuestions(); LoadScores(); }

  public static string NormalizeAnswer(string? value)
  {
    var normalized = (value ?? "").Normalize(NormalizationForm.FormD); var builder = new StringBuilder();
    foreach (var character in normalized) if (CharUnicodeInfo.GetUnicodeCategory(character) != UnicodeCategory.NonSpacingMark) builder.Append(char.IsLetterOrDigit(character) || char.IsWhiteSpace(character) ? char.ToLowerInvariant(character) : ' ');
    return MyRegex().Replace(builder.ToString(), " ").Trim();
  }
  public static int DamerauLevenshtein(string left, string right)
  {
    var matrix = new int[left.Length + 1, right.Length + 1]; for (var i = 0; i <= left.Length; i++) matrix[i, 0] = i; for (var j = 0; j <= right.Length; j++) matrix[0, j] = j;
    for (var i = 1; i <= left.Length; i++) for (var j = 1; j <= right.Length; j++) { var cost = left[i - 1] == right[j - 1] ? 0 : 1; matrix[i, j] = Math.Min(Math.Min(matrix[i - 1, j] + 1, matrix[i, j - 1] + 1), matrix[i - 1, j - 1] + cost); if (i > 1 && j > 1 && left[i - 1] == right[j - 2] && left[i - 2] == right[j - 1]) matrix[i, j] = Math.Min(matrix[i, j], matrix[i - 2, j - 2] + cost); }
    return matrix[left.Length, right.Length];
  }
  private static bool Fuzzy(string left, string right) { var length = Math.Max(left.Length, right.Length); var edits = length >= 8 ? 2 : length >= 4 ? 1 : 0; return Math.Abs(left.Length - right.Length) <= edits && DamerauLevenshtein(left, right) <= edits; }
  public static bool IsAnswerMatch(string guess, TriviaQuestion question)
  {
    var normalized = NormalizeAnswer(guess); if (normalized.Length == 0) return false;
    foreach (var candidateValue in new[] { question.Answer }.Concat(question.AcceptedAnswers)) { var candidate = NormalizeAnswer(candidateValue); if (normalized == candidate || Fuzzy(normalized.Replace(" ", ""), candidate.Replace(" ", ""))) return true; var minimum = Math.Max(5, (int)Math.Ceiling(candidate.Replace(" ", "").Length * .45)); if (normalized.Replace(" ", "").Length >= minimum && normalized.Split(' ').All(g => candidate.Split(' ').Any(c => Fuzzy(g, c)))) return true; }
    return false;
  }
  private List<TriviaQuestion> LoadQuestions()
  {
    if (!File.Exists(_config.TriviaFile)) JsonStore.WriteAsync(_config.TriviaFile, DefaultQuestions).GetAwaiter().GetResult();
    return [.. JsonStore.Read(_config.TriviaFile, new List<TriviaQuestion>()).Where(x => x.Question.Length > 0 && x.Answer.Length > 0)];
  }
  private void LoadScores()
  {
    if (!File.Exists(_config.TriviaScoreFile)) return; try { using var document = System.Text.Json.JsonDocument.Parse(File.ReadAllText(_config.TriviaScoreFile)); var root = document.RootElement; if (root.TryGetProperty("rooms", out var rooms)) foreach (var room in rooms.EnumerateObject()) GetState(room.Name).Scores = System.Text.Json.JsonSerializer.Deserialize<Dictionary<string, TriviaScore>>(room.Value, JsonStore.Options) ?? []; else { var legacy = new Dictionary<string, TriviaScore>(); foreach (var score in root.EnumerateObject()) legacy[score.Name.ToLowerInvariant()] = score.Value.ValueKind == System.Text.Json.JsonValueKind.Number ? new TriviaScore { Name = score.Name, Score = score.Value.GetInt32() } : System.Text.Json.JsonSerializer.Deserialize<TriviaScore>(score.Value, JsonStore.Options) ?? new TriviaScore { Name = score.Name }; GetState(_config.RoomId.Length > 0 ? _config.RoomId : "__legacy__").Scores = legacy; } } catch (Exception exception) { JsonStore.QuarantineCorruptFile(_config.TriviaScoreFile, exception); }
  }
  public State GetState(string room) { if (!_states.TryGetValue(room, out var state)) { if (room != "__legacy__" && _states.Remove("__legacy__", out state)) _states[room] = state; else _states[room] = state = new(); } return state; }
  private TriviaSettings Options(string room) => _settings(room).Trivia;
  private void Refill(State state)
  {
    if (state.Pool.Count > 0) return; var candidates = Questions.Where(x => x.Enabled && (state.Category is null || x.Category.Equals(state.Category, StringComparison.OrdinalIgnoreCase)) && (state.Difficulty is null || x.Difficulty.Equals(state.Difficulty, StringComparison.OrdinalIgnoreCase))).OrderBy(_ => _random.Next()).ToList(); foreach (var item in candidates) state.Pool.Enqueue(item);
  }
  private static string Scoreboard(State state) => state.Scores.Count == 0 ? "No trivia points yet. Start answering to build the scoreboard." : $"Trivia scoreboard: {string.Join(" • ", state.Scores.Values.OrderByDescending(x => x.Score).Take(5).Select(x => $"{x.Name}: {x.Score}"))}";
  public CommandResult Start(string room, string? senderId, string? senderName, string options = "")
  {
    if (_config.TriviaAdminControls && !_isAdmin(room, senderId, senderName)) return new("Trivia start is admin-only."); var state = GetState(room); if (state.Active) return new("Trivia is already running! Answer with .answer <your guess>.");
    var tokens = options.ToLowerInvariant().Split(' ', StringSplitOptions.RemoveEmptyEntries); var categories = Questions.Select(x => x.Category.ToLowerInvariant()).ToHashSet(); state.Category = tokens.FirstOrDefault(categories.Contains); state.Difficulty = tokens.FirstOrDefault(x => x is "easy" or "medium" or "hard"); state.Limit = tokens.Select(x => int.TryParse(x, out var n) ? n : 0).FirstOrDefault(x => x > 0) is var count && count > 0 ? Math.Min(count, 100) : Math.Clamp(Options(room).QuestionCount, 1, 100);
    state.Active = true; state.Current = null; state.Pool.Clear(); state.Attempts.Clear(); state.Streaks.Clear(); state.Asked = 0; if (_config.TriviaScoreMode == "session") state.Scores.Clear(); return new(null, true);
  }
  public CommandResult Stop(string room, string? id, string? name)
  {
    if (_config.TriviaAdminControls && !_isAdmin(room, id, name)) return new("Trivia stop is admin-only."); var state = GetState(room); if (!state.Active) return new("Trivia is not currently running."); state.Active = false; state.Current = null; state.Timer?.Cancel(); return new($"Trivia stopped. {Scoreboard(state)}");
  }
  public async Task AdvanceAsync(string room)
  {
    var state = GetState(room); state.Timer?.Cancel(); if (state.Asked >= state.Limit) { state.Active = false; state.Current = null; await _send(room, $"Trivia round complete! {Scoreboard(state)}"); return; }
    Refill(state); if (state.Pool.Count == 0) { state.Active = false; await _send(room, $"That's all the trivia I have for now. {Scoreboard(state)}"); return; }
    state.Current = state.Pool.Dequeue(); state.Asked++; state.AskedAt = Environment.TickCount64; state.Attempts.Clear(); var options = Options(room); state.Timer = new(); var token = state.Timer.Token;
    var choices = state.Current.Choices.Count > 0 ? " " + string.Join(" • ", state.Current.Choices.Select((x, i) => $"{(char)('A' + i)}) {x}")) : "";
    await _send(room, $"Trivia time! {state.Current.Question}{(state.Current.Category.Length > 0 ? $" ({state.Current.Category})" : "")}{choices} Reply with .answer <your answer>. You get {options.Attempts} attempts.");
    _ = ExpireAsync(room, state.Current, Math.Clamp(options.TimeMs, 5000, 300000), token); if (options.HintMs > 0 && options.HintMs < options.TimeMs) _ = HintAsync(room, state.Current, options.HintMs, token);
  }
  private async Task HintAsync(string room, TriviaQuestion question, int delay, CancellationToken token) { try { await Task.Delay(delay, token); await _dispatch(async () => { var state = GetState(room); if (!state.Active || !ReferenceEquals(state.Current, question)) return; var hint = question.Hint.Length > 0 ? question.Hint : string.Join(' ', question.Answer.Split(' ').Select(x => x[0] + new string('_', Math.Max(0, x.Length - 1)))); await _send(room, $"Hint: {hint}"); }); } catch (OperationCanceledException) when (token.IsCancellationRequested) { } catch (Exception exception) { Console.Error.WriteLine($"[trivia] Hint failed in {room}: {exception.Message}"); } }
  private async Task ExpireAsync(string room, TriviaQuestion question, int delay, CancellationToken token) { try { await Task.Delay(delay, token); await _dispatch(async () => { var state = GetState(room); if (!state.Active || !ReferenceEquals(state.Current, question)) return; state.Current = null; state.Streaks.Clear(); await _send(room, $"Time's up! The correct answer was {question.Answer}. {Scoreboard(state)}"); if (state.Active) await AdvanceAsync(room); }); } catch (OperationCanceledException) when (token.IsCancellationRequested) { } catch (Exception exception) { Console.Error.WriteLine($"[trivia] Expiration failed in {room}: {exception.Message}"); } }
  public CommandResult Answer(string room, string? id, string? name, string guess)
  {
    var state = GetState(room); if (!state.Active || state.Current is null) return new("There isn't an active trivia question right now. Use .trivia start to begin."); var normalized = NormalizeAnswer(guess); if (normalized.Length == 0) return new("Please provide an answer after .answer.");
    if (state.Current.Choices.Count > 0) { var index = normalized.Length == 1 && char.IsLetter(normalized[0]) ? normalized[0] - 'a' : int.TryParse(normalized, out var number) ? number - 1 : -1; if (index >= 0 && index < state.Current.Choices.Count) normalized = state.Current.Choices[index]; }
    var identity = (id ?? name ?? "friend").ToLowerInvariant(); var used = state.Attempts.GetValueOrDefault(identity); var limit = Math.Clamp(Options(room).Attempts, 1, 20); if (used >= limit) return new($"{name}, you've used all {limit} attempts for this question.");
    if (IsAnswerMatch(normalized, state.Current)) { state.Timer?.Cancel(); var elapsed = Environment.TickCount64 - state.AskedAt; var previous = state.Scores.GetValueOrDefault(identity) ?? new TriviaScore { Name = name ?? "friend" }; var streak = state.Streaks.GetValueOrDefault(identity) + 1; state.Streaks[identity] = streak; var speed = Options(room).SpeedBonusMs > 0 && elapsed <= Options(room).SpeedBonusMs ? 1 : 0; var streakBonus = streak % 3 == 0 ? 1 : 0; var points = 1 + speed + streakBonus; previous.Score += points; previous.FastestMs = Math.Min(previous.FastestMs ?? elapsed, elapsed); previous.MaxStreak = Math.Max(previous.MaxStreak, streak); state.Scores[identity] = previous; var answer = state.Current.Answer; state.Current = null; _reward(room, id, name, points); return new($"Correct, {name ?? "friend"}! {answer} is right. +{points} point{(points == 1 ? "" : "s")}. {Scoreboard(state)}", state.Active); }
    state.Attempts[identity] = ++used; state.Streaks[identity] = 0; return used >= limit ? new($"Not quite, {name}. You've used all {limit} attempts for this question.") : new($"Not quite, {name}. Try again! You have {limit - used} attempt{(limit - used == 1 ? "" : "s")} left.");
  }
  public CommandResult Handle(string room, string? id, string? name, string command, string text)
  {
    if (command == "answer") return Answer(room, id, name, text); var parts = text.Trim().Split(' ', 2, StringSplitOptions.RemoveEmptyEntries); var action = parts.ElementAtOrDefault(0)?.ToLowerInvariant() ?? ""; var args = parts.ElementAtOrDefault(1) ?? "";
    return action switch { "start" => Start(room, id, name, args), "stop" => Stop(room, id, name), "score" or "leaderboard" => new(Scoreboard(GetState(room))), "categories" => new($"Trivia categories: {string.Join(", ", Questions.Where(x => x.Enabled).Select(x => x.Category).Where(x => x.Length > 0).Distinct().Order())}."), "help" or "" => new("Trivia commands: .trivia start [category] [difficulty] [count], .trivia stop, .trivia score, .trivia categories, .answer <guess>."), _ => new("Trivia command not recognized. Use .trivia help.") };
  }
  public async Task<TriviaQuestion> AddQuestionAsync(string specification) { var parts = specification.Split('|').Select(x => x.Trim()).Concat(Enumerable.Repeat("", 6)).Take(6).ToArray(); if (parts[0].Length == 0 || parts[1].Length == 0) throw new ArgumentException("Use: question|answer|category|difficulty|alias1,alias2|choice1,choice2"); var item = new TriviaQuestion { Question = parts[0], Answer = parts[1], Category = parts[2].Length > 0 ? parts[2] : "general", Difficulty = sourceArray.Contains(parts[3].ToLowerInvariant()) ? parts[3].ToLowerInvariant() : "medium", AcceptedAnswers = [.. parts[4].Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)], Choices = [.. parts[5].Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)] }; Questions.Add(item); await SaveQuestionsAsync(); return item; }
  public async Task<TriviaQuestion?> RemoveQuestionAsync(int index) { if (index < 1 || index > Questions.Count) return null; var item = Questions[index - 1]; Questions.RemoveAt(index - 1); await SaveQuestionsAsync(); return item; }
  public async Task<TriviaQuestion?> SetEnabledAsync(int index, bool enabled) { if (index < 1 || index > Questions.Count) return null; Questions[index - 1].Enabled = enabled; await SaveQuestionsAsync(); return Questions[index - 1]; }
  public Task SaveQuestionsAsync() => JsonStore.WriteAsync(_config.TriviaFile, Questions);
  public async Task FlushAsync() => await JsonStore.WriteAsync(_config.TriviaScoreFile, new ScoreFile { Rooms = _states.ToDictionary(x => x.Key, x => x.Value.Scores) });
  public void StopAll() { foreach (var state in _states.Values) { state.Active = false; state.Current = null; state.Timer?.Cancel(); } }
  private sealed record ScoreFile { public int Version { get; init; } = 1; public Dictionary<string, Dictionary<string, TriviaScore>> Rooms { get; init; } = []; }
  private static readonly List<TriviaQuestion> DefaultQuestions = [new() { Question = "What is the largest planet in our solar system?", Answer = "jupiter" }, new() { Question = "Which planet is known as the Red Planet?", Answer = "mars" }, new() { Question = "What is the capital city of France?", Answer = "paris" }];
  private static readonly string[] sourceArray = ["easy", "medium", "hard"];

  [GeneratedRegex(@"\s+")]
  private static partial Regex MyRegex();
}
