// tv-movers-stream — per-minute live quotes for the TOP 50 movers (25 gainers + 25 losers).
// Complements save-tv-ticks (full market, 5-min): this one refreshes only the
// names that are actually moving, every minute, via TradingView's scanner API.
// Cron fires it every minute during market hours; self-guards outside
// 09:15-15:30 IST Mon-Fri.
const SB = Deno.env.get('SUPABASE_URL') || 'https://jqmhcalsabexjjiceoux.supabase.co';
const SB_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const MOVERS = 25;

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
}
const sbh = () => ({ 'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' });

function marketOpen(): boolean {
  const now = new Date(Date.now() + 5.5 * 3600 * 1000); // IST
  const day = now.getUTCDay();
  if (day === 0 || day === 6) return false;
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes();
  return mins >= 555 && mins <= 930; // 09:15 - 15:30 IST
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: { 'Access-Control-Allow-Origin': '*' } });
  try {
    if (!marketOpen()) return json({ success: true, skipped: 'market closed', saved: 0 });

    // Pick movers from the freshest full-market snapshot (save-tv-ticks, <=5 min old)
    const since = new Date(Date.now() - 6 * 60 * 1000).toISOString();
    const base = `${SB}/rest/v1/stock_ticks?tick_time=gte.${since}&change_pct=not.is.null&select=symbol,change_pct`;
    const [gRes, lRes] = await Promise.all([
      fetch(`${base}&order=change_pct.desc&limit=${MOVERS}`, { headers: sbh() }),
      fetch(`${base}&order=change_pct.asc&limit=${MOVERS}`, { headers: sbh() }),
    ]);
    const gainers: any[] = await gRes.json();
    const losers: any[] = await lRes.json();
    const symbols = [...new Set([...(gainers || []), ...(losers || [])].map(r => r.symbol))].filter(Boolean);
    if (symbols.length === 0) return json({ success: true, skipped: 'no recent snapshot', saved: 0 });

    // Live quotes from TradingView scanner (single batch)
    const tickers = symbols.map(s => s.includes(':') ? s : `NSE:${s}`);
    const tvToOrig = new Map(tickers.map((t, i) => [t, symbols[i]]));
    const res = await fetch('https://scanner.tradingview.com/india/scan', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        symbols: { tickers, query: { types: [] } },
        columns: ['close', 'change', 'change_abs', 'volume', 'high', 'low', 'open'],
      }),
    });
    if (!res.ok) return json({ success: false, error: `TV scanner HTTP ${res.status}` }, 502);
    const scan: any = await res.json();

    const nowIso = new Date().toISOString();
    const rows: any[] = [];
    for (const item of scan?.data || []) {
      const d = item.d;
      if (!d || d.length < 7) continue;
      const sym = tvToOrig.get(item.s);
      if (!sym) continue;
      rows.push({
        symbol: sym,
        price: Math.round(d[0] * 100) / 100,
        change_pct: Math.round(d[1] * 100) / 100,
        change_abs: Math.round(d[2] * 100) / 100,
        volume: d[3],
        day_high: Math.round(d[4] * 100) / 100,
        day_low: Math.round(d[5] * 100) / 100,
        day_open: Math.round(d[6] * 100) / 100,
        tick_time: nowIso, created_at: nowIso,
      });
    }

    let saved = 0;
    if (rows.length > 0) {
      const ins = await fetch(`${SB}/rest/v1/stock_ticks`, {
        method: 'POST', headers: { ...sbh(), 'Prefer': 'return=minimal' }, body: JSON.stringify(rows),
      });
      if (ins.ok) saved = rows.length;
    }

    return json({ success: true, movers: symbols.length, saved, topGainer: (gainers || [])[0] || null, topLoser: (losers || [])[0] || null });
  } catch (e) {
    return json({ success: false, error: String(e) }, 500);
  }
});
