const crypto = require("crypto");

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  return { salt, hash: crypto.scryptSync(String(password), salt, 32).toString("hex") };
}

class DashboardAuthService {
  constructor({ database = null, bootstrapUsername = "", bootstrapPassword = "", sessionTtlMs = 43200000, logger = console }) {
    this.database = database; this.sessionTtlMs = sessionTtlMs; this.logger = logger; this.failures = new Map();
    this.accounts = new Map((database?.list("dashboard-accounts") || []).map((entry) => [entry.key, entry.value]));
    this.sessions = new Map((database?.list("dashboard-sessions") || []).map((entry) => [entry.key, entry.value]));
    if (bootstrapUsername && bootstrapPassword && !this.accounts.has(bootstrapUsername.toLowerCase())) this.createAccount(bootstrapUsername, bootstrapPassword, "owner");
  }
  createAccount(username, password, role = "viewer") { const key = String(username).trim().toLowerCase(); if (!key || String(password).length < 12) throw new Error("Dashboard passwords must be at least 12 characters."); const item = { username: key, role, ...hashPassword(password), createdAt: Date.now() }; this.accounts.set(key, item); this.database?.set("dashboard-accounts", key, item); return { username: key, role }; }
  verify(account, password) { const candidate = Buffer.from(hashPassword(password, account.salt).hash, "hex"); const expected = Buffer.from(account.hash, "hex"); return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected); }
  login(username, password, remoteAddress = "unknown") {
    const attempts = (this.failures.get(remoteAddress) || []).filter((time) => Date.now() - time < 900000);
    if (attempts.length >= 5) throw new Error("Too many login attempts. Try again later.");
    const account = this.accounts.get(String(username).trim().toLowerCase());
    if (!account || !this.verify(account, password)) { attempts.push(Date.now()); this.failures.set(remoteAddress, attempts); return null; }
    this.failures.delete(remoteAddress);
    const token = crypto.randomBytes(32).toString("base64url"); const csrf = crypto.randomBytes(24).toString("base64url");
    const session = { username: account.username, role: account.role, csrf, expiresAt: Date.now() + this.sessionTtlMs };
    this.sessions.set(token, session); this.database?.set("dashboard-sessions", token, session); return { token, ...session };
  }
  authenticate(token) { const session = this.sessions.get(String(token || "")); if (!session || session.expiresAt <= Date.now()) { if (token) { this.sessions.delete(token); this.database?.delete("dashboard-sessions", token); } return null; } return session; }
  logout(token) { this.sessions.delete(token); return this.database?.delete("dashboard-sessions", token) || true; }
  listAccounts() { return [...this.accounts.values()].map(({ username, role, createdAt }) => ({ username, role, createdAt })); }
}

module.exports = { DashboardAuthService, hashPassword };
