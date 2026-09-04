// get-mega-jwt — fresh MegaBull JWT for the dashboard's live WebSocket feed.
// Read-only purpose: the JWT powers wss://socket.megabull.in tick data (paper account).
const MEGA_API = 'https://api.megabull.in';
const MEGA_KEY = '5bd189e7-ef64-4571-82d1-d4c7eac7aa8f';
const MEGA_EMAIL = 'shubhampawar9090@gmail.com';
const MEGA_PASSWORD = 'NeonNSE@2026';

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  }});
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*" } });
  try {
    const res = await fetch(`${MEGA_API}/api/auth/signin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': MEGA_KEY },
      body: JSON.stringify({ emailId: MEGA_EMAIL, password: MEGA_PASSWORD }),
    });
    const j: any = await res.json().catch(() => ({}));
    if (!j.token) return json({ success: false, error: j.message || 'signin failed' }, 502);
    return json({ success: true, token: j.token, expiryEpoch: j.expiryEpoch || null });
  } catch (e: any) {
    return json({ success: false, error: e.message }, 500);
  }
});
