const { createJsonStore, readJsonFile } = require("./persistence");

class MemoryStore {
  constructor({ filePath, historyLimit = 10, maxUsers = 500, maxRecentReplies = 5, debounceMs = 100, logger = console, database = null }) {
    this.filePath = filePath;
    this.historyLimit = historyLimit;
    this.maxUsers = maxUsers;
    this.maxRecentReplies = maxRecentReplies;
    this.logger = logger;
    this.treatCount = 0;
    this.recentReplies = [];
    this.users = new Map();
    this.optedOut = new Set();

    this.database = database;
    this.load();
    this.writer = createJsonStore({
      filePath,
      delayMs: debounceMs,
      label: "memory",
      logger,
      getData: () => this.serialize(),
      database,
    });
  }

  identity(roomId, senderId, senderName) {
    const id = String(senderId || "").trim().toLowerCase();
    const name = String(senderName || senderId || "unknown").trim();
    const local = id ? `id:${id}` : `name:${name.toLowerCase()}`;
    return { key: `room:${roomId}:${local}`, local, id: id || null, name, roomId: String(roomId) };
  }

  load() {
    const data = readJsonFile(this.filePath, {}, this.logger, this.database);
    this.treatCount = Number(data.treatCount) || 0;
    this.recentReplies = Array.isArray(data.recentReplies)
      ? data.recentReplies.slice(-this.maxRecentReplies)
      : [];
    this.optedOut = new Set(Array.isArray(data.optedOut) ? data.optedOut : []);

    if (data.users && typeof data.users === "object") {
      for (const [key, value] of Object.entries(data.users)) {
        this.users.set(key, {
          id: value?.id || null,
          roomId: value?.roomId || null,
          name: String(value?.name || key),
          history: Array.isArray(value?.history) ? value.history.slice(-this.historyLimit) : [],
          preferences: value?.preferences && typeof value.preferences === "object" ? value.preferences : {},
          lastSeen: Number(value?.lastSeen) || 0,
        });
      }
    } else {
      this.migrateLegacy(data);
    }

    this.prune();
  }

  migrateLegacy(data) {
    const history = data.userHistory && typeof data.userHistory === "object" ? data.userHistory : {};
    const preferences = data.userPreferences && typeof data.userPreferences === "object" ? data.userPreferences : {};
    const lastSeen = data.userLastSeen && typeof data.userLastSeen === "object" ? data.userLastSeen : {};

    for (const name of new Set([...Object.keys(history), ...Object.keys(preferences)])) {
      const key = `name:${name.toLowerCase()}`;
      this.users.set(key, {
        id: null,
        name,
        history: Array.isArray(history[name]) ? history[name].slice(-this.historyLimit) : [],
        preferences: preferences[name] && typeof preferences[name] === "object" ? preferences[name] : {},
        lastSeen: Number(lastSeen[name]) || 0,
      });
    }
  }

  serialize() {
    return {
      version: 3,
      treatCount: this.treatCount,
      recentReplies: this.recentReplies,
      users: Object.fromEntries(this.users),
      optedOut: [...this.optedOut],
    };
  }

  getUser(roomId, senderId, senderName, create = false) {
    const identity = this.identity(roomId, senderId, senderName);
    let user = this.users.get(identity.key);

    if (!user && identity.id) {
      const roomLegacyKey = `room:${roomId}:name:${identity.name.toLowerCase()}`;
      const legacyKey = `name:${identity.name.toLowerCase()}`;
      const legacyIdKey = `id:${identity.id}`;
      user = this.users.get(roomLegacyKey) || this.users.get(legacyIdKey) || this.users.get(legacyKey);
      if (user) {
        this.users.delete(roomLegacyKey);
        this.users.delete(legacyIdKey);
        this.users.delete(legacyKey);
        user.id = identity.id;
        user.roomId = identity.roomId;
        this.users.set(identity.key, user);
      }
    }

    if (!user && create) {
      user = { id: identity.id, roomId: identity.roomId, name: identity.name, history: [], preferences: {}, lastSeen: 0 };
      this.users.set(identity.key, user);
    }

    if (user && identity.name) user.name = identity.name;
    return user;
  }

  rememberMessage(roomId, senderId, senderName, message) {
    const cleaned = typeof message === "string" ? message.trim() : "";
    if (!cleaned) return;

    const identity = this.identity(roomId, senderId, senderName);
    if (this.optedOut.has(identity.key)) return;
    const user = this.getUser(roomId, senderId, senderName, true);
    user.history.push(cleaned);
    user.history = user.history.slice(-this.historyLimit);
    user.lastSeen = Date.now();
    this.prune();
    this.writer.schedule();
  }

  rememberPreference(roomId, senderId, senderName, message) {
    const cleaned = typeof message === "string" ? message.trim() : "";
    const match = cleaned.match(/favou?rite\s+colou?r\s+is\s+([a-zA-Z]+(?:\s+[a-zA-Z]+)*)/i);
    if (!match) return null;

    const identity = this.identity(roomId, senderId, senderName);
    if (this.optedOut.has(identity.key)) return null;
    const user = this.getUser(roomId, senderId, senderName, true);
    const value = match[1].trim();
    user.preferences.favoriteColor = value;
    user.lastSeen = Date.now();
    this.prune();
    this.writer.schedule();
    return { key: "favoriteColor", value };
  }

  getContext(roomId, senderId, senderName) {
    const identity = this.identity(roomId, senderId, senderName);
    if (this.optedOut.has(identity.key)) return [];
    const user = this.getUser(roomId, senderId, senderName, false);
    if (!user) return [];

    const context = [];
    if (user.history.length) {
      context.push(`The user ${user.name} has said recently: ${user.history.join(" | ")}.`);
    }

    const preferences = Object.entries(user.preferences)
      .map(([key, value]) => `${key.replace(/([A-Z])/g, " $1").toLowerCase()}: ${value}`)
      .join(", ");
    if (preferences) context.push(`Known preferences for ${user.name}: ${preferences}.`);
    return context;
  }

  setEnabled(roomId, senderId, senderName, enabled) {
    const identity = this.identity(roomId, senderId, senderName);
    if (enabled) this.optedOut.delete(identity.key);
    else this.optedOut.add(identity.key);
    this.writer.schedule();
    return enabled;
  }

  isEnabled(roomId, senderId, senderName) {
    return !this.optedOut.has(this.identity(roomId, senderId, senderName).key);
  }

  forget(roomId, senderId, senderName) {
    const identity = this.identity(roomId, senderId, senderName);
    const removed = this.users.delete(identity.key);
    this.writer.schedule();
    return removed;
  }

  show(roomId, senderId, senderName) {
    const user = this.getUser(roomId, senderId, senderName, false);
    return user ? { name: user.name, history: [...user.history], preferences: { ...user.preferences } } : null;
  }

  exportUser(roomId, senderId, senderName) {
    const identity = this.identity(roomId, senderId, senderName);
    return { identity: { roomId: identity.roomId, id: identity.id, name: identity.name }, memoryEnabled: !this.optedOut.has(identity.key), memory: this.show(roomId, senderId, senderName) };
  }

  rememberReply(reply) {
    this.recentReplies.push(String(reply).trim().toLowerCase());
    this.recentReplies = this.recentReplies.slice(-this.maxRecentReplies);
    this.writer.schedule();
  }

  isRepeatedReply(reply) {
    return this.recentReplies.slice(-3).includes(String(reply).trim().toLowerCase());
  }

  incrementTreats() {
    this.treatCount += 1;
    this.writer.schedule();
    return this.treatCount;
  }

  prune() {
    if (this.users.size <= this.maxUsers) return;
    const oldest = [...this.users.entries()]
      .sort((a, b) => a[1].lastSeen - b[1].lastSeen)
      .slice(0, this.users.size - this.maxUsers);
    for (const [key] of oldest) this.users.delete(key);
  }

  pruneBefore(timestamp) {
    let removed = 0;
    for (const [key, user] of this.users) {
      if (user.lastSeen && user.lastSeen < timestamp) { this.users.delete(key); removed += 1; }
    }
    if (removed) this.writer.schedule();
    return removed;
  }

  flush() {
    return this.writer.flush();
  }
}

module.exports = { MemoryStore };
