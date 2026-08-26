"use strict";

function parseCommand(content) {
  const trimmed = typeof content === "string" ? content.trim() : "";
  if (!trimmed.startsWith("^")) return { isCommand: false, command: null, text: trimmed };
  const body = trimmed.slice(1).trim();
  if (!body) return { isCommand: true, command: null, text: "" };
  const [command, ...args] = body.split(/\s+/);
  return { isCommand: true, command: command.toLowerCase(), text: args.join(" ").trim() };
}

module.exports = { parseCommand };
