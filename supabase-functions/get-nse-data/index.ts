import { serve } from "https://deno.land/std/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const symbols: string[] = body.symbols || [];

    const results = await Promise.all(
      symbols.map(async (sym: string) => {
        try {
          const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=5d`;
          const res = await fetch(url, {
            headers: { "User-Agent": "Mozilla/5.0" },
          });
          const j = await res.json();
          const meta = j.chart.result[0].meta;
          const price = meta.regularMarketPrice;
          const prev = meta.chartPreviousClose || meta.previousClose || price;
          const change = price - prev;
          const changePercent = prev ? (change / prev) * 100 : 0;

          // Get volume from candles
          const candles = j.chart.result[0].indicators?.quote?.[0] || {};
          const volumes = candles.volume || [];
          const recentVol = volumes.filter(v => v != null).slice(-5);
          const avgVol = recentVol.length ? recentVol.reduce((a,b) => a+b, 0) / recentVol.length : 0;
          const latestVol = volumes.filter(v => v != null).pop() || 0;
          const volumeRatio = avgVol ? (latestVol / avgVol) : 0;

          return {
            symbol: sym,
            price: Math.round(price * 100) / 100,
            change: Math.round(change * 100) / 100,
            changePercent: Math.round(changePercent * 100) / 100,
            volume: latestVol,
            volumeRatio: Math.round(volumeRatio * 100) / 100,
            previousClose: prev,
            dayHigh: meta.regularMarketDayHigh || price,
            dayLow: meta.regularMarketDayLow || price,
            error: false
          };
        } catch (e) {
          return { symbol: sym, price: 0, change: 0, changePercent: 0, volumeRatio: 0, error: true };
        }
      })
    );

    return new Response(JSON.stringify({ success: true, data: results }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ success: false, error: e.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
