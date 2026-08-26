const { createJsonStore, readJsonFile } = require("./persistence");

class SchedulerService {
  constructor({ filePath, execute, debounceMs = 100, logger = console, database = null }) {
    const data = readJsonFile(filePath, {}, logger, database);
    this.items = new Map(Object.entries(data.items || {}));
    this.timers = new Map();
    this.execute = execute;
    this.logger = logger;
    this.writer = createJsonStore({
      filePath,
      delayMs: debounceMs,
      label: "scheduler",
      logger,
      getData: () => ({ version: 1, items: Object.fromEntries(this.items) }),
      database,
    });
    this.restore();
  }

  restore() {
    for (const item of this.items.values()) this.arm(item);
  }

  add({ roomId, type = "announcement", payload, runAt, repeatMs = 0 }) {
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    const item = { id, roomId, type, payload, runAt: Number(runAt), repeatMs: Number(repeatMs) || 0 };
    this.items.set(id, item);
    this.arm(item);
    this.writer.schedule();
    return item;
  }

  arm(item) {
    clearTimeout(this.timers.get(item.id));
    const remaining = item.runAt - Date.now();
    const maximumDelay = 2_147_483_647;
    const delay = Math.max(0, Math.min(maximumDelay, remaining));
    this.timers.set(item.id, setTimeout(() => {
      if (remaining > maximumDelay) this.arm(item);
      else this.run(item.id);
    }, delay));
  }

  async run(id) {
    const item = this.items.get(id);
    if (!item) return;
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    try {
      await this.execute(item);
    } catch (error) {
      this.logger.error("[scheduler] Activity failed", error);
      item.runAt = Date.now() + 60000;
      this.arm(item);
      this.writer.schedule();
      return;
    }
    if (item.repeatMs > 0) {
      item.runAt = Date.now() + item.repeatMs;
      this.arm(item);
    } else {
      this.items.delete(id);
      this.timers.delete(id);
    }
    this.writer.schedule();
  }

  remove(id) {
    if (!this.items.delete(id)) return false;
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    this.writer.schedule();
    return true;
  }

  list(roomId) {
    return [...this.items.values()].filter((item) => String(item.roomId) === String(roomId)).sort((a, b) => a.runAt - b.runAt);
  }

  stopAll() {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  flush() { return this.writer.flush(); }
}

module.exports = { SchedulerService };
