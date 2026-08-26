# EpikChat -> Marbles on Stream bridge

This project now contains a lightweight Marbles roster bridge for EpikChat.

## What it does

When an EpikChat viewer types:

- `!play` - adds their EpikChat display name to `marbles.csv`
- `!marbles` - same as `!play`
- `!leave` - removes their name from the current roster

The bot deduplicates names automatically, so repeatedly typing `!play` does not add duplicate marbles.
Roster writes are queued and atomic; `marbles.csv.state.json` stores stable EpikChat identities while `marbles.csv` remains the human-readable file imported by Marbles.

Streamer/admin commands:

- `.marbles open` - open registrations
- `.marbles close` - close registrations
- `.marbles reset` - erase the roster and open a new registration period
- `.marbles count` - show registration state and player count
- `.marbles help` - show command help

Set your EpikChat username or user ID in `.env` before using the admin commands.

## Marbles setup

This bridge uses Marbles on Stream's **Simulation / Custom Names** workflow rather than trying to impersonate EpikChat users as Twitch accounts.

1. Start the .NET bot with `dotnet run --project EpikChatBot.csproj`.
2. Have EpikChat viewers type `!play`.
3. The generated `marbles.csv` contains one viewer name per line.
4. In Marbles on Stream, open a Simulation race.
5. Enable Custom Names / Add Names, then use the Open/Import option and select `marbles.csv`.
6. Start the simulated race.
7. Before the next race, run `.marbles reset` in EpikChat and collect the next roster.

The exact Marbles menu wording can vary by game version, but the custom-name simulation workflow is the important part.

## Important limitation

This creates **custom-name simulation marbles**. EpikChat viewers are not being authenticated as Twitch/Marbles accounts, so this should not be treated as a way to grant Twitch-linked cosmetics, profile identity, season points, or global leaderboard credit.

For normal season-enabled Twitch races, Marbles officially expects the viewer's own Twitch chat identity to send `!play`.

## Environment options

```env
MARBLES_ENABLED=true
MARBLES_FILE=./marbles.csv
MARBLES_REGISTRATION_OPEN=true
MARBLES_CONFIRM_JOINS=true
MARBLES_JOIN_COMMANDS=!play,!marbles
MARBLES_ADMIN_USERNAMES=your_epikchat_username
MARBLES_ADMIN_IDS=
```

`MARBLES_FILE` can be an absolute path if you want the roster written somewhere convenient on the Windows PC running Marbles, for example:

```env
MARBLES_FILE=C:/Users/YourName/Documents/Marbles/marbles.csv
```

If the .NET bot runs on another PC/server, leave the CSV local there and copy/sync it to the Marbles PC, or point `MARBLES_FILE` at a mounted/shared folder.
