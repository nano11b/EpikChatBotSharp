const fs = require("fs");
const path = require("path");

class PluginLoader {
  constructor({ directory, registry, services = {}, logger = console }) {
    this.directory = path.resolve(directory);
    this.registry = registry;
    this.services = services;
    this.logger = logger;
    this.loaded = new Map();
  }

  loadAll() {
    if (!fs.existsSync(this.directory)) return [];
    const results = [];
    for (const file of fs.readdirSync(this.directory).filter((name) => name.endsWith(".js")).sort()) {
      const filePath = path.join(this.directory, file);
      let source = `plugin:${path.basename(file, ".js").toLowerCase()}`;
      try {
        delete require.cache[require.resolve(filePath)];
        const plugin = require(filePath);
        if (!plugin || typeof plugin.register !== "function") throw new Error("Plugin must export register(api).");
        const name = String(plugin.name || path.basename(file, ".js")).toLowerCase();
        source = `plugin:${name}`;
        if (this.loaded.has(name)) throw new Error(`Duplicate plugin name: ${name}`);
        const api = {
          services: Object.freeze({ ...this.services }),
          registerCommand: (definition) => this.registry.register({ ...definition, source }),
        };
        plugin.register(api);
        this.loaded.set(name, { name, version: plugin.version || "0.0.0", file });
        results.push({ name, ok: true });
      } catch (error) {
        this.registry.unregisterSource(source);
        this.logger.error("[plugin] Load failed", { file, error: error.message });
        results.push({ name: file, ok: false, error: error.message });
      }
    }
    return results;
  }

  list() { return [...this.loaded.values()]; }

  reloadAll() {
    for (const name of this.loaded.keys()) this.registry.unregisterSource(`plugin:${name}`);
    this.loaded.clear();
    return this.loadAll();
  }
}

module.exports = { PluginLoader };
