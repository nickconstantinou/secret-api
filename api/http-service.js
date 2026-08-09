const http = require("node:http");
const { randomUUID } = require("node:crypto");

const { ProviderError } = require("./provider.js");

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

function required(env, name) {
  const value = env[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} is required.`);
  }
  return value.trim();
}

function integer(env, name, fallback, minimum = 1, maximum = Number.MAX_SAFE_INTEGER) {
  const raw = env[name] ?? String(fallback);
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

function loadConfig(env = process.env) {
  const clientKeysFile = required(env, "CLIENT_KEYS_FILE");
  const host = env.API_HOST || "127.0.0.1";
  if (host !== "127.0.0.1") {
    throw new Error("API_HOST must be the loopback address 127.0.0.1.");
  }
  const providerName = env.LLM_PROVIDER || "agy";
  if (providerName !== "agy") {
    throw new Error(`Unsupported LLM_PROVIDER: ${providerName}`);
  }

  return {
    clientKeysFile,
    host,
    maxActiveCalls: integer(env, "MAX_ACTIVE_CALLS", 1),
    maxBodyBytes: integer(env, "MAX_BODY_BYTES", 131_072),
    maxPromptBytes: integer(env, "MAX_PROMPT_BYTES", 120_000),
    maxPromptChars: integer(env, "MAX_PROMPT_CHARS", 120_000),
    maxQueueSize: integer(env, "MAX_QUEUE_SIZE", 4, 0),
    port: integer(env, "API_PORT", 8787, 1, 65_535),
    provider: {
      name: providerName,
      timeoutMs: integer(env, "PROVIDER_TIMEOUT_MS", 300_000),
      agy: {
        binary: required(env, "AGY_CLI_PATH"),
        cwd: required(env, "AGY_WORK_DIR"),
        maxArgumentBytes: integer(env, "AGY_MAX_ARGUMENT_BYTES", 120_000),
        maxOutputBytes: integer(env, "AGY_MAX_OUTPUT_BYTES", 1_048_576),
        model: required(env, "AGY_MODEL"),
      },
    },
    rateLimitCount: integer(env, "RATE_LIMIT_COUNT", 10),
    rateLimitWindowMs: integer(env, "RATE_LIMIT_WINDOW_MS", 60_000),
  };
}

function requestIdFrom(req) {
  const supplied = req.headers["x-request-id"];
  return typeof supplied === "string" && REQUEST_ID_PATTERN.test(supplied)
    ? supplied
    : randomUUID();
}

function writeJson(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Length": Buffer.byteLength(payload),
    "Content-Type": "application/json; charset=utf-8",
    ...headers,
  });
  res.end(payload);
}

function readJsonBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"] || 0);
    if (Number.isFinite(declared) && declared > maxBytes) {
      req.resume();
      reject(Object.assign(new Error("body too large"), { code: "BODY_TOO_LARGE" }));
      return;
    }
    const chunks = [];
    let bytes = 0;
    let settled = false;
    req.on("data", (chunk) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > maxBytes) {
        settled = true;
        req.resume();
        reject(Object.assign(new Error("body too large"), { code: "BODY_TOO_LARGE" }));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(Object.assign(new Error("invalid json", { cause: error }), { code: "INVALID_JSON" }));
      }
    });
    req.on("error", (error) => {
      if (!settled) reject(error);
    });
  });
}

function providerFailure(error) {
  if (!(error instanceof ProviderError)) {
    return { outcome: "provider_failure", status: 502, body: { error: "Provider request failed." } };
  }
  const mappings = {
    PROVIDER_CAPACITY: [429, "capacity", "Service capacity is full."],
    PROVIDER_INPUT_TOO_LARGE: [413, "input_too_large", "Prompt is too large."],
    PROVIDER_SHUTTING_DOWN: [503, "shutting_down", "Service is shutting down."],
    PROVIDER_TIMEOUT: [504, "provider_timeout", "Provider timed out."],
    PROVIDER_OUTPUT_LIMIT: [502, "provider_output_limit", "Provider request failed."],
    PROVIDER_INVALID_RESPONSE: [502, "provider_invalid_response", "Provider request failed."],
    PROVIDER_FAILURE: [502, "provider_failure", "Provider request failed."],
  };
  const [status, outcome, message] = mappings[error.code] || mappings.PROVIDER_FAILURE;
  return {
    body: { error: message },
    headers: status === 429 ? { "Retry-After": "1" } : {},
    outcome,
    status,
  };
}

function createApiService(options) {
  let shuttingDown = false;
  const {
    authenticate,
    logger,
    maxBodyBytes,
    maxPromptBytes,
    maxPromptChars,
    provider,
    rateLimiter,
  } = options;

  const server = http.createServer(async (req, res) => {
    const path = new URL(req.url, "http://127.0.0.1").pathname;
    if (path === "/health" && req.method === "GET") {
      writeJson(res, 200, { status: "ok" });
      return;
    }
    if (path === "/ready" && req.method === "GET") {
      let ready = false;
      try { ready = !shuttingDown && await provider.ready(); } catch { ready = false; }
      writeJson(res, ready ? 200 : 503, { status: ready ? "ready" : "not_ready" });
      return;
    }
    if (path !== "/secure-proxy") {
      writeJson(res, 404, { error: "Not found." });
      return;
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Headers": "authorization, content-type, x-request-id",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
      });
      res.end();
      return;
    }
    if (req.method !== "POST") {
      writeJson(res, 405, { error: "Method not allowed." }, { Allow: "POST, OPTIONS" });
      return;
    }

    const startedAt = Date.now();
    const requestId = requestIdFrom(req);
    let clientId;
    let result;
    const finish = (status, outcome, body, headers = {}) => {
      const usage = result?.usage || {};
      logger({
        cache_read_tokens: usage.cacheReadTokens,
        client_id: clientId,
        duration_ms: Date.now() - startedAt,
        event: "llm_proxy_request",
        input_tokens: usage.inputTokens,
        model: result?.model,
        outcome,
        output_tokens: usage.outputTokens,
        provider: result?.provider || provider.name,
        provider_duration_ms: result?.durationMs,
        request_id: requestId,
        status,
        total_tokens: usage.totalTokens,
      });
      writeJson(res, status, body, { "X-Request-ID": requestId, ...headers });
    };

    if (shuttingDown) {
      finish(503, "shutting_down", { error: "Service is shutting down." });
      return;
    }
    try {
      clientId = await authenticate(req.headers.authorization);
    } catch {
      clientId = null;
    }
    if (!clientId) {
      finish(401, "unauthorized", { error: "Unauthorized." });
      return;
    }
    const rate = rateLimiter.consume(clientId);
    if (!rate.allowed) {
      finish(429, "rate_limited", { error: "Rate limit exceeded." }, {
        "Retry-After": String(rate.retryAfterSeconds),
      });
      return;
    }
    const contentType = String(req.headers["content-type"] || "").split(";", 1)[0].trim();
    if (contentType !== "application/json") {
      req.resume();
      finish(415, "unsupported_media_type", { error: "Content-Type must be application/json." });
      return;
    }

    let body;
    try {
      body = await readJsonBody(req, maxBodyBytes);
    } catch (error) {
      if (error.code === "BODY_TOO_LARGE") {
        finish(413, "body_too_large", { error: "Request body is too large." });
      } else {
        finish(400, "invalid_json", { error: "Invalid JSON body." });
      }
      return;
    }
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      typeof body.prompt !== "string" ||
      body.prompt.trim() === ""
    ) {
      finish(400, "invalid_prompt", { error: "Missing prompt." });
      return;
    }
    if (
      body.prompt.length > maxPromptChars ||
      Buffer.byteLength(body.prompt, "utf8") > maxPromptBytes
    ) {
      finish(413, "prompt_too_large", { error: "Prompt is too large." });
      return;
    }

    try {
      result = await provider.generate({
        prompt: body.prompt,
        requestId,
        signal: AbortSignal.timeout(options.providerTimeoutMs || 300_000),
      });
      finish(200, "success", { content: result.content });
    } catch (error) {
      const failure = providerFailure(error);
      finish(failure.status, failure.outcome, failure.body, failure.headers);
    }
  });

  async function beginShutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    await provider.shutdown();
  }

  async function close() {
    await beginShutdown();
    if (!server.listening) return;
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }

  return { beginShutdown, close, server };
}

module.exports = {
  createApiService,
  loadConfig,
};
