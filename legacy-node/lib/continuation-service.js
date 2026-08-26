const DEFAULT_SUFFIX = " … (^continue)";

function splitMessage(value, maxLength = 250, suffix = "") {
  const text = String(value || "").trim();
  if (!text) return [];
  if (text.length <= maxLength) return [text];
  if (suffix.length >= maxLength) throw new Error("Continuation suffix must be shorter than the message limit.");

  const chunks = [];
  let remaining = text;
  while (remaining.length > maxLength) {
    const budget = maxLength - suffix.length;
    const candidate = remaining.slice(0, budget + 1);
    const minimumBreak = Math.floor(budget * 0.6);
    let breakAt = Math.max(candidate.lastIndexOf("\n", budget), candidate.lastIndexOf(" ", budget));
    if (breakAt < minimumBreak) breakAt = budget;
    const chunk = remaining.slice(0, breakAt).trimEnd();
    chunks.push(`${chunk}${suffix}`);
    remaining = remaining.slice(breakAt).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

class ContinuationService {
  constructor({ maxLength = 250, ttlMs = 600000, suffix = DEFAULT_SUFFIX, now = Date.now } = {}) {
    this.maxLength = maxLength;
    this.ttlMs = ttlMs;
    this.suffix = suffix;
    this.now = now;
    this.pending = new Map();
  }

  key(roomId, senderId, senderName) {
    return `${roomId}:${String(senderId || senderName || "unknown").trim().toLowerCase()}`;
  }

  start(roomId, senderId, senderName, message) {
    const key = this.key(roomId, senderId, senderName);
    const pages = splitMessage(message, this.maxLength, this.suffix);
    this.pending.delete(key);
    if (pages.length > 1) this.pending.set(key, { pages: pages.slice(1), expiresAt: this.now() + this.ttlMs });
    return pages[0] || "";
  }

  next(roomId, senderId, senderName) {
    const key = this.key(roomId, senderId, senderName);
    const entry = this.pending.get(key);
    if (!entry || entry.expiresAt <= this.now()) {
      this.pending.delete(key);
      return { ok: false, message: "There is no AI response to continue." };
    }
    const message = entry.pages.shift();
    entry.expiresAt = this.now() + this.ttlMs;
    if (!entry.pages.length) this.pending.delete(key);
    return { ok: true, message, remaining: entry.pages.length };
  }

  clear(roomId, senderId, senderName) {
    return this.pending.delete(this.key(roomId, senderId, senderName));
  }

  clearAll() { this.pending.clear(); }
}

module.exports = { ContinuationService, DEFAULT_SUFFIX, splitMessage };
