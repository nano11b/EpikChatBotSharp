const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { atomicWriteFile } = require("./persistence");

function checksum(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

class BackupService {
  constructor({ directory, files, encryptionKey = "", flush = async () => {}, deferredFiles = [], logger = console }) {
    this.directory = path.resolve(directory);
    this.files = Object.fromEntries(Object.entries(files).map(([name, filePath]) => [name, path.resolve(filePath)]));
    this.encryptionKey = encryptionKey;
    this.flushSources = flush;
    this.deferredFiles = new Set(deferredFiles);
    this.logger = logger;
  }

  encode(bundle) {
    const plaintext = JSON.stringify(bundle, null, 2);
    if (!this.encryptionKey) return plaintext;
    const salt = crypto.randomBytes(16);
    const iv = crypto.randomBytes(12);
    const key = crypto.scryptSync(this.encryptionKey, salt, 32);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return JSON.stringify({
      version: 1,
      encrypted: true,
      salt: salt.toString("base64"),
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      data: ciphertext.toString("base64"),
    }, null, 2);
  }

  decode(contents) {
    const parsed = JSON.parse(contents);
    if (!parsed.encrypted) return parsed;
    if (!this.encryptionKey) throw new Error("BACKUP_ENCRYPTION_KEY is required for this backup.");
    const key = crypto.scryptSync(this.encryptionKey, Buffer.from(parsed.salt, "base64"), 32);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(parsed.iv, "base64"));
    decipher.setAuthTag(Buffer.from(parsed.tag, "base64"));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(parsed.data, "base64")), decipher.final()]).toString("utf8"));
  }

  resolveBackup(name) {
    const safe = path.basename(String(name));
    if (safe !== name || !safe.endsWith(".backup.json")) throw new Error("Invalid backup name.");
    const resolved = path.resolve(this.directory, safe);
    if (path.dirname(resolved) !== this.directory) throw new Error("Invalid backup path.");
    return resolved;
  }

  async create() {
    await this.flushSources();
    const files = {};
    for (const [name, filePath] of Object.entries(this.files)) {
      if (!fs.existsSync(filePath)) continue;
      const data = await fs.promises.readFile(filePath);
      files[name] = { checksum: checksum(data), data: data.toString("base64") };
    }
    const createdAt = new Date().toISOString();
    const bundle = { version: 1, createdAt, files };
    const name = `${createdAt.replace(/[:.]/g, "-")}.backup.json`;
    await atomicWriteFile(this.resolveBackup(name), this.encode(bundle));
    return { name, createdAt, files: Object.keys(files), encrypted: Boolean(this.encryptionKey) };
  }

  list() {
    if (!fs.existsSync(this.directory)) return [];
    return fs.readdirSync(this.directory).filter((name) => name.endsWith(".backup.json")).sort().reverse();
  }

  inspect(name) {
    const bundle = this.decode(fs.readFileSync(this.resolveBackup(name), "utf8"));
    for (const [fileName, entry] of Object.entries(bundle.files || {})) {
      if (!this.files[fileName]) throw new Error(`Backup contains unknown file: ${fileName}`);
      if (checksum(Buffer.from(entry.data, "base64")) !== entry.checksum) throw new Error(`Checksum failed: ${fileName}`);
    }
    return { name, createdAt: bundle.createdAt, files: Object.keys(bundle.files || {}) };
  }

  async restore(name) {
    const info = this.inspect(name);
    const bundle = this.decode(fs.readFileSync(this.resolveBackup(name), "utf8"));
    for (const [fileName, entry] of Object.entries(bundle.files || {})) {
      const target = this.deferredFiles.has(fileName) ? `${this.files[fileName]}.restore-pending` : this.files[fileName];
      await atomicWriteFile(target, Buffer.from(entry.data, "base64"), null);
    }
    return { ...info, restartRequired: this.deferredFiles.size > 0 };
  }
}

module.exports = { BackupService, checksum };
