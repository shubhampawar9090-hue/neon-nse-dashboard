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

  try {
    // Parse stock symbols from the query
    const knownStocks = [
      "RELIANCE","TCS","HDFCBANK","INFY","ICICIBANK","SBIN","TATAMOTORS",
      "BHARTIARTL","ITC","LT","AXISBANK","KOTAKBANK","MARUTI","WIPRO",
      "HCLTECH","SUNPHARMA","ULTRACEMCO","ASIANPAINT","NESTLEIND","BAJFINANCE",
      "TITAN","TATASTEEL","NTPC","POWERGRID","ONGC","COALINDIA","ADANIENT",
      "ADANIPORTS","JSWSTEEL","BAJAJFINSV","GRASIM","HINDALCO","TECHM",
      "DIVISLAB","DRREDDY","CIPLA","BRITANNIA","HEROMOTOCO","EICHERMOT",
      "UPL","SHRIRAMFIN","BAJAJ-AUTO","BPCL","INDUSINDBK","TATACONSUM",
      "M&M","LTIM","SBILIFE","HDFCLIFE","TATAPOWER","DMART","PIDILITIND"
    ];
    
    const indices = [
      { sym: "^NSEI", name: "NIFTY 50" },
      { sym: "^BSESN", name: "SENSEX" },
      { sym: "^NSEBANK", name: "BANK NIFTY" },
      { sym: "^CNXIT", name: "NIFTY IT" },
      { sym: "^CNXAUTO", name: "NIFTY AUTO" },
      { sym: "^CNXPHARMA", name: "NIFTY PHARMA" }
    ];

    const queryUpper = query.toUpperCase();
    let symbols = [];
    
    // Check for index names
    for (const idx of indices) {
      if (queryUpper.includes(idx.name.toUpperCase()) || queryUpper.includes(idx.sym)) {
        symbols.push(idx.sym);
      }
    }
    
    // Check for stock names
    for (const stock of knownStocks) {
      if (queryUpper.includes(stock)) {
        symbols.push(stock + ".NS");
      }
    }
    
    // Check for explicit .NS symbols in the query
    const nsMatches = queryUpper.match(/[A-Z&\-]+\.NS/g);
    if (nsMatches) {
      for (const m of nsMatches) {
        if (!symbols.includes(m)) symbols.push(m);
      }
    }

    // If no symbols found, try to detect any ALLCAPS word as a potential stock
    if (symbols.length === 0) {
      const words = queryUpper.match(/\b[A-Z]{3,}\b/g);
      if (words) {
        for (const w of words) {
          if (knownStocks.includes(w)) {
            symbols.push(w + ".NS");
          }
        }
      }
    }

    // Detect intent type
    const isMarketQuery = /market|nifty|sensex|index|indices|overall|how.*(market|doing|today)/i.test(query);
    const isAnalysisQuery = /analy[sz]e|analysis|technical|indicator|ema|rsi|vwap|atr|signal|buy|sell|breakout|pattern|support|resistance|trend|momentum|strength|weakness|outlook|forecast|predict|target|sl|stop.?loss|tp|take.?profit/i.test(query);
    const isComparison = /vs|versus|compare|better|which.*(stock|better|best)/i.test(query);
    const isGreeting = /hi|hello|hey|help|what.*can.*you|who.*are/i.test(query);

    // Handle greeting / help
    if (isGreeting && symbols.length === 0) {
      return Response.json({
        success: true,
        response: "👋 Hi! I'm <b>Elara</b> — your AI trading assistant.\n\nI can analyze <b>ANY NSE stock</b> using live Yahoo Finance data. Ask me things like:\n\n• <b>\"Analyze RELIANCE\"</b> — full technical breakdown\n• <b>\"TCS buy or sell?\"</b> — signal with SL/TP\n• <b>\"Breakout stocks today\"</b> — screener results\n• <b>\"NIFTY outlook\"</b> — index analysis\n\nJust type a stock name or ask about market trends!",
        conversation_id: convId || crypto.randomUUID()
      });
    }

    // If no symbols found and not a greeting
    if (symbols.length === 0) {
      // Try to fetch index data for a general market query
      if (isMarketQuery) {
        symbols = ["^NSEI", "^BSESN", "^NSEBANK"];
      } else {
        return Response.json({
          success: true,
          response: "I couldn't identify a stock in your question. Try mentioning a stock name like <b>RELIANCE</b>, <b>TCS</b>, <b>HDFCBANK</b>, or an index like <b>NIFTY 50</b> or <b>SENSEX</b>.\n\nExample: <i>\"Analyze RELIANCE\"</i> or <i>\"NIFTY 50 outlook\"</i>",
          conversation_id: convId || crypto.randomUUID()
        });
      }
    }

    // Fetch data for all identified symbols
    const analysisResults = [];
    for (const sym of symbols.slice(0, 5)) {
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

        // EMA
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

        // RSI
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

        // VWAP
        let totalPV = 0, totalV = 0;
        for (let i = 0; i < closes.length; i++) {
          totalPV += ((highs[i] + lows[i] + closes[i]) / 3) * (volumes[i] || 0);
          totalV += volumes[i] || 0;
        }
        const vwap = totalV > 0 ? parseFloat((totalPV / totalV).toFixed(2)) : null;

        // ATR
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

        // Volume ratio
        const avgVol = volumes.length > 10 ? volumes.slice(-11, -1).reduce((a, b) => a + b, 0) / 10 : 0;
        const volumeRatio = avgVol > 0 ? parseFloat((volumes[volumes.length - 1] / avgVol).toFixed(2)) : 1;

        // Pattern
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
          else pattern = "Consolidation";
        }

        // Signal
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

        // SL/TP
        const direction = buyScore > sellScore ? 1 : -1;
        const sl = atr ? parseFloat((price - atr * direction).toFixed(2)) : null;
        const tp1 = atr ? parseFloat((price + atr * 1.5 * direction).toFixed(2)) : null;
        const tp2 = atr ? parseFloat((price + atr * 2 * direction).toFixed(2)) : null;

        // Display name
        let displayName = sym;
        const idxMap = { "^NSEI": "NIFTY 50", "^BSESN": "SENSEX", "^NSEBANK": "BANK NIFTY", "^CNXIT": "NIFTY IT", "^CNXAUTO": "NIFTY AUTO", "^CNXPHARMA": "NIFTY PHARMA" };
        if (idxMap[sym]) displayName = idxMap[sym];
        else displayName = sym.replace(/\.NS$/, "");

        analysisResults.push({
          symbol: sym,
          name: displayName,
          price: parseFloat(price.toFixed(2)),
          changePercent,
          ema5, ema13, ema26,
          rsi, vwap, atr,
          volumeRatio,
          pattern,
          signal,
          sl, tp1, tp2,
          fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh,
          fiftyTwoWeekLow: meta.fiftyTwoWeekLow,
          dayHigh: meta.regularMarketDayHigh,
          dayLow: meta.regularMarketDayLow,
          isIndex: sym.startsWith("^")
        });
      } catch (e) {
        // skip this symbol
      }
    }

    if (analysisResults.length === 0) {
      return Response.json({
        success: true,
        response: "I couldn't fetch live data for that stock right now. Yahoo Finance might be rate-limiting. Please try again in a few seconds.",
        conversation_id: convId || crypto.randomUUID()
      });
    }

    // Build response
    let response = "";
    
    if (analysisResults.length === 1) {
      const d = analysisResults[0];
      const changeIcon = d.changePercent >= 0 ? "🟢" : "🔴";
      const signalEmoji = d.signal.includes("BUY") ? "🟢" : d.signal.includes("SELL") ? "🔴" : "🟡";
      
      response = `<b>${d.name}</b> — ${changeIcon} ₹${d.price} (${d.changePercent >= 0 ? "+" : ""}${d.changePercent}%)\n\n`;
      response += `<b>${signalEmoji} Signal: ${d.signal}</b>\n\n`;
      
      response += "<b>📊 Technical Indicators</b>\n";
      response += `• EMA 5/13/26: ${d.ema5} / ${d.ema13} / ${d.ema26}\n`;
      const emaStack = d.ema5 > d.ema13 && d.ema13 > d.ema26 ? "Bullish ↑" : d.ema5 < d.ema13 && d.ema13 < d.ema26 ? "Bearish ↓" : "Mixed";
      response += `• EMA Stack: <b>${emaStack}</b>\n`;
      response += `• RSI (14): ${d.rsi} ${d.rsi < 30 ? "(Oversold)" : d.rsi > 70 ? "(Overbought)" : "(Neutral)"}\n`;
      response += `• VWAP: ${d.vwap} ${d.price > d.vwap ? "(Above ✓)" : "(Below ✗)"}\n`;
      response += `• ATR (14): ${d.atr}\n`;
      response += `• Volume Ratio: ${d.volumeRatio}x ${d.volumeRatio > 1.5 ? "(Surge!)" : ""}\n`;
      response += `• Pattern: ${d.pattern}\n\n`;
      
      response += "<b>🎯 Trade Levels</b>\n";
      if (d.sl) response += `• Stop Loss: ₹${d.sl}\n`;
      if (d.tp1) response += `• Target 1: ₹${d.tp1}\n`;
      if (d.tp2) response += `• Target 2: ₹${d.tp2}\n`;
      response += `• Day High/Low: ₹${d.dayHigh} / ₹${d.dayLow}\n`;
      response += `• 52W High/Low: ₹${d.fiftyTwoWeekHigh} / ₹${d.fiftyTwoWeekLow}\n\n`;
      
      // Verdict
      if (d.signal.includes("BUY")) {
        response += "<b>💡 Verdict:</b> Bullish setup. EMA stack aligned, price " + (d.price > d.vwap ? "above VWAP" : "near VWAP") + ", RSI at " + d.rsi + ". Look for entry on dips with SL below ₹" + d.sl + ".";
      } else if (d.signal.includes("SELL")) {
        response += "<b>💡 Verdict:</b> Bearish pressure. EMA stack bearish" + (d.price < d.vwap ? ", below VWAP" : "") + ", RSI at " + d.rsi + ". Consider exiting or shorting with SL above ₹" + d.sl + ".";
      } else {
        response += "<b>💡 Verdict:</b> Sideways/neutral. Wait for a clear breakout above ₹" + d.dayHigh + " or breakdown below ₹" + d.dayLow + " before taking a position.";
      }
    } else {
      // Multi-stock response
      response += "📊 <b>Market Snapshot</b>\n\n";
      for (const d of analysisResults) {
        const signalEmoji = d.signal.includes("BUY") ? "🟢" : d.signal.includes("SELL") ? "🔴" : "🟡";
        response += `<b>${d.name}</b> ${signalEmoji} ₹${d.price} (${d.changePercent >= 0 ? "+" : ""}${d.changePercent}%)\n`;
        response += `  ${d.signal} • RSI ${d.rsi} • ${d.pattern} • Vol ${d.volumeRatio}x\n\n`;
      }
      response += "Ask me about any specific stock for a detailed breakdown!";
    }

    return Response.json({
      success: true,
      response: response,
      conversation_id: convId || crypto.randomUUID()
    });

  } catch (e) {
    return Response.json({
      success: true,
      response: "I ran into an error analyzing that. Please try again or rephrase your question.",
      conversation_id: convId || crypto.randomUUID()
    });
  }
});
