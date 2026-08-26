namespace EpikChatBot.Services;

public sealed record PollOption(string Label)
{
  public HashSet<string> Votes { get; } = [];
}

public sealed class Poll
{
  public required string RoomId { get; init; }

  public required string Question { get; init; }

  public required List<PollOption> Options { get; init; }

  public required CancellationTokenSource Timer { get; init; }

  public Dictionary<string, int> UserVotes { get; } = [];
}

public sealed class PollService(Func<string, string, Task> sendMessage, Func<Func<Task>, Task>? dispatch = null)
{
  private readonly Func<string, string, Task> _sendMessage = sendMessage;
  private readonly Func<Func<Task>, Task> _dispatch = dispatch ?? (action => action());

  public Dictionary<string, Poll> Polls { get; } = [];

  public Poll Create(string room, string question, IEnumerable<string> labels, int durationMs)
  {
    if (Polls.Remove(room, out var previous))
    {
      previous.Timer.Cancel();
    }

    var cancellation = new CancellationTokenSource();
    var poll = new Poll
    {
      RoomId = room,
      Question = question,
      Options = [.. labels.Take(10).Select(x => new PollOption(x))],
      Timer = cancellation,
    };
    Polls[room] = poll;
    _ = RunTimerAsync(room, durationMs, cancellation.Token);
    return poll;
  }

  public (bool Ok, string Reason, PollOption? Option) Vote(string room, string user, string selection)
  {
    if (!Polls.TryGetValue(room, out var poll))
    {
      return (false, "no-poll", null);
    }

    var index = int.TryParse(selection, out var number)
        ? number - 1
        : poll.Options.FindIndex(x => x.Label.Equals(selection, StringComparison.OrdinalIgnoreCase));
    if (index < 0 || index >= poll.Options.Count)
    {
      return (false, "invalid", null);
    }

    if (poll.UserVotes.TryGetValue(user, out var old))
    {
      poll.Options[old].Votes.Remove(user);
    }

    poll.UserVotes[user] = index;
    poll.Options[index].Votes.Add(user);
    return (true, "", poll.Options[index]);
  }

  public string Format(Poll poll) =>
      $"{poll.Question} {string.Join(" • ", poll.Options.Select((option, index) => $"{index + 1}) {option.Label} [{option.Votes.Count}]"))}";

  public async Task<Poll?> CloseAsync(string room)
  {
    if (!Polls.Remove(room, out var poll))
    {
      return null;
    }

    poll.Timer.Cancel();
    await _sendMessage(room, $"Poll closed: {Format(poll)}");
    return poll;
  }

  public void StopAll()
  {
    foreach (var poll in Polls.Values)
    {
      poll.Timer.Cancel();
    }

    Polls.Clear();
  }

  private async Task RunTimerAsync(string room, int durationMs, CancellationToken cancellationToken)
  {
    try
    {
      await Task.Delay(durationMs, cancellationToken);
      await _dispatch(() => CloseAsync(room));
    }
    catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { }
    catch (Exception exception)
    {
      Console.Error.WriteLine($"[poll] Unable to close poll in {room}: {exception.Message}");
    }
  }
}
