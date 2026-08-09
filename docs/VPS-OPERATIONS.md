# VPS service operations

This guide covers the provider-neutral Node.js target. Repository approval and
merge do not authorize installation or activation. Do not start or enable the
service from CI.

## Deployment gates

Before changing a server, record the approved commit, target host, service
owner, maintenance window, resource headroom, Node.js version, Agy version,
model, listener ownership, active Caddy unit, Caddy version, installed modules,
effective configuration path, DNS ownership, backups, checksums, validation
commands, and rollback owner.

Stop if the proposed API key would be stored in browser or mobile code. Keys
are for calling application backends only.

## Runtime layout

The committed files use these generic locations:

- release: `/srv/secret-api/current`
- environment: `/etc/secret-api/llm-api.env`
- client hashes: `/etc/secret-api/client-keys.json`
- writable service home and Agy state: `/var/lib/secret-api`
- loopback listener: `127.0.0.1:8787`

Select and record the effective paths during deployment. Keep the environment
and key registry owned by the dedicated `secret-api` account with mode `0600`.
Set `CLIENT_KEYS_FILE=/etc/secret-api/client-keys.json` in the protected
environment file.
The registry stores SHA-256 hashes and non-secret client identifiers. It must
not contain plaintext bearer keys.

Copy `deploy/llm-api.env.example` and
`deploy/client-keys.json.example` into a protected staging location. Replace
all placeholders. Generate at least 256 random bits for every backend secret
through the approved secret-management procedure. Give the plaintext value to
the calling backend secret store once. Store only its SHA-256 digest on the
VPS.

Use overlapping hashes during rotation. Reload a validated registry with
`SIGHUP`; a failed reload leaves the previous in-memory registry active.

## Local validation before installation

From the approved checkout:

```bash
npm ci
npm test
npx --yes deno test --no-lock supabase/functions/ --allow-env --allow-net
npx --yes deno check --no-lock \
  supabase/functions/secure-proxy/index.ts \
  supabase/functions/secure-proxy/index.deno.test.ts
```

The live Agy test requires separate authority:

```bash
AGY_LIVE_TEST=1 npm run test:agy
```

## Inactive installation

Create the dedicated account, release directory, configuration directory, and
writable state directory through the server's normal configuration mechanism.
Install the approved release and the systemd template without starting or
enabling it. Authenticate Agy under the service account with
`HOME=/var/lib/secret-api`, then confirm its state permissions without exposing
credentials.

Validate the unit before activation:

```bash
systemd-analyze verify deploy/systemd/secret-api-llm.service
systemctl cat secret-api-llm.service
```

The template intentionally has no `[Install]` section. Activation requires a
separate supervised decision.

## Loopback smoke checks

After authorized service start and before Caddy changes:

```bash
curl --fail --silent http://127.0.0.1:8787/health
curl --fail --silent http://127.0.0.1:8787/ready
curl --silent --request POST http://127.0.0.1:8787/secure-proxy \
  --header 'Content-Type: application/json' \
  --header "Authorization: Bearer $SECRET_API_KEY" \
  --data '{"prompt":"sanitized validation prompt"}'
```

Also verify invalid keys, malformed JSON, byte limits, rate limits, queue
capacity, provider timeout, and graceful shutdown. Never use customer content.
Confirm the Node port is not reachable from a remote host.

## Caddy integration

Reuse the existing Caddy process. First run and record:

```bash
caddy version
systemctl status caddy
systemctl cat caddy
```

Inspect the complete active Caddyfile and all imports. Back it up and record a
checksum. Adapt `deploy/caddy/secret-api.Caddyfile.example` through the existing
site/import layout. Use the approved hostname. Keep the upstream on loopback.
Do not log authorization headers or request bodies.

Validate the complete effective configuration before reload:

```bash
caddy validate --config /path/to/effective/Caddyfile
```

Use a graceful reload. Verify all existing sites, the new health routes,
invalid authentication, an authenticated sanitized request, limits, logs,
certificate state, website latency, and host resource use.

## Monitoring

Monitor structured `llm_proxy_request` events for status, outcome, client ID,
provider, model, durations, token counts, rate limiting, capacity, timeouts,
and provider failures. Logs must not contain prompts, responses, credentials,
hashes, authorization headers, raw provider output, or stderr.

Keep Agy concurrency at one until measured host and website behavior supports
a reviewed change. Define acceptable latency, errors, token cost, response
quality, queue behavior, and observation time before any client cutover.

## Rollback

1. Return the calling backend to its previous API base URL.
2. Stop the Node service.
3. Restore the exact prior Caddy configuration from backup.
4. Run `caddy validate` on the restored configuration.
5. Gracefully reload Caddy.
6. Verify every pre-existing site and the previous client path.
7. Preserve sanitized Node and Caddy logs and recorded checksums.
8. Revert code only after service restoration.

Do not remove the Supabase or Insforge compatibility deployments or their
credentials as part of this service rollout.
