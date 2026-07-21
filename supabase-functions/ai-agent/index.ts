
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const SUPABASE_URL = "https://vpjbjzrcbxgdrfjbyfiu.supabase.co";
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

// In-memory symbol cache (TTL: 5 minutes)
let symbolCache: string[] = [];
let symbolCacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000;

const ALIASES: Record<string, string> = {
  "reliance": "RELIANCE", "rel": "RELIANCE", "ril": "RELIANCE",
  "tcs": "TCS", "tata consultancy": "TCS",
  "infosys": "INFY", "infy": "INFY",
  "hdfc bank": "HDFCBANK", "hdfc": "HDFCBANK",
  "icici bank": "ICICIBANK", "icici": "ICICIBANK",
  "sbi": "SBIN", "state bank": "SBIN",
  "bharti airtel": "BHARTIARTL", "airtel": "BHARTIARTL",
  "itc": "ITC",
  "larsen toubro": "LT", "lnt": "LT", "lt": "LT",
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
  "ongc": "ONGC", "oil natural gas": "ONGC",
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

async function getSymbols(): Promise<string[]> {
  const now = Date.now();
  if (symbolCache.length > 0 && now - symbolCacheTime < CACHE_TTL) {
    return symbolCache;
  }

  try {
    // Fetch all active symbols from Supabase database
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/nse_symbols?select=symbol&is_active=eq.true&order=symbol`,
      {
        headers: {
          "apikey": SUPABASE_SERVICE_KEY,
          "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}`,
        },
      }
    );
    if (res.ok) {
      const rows = await res.json();
      symbolCache = rows.map((r: { symbol: string }) => r.symbol);
      symbolCacheTime = now;
      return symbolCache;
    }
  } catch (e) {
    console.error("Failed to fetch symbols from Supabase:", e.message);
  }

  // Fallback: fetch from GitHub
  try {
    const symbolRes = await fetch("https://raw.githubusercontent.com/shubhampawar9090-hue/neon-nse-dashboard/main/data/nse_symbols.json");
    const symbols = await symbolRes.json();
    symbolCache = symbols;
    symbolCacheTime = now;
    return symbols;
  } catch (e) {
    console.error("Fallback also failed:", e.message);
    return [];
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const query: string = (body.query || "").toLowerCase().trim();

    // Try alias match first
    let ticker = "";
    for (const [alias, sym] of Object.entries(ALIASES)) {
      if (query.includes(alias)) { ticker = sym; break; }
    }

    // If no alias match, try fetching the full symbol list from Supabase
    if (!ticker) {
      const symbols = await getSymbols();
      
      const words = query.split(/\s+/);
      for (const word of words) {
        const upper = word.toUpperCase();
        if (symbols.includes(upper)) { ticker = upper; break; }
      }
      
      // Try direct symbol search
      if (!ticker) {
        const upperQuery = query.toUpperCase();
        const match = symbols.find(s => s === upperQuery);
        if (match) ticker = match;
      }
    }

    // Fetch data for resolved ticker
    if (ticker) {
      const sym = ticker.includes("^") ? ticker : `${ticker}.NS`;
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=5d`;
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
      const j = await res.json();
      const meta = j.chart?.result?.[0]?.meta;
      
      if (meta) {
        const price = meta.regularMarketPrice;
        const prev = meta.chartPreviousClose || meta.previousClose || price;
        const change = price - prev;
        const pct = prev ? (change / prev) * 100 : 0;
        
        return new Response(JSON.stringify({
          success: true,
          ticker,
          message: `${ticker} is currently trading at ₹${price.toFixed(2)} (${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%)`,
          data: { price, change, changePercent: pct, prevClose: prev }
        }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
    }

    // Default: general market overview
    const indices = [
      { sym: "^NSEI", name: "NIFTY 50" },
      { sym: "^NSEBANK", name: "BANK NIFTY" },
      { sym: "^BSESN", name: "SENSEX" }
    ];
    const idxData = await Promise.all(indices.map(async (idx) => {
      try {
        const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${idx.sym}?interval=1d&range=1d`, {
          headers: { "User-Agent": "Mozilla/5.0" }
        });
        const j = await res.json();
        const meta = j.chart.result[0].meta;
        const price = meta.regularMarketPrice;
        const prev = meta.previousClose || price;
        const pct = prev ? ((price - prev) / prev) * 100 : 0;
        return { name: idx.name, price, changePercent: pct };
      } catch { return null; }
    }));

    const valid = idxData.filter(d => d);
    let msg = "Market Overview:\n";
    valid.forEach(d => {
      if (d) msg += `${d.name}: ${d.price.toFixed(2)} (${d.changePercent >= 0 ? "+" : ""}${d.changePercent.toFixed(2)}%)\n`;
    });

    return new Response(JSON.stringify({
      success: true,
      ticker: null,
      message: msg,
      data: { indices: valid }
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (e) {
    return new Response(JSON.stringify({ success: false, error: e.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
