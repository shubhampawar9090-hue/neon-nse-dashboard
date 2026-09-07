// ws-tick-stream — per-second live LTP capture for open option positions.
// Connects to MegaBull WebSocket, samples LTP every second for SAMPLE_SECONDS,
// batch-saves ticks to stock_ticks and refreshes ai_trades live price / peak /
// trailing stop. Cron fires it every minute during market hours; the function
// self-guards outside 09:15-15:30 IST Mon-Fri.
const SB = Deno.env.get('SUPABASE_URL') || 'https://jqmhcalsabexjjiceoux.supabase.co';
const SB_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const MEGA_WS = 'wss://socket.megabull.in';
const SAMPLE_SECONDS = 50;

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

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function loadJwt(): Promise<string | null> {
  try {
    const r = await fetch(`${SB}/functions/v1/get-mega-jwt`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const j: any = await r.json();
    if (j?.token) return j.token;
  } catch {}
  try {
    const r = await fetch(`${SB}/rest/v1/ai_agent_config?select=mega_bull_jwt&limit=1`, { headers: sbh() });
    const rows: any[] = await r.json();
    return rows?.[0]?.mega_bull_jwt || null;
  } catch { return null; }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: { 'Access-Control-Allow-Origin': '*' } });
  try {
    if (!marketOpen()) return json({ success: true, skipped: 'market closed', samples: 0 });

    const tr = await fetch(`${SB}/rest/v1/ai_trades?execution_status=eq.OPEN&qty=gt.0&select=id,symbol,instrument_token,peak_ltp,entry_price`, { headers: sbh() });
    const trades: any[] = await tr.json();
    if (!trades || trades.length === 0) return json({ success: true, skipped: 'no open positions', samples: 0 });

    const jwt = await loadJwt();
    if (!jwt) return json({ success: false, error: 'no JWT available' }, 500);

    // Connect WS and collect streaming LTPs into a per-token ring of {ts, ltp}
    const tokens = trades.map(t => String(t.instrument_token));
    const samples: Record<string, { ts: number; ltp: number }[]> = {};
    for (const t of tokens) samples[t] = [];

    const ws = new WebSocket(`${MEGA_WS}?id=${jwt}`);
    const wsReady = new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error('WS connect failed'));
      setTimeout(() => reject(new Error('WS connect timeout')), 8000);
    });
    await wsReady;
    ws.send(JSON.stringify({ type: 'SUBSCRIBE', data: tokens }));

    let latest: Record<string, number> = {};
    ws.onmessage = (ev) => {
      try {
        const d = JSON.parse(ev.data);
        if (d && d.TYPE === 'ORDER_UPDATE') return;
        for (const k of Object.keys(d || {})) {
          if (/^\d+$/.test(k)) {
            const p = parseFloat(d[k]);
            if (!isNaN(p) && p > 0) latest[k] = p;
          }
        }
      } catch {}
    };

    // Sample once per second
    const started = Date.now();
    for (let i = 0; i < SAMPLE_SECONDS; i++) {
      await sleep(1000);
      const ts = Date.now();
      for (const t of tokens) {
        const p = latest[t];
        if (p) samples[t].push({ ts, ltp: Math.round(p * 100) / 100 });
      }
    }
    try { ws.close(); } catch {}

    // Batch-save ticks to stock_ticks
    const rows: any[] = [];
    for (const t of tokens) {
      const trade = trades.find(x => String(x.instrument_token) === t);
      for (const s of samples[t]) {
        rows.push({ symbol: trade.symbol, price: s.ltp, tick_time: new Date(s.ts).toISOString(), created_at: new Date(s.ts).toISOString() });
      }
    }
    let saved = 0;
    if (rows.length > 0) {
      const ins = await fetch(`${SB}/rest/v1/stock_ticks`, { method: 'POST', headers: { ...sbh(), 'Prefer': 'return=minimal' }, body: JSON.stringify(rows) });
      if (ins.ok) saved = rows.length;
    }

    // Refresh live price / peak / trailing per position (last sample wins)
    const updates: any[] = [];
    for (const t of tokens) {
      const s = samples[t];
      if (!s.length) continue;
      const trade = trades.find(x => String(x.instrument_token) === t);
      const last = s[s.length - 1].ltp;
      const peak = Math.max(Number(trade.peak_ltp) || Number(trade.entry_price), ...s.map(x => x.ltp));
      updates.push(fetch(`${SB}/rest/v1/ai_trades?id=eq.${trade.id}`, {
        method: 'PATCH', headers: { ...sbh(), 'Prefer': 'return=minimal' },
        body: JSON.stringify({ price: last, peak_ltp: peak, trailing_stop: Math.round(peak * 0.85 * 100) / 100 }),
      }));
    }
    await Promise.all(updates);

    return json({
      success: true, tokens, symbols: trades.map(t => t.symbol),
      samples: Object.values(samples).reduce((a: number, b: any) => a + b.length, 0),
      saved, durationS: Math.round((Date.now() - started) / 1000),
    });
  } catch (e) {
    return json({ success: false, error: String(e) }, 500);
  }
});
