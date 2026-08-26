const { createJsonStore, readJsonFile } = require("./persistence");

const DAILY_QUESTS = Object.freeze([
  Object.freeze({ id: "daily-claim", reason: "daily", label: "Claim the daily bonus", target: 1, reward: 5 }),
  Object.freeze({ id: "trivia-win", reason: "trivia", label: "Win a trivia question", target: 1, reward: 5 }),
  Object.freeze({ id: "marbles-entry", reason: "marbles", label: "Enter Marbles", target: 1, reward: 5 }),
  Object.freeze({ id: "event-join", reason: "event", label: "Join a community event", target: 1, reward: 5 }),
]);

function levelFor(points) {
  return 1 + Math.floor(Math.sqrt(Math.max(0, Number(points) || 0) / 25));
}

function levelThreshold(level) {
  return 25 * Math.max(0, level - 1) ** 2;
}

function titleFor(level) {
  if (level >= 10) return "Room Legend";
  if (level >= 7) return "Community Champion";
  if (level >= 5) return "Veteran";
  if (level >= 3) return "Regular";
  return "Newcomer";
}

class LoyaltyService {
  constructor({ filePath, debounceMs = 100, logger = console, database = null }) {
    const data = readJsonFile(filePath, {}, logger, database);
    this.users = new Map(Object.entries(data.users || {}));
    this.writer = createJsonStore({
      filePath,
      delayMs: debounceMs,
      label: "loyalty",
      logger,
      getData: () => ({ version: 1, users: Object.fromEntries(this.users) }),
      database,
    });
  }

  key(roomId, senderId, senderName) {
    return `${roomId}:${String(senderId || senderName || "unknown").toLowerCase()}`;
  }

  get(roomId, senderId, senderName) {
    const key = this.key(roomId, senderId, senderName);
    const user = this.users.get(key) || { roomId, id: senderId || null, name: senderName || "unknown", points: 0, triviaWins: 0, streak: 0, achievements: [], lastDaily: null };
    user.achievements ||= [];
    user.questDate ||= null;
    user.questProgress ||= {};
    user.completedQuests ||= [];
    return user;
  }

  recordQuest(user, reason) {
    const today = new Date().toISOString().slice(0, 10);
    if (user.questDate !== today) {
      user.questDate = today;
      user.questProgress = {};
      user.completedQuests = [];
    }
    const quest = DAILY_QUESTS.find((item) => item.reason === reason);
    if (!quest || user.completedQuests.includes(quest.id)) return null;
    user.questProgress[quest.id] = Math.min(quest.target, (user.questProgress[quest.id] || 0) + 1);
    if (user.questProgress[quest.id] < quest.target) return null;
    user.completedQuests.push(quest.id);
    user.points += quest.reward;
    return quest;
  }

  award(roomId, senderId, senderName, amount, reason = "participation") {
    const key = this.key(roomId, senderId, senderName);
    const user = this.get(roomId, senderId, senderName);
    user.name = senderName || user.name;
    user.points += Number(amount) || 0;
    if (reason === "trivia") user.triviaWins += 1;
    const completedQuest = this.recordQuest(user, reason);
    const unlocked = [];
    for (const achievement of [
      { id: "first-point", threshold: 1, label: "First Point" },
      { id: "regular", threshold: 50, label: "Room Regular" },
      { id: "centurion", threshold: 100, label: "Centurion" },
      { id: "trivia-ace", test: () => user.triviaWins >= 10, label: "Trivia Ace" },
    ]) {
      const earned = achievement.test ? achievement.test() : user.points >= achievement.threshold;
      if (earned && !user.achievements.includes(achievement.id)) {
        user.achievements.push(achievement.id);
        unlocked.push(achievement.label);
      }
    }
    this.users.set(key, user);
    this.writer.schedule();
    return { user, unlocked, completedQuest };
  }

  daily(roomId, senderId, senderName) {
    const user = this.get(roomId, senderId, senderName);
    const today = new Date().toISOString().slice(0, 10);
    if (user.lastDaily === today) return { ok: false, user };
    user.lastDaily = today;
    this.users.set(this.key(roomId, senderId, senderName), user);
    const result = this.award(roomId, senderId, senderName, 10, "daily");
    return { ok: true, ...result };
  }

  leaderboard(roomId, limit = 5) {
    return [...this.users.values()]
      .filter((user) => String(user.roomId) === String(roomId))
      .sort((a, b) => b.points - a.points)
      .slice(0, limit);
  }

  progress(roomId, senderId, senderName) {
    const user = this.get(roomId, senderId, senderName);
    const level = levelFor(user.points);
    return {
      user,
      level,
      title: titleFor(level),
      currentLevelAt: levelThreshold(level),
      nextLevelAt: levelThreshold(level + 1),
    };
  }

  quests(roomId, senderId, senderName) {
    const user = this.get(roomId, senderId, senderName);
    this.recordQuest(user, "__refresh__");
    return DAILY_QUESTS.map((quest) => ({
      ...quest,
      progress: user.questProgress[quest.id] || 0,
      completed: user.completedQuests.includes(quest.id),
    }));
  }

  flush() { return this.writer.flush(); }
}

module.exports = { DAILY_QUESTS, LoyaltyService, levelFor, levelThreshold, titleFor };
