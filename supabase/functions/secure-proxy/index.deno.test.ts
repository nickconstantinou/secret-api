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
  // Ensure env is empty
  const envStub = stub(Deno.env, "get", (_key) => undefined);
  try {
    const req = new Request("http://localhost", { method: "POST" });
    const res = await handler(req);
    assertEquals(res.status, 500);
    const body = await res.json();
    assertEquals(body.error, "MINIMAX_API_KEY is not configured in environment.");
  } finally {
    envStub.restore();
  }
});

Deno.test("secure-proxy - Returns data from third-party API on success", async () => {
  const envStub = stub(Deno.env, "get", (key) => {
    if (key === "MINIMAX_API_KEY") return "test_key_123";
    return undefined;
  });

  const fetchStub = stub(globalThis, "fetch", (...args) => {
    const init = args[1] as RequestInit;
    // Check if the Authorization header was correctly set
    const authHeader = (init?.headers as Record<string, string>)?.["Authorization"];
    assertEquals(authHeader, "Bearer test_key_123");
    
    return Promise.resolve(new Response(JSON.stringify({ success: true, dummyData: "value" }), {
      status: 200,
    }));
  });

  try {
    const req = new Request("http://localhost", { method: "POST" });
    const res = await handler(req);
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.success, true);
    assertEquals(body.dummyData, "value");
  } finally {
    envStub.restore();
    fetchStub.restore();
  }
});

Deno.test("secure-proxy - Handles third-party API errors", async () => {
  const envStub = stub(Deno.env, "get", (key) => {
    if (key === "MINIMAX_API_KEY") return "test_key_123";
    return undefined;
  });

  const fetchStub = stub(globalThis, "fetch", (..._args) => {
    return Promise.resolve(new Response("Unauthorized", {
      status: 401,
    }));
  });

  try {
    const req = new Request("http://localhost", { method: "POST" });
    const res = await handler(req);
    
    // Our handler catches non-ok responses and throws, returning 400 with the error message
    assertEquals(res.status, 400);
    const body = await res.json();
    assertEquals(body.error, "Upstream API error: 401 Unauthorized");
  } finally {
    envStub.restore();
    fetchStub.restore();
  }
});
