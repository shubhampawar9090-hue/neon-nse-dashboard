// megabull-token-refresh — Supabase port of Base44 refreshMegaBullToken v1.0
// Logs into MegaBull (or refreshes), stores JWT in ai_agent_config (replaces the agent step)
import { authorized } from "../_shared-guard.ts";

const MEGA_API = 'https://api.megabull.in';
const MEGA_KEY = '5bd189e7-ef64-4571-82d1-d4c7eac7aa8f';
const MEGA_EMAIL = 'shubhampawar9090@gmail.com';
const MEGA_PASSWORD = 'NeonNSE@2026';

const SB = Deno.env.get("SUPABASE_URL") || "";
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
function sb() { return { apikey: SRK, Authorization: `Bearer ${SRK}`, "Content-Type": "application/json" }; }
function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*" } });
  if (!authorized(req)) return json({ success: false, error: "Unauthorized" }, 401);
  try {
    const body = await req.json().catch(() => ({}));
    const cfgRes = await fetch(`${SB}/rest/v1/ai_agent_config?select=id,mega_bull_refresh_token&limit=1`, { headers: sb() });
    const cfg = (await cfgRes.json() || [])[0];

    let tokenData: any = null;

    // 1) Try refresh with stored refresh token
    const refreshToken = body.refreshToken || cfg?.mega_bull_refresh_token;
    if (refreshToken) {
      try {
        const refreshRes = await fetch(`${MEGA_API}/api/auth/refresh`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'api-key': MEGA_KEY },
          body: JSON.stringify({ token: refreshToken, expiryEpoch: 0 })
        });
        if (refreshRes.ok) {
          const refreshData = await refreshRes.json();
          if (refreshData.token) tokenData = { success: true, source: 'refresh', ...refreshData };
        }
      } catch { /* fall through to login */ }
    }

    // 2) Fresh login
    if (!tokenData) {
      const loginRes = await fetch(`${MEGA_API}/api/auth/signin`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'api-key': MEGA_KEY },
        body: JSON.stringify({ emailId: MEGA_EMAIL, password: MEGA_PASSWORD })
      });
      if (!loginRes.ok) {
        const errData = await loginRes.json().catch(() => ({}));
        return json({ success: false, error: `Login failed: ${errData.message || loginRes.statusText}`, status: loginRes.status }, 401);
      }
      const loginData = await loginRes.json();
      if (!loginData.token) return json({ success: false, error: 'Login succeeded but no token returned' }, 500);
      tokenData = { success: true, source: 'login', ...loginData };
    }

    // 3) Store JWT in ai_agent_config (was the Base44 agent step)
    if (cfg?.id) {
      await fetch(`${SB}/rest/v1/ai_agent_config?id=eq.${cfg.id}`, {
        method: 'PATCH', headers: sb(),
        body: JSON.stringify({
          mega_bull_jwt: tokenData.token,
          mega_bull_refresh_token: tokenData.refreshToken || refreshToken || null,
          mega_bull_token_expiry: tokenData.expiryTimeStamp || String(tokenData.expiryEpoch || ''),
          updated_at: new Date().toISOString(),
        })
      });
    }

    // 4) Optional agent notification (same confirmation the agent broadcast before)
    const notify = await fetch(`${SB}/rest/v1/ai_agent_config?select=notify_via_agent&limit=1`, { headers: sb() });
    const notifyFlag = ((await notify.json() || [])[0]?.notify_via_agent) ?? true;
    if (notifyFlag) notifyAgent(
      `MegaBull JWT token refreshed successfully (Supabase megabull-token-refresh). Source: ${tokenData.source}. Expiry: ${tokenData.expiryTimeStamp || 'midnight IST'}. Stored in ai_agent_config.`
    );

    return json({
      success: true, source: tokenData.source,
      token: tokenData.token, refreshToken: tokenData.refreshToken,
      expiryEpoch: tokenData.expiryEpoch, expiryTimeStamp: tokenData.expiryTimeStamp || null,
      stored_in_config: !!cfg?.id,
    });
  } catch (err: any) {
    return json({ success: false, error: String(err) }, 500);
  }
});

function notifyAgent(text: string) {
  const p = fetch(`https://app.base44.com/api/agents/6a5b3772e2193d1b5140a8e3/conversations/${Deno.env.get("AGENT_CONVERSATION_ID")}/messages`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${Deno.env.get("BASE44_SERVICE_TOKEN")}`, "Content-Type": "application/json" },
    body: JSON.stringify({ content: `AUTOMATED NOTIFICATION (non-critical): ${text}\n\nBroadcast a one-line confirmation to the owner. Do not perform any other actions.` }),
  }).catch((e) => console.error("agent notify failed:", String(e)));
  EdgeRuntime.waitUntil(p);
}
