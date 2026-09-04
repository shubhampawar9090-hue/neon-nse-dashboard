export function authorized(req: Request): boolean {
  const auth = req.headers.get("Authorization") || "";
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (service && auth === `Bearer ${service}`) return true;
  const cronKey = req.headers.get("x-cron-key") || "";
  const secret = Deno.env.get("CRON_SECRET") || "";
  return !!(cronKey && secret && cronKey === secret);
}

// position-monitor — Supabase port of Base44 positionMonitor v2.0 (identical logic)
// Reads open trades from ai_trades, monitors LTP (WebSocket primary, Black-Scholes fallback),
// exits on trailing/SL/TP conditions and places SELL orders automatically, updates ai_trades.

const SB = Deno.env.get("SUPABASE_URL") || "";
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
function sb() { return { apikey: SRK, Authorization: `Bearer ${SRK}`, "Content-Type": "application/json" }; }

async function loadJwtFromConfig(): Promise<string> {
  try {
    const res = await fetch(`${SB}/rest/v1/ai_agent_config?select=mega_bull_jwt&limit=1`, { headers: sb() });
    const cfg = (await res.json() || [])[0];
    return cfg?.mega_bull_jwt || "";
  } catch { return ""; }
}

async function dbList(path: string) {
  const res = await fetch(`${SB}/rest/v1/${path}`, { headers: sb() });
  return res.json();
}

async function updateTrade(id: string, patch: any) {
  await fetch(`${SB}/rest/v1/ai_trades?id=eq.${id}`, {
    method: "PATCH", headers: sb(),
    body: JSON.stringify({ ...patch, updated_date: new Date().toISOString() }),
  });
}

async function addEvent(tradeId: string, symbol: string, type: string, payload: any) {
  await fetch(`${SB}/rest/v1/trade_events`, {
    method: "POST", headers: sb(),
    body: JSON.stringify({ trade_id: tradeId, symbol, event_type: type, payload }),
  });
}

function notifyAgent(text: string) {
  // Supabase notifications channel (replaces Base44 agent API broadcast)
  const p = fetch(`${SB}/rest/v1/notifications`, {
    method: "POST",
    headers: { ...sb(), Prefer: "return=minimal" },
    body: JSON.stringify({ source: "position-monitor", title: "Position Monitor", message: text, severity: "trade" }),
  }).catch((e) => console.error("notification insert failed:", String(e)));
  p.catch(() => {});
}


// Position Monitor v2.0 — Real WebSocket LTP + BS fallback
// Primary: MegaBull WebSocket for exact option prices
// Fallback: Black-Scholes estimate if WebSocket fails (expired JWT, network issue)
// Called by Trailing Stop Monitor workflow, loops 4× internally for ~1-min monitoring

const MEGA_WS = 'wss://socket.megabull.in';
const SUPABASE_URL = 'https://jqmhcalsabexjjiceoux.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpxbWhjYWxzYWJleGpqaWNlb3V4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU0MjM1MTMsImV4cCI6MjEwMDk5OTUxM30.nleTw2AsZfQubBEYYWsPKuzqzGFmB9ueR93gmvKYek8';

// JWT token — refreshed daily by MegaBull Token Refresh workflow
// Also accepts jwtToken/updateToken via request body
let MEGA_JWT = 'eyJhbGciOiJIUzUxMiJ9.eyJzdWIiOiI4OGNhNTM1YS04ZTk4LTExZjEtOTExNC0xOTc3NWNhY2RiODciLCJpYXQiOjE3ODU4MjU4OTIsImV4cCI6MTc4NTg2ODE5OX0.YNB1eiz2NMXp_P2StCSMmPGfH8veJn8HOE-vnRPK4UeQZS0YE6xF4jswKcT2tK2_kxUwLJGGYvB9ztN6ADE8Qg';

// === Black-Scholes (fallback) ===
function erf(x: number): number {
  const a1=0.254829592,a2=-0.284496736,a3=1.421413741,a4=-1.453152027,a5=1.061405429,p=0.3275911;
  const sign=x<0?-1:1; x=Math.abs(x); const t=1/(1+p*x);
  const y=1-(((((a5*t+a4)*t)+a3)*t+a2)*t+a1)*t*Math.exp(-x*x);
  return sign*y;
}
function normCDF(x: number): number { return 0.5*(1+erf(x/Math.sqrt(2))); }
function bsPrice(S: number, K: number, T: number, r: number, sigma: number, type: string): number {
  if (T<=0||sigma<=0||S<=0||K<=0) return 0;
  const sqrtT=Math.sqrt(T);
  const d1=(Math.log(S/K)+(r+sigma*sigma/2)*T)/(sigma*sqrtT);
  const d2=d1-sigma*sqrtT;
  const discountK=K*Math.exp(-r*T);
  if (type==='PE') return discountK*normCDF(-d2)-S*normCDF(-d1);
  return S*normCDF(d1)-discountK*normCDF(d2);
}

function parseOption(trade: any): { strike: number, type: string, dte: number } {
  const sym = trade.tradingSymbol || trade.symbol || '';
  const typeMatch = sym.match(/(CE|PE)$/);
  const type = typeMatch ? typeMatch[1] : (trade.signal === 'SELL' ? 'PE' : 'CE');
  const strikeMatch = sym.match(/(\d{5,6})(CE|PE)$/);
  let strike = strikeMatch ? parseInt(strikeMatch[1].slice(-5)) : 0;
  if (!strike && trade.symbol) {
    const nameMatch = trade.symbol.match(/(\d{4,6})\s*(CE|PE)/);
    if (nameMatch) strike = parseInt(nameMatch[1]);
  }
  let dte = 7;
  const monthMap: Record<string, number> = {JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,OCT:9,NOV:10,DEC:11};
  const expMatch = (trade.symbol || '').match(/(\d{2})\s*([A-Z]{3})/);
  if (expMatch) {
    const day = parseInt(expMatch[1]); const month = monthMap[expMatch[2]];
    if (month !== undefined) {
      const now = new Date();
      let year = now.getFullYear();
      let expDate = new Date(year, month, day, 15, 30, 0);
      if (expDate < now) expDate = new Date(year + 1, month, day, 15, 30, 0);
      dte = Math.max(1, Math.floor((expDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)));
    }
  }
  return { strike, type, dte };
}

async function getMarketData(): Promise<{ nifty: number, vix: number }> {
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/get-nse-data`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbols: ['^NSEI', '^INDIAVIX'] })
    });
    const data = await res.json();
    const nifty = (data.data || []).find((p: any) => p.symbol === '^NSEI');
    const vix = (data.data || []).find((p: any) => p.symbol === '^INDIAVIX');
    return { nifty: nifty?.price || 24500, vix: vix?.price || 12 };
  } catch { return { nifty: 24500, vix: 12 }; }
}

function estimateLTP(trade: any, nifty: number, vix: number): number {
  const { strike, type, dte } = parseOption(trade);
  if (!strike) return trade.entryPrice;
  return bsPrice(nifty, strike, dte / 365, 0.07, vix / 100, type);
}

// === WebSocket LTP (primary source) ===
async function fetchLtpViaWebSocket(jwtToken: string, instrumentTokens: string[]): Promise<Record<string, number>> {
  return new Promise((resolve) => {
    const wsUrl = `${MEGA_WS}?id=${jwtToken}`;
    const ws = new WebSocket(wsUrl);
    const ltpMap: Record<string, number> = {};
    let resolved = false;
    
    const finish = () => {
      if (!resolved) { resolved = true; clearTimeout(timeout); try { ws.close(); } catch (e) {} resolve(ltpMap); }
    };
    const timeout = setTimeout(finish, 3000);
    
    ws.onopen = () => { ws.send(JSON.stringify({ type: 'SUBSCRIBE', data: instrumentTokens })); };
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
          if (instrumentTokens.filter(t => ltpMap[t] !== undefined).length >= instrumentTokens.length) finish();
        }
      } catch (e) {}
    };
    ws.onerror = finish;
    ws.onclose = finish;
  });
}

async function placeSellOrder(trade: any) {
  try {
    const tradingSymbol = trade.tradingSymbol || (trade.symbol || '').replace(/\s+/g, '').toUpperCase();
    const res = await fetch(`${MEGA_API}/api/order/buysell`, {
      method: 'POST',
      headers: { 'api-key': MEGA_KEY, 'Authorization': `Bearer ${await _storedJwt()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tradingSymbol, instrumentToken: trade.instrumentToken,
        qty: trade.qty, type: 'SELL', duration: 'MIS', orderType: 'MKT', price: 0
      })
    });
    return await res.json();
  } catch (e) { return { error: String(e) }; }
}

async function runMonitor(req: Request): Promise<Response> {
  try {
    const body = await req.json().catch(() => ({}));
    const trades: any[] = body.trades || [];
    const iterations = body.iterations || 4;
    const delayMs = body.delayMs || 60000;
    const jwtToken = body.jwtToken || body.token || MEGA_JWT;
    
    // Update JWT if provided
    if (body.updateToken) { MEGA_JWT = body.updateToken; }
    
    if (trades.length === 0) return json({ success: true, message: 'No trades to monitor', results: [] });
    
    const allResults: any[] = [];
    let activeTrades = [...trades];
    
    for (let i = 0; i < iterations && activeTrades.length > 0; i++) {
      const ts = new Date().toISOString();
      
      // Fetch market data for BS fallback
      const market = await getMarketData();
      
      // Try WebSocket LTP first (primary source)
      const instrumentTokens = activeTrades.map((t: any) => String(t.instrumentToken));
      let wsLtp: Record<string, number> = {};
      let ltpSource = 'BlackScholes';
      
      if (jwtToken && instrumentTokens.length > 0) {
        try {
          wsLtp = await fetchLtpViaWebSocket(jwtToken, instrumentTokens);
          if (Object.keys(wsLtp).length > 0) ltpSource = 'WebSocket';
        } catch (e) {}
      }
      
      const iterationResults: any[] = [];
      
      for (const trade of [...activeTrades]) {
        // Use WebSocket LTP if available, otherwise BS estimate
        const token = String(trade.instrumentToken);
        let ltp: number;
        
        if (wsLtp[token] !== undefined && wsLtp[token] > 0) {
          ltp = Math.round(wsLtp[token] * 100) / 100;
        } else {
          ltp = Math.round(estimateLTP(trade, market.nifty, market.vix) * 100) / 100;
        }
        
        const currentPeak = Math.max(trade.peakLtp || trade.entryPrice, ltp);
        const currentTrailing = Math.round(currentPeak * 0.85 * 100) / 100;
        const initialSL = trade.sl || (trade.entryPrice * 0.70);
        
        let shouldExit = false; let exitReason = '';
        
        if (ltp <= currentTrailing && currentTrailing > initialSL) {
          shouldExit = true; exitReason = `Trailing stop: LTP ₹${ltp} <= trailing ₹${currentTrailing}`;
        } else if (ltp <= initialSL) {
          shouldExit = true; exitReason = `Initial SL: LTP ₹${ltp} <= SL ₹${initialSL}`;
        } else if (trade.tp3 && ltp >= trade.tp3) {
          shouldExit = true; exitReason = `TP3: LTP ₹${ltp} >= TP3 ₹${trade.tp3}`;
        } else if (trade.tp2 && ltp >= trade.tp2) {
          shouldExit = true; exitReason = `TP2: LTP ₹${ltp} >= TP2 ₹${trade.tp2}`;
        } else if (ltp <= trade.entryPrice * 0.70) {
          shouldExit = true; exitReason = `Hard stop -30%: LTP ₹${ltp}`;
        }
        
        let pnl = Math.round((ltp - trade.entryPrice) * trade.qty * 100) / 100;
        
        if (shouldExit) {
          let order: any;
          if ((trade as any).broker === 'VIRTUAL') {
            const exitFill = Math.max(Math.round((ltp * 0.9975 - 0.05) * 100) / 100, 0.05); // 0.25% slippage
            pnl = Math.round((exitFill - trade.entryPrice) * trade.qty * 100) / 100;
            order = { id: null, status: 'COMPLETE', price: exitFill, virtual: true, note: 'virtual broker exit' };
          } else {
            order = await placeSellOrder(trade);
          }
          iterationResults.push({
            iteration: i+1, timestamp: ts, instrumentToken: trade.instrumentToken,
            symbol: trade.symbol, ltp, ltpSource, peakLtp: currentPeak, trailingStop: currentTrailing,
            nifty: market.nifty, vix: market.vix, status: 'EXIT', exitReason, pnl,
            order: { id: order.id, status: order.status, price: order.price, error: order.error || null }
          });
          activeTrades = activeTrades.filter(t => t.instrumentToken !== trade.instrumentToken);
        } else {
          iterationResults.push({
            iteration: i+1, timestamp: ts, instrumentToken: trade.instrumentToken,
            symbol: trade.symbol, ltp, ltpSource, peakLtp: currentPeak, trailingStop: currentTrailing,
            nifty: market.nifty, vix: market.vix, status: 'HOLD', pnl,
            entryPrice: trade.entryPrice, sl: initialSL,
            tp1: trade.tp1, tp2: trade.tp2, tp3: trade.tp3
          });
        }
      }
      
      allResults.push(...iterationResults);
      if (i < iterations - 1 && activeTrades.length > 0) {
        await new Promise(r => setTimeout(r, delayMs));
      }
    }
    
    const exits = allResults.filter(r => r.status === 'EXIT');
    const lastHold = allResults.filter(r => r.status === 'HOLD').slice(-Math.max(1, activeTrades.length));
    
    return json({
      success: true, totalChecks: allResults.length,
      exits: exits.length, exitDetails: exits,
      finalState: lastHold, remainingActive: activeTrades.length,
      ltpSource: allResults.length > 0 ? allResults[allResults.length-1].ltpSource : 'None',
      results: allResults
    });
  } catch (err) {
    return json({ success: false, error: String(err), results: [] }, 500);
  }
}

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  });
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
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*" } });
  if (!authorized(req)) return json({ success: false, error: "Unauthorized" }, 401);
  const body: any = await req.json().catch(() => ({}));

  // Read open trades from ai_trades unless explicitly provided (same data the Base44 workflow passed in)
  let trades: any[] = body.trades || [];
  if (trades.length === 0) {
    const rows = await dbList("ai_trades?execution_status=eq.OPEN&qty=gt.0&select=id,symbol,qty,entry_price,peak_ltp,trailing_stop,sl,tp1,tp2,tp3,signal,instrument_token,broker");
    trades = (rows || []).map((r: any) => ({
      _dbId: r.id,
      instrumentToken: r.instrument_token,
      symbol: r.symbol,
      tradingSymbol: (r.symbol || "").replace(/\s+/g, "").toUpperCase(),
      qty: Number(r.qty), entryPrice: Number(r.entry_price),
      peakLtp: r.peak_ltp ? Number(r.peak_ltp) : Number(r.entry_price),
      trailingStop: r.trailing_stop ? Number(r.trailing_stop) : null,
      sl: r.sl ? Number(r.sl) : null,
      tp1: r.tp1 ? Number(r.tp1) : null, tp2: r.tp2 ? Number(r.tp2) : null, tp3: r.tp3 ? Number(r.tp3) : null,
      signal: r.signal, broker: r.broker || 'MEGABULL',
    }));
  }

  // JWT: body token > stored config token > embedded fallback
  if (trades.length > 0) body.trades = trades;
  if (!body.jwtToken && !body.token) {
    const jwt = await loadJwtFromConfig();
    if (jwt) body.jwtToken = jwt;
  }

  // Patch: persist results to ai_trades after monitor run (replaces the Base44 agent step 3)
  const res = await runMonitor(new Request("https://internal", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
  const data: any = await res.json().catch(() => ({}));

  if (data?.results && Array.isArray(data.results)) {
    const dbTrades = trades.filter((t: any) => t._dbId);
    const byToken: Record<string, any> = {};
    for (const t of dbTrades) byToken[String(t.instrumentToken)] = t;
    const exits: any[] = [];
    for (const r of data.results) {
      const t = byToken[String(r.instrumentToken)];
      if (!t) continue;
      if (r.status === "EXIT") {
        if (t.broker === 'VIRTUAL') {
          // credit the virtual ledger: cash += qty * exit fill, realized_pnl += pnl
          const exitFill = Number(r.order?.price) || r.ltp;
          const vaRows = await dbList("virtual_account?select=*&limit=1");
          const va: any = (vaRows || [])[0];
          if (va?.id) {
            await fetch(`${SB}/rest/v1/virtual_account?id=eq.${va.id}`, {
              method: "PATCH", headers: sb(),
              body: JSON.stringify({
                cash: Math.round((Number(va.cash) + (Number(t.qty) || 0) * exitFill) * 100) / 100,
                realized_pnl: Math.round((Number(va.realized_pnl) + (Number(r.pnl) || 0)) * 100) / 100,
                updated_at: new Date().toISOString(),
              }),
            });
          }
        }
        await updateTrade(t._dbId, {
          execution_status: "CLOSED", price: r.ltp, peak_ltp: r.peakLtp,
          trailing_stop: r.trailingStop, pnl: r.pnl,
          reason: r.exitReason, order_id: r.order?.id || null,
        });
        await addEvent(t._dbId, t.symbol, "EXIT", r);
        exits.push(r);
      } else {
        // keep last-seen values fresh on holds
        await updateTrade(t._dbId, {
          price: r.ltp, peak_ltp: r.peakLtp, trailing_stop: r.trailingStop,
        });
      }
    }
    if (exits.length > 0) {
      notifyAgent(`${exits.some((x: any) => x.order?.virtual) ? "[VIRTUAL BROKER] " : ""}Position exits detected:

${JSON.stringify(exits, null, 2)}`);
    }
  }

  return new Response(JSON.stringify(data), {
    status: res.status, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
});
