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


async function fetchChartData(sym: string, interval: string = "1m", range: string = "1d") {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=${interval}&range=${range}`;
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) return { symbol: sym, error: true, chart: null };
    
    let j;
    try { j = await res.json(); } catch { return { symbol: sym, error: true, chart: null }; }
    
    const result = j.chart?.result?.[0];
    if (!result) return { symbol: sym, error: true, chart: null };
    
    const meta = result.meta;
    const timestamps = result.timestamp || [];
    const quotes = result.indicators?.quote?.[0] || {};
    
    const candles = [];
    for (let i = 0; i < timestamps.length; i++) {
      if (quotes.close?.[i] != null) {
        candles.push({
          t: timestamps[i],
          o: quotes.open?.[i] || 0,
          h: quotes.high?.[i] || 0,
          l: quotes.low?.[i] || 0,
          c: quotes.close?.[i] || 0,
          v: quotes.volume?.[i] || 0,
        });
      }
    }
    
    return {
      symbol: sym,
      error: false,
      chart: {
        meta: {
          regularMarketPrice: meta.regularMarketPrice,
          chartPreviousClose: meta.chartPreviousClose,
          regularMarketOpen: meta.regularMarketOpen,
          regularMarketDayHigh: meta.regularMarketDayHigh,
          regularMarketDayLow: meta.regularMarketDayLow,
          fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh,
          fiftyTwoWeekLow: meta.fiftyTwoWeekLow,
          currency: meta.currency,
          exchangeName: meta.exchangeName,
        },
        candles: candles,
      },
    };
  } catch {
    return { symbol: sym, error: true, chart: null };
  }
}

// TradingView fallback for chart data — uses scanner API for current OHLC + stock_ticks DB for history
async function fetchChartDataFromTV(sym: string, interval: string = "1m", range: string = "1d"): Promise<any> {
  try {
    const tvSym = toTradingViewSymbol(sym);
    
    // 1. Get current snapshot from TradingView scanner
    const scanRes = await fetch("https://scanner.tradingview.com/india/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        symbols: { tickers: [tvSym], query: { types: [] } },
        columns: ["close", "change", "change_abs", "volume", "high", "low", "open", "Recommend.All"],
      }),
    });
    
    if (!scanRes.ok) return { symbol: sym, error: true, chart: null };
    
    const scanJson = await scanRes.json();
    const item = scanJson.data?.[0];
    if (!item || !item.d || item.d.length < 7) return { symbol: sym, error: true, chart: null };
    
    const d = item.d;
    const price = d[0] || 0;
    const changePct = d[1] || 0;
    const changeAbs = d[2] || 0;
    const volume = d[3] || 0;
    const dayHigh = d[4] || price;
    const dayLow = d[5] || price;
    const open = d[6] || price;
    const prevClose = price - changeAbs;
    
    if (price === 0) return { symbol: sym, error: true, chart: null };
    
    // 2. Try to get intraday ticks from stock_ticks table via Supabase REST
    let candles: any[] = [];
    try {
      const supabaseUrl = Deno.env.get("SUPABASE_URL") || "https://mmxkisgdoepojotignkg.supabase.co";
      const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
      const tickRes = await fetch(
        `${supabaseUrl}/rest/v1/stock_ticks?symbol=eq.${encodeURIComponent(sym)}&order=tick_time.desc&limit=300`,
        { headers: { "apikey": serviceKey, "Authorization": `Bearer ${serviceKey}` } }
      );
      if (tickRes.ok) {
        const ticks = await tickRes.json();
        if (Array.isArray(ticks) && ticks.length > 0) {
          // Convert ticks to candles (reverse to chronological order)
          const sorted = ticks.reverse();
          for (const t of sorted) {
            const p = t.price || 0;
            candles.push({
              t: Math.floor(new Date(t.tick_time).getTime() / 1000),
              o: p,
              h: p,
              l: p,
              c: p,
              v: t.volume || 0,
            });
          }
        }
      }
    } catch (e) {
      console.log("TV chart: stock_ticks fetch failed", e.message);
    }
    
    // 3. If no tick history, build a simple candle from current snapshot
    if (candles.length === 0) {
      const now = Math.floor(Date.now() / 1000);
      candles.push({
        t: now - 60,
        o: open, h: Math.max(open, price), l: Math.min(open, price), c: price, v: volume,
      });
      candles.push({
        t: now,
        o: price, h: dayHigh, l: dayLow, c: price, v: volume,
      });
    }
    
    return {
      symbol: sym,
      error: false,
      chart: {
        meta: {
          regularMarketPrice: price,
          chartPreviousClose: prevClose,
          regularMarketOpen: open,
          regularMarketDayHigh: dayHigh,
          regularMarketDayLow: dayLow,
          fiftyTwoWeekHigh: 0,
          fiftyTwoWeekLow: 0,
          currency: "INR",
          exchangeName: "NSE",
        },
        candles: candles,
        source: "tradingview",
      },
    };
  } catch (e) {
    console.log("TV chart fallback error:", e.message);
    return { symbol: sym, error: true, chart: null };
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = await req.json();
    const symbols: string[] = body.symbols || [];
    
    // Chart mode: return full intraday candle data for charting
    // Try Yahoo Finance first, auto-fallback to TradingView if Yahoo fails
    if (body.chart && symbols.length > 0) {
      const interval = body.interval || "1m";
      const range = body.range || "1d";
      let chartResult = await fetchChartData(symbols[0], interval, range);
      let source = "yahoo";
      
      if (chartResult.error || !chartResult.chart) {
        console.log(`Chart: Yahoo failed for ${symbols[0]}, trying TradingView fallback...`);
        chartResult = await fetchChartDataFromTV(symbols[0], interval, range);
        source = "tradingview";
      }
      
      return Response.json({ 
        success: !chartResult.error, 
        data: chartResult,
        source: source,
      }, {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    
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
