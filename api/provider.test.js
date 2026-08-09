const assert = require("node:assert/strict");
const { test } = require("node:test");

const { AgyRunnerError } = require("./agy-runner.js");
const { AgyProvider, ProviderError, createProvider } = require("./provider.js");

test("Agy provider satisfies the provider-neutral contract", async () => {
  const calls = [];
  const runner = {
    ready: async () => true,
    runDetailed: async (prompt, options) => {
      calls.push({ prompt, options });
      return {
        content: "answer",
        durationSeconds: 1.25,
        model: "gemini-3.6-flash-low",
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          cacheReadTokens: 40,
          totalTokens: 120,
        },
      };
    },
    shutdown() {},
  };
  const provider = new AgyProvider({ runner });
  const signal = AbortSignal.timeout(1000);

  assert.equal(provider.name, "agy");
  assert.equal(await provider.ready(), true);
  assert.deepEqual(
    await provider.generate({ prompt: "hello", requestId: "req-1", signal }),
    {
      content: "answer",
      provider: "agy",
      model: "gemini-3.6-flash-low",
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 40,
        totalTokens: 120,
      },
      durationMs: 1250,
    }
  );
  assert.deepEqual(calls, [{ prompt: "hello", options: { signal } }]);
});

test("Agy provider maps implementation failures to stable failures", async () => {
  const mappings = [
    ["AGY_TIMEOUT", "PROVIDER_TIMEOUT"],
    ["AGY_QUEUE_FULL", "PROVIDER_CAPACITY"],
    ["AGY_SHUTTING_DOWN", "PROVIDER_SHUTTING_DOWN"],
    ["AGY_OUTPUT_LIMIT", "PROVIDER_OUTPUT_LIMIT"],
    ["AGY_ARGUMENT_TOO_LARGE", "PROVIDER_INPUT_TOO_LARGE"],
    ["INVALID_RESPONSE", "PROVIDER_INVALID_RESPONSE"],
    ["AGY_PROCESS_FAILED", "PROVIDER_FAILURE"],
  ];

  for (const [runnerCode, providerCode] of mappings) {
    const provider = new AgyProvider({
      runner: {
        ready: async () => true,
        runDetailed: async () => {
          throw new AgyRunnerError(runnerCode, "private implementation detail");
        },
        shutdown() {},
      },
    });
    await assert.rejects(
      provider.generate({ prompt: "hello", requestId: "req", signal: undefined }),
      (error) => {
        assert.ok(error instanceof ProviderError);
        assert.equal(error.code, providerCode);
        assert.doesNotMatch(error.message, /private implementation detail/);
        return true;
      }
    );
  }
});

test("provider factory selects once from startup configuration", () => {
  const runner = { ready: async () => true, shutdown() {} };
  assert.equal(createProvider({ name: "agy" }, { agyRunner: runner }).name, "agy");
  assert.throws(
    () => createProvider({ name: "client-selected-provider" }, { agyRunner: runner }),
    /Unsupported LLM_PROVIDER/
  );
});

test("provider shutdown delegates to the selected adapter", async () => {
  let stopped = false;
  const provider = new AgyProvider({
    runner: {
      ready: async () => true,
      shutdown() { stopped = true; },
    },
  });
  await provider.shutdown();
  assert.equal(stopped, true);
});
