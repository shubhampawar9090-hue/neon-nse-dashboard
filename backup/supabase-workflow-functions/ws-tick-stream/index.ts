// ws-tick-stream v2 — per-second live LTP capture + PER-SECOND EXIT MONITOR.
// Connects to MegaBull WebSocket, samples LTP every second for SAMPLE_SECONDS.
// Each second: saves tick snapshots, refreshes ai_trades price/peak/trailing,
// and evaluates the full exit rule set (trailing 15%, initial SL, TP2/TP3,
// hard -30%). On an exit signal it fires position-monitor which executes the
// virtual fill, ledger credit and notification. Cron fires every minute
// during market hours; self-guards outside 09:15-15:30 IST Mon-Fri.
const SB = Deno.env.get('SUPABASE_URL') || 'https://jqmhcalsabexjjiceoux.supabase.co';
const SB_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const MEGA_WS = 'wss://socket.megabull.in';
const CRON_KEY = 'BM1w_fZMvitL8MJDe6YqM7l8yKMpRHAhpdN_2PR3cOc';
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

    const tr = await fetch(`${SB}/rest/v1/ai_trades?execution_status=eq.OPEN&qty=gt.0&select=id,symbol,instrument_token,peak_ltp,entry_price,qty,sl,tp1,tp2,tp3,trailing_stop`, { headers: sbh() });
    const trades: any[] = await tr.json();
    if (!trades || trades.length === 0) return json({ success: true, skipped: 'no open positions', samples: 0 });

    const jwt = await loadJwt();
    if (!jwt) return json({ success: false, error: 'no JWT available' }, 500);

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

    // Per-second sampling + per-second exit monitoring
    let active: any[] = [...trades];
    const exitSignals: any[] = [];
    const downBreach: Record<string, number> = {}; // consecutive downside-breach seconds per token
    const started = Date.now();
    for (let i = 0; i < SAMPLE_SECONDS; i++) {
      await sleep(1000);
      const ts = Date.now();
      for (const t of tokens) {
        const p = latest[t];
        if (p && active.some(x => String(x.instrument_token) === t)) {
          samples[t].push({ ts, ltp: Math.round(p * 100) / 100 });
        }
      }
      // ---- EXIT RULES: evaluated EVERY SECOND ----
      for (const trade of [...active]) {
        const t = String(trade.instrument_token);
        const ltp = latest[t];
        if (!ltp) continue;
        const entry = Number(trade.entry_price);
        const peak = Math.max(Number(trade.peak_ltp) || entry, ...samples[t].map(x => x.ltp), ltp);
        const trailing = Math.round(peak * 0.85 * 100) / 100;
        const initialSL = Number(trade.sl) || entry * 0.70;
        let exit = false, reason = '';
        // TP exits fire immediately on touch (sell into the spike)
        if (trade.tp3 && ltp >= Number(trade.tp3)) { exit = true; reason = `TP3: ${ltp} >= ${trade.tp3}`; }
        else if (trade.tp2 && ltp >= Number(trade.tp2)) { exit = true; reason = `TP2: ${ltp} >= ${trade.tp2}`; }
        else {
          // Anti-whipsaw (9 Oct): downside exits (trailing/SL/hard-stop) require
          // 3 CONSECUTIVE breaching seconds — single-tick premium noise no longer
          // kicks out a position. Resets to zero on any healthy tick.
          const down = (ltp <= trailing && trailing > initialSL) || (ltp <= initialSL) || (ltp <= entry * 0.70);
          downBreach[t] = down ? (downBreach[t] || 0) + 1 : 0;
          if (down && downBreach[t] >= 3) {
            if (ltp <= trailing && trailing > initialSL) reason = `Trailing stop: LTP ${ltp} <= trailing ${trailing}`;
            else if (ltp <= initialSL) reason = `Initial SL: LTP ${ltp} <= SL ${initialSL}`;
            else reason = `Hard stop -30%: ${ltp}`;
            exit = true;
          }
        }
        if (exit) {
          exitSignals.push({ symbol: trade.symbol, ltp, reason, second: i + 1 });
          active = active.filter(x => x !== trade);
          // position-monitor executes the virtual exit fill + ledger credit + alert
          fetch(`${SB}/functions/v1/position-monitor`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-cron-key': CRON_KEY },
            body: JSON.stringify({ iterations: 1, delayMs: 0 }),
          }).catch(() => {});
        }
      }
    }
    try { ws.close(); } catch {}

    // Batch-save ticks to stock_ticks (only for still-open tokens)
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

    // Refresh live price / peak / trailing per still-open position
    const updates: any[] = [];
    for (const trade of active) {
      const t = String(trade.instrument_token);
      const s = samples[t];
      if (!s.length) continue;
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
      saved, exitSignals, durationS: Math.round((Date.now() - started) / 1000),
    });
  } catch (e) {
    return json({ success: false, error: String(e) }, 500);
  }
});
