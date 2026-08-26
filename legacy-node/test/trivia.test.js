const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { loadConfig } = require("../lib/config");
const { TriviaService, isAnswerMatch } = require("../lib/trivia");

test("answer matching supports aliases, transpositions, and misspelled partial answers", () => {
  const question = { answer: "william shakespeare", acceptedAnswers: ["shakespeare"] };
  assert.equal(isAnswerMatch("shakespear", question), true);
  assert.equal(isAnswerMatch("shkaespeare", question), true);
  assert.equal(isAnswerMatch("jupter", "jupiter"), true);
  assert.equal(isAnswerMatch("juipter", "jupiter"), true);
  assert.equal(isAnswerMatch("mount", "mount everest"), false);
  assert.equal(isAnswerMatch("mars", "jupiter"), false);
  assert.equal(isAnswerMatch("seven", { answer: "7", acceptedAnswers: ["seven"] }), true);
});

test("admin controls and cumulative scores have explicit behavior", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "epikchat-trivia-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, "trivia.json"), JSON.stringify([{ question: "Largest?", answer: "jupiter" }]));
  const config = loadConfig({
    BOT_TOKEN: "test",
    TRIVIA_FILE: path.join(directory, "trivia.json"),
    TRIVIA_SCORE_FILE: path.join(directory, "scores.json"),
    TRIVIA_ADMIN_CONTROLS: "true",
    TRIVIA_SCORE_MODE: "cumulative",
    PERSIST_DEBOUNCE_MS: "0",
  }, directory);
  const sent = [];
  const trivia = new TriviaService({
    config,
    isAdmin: (id) => id === "admin",
    sendMessage: async (_roomId, message) => sent.push(message),
    random: () => 0,
  });

  assert.match(trivia.start("room", "viewer", "Viewer").reply, /admin-only/);
  assert.equal(trivia.start("room", "admin", "Admin").advanceTrivia, true);
  await trivia.advance("room");
  const questionId = trivia.getState("room").current.id;
  assert.match(trivia.answer("room", "guessing-user", "Bob", "mars").reply, /2 attempts left/);
  assert.match(trivia.answer("room", "guessing-user", "Bob", "saturn").reply, /1 attempt left/);
  assert.match(trivia.answer("room", "guessing-user", "Bob", "earth").reply, /used all 3 attempts/);
  assert.match(trivia.answer("room", "guessing-user", "Bob", "jupiter").reply, /used all 3 attempts/);

  const correct = trivia.answer("room", "user", "Alice", "jupiter");
  assert.equal(correct.advanceTrivia, true);
  const sentBeforeExpiredTimer = sent.length;
  await trivia.expireQuestion("room", questionId);
  assert.equal(sent.length, sentBeforeExpiredTimer, "a stale timer must not advance an answered question");
  assert.match(trivia.answer("room", "other", "Carol", "jupiter").reply, /isn't an active trivia question/);
  trivia.stop("room", "admin", "Admin");
  assert.equal(trivia.getState("room").scores.get("user").score, 1);
  assert.equal(trivia.start("room", "admin", "Admin").advanceTrivia, true);
  assert.equal(trivia.getState("room").scores.get("user").score, 1, "cumulative mode must retain scores");
  trivia.stopAll();
  await trivia.flush();
});
