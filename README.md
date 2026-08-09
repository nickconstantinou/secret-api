# Secret API

A secure backend proxy for routing third-party API requests without exposing provider credentials to clients.

## Overview
- **Supabase deployment:** TypeScript / Deno in `supabase/functions/secure-proxy/`
- **Insforge deployment:** JavaScript in `insforge/functions/secure-proxy.js`
- **Client contract:** authenticated `POST {"prompt":"..."}` returns `{"content":"..."}`

The two implementations are independent deployment options. Keep their public request and response contract aligned. Platform authentication remains specific to each deployment.

The current implementations call MiniMax. A future Agy-backed API is a separate deployment type because the Agy CLI requires a host that can execute the local binary. It must preserve the same client contract.

## Client Apps

The following apps consume the `secure-proxy` Edge Function:
- **horizon-ai** — financial portfolio analyser
- **labwhisperer** — blood test analyser

Both apps authenticate via `signInAnonymously()` and send `{prompt: "..."}` payloads.

## Edge Function key constraint

> **Important:** Supabase Edge Functions only support JWT verification with the **legacy `anon` key** (JWT-based, starts with `eyJ...`). The newer `sb_publishable_...` keys do **not** work with Edge Function JWT verification — using them requires `--no-verify-jwt`, which removes auth entirely.
>
> Client apps must be built with the legacy anon JWT key in `SUPABASE_PUBLISHABLE_KEY`.
>
> See: https://supabase.com/docs/guides/getting-started/api-keys

## Development

Run the Insforge contract tests with Node.js 24:

```bash
npm test
```

Run the Supabase Edge Function tests with Deno:

```bash
deno test supabase/functions/ --allow-env --allow-net
```

### Supabase

Run edge functions locally using the Supabase CLI:

```bash
# Start local Supabase stack
supabase start

# Serve the edge function locally
supabase functions serve secure-proxy
```
