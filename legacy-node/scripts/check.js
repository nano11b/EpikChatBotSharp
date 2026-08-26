#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const files = [path.join(root, "main.js"), path.join(root, "marbles.js")];
for (const directory of [path.join(root, "lib"), path.join(root, "scripts")]) {
  files.push(...fs.readdirSync(directory).filter((name) => name.endsWith(".js")).map((name) => path.join(directory, name)));
}
for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status || 1);
}
