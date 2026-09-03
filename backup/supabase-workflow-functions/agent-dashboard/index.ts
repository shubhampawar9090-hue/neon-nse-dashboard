// agent-dashboard: PUBLIC read-only endpoint that feeds the dashboard's AI AGENT panel.
// Auth: Supabase gateway JWT (verify_jwt=true — the browser sends the anon key).
// Internally calls megabull-agent (full_scan) with the CRON_SECRET service key and
// merges in the recent ai_trades log from Postgres. No secrets leak to the client.

const SB = Deno.env.get('SUPABASE_URL') || 'https://jqmhcalsabexjjiceoux.supabase.co';
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const CRON_SECRET = Deno.env.get('CRON_SECRET') || '';

const CORS: Record<string, string> = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: CORS });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  try {
    // 1) Run the AI agent's full market scan on MegaBull data (server-to-server)
    const scanRes = await fetch(`${SB}/functions/v1/megabull-agent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-cron-key': CRON_SECRET },
      body: JSON.stringify({ action: 'full_scan' }),
    }).catch(() => null);
    const scan = scanRes && scanRes.ok ? await scanRes.json().catch(() => null) : null;

    if (!scan || !scan.success) {
      return json({ success: false, error: scan?.error || 'Agent scan unavailable' }, 502);
    }

    // 2) Recent AI trade log (last 12 actions recorded by trading-agent / position-monitor)
    let recentTrades: any[] = [];
    try {
      const tRes = await fetch(
        `${SB}/rest/v1/ai_trades?select=id,created_date,symbol,action,qty,price,entry_price,peak_ltp,execution_status,reason,signal,buy_score,sell_score&order=created_date.desc&limit=12`,
        { headers: { 'apikey': SERVICE, 'Authorization': `Bearer ${SERVICE}` } }
      );
      if (tRes.ok) recentTrades = await tRes.json();
    } catch { /* non-fatal */ }

    // 3) Trim the payload for the browser
    const idx = (scan.indexAnalysis || {});
    const stripIdx = (arr: any[]) => (arr || []).map((s: any) => ({
      symbol: s.symbol, price: s.price, changePercent: s.changePercent,
      signal: s.signal, buyScore: s.buyScore, sellScore: s.sellScore,
      rsi: s.rsi, trend: s.trend, atr: s.atr, support: s.support, resistance: s.resistance,
      sl: s.sl, tp1: s.tp1, tp2: s.tp2, tp3: s.tp3, positionSize: s.positionSize,
    }));

    const optionSignals = (scan.optionSignals || []).map((o: any) => ({
      index: o.index, underlying: o.underlying, indexLevel: o.indexLevel,
      signal: o.signal, buyScore: o.buyScore, sellScore: o.sellScore,
      recommendation: o.recommendation, reason: o.reason, expiry: o.expiry,
      // ATM pick (same object the trading agent would act on)
      atm: o.atm ? {
        tradingSymbol: o.atm.tradingSymbol || o.atm.symbol, strike: o.atm.strike,
        type: o.atm.type, premium: o.atm.theoreticalPremium ?? o.atm.premium,
        delta: o.atm.delta, theta: o.atm.theta,
      } : null,
    }));

    return json({
      success: true,
      timestamp: Date.now(),
      capital: scan.capital || { total: 0, blocked: 0, available: 0 },
      positions: (scan.positions || []).filter((p: any) => p.qty > 0).map((p: any) => ({
        tradingSymbol: p.tradingSymbol, qty: p.qty, avgPrice: p.avgPrice ?? p.price,
        ltp: p.ltp, pnl: p.pnl,
      })),
      indices: { swing: stripIdx(idx.swing), scalp: stripIdx(idx.scalp) },
      vix: scan.vix ?? null,
      marketBreadth: scan.marketBreadth ?? null,
      optionSignals,
      recentTrades,
    });
  } catch (e) {
    return json({ success: false, error: String(e) }, 500);
  }
});
