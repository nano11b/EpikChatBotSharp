const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { MarblesBridge } = require("../marbles");

test("MarblesBridge keeps stable identities across renames and restarts", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "epikchat-marbles-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const filePath = path.join(directory, "marbles.csv");
  const bridge = new MarblesBridge({ enabled: true, filePath, confirmJoins: false });

  assert.equal(bridge.addPlayer("user-1", "Alice").count, 1);
  assert.equal(bridge.addPlayer("user-2", "Alice").count, 2);

  const renamed = bridge.addPlayer("user-1", "Alicia");
  assert.equal(renamed.duplicate, true);
  assert.equal(renamed.count, 2);
  await bridge.flush();
  assert.match(fs.readFileSync(filePath, "utf8"), /Alicia/);

  const reloaded = new MarblesBridge({ enabled: true, filePath, confirmJoins: false });
  assert.equal(reloaded.players.size, 2);
  assert.equal(reloaded.removePlayer("user-1", "Alicia").existed, true);
  assert.equal(reloaded.players.size, 1);
  assert.equal(reloaded.removePlayer("user-2", "Alice").existed, true);
  await reloaded.flush();
});
