const test = require("node:test");
const assert = require("node:assert/strict");

const { BattlefieldStatsService, validateEaId } = require("../lib/battlefield-stats-service");

function jsonResponse(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, async json() { return data; } };
}

test("Battlefield stats client validates IDs, caches responses, and formats EpikChat payloads", async () => {
  let calls = 0;
  const service = new BattlefieldStatsService({
    baseUrl: "https://stats.example",
    cacheTtlMs: 30000,
    fetchImpl: async (url) => {
      calls += 1;
      assert.match(url, /integrations\/epikchat\/nano11b$/);
      return jsonResponse({ ea_id: "nano11b", text: "nano11b | K/D 1.5 | Kills 100", profile_url: "/player/nano11b" });
    },
  });
  const first = await service.stats("nano11b");
  await service.stats("nano11b");
  assert.equal(calls, 1);
  assert.match(service.formatStats(first), /https:\/\/stats\.example\/player\/nano11b/);
  assert.throws(() => validateEaId("bad id!"), /EA ID/);
});

test("Battlefield comparisons, badges, leaderboards, and API errors are formatted safely", async () => {
  const service = new BattlefieldStatsService({ baseUrl: "https://stats.example", fetchImpl: async (url) => {
    if (url.includes("/compare?")) return jsonResponse({ players: { a: { ea_id: "Alice", kd_ratio: 1.2, total_kills: 100, matches_won: 5 }, b: { ea_id: "Bob", kd_ratio: 1.5, total_kills: 120, matches_won: 4 } }, score: { a: 4, b: 5, winner: "b" } });
    if (url.includes("/achievements")) return jsonResponse({ ea_id: "Alice", unlocked_count: 1, catalog_size: 2, badges: [{ name: "First Contact", tier: "bronze", unlocked: true }] });
    if (url.includes("/leaderboards/")) return jsonResponse({ metric: "kd_ratio", results: [{ rank: 1, ea_id: "Bob", value: 1.5 }] });
    return jsonResponse({ error: { message: "Player not found" } }, 404);
  } });
  assert.match(service.formatComparison(await service.compare("Alice", "Bob")), /Alice vs Bob: 4-5 \(Bob\)/);
  assert.match(service.formatAchievements(await service.achievements("Alice")), /First Contact/);
  assert.match(service.formatLeaderboard(await service.leaderboard("kd")), /#1 Bob 1.5/);
  await assert.rejects(service.stats("Missing"), /Player not found/);
});
