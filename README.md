# EpikChat Bot (.NET)

An EpikChat room bot implemented in C# on .NET 8. It connects over Socket.IO with MessagePack, joins every authorized room, provides deterministic community commands, and optionally uses the OpenAI Responses API.

## Requirements and setup

1. Install the [.NET 8 SDK](https://dotnet.microsoft.com/download/dotnet/8.0) or newer.
2. Copy `.env.example` to `.env` and configure `BOT_TOKEN`.
3. Add `OPENAI_API_KEY` if AI replies are wanted. All deterministic features work without it.
4. Build, test, and run:

```powershell
dotnet restore EpikChatBot.slnx
dotnet test EpikChatBot.slnx --configuration Release
dotnet run --project EpikChatBot.csproj
```

Press Ctrl+C for a clean shutdown. State is flushed, SQLite is checkpointed, timers are stopped, and the socket is disconnected.

## Features

- Room-scoped trivia with fuzzy answer matching, choices, categories, difficulty, hints, bounded rounds, streaks, and persistent scores.
- Marbles on Stream roster bridge using `!play`, `!marbles`, `!leave`, and host controls under `.marbles`.
- OpenAI replies with stable per-user memory and `.continue` paging for EpikChat's 250-character message limit.
- Loyalty points, levels, achievements, daily bonuses, quests, and leaderboards.
- Timed polls, community events, Marbles seasons/race standings, moderation, temporary mutes, warnings, cases, appeals, room roles, and ignore rules.
- Battlefield 6 player statistics, saved EA IDs, and badges through the configured stats API.
- Durable schedules, SQLite-backed outgoing-message outbox, ZIP backups, per-room settings, a token-protected dashboard, and health/metrics responses.
- Compatibility with the existing `.env`, JSON snapshots, `trivia.json`, `marbles.csv`, and `bot-state.sqlite` data.

## Commands

Viewer commands include `.help`, `.ping`, `.profile`, `.ask`, `.trivia`, `.answer`, `.continue`, `.points`, `.progress`, `.quests`, `.daily`, `.leaderboard`, `.memory`, `.vote`, `.bf`, `.event`, `.season`, `!play`, and `!leave`.

`.help` groups commands under general, AI, rewards, games, community, and staff headings. Use `.help <category>` (for example, `.help games`) to show one category.

`.` is the primary command prefix. The former `^` prefix remains accepted as a compatibility alias.

Host, moderator, and owner commands include `.question`, `.poll`, `.event create|teams|close`, `.season start|end`, `.race`, `.schedule`, `.mod`, `.warn`, `.case`, `.ignore`, `.role`, `.config`, `.backup`, `.outbox`, and `.metrics`.

Room roles are `viewer`, `host`, `moderator`, and `owner`. Bootstrap owners through `MARBLES_ADMIN_IDS` or `MARBLES_ADMIN_USERNAMES` in `.env`.

## Dashboard

Set `DASHBOARD_ENABLED=true` and configure a random `DASHBOARD_TOKEN` of at least 32 bytes. The listener is restricted to loopback at `http://127.0.0.1:8787`; non-loopback host settings are rejected and safely remapped to loopback.

- `/health` is public and suitable for a local health check.
- `/` provides a compact status UI.
- `/api/status`, `/api/settings`, and `/api/action` require `Authorization: Bearer <DASHBOARD_TOKEN>`.

Use an authenticated HTTPS reverse proxy if remote dashboard access is required. The server also applies rate limiting, a 16 KiB request limit, constant-time token checks, and restrictive browser security headers.

## Data and migration

The C# implementation retains the original data formats. Existing versioned JSON wrappers are imported and written in compatible shapes, while new operational records use the existing SQLite `records` table. SQLite uses WAL mode, foreign keys, a five-second busy timeout, and a clean checkpoint on shutdown.

The old JavaScript implementation is archived under `legacy-node/` as migration reference. It is no longer the primary runtime, build, test, editor, or CI path; `EpikChatBot.csproj`, `Program.cs`, `Core/`, and `Services/` are authoritative. See [FEATURE_PARITY.md](./FEATURE_PARITY.md) for the explicit conversion status.

Back up `.env`, the SQLite database, JSON state, `trivia.json`, and the Marbles files before the first production cutover. `.backup create` writes a ZIP bundle under `backups/`.

## Development

```powershell
dotnet build EpikChatBot.slnx --configuration Release
dotnet test EpikChatBot.slnx --configuration Release
dotnet publish EpikChatBot.csproj --configuration Release --output publish
dotnet list EpikChatBot.csproj package --vulnerable --include-transitive
```

- `Program.cs` — startup and graceful cancellation.
- `Core/BotHost.cs` — Socket.IO lifecycle, routing, acknowledged delivery, and shutdown.
- `Core/BotConfig.cs` — `.env` configuration and defaults.
- `Core/StateDatabase.cs` — SQLite persistence.
- `Services/TriviaService.cs` — trivia engine and question administration.
- `Services/CommunityServices.cs` — schedules, cases, events, seasons, ignores, and backups.
- `Services/ExternalServices.cs` — OpenAI and Battlefield integrations.
- `tests-csharp/` — native xUnit tests.
- `legacy-node/` — archived JavaScript implementation; excluded from the .NET build.

See [README_MARBLES.md](./README_MARBLES.md) for the Marbles import workflow.
