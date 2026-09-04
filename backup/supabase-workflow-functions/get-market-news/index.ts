// get-market-news — RSS aggregator for the dashboard news panel.
// Sources: CNBC, Yahoo Finance, Stock Analysis (Moneycontrol removed per owner request).
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "*" } });
  }

  interface NewsItem {
    title: string;
    link: string;
    source: string;
    publishedAt: string;
    summary: string;
    sentiment: "Bullish" | "Bearish" | "Neutral";
    impact: "High" | "Medium" | "Low";
    category: string;
  }

  function parseRSS(xml: string, source: string): NewsItem[] {
    const items: NewsItem[] = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let match;
    while ((match = itemRegex.exec(xml)) !== null) {
      const block = match[1];
      let title = block.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/)?.[1] || block.match(/<title>([\s\S]*?)<\/title>/)?.[1] || "";
      let link = block.match(/<link>([\s\S]*?)<\/link>/)?.[1]?.trim() || "";
      let pubDate = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1]?.trim() || "";
      let desc = block.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/)?.[1] || block.match(/<description>([\s\S]*?)<\/description>/)?.[1] || "";
      const cleanDesc = desc.replace(/<[^>]+>/g, "").trim().substring(0, 300);
      const cleanTitle = title.replace(/<[^>]+>/g, "").trim();
      if (cleanTitle && link) {
        items.push({ title: cleanTitle, link, source, publishedAt: pubDate, summary: cleanDesc, sentiment: "Neutral", impact: "Medium", category: "Market" });
      }
    }
    return items;
  }

  function analyzeSentiment(title: string, summary: string) {
    const text = (title + " " + summary).toLowerCase();
    const bullWords = ["surge","rally","gain","rise","jump","soar","boost","upgrade","beat","record high","strong","growth","profit","up","bullish","buy","outperform","breakout","positive","expansion","approved","win","deal","investment","raise","partner","higher","surpasses","beats","surplus"];
    const bearWords = ["crash","plunge","fall","drop","decline","loss","down","bearish","sell","downgrade","weak","miss","cut","recall","fraud","ban","probe","raid","default","debt","negative","slump","tumble","slide","warn","concern","risk","fear","sell-off","correction","red","lower","slides","falls","dips"];
    const highImpactWords = ["nifty","sensex","bank nifty","rbi","budget","gdp","inflation","fed","rate","crude oil","war","crash","surge","record","major","big","huge","breaking","alert","ban","merger","acquisition","ipo","global","us market","asia","dow","nasdaq","fii","dii"];
    let bullScore = 0, bearScore = 0;
    for (const w of bullWords) if (text.includes(w)) bullScore++;
    for (const w of bearWords) if (text.includes(w)) bearScore++;
    let impactScore = 0;
    for (const w of highImpactWords) if (text.includes(w)) impactScore++;
    let sentiment: "Bullish" | "Bearish" | "Neutral" = "Neutral";
    if (bullScore > bearScore + 1) sentiment = "Bullish";
    else if (bearScore > bullScore + 1) sentiment = "Bearish";
    else if (bullScore > 0 && bearScore === 0) sentiment = "Bullish";
    else if (bearScore > 0 && bullScore === 0) sentiment = "Bearish";
    let impact: "High" | "Medium" | "Low" = "Medium";
    if (impactScore >= 2) impact = "High";
    else if (impactScore === 0) impact = "Low";
    return { sentiment, impact };
  }

  function categorize(title: string): string {
    const text = title.toLowerCase();
    if (text.includes("nifty") || text.includes("sensex") || text.includes("bank nifty") || text.includes("index") || text.includes("benchmark")) return "Indices";
    if (text.includes("bank") || text.includes("loan") || text.includes("rbi")) return "Banking";
    if (text.includes("oil") || text.includes("gas") || text.includes("crude") || text.includes("energy")) return "Energy";
    if (text.includes("tech") || text.includes("software") || text.includes("digital") || text.includes("ai ")) return "Technology";
    if (text.includes("pharma") || text.includes("drug") || text.includes("health")) return "Pharma";
    if (text.includes("auto") || text.includes("car") || text.includes("vehicle") || text.includes("motor")) return "Auto";
    if (text.includes("metal") || text.includes("steel") || text.includes("mining")) return "Metals";
    if (text.includes("realty") || text.includes("property") || text.includes("real estate")) return "Realty";
    if (text.includes("ipo") || text.includes("listing") || text.includes("market debut")) return "IPO";
    if (text.includes("crypto") || text.includes("bitcoin")) return "Crypto";
    if (text.includes("global") || text.includes("us market") || text.includes("asia") || text.includes("dow") || text.includes("nasdaq")) return "Global";
    if (text.includes("earnings") || text.includes("result") || text.includes("quarterly") || text.includes("q1") || text.includes("q2") || text.includes("q3") || text.includes("q4")) return "Earnings";
    if (text.includes("economy") || text.includes("gdp") || text.includes("inflation") || text.includes("fiscal")) return "Economy";
    return "Market";
  }

  // ---- persistence (backend DB) ----
  const SB = Deno.env.get("SUPABASE_URL") || "";
  const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const sbH = { apikey: SRK, Authorization: `Bearer ${SRK}`, "Content-Type": "application/json", Prefer: "return=minimal" };
  async function persist(news: NewsItem[], moodInfo: any, score: number, summary: string) {
    if (!SB || !SRK) return;
    try {
      // dedupe against recent rows then insert new headlines
      const recent = await (await fetch(`${SB}/rest/v1/market_news?select=title&created_at=gte.${new Date(Date.now() - 36 * 3600e3).toISOString()}&limit=200`, { headers: sbH })).json();
      const seenTitles = new Set((recent || []).map((r: any) => String(r.title || "").toLowerCase().substring(0, 80)));
      const fresh = news.filter(n => !seenTitles.has(n.title.toLowerCase().substring(0, 80)));
      if (fresh.length) {
        await fetch(`${SB}/rest/v1/market_news`, { method: "POST", headers: sbH, body: JSON.stringify(fresh.map(n => ({
          title: n.title.substring(0, 300), link: n.link, source: n.source, summary: n.summary, published_at: n.publishedAt ? new Date(n.publishedAt).toISOString() : null, sentiment: n.sentiment, impact: n.impact, category: n.category,
        }))) });
      }
      // aggregate row for the trading agent
      const highBull = news.filter(n => n.impact === "High" && n.sentiment === "Bullish").length;
      const highBear = news.filter(n => n.impact === "High" && n.sentiment === "Bearish").length;
      await fetch(`${SB}/rest/v1/market_sentiment`, { method: "POST", headers: sbH, body: JSON.stringify({
        mood: moodInfo.overall, score: Math.round(score * 1000) / 1000,
        bullish: moodInfo.bullish, bearish: moodInfo.bearish, neutral: moodInfo.neutral, total: moodInfo.total,
        high_bullish: highBull, high_bearish: highBear, summary: summary.substring(0, 500),
      }) });
      // retention: keep 7 days
      await fetch(`${SB}/rest/v1/market_news?created_at=lt.${new Date(Date.now() - 7 * 86400e3).toISOString()}`, { method: "DELETE", headers: sbH });
    } catch (e) { /* persistence is best-effort; the API response still goes out */ }
  }

  const FEEDS = [
    { url: "https://feeds.feedburner.com/CnbcMarketNews", source: "CNBC" },
    { url: "https://www.cnbc.com/id/10000664/device/rss/rss.html", source: "CNBC" },
    { url: "https://finance.yahoo.com/news/rssindex", source: "Yahoo Finance" },
    { url: "https://feeds.feedburner.com/stockanalysis/stockideas", source: "Stock Analysis" },
  ];

  try {
    const allNews: NewsItem[] = [];
    const feedPromises = FEEDS.map(async (feed) => {
      try {
        const res = await fetch(feed.url, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" }, signal: AbortSignal.timeout(8000) });
        if (!res.ok) return [];
        const xml = await res.text();
        const items = parseRSS(xml, feed.source);
        items.forEach(item => { item.category = categorize(item.title); });
        return items;
      } catch (e) {
        return [];
      }
    });

    const results = await Promise.all(feedPromises);
    results.forEach(items => allNews.push(...items));

    const seen = new Set<string>();
    const deduped = allNews.filter(item => {
      const key = item.title.toLowerCase().trim().substring(0, 80);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    deduped.forEach(item => {
      const analysis = analyzeSentiment(item.title, item.summary);
      item.sentiment = analysis.sentiment;
      item.impact = analysis.impact;
    });

    deduped.sort((a, b) => {
      const impactOrder: Record<string, number> = { "High": 3, "Medium": 2, "Low": 1 };
      if (impactOrder[b.impact] !== impactOrder[a.impact]) return impactOrder[b.impact] - impactOrder[a.impact];
      return new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime();
    });

    const topNews = deduped.slice(0, 50);
    const bullish = deduped.filter(n => n.sentiment === "Bullish").length;
    const bearish = deduped.filter(n => n.sentiment === "Bearish").length;
    const neutral = deduped.filter(n => n.sentiment === "Neutral").length;
    const mood = bullish > bearish * 1.5 ? "BULLISH" : bearish > bullish * 1.5 ? "BEARISH" : "NEUTRAL";
    const total = deduped.length || 1;
    const score = Math.max(-1, Math.min(1, (bullish - bearish) / total));
    const topHeadlines = topNews.slice(0, 3).map(n => `${n.impact === "High" ? "⚡" : ""}${n.sentiment === "Bullish" ? "▲" : n.sentiment === "Bearish" ? "▼" : "="} ${n.title.substring(0, 90)}`).join(" | ");
    await persist(topNews, { overall: mood, bullish, bearish, neutral, total: deduped.length }, score, `${mood}: ${topHeadlines}`);

    return Response.json({ success: true, data: topNews, mood: { overall: mood, bullish, bearish, neutral, total: deduped.length, score }, timestamp: new Date().toISOString() },{ success: true, data: topNews, mood: { overall: mood, bullish, bearish, neutral, total: deduped.length }, timestamp: new Date().toISOString() }, { headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" } });
  } catch (e) {
    return Response.json({ success: false, error: (e as Error).message }, { status: 500, headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" } });
  }
});
