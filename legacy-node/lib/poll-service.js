class PollService {
  constructor({ sendMessage, logger = console }) {
    this.sendMessage = sendMessage;
    this.logger = logger;
    this.polls = new Map();
  }

  create(roomId, question, options, durationMs = 60000) {
    this.close(roomId, false);
    const poll = {
      question,
      options: options.map((label, index) => ({ id: index + 1, label, votes: new Set() })),
      voters: new Map(),
      closesAt: Date.now() + durationMs,
      timer: null,
    };
    poll.timer = setTimeout(() => this.close(roomId).catch((error) => this.logger.error("[poll]", error)), durationMs);
    this.polls.set(String(roomId), poll);
    return poll;
  }

  vote(roomId, senderId, choice) {
    const poll = this.polls.get(String(roomId));
    if (!poll) return { ok: false, reason: "no-poll" };
    const normalized = String(choice || "").trim().toLowerCase();
    const selected = poll.options.find((option) => String(option.id) === normalized || option.label.toLowerCase() === normalized);
    if (!selected) return { ok: false, reason: "invalid-choice" };
    const voter = String(senderId || "unknown").toLowerCase();
    const previousId = poll.voters.get(voter);
    if (previousId) poll.options.find((option) => option.id === previousId)?.votes.delete(voter);
    selected.votes.add(voter);
    poll.voters.set(voter, selected.id);
    return { ok: true, option: selected };
  }

  format(poll) {
    return `${poll.question} ${poll.options.map((option) => `${option.id}) ${option.label} [${option.votes.size}]`).join(" • ")}`;
  }

  async close(roomId, announce = true) {
    const poll = this.polls.get(String(roomId));
    if (!poll) return null;
    clearTimeout(poll.timer);
    this.polls.delete(String(roomId));
    if (announce) await this.sendMessage(roomId, `Poll closed: ${this.format(poll)}`);
    return poll;
  }

  stopAll() {
    for (const poll of this.polls.values()) clearTimeout(poll.timer);
    this.polls.clear();
  }
}

module.exports = { PollService };
