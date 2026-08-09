const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function getEnv(name) {
  if (globalThis.Deno?.env?.get) {
    return globalThis.Deno.env.get(name);
  }
  return globalThis.process?.env?.[name];
}

async function verifyInsforgeAuth(req) {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return false;
  }

  const baseUrl = getEnv("INSFORGE_BASE_URL");
  if (!baseUrl) {
    throw new Error("INSFORGE_BASE_URL is not configured in environment.");
  }

  const authResponse = await fetch(`${baseUrl}/api/auth/sessions/current`, {
    headers: { Authorization: authHeader },
  });

  return authResponse.ok;
}

module.exports = async function secureProxy(req) {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed." }, 405);
  }

  try {
    const isAuthenticated = await verifyInsforgeAuth(req);
    if (!isAuthenticated) {
      return jsonResponse({ error: "Unauthorized." }, 401);
    }

    const apiKey = getEnv("MINIMAX_API_KEY");
    if (!apiKey) {
      return jsonResponse(
        { error: "MINIMAX_API_KEY is not configured in environment." },
        500
      );
    }

    const clientBody = await req.json();
    const prompt = clientBody.prompt;

    if (!prompt) {
      return jsonResponse({ error: "Missing prompt in request body." }, 400);
    }

    const apiResponse = await fetch("https://api.minimax.io/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "MiniMax-M2.5",
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!apiResponse.ok) {
      const errorText = await apiResponse.text();
      throw new Error(`Upstream API error: ${apiResponse.status} ${errorText}`);
    }

    const data = await apiResponse.json();
    const choices = data.choices;
    if (!choices || choices.length === 0) {
      throw new Error("MiniMax returned empty choices.");
    }

    const content = choices[0].message?.content;
    if (!content) {
      throw new Error("MiniMax returned missing content.");
    }

    return jsonResponse({ content }, 200);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Unknown error";
    return jsonResponse({ error: errorMessage }, 400);
  }
};
