const { execFile } = require("node:child_process");
const { constants: fsConstants } = require("node:fs");
const { access } = require("node:fs/promises");
const path = require("node:path");

const AGY_RESPONSE_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    content: { type: "string" },
  },
  required: ["content"],
  additionalProperties: false,
});

const SAFE_ENV_NAMES = Object.freeze([
  "HOME",
  "LANG",
  "LC_ALL",
  "PATH",
  "SSL_CERT_FILE",
  "TERM",
  "TMPDIR",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
]);

class AgyRunnerError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "AgyRunnerError";
    this.code = code;
  }
}

function sanitizedEnvironment(baseEnv) {
  return Object.fromEntries(
    SAFE_ENV_NAMES.flatMap((name) =>
      typeof baseEnv[name] === "string" ? [[name, baseEnv[name]]] : []
    )
  );
}

function parseAgyResult(stdout, model) {
  let response;
  try {
    response = JSON.parse(stdout);
  } catch (error) {
    throw new AgyRunnerError(
      "INVALID_RESPONSE",
      "Agy returned invalid JSON.",
      { cause: error }
    );
  }

  if (response?.status !== "SUCCESS") {
    throw new AgyRunnerError(
      "AGY_UNSUCCESSFUL",
      "Agy did not complete successfully."
    );
  }

  const content = response?.structured_output?.content;
  if (typeof content !== "string" || content.length === 0) {
    throw new AgyRunnerError(
      "INVALID_RESPONSE",
      "Agy returned no structured content."
    );
  }

  const usage = response.usage && typeof response.usage === "object"
    ? {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheReadTokens: response.usage.cache_read_tokens,
        totalTokens: response.usage.total_tokens,
      }
    : undefined;

  return {
    content,
    durationSeconds: response.duration_seconds,
    model,
    usage,
  };
}

function parseAgyResponse(stdout) {
  return parseAgyResult(stdout).content;
}

class AgyRunner {
  constructor(options = {}) {
    const cwd = options.cwd || process.env.AGY_WORK_DIR;
    if (typeof cwd !== "string" || cwd.trim().length === 0) {
      throw new AgyRunnerError(
        "MISSING_WORK_DIR",
        "AGY_WORK_DIR is required."
      );
    }

    const maxConcurrency = options.maxConcurrency ?? 1;
    if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
      throw new AgyRunnerError(
        "INVALID_CONCURRENCY",
        "Agy concurrency must be a positive integer."
      );
    }

    this.binary = options.binary || process.env.AGY_CLI_PATH || "agy";
    this.cwd = cwd;
    this.access = options.access || access;
    this.execFile = options.execFile || execFile;
    this.maxArgumentBytes = options.maxArgumentBytes ?? 120_000;
    if (!Number.isInteger(this.maxArgumentBytes) || this.maxArgumentBytes < 1) {
      throw new AgyRunnerError(
        "INVALID_ARGUMENT_LIMIT",
        "Agy argument size must be a positive integer."
      );
    }
    this.maxBuffer = options.maxOutputBytes ?? 1_048_576;
    this.maxConcurrency = maxConcurrency;
    this.maxQueueSize = options.maxQueueSize ?? 4;
    if (!Number.isInteger(this.maxQueueSize) || this.maxQueueSize < 0) {
      throw new AgyRunnerError(
        "INVALID_QUEUE_SIZE",
        "Agy queue size must be a non-negative integer."
      );
    }
    this.model = options.model ?? process.env.AGY_MODEL;
    this.safeEnv = sanitizedEnvironment(options.baseEnv || process.env);
    this.timeoutMs = options.timeoutMs ?? 300_000;
    this.activeCount = 0;
    this.accepting = true;
    this.queue = [];
  }

  run(prompt) {
    return this.runDetailed(prompt).then((result) => result.content);
  }

  runDetailed(prompt, options = {}) {
    if (typeof prompt !== "string" || prompt.trim().length === 0) {
      return Promise.reject(
        new AgyRunnerError("INVALID_PROMPT", "A non-empty prompt is required.")
      );
    }

    if (Buffer.byteLength(prompt, "utf8") > this.maxArgumentBytes) {
      return Promise.reject(
        new AgyRunnerError(
          "AGY_ARGUMENT_TOO_LARGE",
          "The Agy prompt argument is too large."
        )
      );
    }

    if (!this.accepting) {
      return Promise.reject(
        new AgyRunnerError(
          "AGY_SHUTTING_DOWN",
          "Agy is shutting down."
        )
      );
    }

    if (
      this.activeCount >= this.maxConcurrency &&
      this.queue.length >= this.maxQueueSize
    ) {
      return Promise.reject(
        new AgyRunnerError("AGY_QUEUE_FULL", "The Agy queue is full.")
      );
    }

    return new Promise((resolve, reject) => {
      this.queue.push({ options, prompt, resolve, reject });
      this.#drain();
    });
  }

  async ready() {
    try {
      await this.access(this.cwd, fsConstants.R_OK | fsConstants.W_OK);
      if (this.binary.includes(path.sep)) {
        await this.access(this.binary, fsConstants.X_OK);
        return true;
      }
      const searchPath = this.safeEnv.PATH || "";
      for (const directory of searchPath.split(path.delimiter).filter(Boolean)) {
        try {
          await this.access(path.join(directory, this.binary), fsConstants.X_OK);
          return true;
        } catch {
          // Continue through PATH without exposing individual filesystem errors.
        }
      }
      return false;
    } catch {
      return false;
    }
  }

  shutdown() {
    this.accepting = false;
    const error = new AgyRunnerError(
      "AGY_SHUTTING_DOWN",
      "Agy is shutting down."
    );
    for (const job of this.queue.splice(0)) {
      job.reject(error);
    }
  }

  #drain() {
    while (this.activeCount < this.maxConcurrency && this.queue.length > 0) {
      const job = this.queue.shift();
      this.activeCount += 1;
      this.#execute(job.prompt, job.options)
        .then(job.resolve, job.reject)
        .finally(() => {
          this.activeCount -= 1;
          this.#drain();
        });
    }
  }

  #execute(prompt, options) {
    const args = [
      "--print",
      prompt,
      "--new-project",
      "--output-format",
      "json",
      "--json-schema",
      JSON.stringify(AGY_RESPONSE_SCHEMA),
      "--disable-slash-commands",
      "--sandbox",
      "--mode",
      "plan",
    ];

    if (this.model) {
      args.push("--model", this.model);
    }
    args.push("--print-timeout", `${this.timeoutMs}ms`);

    return new Promise((resolve, reject) => {
      this.execFile(
        this.binary,
        args,
        {
          cwd: this.cwd,
          encoding: "utf8",
          env: this.safeEnv,
          killSignal: "SIGTERM",
          maxBuffer: this.maxBuffer,
          signal: options.signal,
          shell: false,
          timeout: this.timeoutMs,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          if (error) {
            if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
              reject(
                new AgyRunnerError(
                  "AGY_OUTPUT_LIMIT",
                  "Agy exceeded the output limit."
                )
              );
              return;
            }
            if (error.killed || error.code === "ABORT_ERR") {
              reject(
                new AgyRunnerError("AGY_TIMEOUT", "Agy exceeded the time limit.")
              );
              return;
            }
            reject(
              new AgyRunnerError(
                "AGY_PROCESS_FAILED",
                "Agy failed to produce a response."
              )
            );
            return;
          }

          if (
            Buffer.byteLength(stdout || "", "utf8") +
              Buffer.byteLength(stderr || "", "utf8") >
            this.maxBuffer
          ) {
            reject(
              new AgyRunnerError(
                "AGY_OUTPUT_LIMIT",
                "Agy exceeded the output limit."
              )
            );
            return;
          }

          try {
            resolve(parseAgyResult(stdout, this.model));
          } catch (parseError) {
            reject(parseError);
          }
        }
      );
    });
  }
}

module.exports = {
  AGY_RESPONSE_SCHEMA,
  AgyRunner,
  AgyRunnerError,
  parseAgyResult,
  parseAgyResponse,
  sanitizedEnvironment,
};
