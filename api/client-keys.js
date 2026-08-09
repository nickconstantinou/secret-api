const crypto = require("node:crypto");
const { readFile, stat } = require("node:fs/promises");

const CLIENT_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43,128}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/i;
const DUMMY_HASH = crypto.createHash("sha256").update("invalid-client-key").digest();

function hashSecret(secret) {
  return crypto.createHash("sha256").update(secret, "utf8").digest("hex");
}

function parseBearerCredential(authorization) {
  if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) {
    return null;
  }
  const credential = authorization.slice(7);
  const separator = credential.indexOf(".");
  if (separator < 1 || credential.indexOf(".", separator + 1) !== -1) {
    return null;
  }
  const clientId = credential.slice(0, separator);
  const secret = credential.slice(separator + 1);
  if (!CLIENT_ID_PATTERN.test(clientId) || !SECRET_PATTERN.test(secret)) {
    return null;
  }
  return { clientId, secret };
}

function parseExpiry(value) {
  if (value === undefined) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error("Client key expiry must be an ISO timestamp.");
  }
  return timestamp;
}

function parseRegistryData(data) {
  if (!data || data.version !== 1 || !Array.isArray(data.clients)) {
    throw new Error("Client key registry version 1 is required.");
  }
  const clients = new Map();
  for (const client of data.clients) {
    if (!client || !CLIENT_ID_PATTERN.test(client.id || "")) {
      throw new Error("Client identifier is invalid.");
    }
    if (clients.has(client.id)) {
      throw new Error(`Duplicate client identifier: ${client.id}`);
    }
    if (!Array.isArray(client.keys) || client.keys.length === 0) {
      throw new Error(`Client ${client.id} must have at least one key hash.`);
    }
    const keys = client.keys.map((key) => {
      if (!key || !HASH_PATTERN.test(key.hash || "")) {
        throw new Error("Client key hash must be a 64-character SHA-256 hex digest.");
      }
      return {
        disabled: Boolean(client.disabled || key.disabled),
        expiresAt: parseExpiry(key.expires_at),
        hash: Buffer.from(key.hash, "hex"),
      };
    });
    clients.set(client.id, keys);
  }
  return clients;
}

class ClientKeyRegistry {
  constructor(clients, options = {}) {
    this.clients = clients;
    this.now = options.now || (() => new Date());
    this.reloadSource = options.reloadSource;
  }

  static fromData(data, options = {}) {
    return new ClientKeyRegistry(parseRegistryData(data), options);
  }

  authenticate(authorization) {
    const credential = parseBearerCredential(authorization);
    if (!credential) return null;

    const candidate = Buffer.from(hashSecret(credential.secret), "hex");
    const keys = this.clients.get(credential.clientId) || [
      { disabled: true, expiresAt: null, hash: DUMMY_HASH },
    ];
    const now = this.now().getTime();
    let accepted = false;
    for (const key of keys) {
      const matches = crypto.timingSafeEqual(candidate, key.hash);
      const active = !key.disabled && (key.expiresAt === null || key.expiresAt > now);
      accepted = accepted || (matches && active);
    }
    return accepted ? credential.clientId : null;
  }

  async reload() {
    if (!this.reloadSource) {
      throw new Error("Client key registry has no reload source.");
    }
    const next = await this.reloadSource();
    this.clients = next.clients;
  }
}

async function loadClientKeyRegistry(filePath, options = {}) {
  const statImpl = options.stat || stat;
  const readFileImpl = options.readFile || readFile;
  const load = async () => {
    const metadata = await statImpl(filePath);
    if ((metadata.mode & 0o077) !== 0) {
      throw new Error("CLIENT_KEYS_FILE must have mode 0600 or stricter.");
    }
    const data = JSON.parse(await readFileImpl(filePath, "utf8"));
    return ClientKeyRegistry.fromData(data, { now: options.now });
  };
  const registry = await load();
  registry.reloadSource = load;
  return registry;
}

module.exports = {
  ClientKeyRegistry,
  hashSecret,
  loadClientKeyRegistry,
  parseBearerCredential,
};
