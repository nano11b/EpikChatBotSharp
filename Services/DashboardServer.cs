using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Threading.RateLimiting;
using EpikChatBot.Core;

namespace EpikChatBot.Services;

public sealed class DashboardServer(
    BotConfig config,
    Func<string?, Task<object>> getStatus,
    Func<string, string, string, Task<object>> setSetting,
    Func<string, string, Task<object>> runAction) : IAsyncDisposable
{
  private const long MaximumRequestBytes = 16 * 1024;
  private WebApplication? _app;

  public async Task StartAsync(CancellationToken cancellationToken)
  {
    if (!config.DashboardEnabled)
    {
      return;
    }

    if (Encoding.UTF8.GetByteCount(config.DashboardToken) < 32)
    {
      throw new InvalidOperationException("DASHBOARD_TOKEN must contain at least 32 UTF-8 bytes when the dashboard is enabled.");
    }

    var host = LoopbackHost(config.DashboardHost);
    if (!host.Equals(config.DashboardHost, StringComparison.OrdinalIgnoreCase))
    {
      Console.Error.WriteLine($"[dashboard] Refusing non-loopback host '{config.DashboardHost}'; binding to {host}. Use an HTTPS reverse proxy for remote access.");
    }

    var builder = WebApplication.CreateSlimBuilder();
    builder.WebHost.UseUrls($"http://{host}:{config.DashboardPort}");
    builder.Services.AddRateLimiter(options =>
    {
      options.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
      options.GlobalLimiter = PartitionedRateLimiter.Create<HttpContext, string>(context =>
              RateLimitPartition.GetFixedWindowLimiter(
                  context.Connection.RemoteIpAddress?.ToString() ?? "local",
                  _ => new FixedWindowRateLimiterOptions
                  {
                    PermitLimit = 60,
                    QueueLimit = 0,
                    Window = TimeSpan.FromMinutes(1),
                  }));
    });

    _app = builder.Build();
    _app.Use(async (context, next) =>
    {
      context.Response.Headers.XContentTypeOptions = "nosniff";
      context.Response.Headers.XFrameOptions = "DENY";
      context.Response.Headers["Referrer-Policy"] = "no-referrer";
      context.Response.Headers.ContentSecurityPolicy = "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'";
      if (context.Request.ContentLength > MaximumRequestBytes)
      {
        context.Response.StatusCode = StatusCodes.Status413PayloadTooLarge;
        return;
      }

      await next();
    });
    _app.UseRateLimiter();

    _app.MapGet("/health", () => Results.Json(new { status = "ok" }));
    _app.MapGet("/", () => Results.Content(Html, "text/html", Encoding.UTF8));
    _app.MapGet("/api/status", async (HttpRequest request) =>
        Authorized(request) ? Results.Json(await getStatus(request.Query["room"])) : Results.Unauthorized());
    _app.MapPost("/api/settings", async (HttpRequest request) =>
    {
      if (!Authorized(request))
      {
        return Results.Unauthorized();
      }

      var body = await request.ReadFromJsonAsync<SettingRequest>(cancellationToken: cancellationToken);
      return body is null ? Results.BadRequest() : Results.Json(await setSetting(body.RoomId, body.Path, body.Value));
    });
    _app.MapPost("/api/action", async (HttpRequest request) =>
    {
      if (!Authorized(request))
      {
        return Results.Unauthorized();
      }

      var body = await request.ReadFromJsonAsync<ActionRequest>(cancellationToken: cancellationToken);
      return body is null ? Results.BadRequest() : Results.Json(await runAction(body.RoomId, body.Action));
    });

    await _app.StartAsync(cancellationToken);
    Console.WriteLine($"[dashboard] http://{host}:{config.DashboardPort}");
  }

  internal static string LoopbackHost(string host)
  {
    if (host.Equals("localhost", StringComparison.OrdinalIgnoreCase))
    {
      return "localhost";
    }

    return IPAddress.TryParse(host, out var address) && IPAddress.IsLoopback(address)
        ? host
        : "127.0.0.1";
  }

  private bool Authorized(HttpRequest request)
  {
    const string bearer = "Bearer ";
    var header = request.Headers.Authorization.ToString();
    if (!header.StartsWith(bearer, StringComparison.OrdinalIgnoreCase))
    {
      return false;
    }

    var supplied = Encoding.UTF8.GetBytes(header[bearer.Length..]);
    var expected = Encoding.UTF8.GetBytes(config.DashboardToken);
    return supplied.Length == expected.Length && CryptographicOperations.FixedTimeEquals(supplied, expected);
  }

  public async ValueTask DisposeAsync()
  {
    if (_app is not null)
    {
      await _app.StopAsync();
      await _app.DisposeAsync();
    }
  }

  private sealed record SettingRequest(string RoomId, string Path, string Value);

  private sealed record ActionRequest(string RoomId, string Action);

  private const string Html = """<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>EpikChat Bot</title><style>body{font:16px system-ui;max-width:900px;margin:2rem auto;padding:0 1rem;background:#10151d;color:#e8eef7}button,input,select{font:inherit;padding:.5rem;margin:.25rem}pre{background:#1b2430;padding:1rem;overflow:auto;border-radius:.5rem}</style></head><body><h1>EpikChat Bot</h1><input id="token" type="password" placeholder="Dashboard token"><input id="room" placeholder="Room ID"><button onclick="refresh()">Refresh</button><pre id="status">Enter token and refresh.</pre><script>async function refresh(){const r=await fetch('/api/status?room='+encodeURIComponent(room.value),{headers:{authorization:'Bearer '+token.value}});status.textContent=JSON.stringify(await r.json(),null,2)}</script></body></html>""";
}
