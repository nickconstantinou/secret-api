# AGENTS.md — Secret API

Instructions for agents working on the provider-neutral VPS API and the existing
Supabase and Insforge compatibility implementations.

## Scope and supported deployments

This repository supports independent deployment targets:

1. The Supabase Edge Function in `supabase/functions/secure-proxy/`.
2. The Insforge Function in `insforge/functions/secure-proxy.js`.
3. A provider-neutral Node.js service under `api/`, hosted on a VPS behind
   Caddy.

The VPS service is an additional target. It does not replace the edge
functions. Do not remove, rewrite, deploy, or reconfigure the Supabase or
Insforge implementations unless the task explicitly includes them.

The public contract stays stable across targets:

```text
authenticated POST {"prompt":"..."} -> {"content":"..."}
```

## VPS architecture

```text
Calling application backend
          |
          | HTTPS + per-client bearer key
          v
Existing or new Caddy instance
          |
          | HTTP to loopback
          v
Provider-neutral Node.js service
          |
          +-- Agy CLI provider
          |
          +-- OpenAI-compatible provider (future)
                  +-- MiniMax
                  +-- OpenAI
                  +-- other compatible endpoints
```

Caddy owns public TLS, hostname routing, coarse body limits, proxy timeouts,
and public access logging. The Node service owns authentication, validation,
rate limits, bounded execution, provider selection, safe errors, and
application telemetry.

The Node listener must bind to loopback. Never bind it to `0.0.0.0`, a public
address, or a wildcard interface.

## Provider boundary

The HTTP layer depends on a provider contract, not `AgyRunner` directly. A
provider implementation supplies behavior equivalent to:

```js
provider.name
provider.ready()
provider.generate({ prompt, signal, requestId })
// -> { content, provider, model, usage, durationMs }
provider.shutdown()
```

Use shared contract tests for each provider. Select the provider once at
process startup through `LLM_PROVIDER`. Requests must not select a provider,
endpoint, or model.

Provider-neutral failures are:

- `PROVIDER_TIMEOUT`
- `PROVIDER_CAPACITY`
- `PROVIDER_SHUTTING_DOWN`
- `PROVIDER_OUTPUT_LIMIT`
- `PROVIDER_INVALID_RESPONSE`
- `PROVIDER_FAILURE`

Translate provider-specific failures inside the adapter. Never expose raw
provider bodies, command output, stderr, filesystem paths, credentials, or
stack traces.

The initial VPS configuration uses the existing Agy adapter. A future
OpenAI-compatible adapter must be addable without HTTP route, authentication,
queue, response, or client changes.

## VPS authentication and authorization

Insforge and Supabase authentication are out of scope for the VPS service.
The default VPS mode is service-to-service authentication with a distinct,
high-entropy bearer API key for each calling application backend.

Request format:

```http
Authorization: Bearer <client-id>.<random-secret>
```

Requirements:

- Generate at least 256 random bits for each secret.
- Keep plaintext keys only in the calling service secret store.
- Store only key hashes and non-secret client identifiers on the API server.
- Load the hash registry through `CLIENT_KEYS_FILE` from a service-owned file
  with mode `0600` or an equivalently restrictive permission.
- Compare hashes in constant time.
- Support overlapping old and new keys during rotation.
- Reject missing, malformed, unknown, disabled, or expired keys with a generic
  `401` response.
- Use the authenticated client identifier for rate limits and telemetry. Do not
  log the bearer key, its hash, or raw authorization headers.
- Never forward client credentials to a model provider.
- Keep Caddy access logs from recording authorization headers or bodies.

API keys authorize application backends, not browser JavaScript. Never embed a
VPS key in Horizon AI, Labwhisperer, another browser bundle, a mobile package,
or a public repository. CORS and `Origin` do not prove client identity because
non-browser callers can forge them.

If a browser application needs the VPS API, use one of these designs:

1. Recommended: the browser calls its application backend, and that backend
   calls the VPS API with its server-side key.
2. If direct browser calls are a hard requirement, add a standard short-lived
   user token flow through an explicitly selected OIDC provider. This is a
   separate security design and is not part of the API-key implementation.

Mutual TLS or OAuth client credentials can replace bearer API keys for a later
service-to-service hardening phase. Do not add several authentication modes to
the initial implementation.

## HTTP behavior

Required routes:

- `GET /health`: process liveness only. It must not run inference.
- `GET /ready`: local configuration and selected-provider readiness without
  inference.
- `OPTIONS /secure-proxy`: configured browser preflight behavior, if used.
- `POST /secure-proxy`: authenticated generation.
- Other methods on `/secure-proxy`: `405`.
- Unknown paths: `404`.

Validate JSON content type, JSON syntax, a non-empty string prompt, body bytes,
prompt characters, prompt UTF-8 bytes, and the selected provider's input
boundary.

Expected public mappings:

| Condition | Status |
|---|---:|
| Invalid or missing client key | 401 |
| Invalid JSON or prompt | 400 |
| Body, prompt, or provider argument too large | 413 |
| Rate or queue limit reached | 429 with `Retry-After` |
| Service shutting down | 503 |
| Provider timeout | 504 |
| Provider process, transport, or response failure | 502 |

## Limits and resource protection

The service layer enforces configurable body and prompt limits, per-client rate
limits, maximum active calls, and a bounded queue. Reject excess work before
provider execution.

Initial Agy settings:

- one active call;
- maximum four queued calls;
- five-minute provider timeout;
- 1 MiB combined process-output boundary;
- explicit model configuration;
- maximum complete prompt argument of 120,000 UTF-8 bytes.

Agy receives the prompt as one process argument. Budget the complete `--print`
argument, including service framing. Reject oversized arguments before
queueing and before `execFile`. Cover ASCII, multibyte UTF-8, exact-boundary,
and over-boundary cases. No oversized request may reach the OS and produce
`E2BIG`.

On a server that also hosts a website, observe CPU, memory, file descriptors,
process counts, and website latency. Keep concurrency at one until production
evidence supports a change. Apply systemd resource limits only after measuring
the host and confirming that the limits do not break the selected provider.

## Logs and privacy

Emit one structured JSON event per generation request with:

- validated or generated request ID;
- authenticated client identifier;
- final HTTP status and outcome;
- total duration;
- provider and model;
- provider duration;
- safe input, output, cache-read, and total token counts when available.

Validate request IDs for length and characters before reflecting or logging
them. Never log prompts, response content, request bodies, credentials, raw
provider output, or stderr.

## Installation authority

Repository changes and an implementation PR must remain inert. They must not:

- start or enable the Node service;
- install, edit, reload, restart, or replace Caddy;
- change DNS or firewall rules;
- change client base URLs;
- deploy Supabase or Insforge functions;
- create, rotate, revoke, or expose credentials.

Each live action requires explicit deployment authority. Record the exact Git
commit, effective configuration, backup, validation results, and rollback path
before mutation.

## Common installation preflight

Before installation:

1. Identify the target server, owner, operating system, service manager, and
   maintenance window.
2. Record CPU, memory, disk, process, and file-descriptor headroom.
3. Confirm Node.js 24 and the selected provider runtime are available.
4. Record the selected provider and model. Run no live model probe without
   explicit authority.
5. Inspect listeners on ports 80, 443, and the proposed loopback API port.
6. Inspect the active reverse proxy, its process owner, service unit, binary,
   version, modules, and effective configuration path.
7. Confirm whether Caddy runs as a host systemd service or in a container.
8. Confirm DNS ownership and choose a hostname. Prefer a dedicated subdomain
   such as `api.example.com` over a shared website path.
9. Back up the effective reverse-proxy configuration and record a checksum.
10. Confirm an application backend will hold each client key. Stop if the only
    proposed caller is browser code.

## Install on a server already running Caddy

Reuse the existing Caddy process. Do not install or start another Caddy,
replace its binary, overwrite its unit, or compete for ports 80 and 443.

If the server also hosts a website with a custom domain:

```text
https://www.example.com -> existing website
https://api.example.com -> provider-neutral VPS API
```

Add the API as a separate site block or through the existing import layout:

```caddyfile
api.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

The example uses placeholders. Use the approved hostname and port during an
authorized deployment.

Deployment procedure:

1. Record `caddy version`, installed modules, `systemctl status caddy`, the
   active unit, and the effective config path.
2. Inspect all site blocks, imports, listeners, and hostname ownership.
3. Back up the complete effective configuration and record its checksum.
4. Confirm the new hostname does not conflict with an existing address. Caddy
   site addresses must be unique.
5. Create the DNS record only under explicit DNS authority.
6. Install the Node service in an inactive state and validate it on loopback.
7. Add the smallest Caddy site block or imported file for the API hostname.
8. Preserve the incoming `Authorization` header. Do not add it to logs.
9. Validate the complete effective Caddy configuration with the installed
   binary.
10. Gracefully reload the existing Caddy service. Do not stop or restart it for
    a configuration-only change.
11. Verify every pre-existing website and the new API route.
12. Monitor Caddy errors, website latency, Node health, authentication
    failures, provider errors, queue depth, and host resources.

If the existing Caddy uses an import such as `sites-enabled/*`, add a dedicated
API file through that established mechanism. Otherwise, preserve the current
layout and make the narrowest coherent edit.

If Caddy runs in a container, `127.0.0.1` inside Caddy is the container itself.
Do not apply the host-loopback example. Define and review a private container
network, a mounted Unix socket, or another non-public connection before
deployment. Keep the Node service unreachable from public interfaces. This
variant requires dedicated integration tests and explicit approval.

Rollback:

1. Stop routing clients to the VPS API.
2. Restore the exact previous Caddy configuration.
3. Validate the restored configuration.
4. Gracefully reload Caddy.
5. Verify every existing website.
6. Stop and disable the Node service.
7. Preserve sanitized logs and failure evidence.

## Install on a server without Caddy

First inspect whether another reverse proxy owns ports 80 or 443. If Nginx,
Apache, Traefik, or another proxy is active, do not install Caddy beside it.
Use the existing proxy or obtain explicit authority for a separate proxy
migration plan.

If no reverse proxy is installed and Caddy is approved:

1. Install Caddy from an approved official package source.
2. Record the installed binary version, modules, service unit, user, storage
   path, and configuration path.
3. Use the official systemd service. Do not create a competing Caddy unit.
4. Configure only the approved API hostname.
5. Keep the Node service on loopback.
6. Validate the complete Caddy configuration before the first start or reload.
7. Confirm firewall exposure is limited to required public ports. Never expose
   the Node port.
8. Start Caddy and the Node service only under explicit activation authority.
9. Verify certificate issuance, HTTPS redirect, authentication, limits, and
   failure responses.

On a new or dedicated server, also verify operating-system updates, time sync,
DNS, backup ownership, log retention, monitoring, and recovery access before
activation.

Rollback on a new Caddy installation:

1. Revert any client base URL.
2. Stop and disable the Node service.
3. Remove or disable the API site configuration.
4. Stop and disable Caddy only if it was installed solely for this API and the
   action is explicitly authorized.
5. Preserve configuration backups and sanitized logs.

## Node service installation

Prefer a dedicated Unix account for the Node service on a shared production
host. Do not run it as root, the Caddy account, or the website application
account. Install and authenticate subprocess providers under the account whose
state the systemd service will use.

Use an immutable release directory or a recorded repository commit. Load
runtime settings from a service-owned environment file with restrictive
permissions. Store client key hashes in a separate restricted file. Do not put
secrets in the unit file, Caddyfile, repository, shell history, or command-line
arguments.

The systemd unit must:

- run as the selected non-root service account;
- start the Node API from the recorded release;
- bind only to loopback;
- send `SIGTERM`;
- allow at least six minutes for graceful provider completion;
- reject new and queued work during shutdown;
- restart on unexpected failure;
- preserve only the filesystem and home access required by the selected
  provider;
- include no repository install target that enables or starts it automatically.

Run local health, readiness, authenticated success, invalid-key, oversize,
rate-limit, queue-full, timeout, and graceful-shutdown checks before adding a
public Caddy route.

## Configuration

Provider-neutral settings include:

- `API_HOST=127.0.0.1`
- `API_PORT`
- `CLIENT_KEYS_FILE`
- `LLM_PROVIDER=agy`
- body, prompt-character, and prompt-byte limits;
- rate-limit window and count;
- maximum active calls and queue size;
- provider timeout.

Agy settings include:

- `AGY_CLI_PATH`
- `AGY_WORK_DIR`
- `AGY_MODEL`
- `AGY_MAX_ARGUMENT_BYTES=120000`
- `AGY_MAX_OUTPUT_BYTES`

Future OpenAI-compatible settings must use a separate namespace and
file-backed credentials where practical:

- `OPENAI_COMPATIBLE_BASE_URL`
- `OPENAI_COMPATIBLE_API_KEY_FILE`
- `OPENAI_COMPATIBLE_MODEL`

Do not add unused provider credentials or configuration in the initial PR.

## Development workflow

Inspect repository status and all existing worktree changes before editing.
The `agent/agy-http-service` worktree began with committed red tests and an
unstaged partial adapter implementation. Preserve that history and do not
overwrite or stage unrelated work.

The committed HTTP red tests were written for the earlier Insforge-session
authentication design. Insforge authentication is now out of scope for the VPS
service. Before production implementation, add and commit replacement red tests
for the per-client API-key contract. Keep the earlier commit in history as
evidence; do not implement its stale Insforge dependency or rewrite published
history.

Use strict red-green-refactor TDD:

1. Commit focused failing tests.
2. Confirm failures are caused by the missing behavior.
3. Add the smallest coherent implementation.
4. Run focused tests, then all Node and Deno tests.
5. Run syntax, static, secret, and diff checks.
6. Open work as a draft PR and require exact-head CI.

Minimum coverage includes:

- provider factory and shared contract tests;
- API-key parsing, hashing, constant-time comparison, disablement, expiry, and
  rotation;
- proof that credentials never reach providers or logs;
- route and method behavior;
- body, prompt, UTF-8, and Agy argument limits;
- per-client rate limits, queueing, and concurrency;
- provider-neutral error mapping;
- request-ID validation and structured log redaction;
- graceful shutdown;
- loopback-only configuration;
- static systemd, environment, and Caddy template checks;
- workflow boundary tests proving API changes do not deploy edge functions.

Run:

```bash
npm ci
npm test
npx --yes deno test --no-lock supabase/functions/ --allow-env --allow-net
npx --yes deno check --no-lock \
  supabase/functions/secure-proxy/index.ts \
  supabase/functions/secure-proxy/index.deno.test.ts
```

The authenticated Agy live test remains opt-in and requires explicit live-test
authority:

```bash
AGY_LIVE_TEST=1 npm run test:agy
```

## Activation gates

Before any client uses the VPS endpoint, define acceptable values for latency,
error rate, token usage and cost, output quality, queue behavior, and the
observation period. Use sanitized representative prompt shapes. Never put
medical, financial, personal, or production user data in fixtures or logs.

Record for each activation:

- exact Git commit and release path;
- systemd unit and environment checksums;
- selected provider and model;
- client-key registry checksum without exposing its contents;
- Caddy version and effective config checksum;
- DNS and client base-URL state;
- local and public validation results;
- website health when installed on a shared host;
- observed errors, latency, capacity, tokens, and host resources.

No secret creation, service activation, Caddy mutation, DNS change, client
change, edge deployment, merge, or provider retirement is implied by code or
documentation approval.
