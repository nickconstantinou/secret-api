const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  AgyRunner,
  AgyRunnerError,
  AGY_RESPONSE_SCHEMA,
} = require("./agy-runner.js");

function successEnvelope(content = "spike-ok") {
  return JSON.stringify({
    status: "SUCCESS",
    structured_output: { content },
  });
}

function createExecFileStub(responses = [successEnvelope()]) {
  const calls = [];
  const execFile = (file, args, options, callback) => {
    calls.push({ file, args, options, callback });
    const response = responses.shift();
    if (response !== undefined) {
      queueMicrotask(() => callback(null, response, ""));
    }
    return { kill() {} };
  };
  return { calls, execFile };
}

test("runs Agy without a shell and returns structured content", async () => {
  const stub = createExecFileStub();
  const runner = new AgyRunner({
    binary: "/opt/agy/bin/agy",
    cwd: "/var/lib/secret-api/agy-work",
    execFile: stub.execFile,
    model: "gemini-3.6-flash-low",
    baseEnv: {
      HOME: "/var/lib/secret-api",
      PATH: "/usr/bin:/bin",
      SECRET_SENTINEL: "must-not-leak",
    },
  });

  const content = await runner.run("Reply with exactly: spike-ok");

  assert.equal(content, "spike-ok");
  assert.equal(stub.calls.length, 1);
  const call = stub.calls[0];
  assert.equal(call.file, "/opt/agy/bin/agy");
  assert.equal(call.options.cwd, "/var/lib/secret-api/agy-work");
  assert.equal(call.options.shell, false);
  assert.equal(call.options.timeout, 300_000);
  assert.equal(call.options.maxBuffer, 1_048_576);
  assert.equal(call.options.env.SECRET_SENTINEL, undefined);
  assert.equal(call.options.env.HOME, "/var/lib/secret-api");
  assert.deepEqual(call.args, [
    "--print",
    "Reply with exactly: spike-ok",
    "--new-project",
    "--output-format",
    "json",
    "--json-schema",
    JSON.stringify(AGY_RESPONSE_SCHEMA),
    "--disable-slash-commands",
    "--sandbox",
    "--mode",
    "plan",
    "--model",
    "gemini-3.6-flash-low",
    "--print-timeout",
    "300000ms",
  ]);
});

test("keeps prompt text in one argument", async () => {
  const stub = createExecFileStub();
  const runner = new AgyRunner({
    cwd: "/tmp/agy-work",
    execFile: stub.execFile,
  });
  const prompt = "hello; touch /tmp/should-never-run && $(whoami)";

  await runner.run(prompt);

  assert.equal(stub.calls[0].args[1], prompt);
  assert.equal(stub.calls[0].options.shell, false);
});

test("requires a non-empty prompt", async () => {
  const stub = createExecFileStub();
  const runner = new AgyRunner({
    cwd: "/tmp/agy-work",
    execFile: stub.execFile,
  });

  await assert.rejects(runner.run("  "), {
    name: "AgyRunnerError",
    code: "INVALID_PROMPT",
  });
  assert.equal(stub.calls.length, 0);
});

test("requires an isolated working directory", () => {
  assert.throws(() => new AgyRunner({}), {
    name: "AgyRunnerError",
    code: "MISSING_WORK_DIR",
  });
});

test("rejects malformed CLI JSON", async () => {
  const stub = createExecFileStub(["not-json"]);
  const runner = new AgyRunner({
    cwd: "/tmp/agy-work",
    execFile: stub.execFile,
  });

  await assert.rejects(runner.run("hello"), {
    name: "AgyRunnerError",
    code: "INVALID_RESPONSE",
  });
});

test("rejects unsuccessful Agy responses", async () => {
  const stub = createExecFileStub([
    JSON.stringify({ status: "ERROR", structured_output: null }),
  ]);
  const runner = new AgyRunner({
    cwd: "/tmp/agy-work",
    execFile: stub.execFile,
  });

  await assert.rejects(runner.run("hello"), {
    name: "AgyRunnerError",
    code: "AGY_UNSUCCESSFUL",
  });
});

test("rejects responses without structured content", async () => {
  const stub = createExecFileStub([
    JSON.stringify({ status: "SUCCESS", structured_output: {} }),
  ]);
  const runner = new AgyRunner({
    cwd: "/tmp/agy-work",
    execFile: stub.execFile,
  });

  await assert.rejects(runner.run("hello"), {
    name: "AgyRunnerError",
    code: "INVALID_RESPONSE",
  });
});

test("maps CLI failures without returning stderr", async () => {
  const execFile = (_file, _args, _options, callback) => {
    const error = new Error("process failed");
    error.code = 1;
    queueMicrotask(() => callback(error, "", "secret diagnostic"));
    return { kill() {} };
  };
  const runner = new AgyRunner({ cwd: "/tmp/agy-work", execFile });

  await assert.rejects(
    runner.run("hello"),
    (error) => {
      assert.ok(error instanceof AgyRunnerError);
      assert.equal(error.code, "AGY_PROCESS_FAILED");
      assert.doesNotMatch(error.message, /secret diagnostic/);
      return true;
    }
  );
});

test("maps CLI timeouts", async () => {
  const execFile = (_file, _args, _options, callback) => {
    const error = new Error("terminated");
    error.killed = true;
    error.signal = "SIGTERM";
    queueMicrotask(() => callback(error, "", ""));
    return { kill() {} };
  };
  const runner = new AgyRunner({ cwd: "/tmp/agy-work", execFile });

  await assert.rejects(runner.run("hello"), {
    name: "AgyRunnerError",
    code: "AGY_TIMEOUT",
  });
});

test("maps CLI output limit failures", async () => {
  const execFile = (_file, _args, _options, callback) => {
    const error = new Error("stdout maxBuffer length exceeded");
    error.code = "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
    queueMicrotask(() => callback(error, "", ""));
    return { kill() {} };
  };
  const runner = new AgyRunner({ cwd: "/tmp/agy-work", execFile });

  await assert.rejects(runner.run("hello"), {
    name: "AgyRunnerError",
    code: "AGY_OUTPUT_LIMIT",
  });
});

test("runs only one Agy process at a time by default", async () => {
  const stub = createExecFileStub([]);
  const runner = new AgyRunner({
    cwd: "/tmp/agy-work",
    execFile: stub.execFile,
  });

  const first = runner.run("first");
  const second = runner.run("second");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stub.calls.length, 1);

  stub.calls[0].callback(null, successEnvelope("first-result"), "");
  assert.equal(await first, "first-result");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stub.calls.length, 2);

  stub.calls[1].callback(null, successEnvelope("second-result"), "");
  assert.equal(await second, "second-result");
});
