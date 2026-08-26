const crypto = require("crypto");

function meaningfulChanges(previous, current) {
  const fields = [
    ["kills", "Kills", 1], ["wins", "Wins", 1], ["xp", "XP", 1000], ["kd_ratio", "K/D", 0.01], ["win_rate_percent", "Win rate", 0.01], ["hours_played", "Hours", 0.1],
  ];
  return fields.flatMap(([field, label, minimum]) => {
    const before = Number(previous?.[field]); const after = Number(current?.[field]);
    if (!Number.isFinite(before) || !Number.isFinite(after) || Math.abs(after - before) < minimum) return [];
    const suffix = field === "win_rate_percent" ? "%" : "";
    return [`${label} ${before}${suffix}→${after}${suffix}`];
  });
}

class BattlefieldCommunityService {
  constructor({ database = null, battlefield, sendMessage, intervalMs = 900000, logger = console }) {
    this.database = database; this.battlefield = battlefield; this.sendMessage = sendMessage; this.intervalMs = intervalMs; this.logger = logger; this.timer = null;
    this.links = new Map((database?.list("battlefield-links") || []).map((entry) => [entry.key, entry.value]));
    this.watches = new Map((database?.list("battlefield-watches") || []).map((entry) => [entry.key, entry.value]));
  }
  userKey(roomId, userId) { return `${roomId}:${String(userId).toLowerCase()}`; }
  link(roomId, userId, userName, eaId) { const key = this.userKey(roomId, userId); const item = { roomId, userId, userName, eaId: this.battlefield.validateEaId(eaId), verified: false, code: crypto.randomBytes(3).toString("hex").toUpperCase(), linkedAt: Date.now(), expiresAt: Date.now() + 86400000 }; this.links.set(key, item); this.database?.set("battlefield-links", key, item); return item; }
  getLink(roomId, userId) { return this.links.get(this.userKey(roomId, userId)) || null; }
  unlink(roomId, userId) { const key = this.userKey(roomId, userId); this.watches.delete(key); this.database?.delete("battlefield-watches", key); this.links.delete(key); return this.database?.delete("battlefield-links", key) || true; }
  verify(code, actor) { const item = [...this.links.values()].find((link) => !link.verified && link.expiresAt > Date.now() && link.code === String(code).toUpperCase()); if (!item) return null; item.verified = true; item.verifiedBy = actor; item.verifiedAt = Date.now(); this.database?.set("battlefield-links", this.userKey(item.roomId, item.userId), item); return item; }
  watch(roomId, userId, userName) { const link = this.getLink(roomId, userId); if (!link?.verified) throw new Error("Verify your Battlefield link before enabling alerts."); const key = this.userKey(roomId, userId); const item = { roomId, userId, userName, eaId: link.eaId, lastFields: null, lastChanges: [], enabled: true, updatedAt: Date.now() }; this.watches.set(key, item); this.database?.set("battlefield-watches", key, item); return item; }
  unwatch(roomId, userId) { const key = this.userKey(roomId, userId); this.watches.delete(key); return this.database?.delete("battlefield-watches", key) || true; }
  changes(roomId, userId) { return this.watches.get(this.userKey(roomId, userId))?.lastChanges || []; }
  async poll() {
    for (const [key, watch] of this.watches) {
      if (!watch.enabled) continue;
      try {
        const data = await this.battlefield.stats(watch.eaId); const fields = data.fields || {};
        const changes = watch.lastFields ? meaningfulChanges(watch.lastFields, fields) : [];
        if (typeof this.battlefield.achievements === "function") {
          const badgeData = await this.battlefield.achievements(watch.eaId);
          const unlocked = (badgeData.badges || []).filter((badge) => badge.unlocked).map((badge) => badge.key);
          if (watch.lastBadges) for (const key of unlocked.filter((badge) => !watch.lastBadges.includes(badge))) changes.push(`Badge unlocked: ${key}`);
          watch.lastBadges = unlocked;
        }
        watch.lastFields = fields; watch.lastChanges = changes; watch.checkedAt = Date.now(); this.database?.set("battlefield-watches", key, watch);
        if (changes.length) await this.sendMessage(watch.roomId, `BF update for ${watch.userName || watch.eaId}: ${changes.join(" • ")}`);
      } catch (error) { this.logger.warn("[battlefield-watch]", { eaId: watch.eaId, error: error.message }); }
    }
  }
  start() { if (this.timer) return; this.timer = setInterval(() => this.poll(), this.intervalMs); if (typeof this.timer.unref === "function") this.timer.unref(); }
  stop() { clearInterval(this.timer); this.timer = null; }
}

module.exports = { BattlefieldCommunityService, meaningfulChanges };
