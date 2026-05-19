/**
 * PURPOSE: Securely proxies requests to a third-party API to keep credentials hidden from the client.
 * INPUTS: Client request (requires a valid Supabase JWT in the Authorization header).
 * OUTPUTS: JSON response from the third-party API.
 * NEIGHBORS: Third-party API (https://api.minimax.io).
 * LOGIC: Validates CORS preflight, reads the API key from the secure environment, makes an authenticated POST request to the third-party, and forwards the response.
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

export const handler = async (req: Request): Promise<Response> => {
  // 1. Handle CORS preflight request
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    // 2. Retrieve the secret API key securely
    const apiKey = Deno.env.get('MINIMAX_API_KEY');
    
    if (!apiKey) {
      return new Response(
        JSON.stringify({ error: 'MINIMAX_API_KEY is not configured in environment.' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // 3. Parse the incoming request body from the client
    const clientBody = await req.json();
    const prompt = clientBody.prompt;

    if (!prompt) {
      return new Response(
        JSON.stringify({ error: 'Missing prompt in request body.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // 4. Make the secure request to the MiniMax API
    const targetUrl = 'https://api.minimax.io/v1/chat/completions';
    const apiResponse = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'MiniMax-M2.7',
        messages: [{ role: 'user', content: prompt }]
      }),
    });

    if (!apiResponse.ok) {
      const errorText = await apiResponse.text();
      throw new Error(`Upstream API error: ${apiResponse.status} ${errorText}`);
    }

    // 5. Parse the upstream response and return just the content
    const data = await apiResponse.json();
    const choices = data.choices;
    if (!choices || choices.length === 0) {
      throw new Error('MiniMax returned empty choices.');
    }
    
    const content = choices[0].message?.content;
    if (!content) {
      throw new Error('MiniMax returned missing content.');
    }

    return new Response(JSON.stringify({ content }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (err: unknown) {
    // Using strict catch typing as defined in the repository constraints
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
};

// Protect against Deno.serve executing during test imports
if (import.meta.main) {
  Deno.serve(handler);
}
