import { createClientFromRequest } from "npm:@base44/sdk@0.8.31";

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);
  
  let body;
  try { body = await req.json(); } catch { body = {}; }
  const symbols = body.symbols || [];
  const timeframe = body.timeframe || "intraday";
  if (!symbols.length) return Response.json({ success: false, error: "No symbols provided" });

  const isIntraday = timeframe === "intraday";
  const interval = isIntraday ? "5m" : "1d";
  const range = isIntraday ? "5d" : "3mo";
  const emaPeriods = isIntraday ? [5, 13, 26] : [9, 21, 50];
  const results = [];
  const BATCH = 3;

  for (let i = 0; i < symbols.length; i += BATCH) {
    const batch = symbols.slice(i, i + BATCH);
    const promises = batch.map(async (sym) => {
      try {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=${interval}&range=${range}`;
        const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
        if (!res.ok) return { symbol: sym, error: true };
        const json = await res.json();
        const result = json.chart?.result?.[0];
        if (!result) return { symbol: sym, error: true };

        const meta = result.meta;
        const quotes = result.indicators?.quote?.[0] || {};
        const closes = quotes.close?.filter(v => v != null) || [];
        const highs = quotes.high?.filter(v => v != null) || [];
        const lows = quotes.low?.filter(v => v != null) || [];
        const opens = quotes.open?.filter(v => v != null) || [];
        const volumes = quotes.volume?.filter(v => v != null) || [];

        if (closes.length < 10) return { symbol: sym, error: true };

        const price = meta.regularMarketPrice || closes[closes.length - 1];
        const prevClose = meta.chartPreviousClose || meta.previousClose || closes[closes.length - 2] || price;
        const changePercent = prevClose ? parseFloat(((price - prevClose) / prevClose * 100).toFixed(2)) : 0;

        // EMA (final value + full series for crossover detection)
        function calcEMA(data, period) {
          if (data.length < period) return null;
          const k = 2 / (period + 1);
          let ema = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
          for (let i = period; i < data.length; i++) ema = data[i] * k + ema * (1 - k);
          return parseFloat(ema.toFixed(2));
        }
        function calcEMASeries(data, period) {
          if (data.length < period) return [];
          const k = 2 / (period + 1);
          const series = [];
          let ema = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
          series.push(ema);
          for (let i = period; i < data.length; i++) { ema = data[i] * k + ema * (1 - k); series.push(ema); }
          return series;
        }
        const [ema1, ema2, ema3] = emaPeriods.map(p => calcEMA(closes, p));
        const ema1Series = calcEMASeries(closes, emaPeriods[0]);
        const ema2Series = calcEMASeries(closes, emaPeriods[1]);
        const ema3Series = calcEMASeries(closes, emaPeriods[2]);

        // ===== EMA CROSSOVER DETECTION =====
        // Detect Golden Cross (fast crosses ABOVE slow) and Death Cross (fast crosses BELOW slow)
        let emaCrossSignal = "None";
        let emaCrossType = "none"; // bullish / bearish / none
        let emaCrossLabel = "";
        let emaCrossBars = 0; // candles since crossover
        let emaCrossPrice = null; // price at crossover

        // EMA1/EMA2 crossover (fast/mid)
        if (ema1Series.length >= 2 && ema2Series.length >= 2) {
          const len = Math.min(ema1Series.length, ema2Series.length);
          const minLen = Math.min(len, 30); // look back up to 30 candles
          for (let i = len - 1; i > 0 && i >= len - minLen; i--) {
            const fastPrev = ema1Series[i - 1], slowPrev = ema2Series[i - 1];
            const fastCur = ema1Series[i], slowCur = ema2Series[i];
            // Bullish crossover: fast was below slow, now above
            if (fastPrev <= slowPrev && fastCur > slowCur) {
              emaCrossSignal = "Golden Cross";
              emaCrossType = "bullish";
              emaCrossBars = len - 1 - i;
              emaCrossLabel = "EMA" + emaPeriods[0] + " \u2191 EMA" + emaPeriods[1];
              emaCrossPrice = parseFloat(closes[i].toFixed(2));
              break;
            }
            // Bearish crossover: fast was above slow, now below
            if (fastPrev >= slowPrev && fastCur < slowCur) {
              emaCrossSignal = "Death Cross";
              emaCrossType = "bearish";
              emaCrossBars = len - 1 - i;
              emaCrossLabel = "EMA" + emaPeriods[0] + " \u2193 EMA" + emaPeriods[1];
              emaCrossPrice = parseFloat(closes[i].toFixed(2));
              break;
            }
          }
        }

        // EMA2/EMA3 crossover (mid/slow) — only if no fast/mid cross found
        if (emaCrossSignal === "None" && ema2Series.length >= 2 && ema3Series.length >= 2) {
          const len = Math.min(ema2Series.length, ema3Series.length);
          const minLen = Math.min(len, 30);
          for (let i = len - 1; i > 0 && i >= len - minLen; i--) {
            const fastPrev = ema2Series[i - 1], slowPrev = ema3Series[i - 1];
            const fastCur = ema2Series[i], slowCur = ema3Series[i];
            if (fastPrev <= slowPrev && fastCur > slowCur) {
              emaCrossSignal = "Golden Cross";
              emaCrossType = "bullish";
              emaCrossBars = len - 1 - i;
              emaCrossLabel = "EMA" + emaPeriods[1] + " \u2191 EMA" + emaPeriods[2];
              emaCrossPrice = parseFloat(closes[i].toFixed(2));
              break;
            }
            if (fastPrev >= slowPrev && fastCur < slowCur) {
              emaCrossSignal = "Death Cross";
              emaCrossType = "bearish";
              emaCrossBars = len - 1 - i;
              emaCrossLabel = "EMA" + emaPeriods[1] + " \u2193 EMA" + emaPeriods[2];
              emaCrossPrice = parseFloat(closes[i].toFixed(2));
              break;
            }
          }
        }

        // Crossover freshness: "Fresh" (≤3 bars), "Recent" (≤10), "Fading" (>10)
        let emaCrossFreshness = "None";
        if (emaCrossSignal !== "None") {
          if (emaCrossBars <= 3) emaCrossFreshness = "Fresh";
          else if (emaCrossBars <= 10) emaCrossFreshness = "Recent";
          else emaCrossFreshness = "Fading";
        }

        // RSI 14
        function calcRSI(data, period) {
          if (!period) period = 14;
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
          const rs = avgGain / avgLoss;
          return parseFloat((100 - 100 / (1 + rs)).toFixed(1));
        }
        const rsi = calcRSI(closes, 14);

        // VWAP
        function calcVWAP() {
          let totalPV = 0, totalV = 0;
          for (let i = 0; i < closes.length; i++) {
            const tp = (highs[i] + lows[i] + closes[i]) / 3;
            const v = volumes[i] || 0;
            totalPV += tp * v; totalV += v;
          }
          return totalV > 0 ? parseFloat((totalPV / totalV).toFixed(2)) : null;
        }
        const vwap = calcVWAP();

        // ATR 14
        function calcATR(p) {
          if (!p) p = 14;
          if (closes.length < p + 1) return null;
          const trs = [];
          for (let i = 1; i < closes.length; i++) {
            const tr = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
            trs.push(tr);
          }
          let atr = trs.slice(0, p).reduce((a, b) => a + b, 0) / p;
          for (let i = p; i < trs.length; i++) atr = (atr * (p - 1) + trs[i]) / p;
          return parseFloat(atr.toFixed(2));
        }
        const atr = calcATR(14);
        const atrPercent = atr && price ? parseFloat(((atr / price) * 100).toFixed(2)) : null;

        function calcATRAt(idx, p) {
          if (!p) p = 14;
          if (idx < p) return null;
          const trs = [];
          for (let i = 1; i <= idx; i++) {
            const tr = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
            trs.push(tr);
          }
          let a = trs.slice(0, p).reduce((x, y) => x + y, 0) / p;
          for (let i = p; i < trs.length; i++) a = (a * (p - 1) + trs[i]) / p;
          return a;
        }
        const recentATR = calcATRAt(closes.length - 1);
        const olderATR = calcATRAt(Math.max(14, closes.length - 11));
        const atrExpanding = recentATR && olderATR ? recentATR > olderATR * 1.15 : false;

        // Volume Ratio
        const volPeriod = isIntraday ? 10 : 20;
        const avgVol = volumes.length > volPeriod ? volumes.slice(-volPeriod - 1, -1).reduce((a, b) => a + b, 0) / volPeriod : 0;
        const curVol = volumes[volumes.length - 1] || 0;
        const volumeRatio = avgVol > 0 ? parseFloat((curVol / avgVol).toFixed(2)) : 1;

        // Volatility
        let volatility = "Normal";
        if (atrPercent != null) {
          if (atrPercent > 3) volatility = "High";
          else if (atrPercent < 1) volatility = "Low";
        }

        // ATR Trend
        let atrTrend = "Stable";
        if (atrExpanding) {
          if (changePercent > 0) atrTrend = "Bullish Expansion";
          else if (changePercent < 0) atrTrend = "Bearish Expansion";
        }

        // EMA Stack
        let emaBullish = false, emaBearish = false, emaLabel = "—";
        if (ema1 && ema2 && ema3) {
          emaLabel = "EMA " + emaPeriods[0] + "/" + emaPeriods[1] + "/" + emaPeriods[2];
          if (ema1 > ema2 && ema2 > ema3) { emaBullish = true; emaLabel += " ↑"; }
          if (ema1 < ema2 && ema2 < ema3) { emaBearish = true; emaLabel += " ↓"; }
        }

        // Trend
        let trend = "Sideways";
        if (ema1 && ema2) {
          if (ema1 > ema2 && price > ema1) trend = "Uptrend";
          else if (ema1 < ema2 && price < ema1) trend = "Downtrend";
          else if (ema1 > ema2) trend = "Mild Uptrend";
          else trend = "Mild Downtrend";
        }

        // Breakout Detection
        const srPeriod = isIntraday ? Math.min(closes.length, 20) : Math.min(closes.length, 50);
        const recentHighs = highs.slice(-srPeriod);
        const recentLows = lows.slice(-srPeriod);
        const recentMaxHigh = Math.max(...recentHighs);
        const recentMinLow = Math.min(...recentLows);
        let breakoutType = "None";
        const breakoutThreshold = atr ? atr * 0.5 : price * 0.002;
        if (price > recentMaxHigh - breakoutThreshold && price >= recentHighs[recentHighs.length - 1]) {
          breakoutType = "Breakout Resistance";
        } else if (price < recentMinLow + breakoutThreshold && price <= recentLows[recentLows.length - 1]) {
          breakoutType = "Breakdown Support";
        }

        // Chart Pattern Detection
        let chartPattern = "Consolidation";
        let chartPatternType = "neutral";
        const last20 = closes.slice(-20);
        if (last20.length >= 10) {
          const n = last20.length;
          const sumX = n * (n - 1) / 2;
          const sumY = last20.reduce((a, b) => a + b, 0);
          const sumXY = last20.reduce((s, y, x) => s + x * y, 0);
          const sumX2 = n * (n - 1) * (2 * n - 1) / 6;
          const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
          const avgPrice = sumY / n;
          const slopePct = (slope / avgPrice) * 100;
          const rangePct = ((Math.max(...last20) - Math.min(...last20)) / avgPrice) * 100;
          const firstHalf = last20.slice(0, Math.floor(n / 2));
          const secondHalf = last20.slice(Math.floor(n / 2));
          const fhHigh = Math.max(...firstHalf), shHigh = Math.max(...secondHalf);
          const fhLow = Math.min(...firstHalf), shLow = Math.min(...secondHalf);

          if (Math.abs(slopePct) < 0.1 && rangePct < 2) { chartPattern = "Consolidation"; }
          else if (slopePct > 0.3 && shHigh > fhHigh && shLow > fhLow) { chartPattern = "Higher Highs/Lows"; chartPatternType = "bullish"; }
          else if (slopePct < -0.3 && shHigh < fhHigh && shLow < fhLow) { chartPattern = "Lower Highs/Lows"; chartPatternType = "bearish"; }
          else if (slopePct > 0.2) { chartPattern = "Uptrend"; chartPatternType = "bullish"; }
          else if (slopePct < -0.2) { chartPattern = "Downtrend"; chartPatternType = "bearish"; }
          else if (rangePct > 3 && Math.abs(slopePct) < 0.15) { chartPattern = "Range Bound"; }

          if (last20.length >= 15) {
            const peaks = [], troughs = [];
            for (let j = 2; j < last20.length - 2; j++) {
              if (last20[j] > last20[j-1] && last20[j] > last20[j+1] && last20[j] > last20[j-2] && last20[j] > last20[j+2]) peaks.push(j);
              if (last20[j] < last20[j-1] && last20[j] < last20[j+1] && last20[j] < last20[j-2] && last20[j] < last20[j+2]) troughs.push(j);
            }
            if (peaks.length >= 2) {
              const diff = Math.abs(last20[peaks[peaks.length-1]] - last20[peaks[peaks.length-2]]) / last20[peaks[peaks.length-1]];
              if (diff < 0.02) { chartPattern = "Double Top"; chartPatternType = "bearish"; }
            }
            if (troughs.length >= 2) {
              const diff = Math.abs(last20[troughs[troughs.length-1]] - last20[troughs[troughs.length-2]]) / last20[troughs[troughs.length-1]];
              if (diff < 0.02) { chartPattern = "Double Bottom"; chartPatternType = "bullish"; }
            }
          }
        }

        // 52-Week Proximity
        const fiftyTwoWeekHigh = meta.fiftyTwoWeekHigh || Math.max(...highs);
        const fiftyTwoWeekLow = meta.fiftyTwoWeekLow || Math.min(...lows);
        const pctFrom52WeekHigh = fiftyTwoWeekHigh ? parseFloat(((fiftyTwoWeekHigh - price) / fiftyTwoWeekHigh * 100).toFixed(2)) : null;
        const pctFrom52WeekLow = fiftyTwoWeekLow ? parseFloat(((price - fiftyTwoWeekLow) / fiftyTwoWeekLow * 100).toFixed(2)) : null;
        const near52WeekHigh = pctFrom52WeekHigh !== null && pctFrom52WeekHigh <= 3;
        const near52WeekLow = pctFrom52WeekLow !== null && pctFrom52WeekLow <= 3;

        // ORB (Intraday only)
        let orbSignal = "None";
        if (isIntraday && opens.length > 0) {
          const first15High = Math.max(...highs.slice(0, 3));
          const first15Low = Math.min(...lows.slice(0, 3));
          if (price > first15High) orbSignal = "Bullish ORB";
          else if (price < first15Low) orbSignal = "Bearish ORB";
        }

        // Day Momentum
        const dayOpen = meta.regularMarketDayOpen || opens[opens.length - 1] || prevClose;
        const dayHigh = meta.regularMarketDayHigh || Math.max(...highs.slice(-10));
        const dayLow = meta.regularMarketDayLow || Math.min(...lows.slice(-10));
        const dayMomentum = dayOpen ? parseFloat(((price - dayOpen) / dayOpen * 100).toFixed(2)) : 0;

        // Sentiment
        let sentiment = "Neutral";
        let sentimentReason = "";
        let bullScore = 0, bearScore = 0;
        if (emaBullish) { bullScore += 2; sentimentReason += "EMA bullish stack. "; }
        if (emaBearish) { bearScore += 2; sentimentReason += "EMA bearish stack. "; }
        if (rsi != null) {
          if (rsi < 30) { bullScore += 1; sentimentReason += "RSI oversold (" + rsi + "). "; }
          else if (rsi > 70) { bearScore += 1; sentimentReason += "RSI overbought (" + rsi + "). "; }
        }
        if (price > vwap) { bullScore += 1; sentimentReason += "Above VWAP. "; }
        if (price < vwap) { bearScore += 1; sentimentReason += "Below VWAP. "; }
        if (volumeRatio > 1.5) sentimentReason += "Volume surge " + volumeRatio + "x. ";
        if (breakoutType === "Breakout Resistance") { bullScore += 1; sentimentReason += "Breakout. "; }
        if (breakoutType === "Breakdown Support") { bearScore += 1; sentimentReason += "Breakdown. "; }
        if (emaCrossType === "bullish" && emaCrossFreshness !== "Fading") { bullScore += 1; sentimentReason += emaCrossSignal + " (" + emaCrossFreshness + ", " + emaCrossBars + " bars ago). "; }
        if (emaCrossType === "bearish" && emaCrossFreshness !== "Fading") { bearScore += 1; sentimentReason += emaCrossSignal + " (" + emaCrossFreshness + ", " + emaCrossBars + " bars ago). "; }
        if (chartPatternType === "bullish") { bullScore += 1; sentimentReason += chartPattern + ". "; }
        if (chartPatternType === "bearish") { bearScore += 1; sentimentReason += chartPattern + ". "; }
        if (bullScore >= 4) sentiment = "Bullish";
        else if (bullScore >= 2) sentiment = "Positive";
        else if (bearScore >= 4) sentiment = "Bearish";
        else if (bearScore >= 2) sentiment = "Negative";

        // Signal — includes EMA crossover bonus
        let signal = "HOLD";
        let crossBuyBonus = 0, crossSellBonus = 0;
        if (emaCrossType === "bullish" && emaCrossFreshness !== "Fading") crossBuyBonus = emaCrossFreshness === "Fresh" ? 2 : 1;
        if (emaCrossType === "bearish" && emaCrossFreshness !== "Fading") crossSellBonus = emaCrossFreshness === "Fresh" ? 2 : 1;
        const buyScore = (emaBullish ? 2 : 0) + (price > vwap ? 1 : 0) + (rsi < 35 ? 1 : 0) + (breakoutType === "Breakout Resistance" ? 1 : 0) + (chartPatternType === "bullish" ? 1 : 0) + (trend === "Uptrend" ? 1 : 0) + (orbSignal === "Bullish ORB" ? 1 : 0) + crossBuyBonus;
        const sellScore = (emaBearish ? 2 : 0) + (price < vwap ? 1 : 0) + (rsi > 65 ? 1 : 0) + (breakoutType === "Breakdown Support" ? 1 : 0) + (chartPatternType === "bearish" ? 1 : 0) + (trend === "Downtrend" ? 1 : 0) + (orbSignal === "Bearish ORB" ? 1 : 0) + crossSellBonus;
        if (buyScore >= 4) signal = "STRONG BUY";
        else if (buyScore >= 2) signal = "BUY";
        else if (sellScore >= 4) signal = "STRONG SELL";
        else if (sellScore >= 2) signal = "SELL";

        // SL / TP
        const slMult = isIntraday ? 1 : 1.5;
        const tpMult1 = isIntraday ? 1.5 : 2;
        const tpMult2 = isIntraday ? 2 : 3;
        const direction = buyScore > sellScore ? 1 : -1;
        const sl = atr ? parseFloat((price - atr * slMult * direction).toFixed(2)) : null;
        const tp1 = atr ? parseFloat((price + atr * tpMult1 * direction).toFixed(2)) : null;
        const tp2 = atr ? parseFloat((price + atr * tpMult2 * direction).toFixed(2)) : null;

        return {
          symbol: sym,
          price: parseFloat(price.toFixed(2)),
          changePercent,
          volumeRatio,
          signal,
          chartPattern,
          chartPatternType,
          breakoutType,
          emaBullish, emaBearish, emaLabel,
          ema1, ema2, ema3,
          emaCrossSignal, emaCrossType, emaCrossLabel, emaCrossBars, emaCrossFreshness, emaCrossPrice,
          vwap, rsi, atr,
          atrExpanding, atrTrend, volatility,
          near52WeekHigh, near52WeekLow,
          fiftyTwoWeekHigh, fiftyTwoWeekLow,
          pctFrom52WeekHigh, pctFrom52WeekLow,
          sentiment, sentimentReason: sentimentReason.trim(),
          trend, orbSignal,
          dayOpen: parseFloat((dayOpen || 0).toFixed(2)),
          dayHigh: parseFloat((dayHigh || 0).toFixed(2)),
          dayLow: parseFloat((dayLow || 0).toFixed(2)),
          dayMomentum,
          previousClose: parseFloat((prevClose || 0).toFixed(2)),
          sl, tp1, tp2,
          volume: meta.regularMarketVolume || 0,
          error: false
        };
      } catch (e) {
        return { symbol: sym, error: true };
      }
    });
    const batchResults = await Promise.all(promises);
    results.push(...batchResults);
    if (i + BATCH < symbols.length) await new Promise(r => setTimeout(r, 300));
  }

  return Response.json({ success: true, data: results });
});
