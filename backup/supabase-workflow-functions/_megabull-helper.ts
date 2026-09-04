// Shared MegaBull client: api-key + auto-healing Bearer JWT.
// Data endpoints now require Authorization: Bearer <jwt>; if the stored JWT is
// expired/missing we sign in, persist the fresh JWT to ai_agent_config, and retry once.
const MEGA_API = 'https://api.megabull.in';
const MEGA_KEY = '5bd189e7-ef64-4571-82d1-d4c7eac7aa8f';
const MEGA_EMAIL = 'shubhampawar9090@gmail.com';
const MEGA_PASSWORD = 'NeonNSE@2026';
const _SB = Deno.env.get("SUPABASE_URL") || "";
const _SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
function _sbh() { return { apikey: _SRK, Authorization: `Bearer ${_SRK}`, "Content-Type": "application/json" }; }
let _jwtCache: { jwt: string; ts: number } | null = null;

async function _storedJwt(): Promise<string> {
  if (_jwtCache && Date.now() - _jwtCache.ts < 60000) return _jwtCache.jwt;
  try {
    const res = await fetch(`${_SB}/rest/v1/ai_agent_config?select=mega_bull_jwt&limit=1`, { headers: _sbh() });
    const cfg = (await res.json() || [])[0];
    _jwtCache = { jwt: cfg?.mega_bull_jwt || "", ts: Date.now() };
    return _jwtCache.jwt;
  } catch { return ""; }
}

async function _megaLogin(): Promise<string> {
  const res = await fetch(`${MEGA_API}/api/auth/signin`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'api-key': MEGA_KEY },
    body: JSON.stringify({ emailId: MEGA_EMAIL, password: MEGA_PASSWORD }),
  });
  const data = await res.json();
  if (!data.token) throw new Error('MegaBull login failed: ' + JSON.stringify(data).slice(0, 150));
  try {
    const cfgRes = await fetch(`${_SB}/rest/v1/ai_agent_config?select=id&limit=1`, { headers: _sbh() });
    const cfg = (await cfgRes.json() || [])[0];
    if (cfg?.id) {
      await fetch(`${_SB}/rest/v1/ai_agent_config?id=eq.${cfg.id}`, {
        method: 'PATCH', headers: _sbh(),
        body: JSON.stringify({
          mega_bull_jwt: data.token,
          mega_bull_refresh_token: data.refreshToken || null,
          mega_bull_token_expiry: data.expiryTimeStamp || null,
          updated_at: new Date().toISOString(),
        }),
      });
    }
  } catch (e) { console.error('jwt store failed:', String(e)); }
  _jwtCache = { jwt: data.token, ts: Date.now() };
  return data.token;
}

async function megaFetch(path: string, method: string = 'GET', body?: any) {
  let jwt = await _storedJwt();
  const doFetch = (t: string) => fetch(`${MEGA_API}${path}`, {
    method,
    headers: { 'api-key': MEGA_KEY, 'Authorization': `Bearer ${t}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let res = await doFetch(jwt);
  if (res.status === 401 || res.status === 403) {
    const txt = await res.text();
    try {
      const j = JSON.parse(txt);
      if (j.error === 'AuthenticationException' || j.status === 'UNAUTHORIZED' || /api key/i.test(j.message?.join?.('') || j.message || '')) {
        jwt = await _megaLogin();
        res = await doFetch(jwt);
      }
    } catch { /* non-json 401 — retry with fresh login anyway */ 
      jwt = await _megaLogin();
      res = await doFetch(jwt);
    }
  }
  return res.json();
}
