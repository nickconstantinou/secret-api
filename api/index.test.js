const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");

test("importing the service bootstrap does not start a listener", () => {
  const entrypoint = path.join(__dirname, "index.js");
  const result = spawnSync(process.execPath, ["-e", `require(${JSON.stringify(entrypoint)})`], {
    encoding: "utf8",
    timeout: 2_000,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});
