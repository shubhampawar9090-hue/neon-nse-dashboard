const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const TV_WS_URL = "wss://data.tradingview.com/socket.io/websocket?&type=chart";
const CACHE_TTL = 2000;
const tvCache = new Map<string, { data: any; ts: number }>();

function getTVSymbol(sym: string): string {
  if (sym === "^NSEI") return "NSE:NIFTY";
  if (sym === "^NSEBANK") return "NSE:BANKNIFTY";
  if (sym === "^BSESN") return "BSE:SENSEX";
  if (sym.endsWith(".NS")) return "NSE:" + sym.replace(".NS", "");
  if (sym.endsWith(".BO")) return "BSE:" + sym.replace(".BO", "");
  return "NSE:" + sym;
}

function getOurSymbol(tvSym: string): string {
  if (tvSym === "NSE:NIFTY") return "^NSEI";
  if (tvSym === "NSE:BANKNIFTY") return "^NSEBANK";
  if (tvSym === "BSE:SENSEX") return "^BSESN";
  const [exchange, ticker] = tvSym.split(":");
  if (exchange === "NSE") return ticker + ".NS";
  if (exchange === "BSE") return ticker + ".BO";
  return ticker;
}

function packMessage(json: string): string {
  return `~m~${json.length}~m~${json}`;
}

function parseMessages(text: string): { m: string; p: any[]; raw: string }[] {
  const results: { m: string; p: any[]; raw: string }[] = [];
  const parts = text.split("~m~").filter(Boolean);
  for (let i = 0; i < parts.length; i += 2) {
    const raw = "~m~" + (parts[i] || "") + "~m~" + (parts[i + 1] || "");
    const jsonStr = parts[i + 1];
    if (!jsonStr) continue;
    if (jsonStr.startsWith("~h~")) continue; // heartbeat
    if (jsonStr.includes("session_id")) continue; // protocol negotiation
    try {
      const parsed = JSON.parse(jsonStr);
      if (parsed.m) results.push({ m: parsed.m, p: parsed.p || [], raw: jsonStr });
    } catch {}
  }
  return results;
}

interface TVResult {
  symbol: string;
  price: number;
  change: number;
  changePercent: number;
  previousClose: number;
  dayHigh: number;
  dayLow: number;
  open: number;
  volume: number;
  error: boolean;
  timestamp: number;
}

function emptyResult(sym: string): TVResult {
  return { symbol: sym, price: 0, change: 0, changePercent: 0, previousClose: 0, dayHigh: 0, dayLow: 0, open: 0, volume: 0, error: true, timestamp: Date.now() };
}

async function fetchFromTradingView(symbols: string[]): Promise<TVResult[]> {
  return new Promise((resolve) => {
    const results: TVResult[] = [];
    const symbolResolveMap = new Map<string, string>(); // symbol_id -> our_sym
    const seriesMap = new Map<string, string>(); // series_id -> our_sym
    let resolvedCount = 0;
    let ws: WebSocket;
    let chartId: string;
    let timeoutHandle: number;
    let closed = false;
    let protocolReady = false;

    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearTimeout(timeoutHandle);
      try { ws.close(); } catch {}
    };

    const finish = () => {
      cleanup();
      // Fill any unresolved symbols with errors
      symbols.forEach(sym => {
        if (!results.find(r => r.symbol === sym)) {
          results.push(emptyResult(sym));
        }
      });
      resolve(results);
    };

    timeoutHandle = setTimeout(() => {
      console.error("TV: timeout after 10s");
      finish();
    }, 10000);

    try {
      ws = new WebSocket(TV_WS_URL);
    } catch (e) {
      console.error("TV: WebSocket init failed", e);
      symbols.forEach(sym => results.push(emptyResult(sym)));
      resolve(results);
      return;
    }

    ws.onopen = () => {
      console.log("TV: WebSocket connected, waiting for protocol...");
    };

    ws.onmessage = (event: MessageEvent) => {
      const text = String(event.data);

      // Handle heartbeat
      if (text.includes("~h~")) {
        const m = text.match(/~m~(\d+)~m~~h~(\d+)/);
        if (m) ws.send(`~m~${m[1]}~m~~h~${m[2]}`);
        return;
      }

      // Handle protocol negotiation (session_id message)
      if (text.includes("session_id") && !protocolReady) {
        protocolReady = true;
        console.log("TV: Protocol established, sending auth...");

        // Set auth token (unauthorized = free data)
        ws.send(packMessage(JSON.stringify({ m: "set_auth_token", p: ["unauthorized_user_token"] })));
        ws.send(packMessage(JSON.stringify({ m: "set_locale", p: ["en", "US"] })));

        // Create chart session
        chartId = "chart_" + Date.now();
        ws.send(packMessage(JSON.stringify({ m: "chart_create_session", p: [chartId] })));

        // Resolve all symbols
        symbols.forEach((sym, i) => {
          const tvSym = getTVSymbol(sym);
          const symId = "sym_" + i;
          symbolResolveMap.set(symId, sym);
          // The resolve_symbol command: [chart_id, symbol_id, "NSE:RELIANCE"]
          ws.send(packMessage(JSON.stringify({
            m: "resolve_symbol",
            p: [chartId, symId, tvSym]
          })));
        });
        return;
      }

      // Parse regular messages
      const messages = parseMessages(text);
      for (const msg of messages) {
        const { m: method, p: params } = msg;

        if (method === "resolve_symbol") {
          // Symbol resolved. params = [chart_id, symbol_id, symbol_info]
          const symId = params[1];
          const ourSym = symbolResolveMap.get(symId);
          if (!ourSym) continue;

          // Create a series for this symbol (daily timeframe, 5 bars)
          const serId = "ser_" + symId;
          seriesMap.set(serId, ourSym);
          ws.send(packMessage(JSON.stringify({
            m: "create_series",
            p: [chartId, serId, serId, symId, "1D", 5, ""]
          })));
        }

        if (method === "create_series") {
          // Series created. params = [chart_id, series_id, update_mode, turnaround_id, info]
          // Wait for data via du or timescale_update events
        }

        if (method === "du" || method === "timescale_update") {
          // Data update. params = [chart_id, { series_id: { s: [{ v: [ts, o, h, l, c, vol] }] } }]
          if (!Array.isArray(params) || params[0] !== chartId) continue;
          const seriesData = params[1];
          if (!seriesData || typeof seriesData !== 'object') continue;

          for (const [serId, data] of Object.entries(seriesData as Record<string, any>)) {
            const ourSym = seriesMap.get(serId);
            if (!ourSym) continue;
            if (results.find(r => r.symbol === ourSym)) continue; // already got data

            const bars = data.s || data.ohlc || [];
            if (!Array.isArray(bars) || bars.length === 0) continue;

            // Each bar: { v: [timestamp, open, high, low, close, volume] }
            const values = bars.map((b: any) => b.v || b).filter((v: any) => Array.isArray(v));
            if (values.length === 0) continue;

            const lastBar = values[values.length - 1];
            const prevBar = values.length > 1 ? values[values.length - 2] : lastBar;

            const price = lastBar[4] || lastBar[1] || 0;
            const open = lastBar[1] || price;
            const high = lastBar[2] || price;
            const low = lastBar[3] || price;
            const volume = lastBar[5] || 0;
            const prevClose = prevBar[4] || prevBar[1] || price;

            const change = price - prevClose;
            const changePercent = prevClose ? (change / prevClose) * 100 : 0;

            const result: TVResult = {
              symbol: ourSym,
              price: Math.round(price * 100) / 100,
              change: Math.round(change * 100) / 100,
              changePercent: Math.round(changePercent * 100) / 100,
              previousClose: prevClose,
              dayHigh: high,
              dayLow: low,
              open: open,
              volume: volume,
              error: price === 0,
              timestamp: Date.now(),
            };

            tvCache.set(ourSym, { data: result, ts: Date.now() });
            results.push(result);
            resolvedCount++;

            if (resolvedCount === symbols.length) {
              finish();
            }
          }
        }

        if (method === "protocol_error" || method === "series_error") {
          console.error("TV: error", method, params);
        }

        if (method === "symbol_error") {
          // params = [chart_id, symbol_id, error_msg, time]
          const symId = params[1];
          const ourSym = symbolResolveMap.get(symId);
          if (ourSym && !results.find(r => r.symbol === ourSym)) {
            results.push(emptyResult(ourSym));
            resolvedCount++;
            if (resolvedCount === symbols.length) finish();
          }
        }
      }
    };

    ws.onerror = (e: Event) => {
      console.error("TV: WebSocket error");
      finish();
    };

    ws.onclose = () => {
      if (!closed) finish();
    };
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = await req.json();
    const symbols: string[] = body.symbols || [];
    if (!symbols.length) return Response.json({ success: false, error: "No symbols" }, { headers: corsHeaders });

    // Check cache first
    const results: any[] = [];
    const uncached: string[] = [];
    for (const sym of symbols) {
      const cached = tvCache.get(sym);
      if (cached && Date.now() - cached.ts < CACHE_TTL) {
        results.push(cached.data);
      } else {
        uncached.push(sym);
      }
    }

    if (uncached.length > 0) {
      console.log(`TV: Fetching ${uncached.length} uncached symbols`);
      const tvResults = await fetchFromTradingView(uncached);
      results.push(...tvResults);
    }

    return Response.json({
      success: true,
      data: results,
      count: results.length,
      source: "tradingview",
      tick: Date.now(),
    }, {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e: any) {
    return Response.json({ success: false, error: e.message, source: "tradingview" }, {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
