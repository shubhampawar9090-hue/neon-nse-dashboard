// mb-idx-ltp (12 Oct 2026): server-side MegaBull index relay.
// Why: TradingView scanner lags 17-46 pts on indices; when a browser's MegaBull
// WS dies, the dashboard's TV fallback paints stale prices ("not moving, wrong
// price"). This fn signs in via get-mega-jwt, opens the MB WS, subscribes ONLY
// the 4 index tokens and returns their freshest LTPs. Client calls it ~6s when
// its own MB WS is down; MB stays primary, TV is last resort.
const SELF_BASE = 'https://jqmhcalsabexjjiceoux.supabase.co/functions/v1';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpxbWhjYWxzYWJleGpqaWNlb3V4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTkxMDU4MDEsImV4cCI6NDM5MDQxNTgwMX0.NqjpGVkr7U-uCHQqZL5GdHyjyBTutN1kt2GjNlnlNos';

const IDX_TOKENS: Record<string, string> = {
  '^NSEI': '256265',
  '^NSEBANK': '260105',
  '^INDIAVIX': '264969',
  '^BSESN': '265',
};

Deno.serve(async (req) => {
  const json = (o: unknown, code = 200) =>
    new Response(JSON.stringify(o), { status: code, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' } });

  if (req.method === 'OPTIONS') return new Response('ok', { headers: { 'Access-Control-Allow-Origin': '*' } });
  // runtime Yahoo hard-block (shared guard convention)
  const _origFetch = globalThis.fetch;
  globalThis.fetch = (input: any, init?: any) => {
    const u = String(typeof input === 'string' ? input : (input && input.url) || '');
    if (/\.yahoo\.com/i.test(u)) throw new Error('BLOCKED: Yahoo Finance feeds are prohibited');
    return _origFetch(input, init);
  };

  try {
    // 1) fresh WS-verified MegaBull JWT (heals itself)
    const jr = await _origFetch(SELF_BASE + '/get-mega-jwt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + SUPABASE_KEY },
      body: '{}',
    });
    const jw = await jr.json();
    if (!jw || !jw.token) return json({ ok: false, err: 'no-jwt' });

    // 2) open WS, subscribe indices, harvest ticks up to 5s
    const out: Record<string, number> = {};
    let got = 0;
    const ws = new WebSocket('wss://socket.megabull.in?id=' + encodeURIComponent(jw.token));
    const t0 = Date.now();
    ws.onopen = () => {
      try {
        ws.send(JSON.stringify({ type: 'SUBSCRIBE', data: Object.values(IDX_TOKENS) }));
      } catch (e) { /* ignore */ }
    };
    ws.onmessage = (ev) => {
      try {
        const d = JSON.parse(String(ev.data));
        if (d && typeof d === 'object') {
          for (const k of Object.keys(d)) {
            if (typeof d[k] === 'number') { out[k] = d[k]; got++; }
          }
        }
      } catch (e) { /* ignore */ }
    };
    ws.onerror = () => { /* surfaced via timeout */ };
    while (Date.now() - t0 < 5000 && got < 4) {
      await new Promise((r) => setTimeout(r, 150));
    }
    try { ws.close(); } catch (e) { /* ignore */ }

    const ltp: Record<string, number | null> = {};
    for (const [sym, tok] of Object.entries(IDX_TOKENS)) ltp[sym] = out[tok] ?? null;
    const any = Object.values(ltp).some((v) => v != null);
    return json({ ok: any, at: Date.now(), ms: Date.now() - t0, ltp });
  } catch (e) {
    return json({ ok: false, err: String(e && (e as Error).message || e) }, 200);
  }
});
