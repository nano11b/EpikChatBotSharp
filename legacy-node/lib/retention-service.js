class RetentionService {
  constructor({ retentionDays = 90, run, intervalMs = 86400000, logger = console }) {
    this.retentionDays = retentionDays;
    this.runJob = run;
    this.logger = logger;
    this.lastRunAt = null;
    this.lastResult = null;
    this.timer = setInterval(() => this.run().catch((error) => logger.error("[retention]", error)), intervalMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  async run() {
    const cutoff = Date.now() - this.retentionDays * 86400000;
    this.lastResult = await this.runJob(cutoff);
    this.lastRunAt = Date.now();
    return this.lastResult;
  }

  status() { return { retentionDays: this.retentionDays, lastRunAt: this.lastRunAt, lastResult: this.lastResult }; }
  stop() { clearInterval(this.timer); }
}

module.exports = { RetentionService };
