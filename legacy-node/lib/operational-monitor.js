class OperationalMonitor {
  constructor({ inspect, notify, intervalMs = 300000, enabled = true, logger = console }) {
    this.inspect = inspect; this.notify = notify; this.intervalMs = intervalMs; this.enabled = enabled; this.logger = logger; this.timer = null; this.lastSignature = ""; this.lastCheckAt = null; this.lastAlert = null;
  }
  async check() {
    this.lastCheckAt = Date.now(); const state = await this.inspect(); const problems = [];
    if (state.outbox?.failed) problems.push(`${state.outbox.failed} failed outgoing message(s)`);
    if (state.openai?.lastErrorAt && Date.now() - state.openai.lastErrorAt < 900000) problems.push("recent OpenAI failure");
    if (state.battlefieldErrorAt && Date.now() - state.battlefieldErrorAt < 900000) problems.push("recent Battlefield API failure");
    const signature = problems.join("|");
    if (signature && signature !== this.lastSignature) { this.lastAlert = { at: Date.now(), problems }; await this.notify(`Bot operations alert: ${problems.join("; ")}. Check ^metrics or the dashboard.`); }
    this.lastSignature = signature; return { healthy: !problems.length, problems };
  }
  start() { if (!this.enabled || this.timer) return; this.timer = setInterval(() => this.check().catch((error) => this.logger.error("[operations-monitor]", error)), this.intervalMs); if (typeof this.timer.unref === "function") this.timer.unref(); }
  stop() { clearInterval(this.timer); this.timer = null; }
  status() { return { lastCheckAt: this.lastCheckAt, lastAlert: this.lastAlert }; }
}

module.exports = { OperationalMonitor };
