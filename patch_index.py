import re

with open('supabase-functions/ai-agent/index.ts', 'r') as f:
    content = f.read()

# 1. Define fetchQuoteWithFallback
fetch_fallback_code = """
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
"""

# Insert fetchQuoteWithFallback after fetchYahooQuote
yahoo_quote_pattern = r'(async function fetchYahooQuote[\s\S]+?\}\n)'
content_with_fallback = re.sub(yahoo_quote_pattern, r'\1' + fetch_fallback_code, content, count=1)

# 2. Update actionQuery to use fetchQuoteWithFallback
action_query_pattern = r'async function actionQuery\(query: string\) \{'
# Let's find: const quote = await fetchYahooQuote(ticker);
# inside actionQuery. Since there's multiple, let's find the first one inside actionQuery.
query_replacement = r'const quote = await fetchYahooQuote(ticker);'
query_with_fallback_replacement = r'const quote = await fetchQuoteWithFallback(ticker);'

# Let's locate the actionQuery body and replace the first occurrence of fetchYahooQuote
action_query_start = content_with_fallback.find("async function actionQuery")
if action_query_start != -1:
    idx = content_with_fallback.find(query_replacement, action_query_start)
    if idx != -1:
        content_with_fallback = content_with_fallback[:idx] + query_with_fallback_replacement + content_with_fallback[idx + len(query_replacement):]
        print("Updated actionQuery to use fetchQuoteWithFallback")
    else:
        print("Could not find fetchYahooQuote(ticker) in actionQuery")
else:
    print("Could not find actionQuery function")

# 3. Update actionAddSymbol
new_add_symbol_code = """async function actionAddSymbol(body: any) {
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
}"""

add_symbol_pattern = r'async function actionAddSymbol\(body: any\) \{[\s\S]+?\}\n\n'
content_final = re.sub(add_symbol_pattern, new_add_symbol_code + '\n\n', content_with_fallback, count=1)

with open('supabase-functions/ai-agent/index.ts', 'w') as f:
    f.write(content_final)

print("File successfully updated!")
