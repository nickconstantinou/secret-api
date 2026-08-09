const { mkdir } = require("node:fs/promises");

const { AgyRunner } = require("./agy-runner.js");
const { loadClientKeyRegistry } = require("./client-keys.js");
const { createApiService, loadConfig } = require("./http-service.js");
const { createProvider } = require("./provider.js");
const { FixedWindowRateLimiter } = require("./rate-limiter.js");

function jsonLogger(entry) {
  process.stdout.write(`${JSON.stringify(entry)}\n`);
}

async function main(env = process.env) {
  const config = loadConfig(env);
  await mkdir(config.provider.agy.cwd, { mode: 0o700, recursive: true });
  const registry = await loadClientKeyRegistry(config.clientKeysFile);
  const agyRunner = new AgyRunner({
    binary: config.provider.agy.binary,
    cwd: config.provider.agy.cwd,
    maxArgumentBytes: config.provider.agy.maxArgumentBytes,
    maxConcurrency: config.maxActiveCalls,
    maxOutputBytes: config.provider.agy.maxOutputBytes,
    maxQueueSize: config.maxQueueSize,
    model: config.provider.agy.model,
    timeoutMs: config.provider.timeoutMs,
  });
  const provider = createProvider(config.provider, { agyRunner });
  const rateLimiter = new FixedWindowRateLimiter({
    limit: config.rateLimitCount,
    windowMs: config.rateLimitWindowMs,
  });
  const service = createApiService({
    authenticate: (authorization) => registry.authenticate(authorization),
    logger: jsonLogger,
    maxBodyBytes: config.maxBodyBytes,
    maxPromptBytes: config.maxPromptBytes,
    maxPromptChars: config.maxPromptChars,
    provider,
    providerTimeoutMs: config.provider.timeoutMs,
    rateLimiter,
  });

  service.server.listen(config.port, config.host, () => {
    jsonLogger({
      event: "llm_proxy_started",
      host: config.host,
      port: config.port,
      provider: provider.name,
      model: config.provider.agy.model,
    });
  });

  process.on("SIGHUP", () => {
    registry.reload().then(
      () => jsonLogger({ event: "client_keys_reloaded", outcome: "success" }),
      () => jsonLogger({ event: "client_keys_reloaded", outcome: "failure" })
    );
  });

  let stopping = false;
  const stop = async (signal) => {
    if (stopping) return;
    stopping = true;
    jsonLogger({ event: "llm_proxy_stopping", signal });
    try {
      await service.close();
      jsonLogger({ event: "llm_proxy_stopped", outcome: "success" });
    } catch {
      process.exitCode = 1;
      jsonLogger({ event: "llm_proxy_stopped", outcome: "failure" });
    }
  };
  process.on("SIGINT", () => void stop("SIGINT"));
  process.on("SIGTERM", () => void stop("SIGTERM"));
  return { config, provider, registry, service, stop };
}

if (require.main === module) {
  main().catch(() => {
    process.stderr.write("Secret API failed to start.\n");
    process.exitCode = 1;
  });
}

module.exports = { jsonLogger, main };
