const fs = require("fs");
const path = require("path");

class AuditService {
  constructor({ filePath, logger = console }) {
    this.filePath = filePath;
    this.logger = logger;
    this.chain = Promise.resolve();
  }

  record(entry) {
    const event = { at: new Date().toISOString(), ...entry };
    this.chain = this.chain.then(async () => {
      await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.promises.appendFile(this.filePath, `${JSON.stringify(event)}\n`, "utf8");
    }).catch((error) => this.logger.error("[audit] Unable to append", error));
    return event;
  }

  recent(roomId, limit = 10) {
    if (!fs.existsSync(this.filePath)) return [];
    return fs.readFileSync(this.filePath, "utf8").split(/\r?\n/).filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    }).filter((entry) => !roomId || String(entry.roomId) === String(roomId)).slice(-limit).reverse();
  }

  async purgeBefore(timestamp) {
    if (!fs.existsSync(this.filePath)) return 0;
    const entries = this.recent(null, Number.MAX_SAFE_INTEGER).reverse();
    const retained = entries.filter((entry) => Date.parse(entry.at) >= timestamp);
    await fs.promises.writeFile(this.filePath, retained.map((entry) => JSON.stringify(entry)).join("\n") + (retained.length ? "\n" : ""));
    return entries.length - retained.length;
  }

  flush() { return this.chain; }
}

module.exports = { AuditService };
