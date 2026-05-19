/**
 * PURPOSE: Tests the secure-proxy Edge Function logic.
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { stub } from "https://deno.land/std@0.224.0/testing/mock.ts";
import { handler } from "./index.ts";

Deno.test("secure-proxy - Handles OPTIONS preflight", async () => {
  const req = new Request("http://localhost", { method: "OPTIONS" });
  const res = await handler(req);
  assertEquals(res.status, 200);
  assertEquals(await res.text(), "ok");
  assertEquals(res.headers.get("Access-Control-Allow-Origin"), "*");
});

Deno.test("secure-proxy - Returns 500 if API key is missing", async () => {
  const envStub = stub(Deno.env, "get", (_key) => undefined);
  try {
    const req = new Request("http://localhost", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "test" }),
    });
    const res = await handler(req);
    assertEquals(res.status, 500);
    const body = await res.json();
    assertEquals(body.error, "MINIMAX_API_KEY is not configured in environment.");
  } finally {
    envStub.restore();
  }
});

Deno.test("secure-proxy - Returns 400 if prompt is missing", async () => {
  const envStub = stub(Deno.env, "get", (key) => {
    if (key === "MINIMAX_API_KEY") return "test_key_123";
    return undefined;
  });
  try {
    const req = new Request("http://localhost", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const res = await handler(req);
    assertEquals(res.status, 400);
    const body = await res.json();
    assertEquals(body.error, "Missing prompt in request body.");
  } finally {
    envStub.restore();
  }
});

Deno.test("secure-proxy - Returns content from MiniMax on success", async () => {
  const envStub = stub(Deno.env, "get", (key) => {
    if (key === "MINIMAX_API_KEY") return "test_key_123";
    return undefined;
  });

  const fetchStub = stub(globalThis, "fetch", (...args) => {
    const init = args[1] as RequestInit;
    const authHeader = (init?.headers as Record<string, string>)?.["Authorization"];
    assertEquals(authHeader, "Bearer test_key_123");

    return Promise.resolve(new Response(JSON.stringify({
      choices: [{ message: { content: "Hello from MiniMax" } }],
    }), { status: 200 }));
  });

  try {
    const req = new Request("http://localhost", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "say hello" }),
    });
    const res = await handler(req);
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.content, "Hello from MiniMax");
  } finally {
    envStub.restore();
    fetchStub.restore();
  }
});

Deno.test("secure-proxy - Handles upstream API errors", async () => {
  const envStub = stub(Deno.env, "get", (key) => {
    if (key === "MINIMAX_API_KEY") return "test_key_123";
    return undefined;
  });

  const fetchStub = stub(globalThis, "fetch", () => {
    return Promise.resolve(new Response("Unauthorized", { status: 401 }));
  });

  try {
    const req = new Request("http://localhost", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "test" }),
    });
    const res = await handler(req);
    assertEquals(res.status, 400);
    const body = await res.json();
    assertEquals(body.error, "Upstream API error: 401 Unauthorized");
  } finally {
    envStub.restore();
    fetchStub.restore();
  }
});

Deno.test("secure-proxy - Handles empty choices from MiniMax", async () => {
  const envStub = stub(Deno.env, "get", (key) => {
    if (key === "MINIMAX_API_KEY") return "test_key_123";
    return undefined;
  });

  const fetchStub = stub(globalThis, "fetch", () => {
    return Promise.resolve(new Response(JSON.stringify({ choices: [] }), { status: 200 }));
  });

  try {
    const req = new Request("http://localhost", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "test" }),
    });
    const res = await handler(req);
    assertEquals(res.status, 400);
    const body = await res.json();
    assertEquals(body.error, "MiniMax returned empty choices.");
  } finally {
    envStub.restore();
    fetchStub.restore();
  }
});
