const assert = require("node:assert/strict");
const { mkdtemp, rm } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { AgyRunner } = require("./agy-runner.js");

test(
  "live Agy CLI returns structured content",
  { skip: process.env.AGY_LIVE_TEST !== "1", timeout: 90_000 },
  async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "secret-api-agy-live-"));
    try {
      const runner = new AgyRunner({
        cwd,
        model: process.env.AGY_MODEL || "gemini-3.6-flash-low",
        timeoutMs: 60_000,
      });

      assert.equal(
        await runner.run("Reply with exactly: spike-ok"),
        "spike-ok"
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }
);
