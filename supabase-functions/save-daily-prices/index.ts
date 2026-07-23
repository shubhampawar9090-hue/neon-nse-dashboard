const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const SUPABASE_URL = "https://vpjbjzrcbxgdrfjbyfiu.supabase.co";
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

function getISTDate(): string {
  // Get current date in IST (UTC+5:30)
  const now = new Date();
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  const ist = new Date(utc + 5.5 * 3600000);
  return ist.toISOString().split("T")[0]; // YYYY-MM-DD
}

async function fetchSymbols(): Promise<string[]> {
  const allSymbols: string[] = [];
  let offset = 0;
  const pageSize = 1000;
  
  while (true) {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/nse_symbols?select=symbol&is_active=eq.true&order=symbol&limit=${pageSize}&offset=${offset}`,
      {
        headers: {
          "apikey": SUPABASE_SERVICE_KEY,
          "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}`,
        },
      }
    );
    if (!res.ok) throw new Error(`Failed to fetch symbols: ${res.status}`);
    const rows = await res.json();
    allSymbols.push(...rows.map((r: { symbol: string }) => r.symbol));
    if (rows.length < pageSize) break;
    offset += pageSize;
  }
  return allSymbols;
}

async function fetchBatchQuotes(symbols: string[]): Promise<any[]> {
  // Fetch chart data for a batch of symbols from Yahoo Finance
  const results: any[] = [];
  
  await Promise.all(symbols.map(async (sym) => {
    try {
      const yahooSym = `${sym}.NS`;
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${yahooSym}?interval=1d&range=5d`;
      const res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0" },
        signal: AbortSignal.timeout(8000),
      });
      
      if (!res.ok) return;
      
      let j;
      try {
        j = await res.json();
      } catch (jsonErr) {
        // Handle json parse error (e.g. empty response from rate limiting)
        return;
      }
      
      const result = j.chart?.result?.[0];
      if (!result) return;
      
      const meta = result.meta;
      const price = meta.regularMarketPrice;
      
      // Get OHLC from candles — use candle data for accurate close/prev_close
      const timestamps = result.timestamp || [];
      const quotes = result.indicators?.quote?.[0] || {};
      const closes = (quotes.close || []).filter((v: number | null) => v != null);
      const opens = (quotes.open || []).filter((v: number | null) => v != null);
      const highs = (quotes.high || []).filter((v: number | null) => v != null);
      const lows = (quotes.low || []).filter((v: number | null) => v != null);
      const volumes = (quotes.volume || []).filter((v: number | null) => v != null);
      
      // Use second-to-last candle's close as previous close (yesterday's actual close)
      // chartPreviousClose gives the close BEFORE the range start, NOT yesterday's close
      const prevClose = closes.length >= 2 
        ? closes[closes.length - 2] 
        : (meta.chartPreviousClose || price);
      
      // Use the last candle's close if available (more reliable than regularMarketPrice
      // which can be a stale cached value), fallback to regularMarketPrice
      const closePrice = closes.length >= 1 ? closes[closes.length - 1] : price;
      const openPrice = opens.length >= 1 ? opens[opens.length - 1] : (meta.regularMarketOpen || closePrice);
      const highPrice = highs.length >= 1 ? highs[highs.length - 1] : (meta.regularMarketDayHigh || closePrice);
      const lowPrice = lows.length >= 1 ? lows[lows.length - 1] : (meta.regularMarketDayLow || closePrice);
      const volume = volumes.length >= 1 ? volumes[volumes.length - 1] : (meta.regularMarketVolume || null);
      
      const change = closePrice - prevClose;
      const changePercent = prevClose ? (change / prevClose) * 100 : 0;
      
      results.push({
        symbol: sym,
        open: openPrice,
        high: highPrice,
        low: lowPrice,
        close: closePrice,
        prev_close: prevClose,
        change_val: parseFloat(change.toFixed(2)),
        change_percent: parseFloat(changePercent.toFixed(2)),
        volume: volume,
        turnover: null,
        series: "EQ",
      });
    } catch (e) {
      // Skip failed symbols silently
    }
  }));
  
  return results;
}

async function fetchTVQuotes(symbols: string[]): Promise<any[]> {
  const tickers = symbols.map(sym => `NSE:${sym}`);
  const url = "https://scanner.tradingview.com/india/scan";
  
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0",
      },
      body: JSON.stringify({
        symbols: {
          tickers: tickers,
          query: { types: [] }
        },
        columns: ["close", "change", "change_abs", "volume", "high", "low", "open"]
      }),
      signal: AbortSignal.timeout(10000),
    });
    
    if (!res.ok) {
      console.error(`TradingView fetch failed: ${res.status}`);
      return [];
    }
    
    const j = await res.json();
    const data = j.data || [];
    const results: any[] = [];
    
    for (const item of data) {
      if (!item || !item.s || !Array.isArray(item.d)) continue;
      
      const s = item.s;
      const symbol = s.startsWith("NSE:") ? s.substring(4) : s;
      const [close, change_pct, change_abs, volume, high, low, open] = item.d;
      
      if (typeof close !== "number") continue;
      
      const prevClose = typeof change_abs === "number" ? close - change_abs : close;
      
      results.push({
        symbol: symbol,
        open: typeof open === "number" ? open : close,
        high: typeof high === "number" ? high : close,
        low: typeof low === "number" ? low : close,
        close: close,
        prev_close: prevClose,
        change_val: typeof change_abs === "number" ? parseFloat(change_abs.toFixed(2)) : 0,
        change_percent: typeof change_pct === "number" ? parseFloat(change_pct.toFixed(2)) : 0,
        volume: typeof volume === "number" ? volume : null,
        turnover: null,
        series: "EQ",
      });
    }
    
    return results;
  } catch (e) {
    console.error(`TradingView fetch error: ${e.message}`);
    return [];
  }
}

async function upsertPrices(records: any[], tradeDate: string): Promise<number> {
  if (records.length === 0) return 0;
  
  // Prepare records with trade_date
  const data = records.map(r => ({
    ...r,
    trade_date: tradeDate,
  }));
  
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/stock_daily_prices?on_conflict=symbol,trade_date`,
    {
      method: "POST",
      headers: {
        "apikey": SUPABASE_SERVICE_KEY,
        "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}`,
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates",
      },
      body: JSON.stringify(data),
    }
  );
  
  if (!res.ok) {
    console.error(`Upsert failed: ${res.status} - ${await res.text()}`);
    return 0;
  }
  
  return data.length;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  
  const startTime = Date.now();
  
  try {
    // 1. Fetch all active symbols
    console.log("Fetching symbols from database...");
    const allSymbols = await fetchSymbols();
    console.log(`Got ${allSymbols.length} symbols`);
    
    // 2. Process in batches of 30 (to avoid overwhelming Yahoo Finance)
    const batchSize = 30;
    let yahooSavedCount = 0;
    const succeededSymbols = new Set<string>();
    const tradeDate = getISTDate();
    console.log(`Trade date: ${tradeDate}`);
    
    for (let i = 0; i < allSymbols.length; i += batchSize) {
      const batch = allSymbols.slice(i, i + batchSize);
      const batchNum = Math.floor(i / batchSize) + 1;
      const totalBatches = Math.ceil(allSymbols.length / batchSize);
      
      console.log(`Processing batch ${batchNum}/${totalBatches} (${batch.length} symbols)...`);
      
      try {
        const results = await fetchBatchQuotes(batch);
        const saved = await upsertPrices(results, tradeDate);
        if (saved > 0) {
          results.forEach(r => succeededSymbols.add(r.symbol));
          yahooSavedCount += saved;
        }
      } catch (e) {
        console.error(`Batch ${batchNum} error: ${e.message}`);
      }
      
      // Small delay between batches to be gentle on Yahoo Finance
      if (i + batchSize < allSymbols.length) {
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }
    
    // 3. Collect failed symbols for TradingView scanner fallback
    const failedSymbols = allSymbols.filter(sym => !succeededSymbols.has(sym));
    console.log(`Yahoo attempt done. Succeeded: ${yahooSavedCount}, Failed: ${failedSymbols.length}`);
    
    let tvSavedCount = 0;
    if (failedSymbols.length > 0) {
      console.log(`Starting TradingView fallback for ${failedSymbols.length} failed symbols...`);
      const tvBatchSize = 100;
      
      for (let i = 0; i < failedSymbols.length; i += tvBatchSize) {
        const batch = failedSymbols.slice(i, i + tvBatchSize);
        const batchNum = Math.floor(i / tvBatchSize) + 1;
        const totalBatches = Math.ceil(failedSymbols.length / tvBatchSize);
        
        console.log(`Processing TradingView batch ${batchNum}/${totalBatches} (${batch.length} symbols)...`);
        
        try {
          const results = await fetchTVQuotes(batch);
          const saved = await upsertPrices(results, tradeDate);
          if (saved > 0) {
            results.forEach(r => succeededSymbols.add(r.symbol));
            tvSavedCount += saved;
          }
        } catch (e) {
          console.error(`TradingView batch ${batchNum} error: ${e.message}`);
        }
        
        // Small delay between TradingView batches
        if (i + tvBatchSize < failedSymbols.length) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
    }
    
    const totalFailed = allSymbols.length - succeededSymbols.size;
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const totalSaved = yahooSavedCount + tvSavedCount;
    
    return new Response(JSON.stringify({
      success: true,
      message: `Daily prices saved: ${totalSaved} symbols (Yahoo: ${yahooSavedCount}, TradingView: ${tvSavedCount}), ${totalFailed} failed`,
      data: {
        trade_date: tradeDate,
        total_symbols: allSymbols.length,
        saved_yahoo: yahooSavedCount,
        saved_tradingview: tvSavedCount,
        total_saved: totalSaved,
        failed: totalFailed,
        elapsed_seconds: parseFloat(elapsed),
      }
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    
  } catch (e) {
    return new Response(JSON.stringify({
      success: false,
      error: e.message,
    }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});