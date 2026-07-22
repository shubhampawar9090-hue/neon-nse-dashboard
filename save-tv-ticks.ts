// save-tv-ticks: Fetch all NSE stocks from TradingView scanner API and store tick snapshots
// Uses direct REST API calls instead of Supabase JS client for reliability

const SUPABASE_URL = "https://vpjbjzrcbxgdrfjbyfiu.supabase.co";
const SUPABASE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const TV_SCAN_URL = "https://scanner.tradingview.com/india/scan";
const TV_COLUMNS = ["close", "change", "change_abs", "volume", "high", "low", "open"];
const BATCH_SIZE = 100;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

async function fetchSymbols(): Promise<string[]> {
  const allSymbols: string[] = [];
  let offset = 0;
  const limit = 1000;
  
  while (true) {
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/nse_symbols?select=symbol&is_active=eq.true&order=symbol&limit=${limit}&offset=${offset}`, {
      headers: {
        "apikey": SUPABASE_KEY,
        "Authorization": `Bearer ${SUPABASE_KEY}`,
      },
    });
    if (!resp.ok) throw new Error(`Failed to fetch symbols: ${resp.status}`);
    const data = await resp.json();
    if (!data || data.length === 0) break;
    allSymbols.push(...data.map((r: any) => r.symbol));
    if (data.length < limit) break;
    offset += limit;
  }
  
  return allSymbols;
}

async function fetchTvBatch(tickers: string[]): Promise<any[]> {
  const body = {
    symbols: { tickers, query: { types: [] } },
    columns: TV_COLUMNS,
  };
  
  const resp = await fetch(TV_SCAN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  
  if (!resp.ok) throw new Error(`TradingView API error: ${resp.status}`);
  const data = await resp.json();
  return data.data || [];
}

async function fetchAllTvTicks(symbols: string[]): Promise<any[]> {
  const allTicks: any[] = [];
  const batches: string[][] = [];
  
  for (let i = 0; i < symbols.length; i += BATCH_SIZE) {
    batches.push(symbols.slice(i, i + BATCH_SIZE).map(s => `NSE:${s}`));
  }
  
  // Fetch all batches in parallel (max 5 concurrent)
  const CONCURRENCY = 5;
  for (let i = 0; i < batches.length; i += CONCURRENCY) {
    const chunk = batches.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(chunk.map(b => fetchTvBatch(b)));
    
    for (const result of results) {
      if (result.status === "fulfilled") {
        for (const item of result.value) {
          const d = item.d;
          if (!d || d.length < 7) continue;
          const symbol = item.s.replace("NSE:", "").replace("BSE:", "");
          allTicks.push({
            symbol,
            price: d[0],
            change_pct: d[1],
            change_abs: d[2],
            volume: d[3],
            day_high: d[4],
            day_low: d[5],
            day_open: d[6],
            tick_time: new Date().toISOString(),
          });
        }
      }
    }
  }
  
  return allTicks;
}

async function saveTicks(ticks: any[]): Promise<number> {
  if (ticks.length === 0) return 0;
  
  const BATCH_INSERT = 500;
  let totalInserted = 0;
  
  for (let i = 0; i < ticks.length; i += BATCH_INSERT) {
    const batch = ticks.slice(i, i + BATCH_INSERT);
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/stock_ticks`, {
      method: "POST",
      headers: {
        "apikey": SUPABASE_KEY,
        "Authorization": `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json",
        "Prefer": "return=minimal",
      },
      body: JSON.stringify(batch),
    });
    
    if (!resp.ok) {
      console.error(`Insert error: ${resp.status} ${await resp.text()}`);
      // Try individual inserts
      for (const tick of batch) {
        const r2 = await fetch(`${SUPABASE_URL}/rest/v1/stock_ticks`, {
          method: "POST",
          headers: {
            "apikey": SUPABASE_KEY,
            "Authorization": `Bearer ${SUPABASE_KEY}`,
            "Content-Type": "application/json",
            "Prefer": "return=minimal",
          },
          body: JSON.stringify(tick),
        });
        if (r2.ok) totalInserted++;
      }
    } else {
      totalInserted += batch.length;
    }
  }
  
  return totalInserted;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  
  try {
    // Fetch all active symbols from database
    const symbols = await fetchSymbols();
    console.log(`Fetched ${symbols.length} symbols from nse_symbols table`);
    
    if (symbols.length === 0) {
      return new Response(JSON.stringify({
        success: false,
        error: "No symbols found in database"
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 400 });
    }
    
    // Fetch real-time data from TradingView scanner API
    const startTime = Date.now();
    const ticks = await fetchAllTvTicks(symbols);
    const fetchTime = ((Date.now() - startTime) / 1000).toFixed(2);
    
    console.log(`Fetched ${ticks.length} ticks from TradingView in ${fetchTime}s`);
    
    if (ticks.length === 0) {
      return new Response(JSON.stringify({
        success: false,
        error: "No tick data received from TradingView"
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 502 });
    }
    
    // Save to database
    const saved = await saveTicks(ticks);
    const totalTime = ((Date.now() - startTime) / 1000).toFixed(2);
    
    // Get some stats
    const gainers = ticks.filter(t => t.change_pct > 0).length;
    const losers = ticks.filter(t => t.change_pct < 0).length;
    
    return new Response(JSON.stringify({
      success: true,
      total_symbols: symbols.length,
      ticks_fetched: ticks.length,
      ticks_saved: saved,
      gainers,
      losers,
      fetch_time_s: parseFloat(fetchTime),
      total_time_s: parseFloat(totalTime),
      timestamp: new Date().toISOString(),
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    
  } catch (error) {
    console.error("Error:", error.message);
    return new Response(JSON.stringify({
      success: false,
      error: error.message
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 500 });
  }
});
