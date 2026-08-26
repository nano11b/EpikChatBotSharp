const { createJsonStore, readJsonFile } = require("./persistence");

const DEFAULT_ROOM_SETTINGS = Object.freeze({
  ai: { enabled: true, respondToAll: false },
  bot: { name: null, persona: "a friendly male cat in an EpikChat community" },
  reply: { color: "#6d9eeb" },
  trivia: {
    attempts: null,
    timeMs: null,
    hintMs: 15000,
    questionCount: 10,
    speedBonusMs: 5000,
  },
  moderation: { linksAllowed: true, enabled: true },
  welcome: { enabled: false, message: "Welcome, {name}!" },
  locale: { language: "en" },
  accessibility: { concise: false },
  releaseChannel: "stable",
  features: { ai: true, battlefield: true, trivia: true, marbles: true, polls: true, loyalty: true, memory: true, welcome: true, submissions: true, experimental: false },
  commands: {},
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function merge(target, source) {
  for (const [key, value] of Object.entries(source || {})) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      target[key] = merge(target[key] && typeof target[key] === "object" ? target[key] : {}, value);
    } else {
      target[key] = value;
    }
  }
  return target;
}

function parseValue(value) {
  const text = String(value).trim();
  if (/^(true|on|yes)$/i.test(text)) return true;
  if (/^(false|off|no)$/i.test(text)) return false;
  if (/^-?\d+(?:\.\d+)?$/.test(text)) return Number(text);
  return text;
}

class SettingsStore {
  constructor({ filePath, debounceMs = 100, logger = console, database = null }) {
    this.filePath = filePath;
    const data = readJsonFile(filePath, {}, logger, database);
    this.rooms = data.rooms && typeof data.rooms === "object" ? data.rooms : {};
    this.writer = createJsonStore({
      filePath,
      delayMs: debounceMs,
      label: "settings",
      logger,
      getData: () => ({ version: 1, rooms: this.rooms }),
      database,
    });
  }

  get(roomId) {
    return merge(clone(DEFAULT_ROOM_SETTINGS), clone(this.rooms[String(roomId)] || {}));
  }

  set(roomId, settingPath, rawValue) {
    const allowed = /^(ai\.(enabled|respondToAll)|bot\.(name|persona)|reply\.color|trivia\.(attempts|timeMs|hintMs|questionCount|speedBonusMs)|moderation\.(linksAllowed|enabled)|welcome\.(enabled|message)|locale\.language|accessibility\.concise|releaseChannel|features\.(ai|battlefield|trivia|marbles|polls|loyalty|memory|welcome|submissions|experimental)|commands\.[a-z0-9_-]+)$/;
    if (!allowed.test(settingPath)) throw new Error(`Unsupported setting: ${settingPath}`);
    const roomKey = String(roomId);
    const room = this.rooms[roomKey] || {};
    const parts = settingPath.split(".");
    let cursor = room;
    for (const part of parts.slice(0, -1)) cursor = cursor[part] ||= {};
    cursor[parts.at(-1)] = parseValue(rawValue);
    this.rooms[roomKey] = room;
    this.writer.schedule();
    return this.get(roomId);
  }

  reset(roomId) {
    delete this.rooms[String(roomId)];
    this.writer.schedule();
  }

  isCommandEnabled(roomId, command) {
    return this.get(roomId).commands[String(command).toLowerCase()] !== false;
  }

  isFeatureEnabled(roomId, feature) {
    return this.get(roomId).features[String(feature)] !== false;
  }

  flush() {
    return this.writer.flush();
  }
}

module.exports = { DEFAULT_ROOM_SETTINGS, SettingsStore, parseValue };
