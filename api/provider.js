const { AgyRunnerError } = require("./agy-runner.js");

class ProviderError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "ProviderError";
    this.code = code;
  }
}

const AGY_ERROR_MAP = Object.freeze({
  AGY_ARGUMENT_TOO_LARGE: "PROVIDER_INPUT_TOO_LARGE",
  AGY_OUTPUT_LIMIT: "PROVIDER_OUTPUT_LIMIT",
  AGY_PROCESS_FAILED: "PROVIDER_FAILURE",
  AGY_QUEUE_FULL: "PROVIDER_CAPACITY",
  AGY_SHUTTING_DOWN: "PROVIDER_SHUTTING_DOWN",
  AGY_TIMEOUT: "PROVIDER_TIMEOUT",
  AGY_UNSUCCESSFUL: "PROVIDER_FAILURE",
  INVALID_RESPONSE: "PROVIDER_INVALID_RESPONSE",
});

class AgyProvider {
  constructor(options) {
    this.name = "agy";
    this.runner = options.runner;
  }

  async ready() {
    return this.runner.ready();
  }

  async generate({ prompt, signal }) {
    try {
      const result = await this.runner.runDetailed(prompt, { signal });
      return {
        content: result.content,
        provider: this.name,
        model: result.model,
        usage: result.usage,
        durationMs: typeof result.durationSeconds === "number"
          ? Math.round(result.durationSeconds * 1000)
          : undefined,
      };
    } catch (error) {
      const code = error instanceof AgyRunnerError
        ? AGY_ERROR_MAP[error.code] || "PROVIDER_FAILURE"
        : "PROVIDER_FAILURE";
      throw new ProviderError(code, "The configured provider failed.", { cause: error });
    }
  }

  async shutdown() {
    this.runner.shutdown();
  }
}

function createProvider(config, dependencies) {
  if (config.name === "agy") {
    return new AgyProvider({ runner: dependencies.agyRunner });
  }
  throw new Error(`Unsupported LLM_PROVIDER: ${config.name}`);
}

module.exports = {
  AgyProvider,
  ProviderError,
  createProvider,
};
