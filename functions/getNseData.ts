import { createClientFromRequest } from "npm:@base44/sdk@0.8.31";

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);
  
  let body;
  try { body = await req.json(); } catch { body = {}; }
  const symbols = body.symbols || [];
  if (!symbols.length) return Response.json({ success: false, error: "No symbols provided" });

  const results = [];
  const BATCH = 5;

  for (let i = 0; i < symbols.length; i += BATCH) {
    const batch = symbols.slice(i, i + BATCH);
    const promises = batch.map(async (sym) => {
      try {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=5m&range=1d`;
        const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
        if (!res.ok) return { symbol: sym, error: true };
        const json = await res.json();
        const meta = json.chart?.result?.[0]?.meta;
        if (!meta) return { symbol: sym, error: true };

        const price = meta.regularMarketPrice;
        const prevClose = meta.chartPreviousClose || meta.previousClose || price;
        const changePercent = prevClose ? ((price - prevClose) / prevClose) * 100 : 0;

        return {
          symbol: sym,
          price: price,
          changePercent: parseFloat(changePercent.toFixed(2)),
          volume: meta.regularMarketVolume || 0,
          dayHigh: meta.regularMarketDayHigh || null,
          dayLow: meta.regularMarketDayLow || null,
          dayOpen: meta.regularMarketDayOpen || prevClose,
          fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh || null,
          fiftyTwoWeekLow: meta.fiftyTwoWeekLow || null,
          previousClose: prevClose,
          currency: meta.currency || "INR",
          exchange: meta.exchangeName || "NSE",
          error: false
        };
      } catch (e) {
        return { symbol: sym, error: true };
      }
    });
    const batchResults = await Promise.all(promises);
    results.push(...batchResults);
    if (i + BATCH < symbols.length) await new Promise(r => setTimeout(r, 200));
  }

  return Response.json({ success: true, data: results });
});
