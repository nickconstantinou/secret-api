const assert = require("node:assert/strict");
const { chmod, mkdtemp, rm, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const {
  ClientKeyRegistry,
  hashSecret,
  loadClientKeyRegistry,
  parseBearerCredential,
} = require("./client-keys.js");

const ACTIVE_SECRET = "a".repeat(43);
const ROTATED_SECRET = "b".repeat(43);

function registryData(overrides = {}) {
  return {
    version: 1,
    clients: [
      {
        id: "horizon-backend",
        keys: [
          { hash: hashSecret(ACTIVE_SECRET) },
          { hash: hashSecret(ROTATED_SECRET), expires_at: "2030-01-01T00:00:00Z" },
        ],
      },
    ],
    ...overrides,
  };
}

test("parses the service-to-service bearer credential", () => {
  assert.deepEqual(
    parseBearerCredential(`Bearer horizon-backend.${ACTIVE_SECRET}`),
    { clientId: "horizon-backend", secret: ACTIVE_SECRET }
  );
  for (const value of [
    undefined,
    "",
    "Basic abc",
    "Bearer missing-separator",
    "Bearer Bad_ID." + ACTIVE_SECRET,
    "Bearer horizon-backend.short",
    "Bearer horizon-backend.secret with spaces",
  ]) {
    assert.equal(parseBearerCredential(value), null);
  }
});

test("authenticates active overlapping rotation keys", () => {
  const registry = ClientKeyRegistry.fromData(registryData(), {
    now: () => new Date("2029-01-01T00:00:00Z"),
  });

  assert.equal(
    registry.authenticate(`Bearer horizon-backend.${ACTIVE_SECRET}`),
    "horizon-backend"
  );
  assert.equal(
    registry.authenticate(`Bearer horizon-backend.${ROTATED_SECRET}`),
    "horizon-backend"
  );
});

test("rejects unknown, disabled, and expired keys generically", () => {
  const registry = ClientKeyRegistry.fromData({
    version: 1,
    clients: [
      {
        id: "horizon-backend",
        keys: [
          { hash: hashSecret(ACTIVE_SECRET), disabled: true },
          { hash: hashSecret(ROTATED_SECRET), expires_at: "2025-01-01T00:00:00Z" },
        ],
      },
    ],
  }, { now: () => new Date("2026-01-01T00:00:00Z") });

  assert.equal(registry.authenticate(`Bearer horizon-backend.${ACTIVE_SECRET}`), null);
  assert.equal(registry.authenticate(`Bearer horizon-backend.${ROTATED_SECRET}`), null);
  assert.equal(registry.authenticate(`Bearer unknown.${ACTIVE_SECRET}`), null);
  assert.equal(registry.authenticate(`Bearer horizon-backend.${"c".repeat(43)}`), null);
});

test("rejects duplicate clients and invalid hashes", () => {
  assert.throws(
    () => ClientKeyRegistry.fromData({
      version: 1,
      clients: [
        { id: "duplicate", keys: [{ hash: hashSecret(ACTIVE_SECRET) }] },
        { id: "duplicate", keys: [{ hash: hashSecret(ROTATED_SECRET) }] },
      ],
    }),
    /Duplicate client identifier/
  );
  assert.throws(
    () => ClientKeyRegistry.fromData({
      version: 1,
      clients: [{ id: "client", keys: [{ hash: "plaintext-secret" }] }],
    }),
    /64-character SHA-256 hex digest/
  );
});

test("loads only a restrictively permissioned key registry", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "secret-api-keys-"));
  const file = path.join(directory, "keys.json");
  try {
    await writeFile(file, JSON.stringify(registryData()), { mode: 0o600 });
    const registry = await loadClientKeyRegistry(file);
    assert.equal(
      registry.authenticate(`Bearer horizon-backend.${ACTIVE_SECRET}`),
      "horizon-backend"
    );

    await chmod(file, 0o640);
    await assert.rejects(loadClientKeyRegistry(file), /mode 0600/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("reload swaps valid registries atomically", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "secret-api-keys-"));
  const file = path.join(directory, "keys.json");
  try {
    await writeFile(file, JSON.stringify(registryData()), { mode: 0o600 });
    const registry = await loadClientKeyRegistry(file);

    const nextSecret = "d".repeat(43);
    await writeFile(file, JSON.stringify({
      version: 1,
      clients: [{ id: "lab-backend", keys: [{ hash: hashSecret(nextSecret) }] }],
    }), { mode: 0o600 });
    await registry.reload();

    assert.equal(registry.authenticate(`Bearer horizon-backend.${ACTIVE_SECRET}`), null);
    assert.equal(registry.authenticate(`Bearer lab-backend.${nextSecret}`), "lab-backend");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
