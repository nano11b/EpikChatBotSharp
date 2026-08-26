const fs = require("fs");
const { atomicWriteFile, createJsonStore, readJsonFile } = require("./persistence");

const DEFAULT_QUESTIONS = [
  { question: "What is the largest planet in our solar system?", answer: "jupiter" },
  { question: "Which element has the chemical symbol O?", answer: "oxygen" },
  { question: "What year did the first human walk on the moon?", answer: "1969" },
  { question: "What is the capital city of France?", answer: "paris" },
  { question: "How many continents are there on Earth?", answer: "7", acceptedAnswers: ["seven"] },
  { question: "What is the hardest natural substance on Earth?", answer: "diamond" },
  { question: "Which animal is known as the king of the jungle?", answer: "lion" },
  { question: "What is the smallest prime number?", answer: "2", acceptedAnswers: ["two"] },
  { question: "Which planet is known as the Red Planet?", answer: "mars" },
  { question: "What do bees collect from flowers to make honey?", answer: "nectar" },
  { question: "In computing, what does CPU stand for?", answer: "central processing unit", acceptedAnswers: ["cpu"] },
  { question: "What is the chemical symbol for gold?", answer: "au" },
  { question: "Who painted the Mona Lisa?", answer: "leonardo da vinci", acceptedAnswers: ["da vinci"] },
  { question: "What is the tallest mountain in the world?", answer: "mount everest", acceptedAnswers: ["everest"] },
  { question: "What is the primary language spoken in Brazil?", answer: "portuguese" },
  { question: "What gas do plants absorb from the atmosphere?", answer: "carbon dioxide", acceptedAnswers: ["co2"] },
  { question: "How many legs does a spider have?", answer: "8", acceptedAnswers: ["eight"] },
  { question: "What is the name of the longest river in the world?", answer: "nile", acceptedAnswers: ["the nile"] },
  { question: "Who wrote Romeo and Juliet?", answer: "william shakespeare", acceptedAnswers: ["shakespeare"] },
  { question: "Which planet has rings around it?", answer: "saturn" },
];

function normalizeAnswer(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function damerauLevenshtein(left, right) {
  const matrix = Array.from({ length: left.length + 1 }, () => Array(right.length + 1).fill(0));
  for (let i = 0; i <= left.length; i += 1) matrix[i][0] = i;
  for (let j = 0; j <= right.length; j += 1) matrix[0][j] = j;

  for (let i = 1; i <= left.length; i += 1) {
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      );
      if (i > 1 && j > 1 && left[i - 1] === right[j - 2] && left[i - 2] === right[j - 1]) {
        matrix[i][j] = Math.min(matrix[i][j], matrix[i - 2][j - 2] + cost);
      }
    }
  }

  return matrix[left.length][right.length];
}

function allowedEdits(length) {
  if (length >= 8) return 2;
  if (length >= 4) return 1;
  return 0;
}

function fuzzyEqual(left, right) {
  const edits = allowedEdits(Math.max(left.length, right.length));
  return Math.abs(left.length - right.length) <= edits && damerauLevenshtein(left, right) <= edits;
}

function matchesCandidate(normalizedGuess, normalizedCandidate) {
  if (normalizedGuess === normalizedCandidate) return true;

  const compactGuess = normalizedGuess.replace(/\s/g, "");
  const compactCandidate = normalizedCandidate.replace(/\s/g, "");
  if (fuzzyEqual(compactGuess, compactCandidate)) return true;

  const guessTokens = normalizedGuess.split(" ");
  const candidateTokens = normalizedCandidate.split(" ");
  const minimumPartialLength = Math.max(5, Math.ceil(compactCandidate.length * 0.45));
  if (compactGuess.length < minimumPartialLength) return false;

  return guessTokens.every((guessToken) =>
    candidateTokens.some((candidateToken) => fuzzyEqual(guessToken, candidateToken))
  );
}

function isAnswerMatch(guess, answerOrQuestion) {
  const normalizedGuess = normalizeAnswer(guess);
  if (!normalizedGuess) return false;

  const question = typeof answerOrQuestion === "object"
    ? answerOrQuestion
    : { answer: answerOrQuestion, acceptedAnswers: [] };
  const candidates = [question.answer, ...(question.acceptedAnswers || [])]
    .map(normalizeAnswer)
    .filter(Boolean);
  return candidates.some((candidate) => matchesCandidate(normalizedGuess, candidate));
}

function shuffle(array, random = Math.random) {
  for (let index = array.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [array[index], array[other]] = [array[other], array[index]];
  }
}

function deserializeScores(scores) {
  return new Map(Object.entries(scores || {}).map(([key, value]) => {
    if (value && typeof value === "object") {
      return [key, {
        name: String(value.name || key),
        score: Number(value.score) || 0,
        fastestMs: Number(value.fastestMs) || null,
        maxStreak: Number(value.maxStreak) || 0,
      }];
    }
    return [key.toLowerCase(), { name: key, score: Number(value) || 0 }];
  }));
}

class TriviaService {
  constructor({ config, isAdmin, sendMessage, getRoomSettings = null, onCorrect = null, logger = console, random = Math.random, database = null }) {
    this.config = config;
    this.isAdmin = isAdmin;
    this.sendMessage = sendMessage;
    this.logger = logger;
    this.random = random;
    this.getRoomSettings = getRoomSettings || (() => ({ trivia: {} }));
    this.onCorrect = onCorrect || (() => {});
    this.database = database;
    this.states = new Map();
    this.savedScores = new Map();
    this.questionSequence = 0;
    this.questions = this.loadQuestions();
    const statsData = readJsonFile(config.triviaStatsFile, {}, logger, database);
    this.stats = statsData.questions && typeof statsData.questions === "object" ? statsData.questions : {};
    this.loadScores();
    this.writer = createJsonStore({
      filePath: config.triviaScoreFile,
      delayMs: config.persistDebounceMs,
      label: "trivia",
      logger,
      getData: () => this.serializeScores(),
      database,
    });
    this.statsWriter = createJsonStore({
      filePath: config.triviaStatsFile,
      delayMs: config.persistDebounceMs,
      label: "trivia-stats",
      logger,
      getData: () => ({ version: 1, questions: this.stats }),
      database,
    });
  }

  loadQuestions() {
    if (!fs.existsSync(this.config.triviaFile)) {
      fs.mkdirSync(require("path").dirname(this.config.triviaFile), { recursive: true });
      fs.writeFileSync(this.config.triviaFile, JSON.stringify(DEFAULT_QUESTIONS, null, 2));
    }

    const questions = readJsonFile(this.config.triviaFile, [], this.logger);
    if (!Array.isArray(questions)) {
      this.logger.error("[trivia] Trivia file must contain an array.");
      return [];
    }

    const validQuestions = questions.filter((entry) => entry && entry.question && entry.answer);
    if (validQuestions.length !== questions.length) {
      this.logger.warn(`[trivia] Ignored ${questions.length - validQuestions.length} malformed question(s).`);
    }
    return validQuestions.map((entry) => ({
      question: String(entry.question),
      answer: String(entry.answer),
      acceptedAnswers: Array.isArray(entry.acceptedAnswers) ? entry.acceptedAnswers.map(String) : [],
      category: entry.category ? String(entry.category) : "",
      difficulty: entry.difficulty ? String(entry.difficulty).toLowerCase() : "medium",
      choices: Array.isArray(entry.choices) ? entry.choices.map(String) : [],
      hint: entry.hint ? String(entry.hint) : "",
      enabled: entry.enabled !== false,
    }));
  }

  loadScores() {
    const data = readJsonFile(this.config.triviaScoreFile, {}, this.logger, this.database);
    if (data.rooms && typeof data.rooms === "object") {
      for (const [roomId, scores] of Object.entries(data.rooms)) {
        this.savedScores.set(roomId, deserializeScores(scores));
      }
    } else if (data && typeof data === "object") {
      this.savedScores.set(this.config.roomId || "__legacy__", deserializeScores(data));
    }
  }

  serializeScores() {
    const rooms = Object.create(null);
    for (const [roomId, scores] of this.savedScores) {
      if (roomId !== "__legacy__") rooms[roomId] = Object.fromEntries(scores);
    }
    for (const [roomId, state] of this.states) rooms[roomId] = Object.fromEntries(state.scores);
    return { version: 1, mode: this.config.triviaScoreMode, rooms };
  }

  getState(roomId) {
    const key = String(roomId);
    if (!this.states.has(key)) {
      const scores = this.savedScores.get(key) || this.savedScores.get("__legacy__") || new Map();
      this.savedScores.delete("__legacy__");
      this.states.set(key, {
        active: false,
        current: null,
        scores: new Map(scores),
        timer: null,
        hintTimer: null,
        questionPool: [],
        attempts: new Map(),
        round: null,
      });
    }
    return this.states.get(key);
  }

  refillPool(state) {
    if (state.questionPool.length || !this.questions.length) return;
    state.questionPool = this.questions
      .filter((question) => question.enabled !== false)
      .filter((question) => !state.round?.category || question.category.toLowerCase() === state.round.category)
      .filter((question) => !state.round?.difficulty || question.difficulty === state.round.difficulty)
      .map((question) => ({ ...question }));
    shuffle(state.questionPool, this.random);
  }

  clearTimer(state) {
    if (state.timer) clearTimeout(state.timer);
    if (state.hintTimer) clearTimeout(state.hintTimer);
    state.timer = null;
    state.hintTimer = null;
  }

  scoreboard(state) {
    if (!state.scores.size) return "No trivia points yet. Start answering to build the scoreboard.";
    const entries = [...state.scores.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map(({ name, score }) => `${name}: ${score}`)
      .join(" • ");
    return `Trivia scoreboard: ${entries}`;
  }

  formatQuestion(question, roomId) {
    const category = question.category ? ` (${question.category})` : "";
    const choices = question.choices?.length
      ? ` ${question.choices.map((choice, index) => `${String.fromCharCode(65 + index)}) ${choice}`).join(" • ")}`
      : "";
    const attempts = this.roomOptions(roomId).attempts;
    return `Trivia time! ${question.question}${category}${choices} Reply with ^answer <your answer>. You get ${attempts} attempts.`;
  }

  roomOptions(roomId) {
    const settings = this.getRoomSettings(roomId)?.trivia || {};
    const clamp = (value, fallback, minimum, maximum) => Math.min(maximum, Math.max(minimum, Number(value) || fallback));
    return {
      attempts: clamp(settings.attempts, this.config.triviaAttemptsPerUser, 1, 20),
      timeMs: clamp(settings.timeMs, this.config.triviaQuestionTimeMs, 5000, 300000),
      hintMs: clamp(settings.hintMs, 0, 0, 299999),
      questionCount: clamp(settings.questionCount, 10, 1, 100),
      speedBonusMs: clamp(settings.speedBonusMs, 0, 0, 300000),
    };
  }

  questionKey(question) {
    return normalizeAnswer(question.question);
  }

  recordStat(question, field, amount = 1) {
    const key = this.questionKey(question);
    const entry = this.stats[key] ||= { question: question.question, asked: 0, correct: 0, attempts: 0, totalAnswerMs: 0 };
    entry[field] = (Number(entry[field]) || 0) + amount;
    this.statsWriter.schedule();
  }

  makeHint(question) {
    if (question.hint) return question.hint;
    return question.answer.split(" ").map((word) => `${word[0]}${"_".repeat(Math.max(0, word.length - 1))}`).join(" ");
  }

  async advance(roomId) {
    const state = this.getState(roomId);
    this.clearTimer(state);
    if (state.round && state.round.asked >= state.round.limit) {
      state.active = false;
      state.current = null;
      await this.sendMessage(roomId, `Trivia round complete! ${this.scoreboard(state)}`);
      return;
    }
    this.refillPool(state);
    if (!state.questionPool.length) {
      state.active = false;
      state.current = null;
      await this.sendMessage(roomId, `That's all the trivia I have for now. ${this.scoreboard(state)}`);
      return;
    }

    const question = state.questionPool.pop();
    const questionId = ++this.questionSequence;
    state.current = { ...question, id: questionId, askedAt: Date.now() };
    if (state.round) state.round.asked += 1;
    state.attempts.clear();
    this.recordStat(question, "asked");
    const options = this.roomOptions(roomId);
    state.timer = setTimeout(() => this.expireQuestion(roomId, questionId), options.timeMs);
    if (options.hintMs > 0 && options.hintMs < options.timeMs) {
      state.hintTimer = setTimeout(() => {
        if (state.active && state.current?.id === questionId) {
          this.sendMessage(roomId, `Hint: ${this.makeHint(question)}`).catch((error) => this.logger.error("[trivia hint]", error));
        }
      }, options.hintMs);
    }
    await this.sendMessage(roomId, this.formatQuestion(question, roomId));
  }

  async expireQuestion(roomId, questionId) {
    const state = this.getState(roomId);
    if (!state.active || state.current?.id !== questionId) return;
    const answer = state.current.answer;
    if (state.round) state.round.streaks.clear();
    state.current = null;
    try {
      await this.sendMessage(roomId, `Time's up! The correct answer was ${answer}. ${this.scoreboard(state)}`);
      if (state.active) await this.advance(roomId);
    } catch (error) {
      this.logger.error("[trivia] Unable to advance question", error);
    }
  }

  requireAdmin(roomId, senderId, senderName) {
    return this.config.triviaAdminControls && !this.isAdmin(senderId, senderName, roomId);
  }

  start(roomId, senderId, senderName, optionsText = "") {
    if (this.requireAdmin(roomId, senderId, senderName)) return { handled: true, reply: "Trivia start is admin-only." };
    const state = this.getState(roomId);
    if (state.active) return { handled: true, reply: "Trivia is already running! Answer with ^answer <your guess>." };
    state.active = true;
    state.current = null;
    state.questionPool = [];
    state.attempts.clear();
    const tokens = String(optionsText).trim().toLowerCase().split(/\s+/).filter(Boolean);
    const categories = new Set(this.questions.map((question) => question.category.toLowerCase()).filter(Boolean));
    const category = tokens.find((token) => categories.has(token)) || null;
    const difficulty = tokens.find((token) => ["easy", "medium", "hard"].includes(token)) || null;
    const requestedCount = tokens.map(Number).find((value) => Number.isInteger(value) && value > 0);
    state.round = {
      category,
      difficulty,
      limit: Math.min(requestedCount || this.roomOptions(roomId).questionCount, 100),
      asked: 0,
      streaks: new Map(),
    };
    if (this.config.triviaScoreMode === "session") state.scores.clear();
    this.writer.schedule();
    return { handled: true, advanceTrivia: true };
  }

  stop(roomId, senderId, senderName) {
    if (this.requireAdmin(roomId, senderId, senderName)) return { handled: true, reply: "Trivia stop is admin-only." };
    const state = this.getState(roomId);
    if (!state.active) return { handled: true, reply: "Trivia is not currently running." };
    state.active = false;
    state.current = null;
    state.attempts.clear();
    state.round = null;
    this.clearTimer(state);
    this.writer.schedule();
    return { handled: true, reply: `Trivia stopped. ${this.scoreboard(state)}` };
  }

  reset(roomId, senderId, senderName) {
    if (!this.isAdmin(senderId, senderName, roomId)) return { handled: true, reply: "Trivia reset is admin-only." };
    const state = this.getState(roomId);
    state.active = false;
    state.current = null;
    state.questionPool = [];
    state.attempts.clear();
    state.round = null;
    state.scores.clear();
    this.clearTimer(state);
    this.questions = this.loadQuestions();
    this.writer.schedule();
    return { handled: true, reply: "Trivia has been reset. Scores cleared and questions refreshed." };
  }

  answer(roomId, senderId, senderName, guess) {
    const state = this.getState(roomId);
    if (!state.active || !state.current) {
      return { handled: true, reply: "There isn't an active trivia question right now. Use ^trivia start to begin." };
    }

    let normalizedGuess = normalizeAnswer(guess);
    if (!normalizedGuess) return { handled: true, reply: "Please provide an answer after ^answer." };

    if (state.current.choices?.length) {
      const letterIndex = /^[a-z]$/.test(normalizedGuess) ? normalizedGuess.charCodeAt(0) - 97 : -1;
      const numberIndex = /^\d+$/.test(normalizedGuess) ? Number(normalizedGuess) - 1 : -1;
      const choiceIndex = letterIndex >= 0 ? letterIndex : numberIndex;
      if (choiceIndex >= 0 && choiceIndex < state.current.choices.length) {
        normalizedGuess = normalizeAnswer(state.current.choices[choiceIndex]);
      }
    }

    const name = senderName || "friend";
    const identity = String(senderId || name).trim().toLowerCase();
    const attemptsUsed = state.attempts.get(identity) || 0;
    const limit = this.roomOptions(roomId).attempts;
    if (attemptsUsed >= limit) return { handled: true, reply: `${name}, you've used all ${limit} attempts for this question.` };

    this.recordStat(state.current, "attempts");
    if (isAnswerMatch(normalizedGuess, state.current)) {
      this.clearTimer(state);
      const elapsedMs = Date.now() - state.current.askedAt;
      const previous = state.scores.get(identity) || { name, score: 0, fastestMs: null, maxStreak: 0 };
      const streak = (state.round?.streaks.get(identity) || 0) + 1;
      if (state.round) state.round.streaks.set(identity, streak);
      const options = this.roomOptions(roomId);
      const speedBonus = options.speedBonusMs > 0 && elapsedMs <= options.speedBonusMs ? 1 : 0;
      const streakBonus = streak > 0 && streak % 3 === 0 ? 1 : 0;
      const points = 1 + speedBonus + streakBonus;
      const score = previous.score + points;
      state.scores.set(identity, {
        name,
        score,
        fastestMs: previous.fastestMs === null ? elapsedMs : Math.min(previous.fastestMs, elapsedMs),
        maxStreak: Math.max(previous.maxStreak || 0, streak),
      });
      const answer = state.current.answer;
      this.recordStat(state.current, "correct");
      this.recordStat(state.current, "totalAnswerMs", elapsedMs);
      state.current = null;
      this.writer.schedule();
      Promise.resolve(this.onCorrect({ roomId, senderId, senderName: name, points, streak, elapsedMs }))
        .catch((error) => this.logger.error("[trivia reward]", error));
      const bonuses = [speedBonus ? "speed bonus" : "", streakBonus ? `${streak}-answer streak bonus` : ""].filter(Boolean);
      return {
        handled: true,
        reply: `Correct, ${name}! ${answer} is right. +${points} point${points === 1 ? "" : "s"}${bonuses.length ? ` (${bonuses.join(", ")})` : ""}. ${this.scoreboard(state)}`,
        advanceTrivia: state.active,
      };
    }

    const used = attemptsUsed + 1;
    state.attempts.set(identity, used);
    if (state.round) state.round.streaks.set(identity, 0);
    const remaining = limit - used;
    if (!remaining) return { handled: true, reply: `Not quite, ${name}. You've used all ${limit} attempts for this question.` };
    return { handled: true, reply: `Not quite, ${name}. Try again! You have ${remaining} attempt${remaining === 1 ? "" : "s"} left.` };
  }

  handleCommand({ roomId, senderId, senderName, command, text }) {
    if (command === "answer") return this.answer(roomId, senderId, senderName, text);
    if (command !== "trivia") return { handled: false };

    const normalized = String(text || "").trim().toLowerCase();
    const [subcommand, ...args] = normalized.split(/\s+/);
    switch (subcommand) {
      case "start": return this.start(roomId, senderId, senderName, args.join(" "));
      case "stop": return this.stop(roomId, senderId, senderName);
      case "score":
      case "leaderboard": return { handled: true, reply: this.scoreboard(this.getState(roomId)) };
      case "reset": return this.reset(roomId, senderId, senderName);
      case "categories": return { handled: true, reply: `Trivia categories: ${this.categories().join(", ") || "none"}.` };
      case "stats": return { handled: true, reply: this.formatStats() };
      case "help":
      case "": return { handled: true, reply: "Trivia commands: ^trivia start [category] [difficulty] [count], ^trivia stop, ^trivia score, ^trivia categories, ^trivia stats, ^trivia reset, ^answer <guess>." };
      default: return { handled: true, reply: "Trivia command not recognized. Use ^trivia help." };
    }
  }

  status(roomId) {
    const state = this.getState(roomId);
    return { active: state.active, question: state.current?.question || "none" };
  }

  categories() {
    return [...new Set(this.questions.filter((question) => question.enabled).map((question) => question.category).filter(Boolean))].sort();
  }

  formatStats() {
    const entries = Object.values(this.stats)
      .filter((entry) => entry.asked > 0)
      .sort((a, b) => b.attempts - a.attempts)
      .slice(0, 5)
      .map((entry) => `${entry.question}: ${Math.round((entry.correct / entry.asked) * 100)}% correct`);
    return entries.length ? `Trivia analytics: ${entries.join(" • ")}` : "No trivia analytics yet.";
  }

  listQuestions() {
    return this.questions.map((question, index) => `${index + 1}) [${question.enabled ? "on" : "off"}] ${question.question} → ${question.answer}`);
  }

  async saveQuestions() {
    await atomicWriteFile(this.config.triviaFile, JSON.stringify(this.questions, null, 2));
  }

  async addQuestion(specification) {
    const [question, answer, category = "general", difficulty = "medium", aliases = "", choices = ""] = String(specification).split("|").map((part) => part.trim());
    if (!question || !answer) throw new Error("Use: question|answer|category|difficulty|alias1,alias2|choice1,choice2");
    this.questions.push({
      question,
      answer,
      category,
      difficulty: ["easy", "medium", "hard"].includes(difficulty.toLowerCase()) ? difficulty.toLowerCase() : "medium",
      acceptedAnswers: aliases.split(",").map((item) => item.trim()).filter(Boolean),
      choices: choices.split(",").map((item) => item.trim()).filter(Boolean),
      hint: "",
      enabled: true,
    });
    await this.saveQuestions();
    return this.questions.at(-1);
  }

  async removeQuestion(index) {
    const position = Number(index) - 1;
    if (!Number.isInteger(position) || !this.questions[position]) return null;
    const [removed] = this.questions.splice(position, 1);
    await this.saveQuestions();
    return removed;
  }

  async setQuestionEnabled(index, enabled) {
    const question = this.questions[Number(index) - 1];
    if (!question) return null;
    question.enabled = enabled;
    await this.saveQuestions();
    return question;
  }

  reloadQuestions() {
    this.questions = this.loadQuestions();
    for (const state of this.states.values()) state.questionPool = [];
    return this.questions.length;
  }

  stopAll() {
    for (const state of this.states.values()) {
      state.active = false;
      state.current = null;
      state.attempts.clear();
      state.round = null;
      this.clearTimer(state);
    }
  }

  flush() {
    return Promise.all([this.writer.flush(), this.statsWriter.flush()]);
  }
}

module.exports = { DEFAULT_QUESTIONS, TriviaService, damerauLevenshtein, isAnswerMatch, normalizeAnswer };
