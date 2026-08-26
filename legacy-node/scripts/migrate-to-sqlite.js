#!/usr/bin/env node
require("dotenv").config();
const fs = require("node:fs");
const path = require("node:path");
const { loadConfig } = require("../lib/config");
const { StateDatabase } = require("../lib/state-database");

const config = loadConfig();
const database = new StateDatabase({ filePath: config.databaseFile, logger: console });
const files = [config.memoryFile, config.settingsFile, config.loyaltyFile, config.schedulesFile, config.triviaScoreFile, config.triviaStatsFile, config.rolesFile, config.outboxFile, config.submissionsFile, config.userPreferencesFile, config.marblesSeasonsFile];
let imported = 0;
for (const filePath of files) {
  if (!fs.existsSync(filePath)) continue;
  database.readDocument(filePath, {});
  imported += 1;
}
database.close();
console.log(`SQLite migration complete: ${imported} legacy document(s) imported into ${path.basename(config.databaseFile)}.`);
