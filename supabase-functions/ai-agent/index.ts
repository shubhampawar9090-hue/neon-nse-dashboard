
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const SUPABASE_URL = "https://vpjbjzrcbxgdrfjbyfiu.supabase.co";
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

// In-memory caches
let symbolCache: string[] = [];
let symbolDetailCache: any[] = [];
let symbolCacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000;

// ============ ALIASES (natural language → ticker) ============
const ALIASES: Record<string, string> = {
  "reliance": "RELIANCE", "rel": "RELIANCE", "ril": "RELIANCE",
  "tcs": "TCS", "tata consultancy": "TCS",
  "infosys": "INFY", "infy": "INFY",
  "hdfc bank": "HDFCBANK", "hdfc": "HDFCBANK",
  "icici bank": "ICICIBANK", "icici": "ICICIBANK",
  "sbi": "SBIN", "state bank": "SBIN",
  "bharti airtel": "BHARTIARTL", "airtel": "BHARTIARTL",
  "itc": "ITC",
  "larsen toubro": "LT", "lnt": "LT",
  "bajaj finance": "BAJFINANCE", "bajfinance": "BAJFINANCE",
  "maruti": "MARUTI", "maruti suzuki": "MARUTI",
  "tata motors": "TATAMOTORS", "tatamotors": "TATAMOTORS",
  "sun pharma": "SUNPHARMA", "sunpharma": "SUNPHARMA",
  "adani enterprises": "ADANIENT", "adani": "ADANIENT",
  "adani total gas": "ATGL", "adani power": "ADANIPOWER",
  "trent": "TRENT",
  "zomato": "ETERNAL", "food": "ETERNAL", "eternal": "ETERNAL",
  "dmart": "DMART", "avenue supermarts": "DMART",
  "tata steel": "TATASTEEL", "tatasteel": "TATASTEEL",
  "wipro": "WIPRO",
  "axis bank": "AXISBANK", "axis": "AXISBANK",
  "kotak bank": "KOTAKBANK", "kotak": "KOTAKBANK",
  "asian paints": "ASIANPAINT",
  "hindustan unilever": "HINDUNILVR", "hul": "HINDUNILVR",
  "ongc": "ONGC",
  "ntpc": "NTPC",
  "power grid": "POWERGRID", "powergrid": "POWERGRID",
  "coal india": "COALINDIA", "coalindia": "COALINDIA",
  "tech mahindra": "TECHM", "techm": "TECHM",
  "jsw steel": "JSWSTEEL", "jswsteel": "JSWSTEEL",
  "cipla": "CIPLA",
  "dr reddy": "DRREDDY", "drreddy": "DRREDDY",
  "divis lab": "DIVISLAB", "divis": "DIVISLAB",
  "eicher motors": "EICHERMOT", "eicher": "EICHERMOT",
  "indigo": "INDIGO", "interglobe": "INDIGO",
  "shriram finance": "SHRIRAMFIN",
  "jio financial": "JIOFIN", "jiofin": "JIOFIN",
  "bel": "BEL", "bharat electronics": "BEL",
  "nifty": "^NSEI", "nifty 50": "^NSEI", "nifty50": "^NSEI",
  "bank nifty": "^NSEBANK", "banknifty": "^NSEBANK",
  "sensex": "^BSESN",
  "nifty it": "^CNXIT", "niftyit": "^CNXIT",
  "nifty auto": "^CNXAUTO",
  "nifty fmcg": "^CNXFMCG",
};

// ============ HELPER: Fetch all symbols from DB ============
async function getSymbols(): Promise<string[]> {
  const now = Date.now();
  if (symbolCache.length > 0 && now - symbolCacheTime < CACHE_TTL) return symbolCache;

  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/nse_symbols?select=symbol&is_active=eq.true&order=symbol`,
      { headers: { "apikey": SUPABASE_SERVICE_KEY, "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}` } }
    );
    if (res.ok) {
      const rows = await res.json();
      symbolCache = rows.map((r: { symbol: string }) => r.symbol);
      symbolCacheTime = now;
      return symbolCache;
    }
  } catch (e) { console.error("Failed to fetch symbols:", e.message); }
  return [];
}

// ============ HELPER: Resolve ticker from query ============
async function resolveTicker(query: string): Promise<string> {
  const q = query.toLowerCase().trim();
  for (const [alias, sym] of Object.entries(ALIASES)) {
    if (q.includes(alias)) return sym;
  }
  const symbols = await getSymbols();
  const words = q.split(/\s+/);
  for (const word of words) {
    const upper = word.toUpperCase();
    if (symbols.includes(upper)) return upper;
  }
  const upperQuery = query.toUpperCase();
  if (symbols.includes(upperQuery)) return upperQuery;
  return "";
}

// ============ HELPER: Fetch Yahoo Finance quote ============
async function fetchYahooQuote(ticker: string): Promise<any> {
  const sym = ticker.includes("^") ? ticker : `${ticker}.NS`;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=5d`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) return null;
  const text = await res.text();
  if (!text || text.length < 10) return null;
  let j;
  try { j = JSON.parse(text); } catch { return null; }
  const result = j.chart?.result?.[0];
  if (!result) return null;
  const meta = result.meta;
  const price = meta.regularMarketPrice;
  const closes = (result.indicators?.quote?.[0]?.close || []).filter((v: number | null) => v != null);
  const prev = closes.length >= 2 ? closes[closes.length - 2] : (meta.chartPreviousClose || price);
  const change = price - prev;
  const pct = prev ? (change / prev) * 100 : 0;
  return {
    price: Math.round(price * 100) / 100,
    change: Math.round(change * 100) / 100,
    changePercent: Math.round(pct * 100) / 100,
    prevClose: prev,
    open: meta.regularMarketOpen || price,
    high: meta.regularMarketDayHigh || price,
    low: meta.regularMarketDayLow || price,
    volume: meta.regularMarketVolume || null,
    fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh || null,
    fiftyTwoWeekLow: meta.fiftyTwoWeekLow || null,
  };
}

// ============ HELPER: Fetch Quote with Fallbacks ============
async function fetchQuoteWithFallback(ticker: string): Promise<any> {
  // Try 1: Yahoo Finance
  try {
    const yahoo = await fetchYahooQuote(ticker);
    if (yahoo) {
      console.log(`fetchQuoteWithFallback: Successfully fetched from Yahoo Finance for ${ticker}`);
      return yahoo;
    }
  } catch (e) {
    console.error(`fetchQuoteWithFallback: Yahoo Finance failed for ${ticker}:`, e.message);
  }

  const cleanSym = ticker.replace(".NS", "").replace("^", "").toUpperCase();

  // Try 2: stock_ticks Supabase table
  try {
    console.log(`fetchQuoteWithFallback: Yahoo failed. Trying stock_ticks table for ${cleanSym}`);
    const url = `${SUPABASE_URL}/rest/v1/stock_ticks?symbol=eq.${cleanSym}&order=tick_time.desc&limit=1`;
    const res = await fetch(url, {
      headers: {
        "apikey": SUPABASE_SERVICE_KEY,
        "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}`,
      },
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      const data = await res.json();
      if (data && data.length > 0) {
        const tick = data[0];
        const price = tick.price;
        const change = tick.change_abs ?? 0;
        console.log(`fetchQuoteWithFallback: Found tick data in stock_ticks for ${cleanSym}`);
        return {
          price: Math.round(price * 100) / 100,
          change: Math.round(change * 100) / 100,
          changePercent: Math.round((tick.change_pct ?? 0) * 100) / 100,
          prevClose: Math.round((price - change) * 100) / 100,
          open: tick.day_open ?? price,
          high: tick.day_high ?? price,
          low: tick.day_low ?? price,
          volume: tick.volume ?? null,
          fiftyTwoWeekHigh: 0,
          fiftyTwoWeekLow: 0,
        };
      }
    }
  } catch (e) {
    console.error(`fetchQuoteWithFallback: stock_ticks failed for ${cleanSym}:`, e.message);
  }

  // Try 3: TradingView scanner API
  try {
    console.log(`fetchQuoteWithFallback: stock_ticks failed. Trying TradingView for ${cleanSym}`);
    const url = "https://scanner.tradingview.com/india/scan";
    const body = {
      symbols: {
        tickers: [`NSE:${cleanSym}`],
        query: { types: [] }
      },
      columns: ["close", "change", "change_abs", "volume", "high", "low", "open"]
    };
    const res = await fetch(url, {
      method: "POST",
      headers: { 
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0"
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      const result = await res.json();
      if (result && result.data && result.data.length > 0) {
        const d = result.data[0].d;
        if (d && d.length >= 7) {
          const close = d[0];
          const change = d[1] ?? 0;
          const change_abs = d[2] ?? 0;
          const volume = d[3] ?? null;
          const high = d[4] ?? close;
          const low = d[5] ?? close;
          const open = d[6] ?? close;
          console.log(`fetchQuoteWithFallback: Found TradingView data for ${cleanSym}`);
          return {
            price: Math.round(close * 100) / 100,
            change: Math.round(change_abs * 100) / 100,
            changePercent: Math.round(change * 100) / 100,
            prevClose: Math.round((close - change_abs) * 100) / 100,
            open: Math.round(open * 100) / 100,
            high: Math.round(high * 100) / 100,
            low: Math.round(low * 100) / 100,
            volume: volume,
            fiftyTwoWeekHigh: 0,
            fiftyTwoWeekLow: 0,
          };
        }
      }
    }
  } catch (e) {
    console.error(`fetchQuoteWithFallback: TradingView failed for ${cleanSym}:`, e.message);
  }

  // Try 4: stock_daily_prices Supabase table
  try {
    console.log(`fetchQuoteWithFallback: TradingView failed. Trying stock_daily_prices table for ${cleanSym}`);
    const url = `${SUPABASE_URL}/rest/v1/stock_daily_prices?symbol=eq.${cleanSym}&order=trade_date.desc&limit=1`;
    const res = await fetch(url, {
      headers: {
        "apikey": SUPABASE_SERVICE_KEY,
        "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}`,
      },
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      const data = await res.json();
      if (data && data.length > 0) {
        const row = data[0];
        const close = row.close;
        const change_val = row.change_val ?? 0;
        console.log(`fetchQuoteWithFallback: Found stock_daily_prices data for ${cleanSym}`);
        return {
          price: Math.round(close * 100) / 100,
          change: Math.round(change_val * 100) / 100,
          changePercent: Math.round((row.change_percent ?? 0) * 100) / 100,
          prevClose: Math.round((row.prev_close ?? (close - change_val)) * 100) / 100,
          open: row.open ?? close,
          high: row.high ?? close,
          low: row.low ?? close,
          volume: row.volume ?? null,
          fiftyTwoWeekHigh: 0,
          fiftyTwoWeekLow: 0,
        };
      }
    }
  } catch (e) {
    console.error(`fetchQuoteWithFallback: stock_daily_prices failed for ${cleanSym}:`, e.message);
  }

  return null;
}


// ============ HELPER: DB fetch wrapper ============
async function dbFetch(path: string): Promise<any> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { "apikey": SUPABASE_SERVICE_KEY, "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}` },
  });
  if (!res.ok) return null;
  const text = await res.text();
  if (!text || text.length === 0) return [];
  try { return JSON.parse(text); } catch { return null; }
}

// ============ HELPER: DB upsert wrapper ============
async function dbUpsert(table: string, data: any, conflict: string): Promise<any> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?on_conflict=${conflict}`, {
    method: "POST",
    headers: {
      "apikey": SUPABASE_SERVICE_KEY,
      "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json",
      "Prefer": "resolution=merge-duplicates",
    },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const text = await res.text();
    return { error: `DB upsert failed: ${res.status} - ${text}` };
  }
  const text = await res.text();
  if (!text || text.length === 0) return { success: true };
  try { return JSON.parse(text); } catch { return { success: true }; }
}

// ============ HELPER: DB delete wrapper ============
async function dbDelete(path: string): Promise<boolean> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: "DELETE",
    headers: { "apikey": SUPABASE_SERVICE_KEY, "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}` },
  });
  return res.ok;
}

// ============ HELPER: DB count ============
async function dbCount(table: string, filter: string = ""): Promise<number> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=id&${filter}`, {
    headers: {
      "apikey": SUPABASE_SERVICE_KEY,
      "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}`,
      "Prefer": "count=exact",
    },
  });
  if (!res.ok) return 0;
  const range = res.headers.get("content-range");
  if (range) {
    const parts = range.split("/");
    return parseInt(parts[1]) || 0;
  }
  return 0;
}

// ============ ACTION: Stock query (backward compatible) ============
async function actionQuery(query: string) {
  const ticker = await resolveTicker(query);
  if (ticker) {
    const quote = await fetchQuoteWithFallback(ticker);
    if (quote) {
      return {
        success: true, action: "query", ticker,
        message: `${ticker} is currently trading at ₹${quote.price.toFixed(2)} (${quote.changePercent >= 0 ? "+" : ""}${quote.changePercent.toFixed(2)}%)`,
        data: quote,
      };
    }
  }
  // Market overview fallback
  const indices = [
    { sym: "^NSEI", name: "NIFTY 50" },
    { sym: "^NSEBANK", name: "BANK NIFTY" },
    { sym: "^BSESN", name: "SENSEX" },
  ];
  const idxData = await Promise.all(indices.map(async (idx) => {
    try {
      const q = await fetchYahooQuote(idx.sym);
      return q ? { name: idx.name, ...q } : null;
    } catch { return null; }
  }));
  const valid = idxData.filter(d => d);
  let msg = "Market Overview:\n";
  valid.forEach(d => { if (d) msg += `${d.name}: ₹${d.price.toFixed(2)} (${d.changePercent >= 0 ? "+" : ""}${d.changePercent.toFixed(2)}%)\n`; });
  return { success: true, action: "query", ticker: null, message: msg, data: { indices: valid } };
}

// ============ ACTION: Add new stock symbol ============
async function actionAddSymbol(body: any) {
  const { symbol, company_name, sector, industry, series } = body;
  if (!symbol) return { success: false, error: "Symbol is required" };
  const sym = symbol.toUpperCase().trim();
  const symbols = await getSymbols();
  if (symbols.includes(sym)) {
    return { success: false, error: `Symbol ${sym} already exists in database` };
  }
  // Validate symbol exists on Yahoo Finance
  let yahooValidated = false;
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}.NS?interval=1d&range=1d`;
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      const text = await res.text();
      if (text && text.length >= 10) {
        let j;
        try { j = JSON.parse(text); } catch { j = null; }
        const meta = j?.chart?.result?.[0]?.meta;
        if (meta) {
          yahooValidated = true;
          // Store company name from Yahoo
          if (!company_name) {
            const longName = meta.longName || meta.shortName;
            if (longName) body.company_name = longName;
          }
        }
      }
    }
  } catch (e) {
    console.warn(`Yahoo validation check failed for ${sym}:`, e.message);
  }

  if (!yahooValidated) {
    // Try TradingView validation fallback
    console.log(`Yahoo validation failed or was rate limited. Trying TradingView validation fallback for ${sym}`);
    try {
      const url = "https://scanner.tradingview.com/india/scan";
      const bodyTV = {
        symbols: {
          tickers: [`NSE:${sym}`],
          query: { types: [] }
        },
        columns: ["close"]
      };
      const res = await fetch(url, {
        method: "POST",
        headers: { 
          "Content-Type": "application/json",
          "User-Agent": "Mozilla/5.0"
        },
        body: JSON.stringify(bodyTV),
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) {
        const result = await res.json();
        if (result && result.data && result.data.length > 0) {
          console.log(`TradingView validated symbol ${sym} successfully`);
          // Symbol exists in TradingView, proceed
        } else {
          return { success: false, error: `Symbol ${sym} not found on Yahoo Finance or TradingView scanner API.` };
        }
      } else {
        return { success: false, error: `Symbol validation failed on Yahoo Finance, and TradingView scanner API returned HTTP ${res.status}.` };
      }
    } catch (e) {
      return { success: false, error: `Symbol validation failed on Yahoo Finance, and TradingView fallback also failed: ${e.message}` };
    }
  }

  // Insert into database
  const result = await dbUpsert("nse_symbols", {
    symbol: sym,
    company_name: body.company_name || null,
    sector: sector || null,
    industry: industry || null,
    series: series || "EQ",
    is_active: true,
  }, "symbol");
  // Clear cache
  symbolCache = [];
  symbolCacheTime = 0;
  if (result.error) return { success: false, error: result.error };
  // Fetch and save today's price for the new symbol
  try {
    const quote = await fetchQuoteWithFallback(sym);
    if (quote) {
      const istDate = new Date(Date.now() + 5.5 * 3600000).toISOString().split("T")[0];
      await dbUpsert("stock_daily_prices", {
        symbol: sym,
        trade_date: istDate,
        open: quote.open, high: quote.high, low: quote.low,
        close: quote.price, prev_close: quote.prevClose,
        change_val: quote.change, change_percent: quote.changePercent,
        volume: quote.volume, series: series || "EQ",
      }, "symbol,trade_date");
    }
  } catch { /* price fetch is best-effort */ }
  return {
    success: true, action: "add_symbol",
    message: `Symbol ${sym} added successfully to database${body.company_name ? ` (${body.company_name})` : ""}`,
    data: { symbol: sym, company_name: body.company_name, sector, industry, series: series || "EQ" },
  };
}

// ============ ACTION: List symbols (with search & pagination) ============
async function actionListSymbols(body: any) {
  const search = (body.search || "").toUpperCase().trim();
  const limit = Math.min(body.limit || 50, 500);
  const offset = body.offset || 0;
  const includeInactive = body.include_inactive || false;
  let path = `nse_symbols?select=symbol,company_name,sector,industry,series,is_active&order=symbol&limit=${limit}&offset=${offset}`;
  if (search) {
    path += `&symbol=like.${search}%25`;
  }
  if (!includeInactive) {
    path += `&is_active=eq.true`;
  }
  const data = await dbFetch(path);
  const total = await dbCount("nse_symbols", includeInactive ? "" : "is_active=eq.true");
  return {
    success: true, action: "list_symbols",
    data: data || [],
    pagination: { limit, offset, total, has_more: offset + limit < total },
  };
}

// ============ ACTION: Get daily prices ============
async function actionGetDailyPrices(body: any) {
  const { symbol, start_date, end_date, limit } = body;
  let path = "stock_daily_prices?select=symbol,trade_date,open,high,low,close,prev_close,change_val,change_percent,volume,series&order=trade_date.desc";
  if (symbol) {
    path += `&symbol=eq.${symbol.toUpperCase()}`;
  }
  if (start_date) {
    path += `&trade_date=gte.${start_date}`;
  }
  if (end_date) {
    path += `&trade_date=lte.${end_date}`;
  }
  path += `&limit=${Math.min(limit || 100, 1000)}`;
  const data = await dbFetch(path);
  return { success: true, action: "get_daily_prices", data: data || [], count: data ? data.length : 0 };
}

// ============ ACTION: Get latest ticks ============
async function actionGetTicks(body: any) {
  const { symbol, limit } = body;
  let path = "stock_ticks?select=symbol,price,change_pct,change_abs,volume,day_high,day_low,day_open,tick_time&order=tick_time.desc";
  if (symbol) {
    path += `&symbol=eq.${symbol.toUpperCase()}`;
  } else {
    // Get the latest snapshot — fetch distinct symbols from latest tick_time
    path += `&limit=${Math.min(limit || 100, 500)}`;
  }
  const data = await dbFetch(path);
  return { success: true, action: "get_ticks", data: data || [], count: data ? data.length : 0 };
}

// ============ ACTION: Get database stats ============
async function actionGetDbStats() {
  const [symbolsCount, dailyCount, ticksCount, dailyDates, latestTick, profileCount, watchlistCount, signalsCount, alertsCount] = await Promise.all([
    dbCount("nse_symbols", "is_active=eq.true"),
    dbCount("stock_daily_prices"),
    dbCount("stock_ticks"),
    dbFetch("stock_daily_prices?select=trade_date&order=trade_date.desc&limit=5"),
    dbFetch("stock_ticks?select=tick_time&order=tick_time.desc&limit=1"),
    dbCount("profiles"),
    dbCount("watchlists"),
    dbCount("saved_signals"),
    dbCount("user_alerts"),
  ]);

  // Count distinct dates
  const dateCounts: Record<string, number> = {};
  if (dailyDates && Array.isArray(dailyDates)) {
    dailyDates.forEach((d: any) => {
      const dt = d.trade_date;
      dateCounts[dt] = (dateCounts[dt] || 0) + 1;
    });
  }

  return {
    success: true, action: "get_db_stats",
    data: {
      nse_symbols: { total: symbolsCount, active: symbolsCount },
      stock_daily_prices: { total: dailyCount, dates: Object.keys(dateCounts).sort().reverse() },
      stock_ticks: { total: ticksCount, latest_tick: latestTick?.[0]?.tick_time || null },
      profiles: { total: profileCount },
      watchlists: { total: watchlistCount },
      saved_signals: { total: signalsCount },
      user_alerts: { total: alertsCount },
    },
  };
}

// ============ ACTION: Sync symbols from NSE ============
async function actionSyncSymbols() {
  try {
    // Fetch NSE symbol list from GitHub (comprehensive list)
    const res = await fetch("https://raw.githubusercontent.com/shubhampawar9090-hue/neon-nse-dashboard/main/data/nse_symbols.json");
    if (!res.ok) return { success: false, error: "Failed to fetch symbol list from GitHub" };
    const symbols: string[] = await res.json();
    if (!Array.isArray(symbols) || symbols.length === 0) {
      return { success: false, error: "Empty symbol list received" };
    }
    // Batch upsert
    const batchSize = 100;
    let added = 0, updated = 0;
    for (let i = 0; i < symbols.length; i += batchSize) {
      const batch = symbols.slice(i, i + batchSize).map(sym => ({
        symbol: sym, series: "EQ", is_active: true,
      }));
      const result = await dbUpsert("nse_symbols", batch, "symbol");
      if (!result.error) added += batch.length;
    }
    symbolCache = [];
    symbolCacheTime = 0;
    const totalCount = await dbCount("nse_symbols", "is_active=eq.true");
    return {
      success: true, action: "sync_symbols",
      message: `Synced ${added} symbols. Total active: ${totalCount}`,
      data: { synced: added, total_active: totalCount },
    };
  } catch (e) {
    return { success: false, error: `Sync failed: ${e.message}` };
  }
}

// ============ ACTION: Delete/deactivate symbol ============
async function actionDeleteSymbol(body: any) {
  const { symbol } = body;
  if (!symbol) return { success: false, error: "Symbol is required" };
  const sym = symbol.toUpperCase().trim();
  // Deactivate instead of hard delete
  const res = await fetch(`${SUPABASE_URL}/rest/v1/nse_symbols?symbol=eq.${sym}`, {
    method: "PATCH",
    headers: {
      "apikey": SUPABASE_SERVICE_KEY,
      "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ is_active: false }),
  });
  if (!res.ok) return { success: false, error: `Failed to deactivate ${sym}` };
  symbolCache = [];
  symbolCacheTime = 0;
  return {
    success: true, action: "delete_symbol",
    message: `Symbol ${sym} deactivated successfully`,
  };
}

// ============ ACTION: Get top movers from daily prices ============
async function actionGetTopMovers(body: any) {
  const { date, limit } = body;
  const today = new Date().toISOString().split("T")[0];
  const targetDate = date || today;
  // Get gainers
  const gainers = await dbFetch(
    `stock_daily_prices?select=symbol,close,change_val,change_percent,volume&trade_date=eq.${targetDate}&order=change_percent.desc&limit=${limit || 10}`
  );
  // Get losers
  const losers = await dbFetch(
    `stock_daily_prices?select=symbol,close,change_val,change_percent,volume&trade_date=eq.${targetDate}&order=change_percent.asc&limit=${limit || 10}`
  );
  return {
    success: true, action: "get_top_movers",
    data: {
      date: targetDate,
      gainers: gainers || [],
      losers: losers || [],
    },
  };
}

// ============ ACTION: Get latest tick snapshot ============
async function actionGetLatestSnapshot() {
  // Get the latest tick_time
  const latestTime = await dbFetch("stock_ticks?select=tick_time&order=tick_time.desc&limit=1");
  if (!latestTime || latestTime.length === 0) {
    return { success: true, action: "get_latest_snapshot", data: [], message: "No tick data available" };
  }
  const tickTime = latestTime[0].tick_time;
  // Fetch all ticks at that snapshot time (approximate — within a few seconds)
  const data = await dbFetch(
    `stock_ticks?select=symbol,price,change_pct,change_abs,volume,day_high,day_low,day_open,tick_time&order=change_pct.desc&tick_time=eq.${tickTime}&limit=500`
  );
  if (!data || data.length === 0) {
    // Fallback: get ticks near that time
    const fallback = await dbFetch(
      `stock_ticks?select=symbol,price,change_pct,change_abs,volume,day_high,day_low,day_open,tick_time&order=change_pct.desc&limit=500`
    );
    return { success: true, action: "get_latest_snapshot", data: fallback || [], tick_time: tickTime };
  }
  return { success: true, action: "get_latest_snapshot", data, tick_time: tickTime };
}

// ============ ACTION: Batch add multiple symbols ============
async function actionBatchAddSymbols(body: any) {
  const { symbols } = body;
  if (!Array.isArray(symbols) || symbols.length === 0) {
    return { success: false, error: "symbols array is required" };
  }
  const existing = await getSymbols();
  const newSymbols = symbols.map((s: string) => s.toUpperCase().trim()).filter((s: string) => !existing.includes(s));
  if (newSymbols.length === 0) {
    return { success: true, action: "batch_add_symbols", message: "All symbols already exist", data: { added: 0 } };
  }
  // Validate each on Yahoo Finance
  const valid: { symbol: string; company_name: string | null }[] = [];
  const invalid: string[] = [];
  await Promise.all(newSymbols.map(async (sym: string) => {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}.NS?interval=1d&range=1d`;
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const j = await res.json();
        const meta = j.chart?.result?.[0]?.meta;
        if (meta) {
          valid.push({ symbol: sym, company_name: meta.longName || meta.shortName || null });
        } else {
          invalid.push(sym);
        }
      } else {
        invalid.push(sym);
      }
    } catch { invalid.push(sym); }
  }));
  // Batch insert valid ones
  let added = 0;
  for (let i = 0; i < valid.length; i += 100) {
    const batch = valid.slice(i, i + 100).map(v => ({
      symbol: v.symbol, company_name: v.company_name, series: "EQ", is_active: true,
    }));
    const result = await dbUpsert("nse_symbols", batch, "symbol");
    if (!result.error) added += batch.length;
  }
  symbolCache = [];
  symbolCacheTime = 0;
  return {
    success: true, action: "batch_add_symbols",
    message: `Added ${added} new symbols. ${invalid.length} invalid symbols skipped.`,
    data: { added, invalid, valid: valid.map(v => v.symbol) },
  };
}

// ============ MAIN HANDLER ============
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const action: string = body.action || "query";
    const query: string = body.query || "";

    switch (action) {
      case "query":
        return new Response(JSON.stringify(await actionQuery(query)), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });

      case "add_symbol":
        return new Response(JSON.stringify(await actionAddSymbol(body)), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });

      case "batch_add_symbols":
        return new Response(JSON.stringify(await actionBatchAddSymbols(body)), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });

      case "list_symbols":
        return new Response(JSON.stringify(await actionListSymbols(body)), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });

      case "get_daily_prices":
        return new Response(JSON.stringify(await actionGetDailyPrices(body)), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });

      case "get_ticks":
        return new Response(JSON.stringify(await actionGetTicks(body)), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });

      case "get_latest_snapshot":
        return new Response(JSON.stringify(await actionGetLatestSnapshot()), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });

      case "get_db_stats":
        return new Response(JSON.stringify(await actionGetDbStats()), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });

      case "sync_symbols":
        return new Response(JSON.stringify(await actionSyncSymbols()), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });

      case "delete_symbol":
        return new Response(JSON.stringify(await actionDeleteSymbol(body)), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });

      case "get_top_movers":
        return new Response(JSON.stringify(await actionGetTopMovers(body)), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });

      default:
        // Unknown action — fall back to query
        return new Response(JSON.stringify(await actionQuery(query)), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
    }

  } catch (e) {
    return new Response(JSON.stringify({ success: false, error: e.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
