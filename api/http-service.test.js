const assert = require("node:assert/strict");
const { once } = require("node:events");
const { test } = require("node:test");

const { AgyRunnerError } = require("./agy-runner.js");
const {
  createApiServer,
  loadConfig,
  verifyInsforgeSession,
} = require("./http-service.js");

async function withServer(options, callback) {
  const server = createApiServer(options);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  try {
    await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    server.close();
    await once(server, "close");
  }
}

function serviceOptions(overrides = {}) {
  return {
    allowedOrigins: ["https://client.example"],
    authenticate: async () => true,
    logger: () => {},
    maxBodyBytes: 1024,
    maxPromptChars: 100,
    readiness: () => true,
    runner: {
      model: "gemini-3.6-flash-low",
      runDetailed: async () => ({
        content: "provider response",
        durationSeconds: 1.5,
        model: "gemini-3.6-flash-low",
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      }),
    },
    ...overrides,
  };
}

function post(url, options = {}) {
  return fetch(`${url}/secure-proxy`, {
    method: "POST",
    headers: {
      Authorization: "Bearer session-token",
      "Content-Type": "application/json",
      Origin: "https://client.example",
      ...options.headers,
    },
    body: options.body ?? JSON.stringify({ prompt: "hello" }),
  });
}

test("health and readiness do not authenticate or invoke Agy", async () => {
  let calls = 0;
  await withServer(
    serviceOptions({
      authenticate: async () => {
        calls += 1;
        return true;
      },
      runner: {
        runDetailed: async () => {
          calls += 1;
          throw new Error("unexpected");
        },
      },
    }),
    async (url) => {
      const health = await fetch(`${url}/health`);
      assert.equal(health.status, 200);
      assert.deepEqual(await health.json(), { status: "ok" });

      const ready = await fetch(`${url}/ready`);
      assert.equal(ready.status, 200);
      assert.deepEqual(await ready.json(), { status: "ready" });
      assert.equal(calls, 0);
    }
  );
});

test("readiness reports unavailable dependencies", async () => {
  await withServer(serviceOptions({ readiness: () => false }), async (url) => {
    const response = await fetch(`${url}/ready`);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { status: "not_ready" });
  });
});

test("allows CORS preflight only for configured origins", async () => {
  await withServer(serviceOptions(), async (url) => {
    const allowed = await fetch(`${url}/secure-proxy`, {
      method: "OPTIONS",
      headers: { Origin: "https://client.example" },
    });
    assert.equal(allowed.status, 204);
    assert.equal(
      allowed.headers.get("Access-Control-Allow-Origin"),
      "https://client.example"
    );

    const denied = await fetch(`${url}/secure-proxy`, {
      method: "OPTIONS",
      headers: { Origin: "https://attacker.example" },
    });
    assert.equal(denied.status, 403);
  });
});

test("requires a bearer session before reading prompts", async () => {
  let runnerCalled = false;
  await withServer(
    serviceOptions({
      authenticate: async () => false,
      runner: {
        runDetailed: async () => {
          runnerCalled = true;
        },
      },
    }),
    async (url) => {
      const response = await post(url);
      assert.equal(response.status, 401);
      assert.deepEqual(await response.json(), { error: "Unauthorized." });
      assert.equal(runnerCalled, false);
    }
  );
});

test("returns 503 when the authentication service is unavailable", async () => {
  await withServer(
    serviceOptions({
      authenticate: async () => {
        throw new Error("session service failed");
      },
    }),
    async (url) => {
      const response = await post(url);
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), {
        error: "Authentication service unavailable.",
      });
    }
  );
});

test("rejects malformed and oversized prompt bodies", async () => {
  await withServer(serviceOptions(), async (url) => {
    const malformed = await post(url, { body: "{" });
    assert.equal(malformed.status, 400);
    assert.deepEqual(await malformed.json(), { error: "Invalid JSON body." });

    const missing = await post(url, { body: JSON.stringify({}) });
    assert.equal(missing.status, 400);
    assert.deepEqual(await missing.json(), { error: "Missing prompt." });

    const longPrompt = await post(url, {
      body: JSON.stringify({ prompt: "x".repeat(101) }),
    });
    assert.equal(longPrompt.status, 413);
    assert.deepEqual(await longPrompt.json(), { error: "Prompt is too large." });

    const largeBody = await post(url, {
      body: JSON.stringify({ prompt: "x", padding: "y".repeat(1100) }),
    });
    assert.equal(largeBody.status, 413);
    assert.deepEqual(await largeBody.json(), { error: "Request body is too large." });
  });
});

test("returns content and logs safe request telemetry", async () => {
  const logs = [];
  const authHeaders = [];
  const prompts = [];
  await withServer(
    serviceOptions({
      authenticate: async (authorization) => {
        authHeaders.push(authorization);
        return true;
      },
      logger: (entry) => logs.push(entry),
      runner: {
        model: "gemini-3.6-flash-low",
        runDetailed: async (prompt) => {
          prompts.push(prompt);
          return {
            content: "safe result",
            durationSeconds: 1.5,
            model: "gemini-3.6-flash-low",
            usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          };
        },
      },
    }),
    async (url) => {
      const response = await post(url, {
        headers: { "X-Request-ID": "request-123" },
        body: JSON.stringify({ prompt: "private medical prompt" }),
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { content: "safe result" });
      assert.equal(response.headers.get("X-Request-ID"), "request-123");
    }
  );

  assert.deepEqual(authHeaders, ["Bearer session-token"]);
  assert.deepEqual(prompts, ["private medical prompt"]);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].event, "agy_api_request");
  assert.equal(logs[0].request_id, "request-123");
  assert.equal(logs[0].status, 200);
  assert.equal(logs[0].outcome, "success");
  assert.equal(logs[0].model, "gemini-3.6-flash-low");
  assert.equal(logs[0].total_tokens, 15);
  assert.equal(typeof logs[0].duration_ms, "number");
  assert.doesNotMatch(JSON.stringify(logs), /private medical prompt/);
  assert.doesNotMatch(JSON.stringify(logs), /session-token/);
});

test("maps queue, timeout, shutdown, and provider errors", async () => {
  const cases = [
    ["AGY_QUEUE_FULL", 429, "Service queue is full."],
    ["AGY_TIMEOUT", 504, "Provider timed out."],
    ["AGY_SHUTTING_DOWN", 503, "Service is shutting down."],
    ["AGY_PROCESS_FAILED", 502, "Provider request failed."],
  ];

  for (const [code, expectedStatus, expectedMessage] of cases) {
    await withServer(
      serviceOptions({
        runner: {
          runDetailed: async () => {
            throw new AgyRunnerError(code, "internal detail");
          },
        },
      }),
      async (url) => {
        const response = await post(url);
        assert.equal(response.status, expectedStatus);
        assert.deepEqual(await response.json(), { error: expectedMessage });
      }
    );
  }
});

test("rejects unsupported methods and unknown routes", async () => {
  await withServer(serviceOptions(), async (url) => {
    const method = await fetch(`${url}/secure-proxy`, { method: "GET" });
    assert.equal(method.status, 405);
    const missing = await fetch(`${url}/missing`);
    assert.equal(missing.status, 404);
  });
});

test("validates Insforge sessions with the bearer header", async () => {
  const calls = [];
  const authenticated = await verifyInsforgeSession("Bearer abc", {
    baseUrl: "https://auth.example/",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(null, { status: 200 });
    },
    timeoutMs: 1000,
  });

  assert.equal(authenticated, true);
  assert.equal(calls[0].url, "https://auth.example/api/auth/sessions/current");
  assert.equal(calls[0].options.headers.Authorization, "Bearer abc");
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  assert.equal(
    await verifyInsforgeSession("Basic abc", {
      baseUrl: "https://auth.example",
      fetchImpl: async () => {
        throw new Error("unexpected");
      },
    }),
    false
  );
});

test("configuration requires local binding and explicit service settings", () => {
  const config = loadConfig({
    AGY_CLI_PATH: "/opt/agy/bin/agy",
    AGY_MAX_QUEUE_SIZE: "3",
    AGY_MODEL: "gemini-3.6-flash-low",
    AGY_WORK_DIR: "/var/lib/secret-api/agy-work",
    ALLOWED_ORIGINS: "https://one.example, https://two.example",
    API_HOST: "127.0.0.1",
    API_PORT: "8787",
    INSFORGE_BASE_URL: "https://auth.example/",
  });

  assert.deepEqual(config.allowedOrigins, [
    "https://one.example",
    "https://two.example",
  ]);
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 8787);
  assert.equal(config.runner.maxQueueSize, 3);
  assert.equal(config.insforgeBaseUrl, "https://auth.example");

  assert.throws(
    () => loadConfig({ ...process.env, API_HOST: "0.0.0.0" }),
    /API_HOST must be 127\.0\.0\.1/
  );
  assert.throws(() => loadConfig({}), /AGY_WORK_DIR is required/);
});
