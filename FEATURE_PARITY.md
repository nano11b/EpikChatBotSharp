# C# conversion parity

The .NET 8 implementation is the supported runtime. This matrix prevents archived JavaScript capabilities from being mistaken for current C# features.

| Area | Status | Notes |
| --- | --- | --- |
| Socket.IO/MessagePack connection | Supported | Multi-room join, acknowledgements, reconnect handling, serialized event processing, and a durable outbox. |
| Command prefix | Supported | `.` is primary; `^` remains a compatibility alias. |
| Trivia, polls, Marbles, loyalty | Supported | Persistent room-scoped state, timers, points, quests, and race seasons. |
| Moderation and room roles | Supported | Ignores, warnings, cases, appeals, mutes, and delegated roles. |
| Community events and schedules | Supported | Events, teams, recurring schedules, and announcements. |
| OpenAI replies and memory | Supported | Optional AI replies, paging, per-user memory controls, and `.profile`. |
| Battlefield stats | Reduced | Stats, badges, saved IDs, and unlinking are supported. Compare/top/watch/verification flows remain archived only. |
| Dashboard | Reduced and hardened | Loopback-only bearer-token UI/API. Archived multi-account sessions, CSRF workflow, and built-in TLS are not ported; use an HTTPS reverse proxy. |
| Backups | Reduced | ZIP create/list/verify is supported. Encrypted archives and interactive restore are not yet ported. |
| Plugins, audit, retention, user preferences | Not ported | Reference implementations remain under `legacy-node/`; they are not loaded by the C# runtime. |

New features should be added to the C# command catalog and tests before this matrix is updated.
