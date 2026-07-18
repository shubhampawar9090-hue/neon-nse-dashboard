import { createClientFromRequest } from "npm:@base44/sdk@0.8.31";

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);
  
  let body;
  try { body = await req.json(); } catch { body = {}; }
  const query = body.content || body.query || "";
  const convId = body.conversation_id || null;

  if (!query.trim()) {
    return Response.json({ success: false, error: "No question provided" });
  }

  // Expanded stock list with aliases
  const stockAliases = {
    "RELIANCE.NS": ["reliance", "reliance industries", "ril", "mukesh ambani"],
    "TCS.NS": ["tcs", "tata consultancy", "tata consult"],
    "HDFCBANK.NS": ["hdfc bank", "hdfcbank", "hdfc"],
    "INFY.NS": ["infy", "infosys", "infosys limited"],
    "ICICIBANK.NS": ["icici bank", "icicibank", "icici"],
    "SBIN.NS": ["sbin", "state bank", "sbi"],
    "TATAMOTORS.NS": ["tata motors", "tatamotors", "tata motor"],
    "BHARTIARTL.NS": ["bharti airtel", "bhartiartl", "airtel"],
    "ITC.NS": ["itc", "itc limited"],
    "LT.NS": ["lt", "larsen", "l&t", "larsen toubro", "l and t"],
    "AXISBANK.NS": ["axis bank", "axisbank", "axis"],
    "KOTAKBANK.NS": ["kotak bank", "kotakbank", "kotak"],
    "MARUTI.NS": ["maruti", "maruti suzuki"],
    "WIPRO.NS": ["wipro"],
    "HCLTECH.NS": ["hcl tech", "hcltech", "hcl"],
    "SUNPHARMA.NS": ["sun pharma", "sunpharma", "sun pharmaceutical"],
    "ULTRACEMCO.NS": ["ultracemco", "ultra tech", "ultratech"],
    "ASIANPAINT.NS": ["asian paints", "asianpaint", "asian paint"],
    "NESTLEIND.NS": ["nestle", "nestleind", "nestle india"],
    "BAJFINANCE.NS": ["bajaj finance", "bajfinance", "bajaj fin"],
    "TITAN.NS": ["titan", "titan company"],
    "TATASTEEL.NS": ["tata steel", "tatasteel"],
    "NTPC.NS": ["ntpc"],
    "POWERGRID.NS": ["powergrid", "power grid", "power grid corp"],
    "ONGC.NS": ["ongc", "oil and natural gas"],
    "COALINDIA.NS": ["coal india", "coalindia"],
    "ADANIENT.NS": ["adani enterprises", "adanient", "adani ent"],
    "ADANIPORTS.NS": ["adani ports", "adaniports", "adani port"],
    "JSWSTEEL.NS": ["jsw steel", "jswsteel"],
    "BAJAJFINSV.NS": ["bajaj finserv", "bajajfinsv", "bajaj finserv"],
    "GRASIM.NS": ["grasim", "grasim industries"],
    "HINDALCO.NS": ["hindalco", "hindalco industries"],
    "TECHM.NS": ["techm", "tech mahindra", "tech m"],
    "DIVISLAB.NS": ["divis lab", "divislab", "divi's lab"],
    "DRREDDY.NS": ["dr reddy", "drreddy", "dr reddy's lab"],
    "CIPLA.NS": ["cipla"],
    "BRITANNIA.NS": ["britannia", "britannia industries"],
    "HEROMOTOCO.NS": ["hero motocorp", "heromotoco", "hero moto"],
    "EICHERMOT.NS": ["eicher motor", "eichermot", "eicher motors"],
    "UPL.NS": ["upl"],
    "SHRIRAMFIN.NS": ["shriram finance", "shriramfin", "shriram fin"],
    "BAJAJ-AUTO.NS": ["bajaj auto", "bajaj-auto", "bajaj motorcycle"],
    "BPCL.NS": ["bpcl", "bharat petroleum"],
    "INDUSINDBK.NS": ["indusind bank", "indusindbk", "indusind"],
    "TATACONSUM.NS": ["tata consumer", "tataconsum", "tata consumer products"],
    "M&M.NS": ["mahindra", "m&m", "m and m", "mahindra & mahindra"],
    "LTIM.NS": ["ltim", "lti mindtree", "lti"],
    "SBILIFE.NS": ["sbi life", "sbilife", "sbi life insurance"],
    "HDFCLIFE.NS": ["hdfc life", "hdfclife", "hdfc life insurance"],
    "TATAPOWER.NS": ["tata power", "tatapower"],
    "DMART.NS": ["dmart", "avenue supermarts", "avenue supermart"],
    "PIDILITIND.NS": ["pidilite", "pidilitind", "pidilite industries"],
    "ZOMATO.NS": ["zomato"],
    "PAYTM.NS": ["paytm", "one97"],
    "NYKAA.NS": ["nykaa", "nykaa fsn"],
    "POLICYBZR.NS": ["policybazaar", "policybzr", "policy bazaar"],
    "IRCTC.NS": ["irctc", "indian railway catering"],
    "DLF.NS": ["dlf"],
    "VEDL.NS": ["vedanta", "vedl"],
    "HINDUNILVR.NS": ["hindustan unilever", "hindunilvr", "hul"],
    "SIEMENS.NS": ["siemens"],
    "TATAELXSI.NS": ["tata elxsi", "tataelxsi"],
    "BEL.NS": ["bel", "bharat electronics"],
    "HAL.NS": ["hal", "hindustan aeronautics"],
    "PFC.NS": ["pfc", "power finance corp"],
    "RECLTD.NS": ["rec ltd", "recltd", "rec limited"],
    "MOTHERSON.NS": ["motherson", "mothersummi", "samvardhana motherson"],
    "BHEL.NS": ["bhel", "bharat heavy electricals"],
    "GAIL.NS": ["gail", "gail india"],
    "IOC.NS": ["ioc", "indian oil"],
    "NMDC.NS": ["nmdc"],
    "BANKBARODA.NS": ["bank of baroda", "bankbaroda", "bob", "baroda"],
    "PNB.NS": ["pnb", "punjab national bank"],
    "CANBK.NS": ["canara bank", "canbk"],
    "UNIONBANK.NS": ["union bank", "unionbank"],
    "IDFCFIRSTB.NS": ["idfc first bank", "idfcfirstb", "idfc first"],
    "FEDERALBNK.NS": ["federal bank", "federalbnk"],
    "IIFL.NS": ["iifl", "india infoline"],
    "MANAPPURAM.NS": ["manappuram"],
    "MUTHOOTFIN.NS": ["muthoot", "muthootfin", "muthoot finance"]
  };

  const indices = [
    { sym: "^NSEI", name: "NIFTY 50", aliases: ["nifty 50", "nifty50", "nifty", "^nsei", "nsei"] },
    { sym: "^BSESN", name: "SENSEX", aliases: ["sensex", "^bsesn", "bsesn", "bombay stock", "bse"] },
    { sym: "^NSEBANK", name: "BANK NIFTY", aliases: ["bank nifty", "banknifty", "nsebank", "^nsebank", "bank nifty 50"] },
    { sym: "^CNXIT", name: "NIFTY IT", aliases: ["nifty it", "cnxit", "it index"] },
    { sym: "^CNXAUTO", name: "NIFTY AUTO", aliases: ["nifty auto", "cnxauto", "auto index"] },
    { sym: "^CNXPHARMA", name: "NIFTY PHARMA", aliases: ["nifty pharma", "cnxpharma", "pharma index"] }
  ];

  const queryLower = query.toLowerCase().trim();
  let symbols = [];

  // Check indices first (more specific)
  for (const idx of indices) {
    for (const alias of idx.aliases) {
      if (queryLower.includes(alias.toLowerCase())) {
        if (!symbols.includes(idx.sym)) symbols.push(idx.sym);
        break;
      }
    }
  }

  // Check stock aliases
  for (const [ticker, aliases] of Object.entries(stockAliases)) {
    for (const alias of aliases) {
      if (queryLower.includes(alias.toLowerCase())) {
        if (!symbols.includes(ticker)) symbols.push(ticker);
        break;
      }
    }
  }

  // Check for explicit .NS or .BO symbols
  const nsMatches = query.match(/[A-Z&\-\.]+\.NS/gi);
  if (nsMatches) {
    for (const m of nsMatches) {
      const sym = m.toUpperCase();
      if (!symbols.includes(sym)) symbols.push(sym);
    }
  }

  // Detect intent
  const isMarketQuery = /market|nifty|sensex|index|indices|overall|how.*(market|doing|today|sector)|top.*(gainer|loser|stock)|best.*(stock|buy)|trend|outlook/i.test(query);
  const isGreeting = /^\s*(hi|hello|hey|yo|sup|namaste|hii|help|what.*can.*you|who.*are|start)\b/i.test(query);
  const isBreakoutQuery = /breakout|breakdown|screening|screener|scan|hot stock|momentum stock|pick/i.test(query);
  const isBuySell = /buy|sell|hold|long|short|entry|exit|should i/i.test(query);

  // Handle greeting
  if (isGreeting && symbols.length === 0) {
    return Response.json({
      success: true,
      response: "👋 Hi! I'm <b>Elara</b> — your AI trading assistant.\n\nI can analyze <b>ANY NSE stock</b> using live Yahoo Finance data. Try:\n\n• <b>\"Analyze Reliance\"</b> — full technical breakdown\n• <b>\"TCS buy or sell?\"</b> — signal with SL/TP\n• <b>\"NIFTY 50 outlook\"</b> — index analysis\n• <b>\"Tata Motors signal\"</b> — any stock\n• <b>\"Market today\"</b> — all indices snapshot\n\nI recognize 80+ NSE stocks by name — just type naturally!",
      conversation_id: convId || crypto.randomUUID()
    });
  }

  // If no symbols found, fall back to market overview
  if (symbols.length === 0) {
    if (isBreakoutQuery) {
      // Return top NIFTY stocks for breakout scanning
      symbols = ["^NSEI", "RELIANCE.NS", "TCS.NS", "HDFCBANK.NS", "INFY.NS", "ICICIBANK.NS", "SBIN.NS", "TATAMOTORS.NS", "BHARTIARTL.NS", "ADANIENT.NS"];
    } else if (isMarketQuery || isBuySell) {
      symbols = ["^NSEI", "^BSESN", "^NSEBANK"];
    } else {
      // Even if we can't parse the query, show market overview
      symbols = ["^NSEI", "^BSESN", "^NSEBANK"];
    }
  }

  // Fetch data for all identified symbols
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
      let patternType = "neutral";
      if (last20.length >= 10) {
        const n = last20.length;
        const sumX = n * (n - 1) / 2;
        const sumY = last20.reduce((a, b) => a + b, 0);
        const sumXY = last20.reduce((s, y, x) => s + x * y, 0);
        const sumX2 = n * (n - 1) * (2 * n - 1) / 6;
        const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
        const slopePct = (slope / (sumY / n)) * 100;
        if (slopePct > 0.3) { pattern = "Uptrend"; patternType = "bullish"; }
        else if (slopePct < -0.3) { pattern = "Downtrend"; patternType = "bearish"; }
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
        dayHigh: meta.regularMarketDayHigh, dayLow: meta.regularMarketDayLow,
        isIndex: sym.startsWith("^")
      });
    } catch (e) {}
  }

  if (analysisResults.length === 0) {
    return Response.json({
      success: true,
      response: "I couldn't fetch live data right now — Yahoo Finance might be rate-limiting. Please try again in a few seconds.",
      conversation_id: convId || crypto.randomUUID()
    });
  }

  let response = "";

  if (analysisResults.length === 1) {
    // Single stock — detailed analysis
    const d = analysisResults[0];
    const changeIcon = d.changePercent >= 0 ? "🟢" : "🔴";
    const signalEmoji = d.signal.includes("BUY") ? "🟢" : d.signal.includes("SELL") ? "🔴" : "🟡";

    response = "<b>" + d.name + "</b> — " + changeIcon + " ₹" + d.price + " (" + (d.changePercent >= 0 ? "+" : "") + d.changePercent + "%)\n\n";
    response += "<b>" + signalEmoji + " Signal: " + d.signal + "</b>\n\n";
    response += "<b>📊 Technical Indicators</b>\n";
    response += "• EMA 5/13/26: " + d.ema5 + " / " + d.ema13 + " / " + d.ema26 + "\n";
    const emaStack = d.ema5 > d.ema13 && d.ema13 > d.ema26 ? "Bullish ↑" : d.ema5 < d.ema13 && d.ema13 < d.ema26 ? "Bearish ↓" : "Mixed";
    response += "• EMA Stack: <b>" + emaStack + "</b>\n";
    response += "• RSI (14): " + d.rsi + (d.rsi < 30 ? " (Oversold)" : d.rsi > 70 ? " (Overbought)" : " (Neutral)") + "\n";
    response += "• VWAP: " + (d.vwap || "N/A") + (d.vwap ? (d.price > d.vwap ? " (Above ✓)" : " (Below ✗)") : "") + "\n";
    response += "• ATR (14): " + d.atr + "\n";
    response += "• Volume Ratio: " + d.volumeRatio + "x" + (d.volumeRatio > 1.5 ? " (Surge!)" : "") + "\n";
    response += "• Pattern: " + d.pattern + "\n\n";
    response += "<b>🎯 Trade Levels</b>\n";
    if (d.sl) response += "• Stop Loss: ₹" + d.sl + "\n";
    if (d.tp1) response += "• Target 1: ₹" + d.tp1 + "\n";
    if (d.tp2) response += "• Target 2: ₹" + d.tp2 + "\n";
    response += "• Day High/Low: ₹" + d.dayHigh + " / ₹" + d.dayLow + "\n";
    response += "• 52W High/Low: ₹" + d.fiftyTwoWeekHigh + " / ₹" + d.fiftyTwoWeekLow + "\n\n";

    if (d.signal.includes("BUY")) {
      response += "<b>💡 Verdict:</b> Bullish setup. EMA stack aligned, price " + (d.price > d.vwap ? "above VWAP" : "near VWAP") + ", RSI at " + d.rsi + ". Look for entry on dips with SL below ₹" + d.sl + ".";
    } else if (d.signal.includes("SELL")) {
      response += "<b>💡 Verdict:</b> Bearish pressure. EMA stack bearish" + (d.price < d.vwap ? ", below VWAP" : "") + ", RSI at " + d.rsi + ". Consider exiting or shorting with SL above ₹" + d.sl + ".";
    } else {
      response += "<b>💡 Verdict:</b> Sideways/neutral. Wait for a clear breakout above ₹" + d.dayHigh + " or breakdown below ₹" + d.dayLow + " before taking a position.";
    }
  } else if (analysisResults.length <= 3) {
    // 2-3 stocks — medium detail
    for (const d of analysisResults) {
      const signalEmoji = d.signal.includes("BUY") ? "🟢" : d.signal.includes("SELL") ? "🔴" : "🟡";
      response += "<b>" + d.name + "</b> " + signalEmoji + " ₹" + d.price + " (" + (d.changePercent >= 0 ? "+" : "") + d.changePercent + "%)\n";
      response += "  " + d.signal + " • EMA " + d.ema5 + "/" + d.ema13 + "/" + d.ema26 + " • RSI " + d.rsi + " • " + d.pattern + "\n";
      if (d.sl) response += "  SL: ₹" + d.sl + " • TP: ₹" + d.tp1 + " / ₹" + d.tp2 + "\n";
      response += "\n";
    }
    response += "Ask me about any specific stock for a full detailed breakdown!";
  } else {
    // 4+ stocks — compact screener view
    if (isBreakoutQuery) {
      response += "🔥 <b>Breakout Scan</b>\n\n";
    } else {
      response += "📊 <b>Market Snapshot</b>\n\n";
    }

    const buyStocks = analysisResults.filter(d => d.signal.includes("BUY")).sort((a, b) => b.changePercent - a.changePercent);
    const sellStocks = analysisResults.filter(d => d.signal.includes("SELL")).sort((a, b) => a.changePercent - b.changePercent);
    const holdStocks = analysisResults.filter(d => d.signal === "HOLD");

    if (buyStocks.length > 0) {
      response += "🟢 <b>Bullish</b>\n";
      for (const d of buyStocks.slice(0, 5)) {
        response += "  " + d.name + " ₹" + d.price + " (" + (d.changePercent >= 0 ? "+" : "") + d.changePercent + "%) — " + d.signal + " RSI " + d.rsi + "\n";
      }
      response += "\n";
    }
    if (sellStocks.length > 0) {
      response += "🔴 <b>Bearish</b>\n";
      for (const d of sellStocks.slice(0, 5)) {
        response += "  " + d.name + " ₹" + d.price + " (" + (d.changePercent >= 0 ? "+" : "") + d.changePercent + "%) — " + d.signal + " RSI " + d.rsi + "\n";
      }
      response += "\n";
    }
    if (holdStocks.length > 0) {
      response += "🟡 <b>Neutral</b>\n";
      for (const d of holdStocks.slice(0, 3)) {
        response += "  " + d.name + " ₹" + d.price + " (" + (d.changePercent >= 0 ? "+" : "") + d.changePercent + "%) — HOLD\n";
      }
    }
    response += "\nAsk me about any stock for detailed analysis!";
  }

  return Response.json({
    success: true,
    response: response,
    conversation_id: convId || crypto.randomUUID()
  });
});
