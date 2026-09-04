// sync-portfolio — Supabase port of Base44 syncPortfolio (identical logic; writes ai_trades/ai_agent_config via PostgREST)
import { authorized } from "../_shared-guard.ts";



const SB = Deno.env.get("SUPABASE_URL") || "";
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
function sb() { return { apikey: SRK, Authorization: `Bearer ${SRK}`, "Content-Type": "application/json" }; }

async function dbList(path: string) {
  const res = await fetch(`${SB}/rest/v1/${path}`, { headers: sb() });
  return res.json();
}

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
  const CORS = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (!authorized(req)) return new Response(JSON.stringify({ success: false, error: "Unauthorized" }), { status: 401, headers: CORS });
  try {
    const [positionsRes, ordersRes, profileRes] = await Promise.all([
      megaFetch("/api/position/my"), megaFetch("/api/order/my"), megaFetch("/api/user/my"),
    ]);
    // FAIL-SAFE: if MegaBull auth or API failed, never treat it as "no positions"
    if (positionsRes?.error === "AuthenticationException" || profileRes?.error === "AuthenticationException" || (profileRes && profileRes.virtualMoney === undefined)) {
      return new Response(JSON.stringify({ success: false, error: "MegaBull API unavailable — sync skipped (no trades touched)", api: { positions: positionsRes, profile: profileRes } }), { status: 502, headers: CORS });
    }
    const positions: any[] = Array.isArray(positionsRes) ? positionsRes : (positionsRes?.data || []);
    const executedOrders = ordersRes?.executed || [];
    const openOrders = ordersRes?.open || [];
    const profile = profileRes || {};
    const totalCapital = profile.virtualMoney || 0;
    const blockedMargin = profile.virtualMoneyBlocked || 0;
    const availableMargin = profile.virtualMoneyLeft || 0;
    const totalPnL = positions.reduce((sum: number, p: any) => sum + (p.pl || 0), 0);

    let syncedPositions = 0;
    for (const pos of positions) {
      const symbol = pos.instrumentName || pos.symbol;
      if (!symbol) continue;
      const existing = await dbList(`ai_trades?symbol=eq.${encodeURIComponent(symbol)}&execution_status=eq.OPEN&select=id`);
      const tradeData: any = {
        symbol,
        action: (pos.type === "SHORT" || pos.type === "SELL") ? "SELL" : "BUY",
        signal: (pos.type === "SHORT" || pos.type === "SELL") ? "SELL" : "BUY",
        qty: pos.qty || 0,
        entry_price: pos.priceAvg || pos.avgBuyPrice || 0,
        price: pos.ltp || pos.lastPrice || pos.priceAvg || 0,
        instrument_token: String(pos.instrumentToken || ""),
        position_size: (pos.qty || 0) * (pos.priceAvg || pos.avgBuyPrice || 0),
        execution_status: "OPEN",
        duration: pos.duration || "MIS",
        strategy: "NIFTY_WEEKLY",
        reason: "Live sync from MegaBull",
        pnl: pos.pl || 0,
        updated_date: new Date().toISOString(),
      };
      if (existing && existing.length > 0) {
        await fetch(`${SB}/rest/v1/ai_trades?id=eq.${existing[0].id}`, {
          method: "PATCH", headers: sb(), body: JSON.stringify(tradeData),
        });
      } else {
        await fetch(`${SB}/rest/v1/ai_trades`, {
          method: "POST", headers: { ...sb(), Prefer: "return=minimal" },
          body: JSON.stringify({ ...tradeData, broker: "MEGABULL", created_date: new Date().toISOString() }),
        });
      }
      syncedPositions++;
    }

    // Close ai_trades rows for positions no longer live in MegaBull
    const allOpen = await dbList("ai_trades?execution_status=eq.OPEN&broker=neq.VIRTUAL&select=id,symbol"); // VIRTUAL trades live in our ledger, not MegaBull
    const liveSymbols = new Set(positions.map((p: any) => p.instrumentName || p.symbol).filter(Boolean));
    let closedStale = 0;
    for (const trade of allOpen || []) {
      if (!liveSymbols.has(trade.symbol)) {
        await fetch(`${SB}/rest/v1/ai_trades?id=eq.${trade.id}`, {
          method: "PATCH", headers: sb(),
          body: JSON.stringify({ execution_status: "CLOSED", reason: "Position closed in MegaBull (auto-sync)", updated_date: new Date().toISOString() }),
        });
        await fetch(`${SB}/rest/v1/trade_events`, {
          method: "POST", headers: sb(),
          body: JSON.stringify({ trade_id: trade.id, symbol: trade.symbol, event_type: "AUTO_CLOSE", payload: { source: "sync-portfolio" } }),
        });
        closedStale++;
      }
    }

    // Update config capital + last run
    const cfg = await dbList("ai_agent_config?select=id&limit=1");
    if (cfg && cfg.length > 0) {
      await fetch(`${SB}/rest/v1/ai_agent_config?id=eq.${cfg[0].id}`, {
        method: "PATCH", headers: sb(),
        body: JSON.stringify({
          total_pnl: totalPnL, last_run_at: new Date().toISOString(),
          capital_total: totalCapital, capital_available: availableMargin, capital_blocked: blockedMargin,
          updated_at: new Date().toISOString(),
        }),
      });
    }

    return new Response(JSON.stringify({
      success: true, syncedPositions, closedStale,
      totalOpenOrders: openOrders.length, totalExecutedOrders: executedOrders.length,
      capital: { total: totalCapital, available: availableMargin, blocked: blockedMargin, pnl: totalPnL },
      timestamp: new Date().toISOString(),
    }), { headers: CORS });
  } catch (err: any) {
    return new Response(JSON.stringify({ success: false, error: err.message || String(err) }), { status: 500, headers: CORS });
  }
});
