class CommandRegistry {
  constructor() {
    this.commands = new Map();
    this.aliases = new Map();
  }

  register(definition) {
    const categories = {
      battlefield: new Set(["bf", "bf6", "battlefield", "askbf", "bfverify"]),
      games: new Set(["trivia", "answer", "question", "submit", "review", "season", "race", "event", "poll", "vote"]),
      moderation: new Set(["mod", "warn", "case", "appeal", "ignore"]),
      community: new Set(["points", "daily", "leaderboard", "memory", "profile"]),
      administration: new Set(["config", "role", "audit", "backup", "schedule", "plugins", "outbox", "retention", "metrics"]),
    };
    const inferredCategory = Object.entries(categories).find(([, names]) => names.has(String(definition.name).toLowerCase()))?.[0] || "general";
    const command = {
      permission: "viewer",
      cooldown: "command",
      aliases: [],
      category: inferredCategory,
      ...definition,
      name: String(definition.name).toLowerCase(),
    };
    if (this.commands.has(command.name)) throw new Error(`Command already registered: ${command.name}`);
    this.commands.set(command.name, command);
    for (const alias of command.aliases) this.aliases.set(String(alias).toLowerCase(), command.name);
    return this;
  }

  resolve(name) {
    const normalized = String(name || "").toLowerCase();
    return this.commands.get(this.aliases.get(normalized) || normalized) || null;
  }

  unregisterSource(source) {
    for (const [name, command] of this.commands) {
      if (command.source !== source) continue;
      this.commands.delete(name);
      for (const [alias, target] of this.aliases) if (target === name) this.aliases.delete(alias);
    }
  }

  async execute(context) {
    const definition = this.resolve(context.command);
    if (!definition) return { handled: false };
    const permission = definition.permission === "admin" ? "moderator" : definition.permission;
    if (permission !== "viewer" && !(context.hasPermission?.(permission) || (permission === "moderator" && context.isAdmin))) {
      const fallback = definition.permission === "admin" ? `${definition.name} is admin-only.` : `${definition.name} requires the ${permission} role.`;
      return { handled: true, reply: context.t?.("permission", { role: permission }) || fallback };
    }
    return { handled: true, ...(await definition.handler(context)) };
  }

  help({ isAdmin = false, role = isAdmin ? "moderator" : "viewer", category = null } = {}) {
    const levels = { viewer: 0, host: 1, moderator: 2, owner: 3, admin: 2 };
    return [...this.commands.values()]
      .filter((command) => !command.hidden && levels[role] >= levels[command.permission] && (!category || command.category === category))
      .map((command) => `^${command.name}${command.usage ? ` ${command.usage}` : ""} — ${command.description || ""}`);
  }

  categories({ role = "viewer" } = {}) {
    const levels = { viewer: 0, host: 1, moderator: 2, owner: 3, admin: 2 };
    return [...new Set([...this.commands.values()].filter((command) => !command.hidden && levels[role] >= levels[command.permission]).map((command) => command.category))].sort();
  }
}

module.exports = { CommandRegistry };
