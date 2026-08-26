using EpikChatBot.Core;

DotEnv.Load(Path.Combine(Directory.GetCurrentDirectory(), ".env"));

try
{
  var config = BotConfig.Load();
  await using var bot = new BotHost(config);
  using var stopping = new CancellationTokenSource();
  Console.CancelKeyPress += (_, eventArgs) =>
  {
    eventArgs.Cancel = true;
    stopping.Cancel();
  };

  await bot.StartAsync(stopping.Token);
  await Task.Delay(Timeout.Infinite, stopping.Token).ConfigureAwait(ConfigureAwaitOptions.SuppressThrowing);
}
catch (Exception exception)
{
  Console.Error.WriteLine($"[startup error] {exception.Message}");
  Environment.ExitCode = 1;
}
