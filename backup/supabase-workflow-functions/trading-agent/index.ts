// trading-agent — Supabase port of Base44 "AI Trading Agent v8.3" workflow (deterministic)
// STEP 1: position monitoring (delegates to position-monitor fn, 4×60s — same as v8.3)
// STEP 2: new entries per v8.3 rules (score gates → nearest weekly NIFTY expiry → ATM strike → lot 65 →
//         BUY MKT via MegaBull → ai_trades row with ATR×2 SL, 1:1/1:2/1:3 TPs, 15% trailing)
// STEP 3: update config last_run_at
import { authorized } from "../_shared-guard.ts";

const LOT_SIZE = 65;
const SB = Deno.env.get("SUPABASE_URL") || "";
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
function sb() { return { apikey: SRK, Authorization: `Bearer ${SRK}`, "Content-Type": "application/json" }; }
const CORS = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

async function dbList(path: string) {
  const res = await fetch(`${SB}/rest/v1/${path}`, { headers: sb() });
  return res.json();
}
function istNow() {
  const d = new Date(Date.now() + 5.5 * 3600 * 1000);
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  return { h: d.getUTCHours(), m: d.getUTCMinutes(), dow: d.getUTCDay(), mins };
}
function marketOpenForEntries() {
  const { mins, dow } = istNow();
  if (dow === 0 || dow === 6) return false;
  return mins >= 9 * 60 + 15 && mins <= 15 * 60 + 30; // 09:15–15:30 IST
}
function notifyAgent(content: string) {
  const p = fetch(`https://app.base44.com/api/agents/6a5b3772e2193d1b5140a8e3/conversations/${Deno.env.get("AGENT_CONVERSATION_ID")}/messages`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${Deno.env.get("BASE44_SERVICE_TOKEN")}`, "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  }).catch((e) => console.error("agent notify failed:", String(e)));
  EdgeRuntime.waitUntil(p);
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
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (!authorized(req)) return new Response(JSON.stringify({ success: false, error: "Unauthorized" }), { status: 401, headers: CORS });
  try {
    const body: any = await req.json().catch(() => ({}));
    const iterations = body.iterations ?? 4;
    const delayMs = body.delayMs ?? 60000;
    const entriesEnabled = body.entries !== false;

    // ===== STEP 1 — monitor open positions (same call the v8.3 workflow made) =====
    const monitorRes = await fetch(`${SB}/functions/v1/position-monitor`, {
      method: "POST", headers: sb(),
      body: JSON.stringify({ iterations, delayMs }),
    }).catch((e) => ({ json: async () => ({ success: false, error: String(e) }) }));
    const monitor = await (monitorRes as any).json();

    const cfgRows = await dbList("ai_agent_config?select=*&limit=1");
    const cfg = (cfgRows || [])[0] || {};
    const result: any = { success: true, monitor: { success: monitor?.success, exits: [] as any[] }, entries: [] as any[], config_updated: false };

    for (const r of monitor?.results || []) if (r.status === "EXIT") result.monitor.exits.push({ symbol: r.symbol, reason: r.exitReason, pnl: r.pnl });

    // ===== STEP 2 — new entries (only 09:15–15:30 IST, Mon-Fri, autoExecute on) =====
    const openTrades = await dbList("ai_trades?execution_status=eq.OPEN&qty=gt.0&select=id,symbol");
    const openCount = (openTrades || []).length;

    if (entriesEnabled && marketOpenForEntries() && cfg.auto_execute && openCount < (cfg.max_positions || 5)) {
      const scanRes = await fetch(`${SB}/functions/v1/megabull-agent`, {
        method: "POST", headers: sb(), body: JSON.stringify({ action: "full_scan" }),
      });
      const scan = await scanRes.json();

      const nifty = (scan?.indexAnalysis?.swing || []).find((s: any) => s.symbol === "^NSEI");
      const optionSignals = scan?.optionSignals || [];
      const slots = Math.min((cfg.max_positions || 5) - openCount, cfg.max_trades_per_run || 3);

      // v8.3 rules:
      //   CE entry: NIFTY signal BUY/STRONG BUY with buyScore >= min_buy_score
      //   PE entry: NIFTY signal SELL/STRONG SELL with sellScore >= min_sell_score
      let side: "CE" | "PE" | null = null;
      if (nifty) {
        const sig = String(nifty.signal || "").toUpperCase();
        if ((sig === "BUY" || sig === "STRONG_BUY" || sig === "STRONG BUY") && (nifty.buyScore || 0) >= (cfg.min_buy_score || 65)) side = "CE";
        else if ((sig === "SELL" || sig === "STRONG_SELL" || sig === "STRONG SELL") && (nifty.sellScore || 0) >= (cfg.min_sell_score || 65)) side = "PE";
      }

      if (side && slots > 0) {
        const candidates = optionSignals.filter((o: any) => o.type === side && (o.tradingSymbol || o.symbol));
        const chosen = candidates[0]; // full_scan returns ATM-strike signals for the nearest expiry (same pick order the agent used)
        if (chosen && chosen.strike && chosen.tradingSymbol) {
          // position size: maxPositionSize / premium, rounded down to lot 65
          const premium = Number(chosen.theoreticalPremium ?? chosen.premium ?? chosen.entryPrice ?? 0);
          if (premium > 0) {
            let qty = Math.floor((cfg.max_position_size || 25000) / premium);
            qty = Math.max(LOT_SIZE, Math.floor(qty / LOT_SIZE) * LOT_SIZE);
            const entryPrice = Math.max(premium, 0.05);

            const order: any = await megaFetch("/api/order/buysell", "POST", {
              tradingSymbol: chosen.tradingSymbol,
              instrumentToken: String(chosen.instrumentToken || ""),
              qty, type: "BUY", duration: "MIS", orderType: "MKT", price: 0,
            });

            const fill = Number(order?.price) > 0 ? Number(order.price) : entryPrice;
            // ATR×2 SL on the premium (fallback: 30% premium stop, same as position-monitor default)
            const atr = Number(nifty?.atr || 0);
            const sl = atr > 0 ? Math.max(fill - atr * 2, fill * 0.70) : fill * 0.70;
            const risk = fill - sl;
            const ins = await fetch(`${SB}/rest/v1/ai_trades`, {
              method: "POST", headers: { ...sb(), Prefer: "return=representation" },
              body: JSON.stringify({
                symbol: chosen.symbol || chosen.tradingSymbol,
                action: "BUY", signal: side === "CE" ? "BUY" : "SELL",
                qty, entry_price: fill, price: fill,
                peak_ltp: fill, trailing_stop: Math.round(fill * 0.85 * 100) / 100,
                sl: Math.round(sl * 100) / 100,
                tp1: Math.round((fill + risk * 1) * 100) / 100,
                tp2: Math.round((fill + risk * 2) * 100) / 100,
                tp3: Math.round((fill + risk * 3) * 100) / 100,
                instrument_token: String(chosen.instrumentToken || ""),
                position_size: qty * fill,
                duration: "MIS", strategy: "NIFTY_WEEKLY",
                reason: `Auto entry: NIFTY ${side} score ${side === "CE" ? nifty.buyScore : nifty.sellScore} (v8.3 port)`,
                buy_score: nifty.buyScore ?? null, sell_score: nifty.sellScore ?? null,
                order_id: order?.id ?? null, execution_status: "OPEN",
              }),
            });
            const tradeRow = (await ins.json() || [])[0];
            result.entries.push({ symbol: chosen.symbol || chosen.tradingSymbol, side, qty, entry: fill, order_id: order?.id, trade_id: tradeRow?.id, order });
            if (cfg.notify_via_agent !== false) {
              notifyAgent(`New trade entry (Supabase trading-agent):\n\n${JSON.stringify(result.entries, null, 2)}\n\nBroadcast the trade details to the owner. Do not perform any other actions.`);
            }
          }
        } else {
          result.entries_note = "signal gate passed but no ATM option signal available in scan";
        }
      } else if (!side) {
        result.entries_note = "no entry signal meeting score gates";
      } else {
        result.entries_note = "no open slots";
      }
    } else if (!marketOpenForEntries()) {
      result.entries_note = "market closed for entries";
    }

    // ===== STEP 3 — update config lastRunAt =====
    if (cfg?.id) {
      await fetch(`${SB}/rest/v1/ai_agent_config?id=eq.${cfg.id}`, {
        method: "PATCH", headers: sb(),
        body: JSON.stringify({ last_run_at: new Date().toISOString(), updated_at: new Date().toISOString() }),
      });
      result.config_updated = true;
    }

    return new Response(JSON.stringify(result), { headers: CORS });
  } catch (err: any) {
    return new Response(JSON.stringify({ success: false, error: String(err) }), { status: 500, headers: CORS });
  }
});
