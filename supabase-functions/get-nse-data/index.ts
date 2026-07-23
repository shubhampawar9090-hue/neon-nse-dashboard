const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

// Server-side cache: 2-second TTL to support tick-by-tick frontend updates
// without overwhelming Yahoo Finance with redundant requests
const CACHE_TTL = 2000; // 2 seconds
const priceCache = new Map<string, { data: any; ts: number }>();

function toTradingViewSymbol(sym: string): string {
  const upper = sym.toUpperCase().trim();
  if (upper === "^NSEI") return "NSE:NIFTY";
  if (upper === "^NSEBANK") return "NSE:BANKNIFTY";
  if (upper === "^BSESN") return "BSE:SENSEX";
  
  if (upper.includes(":")) return upper;

  if (upper.endsWith(".NS")) {
    return `NSE:${upper.slice(0, -3)}`;
  }
  if (upper.endsWith(".BO")) {
    return `BSE:${upper.slice(0, -3)}`;
  }

  return `NSE:${upper}`;
}

async function fetchSymbol(sym: string) {
  // Check cache first
  const cached = priceCache.get(sym);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return cached.data;
  }

  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=5d`;
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) return { symbol: sym, error: true };
    
    let j;
    try {
      j = await res.json();
    } catch {
      return { symbol: sym, error: true };
    }

    const meta = j.chart?.result?.[0]?.meta;
    if (!meta) return { symbol: sym, error: true };

    const price = meta.regularMarketPrice;
    const candles = j.chart?.result?.[0]?.indicators?.quote?.[0] || {};
    const closes = (candles.close || []).filter((v: number | null) => v != null);
    // Use second-to-last candle's close as previous close (actual yesterday's close)
    // chartPreviousClose gives the close BEFORE the range start, not yesterday's close
    const prev = closes.length >= 2 ? closes[closes.length - 2] : (meta.chartPreviousClose || price);
    const change = price - prev;
    const changePercent = prev ? (change / prev) * 100 : 0;

    const volumes = (candles.volume || []).filter((v: number | null) => v != null);
    const recentVol = volumes.slice(-5);
    const avgVol = recentVol.length ? recentVol.reduce((a: number, b: number) => a + b, 0) / recentVol.length : 0;
    const latestVol = volumes.length ? volumes[volumes.length - 1] : 0;
    const volumeRatio = avgVol ? latestVol / avgVol : 0;

    const result = {
      symbol: sym,
      price: Math.round(price * 100) / 100,
      change: Math.round(change * 100) / 100,
      changePercent: Math.round(changePercent * 100) / 100,
      volume: latestVol,
      volumeRatio: Math.round(volumeRatio * 100) / 100,
      previousClose: prev,
      dayHigh: meta.regularMarketDayHigh || price,
      dayLow: meta.regularMarketDayLow || price,
      open: meta.regularMarketOpen || price,
      fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh || 0,
      fiftyTwoWeekLow: meta.fiftyTwoWeekLow || 0,
      timestamp: Date.now(),
      error: false,
    };

    // Store in cache
    priceCache.set(sym, { data: result, ts: Date.now() });
    return result;
  } catch {
    return { symbol: sym, error: true };
  }
}

async function fetchTradingViewFallback(failedSymbols: string[]): Promise<Map<string, any>> {
  const tvToOriginal = new Map<string, string>();
  const tickers: string[] = [];
  
  for (const sym of failedSymbols) {
    const tvSym = toTradingViewSymbol(sym);
    tvToOriginal.set(tvSym, sym);
    tickers.push(tvSym);
  }

  const resultsMap = new Map<string, any>();
  const TV_BATCH = 100;

  for (let i = 0; i < tickers.length; i += TV_BATCH) {
    const batchTickers = tickers.slice(i, i + TV_BATCH);
    try {
      const res = await fetch("https://scanner.tradingview.com/india/scan", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          symbols: {
            tickers: batchTickers,
            query: { types: [] },
          },
          columns: ["close", "change", "change_abs", "volume", "high", "low", "open"],
        }),
      });

      if (!res.ok) continue;

      let json;
      try {
        json = await res.json();
      } catch {
        continue;
      }

      const data = json.data || [];
      for (const item of data) {
        const tvSym = item.s;
        const d = item.d;
        if (!d || d.length < 7) continue;

        const price = d[0];
        const changePercent = d[1];
        const change = d[2];
        const volume = d[3];
        const dayHigh = d[4];
        const dayLow = d[5];
        const open = d[6];

        const previousClose = price - change;
        const orig = tvToOriginal.get(tvSym);

        if (orig) {
          const result = {
            symbol: orig,
            price: Math.round(price * 100) / 100,
            change: Math.round(change * 100) / 100,
            changePercent: Math.round(changePercent * 100) / 100,
            volume: volume,
            volumeRatio: 0,
            previousClose: Math.round(previousClose * 100) / 100,
            dayHigh: Math.round(dayHigh * 100) / 100,
            dayLow: Math.round(dayLow * 100) / 100,
            open: Math.round(open * 100) / 100,
            fiftyTwoWeekHigh: 0,
            fiftyTwoWeekLow: 0,
            timestamp: Date.now(),
            error: false,
          };
          resultsMap.set(orig, result);
          priceCache.set(orig, { data: result, ts: Date.now() });
        }
      }
    } catch (err) {
      console.error("TradingView fetch error:", err);
    }
  }

  return resultsMap;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = await req.json();
    const symbols: string[] = body.symbols || [];
    if (!symbols.length) return Response.json({ success: false, error: "No symbols" }, { headers: corsHeaders });

    const BATCH = 40;
    const results: any[] = [];

    for (let i = 0; i < symbols.length; i += BATCH) {
      const batch = symbols.slice(i, i + BATCH);
      const batchResults = await Promise.all(batch.map(fetchSymbol));
      results.push(...batchResults);
    }

    // TradingView Fallback for any symbols that failed on Yahoo Finance
    const failedSymbols = results
      .filter((r) => r.error)
      .map((r) => r.symbol);

    if (failedSymbols.length > 0) {
      const tvResults = await fetchTradingViewFallback(failedSymbols);
      for (let i = 0; i < results.length; i++) {
        if (results[i].error) {
          const tvResult = tvResults.get(results[i].symbol);
          if (tvResult) {
            results[i] = tvResult;
          }
        }
      }
    }

    return Response.json({ 
      success: true, 
      data: results, 
      count: results.length,
      tick: Date.now(),
    }, {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e: any) {
    return Response.json({ success: false, error: e.message }, {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
