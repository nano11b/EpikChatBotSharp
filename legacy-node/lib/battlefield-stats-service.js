const EA_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/;
const METRICS = Object.freeze({
  kd: "kd_ratio",
  kd_ratio: "kd_ratio",
  kills: "total_kills",
  total_kills: "total_kills",
  wins: "matches_won",
  matches_won: "matches_won",
  xp: "total_xp",
  total_xp: "total_xp",
  hours: "hours_played",
  hours_played: "hours_played",
  winrate: "win_rate_percent",
  win_rate_percent: "win_rate_percent",
  kph: "kills_per_hour",
  kills_per_hour: "kills_per_hour",
});

function validateEaId(value) {
  const eaId = String(value || "").trim();
  if (!EA_ID_PATTERN.test(eaId)) throw new Error("EA ID must be 2-64 characters using letters, numbers, dots, underscores, or hyphens.");
  return eaId;
}

function number(value, maximumFractionDigits = 2) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "—";
  return Number(value).toLocaleString("en-US", { maximumFractionDigits });
}

class BattlefieldStatsService {
  constructor({ baseUrl = "https://bfstats.nano11bravo.com", timeoutMs = 10000, cacheTtlMs = 30000, fetchImpl = global.fetch, now = Date.now, logger = console } = {}) {
    if (typeof fetchImpl !== "function") throw new Error("A Fetch API implementation is required.");
    this.baseUrl = String(baseUrl).replace(/\/+$/, "");
    this.timeoutMs = timeoutMs;
    this.cacheTtlMs = cacheTtlMs;
    this.fetch = fetchImpl;
    this.now = now;
    this.logger = logger;
    this.cache = new Map();
    this.lastSuccessAt = null;
    this.lastErrorAt = null;
    this.lastOperationalErrorAt = null;
    this.lastErrorMessage = null;
  }

  validateEaId(value) { return validateEaId(value); }

  async request(path) {
    const url = new URL(path, `${this.baseUrl}/`).toString();
    const cached = this.cache.get(url);
    if (cached && cached.expiresAt > this.now()) return cached.data;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
    try {
      const response = await this.fetch(url, { headers: { Accept: "application/json", "User-Agent": "EpikChat-Bot/1.0" }, signal: controller.signal });
      let data = null;
      try { data = await response.json(); } catch { data = null; }
      if (!response.ok) {
        const message = data?.error?.message || data?.detail || `API returned HTTP ${response.status}`;
        const error = new Error(String(message).slice(0, 180)); error.status = response.status; throw error;
      }
      this.cache.set(url, { data, expiresAt: this.now() + this.cacheTtlMs });
      this.lastSuccessAt = this.now(); this.lastErrorMessage = null;
      return data;
    } catch (error) {
      this.lastErrorAt = this.now(); this.lastErrorMessage = String(error?.message || error);
      if (!error?.status || error.status >= 500) this.lastOperationalErrorAt = this.now();
      if (error?.name === "AbortError") throw new Error("Battlefield stats request timed out.");
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  status() { return { baseUrl: this.baseUrl, lastSuccessAt: this.lastSuccessAt, lastErrorAt: this.lastErrorAt, lastOperationalErrorAt: this.lastOperationalErrorAt, lastErrorMessage: this.lastErrorMessage, cacheEntries: this.cache.size }; }

  stats(eaId) {
    return this.request(`/api/v1/integrations/epikchat/${encodeURIComponent(validateEaId(eaId))}`);
  }

  compact(eaId) {
    return this.request(`/api/v1/integrations/compact/${encodeURIComponent(validateEaId(eaId))}`);
  }

  achievements(eaId) {
    return this.request(`/api/v1/players/${encodeURIComponent(validateEaId(eaId))}/achievements`);
  }

  compare(first, second) {
    const firstId = validateEaId(first);
    const secondId = validateEaId(second);
    if (firstId.toLowerCase() === secondId.toLowerCase()) throw new Error("Choose two different EA IDs to compare.");
    const query = new URLSearchParams({ first: firstId, second: secondId });
    return this.request(`/api/v1/compare?${query}`);
  }

  leaderboard(metric = "kd", limit = 5) {
    const normalizedMetric = METRICS[String(metric || "kd").toLowerCase()];
    if (!normalizedMetric) throw new Error(`Leaderboard metric must be: ${Object.keys(METRICS).filter((key) => !key.includes("_")).join(", ")}.`);
    const safeLimit = Math.min(10, Math.max(1, Number(limit) || 5));
    return this.request(`/api/v1/leaderboards/${normalizedMetric}?limit=${safeLimit}`);
  }

  formatStats(data) {
    if (!data?.text) throw new Error("The stats API returned an incomplete player payload.");
    const profileUrl = data.profile_url ? new URL(data.profile_url, `${this.baseUrl}/`).toString() : null;
    const withLink = profileUrl ? `${data.text} | ${profileUrl}` : data.text;
    return withLink.length <= 250 ? withLink : String(data.text).slice(0, 250);
  }

  formatAchievements(data) {
    const unlocked = Array.isArray(data?.badges) ? data.badges.filter((badge) => badge.unlocked) : [];
    const names = unlocked.map((badge) => `${badge.name} (${badge.tier})`).join(", ");
    return `${data?.ea_id || "Player"} badges ${data?.unlocked_count ?? unlocked.length}/${data?.catalog_size ?? unlocked.length}: ${names || "none unlocked"}.`;
  }

  formatComparison(data) {
    const a = data?.players?.a;
    const b = data?.players?.b;
    if (!a || !b) throw new Error("The stats API returned an incomplete comparison payload.");
    const winner = data.score?.winner === "a" ? a.ea_id : data.score?.winner === "b" ? b.ea_id : "tie";
    return `${a.ea_id} vs ${b.ea_id}: ${number(data.score?.a, 0)}-${number(data.score?.b, 0)} (${winner}) | K/D ${number(a.kd_ratio)}/${number(b.kd_ratio)} | Kills ${number(a.total_kills, 0)}/${number(b.total_kills, 0)} | Wins ${number(a.matches_won, 0)}/${number(b.matches_won, 0)}.`;
  }

  formatLeaderboard(data) {
    const rows = Array.isArray(data?.results) ? data.results : [];
    if (!rows.length) return "The Battlefield leaderboard has no stored players yet.";
    return `BF ${data.metric || "leaderboard"}: ${rows.map((row) => `#${row.rank} ${row.ea_id} ${number(row.value)}`).join(" • ")}`;
  }
}

module.exports = { BattlefieldStatsService, EA_ID_PATTERN, METRICS, validateEaId };
