const { createJsonStore, readJsonFile } = require("./persistence");

const ROLE_LEVELS = Object.freeze({ viewer: 0, host: 1, moderator: 2, owner: 3 });

function normalize(value) {
  return String(value || "").trim().toLowerCase();
}

class AccessControl {
  constructor({ filePath, ownerIds = new Set(), ownerUsernames = new Set(), debounceMs = 100, logger = console, database = null }) {
    const data = readJsonFile(filePath, {}, logger, database);
    this.rooms = data.rooms && typeof data.rooms === "object" ? data.rooms : {};
    this.ownerIds = new Set([...ownerIds].map(normalize));
    this.ownerUsernames = new Set([...ownerUsernames].map(normalize));
    this.writer = createJsonStore({
      filePath,
      delayMs: debounceMs,
      label: "access-control",
      logger,
      getData: () => ({ version: 1, rooms: this.rooms }),
      database,
    });
  }

  roleFor(roomId, senderId, senderName) {
    if (senderId === "__system__") return "owner";
    const id = normalize(senderId);
    const name = normalize(senderName);
    if ((id && this.ownerIds.has(id)) || (name && this.ownerUsernames.has(name))) return "owner";
    const roles = this.rooms[String(roomId)] || {};
    return roles[id ? `id:${id}` : `name:${name}`]?.role || "viewer";
  }

  has(roomId, senderId, senderName, required = "viewer") {
    return ROLE_LEVELS[this.roleFor(roomId, senderId, senderName)] >= ROLE_LEVELS[required];
  }

  grant(roomId, identity, role, displayName = null) {
    const normalizedRole = normalize(role);
    if (!(normalizedRole in ROLE_LEVELS) || normalizedRole === "viewer") {
      throw new Error("Role must be host, moderator, or owner.");
    }
    const normalizedIdentity = normalize(identity);
    if (!normalizedIdentity) throw new Error("A user ID is required.");
    const key = normalizedIdentity.startsWith("name:") || normalizedIdentity.startsWith("id:")
      ? normalizedIdentity
      : `id:${normalizedIdentity}`;
    const room = this.rooms[String(roomId)] ||= {};
    room[key] = { role: normalizedRole, name: displayName || null, grantedAt: Date.now() };
    this.writer.schedule();
    return { identity: key, ...room[key] };
  }

  revoke(roomId, identity) {
    const normalizedIdentity = normalize(identity);
    const room = this.rooms[String(roomId)] || {};
    const keys = normalizedIdentity.startsWith("name:") || normalizedIdentity.startsWith("id:")
      ? [normalizedIdentity]
      : [`id:${normalizedIdentity}`, `name:${normalizedIdentity}`];
    let removed = false;
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(room, key)) { delete room[key]; removed = true; }
    }
    if (removed) this.writer.schedule();
    return removed;
  }

  list(roomId) {
    return Object.entries(this.rooms[String(roomId)] || {}).map(([identity, value]) => ({ identity, ...value }));
  }

  flush() { return this.writer.flush(); }
}

module.exports = { AccessControl, ROLE_LEVELS };
