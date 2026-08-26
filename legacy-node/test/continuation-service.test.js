const test = require("node:test");
const assert = require("node:assert/strict");

const { ContinuationService, splitMessage } = require("../lib/continuation-service");

test("message splitting keeps every EpikChat message within 250 characters", () => {
  const source = Array.from({ length: 120 }, (_, index) => `word${index}`).join(" ");
  const chunks = splitMessage(source, 250, " … (^continue)");
  assert.ok(chunks.length > 2);
  assert.equal(chunks.every((chunk) => chunk.length <= 250), true);
  assert.equal(chunks.slice(0, -1).every((chunk) => chunk.endsWith("(^continue)")), true);
  assert.equal(chunks.at(-1).endsWith("(^continue)"), false);
});

test("AI continuations are isolated per user and expire", () => {
  let now = 1000;
  const service = new ContinuationService({ maxLength: 50, ttlMs: 100, now: () => now });
  const first = service.start("room", "alice", "Alice", "This is a long response with enough words to require several continuation pages for Alice only.");
  assert.ok(first.length <= 50);
  assert.match(first, /\^continue/);
  assert.equal(service.next("room", "bob", "Bob").ok, false);
  assert.equal(service.next("room", "alice", "Alice").ok, true);
  now += 101;
  assert.equal(service.next("room", "alice", "Alice").ok, false);
});
