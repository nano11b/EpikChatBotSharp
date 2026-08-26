const { createJsonStore, readJsonFile } = require("./persistence");

class MarblesSeasonService {
  constructor({ filePath, debounceMs = 100, logger = console, database = null }) {
    const data = readJsonFile(filePath, {}, logger, database);
    this.rooms = data.rooms && typeof data.rooms === "object" ? data.rooms : {};
    this.history = data.history && typeof data.history === "object" ? data.history : {};
    this.writer = createJsonStore({ filePath, delayMs: debounceMs, label: "marbles-seasons", logger, database, getData: () => ({ version: 2, rooms: this.rooms, history: this.history }) });
  }

  get(roomId) { return this.rooms[String(roomId)] || null; }

  start(roomId, name = null) {
    const existing = this.get(roomId);
    if (existing?.active) throw new Error("A Marbles season is already active.");
    const season = { name: name || `Season ${new Date().toISOString().slice(0, 10)}`, active: true, startedAt: Date.now(), endedAt: null, races: [], players: {} };
    this.rooms[String(roomId)] = season;
    this.writer.schedule();
    return season;
  }

  record(roomId, finishers) {
    const season = this.get(roomId);
    if (!season?.active) throw new Error("Start a season before recording a race.");
    const names = [...new Set(finishers.map((name) => String(name).trim()).filter(Boolean))];
    if (names.length < 1) throw new Error("Provide finishers separated by |.");
    const pointsTable = [10, 7, 5, 3, 2, 1];
    const race = { at: Date.now(), finishers: names };
    season.races.push(race);
    names.forEach((name, index) => {
      const key = name.toLowerCase();
      const player = season.players[key] ||= { name, races: 0, wins: 0, podiums: 0, points: 0, bestFinish: null };
      player.name = name;
      player.races += 1;
      if (index === 0) player.wins += 1;
      if (index < 3) player.podiums += 1;
      player.points += pointsTable[index] || 0;
      player.bestFinish = player.bestFinish === null ? index + 1 : Math.min(player.bestFinish, index + 1);
    });
    this.writer.schedule();
    return race;
  }

  leaderboard(roomId, limit = 10) {
    const season = this.get(roomId);
    if (!season) return [];
    return Object.values(season.players).sort((a, b) => b.points - a.points || b.wins - a.wins || a.name.localeCompare(b.name)).slice(0, limit);
  }

  end(roomId) {
    const season = this.get(roomId);
    if (!season?.active) return null;
    season.active = false;
    season.endedAt = Date.now();
    (this.history[String(roomId)] ||= []).push(JSON.parse(JSON.stringify(season)));
    this.writer.schedule();
    return season;
  }

  historyFor(roomId) { return [...(this.history[String(roomId)] || [])]; }

  flush() { return this.writer.flush(); }
}

module.exports = { MarblesSeasonService };
