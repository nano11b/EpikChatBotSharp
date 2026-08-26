function normalize(value) { return String(value || "").trim().toLowerCase(); }

class IgnoreService {
  constructor({ database = null, defaultIds = new Set(), defaultUsernames = new Set() } = {}) {
    this.database = database;
    this.rules = new Map();
    for (const id of defaultIds) this.rules.set(`*:id:${normalize(id)}`, { roomId: "*", type: "id", value: normalize(id), ignored: true, source: "default" });
    for (const name of defaultUsernames) this.rules.set(`*:name:${normalize(name)}`, { roomId: "*", type: "name", value: normalize(name), ignored: true, source: "default" });
    for (const entry of database?.list("ignore-rules") || []) this.rules.set(entry.key, entry.value);
  }

  key(roomId, type, value) { return `${roomId}:${type}:${normalize(value)}`; }

  add(roomId, type, value, actor = null) {
    if (!['id', 'name'].includes(type)) throw new Error("Ignore type must be id or name.");
    const normalized = normalize(value);
    if (!normalized) throw new Error("A user identity is required.");
    const rule = { roomId: String(roomId), type, value: normalized, ignored: true, source: "runtime", actor, updatedAt: Date.now() };
    const key = this.key(roomId, type, normalized);
    this.rules.set(key, rule);
    this.database?.set("ignore-rules", key, rule);
    return rule;
  }

  remove(roomId, type, value, actor = null) {
    const normalized = normalize(value);
    const localKey = this.key(roomId, type, normalized);
    const defaultKey = this.key("*", type, normalized);
    const isDefault = this.rules.get(defaultKey)?.source === "default";
    this.rules.delete(localKey);
    this.database?.delete("ignore-rules", localKey);
    if (isDefault) {
      const override = { roomId: String(roomId), type, value: normalized, ignored: false, source: "override", actor, updatedAt: Date.now() };
      this.rules.set(localKey, override);
      this.database?.set("ignore-rules", localKey, override);
      return true;
    }
    return true;
  }

  isIgnored(roomId, senderId, senderName) {
    const checks = [{ type: "id", value: normalize(senderId) }, { type: "name", value: normalize(senderName) }].filter((item) => item.value);
    return checks.some(({ type, value }) => {
      const local = this.rules.get(this.key(roomId, type, value));
      if (local) return local.ignored;
      return this.rules.get(this.key("*", type, value))?.ignored === true;
    });
  }

  status(roomId, type, value) { return this.isIgnored(roomId, type === "id" ? value : null, type === "name" ? value : null); }
  list(roomId) { return [...this.rules.values()].filter((rule) => rule.ignored && (rule.roomId === "*" || String(rule.roomId) === String(roomId))); }
}

module.exports = { IgnoreService };
