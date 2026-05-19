# Secret API

A secure backend proxy pattern implemented using Supabase Edge Functions. This repository acts as a backend proxy for routing third-party API requests securely.

## Overview
- **Framework:** Supabase Edge Functions
- **Language:** TypeScript / Deno
- **Deployed to:** `Marketing` Supabase project (`araqigsimkjsmwhnjesv`)

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

Run edge functions locally using the Supabase CLI:

```bash
# Start local Supabase stack
supabase start

# Serve the edge function locally
supabase functions serve secure-proxy
```
