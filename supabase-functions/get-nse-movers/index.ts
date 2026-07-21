
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const NSE_HOME = "https://www.nseindia.com";
const NSE_HEADERS: Record<string, string> = {
  "Accept": "*/*",
  "Accept-Language": "en-US,en;q=0.5",
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "X-Requested-With": "XMLHttpRequest",
  "Referer": NSE_HOME + "/",
};

async function getNseCookies(): Promise<string> {
  const res = await fetch(NSE_HOME, {
    headers: {
      "User-Agent": NSE_HEADERS["User-Agent"],
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": NSE_HEADERS["Accept-Language"],
    },
  });
  const setCookieHeaders = res.headers.getSetCookie?.() || [];
  if (setCookieHeaders.length === 0) {
    const cookieHeader = res.headers.get("set-cookie");
    if (cookieHeader) return cookieHeader.split(",").map((c: string) => c.split(";")[0].trim()).join("; ");
    return "";
  }
  return setCookieHeaders.map((c: string) => c.split(";")[0]).join("; ");
}

async function fetchNseApi(url: string, cookie: string): Promise<any> {
  const headers: Record<string, string> = { ...NSE_HEADERS };
  if (cookie) headers["Cookie"] = cookie;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`NSE API returned ${res.status}`);
  return res.json();
}

function mapStock(d: any) {
  return {
    symbol: d.symbol,
    price: d.ltp || d.lastPrice,
    changePercent: d.perChange || d.net_price || 0,
    change: (d.ltp && d.prev_price) ? d.ltp - d.prev_price : (d.change || 0),
    open: d.open_price,
    high: d.high_price,
    low: d.low_price,
    prevClose: d.prev_price || d.prevClose,
    volume: d.trade_quantity || 0,
    turnover: d.turnover || 0,
    series: d.series || "EQ",
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const cookie = await getNseCookies();
    
    const [gainersData, losersData, highData, lowData] = await Promise.all([
      fetchNseApi(`${NSE_HOME}/api/live-analysis-variations?index=gainers`, cookie).catch(() => ({})),
      fetchNseApi(`${NSE_HOME}/api/live-analysis-variations?index=loosers`, cookie).catch(() => ({})),
      fetchNseApi(`${NSE_HOME}/api/live-analysis-data-52weekhighstock`, cookie).catch(() => ({})),
      fetchNseApi(`${NSE_HOME}/api/live-analysis-data-52weeklowstock`, cookie).catch(() => ({})),
    ]);

    // NSE API returns grouped data: { allSec: { data: [...] }, NIFTY: { data: [...] }, ... }
    const gainersRaw = gainersData?.allSec?.data || gainersData?.data || [];
    const losersRaw = losersData?.allSec?.data || losersData?.data || [];
    const highRaw = highData?.data || [];
    const lowRaw = lowData?.data || [];

    const gainers = gainersRaw.map(mapStock).sort((a, b) => b.changePercent - a.changePercent);
    const losers = losersRaw.map(mapStock).sort((a, b) => a.changePercent - b.changePercent);

    const fiftyTwoWeekHigh = highRaw.map((d: any) => ({
      symbol: d.symbol, ltp: d.ltp, prevClose: d.prevClose, change: d.change, pChange: d.pChange,
    }));
    const fiftyTwoWeekLow = lowRaw.map((d: any) => ({
      symbol: d.symbol, ltp: d.ltp, prevClose: d.prevClose, change: d.change, pChange: d.pChange,
    }));

    return Response.json({
      success: true,
      data: { gainers, losers, fiftyTwoWeekHigh, fiftyTwoWeekLow },
      timestamp: new Date().toISOString(),
    }, { headers: corsHeaders });

  } catch (error) {
    console.error("get-nse-movers error:", error.message);
    return Response.json({
      success: false,
      error: error.message,
      data: { gainers: [], losers: [], fiftyTwoWeekHigh: [], fiftyTwoWeekLow: [] },
    }, { headers: corsHeaders, status: 500 });
  }
});
