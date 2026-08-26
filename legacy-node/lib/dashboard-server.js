const http = require("http");
const https = require("https");
const fs = require("fs");
const { URL } = require("url");

const DASHBOARD_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>EpikChat Bot</title>
<style>body{font:16px system-ui;max-width:900px;margin:2rem auto;padding:0 1rem;background:#10151d;color:#e8eef7}button,input,select{font:inherit;padding:.5rem;margin:.25rem}pre{background:#1b2430;padding:1rem;overflow:auto;border-radius:.5rem}.row{display:flex;gap:.5rem;flex-wrap:wrap}</style></head>
<body><h1>EpikChat Bot</h1><div class="row"><input id="username" placeholder="Username"><input id="password" type="password" placeholder="Password"><button onclick="login()">Sign in</button><input id="token" type="password" placeholder="Legacy token"><input id="room" placeholder="Room ID"><button onclick="refresh()">Refresh</button></div>
<pre id="status">Enter token and refresh.</pre><h2>Action</h2><div class="row"><select id="action"><option>trivia-start</option><option>trivia-stop</option><option>marbles-open</option><option>marbles-close</option></select><button onclick="act()">Run</button></div>
<h2>Setting</h2><div class="row"><input id="path" placeholder="ai.enabled"><input id="value" placeholder="true"><button onclick="setting()">Save</button></div>
<script>let csrf='';const headers=()=>({'authorization':token.value?'Bearer '+token.value:'','x-csrf-token':csrf,'content-type':'application/json'});async function login(){const r=await fetch('/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:username.value,password:password.value})});const d=await r.json();csrf=d.csrf||'';password.value='';status.textContent=JSON.stringify(d,null,2);if(r.ok)refresh()}async function refresh(){const r=await fetch('/api/status?room='+encodeURIComponent(room.value),{headers:headers()});status.textContent=JSON.stringify(await r.json(),null,2)}async function act(){await fetch('/api/action',{method:'POST',headers:headers(),body:JSON.stringify({roomId:room.value,action:action.value})});refresh()}async function setting(){await fetch('/api/settings',{method:'POST',headers:headers(),body:JSON.stringify({roomId:room.value,path:path.value,value:value.value})});refresh()}</script></body></html>`;

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) reject(new Error("Request body too large"));
    });
    request.on("end", () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch (error) { reject(error); }
    });
    request.on("error", reject);
  });
}

class DashboardServer {
  constructor({ host = "127.0.0.1", port = 8787, token, auth = null, tlsKeyFile = null, tlsCertFile = null, getStatus, setSetting, runAction, logger = console }) {
    this.host = host;
    this.port = port;
    this.token = token;
    this.auth = auth;
    this.tlsKeyFile = tlsKeyFile; this.tlsCertFile = tlsCertFile;
    this.getStatus = getStatus;
    this.setSetting = setSetting;
    this.runAction = runAction;
    this.logger = logger;
    this.server = null;
  }

  sessionToken(request) { return String(request.headers.cookie || "").split(/;\s*/).find((item) => item.startsWith("epik_session="))?.slice(13) || ""; }

  authorization(request) {
    if (this.token && request.headers.authorization === `Bearer ${this.token}`) return { role: "owner", method: "token" };
    const token = this.sessionToken(request); const session = this.auth?.authenticate(token);
    return session ? { ...session, token, method: "session" } : null;
  }

  authorized(request, role = "viewer") {
    const auth = this.authorization(request); const levels = { viewer: 0, owner: 1 };
    return auth && levels[auth.role] >= levels[role] ? auth : null;
  }

  json(response, status, data) {
    response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; frame-ancestors 'none'" });
    response.end(JSON.stringify(data));
  }

  async handle(request, response) {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    if (url.pathname === "/health") {
      const status = await this.getStatus(null);
      return this.json(response, status.ok ? 200 : 503, status);
    }
    if (url.pathname === "/" && request.method === "GET") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "x-frame-options": "DENY", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors 'none'" });
      response.end(DASHBOARD_HTML);
      return;
    }
    if (url.pathname === "/api/login" && request.method === "POST" && this.auth) {
      const body = await readBody(request); const session = this.auth.login(body.username, body.password, request.socket.remoteAddress);
      if (!session) return this.json(response, 401, { error: "invalid-credentials" });
      response.setHeader("set-cookie", `epik_session=${session.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor((session.expiresAt - Date.now()) / 1000)}${this.tlsKeyFile ? "; Secure" : ""}`);
      return this.json(response, 200, { ok: true, username: session.username, role: session.role, csrf: session.csrf });
    }
    const authorization = this.authorized(request, url.pathname === "/api/status" ? "viewer" : "owner");
    if (!authorization) return this.json(response, 401, { error: "unauthorized" });
    if (request.method !== "GET" && authorization.method === "session" && request.headers["x-csrf-token"] !== authorization.csrf) return this.json(response, 403, { error: "csrf" });
    if (url.pathname === "/api/accounts" && request.method === "GET") return this.json(response, 200, { accounts: this.auth?.listAccounts() || [] });
    if (url.pathname === "/api/accounts" && request.method === "POST" && this.auth) {
      const body = await readBody(request); return this.json(response, 201, this.auth.createAccount(body.username, body.password, body.role === "owner" ? "owner" : "viewer"));
    }
    if (url.pathname === "/api/logout" && request.method === "POST" && this.auth) { this.auth.logout(authorization.token); response.setHeader("set-cookie", "epik_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0"); return this.json(response, 200, { ok: true }); }
    if (url.pathname === "/api/status" && request.method === "GET") {
      return this.json(response, 200, await this.getStatus(url.searchParams.get("room")));
    }
    if (url.pathname === "/api/settings" && request.method === "POST") {
      const body = await readBody(request);
      return this.json(response, 200, await this.setSetting(body));
    }
    if (url.pathname === "/api/action" && request.method === "POST") {
      const body = await readBody(request);
      return this.json(response, 200, await this.runAction(body));
    }
    return this.json(response, 404, { error: "not-found" });
  }

  start() {
    if (this.server) return;
    const listener = (request, response) => {
      this.handle(request, response).catch((error) => {
        this.logger.error("[dashboard]", error);
        if (!response.headersSent) this.json(response, 500, { error: "internal-error" });
        else response.end();
      });
    };
    this.server = this.tlsKeyFile && this.tlsCertFile
      ? https.createServer({ key: fs.readFileSync(this.tlsKeyFile), cert: fs.readFileSync(this.tlsCertFile) }, listener)
      : http.createServer(listener);
    const protocol = this.tlsKeyFile && this.tlsCertFile ? "https" : "http";
    this.server.listen(this.port, this.host, () => this.logger.log(`[dashboard] ${protocol}://${this.host}:${this.port}`));
  }

  stop() {
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
      this.server = null;
    });
  }
}

module.exports = { DashboardServer };
