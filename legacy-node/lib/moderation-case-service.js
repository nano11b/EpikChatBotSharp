class ModerationCaseService {
  constructor({ database = null } = {}) {
    this.database = database;
    this.cases = new Map((database?.list("moderation-cases") || []).map((entry) => [entry.key, entry.value]));
  }

  create({ roomId, userId, userName = null, actorId, actorName, reason, action = "warning", durationMs = 0 }) {
    if (!userId || !reason) throw new Error("A user ID and reason are required.");
    const id = `case-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const item = { id, roomId: String(roomId), userId: String(userId).toLowerCase(), userName, actorId, actorName, reason: String(reason).slice(0, 500), action, durationMs, status: "open", createdAt: Date.now(), notes: [], appeal: null };
    this.cases.set(id, item); this.database?.set("moderation-cases", id, item); return item;
  }

  save(item) { this.cases.set(item.id, item); this.database?.set("moderation-cases", item.id, item); return item; }
  get(id) { return this.cases.get(String(id)) || null; }
  list(roomId, userId = null, limit = 10) { return [...this.cases.values()].filter((item) => String(item.roomId) === String(roomId) && (!userId || item.userId === String(userId).toLowerCase())).sort((a, b) => b.createdAt - a.createdAt).slice(0, limit); }
  note(id, actor, text) { const item = this.get(id); if (!item) return null; item.notes.push({ actor, text: String(text).slice(0, 500), at: Date.now() }); return this.save(item); }
  appeal(roomId, userId, text) { const item = this.list(roomId, userId, 20).find((entry) => entry.status === "open"); if (!item) return null; item.appeal = { text: String(text).slice(0, 500), at: Date.now(), status: "pending" }; return this.save(item); }
  resolve(id, actor, decision = "resolved") { const item = this.get(id); if (!item) return null; item.status = decision; item.resolvedBy = actor; item.resolvedAt = Date.now(); if (item.appeal) item.appeal.status = decision; return this.save(item); }
}

module.exports = { ModerationCaseService };
