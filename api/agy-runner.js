const { execFile } = require("node:child_process");

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

function parseAgyResponse(stdout) {
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

  return content;
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
    this.execFile = options.execFile || execFile;
    this.maxBuffer = options.maxOutputBytes ?? 1_048_576;
    this.maxConcurrency = maxConcurrency;
    this.model = options.model ?? process.env.AGY_MODEL;
    this.safeEnv = sanitizedEnvironment(options.baseEnv || process.env);
    this.timeoutMs = options.timeoutMs ?? 300_000;
    this.activeCount = 0;
    this.queue = [];
  }

  run(prompt) {
    if (typeof prompt !== "string" || prompt.trim().length === 0) {
      return Promise.reject(
        new AgyRunnerError("INVALID_PROMPT", "A non-empty prompt is required.")
      );
    }

    return new Promise((resolve, reject) => {
      this.queue.push({ prompt, resolve, reject });
      this.#drain();
    });
  }

  #drain() {
    while (this.activeCount < this.maxConcurrency && this.queue.length > 0) {
      const job = this.queue.shift();
      this.activeCount += 1;
      this.#execute(job.prompt)
        .then(job.resolve, job.reject)
        .finally(() => {
          this.activeCount -= 1;
          this.#drain();
        });
    }
  }

  #execute(prompt) {
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
          shell: false,
          timeout: this.timeoutMs,
          windowsHide: true,
        },
        (error, stdout) => {
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
            if (error.killed) {
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

          try {
            resolve(parseAgyResponse(stdout));
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
  parseAgyResponse,
  sanitizedEnvironment,
};
