const fs = require("fs");
const path = require("path");
const { atomicWriteFile, createDebouncedWriter } = require("./lib/persistence");

function parseBoolean(value, defaultValue = false) {
  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }

  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function parseCsvList(value) {
  if (!value) {
    return new Set();
  }

  return new Set(
    String(value)
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean)
  );
}

function cleanMarbleName(value) {
  if (typeof value !== "string") {
    return "";
  }

  // Marbles' custom-name import expects one name per line. Remove line breaks
  // and commas so a chat display name cannot corrupt the roster file.
  return value
    .replace(/[\r\n]+/g, " ")
    .replace(/,/g, "")
    .trim()
    .slice(0, 50);
}

class MarblesBridge {
  constructor(options = {}) {
    this.enabled = options.enabled ?? parseBoolean(process.env.MARBLES_ENABLED, true);
    this.filePath = path.resolve(
      options.filePath || process.env.MARBLES_FILE || path.join(__dirname, "marbles.csv")
    );
    this.stateFilePath = options.stateFilePath || `${this.filePath}.state.json`;
    this.registrationOpen =
      options.registrationOpen ?? parseBoolean(process.env.MARBLES_REGISTRATION_OPEN, true);
    this.confirmJoins = options.confirmJoins ?? parseBoolean(process.env.MARBLES_CONFIRM_JOINS, true);
    this.joinCommands = new Set(
      (options.joinCommands || process.env.MARBLES_JOIN_COMMANDS || "!play,!marbles")
        .split(",")
        .map((command) => command.trim().toLowerCase())
        .filter(Boolean)
    );
    this.adminIds = options.adminIds || parseCsvList(process.env.MARBLES_ADMIN_IDS);
    this.adminUsernames = options.adminUsernames || parseCsvList(process.env.MARBLES_ADMIN_USERNAMES);
    this.players = new Map();
    this.writer = createDebouncedWriter({
      delayMs: options.persistDebounceMs ?? 100,
      label: "marbles",
      logger: options.logger || console,
      write: async () => {
        const entries = [...this.players.values()];
        const contents = entries.map((entry) => entry.name).join("\n");
        await Promise.all([
          atomicWriteFile(this.filePath, contents ? `${contents}\n` : ""),
          atomicWriteFile(this.stateFilePath, JSON.stringify(entries, null, 2)),
        ]);
      },
    });

    if (this.enabled) {
      this.ensureRosterFile();
      this.loadRoster();
    }
  }

  ensureRosterFile() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    if (!fs.existsSync(this.filePath)) {
      fs.writeFileSync(this.filePath, "", "utf8");
    }
  }

  loadRoster() {
    this.players.clear();

    if (fs.existsSync(this.stateFilePath)) {
      try {
        const entries = JSON.parse(fs.readFileSync(this.stateFilePath, "utf8"));
        if (Array.isArray(entries)) {
          for (const entry of entries) {
            const id = String(entry?.id || "").trim().toLowerCase();
            const name = cleanMarbleName(entry?.name);
            if (name) {
              const key = id ? `id:${id}` : `name:${name.toLowerCase()}`;
              this.players.set(key, { id: id || null, name });
            }
          }
          return;
        }
      } catch (error) {
        console.error("[marbles] Unable to load roster identity state", error);
      }
    }

    if (!fs.existsSync(this.filePath)) {
      return;
    }

    const lines = fs
      .readFileSync(this.filePath, "utf8")
      .split(/\r?\n/)
      .map(cleanMarbleName)
      .filter(Boolean);

    for (const name of lines) {
      this.players.set(`name:${name.toLowerCase()}`, { id: null, name });
    }
  }

  writeRoster() {
    this.writer.schedule();
  }

  flush() {
    return this.writer.flush();
  }

  isAdmin(senderId, senderName) {
    const id = String(senderId || "").trim().toLowerCase();
    const username = String(senderName || "").trim().toLowerCase();

    // Admin controls are intentionally disabled until at least one admin is
    // configured. This prevents anyone in the room from clearing the race.
    if (this.adminIds.size === 0 && this.adminUsernames.size === 0) {
      return false;
    }

    return (id && this.adminIds.has(id)) || (username && this.adminUsernames.has(username));
  }

  parse(content) {
    const text = typeof content === "string" ? content.trim() : "";
    if (!text) {
      return null;
    }

    const lower = text.toLowerCase();

    if (this.joinCommands.has(lower)) {
      return { type: "join" };
    }

    if (lower === "!leave" || lower === "!unplay") {
      return { type: "leave" };
    }

    const adminMatch = text.match(/^\^marbles(?:\s+(.+))?$/i);
    if (!adminMatch) {
      return null;
    }

    const command = (adminMatch[1] || "status").trim().toLowerCase();
    return { type: "admin", command };
  }

  addPlayer(senderId, senderName = senderId) {
    const name = cleanMarbleName(senderName);
    if (!name) {
      return { ok: false, reason: "invalid-name" };
    }

    if (!this.registrationOpen) {
      return { ok: false, reason: "closed", name };
    }

    const normalizedId = String(senderId || "").trim().toLowerCase();
    const key = normalizedId ? `id:${normalizedId}` : `name:${name.toLowerCase()}`;
    if (this.players.has(key)) {
      const existing = this.players.get(key);
      if (existing.name !== name) {
        existing.name = name;
        this.writeRoster();
      }
      return { ok: true, duplicate: true, name: existing.name, count: this.players.size };
    }

    const legacyKey = `name:${name.toLowerCase()}`;
    if (normalizedId && this.players.has(legacyKey)) {
      this.players.delete(legacyKey);
    }

    this.players.set(key, { id: normalizedId || null, name });
    this.writeRoster();
    return { ok: true, duplicate: false, name, count: this.players.size };
  }

  removePlayer(senderId, senderName = senderId) {
    const name = cleanMarbleName(senderName);
    if (!name) {
      return { ok: false, reason: "invalid-name" };
    }

    const normalizedId = String(senderId || "").trim().toLowerCase();
    const key = normalizedId ? `id:${normalizedId}` : `name:${name.toLowerCase()}`;
    let existed = this.players.delete(key);
    if (!existed && normalizedId) {
      existed = this.players.delete(`name:${name.toLowerCase()}`);
    }
    if (existed) {
      this.writeRoster();
    }

    return { ok: true, existed, name, count: this.players.size };
  }

  handleAdmin(command) {
    switch (command) {
      case "open":
      case "start":
        this.registrationOpen = true;
        return { handled: true, reply: `🎱 Marbles registration is OPEN. Type !play to join. (${this.players.size} currently entered)` };

      case "close":
      case "stop":
        this.registrationOpen = false;
        return { handled: true, reply: `🔒 Marbles registration is CLOSED with ${this.players.size} player${this.players.size === 1 ? "" : "s"}.` };

      case "reset":
      case "clear":
        this.players.clear();
        this.writeRoster();
        this.registrationOpen = true;
        return { handled: true, reply: "🧹 Marbles roster cleared. Registration is OPEN for a new race." };

      case "count":
      case "status":
        return {
          handled: true,
          reply: `🎱 Marbles: ${this.registrationOpen ? "OPEN" : "CLOSED"} • ${this.players.size} player${this.players.size === 1 ? "" : "s"} • ${path.basename(this.filePath)}`,
        };

      case "help":
        return {
          handled: true,
          reply: "Marbles admin: ^marbles open | close | reset | count. Viewers: !play to join, !leave to leave.",
        };

      default:
        return {
          handled: true,
          reply: "Unknown Marbles command. Use ^marbles help.",
        };
    }
  }

  handleMessage({ senderId, senderName, content }) {
    if (!this.enabled) {
      return { handled: false };
    }

    const parsed = this.parse(content);
    if (!parsed) {
      return { handled: false };
    }

    if (parsed.type === "join") {
      const result = this.addPlayer(senderId, senderName || senderId);

      if (result.reason === "closed") {
        return { handled: true, reply: "🔒 Marbles registration is currently closed." };
      }

      if (!result.ok) {
        return { handled: true, reply: "I couldn't add that name to the Marbles roster." };
      }

      if (!this.confirmJoins) {
        return { handled: true, reply: null, joined: !result.duplicate, duplicate: result.duplicate };
      }

      if (result.duplicate) {
        return { handled: true, duplicate: true, reply: `🎱 ${result.name}, you're already in the race! (${result.count} entered)` };
      }

      return { handled: true, joined: true, reply: `🎱 ${result.name} joined the Marbles race! (${result.count} entered)` };
    }

    if (parsed.type === "leave") {
      const result = this.removePlayer(senderId, senderName || senderId);
      return {
        handled: true,
        reply: result.existed
          ? `👋 ${result.name} left the Marbles race. (${result.count} entered)`
          : `🎱 ${result.name}, you weren't in the current Marbles roster.`,
      };
    }

    if (parsed.type === "admin") {
      if (!this.isAdmin(senderId, senderName)) {
        return { handled: true, reply: "⛔ That Marbles control is streamer/admin only." };
      }

      return this.handleAdmin(parsed.command);
    }

    return { handled: false };
  }
}

module.exports = {
  MarblesBridge,
  cleanMarbleName,
};
