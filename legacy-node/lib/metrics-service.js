class MetricsService {
  constructor({ database = null } = {}) {
    this.database = database;
    this.counters = database?.get("operations", "counters", {}) || {};
    this.timings = database?.get("operations", "timings", {}) || {};
  }
  persist() { this.database?.set("operations", "counters", this.counters); this.database?.set("operations", "timings", this.timings); }
  increment(name, amount = 1) { this.counters[name] = (Number(this.counters[name]) || 0) + amount; this.persist(); return this.counters[name]; }
  timing(name, milliseconds) { const item = this.timings[name] ||= { count: 0, totalMs: 0, maxMs: 0 }; item.count += 1; item.totalMs += Number(milliseconds) || 0; item.maxMs = Math.max(item.maxMs, Number(milliseconds) || 0); this.persist(); }
  snapshot() { return { counters: { ...this.counters }, timings: Object.fromEntries(Object.entries(this.timings).map(([key, value]) => [key, { ...value, averageMs: value.count ? Math.round(value.totalMs / value.count) : 0 }])) }; }
}

module.exports = { MetricsService };
