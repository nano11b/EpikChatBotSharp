"use strict";

function createBattlefieldCommandHandlers({
  battlefield,
  battlefieldCommunity,
  config,
  continuations,
  logger,
  openai,
  preferences,
}) {
  async function handleBattlefield({ roomId, senderId, senderName, text }) {
    const tokens = String(text || "").trim().split(/\s+/).filter(Boolean);
    const action = String(tokens[0] || "stats").toLowerCase();
    const profile = preferences.get(roomId, senderId, senderName);
    const linkedId = profile.battlefieldId;
    const help = "BF: ^bf <EA-ID>, set, status, unlink, watch, unwatch, changes, badges, compare, top. Use ^help bf for details.";
    try {
      if (action === "help") return { reply: help };
      if (action === "set") {
        const eaId = battlefield.validateEaId(tokens[1]);
        preferences.set(roomId, senderId, senderName, "battlefieldId", eaId);
        const link = battlefieldCommunity.link(roomId, senderId, senderName, eaId);
        return { reply: `EA ID ${eaId} linked but unverified. Give code ${link.code} to a moderator; they can run ^bfverify ${link.code}.` };
      }
      if (action === "unlink") {
        preferences.unset(roomId, senderId, senderName, "battlefieldId");
        battlefieldCommunity.unlink(roomId, senderId);
        return { reply: "Your saved Battlefield EA ID was removed." };
      }
      if (action === "status") {
        const link = battlefieldCommunity.getLink(roomId, senderId);
        return { reply: link ? `${link.eaId}: ${link.verified ? "verified" : `pending verification (${link.code})`}.` : "No Battlefield ID is linked." };
      }
      if (action === "watch") { const watch = battlefieldCommunity.watch(roomId, senderId, senderName); return { reply: `Watching ${watch.eaId} for stat changes and milestones.` }; }
      if (action === "unwatch") { battlefieldCommunity.unwatch(roomId, senderId); return { reply: "Battlefield stat alerts disabled." }; }
      if (action === "changes") { const changes = battlefieldCommunity.changes(roomId, senderId); return { reply: changes.length ? `Latest BF changes: ${changes.join(" • ")}` : "No Battlefield stat changes recorded yet." }; }
      if (action === "badges") {
        const eaId = tokens[1] || linkedId;
        if (!eaId) return { reply: "Provide an EA ID or save one with ^bf set <EA-ID>." };
        return { reply: battlefield.formatAchievements(await battlefield.achievements(eaId)) };
      }
      if (action === "compare") {
        const ids = tokens.slice(1);
        const first = ids.length >= 2 ? ids[0] : linkedId;
        const second = ids.length >= 2 ? ids[1] : ids[0];
        if (!first || !second) return { reply: "Use ^bf compare <first-EA-ID> <second-EA-ID>, or save your ID and provide one opponent." };
        return { reply: battlefield.formatComparison(await battlefield.compare(first, second)) };
      }
      if (action === "top") return { reply: battlefield.formatLeaderboard(await battlefield.leaderboard(tokens[1] || "kd", tokens[2] || 5)) };
      const eaId = action === "stats" ? (tokens[1] || linkedId) : tokens[0];
      if (!eaId) return { reply: help };
      return { reply: battlefield.formatStats(await battlefield.stats(eaId)) };
    } catch (error) {
      logger.warn("[battlefield] Request failed", { senderId, error: error.message });
      return { reply: `Battlefield stats error: ${String(error.message || error).slice(0, 200)}` };
    }
  }

  async function handleAskBattlefield({ roomId, senderId, senderName, text }) {
    const linkedId = preferences.get(roomId, senderId, senderName).battlefieldId;
    if (!linkedId) return { reply: "Save an EA ID first with ^bf set <EA-ID>." };
    try {
      const data = await battlefield.compact(linkedId);
      if (!openai) return { reply: battlefield.formatStats(await battlefield.stats(linkedId)) };
      const response = await openai.responses.create({
        model: config.openaiModel,
        instructions: "Answer the Battlefield question using only the supplied JSON statistics. Be concise, state when data is unavailable, and never invent a value.",
        input: JSON.stringify({ eaId: linkedId, question: String(text || "Summarize my performance"), statistics: data }),
        max_output_tokens: 200,
      });
      const answer = String(response.output_text || response.output?.[0]?.content?.[0]?.text || "").trim();
      if (!answer) throw new Error("AI returned an empty Battlefield answer.");
      return { reply: continuations.start(roomId, senderId, senderName, answer) };
    } catch (error) {
      logger.warn("[askbf]", error.message);
      return { reply: `Battlefield assistant error: ${String(error.message).slice(0, 190)}` };
    }
  }

  return { handleAskBattlefield, handleBattlefield };
}

module.exports = { createBattlefieldCommandHandlers };
