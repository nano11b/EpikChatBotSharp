const { createJsonStore, readJsonFile } = require("./persistence");

class DeliveryService {
  constructor({ filePath, deliver, debounceMs = 100, logger = console, maxAttempts = 20, database = null }) {
    const data = readJsonFile(filePath, {}, logger, database);
    this.items = new Map(Object.entries(data.items || {}));
    this.deliver = deliver;
    this.logger = logger;
    this.maxAttempts = maxAttempts;
    this.draining = null;
    this.writer = createJsonStore({
      filePath,
      delayMs: debounceMs,
      label: "outbox",
      logger,
      getData: () => ({ version: 1, items: Object.fromEntries(this.items) }),
      database,
    });
  }

  async send(message) {
    const id = message.id || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
    const item = { id, createdAt: Date.now(), attempts: 0, ...message };
    this.items.set(id, item);
    this.writer.schedule();
    await this.writer.flush();
    try {
      const response = await this.attempt(item);
      return { id, delivered: true, response };
    } catch (error) {
      this.logger.warn?.("[outbox] Message queued for retry", { id, error: error.message });
      return { id, delivered: false, queued: true };
    }
  }

  async attempt(item) {
    item.attempts += 1;
    item.lastAttemptAt = Date.now();
    try {
      const response = await this.deliver(item);
      this.items.delete(item.id);
      this.writer.schedule();
      await this.writer.flush();
      return response;
    } catch (error) {
      item.lastError = String(error?.message || error).slice(0, 500);
      if (item.attempts >= this.maxAttempts) item.failed = true;
      this.writer.schedule();
      await this.writer.flush();
      throw error;
    }
  }

  drain() {
    if (this.draining) return this.draining;
    this.draining = (async () => {
      for (const item of [...this.items.values()].filter((entry) => !entry.failed)) {
        await this.attempt(item).catch((error) => this.logger.error("[outbox] Delivery retry failed", { id: item.id, error: error.message }));
      }
    })().finally(() => { this.draining = null; });
    return this.draining;
  }

  retryFailed() {
    for (const item of this.items.values()) item.failed = false;
    return this.drain();
  }

  status() {
    const entries = [...this.items.values()];
    return { pending: entries.filter((item) => !item.failed).length, failed: entries.filter((item) => item.failed).length };
  }

  async flush() {
    if (this.draining) await this.draining;
    await this.writer.flush();
  }
}

module.exports = { DeliveryService };
