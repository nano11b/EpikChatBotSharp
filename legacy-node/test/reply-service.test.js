const test = require("node:test");
const assert = require("node:assert/strict");

const { ReplyService } = require("../lib/reply-service");

test("OpenAI failures are logged and fall back safely", async () => {
  const errors = [];
  const replies = [];
  const memory = {
    getContext: () => [],
    incrementTreats: () => 1,
    isRepeatedReply: () => false,
    rememberReply: (reply) => replies.push(reply),
  };
  const service = new ReplyService({
    openai: { responses: { create: async () => { throw new Error("API unavailable"); } } },
    model: "test-model",
    botName: "Test Cat",
    maxReplyLength: 140,
    memory,
    logger: { error: (...args) => errors.push(args.join(" ")) },
  });

  const reply = await service.generate({ message: "hello", senderId: "1", senderName: "Alice", command: "unknown" });
  assert.match(reply, /Test Cat/);
  assert.equal(errors.some((entry) => entry.includes("API unavailable")), true);
  assert.equal(replies.length, 1);
});

test("room AI settings disable API calls and apply the room bot name", async () => {
  let called = false;
  const memory = {
    getContext: () => [],
    incrementTreats: () => 1,
    isRepeatedReply: () => false,
    rememberReply() {},
  };
  const service = new ReplyService({
    openai: { responses: { create: async () => { called = true; return { output_text: "api" }; } } },
    model: "test",
    botName: "Default Cat",
    maxReplyLength: 140,
    memory,
    logger: { error() {} },
  });
  const reply = await service.generate({
    roomId: "room",
    message: "hello",
    senderId: "1",
    senderName: "Alice",
    command: "unknown",
    roomSettings: { ai: { enabled: false }, bot: { name: "Room Owl" } },
  });
  assert.equal(called, false);
  assert.match(reply, /Room Owl/);
});
