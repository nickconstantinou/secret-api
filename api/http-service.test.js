const assert = require("node:assert/strict");
const { once } = require("node:events");
const { test } = require("node:test");

const { ProviderError } = require("./provider.js");
const { createApiService, loadConfig } = require("./http-service.js");

async function withService(overrides, callback) {
  const logs = [];
  const provider = overrides.provider || {
    name: "agy",
    ready: async () => true,
    generate: async () => ({
      content: "provider response",
      provider: "agy",
      model: "gemini-3.6-flash-low",
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, totalTokens: 15 },
      durationMs: 1250,
    }),
    shutdown: async () => {},
  };
  const service = createApiService({
    authenticate: overrides.authenticate || (() => "horizon-backend"),
    logger: overrides.logger || ((entry) => logs.push(entry)),
    maxBodyBytes: overrides.maxBodyBytes || 1024,
    maxPromptBytes: overrides.maxPromptBytes || 100,
    maxPromptChars: overrides.maxPromptChars || 100,
    provider,
    rateLimiter: overrides.rateLimiter || { consume: () => ({ allowed: true }) },
  });
  service.server.listen(0, "127.0.0.1");
  await once(service.server, "listening");
  const { port } = service.server.address();
  try {
    await callback({ logs, service, url: `http://127.0.0.1:${port}` });
  } finally {
    await service.close();
  }
}

function post(url, options = {}) {
  return fetch(`${url}/secure-proxy`, {
    method: "POST",
    headers: {
      Authorization: `Bearer horizon-backend.${"a".repeat(43)}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
    body: options.body ?? JSON.stringify({ prompt: "hello" }),
  });
}

test("health and readiness do not run inference", async () => {
  let generated = false;
  await withService({
    provider: {
      name: "agy",
      ready: async () => true,
      generate: async () => { generated = true; },
      shutdown: async () => {},
    },
  }, async ({ url }) => {
    assert.deepEqual(await (await fetch(`${url}/health`)).json(), { status: "ok" });
    assert.deepEqual(await (await fetch(`${url}/ready`)).json(), { status: "ready" });
    assert.equal(generated, false);
  });
});

test("readiness fails closed for unavailable providers", async () => {
  await withService({
    provider: {
      name: "agy",
      ready: async () => false,
      shutdown: async () => {},
    },
  }, async ({ url }) => {
    const response = await fetch(`${url}/ready`);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { status: "not_ready" });
  });
});

test("authenticates service keys and never forwards credentials", async () => {
  const providerCalls = [];
  const authHeaders = [];
  await withService({
    authenticate: (header) => {
      authHeaders.push(header);
      return "horizon-backend";
    },
    provider: {
      name: "agy",
      ready: async () => true,
      generate: async (request) => {
        providerCalls.push(request);
        return { content: "answer", provider: "agy", model: "model", durationMs: 1 };
      },
      shutdown: async () => {},
    },
  }, async ({ url }) => {
    const response = await post(url);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { content: "answer" });
  });

  assert.equal(authHeaders.length, 1);
  assert.equal(providerCalls.length, 1);
  assert.deepEqual(Object.keys(providerCalls[0]).sort(), ["prompt", "requestId", "signal"]);
  assert.doesNotMatch(JSON.stringify(providerCalls), /Bearer|horizon-backend/);
});

test("returns generic 401 for invalid service keys", async () => {
  await withService({ authenticate: () => null }, async ({ url }) => {
    const response = await post(url);
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "Unauthorized." });
  });
});

test("validates content type, JSON, prompt characters, and UTF-8 bytes", async () => {
  await withService({ maxPromptBytes: 5, maxPromptChars: 4 }, async ({ url }) => {
    const wrongType = await post(url, { headers: { "Content-Type": "text/plain" } });
    assert.equal(wrongType.status, 415);
    const malformed = await post(url, { body: "{" });
    assert.equal(malformed.status, 400);
    const nullBody = await post(url, { body: "null" });
    assert.equal(nullBody.status, 400);
    const arrayBody = await post(url, { body: "[]" });
    assert.equal(arrayBody.status, 400);
    const missing = await post(url, { body: "{}" });
    assert.equal(missing.status, 400);
    const chars = await post(url, { body: JSON.stringify({ prompt: "abcde" }) });
    assert.equal(chars.status, 413);
    const bytes = await post(url, { body: JSON.stringify({ prompt: "€€" }) });
    assert.equal(bytes.status, 413);
    const exact = await post(url, { body: JSON.stringify({ prompt: "éé" }) });
    assert.equal(exact.status, 200);
  });
});

test("rejects oversized request bodies before provider execution", async () => {
  let generated = false;
  await withService({
    maxBodyBytes: 32,
    provider: {
      name: "agy",
      ready: async () => true,
      generate: async () => { generated = true; },
      shutdown: async () => {},
    },
  }, async ({ url }) => {
    const response = await post(url, {
      body: JSON.stringify({ prompt: "x", padding: "y".repeat(100) }),
    });
    assert.equal(response.status, 413);
    assert.equal(generated, false);
  });
});

test("rate and provider capacity return 429 with Retry-After", async () => {
  await withService({
    rateLimiter: { consume: () => ({ allowed: false, retryAfterSeconds: 7 }) },
  }, async ({ url }) => {
    const response = await post(url);
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("Retry-After"), "7");
  });

  await withService({
    provider: {
      name: "agy",
      ready: async () => true,
      generate: async () => { throw new ProviderError("PROVIDER_CAPACITY", "private"); },
      shutdown: async () => {},
    },
  }, async ({ url }) => {
    const response = await post(url);
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("Retry-After"), "1");
  });
});

test("maps stable provider failures to safe public errors", async () => {
  const mappings = [
    ["PROVIDER_INPUT_TOO_LARGE", 413],
    ["PROVIDER_SHUTTING_DOWN", 503],
    ["PROVIDER_TIMEOUT", 504],
    ["PROVIDER_OUTPUT_LIMIT", 502],
    ["PROVIDER_INVALID_RESPONSE", 502],
    ["PROVIDER_FAILURE", 502],
  ];
  for (const [code, status] of mappings) {
    await withService({
      provider: {
        name: "agy",
        ready: async () => true,
        generate: async () => { throw new ProviderError(code, "private detail"); },
        shutdown: async () => {},
      },
    }, async ({ url }) => {
      const response = await post(url);
      assert.equal(response.status, status);
      assert.doesNotMatch(await response.text(), /private detail/);
    });
  }
});

test("validates request IDs and emits privacy-safe telemetry", async () => {
  await withService({}, async ({ logs, url }) => {
    const response = await post(url, {
      headers: { "X-Request-ID": "valid-request_123" },
      body: JSON.stringify({ prompt: "private medical prompt" }),
    });
    assert.equal(response.headers.get("X-Request-ID"), "valid-request_123");
    assert.equal(logs.length, 1);
    assert.equal(logs[0].client_id, "horizon-backend");
    assert.equal(logs[0].provider, "agy");
    assert.equal(logs[0].total_tokens, 15);
    assert.doesNotMatch(JSON.stringify(logs), /private medical prompt|Bearer|a{20}/);
  });

  await withService({}, async ({ url }) => {
    const response = await post(url, { headers: { "X-Request-ID": "bad value" } });
    assert.notEqual(response.headers.get("X-Request-ID"), "bad value");
  });
});

test("shutdown rejects new requests and delegates to provider", async () => {
  let stopped = false;
  await withService({
    provider: {
      name: "agy",
      ready: async () => true,
      generate: async () => ({ content: "ok", provider: "agy" }),
      shutdown: async () => { stopped = true; },
    },
  }, async ({ service, url }) => {
    await service.beginShutdown();
    assert.equal(stopped, true);
    const response = await post(url);
    assert.equal(response.status, 503);
  });
});

test("supports OPTIONS, rejects other methods, and returns 404", async () => {
  await withService({}, async ({ url }) => {
    assert.equal((await fetch(`${url}/secure-proxy`, { method: "OPTIONS" })).status, 204);
    assert.equal((await fetch(`${url}/secure-proxy`)).status, 405);
    assert.equal((await fetch(`${url}/missing`)).status, 404);
  });
});

test("configuration is provider-neutral and loopback-only", () => {
  const validEnv = {
    AGY_CLI_PATH: "/opt/agy/bin/agy",
    AGY_MAX_ARGUMENT_BYTES: "120000",
    AGY_MODEL: "gemini-3.6-flash-low",
    AGY_WORK_DIR: "/var/lib/secret-api/agy-work",
    API_HOST: "127.0.0.1",
    API_PORT: "8787",
    CLIENT_KEYS_FILE: "/etc/secret-api/client-keys.json",
    LLM_PROVIDER: "agy",
    MAX_ACTIVE_CALLS: "1",
    MAX_QUEUE_SIZE: "4",
    RATE_LIMIT_COUNT: "10",
    RATE_LIMIT_WINDOW_MS: "60000",
  };
  const config = loadConfig(validEnv);
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.provider.name, "agy");
  assert.equal(config.provider.agy.maxArgumentBytes, 120000);
  assert.equal(config.maxActiveCalls, 1);
  assert.equal(config.maxQueueSize, 4);
  assert.throws(() => loadConfig({ ...validEnv, API_HOST: "0.0.0.0" }), /loopback/);
  assert.throws(() => loadConfig({}), /CLIENT_KEYS_FILE is required/);
});
