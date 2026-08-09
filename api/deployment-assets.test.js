const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const ROOT = path.resolve(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

test("systemd unit is inactive and protects graceful Agy shutdown", () => {
  const unit = read("deploy/systemd/secret-api-llm.service");
  assert.match(unit, /^After=network-online\.target$/m);
  assert.match(unit, /^User=secret-api$/m);
  assert.match(unit, /^EnvironmentFile=\/etc\/secret-api\/llm-api\.env$/m);
  assert.match(unit, /^ExecStart=\/usr\/bin\/env node api\/index\.js$/m);
  assert.match(unit, /^KillSignal=SIGTERM$/m);
  assert.match(unit, /^TimeoutStopSec=6min$/m);
  assert.match(unit, /^NoNewPrivileges=true$/m);
  assert.doesNotMatch(unit, /^WantedBy=/m);
});

test("environment and key examples contain placeholders only", () => {
  const environment = read("deploy/llm-api.env.example");
  const keys = read("deploy/client-keys.json.example");
  assert.match(environment, /^API_HOST=127\.0\.0\.1$/m);
  assert.match(environment, /^LLM_PROVIDER=agy$/m);
  assert.match(environment, /^CLIENT_KEYS_FILE=/m);
  assert.match(environment, /^AGY_MAX_ARGUMENT_BYTES=120000$/m);
  assert.match(keys, /<sha256-hex-of-random-secret>/);
  assert.doesNotMatch(environment + keys, /(TOKEN|PASSWORD|PRIVATE_KEY)=/);
  assert.doesNotMatch(environment + keys, /[a-f0-9]{64}/i);
});

test("Caddy example uses placeholders and loopback upstream", () => {
  const caddy = read("deploy/caddy/secret-api.Caddyfile.example");
  assert.match(caddy, /^api\.example\.invalid \{$/m);
  assert.match(caddy, /reverse_proxy 127\.0\.0\.1:8787/);
  assert.match(caddy, /Authorization delete/);
  assert.doesNotMatch(caddy, /https:\/\/(?!api\.example\.invalid)/);
});

test("operations guide keeps activation manual and reversible", () => {
  const guide = read("docs/VPS-OPERATIONS.md");
  assert.match(guide, /Do not start or enable the\s+service from CI/i);
  assert.match(guide, /systemctl status caddy/);
  assert.match(guide, /caddy validate/);
  assert.match(guide, /Rollback/);
  assert.match(guide, /CLIENT_KEYS_FILE/);
});
