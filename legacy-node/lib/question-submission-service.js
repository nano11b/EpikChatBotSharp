const { createJsonStore, readJsonFile } = require("./persistence");

function normalize(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

class QuestionSubmissionService {
  constructor({ filePath, existingQuestions = () => [], debounceMs = 100, logger = console, database = null }) {
    const data = readJsonFile(filePath, {}, logger, database);
    this.items = new Map(Object.entries(data.items || {}));
    this.existingQuestions = existingQuestions;
    this.writer = createJsonStore({ filePath, delayMs: debounceMs, label: "question-submissions", logger, database, getData: () => ({ version: 1, items: Object.fromEntries(this.items) }) });
  }

  submit({ roomId, senderId, senderName, specification }) {
    const [question, answer, category = "general", difficulty = "medium", aliases = "", choices = ""] = String(specification).split("|").map((part) => part.trim());
    if (!question || !answer) throw new Error("Use: ^submit Question|answer|category|difficulty|aliases|choices");
    const key = `${normalize(question)}|${normalize(answer)}`;
    const duplicates = [
      ...this.existingQuestions().map((item) => `${normalize(item.question)}|${normalize(item.answer)}`),
      ...[...this.items.values()].filter((item) => item.status === "pending").map((item) => item.key),
    ];
    if (duplicates.includes(key)) return { ok: false, reason: "duplicate" };
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const item = { id, roomId, senderId: senderId || null, senderName: senderName || "unknown", question, answer, category, difficulty, aliases, choices, key, status: "pending", submittedAt: Date.now() };
    this.items.set(id, item);
    this.writer.schedule();
    return { ok: true, item };
  }

  pending(roomId) { return [...this.items.values()].filter((item) => item.status === "pending" && (!roomId || String(item.roomId) === String(roomId))); }

  async approve(id, reviewer, addQuestion) {
    const item = this.items.get(String(id));
    if (!item || item.status !== "pending") return null;
    const specification = [item.question, item.answer, item.category, item.difficulty, item.aliases, item.choices].join("|");
    await addQuestion(specification);
    item.status = "approved";
    item.reviewedBy = reviewer;
    item.reviewedAt = Date.now();
    this.writer.schedule();
    return item;
  }

  reject(id, reviewer) {
    const item = this.items.get(String(id));
    if (!item || item.status !== "pending") return null;
    item.status = "rejected";
    item.reviewedBy = reviewer;
    item.reviewedAt = Date.now();
    this.writer.schedule();
    return item;
  }

  purgeBefore(timestamp) {
    let removed = 0;
    for (const [id, item] of this.items) {
      if (item.status !== "pending" && item.reviewedAt < timestamp) { this.items.delete(id); removed += 1; }
    }
    if (removed) this.writer.schedule();
    return removed;
  }

  flush() { return this.writer.flush(); }
}

module.exports = { QuestionSubmissionService };
