const fs = require("fs");
const path = require("path");

class StructuredLogger {
  constructor({ filePath, maxBytes = 5_000_000, consoleOutput = true } = {}) {
    this.filePath = filePath;
    this.maxBytes = maxBytes;
    this.consoleOutput = consoleOutput;
    this.chain = Promise.resolve();
    this.errorCount = 0;
    this.lastErrorAt = null;
  }

  write(level, args) {
    if (level === "error") {
      this.errorCount += 1;
      this.lastErrorAt = Date.now();
    }
    if (this.consoleOutput) (console[level] || console.log)(...args);
    if (!this.filePath) return;
    const render = (arg) => {
      if (arg instanceof Error) return arg.message;
      if (typeof arg === "string") return arg;
      try { return JSON.stringify(arg); } catch { return "[unserializable]"; }
    };
    const entry = `${JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      message: args.map(render).join(" "),
    })}\n`;
    this.chain = this.chain.then(async () => {
      await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
      const size = await fs.promises.stat(this.filePath).then((stat) => stat.size).catch(() => 0);
      if (size + Buffer.byteLength(entry) > this.maxBytes) {
        await fs.promises.rm(`${this.filePath}.1`, { force: true });
        await fs.promises.rename(this.filePath, `${this.filePath}.1`).catch(() => {});
      }
      await fs.promises.appendFile(this.filePath, entry, "utf8");
    }).catch((error) => console.error("[logger]", error));
  }

  log(...args) { this.write("log", args); }
  warn(...args) { this.write("warn", args); }
  error(...args) { this.write("error", args); }
  purgeBefore(timestamp) {
    if (!this.filePath) return Promise.resolve(0);
    this.chain = this.chain.then(async () => {
      let removed = 0;
      for (const filePath of [`${this.filePath}.1`, this.filePath]) {
        if (!fs.existsSync(filePath)) continue;
        const lines = (await fs.promises.readFile(filePath, "utf8")).split(/\r?\n/).filter(Boolean);
        const retained = lines.filter((line) => {
          try { return Date.parse(JSON.parse(line).timestamp) >= timestamp; } catch { return false; }
        });
        removed += lines.length - retained.length;
        if (retained.length) await fs.promises.writeFile(filePath, `${retained.join("\n")}\n`, "utf8");
        else await fs.promises.rm(filePath, { force: true });
      }
      return removed;
    });
    return this.chain;
  }
  flush() { return this.chain; }
}

module.exports = { StructuredLogger };
