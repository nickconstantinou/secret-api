const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const ROOT = path.resolve(__dirname, "..");

test("systemd unit is inactive by default and protects long Agy requests", () => {
  const unit = fs.readFileSync(
    path.join(ROOT, "deploy", "systemd", "secret-api-agy.service"),
    "utf8"
  );

  assert.match(unit, /^After=network-online\.target$/m);
  assert.match(unit, /^EnvironmentFile=%h\/\.config\/secret-api\/agy-api\.env$/m);
  assert.match(unit, /^ExecStart=\/usr\/bin\/env node api\/index\.js$/m);
  assert.match(unit, /^KillSignal=SIGTERM$/m);
  assert.match(unit, /^TimeoutStopSec=6min$/m);
  assert.match(unit, /^NoNewPrivileges=true$/m);
  assert.doesNotMatch(unit, /^WantedBy=/m);
});

test("environment example binds to loopback and contains no secrets", () => {
  const environment = fs.readFileSync(
    path.join(ROOT, "deploy", "agy-api.env.example"),
    "utf8"
  );

  assert.match(environment, /^API_HOST=127\.0\.0\.1$/m);
  assert.match(environment, /^API_PORT=8787$/m);
  assert.match(environment, /^AGY_MAX_QUEUE_SIZE=4$/m);
  assert.match(environment, /^AGY_MODEL=/m);
  assert.match(environment, /^INSFORGE_BASE_URL=/m);
  assert.match(environment, /^ALLOWED_ORIGINS=/m);
  assert.doesNotMatch(environment, /(TOKEN|PASSWORD|SECRET|PRIVATE_KEY)=/);
});
