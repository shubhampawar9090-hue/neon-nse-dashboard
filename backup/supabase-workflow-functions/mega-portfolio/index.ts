// mega-portfolio — Supabase port of Base44 getMegaPortfolio v2.1
// JWT now read from ai_agent_config (updated daily by megabull-token-refresh cron)

const SB = Deno.env.get("SUPABASE_URL") || "";
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
function sbh() { return { apikey: SRK, Authorization: `Bearer ${SRK}`, "Content-Type": "application/json" }; }

async function loadJwtFromConfig(): Promise<string> {
  try {
    const res = await fetch(`${SB}/rest/v1/ai_agent_config?select=mega_bull_jwt&limit=1`, { headers: sbh() });
    const cfg = (await res.json() || [])[0];
    return cfg?.mega_bull_jwt || "";
  } catch { return ""; }
}

// Shared: simple key guard for cron-internal edge functions.
// Accepts either the service-role bearer or the x-cron-key secret.
export function authorized(req: Request): boolean {
  const auth = req.headers.get("Authorization") || "";
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (service && auth === `Bearer ${service}`) return true;
  const cronKey = req.headers.get("x-cron-key") || "";
  const secret = Deno.env.get("CRON_SECRET") || "";
  return !!(cronKey && secret && cronKey === secret);
}

// Fetch MegaBull portfolio data with REAL LTP via WebSocket
// v2.1: JWT token auto-refreshed daily via MegaBull Token Refresh workflow at 9:10 AM IST
// The workflow agent step calls this function with {updateToken: "<fresh_jwt>"} every morning

const MEGA_WS = 'wss://socket.megabull.in';

// JWT token — refreshed daily by workflow, or passed via request body
// Fresh token from Aug 4 login (valid until midnight IST)
let MEGA_JWT = 'eyJhbGciOiJIUzUxMiJ9.eyJzdWIiOiI4OGNhNTM1YS04ZTk4LTExZjEtOTExNC0xOTc3NWNhY2RiODciLCJpYXQiOjE3ODU4MjU4OTIsImV4cCI6MTc4NTg2ODE5OX0.YNB1eiz2NMXp_P2StCSMmPGfH8veJn8HOE-vnRPK4UeQZS0YE6xF4jswKcT2tK2_kxUwLJGGYvB9ztN6ADE8Qg';

let ltpCache: { tokens: string[], prices: Record<string, number>, ts: number } = { tokens: [], prices: {}, ts: 0 };
const CACHE_TTL = 3000;

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


Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*" } });
  const _body: any = await req.json().catch(() => ({}));
  if (!_body.jwtToken && !_body.token && !_body.updateToken) {
    const stored = await loadJwtFromConfig();
    if (stored) { _body.jwtToken = stored; }
  }
  const req2 = new Request("https://internal", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(_body) });
  return await portfolioHandler(req2);
});

async function portfolioHandler(req: Request): Promise<Response> {
  try {
    const body = await req.json().catch(() => ({}));
    
    if (body.updateToken) {
      MEGA_JWT = body.updateToken;
      return json({ success: true, message: 'Token updated', tokenLength: MEGA_JWT.length });
    }
    
    const jwtToken = body.jwtToken || body.token || MEGA_JWT;
    const liteMode = body.lite === true;
    
    const fetches: Promise<any>[] = [];
    
    fetches.push(
      fetch(`${MEGA_API}/api/position/my`, {
        headers: { 'api-key': MEGA_KEY, 'Authorization': `Bearer ${await _storedJwt()}`, 'Content-Type': 'application/json' }
      }).then(r => r.ok ? r.json() : []).catch(() => [])
    );
    
    fetches.push(
      fetch(`${MEGA_API}/api/user/my`, {
        headers: { 'api-key': MEGA_KEY, 'Authorization': `Bearer ${await _storedJwt()}`, 'Content-Type': 'application/json' }
      }).then(r => r.ok ? r.json() : {}).catch(() => ({}))
    );
    
    if (!liteMode) {
      fetches.push(
        fetch(`${MEGA_API}/api/order/my`, {
          headers: { 'api-key': MEGA_KEY, 'Authorization': `Bearer ${await _storedJwt()}`, 'Content-Type': 'application/json' }
        }).then(r => r.ok ? r.json() : {}).catch(() => ({}))
      );
    } else {
      fetches.push(Promise.resolve(null));
    }
    
    const [positionsRaw, capitalData, ordersRaw] = await Promise.all(fetches);
    
    const positions: any[] = Array.isArray(positionsRaw) ? positionsRaw : [];
    
    let capital = 0, availableMargin = 0, blockedMargin = 0;
    if (capitalData) {
      capital = capitalData.virtualMoney || capitalData.capital || 0;
      availableMargin = capitalData.virtualMoneyLeft || capitalData.availableMargin || 0;
      blockedMargin = capitalData.virtualMoneyBlocked || 0;
    }
    
    let orders: any[] = [];
    let openOrders: any[] = [];
    if (ordersRaw) {
      if (Array.isArray(ordersRaw)) {
        orders = ordersRaw;
      } else if (ordersRaw && Array.isArray(ordersRaw.executed)) {
        orders = ordersRaw.executed;
        openOrders = Array.isArray(ordersRaw.open) ? ordersRaw.open : [];
      } else if (ordersRaw && !Array.isArray(ordersRaw)) {
        orders = [ordersRaw];
      }
    }
    
    const instrumentTokens = positions
      .filter((p: any) => p.qty > 0)
      .map((p: any) => String(p.instrumentToken));
    
    let ltpMap: Record<string, number> = {};
    let cacheValid = false;
    
    if (jwtToken && instrumentTokens.length > 0) {
      const now = Date.now();
      cacheValid = ltpCache.tokens.length > 0 && 
        JSON.stringify(ltpCache.tokens.sort()) === JSON.stringify(instrumentTokens.sort()) &&
        (now - ltpCache.ts) < CACHE_TTL;
      
      if (cacheValid) {
        ltpMap = { ...ltpCache.prices };
        fetchLtpViaWebSocket(jwtToken, instrumentTokens).then(prices => {
          ltpCache = { tokens: instrumentTokens, prices, ts: Date.now() };
        }).catch(() => {});
      } else {
        try {
          ltpMap = await fetchLtpViaWebSocket(jwtToken, instrumentTokens);
          ltpCache = { tokens: instrumentTokens, prices: ltpMap, ts: Date.now() };
        } catch (e) {}
      }
    }
    
    const enrichedPositions = positions.map((p: any) => {
      const ltp = ltpMap[String(p.instrumentToken)] || 0;
      const pnl = ltp > 0 && p.qty > 0
        ? (ltp - p.priceAvg) * p.qty * (p.type === 'LONG' ? 1 : -1)
        : (p.pl || 0);
      
      return {
        instrumentToken: String(p.instrumentToken),
        instrumentName: p.instrumentName || '',
        duration: p.duration || 'MIS',
        qty: p.qty || 0,
        lotSize: p.lotSize || 65,
        type: p.type || 'LONG',
        avgPrice: p.priceAvg || p.avgBuyPrice || 0,
        ltp: ltp,
        pnl: Math.round(pnl * 100) / 100,
        changePercent: ltp > 0 && (p.priceAvg || 0) > 0
          ? Math.round(((ltp - p.priceAvg) / p.priceAvg * 100) * 100) / 100
          : 0,
        source: ltp > 0 ? 'WebSocket' : 'None'
      };
    });
    
    const totalPnL = enrichedPositions
      .filter((p: any) => p.qty > 0)
      .reduce((sum: number, p: any) => sum + p.pnl, 0);
    
    const openPositions = enrichedPositions.filter((p: any) => p.qty > 0);
    
    return json({
      success: true,
      timestamp: Date.now(),
      capital,
      availableMargin,
      blockedMargin,
      positions: openPositions,
      orders: liteMode ? [] : orders.slice(0, 20),
      openOrders: liteMode ? [] : openOrders,
      totalPnL: Math.round(totalPnL * 100) / 100,
      ltpSource: Object.keys(ltpMap).length > 0 ? 'WebSocket' : 'None',
      instrumentCount: instrumentTokens.length,
      ltpCount: Object.keys(ltpMap).length,
      cached: cacheValid,
      lite: liteMode
    });
    
  } catch (err) {
    return json({ error: String(err), success: false }, 500);
  }
}

async function fetchLtpViaWebSocket(jwtToken: string, instrumentTokens: string[]): Promise<Record<string, number>> {
  return new Promise((resolve) => {
    const wsUrl = `${MEGA_WS}?id=${jwtToken}`;
    const ws = new WebSocket(wsUrl);
    const ltpMap: Record<string, number> = {};
    let resolved = false;
    
    const finish = () => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        try { ws.close(); } catch (e) {}
        resolve(ltpMap);
      }
    };
    
    const timeout = setTimeout(finish, 3000);
    
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'SUBSCRIBE', data: instrumentTokens }));
    };
    
    ws.onmessage = (event: any) => {
      try {
        const data = JSON.parse(event.data);
        if (data.TYPE === 'ORDER_UPDATE') return;
        
        if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
          for (const key of Object.keys(data)) {
            if (/^\d+$/.test(key)) {
              const price = parseFloat(data[key]);
              if (!isNaN(price) && price > 0) ltpMap[key] = price;
            }
          }
          const foundCount = instrumentTokens.filter(t => ltpMap[t] !== undefined).length;
          if (foundCount >= instrumentTokens.length) finish();
        }
      } catch (e) {}
    };
    
    ws.onerror = finish;
    ws.onclose = finish;
  });
}

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  });
}