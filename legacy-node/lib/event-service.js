class EventService {
  constructor({ database = null } = {}) {
    this.database = database;
    this.events = new Map((database?.list("community-events") || []).map((entry) => [entry.key, entry.value]));
  }

  save(event) { this.events.set(event.id, event); this.database?.set("community-events", event.id, event); return event; }
  create(roomId, creator, specification) {
    const [title, timeText = ""] = String(specification).split("|").map((part) => part.trim());
    if (!title) throw new Error("Use: ^event create Title|2026-08-22 20:00");
    const startsAt = timeText ? Date.parse(timeText) : NaN;
    if (timeText && !Number.isFinite(startsAt)) throw new Error("Event time could not be parsed.");
    const id = `evt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
    return this.save({ id, roomId: String(roomId), title: title.slice(0, 100), startsAt: Number.isFinite(startsAt) ? startsAt : null, creator, status: "open", participants: {}, createdAt: Date.now(), teams: null });
  }
  get(id) { return this.events.get(String(id)) || null; }
  active(roomId) { return [...this.events.values()].filter((event) => event.roomId === String(roomId) && event.status === "open").sort((a, b) => (a.startsAt || Infinity) - (b.startsAt || Infinity)); }
  join(id, userId, name) { const event = this.get(id); if (!event || event.status !== "open") return null; event.participants[String(userId).toLowerCase()] = { id: userId, name, joinedAt: Date.now() }; return this.save(event); }
  leave(id, userId) { const event = this.get(id); if (!event) return null; delete event.participants[String(userId).toLowerCase()]; return this.save(event); }
  close(id) { const event = this.get(id); if (!event) return null; event.status = "closed"; event.closedAt = Date.now(); return this.save(event); }
  async balance(id, ratingFor) {
    const event = this.get(id); if (!event) return null;
    const rated = await Promise.all(Object.values(event.participants).map(async (player) => ({ ...player, rating: Number(await ratingFor(player)) || 0 })));
    rated.sort((a, b) => b.rating - a.rating);
    const teams = [[], []]; const totals = [0, 0];
    for (const player of rated) { const target = totals[0] <= totals[1] ? 0 : 1; teams[target].push(player); totals[target] += player.rating; }
    event.teams = { a: teams[0], b: teams[1], totals, generatedAt: Date.now() }; this.save(event); return event.teams;
  }
}

module.exports = { EventService };
