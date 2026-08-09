const assert = require("node:assert/strict");
const { afterEach, test } = require("node:test");

const secureProxy = require("./secure-proxy.js");

const originalFetch = globalThis.fetch;
const originalEnv = {
  INSFORGE_BASE_URL: process.env.INSFORGE_BASE_URL,
  MINIMAX_API_KEY: process.env.MINIMAX_API_KEY,
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [name, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
});

function request(body = { prompt: "say hello" }, options = {}) {
  return new Request("http://localhost/secure-proxy", {
    method: "POST",
    headers: {
      Authorization: "Bearer test-session",
      "Content-Type": "application/json",
      ...options.headers,
    },
    body: JSON.stringify(body),
    ...options,
  });
}

function configureEnvironment() {
  process.env.INSFORGE_BASE_URL = "https://example.insforge.test";
  process.env.MINIMAX_API_KEY = "test-api-key";
}

test("handles CORS preflight", async () => {
  const response = await secureProxy(
    new Request("http://localhost/secure-proxy", { method: "OPTIONS" })
  );

  assert.equal(response.status, 200);
  assert.equal(await response.text(), "ok");
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
});

test("rejects methods other than POST and OPTIONS", async () => {
  const response = await secureProxy(
    new Request("http://localhost/secure-proxy", { method: "GET" })
  );

  assert.equal(response.status, 405);
  assert.deepEqual(await response.json(), { error: "Method not allowed." });
});

test("rejects requests without a bearer token", async () => {
  configureEnvironment();
  let fetchCalled = false;
  globalThis.fetch = async () => {
    fetchCalled = true;
    throw new Error("unexpected fetch");
  };

  const response = await secureProxy(
    request(undefined, { headers: { Authorization: "" } })
  );

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "Unauthorized." });
  assert.equal(fetchCalled, false);
});

test("validates the bearer token with Insforge Auth", async () => {
  configureEnvironment();
  globalThis.fetch = async (url, init) => {
    assert.equal(
      url,
      "https://example.insforge.test/api/auth/sessions/current"
    );
    assert.equal(init.headers.Authorization, "Bearer test-session");
    return new Response("Unauthorized", { status: 401 });
  };

  const response = await secureProxy(request());

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "Unauthorized." });
});

test("returns 500 when the MiniMax API key is missing", async () => {
  process.env.INSFORGE_BASE_URL = "https://example.insforge.test";
  delete process.env.MINIMAX_API_KEY;
  globalThis.fetch = async () => new Response(null, { status: 200 });

  const response = await secureProxy(request());

  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), {
    error: "MINIMAX_API_KEY is not configured in environment.",
  });
});

test("returns 400 when the prompt is missing", async () => {
  configureEnvironment();
  globalThis.fetch = async () => new Response(null, { status: 200 });

  const response = await secureProxy(request({}));

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: "Missing prompt in request body.",
  });
});

test("returns provider content for an authenticated request", async () => {
  configureEnvironment();
  const fetchCalls = [];
  globalThis.fetch = async (url, init) => {
    fetchCalls.push([url, init]);
    if (fetchCalls.length === 1) {
      return new Response(null, { status: 200 });
    }
    return Response.json({
      choices: [{ message: { content: "Hello from the provider" } }],
    });
  };

  const response = await secureProxy(request());

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    content: "Hello from the provider",
  });
  assert.equal(fetchCalls.length, 2);
  assert.equal(
    fetchCalls[1][0],
    "https://api.minimax.io/v1/chat/completions"
  );
  assert.equal(
    fetchCalls[1][1].headers.Authorization,
    "Bearer test-api-key"
  );
  assert.deepEqual(JSON.parse(fetchCalls[1][1].body), {
    model: "MiniMax-M2.5",
    messages: [{ role: "user", content: "say hello" }],
  });
});

test("returns the upstream error without exposing credentials", async () => {
  configureEnvironment();
  let callCount = 0;
  globalThis.fetch = async () => {
    callCount += 1;
    if (callCount === 1) {
      return new Response(null, { status: 200 });
    }
    return new Response("Service unavailable", { status: 503 });
  };

  const response = await secureProxy(request());

  assert.equal(response.status, 400);
  const body = await response.json();
  assert.deepEqual(body, {
    error: "Upstream API error: 503 Service unavailable",
  });
  assert.doesNotMatch(JSON.stringify(body), /test-api-key/);
});

test("rejects an empty provider response", async () => {
  configureEnvironment();
  let callCount = 0;
  globalThis.fetch = async () => {
    callCount += 1;
    return callCount === 1
      ? new Response(null, { status: 200 })
      : Response.json({ choices: [] });
  };

  const response = await secureProxy(request());

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: "MiniMax returned empty choices.",
  });
});
