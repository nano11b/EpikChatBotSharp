class ModerationService {
  constructor({ blockedWords = [], floodLimit = 6, floodWindowMs = 10000, repeatLimit = 3 } = {}) {
    this.blockedWords = blockedWords.map((word) => String(word).trim().toLowerCase()).filter(Boolean);
    this.floodLimit = floodLimit;
    this.floodWindowMs = floodWindowMs;
    this.repeatLimit = repeatLimit;
    this.activity = new Map();
    this.muted = new Map();
  }

  identity(roomId, senderId, senderName) {
    return `${roomId}:${String(senderId || senderName || "unknown").toLowerCase()}`;
  }

  mute(roomId, senderId, durationMs = 300000) {
    this.muted.set(`${roomId}:${String(senderId).toLowerCase()}`, Date.now() + durationMs);
  }

  unmute(roomId, senderId) {
    this.muted.delete(`${roomId}:${String(senderId).toLowerCase()}`);
  }

  check({ roomId, senderId, senderName, content, linksAllowed = true }) {
    const key = this.identity(roomId, senderId, senderName);
    const now = Date.now();
    const mutedUntil = this.muted.get(key) || 0;
    if (mutedUntil > now) return { allowed: false, reason: "muted" };
    if (mutedUntil) this.muted.delete(key);

    const normalized = String(content || "").trim().toLowerCase();
    if (this.blockedWords.some((word) => normalized.includes(word))) return { allowed: false, reason: "blocked-word" };
    if (!linksAllowed && /https?:\/\/|www\./i.test(normalized)) return { allowed: false, reason: "link" };

    const record = this.activity.get(key) || { messages: [], last: "", repeats: 0 };
    record.messages = record.messages.filter((timestamp) => now - timestamp < this.floodWindowMs);
    record.messages.push(now);
    record.repeats = record.last === normalized ? record.repeats + 1 : 1;
    record.last = normalized;
    this.activity.set(key, record);
    if (record.messages.length > this.floodLimit) return { allowed: false, reason: "flood" };
    if (record.repeats > this.repeatLimit) return { allowed: false, reason: "repeat" };
    return { allowed: true };
  }

  prune() {
    const now = Date.now();
    for (const [key, record] of this.activity) {
      if (!record.messages.some((timestamp) => now - timestamp < this.floodWindowMs)) this.activity.delete(key);
    }
    for (const [key, until] of this.muted) if (until <= now) this.muted.delete(key);
  }
}

module.exports = { ModerationService };
