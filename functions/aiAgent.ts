import { createClientFromRequest } from "npm:@base44/sdk@0.8.31";

// Full NSE stock list URL (2,384 stocks) — fetched at runtime
const NSE_SYMBOLS_URL = "https://base44.app/api/apps/6a5b3772e2193d1b5140a8e3/files/mp/public/6a5b3772e2193d1b5140a8e3/e2d45e769_nse_symbols.json";
let nseSymbolsCache = null;

async function getNseSymbols() {
  if (nseSymbolsCache) return nseSymbolsCache;
  try {
    const res = await fetch(NSE_SYMBOLS_URL);
    if (res.ok) {
      const arr = await res.json();
      nseSymbolsCache = new Set(arr);
      return nseSymbolsCache;
    }
  } catch (e) {}
  return null;
}

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);
  
  let body;
  try { body = await req.json(); } catch { body = {}; }
  const query = body.content || body.query || "";
  const convId = body.conversation_id || null;

  if (!query.trim()) {
    return Response.json({ success: false, error: "No question provided" });
  }

  // Natural language aliases for common stocks
  const stockAliases = {
    "RELIANCE.NS": ["reliance", "reliance industries", "ril"],
    "TCS.NS": ["tcs", "tata consultancy"],
    "HDFCBANK.NS": ["hdfc bank", "hdfcbank", "hdfc"],
    "INFY.NS": ["infy", "infosys"],
    "ICICIBANK.NS": ["icici bank", "icicibank", "icici"],
    "SBIN.NS": ["sbin", "state bank", "sbi"],
    "TATAMOTORS.NS": ["tata motors", "tatamotors"],
    "BHARTIARTL.NS": ["bharti airtel", "airtel"],
    "ITC.NS": ["itc"],
    "LT.NS": ["larsen", "l&t", "larsen toubro", "l and t"],
    "AXISBANK.NS": ["axis bank", "axisbank"],
    "KOTAKBANK.NS": ["kotak bank", "kotakbank", "kotak"],
    "MARUTI.NS": ["maruti", "maruti suzuki"],
    "HCLTECH.NS": ["hcl tech", "hcltech", "hcl"],
    "SUNPHARMA.NS": ["sun pharma", "sunpharma"],
    "ULTRACEMCO.NS": ["ultracemco", "ultratech", "ultra tech"],
    "ASIANPAINT.NS": ["asian paints", "asianpaint"],
    "NESTLEIND.NS": ["nestle", "nestleind"],
    "BAJFINANCE.NS": ["bajaj finance", "bajfinance"],
    "TITAN.NS": ["titan"],
    "TATASTEEL.NS": ["tata steel", "tatasteel"],
    "ADANIENT.NS": ["adani enterprises", "adanient"],
    "ADANIPORTS.NS": ["adani ports", "adaniports"],
    "JSWSTEEL.NS": ["jsw steel", "jswsteel"],
    "BAJAJFINSV.NS": ["bajaj finserv", "bajajfinsv"],
    "GRASIM.NS": ["grasim"],
    "HINDALCO.NS": ["hindalco"],
    "TECHM.NS": ["tech mahindra", "techm"],
    "DIVISLAB.NS": ["divis lab", "divislab"],
    "DRREDDY.NS": ["dr reddy", "drreddy"],
    "CIPLA.NS": ["cipla"],
    "BRITANNIA.NS": ["britannia"],
    "HEROMOTOCO.NS": ["hero motocorp", "heromotoco"],
    "EICHERMOT.NS": ["eicher motor", "eichermot"],
    "SHRIRAMFIN.NS": ["shriram finance", "shriramfin"],
    "BPCL.NS": ["bpcl", "bharat petroleum"],
    "INDUSINDBK.NS": ["indusind bank", "indusindbk", "indusind"],
    "TATACONSUM.NS": ["tata consumer", "tataconsum"],
    "M&M.NS": ["mahindra", "m&m", "m and m"],
    "TATAPOWER.NS": ["tata power", "tatapower"],
    "DMART.NS": ["dmart", "avenue supermarts"],
    "PIDILITIND.NS": ["pidilite", "pidilitind"],
    "ZOMATO.NS": ["zomato"],
    "IRCTC.NS": ["irctc"],
    "DLF.NS": ["dlf"],
    "VEDL.NS": ["vedanta", "vedl"],
    "HINDUNILVR.NS": ["hindustan unilever", "hindunilvr", "hul"],
    "BEL.NS": ["bharat electronics"],
    "HAL.NS": ["hindustan aeronautics"],
    "BHEL.NS": ["bhel", "bharat heavy"],
    "GAIL.NS": ["gail"],
    "IOC.NS": ["ioc", "indian oil"],
    "NMDC.NS": ["nmdc"],
    "BANKBARODA.NS": ["bank of baroda", "bankbaroda", "baroda"],
    "PNB.NS": ["pnb", "punjab national bank"],
    "CANBK.NS": ["canara bank", "canbk"],
    "MUTHOOTFIN.NS": ["muthoot", "muthootfin"]
  };

  const indices = [
    { sym: "^NSEI", name: "NIFTY 50", aliases: ["nifty 50", "nifty50", "nifty", "nsei"] },
    { sym: "^BSESN", name: "SENSEX", aliases: ["sensex", "bse", "bombay stock"] },
    { sym: "^NSEBANK", name: "BANK NIFTY", aliases: ["bank nifty", "banknifty", "nsebank"] },
    { sym: "^CNXIT", name: "NIFTY IT", aliases: ["nifty it", "cnxit", "it index"] },
    { sym: "^CNXAUTO", name: "NIFTY AUTO", aliases: ["nifty auto", "cnxauto"] },
    { sym: "^CNXPHARMA", name: "NIFTY PHARMA", aliases: ["nifty pharma", "cnxpharma"] }
  ];

  const queryLower = query.toLowerCase().trim();
  let symbols = [];

  // Check indices
  for (const idx of indices) {
    for (const alias of idx.aliases) {
      if (queryLower.includes(alias.toLowerCase())) {
        if (!symbols.includes(idx.sym)) symbols.push(idx.sym);
        break;
      }
    }
  }

  // Check natural language aliases
  for (const [ticker, aliases] of Object.entries(stockAliases)) {
    for (const alias of aliases) {
      if (queryLower.includes(alias.toLowerCase())) {
        if (!symbols.includes(ticker)) symbols.push(ticker);
        break;
      }
    }
  }

  // Check explicit .NS symbols
  const nsMatches = query.match(/[A-Z0-9&\-\.]+\.NS/gi);
  if (nsMatches) {
    for (const m of nsMatches) {
      const sym = m.toUpperCase();
      if (!symbols.includes(sym)) symbols.push(sym);
    }
  }

  // Check ALL uppercase words against full NSE symbol list (2,384 stocks)
  const upperWords = query.match(/\b[A-Z][A-Z0-9&\-]{2,}\b/g);
  if (upperWords) {
    const nseSet = await getNseSymbols();
    if (nseSet) {
      for (const w of upperWords) {
        if (nseSet.has(w) && !symbols.includes(w + ".NS")) {
          symbols.push(w + ".NS");
        }
      }
    }
  }

  // Also check Title Case words merged (e.g. "Tata Motors" -> "TATAMOTORS")
  const titleWords = query.match(/\b[A-Z][a-z]+\s+[A-Z][a-z]+\b/g);
  if (titleWords) {
    const nseSet = nseSymbolsCache || await getNseSymbols();
    if (nseSet) {
      for (const w of titleWords) {
        const merged = w.replace(/\s+/g, '').toUpperCase();
        if (nseSet.has(merged) && !symbols.includes(merged + ".NS")) {
          symbols.push(merged + ".NS");
        }
      }
    }
  }

  const isMarketQuery = /market|nifty|sensex|index|indices|overall|how.*(market|doing|today|sector)|top.*(gainer|loser|stock)|best.*(stock|buy)|trend|outlook/i.test(query);
  const isGreeting = /^\s*(hi|hello|hey|yo|sup|namaste|hii|help|what.*can.*you|who.*are|start)\b/i.test(query);
  const isBreakoutQuery = /breakout|breakdown|screening|screener|scan|hot stock|momentum stock|pick/i.test(query);

  if (isGreeting && symbols.length === 0) {
    return Response.json({
      success: true,
      response: "\u{1F44B} Hi! I'm <b>Elara</b> \u2014 your AI trading assistant.\n\nI can analyze <b>ALL 2,384 NSE stocks</b> using live Yahoo Finance data. Try:\n\n\u2022 <b>\"Analyze RELIANCE\"</b> \u2014 full technical breakdown\n\u2022 <b>\"TCS buy or sell?\"</b> \u2014 signal with SL/TP\n\u2022 <b>\"NIFTY 50 outlook\"</b> \u2014 index analysis\n\u2022 <b>\"Market today\"</b> \u2014 all indices snapshot\n\u2022 Type any NSE ticker (e.g. \"HDFCBANK\", \"ZOMATO\", \"IRCTC\") for instant analysis!",
      conversation_id: convId || crypto.randomUUID()
    });
  }

  if (symbols.length === 0) {
    if (isBreakoutQuery) {
      symbols = ["^NSEI", "RELIANCE.NS", "TCS.NS", "HDFCBANK.NS", "INFY.NS", "ICICIBANK.NS", "SBIN.NS", "TATAMOTORS.NS", "BHARTIARTL.NS", "ADANIENT.NS"];
    } else {
      symbols = ["^NSEI", "^BSESN", "^NSEBANK"];
    }
  }

  const analysisResults = [];
  for (const sym of symbols.slice(0, 8)) {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=5m&range=5d`;
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
      if (!res.ok) continue;
      const json = await res.json();
      const result = json.chart?.result?.[0];
      if (!result) continue;
      const meta = result.meta;
      const quotes = result.indicators?.quote?.[0] || {};
      const closes = quotes.close?.filter(v => v != null) || [];
      const highs = quotes.high?.filter(v => v != null) || [];
      const lows = quotes.low?.filter(v => v != null) || [];
      const volumes = quotes.volume?.filter(v => v != null) || [];
      if (closes.length < 10) continue;

      const price = meta.regularMarketPrice || closes[closes.length - 1];
      const prevClose = meta.chartPreviousClose || meta.previousClose || closes[closes.length - 2] || price;
      const changePercent = prevClose ? parseFloat(((price - prevClose) / prevClose * 100).toFixed(2)) : 0;

      function calcEMA(data, period) {
        if (data.length < period) return null;
        const k = 2 / (period + 1);
        let ema = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
        for (let i = period; i < data.length; i++) ema = data[i] * k + ema * (1 - k);
        return parseFloat(ema.toFixed(2));
      }
      const ema5 = calcEMA(closes, 5);
      const ema13 = calcEMA(closes, 13);
      const ema26 = calcEMA(closes, 26);

      function calcRSI(data, period) {
        if (data.length < period + 1) return null;
        let gains = 0, losses = 0;
        for (let i = 1; i <= period; i++) {
          const diff = data[i] - data[i - 1];
          if (diff > 0) gains += diff; else losses += Math.abs(diff);
        }
        let avgGain = gains / period, avgLoss = losses / period;
        for (let i = period + 1; i < data.length; i++) {
          const diff = data[i] - data[i - 1];
          avgGain = (avgGain * (period - 1) + (diff > 0 ? diff : 0)) / period;
          avgLoss = (avgLoss * (period - 1) + (diff < 0 ? Math.abs(diff) : 0)) / period;
        }
        if (avgLoss === 0) return 100;
        return parseFloat((100 - 100 / (1 + avgGain / avgLoss)).toFixed(1));
      }
      const rsi = calcRSI(closes, 14);

      let totalPV = 0, totalV = 0;
      for (let i = 0; i < closes.length; i++) {
        totalPV += ((highs[i] + lows[i] + closes[i]) / 3) * (volumes[i] || 0);
        totalV += volumes[i] || 0;
      }
      const vwap = totalV > 0 ? parseFloat((totalPV / totalV).toFixed(2)) : null;

      function calcATR(p) {
        if (closes.length < p + 1) return null;
        const trs = [];
        for (let i = 1; i < closes.length; i++) {
          trs.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
        }
        let atr = trs.slice(0, p).reduce((a, b) => a + b, 0) / p;
        for (let i = p; i < trs.length; i++) atr = (atr * (p - 1) + trs[i]) / p;
        return parseFloat(atr.toFixed(2));
      }
      const atr = calcATR(14);

      const avgVol = volumes.length > 10 ? volumes.slice(-11, -1).reduce((a, b) => a + b, 0) / 10 : 0;
      const volumeRatio = avgVol > 0 ? parseFloat((volumes[volumes.length - 1] / avgVol).toFixed(2)) : 1;

      const last20 = closes.slice(-20);
      let pattern = "Consolidation";
      if (last20.length >= 10) {
        const n = last20.length;
        const sumX = n * (n - 1) / 2;
        const sumY = last20.reduce((a, b) => a + b, 0);
        const sumXY = last20.reduce((s, y, x) => s + x * y, 0);
        const sumX2 = n * (n - 1) * (2 * n - 1) / 6;
        const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
        const slopePct = (slope / (sumY / n)) * 100;
        if (slopePct > 0.3) pattern = "Uptrend";
        else if (slopePct < -0.3) pattern = "Downtrend";
      }

      let buyScore = 0, sellScore = 0;
      if (ema5 > ema13 && ema13 > ema26) buyScore += 2;
      if (ema5 < ema13 && ema13 < ema26) sellScore += 2;
      if (vwap && price > vwap) buyScore += 1;
      if (vwap && price < vwap) sellScore += 1;
      if (rsi && rsi < 35) buyScore += 1;
      if (rsi && rsi > 65) sellScore += 1;
      if (pattern === "Uptrend") buyScore += 1;
      if (pattern === "Downtrend") sellScore += 1;

      let signal = "HOLD";
      if (buyScore >= 4) signal = "STRONG BUY";
      else if (buyScore >= 2) signal = "BUY";
      else if (sellScore >= 4) signal = "STRONG SELL";
      else if (sellScore >= 2) signal = "SELL";

      const direction = buyScore > sellScore ? 1 : -1;
      const sl = atr ? parseFloat((price - atr * direction).toFixed(2)) : null;
      const tp1 = atr ? parseFloat((price + atr * 1.5 * direction).toFixed(2)) : null;
      const tp2 = atr ? parseFloat((price + atr * 2 * direction).toFixed(2)) : null;

      let displayName = sym;
      const idxMap = { "^NSEI": "NIFTY 50", "^BSESN": "SENSEX", "^NSEBANK": "BANK NIFTY", "^CNXIT": "NIFTY IT", "^CNXAUTO": "NIFTY AUTO", "^CNXPHARMA": "NIFTY PHARMA" };
      if (idxMap[sym]) displayName = idxMap[sym];
      else displayName = sym.replace(/\.NS$/, "").replace(/\.BO$/, "");

      analysisResults.push({
        symbol: sym, name: displayName,
        price: parseFloat(price.toFixed(2)), changePercent,
        ema5, ema13, ema26, rsi, vwap, atr, volumeRatio, pattern, signal,
        sl, tp1, tp2,
        fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh, fiftyTwoWeekLow: meta.fiftyTwoWeekLow,
        dayHigh: meta.regularMarketDayHigh, dayLow: meta.regularMarketDayLow
      });
    } catch (e) {}
  }

  if (analysisResults.length === 0) {
    return Response.json({
      success: true,
      response: "I couldn't fetch live data right now \u2014 Yahoo Finance might be rate-limiting. Please try again in a few seconds.",
      conversation_id: convId || crypto.randomUUID()
    });
  }

  let response = "";
  if (analysisResults.length === 1) {
    const d = analysisResults[0];
    const changeIcon = d.changePercent >= 0 ? "\u{1F7E2}" : "\u{1F534}";
    const signalEmoji = d.signal.includes("BUY") ? "\u{1F7E2}" : d.signal.includes("SELL") ? "\u{1F534}" : "\u{1F7E1}";
    response = "<b>" + d.name + "</b> \u2014 " + changeIcon + " \u20B9" + d.price + " (" + (d.changePercent >= 0 ? "+" : "") + d.changePercent + "%)\n\n";
    response += "<b>" + signalEmoji + " Signal: " + d.signal + "</b>\n\n";
    response += "<b>\u{1F4CA} Technical Indicators</b>\n";
    response += "\u2022 EMA 5/13/26: " + d.ema5 + " / " + d.ema13 + " / " + d.ema26 + "\n";
    const emaStack = d.ema5 > d.ema13 && d.ema13 > d.ema26 ? "Bullish \u2191" : d.ema5 < d.ema13 && d.ema13 < d.ema26 ? "Bearish \u2193" : "Mixed";
    response += "\u2022 EMA Stack: <b>" + emaStack + "</b>\n";
    response += "\u2022 RSI (14): " + d.rsi + (d.rsi < 30 ? " (Oversold)" : d.rsi > 70 ? " (Overbought)" : " (Neutral)") + "\n";
    response += "\u2022 VWAP: " + (d.vwap || "N/A") + (d.vwap ? (d.price > d.vwap ? " (Above \u2713)" : " (Below \u2717)") : "") + "\n";
    response += "\u2022 ATR (14): " + d.atr + "\n";
    response += "\u2022 Volume Ratio: " + d.volumeRatio + "x" + (d.volumeRatio > 1.5 ? " (Surge!)" : "") + "\n";
    response += "\u2022 Pattern: " + d.pattern + "\n\n";
    response += "<b>\u{1F3AF} Trade Levels</b>\n";
    if (d.sl) response += "\u2022 Stop Loss: \u20B9" + d.sl + "\n";
    if (d.tp1) response += "\u2022 Target 1: \u20B9" + d.tp1 + "\n";
    if (d.tp2) response += "\u2022 Target 2: \u20B9" + d.tp2 + "\n";
    response += "\u2022 Day High/Low: \u20B9" + d.dayHigh + " / \u20B9" + d.dayLow + "\n";
    response += "\u2022 52W High/Low: \u20B9" + d.fiftyTwoWeekHigh + " / \u20B9" + d.fiftyTwoWeekLow + "\n\n";
    if (d.signal.includes("BUY")) {
      response += "<b>\u{1F4A1} Verdict:</b> Bullish setup. EMA stack aligned, price " + (d.price > d.vwap ? "above VWAP" : "near VWAP") + ", RSI at " + d.rsi + ". Look for entry on dips with SL below \u20B9" + d.sl + ".";
    } else if (d.signal.includes("SELL")) {
      response += "<b>\u{1F4A1} Verdict:</b> Bearish pressure. EMA stack bearish" + (d.price < d.vwap ? ", below VWAP" : "") + ", RSI at " + d.rsi + ". Consider exiting or shorting with SL above \u20B9" + d.sl + ".";
    } else {
      response += "<b>\u{1F4A1} Verdict:</b> Sideways/neutral. Wait for a clear breakout above \u20B9" + d.dayHigh + " or breakdown below \u20B9" + d.dayLow + " before taking a position.";
    }
  } else if (analysisResults.length <= 3) {
    for (const d of analysisResults) {
      const signalEmoji = d.signal.includes("BUY") ? "\u{1F7E2}" : d.signal.includes("SELL") ? "\u{1F534}" : "\u{1F7E1}";
      response += "<b>" + d.name + "</b> " + signalEmoji + " \u20B9" + d.price + " (" + (d.changePercent >= 0 ? "+" : "") + d.changePercent + "%)\n";
      response += "  " + d.signal + " \u2022 EMA " + d.ema5 + "/" + d.ema13 + "/" + d.ema26 + " \u2022 RSI " + d.rsi + " \u2022 " + d.pattern + "\n";
      if (d.sl) response += "  SL: \u20B9" + d.sl + " \u2022 TP: \u20B9" + d.tp1 + " / \u20B9" + d.tp2 + "\n";
      response += "\n";
    }
    response += "Ask me about any specific stock for a full detailed breakdown!";
  } else {
    if (isBreakoutQuery) response += "\u{1F525} <b>Breakout Scan</b>\n\n";
    else response += "\u{1F4CA} <b>Market Snapshot</b>\n\n";
    const buyStocks = analysisResults.filter(d => d.signal.includes("BUY")).sort((a, b) => b.changePercent - a.changePercent);
    const sellStocks = analysisResults.filter(d => d.signal.includes("SELL")).sort((a, b) => a.changePercent - b.changePercent);
    const holdStocks = analysisResults.filter(d => d.signal === "HOLD");
    if (buyStocks.length > 0) {
      response += "\u{1F7E2} <b>Bullish</b>\n";
      for (const d of buyStocks.slice(0, 5)) response += "  " + d.name + " \u20B9" + d.price + " (" + (d.changePercent >= 0 ? "+" : "") + d.changePercent + "%) \u2014 " + d.signal + " RSI " + d.rsi + "\n";
      response += "\n";
    }
    if (sellStocks.length > 0) {
      response += "\u{1F534} <b>Bearish</b>\n";
      for (const d of sellStocks.slice(0, 5)) response += "  " + d.name + " \u20B9" + d.price + " (" + (d.changePercent >= 0 ? "+" : "") + d.changePercent + "%) \u2014 " + d.signal + " RSI " + d.rsi + "\n";
      response += "\n";
    }
    if (holdStocks.length > 0) {
      response += "\u{1F7E1} <b>Neutral</b>\n";
      for (const d of holdStocks.slice(0, 3)) response += "  " + d.name + " \u20B9" + d.price + " (" + (d.changePercent >= 0 ? "+" : "") + d.changePercent + "%) \u2014 HOLD\n";
    }
    response += "\nAsk me about any stock for detailed analysis!";
  }

  return Response.json({ success: true, response: response, conversation_id: convId || crypto.randomUUID() });
});
