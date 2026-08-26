const { createJsonStore, readJsonFile } = require("./persistence");

const SUPPORTED_LANGUAGES = new Set(["en", "es"]);

class UserPreferenceService {
  constructor({ filePath, debounceMs = 100, logger = console, database = null }) {
    const data = readJsonFile(filePath, {}, logger, database);
    this.users = new Map(Object.entries(data.users || {}));
    this.writer = createJsonStore({ filePath, delayMs: debounceMs, label: "user-preferences", logger, database, getData: () => ({ version: 1, users: Object.fromEntries(this.users) }) });
  }

  key(roomId, senderId, senderName) { return `${roomId}:${String(senderId || senderName || "unknown").toLowerCase()}`; }
  get(roomId, senderId, senderName) { return { language: null, timezone: "UTC", concise: false, battlefieldId: null, ...(this.users.get(this.key(roomId, senderId, senderName)) || {}) }; }

  set(roomId, senderId, senderName, property, value) {
    const user = this.get(roomId, senderId, senderName);
    if (property === "language") {
      const language = String(value).toLowerCase();
      if (!SUPPORTED_LANGUAGES.has(language)) throw new Error("Supported languages: en, es.");
      user.language = language;
    } else if (property === "timezone") {
      try { new Intl.DateTimeFormat("en", { timeZone: value }).format(); } catch { throw new Error("Use an IANA timezone such as America/New_York."); }
      user.timezone = value;
    } else if (property === "concise") {
      user.concise = ["true", "on", "yes", "1"].includes(String(value).toLowerCase());
    } else if (property === "battlefieldId") {
      user.battlefieldId = String(value).trim();
    } else throw new Error("Profile fields: language, timezone, concise.");
    this.users.set(this.key(roomId, senderId, senderName), user);
    this.writer.schedule();
    return user;
  }

  unset(roomId, senderId, senderName, property) {
    const key = this.key(roomId, senderId, senderName);
    const user = this.get(roomId, senderId, senderName);
    if (!(property in user)) return false;
    user[property] = null;
    this.users.set(key, user);
    this.writer.schedule();
    return true;
  }

  forget(roomId, senderId, senderName) {
    const removed = this.users.delete(this.key(roomId, senderId, senderName));
    if (removed) this.writer.schedule();
    return removed;
  }

  format(message, preferences) {
    let output = String(message);
    if (preferences?.concise) output = output.replace(/[\p{Extended_Pictographic}\uFE0F]/gu, "").replace(/\s*[•|]\s*/g, "; ").replace(/\s+/g, " ").trim();
    return output;
  }

  purgeBefore() { return 0; }
  flush() { return this.writer.flush(); }
}

module.exports = { SUPPORTED_LANGUAGES, UserPreferenceService };
