const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");

function readWorkflow(name) {
  return fs.readFileSync(path.join(ROOT, ".github", "workflows", name), "utf8");
}

function triggerBlock(workflow, trigger) {
  const match = workflow.match(
    new RegExp(`^  ${trigger}:\\n([\\s\\S]*?)(?=^  [a-z_]+:|^jobs:)`, "m")
  );
  assert.ok(match, `${trigger} trigger is required`);
  return match[1];
}

function configuredPaths(block) {
  const lines = block.split("\n");
  const pathsIndex = lines.findIndex((line) => line === "    paths:");
  assert.notEqual(pathsIndex, -1, "paths filter is required");

  const paths = [];
  for (const line of lines.slice(pathsIndex + 1)) {
    const match = line.match(/^      - ['"]?([^'"]+)['"]?$/);
    if (!match) break;
    paths.push(match[1]);
  }
  return paths;
}

test("test workflow covers adapter and existing function changes without deployment", () => {
  const workflow = readWorkflow("test.yml");
  const pullRequestPaths = configuredPaths(triggerBlock(workflow, "pull_request"));
  const pushPaths = configuredPaths(triggerBlock(workflow, "push"));
  const requiredPaths = [
    ".github/workflows/deploy.yml",
    ".github/workflows/test.yml",
    "api/**",
    "insforge/functions/**",
    "package.json",
    "package-lock.json",
    "supabase/config.toml",
    "supabase/functions/**",
  ];

  for (const requiredPath of requiredPaths) {
    assert.ok(pullRequestPaths.includes(requiredPath), `missing PR test path: ${requiredPath}`);
    assert.ok(pushPaths.includes(requiredPath), `missing main test path: ${requiredPath}`);
  }
  assert.doesNotMatch(workflow, /supabase functions deploy/);
});

test("deploy workflow only auto-runs for deployable Supabase inputs", () => {
  const workflow = readWorkflow("deploy.yml");
  const pushPaths = configuredPaths(triggerBlock(workflow, "push")).sort();

  assert.deepEqual(pushPaths, ["supabase/config.toml", "supabase/functions/**"]);
  assert.doesNotMatch(workflow, /^  pull_request:/m);
  assert.match(workflow, /^  workflow_dispatch:/m);
});
