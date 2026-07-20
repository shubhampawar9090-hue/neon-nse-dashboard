const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function calcEMA(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const ema: number[] = [values[0]];
  for (let i = 1; i < values.length; i++) {
    ema.push(values[i] * k + ema[i - 1] * (1 - k));
  }
  return ema;
}

function calcRSI(values: number[], period: number = 14): number {
  if (values.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = values.length - period; i < values.length; i++) {
    const change = values[i] - values[i - 1];
    if (change >= 0) gains += change; else losses -= change;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function calcATR(highs: number[], lows: number[], closes: number[], period: number = 14): number {
  if (closes.length < period + 1) return 0;
  const trs: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
    trs.push(tr);
  }
  const recent = trs.slice(-period);
  return recent.reduce((a, b) => a + b, 0) / recent.length;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const symbols: string[] = body.symbols || [];
    const timeframe: string = body.timeframe || "intraday";

    const results = await Promise.all(
      symbols.map(async (sym: string) => {
        try {
          const interval = timeframe === "intraday" ? "5m" : "1d";
          const range = timeframe === "intraday" ? "1mo" : "6mo";
          const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=${interval}&range=${range}`;
          const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
          const j = await res.json();
          const result = j.chart.result[0];
          const meta = result.meta || {};
          const candles = result.indicators.quote[0];
          const closes = (candles.close || []).filter((v: number) => v != null);
          const highs = (candles.high || []).filter((v: number) => v != null);
          const lows = (candles.low || []).filter((v: number) => v != null);
          const volumes = (candles.volume || []).filter((v: number) => v != null);

          if (closes.length < 5) return { symbol: sym, error: true };

          const price = meta.regularMarketPrice || closes[closes.length - 1];
          const prev = meta.chartPreviousClose || meta.previousClose || closes[closes.length - 2] || price;
          const change = price - prev;
          const changePercent = prev ? (change / prev) * 100 : 0;

          // === EMA calculations ===
          const emaPeriods = timeframe === "intraday" ? [5, 13, 26] : [9, 21, 50];
          const emas: Record<string, number> = {};
          emaPeriods.forEach(p => {
            if (closes.length >= p) {
              const emaArr = calcEMA(closes, p);
              emas[`ema${p}`] = Math.round(emaArr[emaArr.length - 1] * 100) / 100;
            }
          });

          // === RSI ===
          const rsi = Math.round(calcRSI(closes, 14) * 100) / 100;

          // === ATR ===
          const atr = Math.round(calcATR(highs, lows, closes, 14) * 100) / 100;

          // === VWAP ===
          let vwap = price;
          if (closes.length > 0 && volumes.length > 0) {
            let pv = 0, vv = 0;
            for (let i = 0; i < closes.length; i++) {
              if (i < volumes.length && volumes[i]) {
                pv += closes[i] * volumes[i];
                vv += volumes[i];
              }
            }
            vwap = vv ? Math.round((pv / vv) * 100) / 100 : price;
          }

          // === Volume Ratio ===
          // Uses regularMarketVolume from meta vs avg of recent non-zero candle volumes
          // Note: price function (get-nse-data) computes this more accurately from daily candles
          // The frontend merge prefers price data's volumeRatio over this value
          let volumeRatio = 0;
          const regVol = meta.regularMarketVolume || 0;
          const nonZeroVols = volumes.filter((v: number) => v != null && v > 0);
          if (regVol && nonZeroVols.length >= 2) {
            // Use second-to-last candle (last completed candle) as representative
            const lastComplete = nonZeroVols[nonZeroVols.length - 1] > 0 ? nonZeroVols[nonZeroVols.length - 1] : nonZeroVols[nonZeroVols.length - 2];
            const recent = nonZeroVols.slice(-20, -1);
            const avgRecent = recent.length ? recent.reduce((a: number, b: number) => a + b, 0) / recent.length : 0;
            // Scale up: daily volume vs avg 5m candle * candles per day
            const candlesPerDay = timeframe === "intraday" ? 75 : 1;
            const estAvgDaily = avgRecent * candlesPerDay;
            volumeRatio = estAvgDaily ? Math.round((regVol / estAvgDaily) * 100) / 100 : 0;
          }

          // === Support/Resistance ===
          const lookback = timeframe === "intraday" ? 5 : 20;
          const recentHighs = highs.slice(-lookback);
          const recentLows = lows.slice(-lookback);
          const resistance = Math.round(Math.max(...recentHighs) * 100) / 100;
          const support = Math.round(Math.min(...recentLows) * 100) / 100;

          // === Signal logic ===
          const emaKeys = Object.keys(emas).map(k => parseInt(k.replace("ema", ""))).sort((a, b) => a - b);
          let signal = "NEUTRAL";
          let buyScore = 0, sellScore = 0;

          if (emaKeys.length >= 2) {
            const shortEma = emas[`ema${emaKeys[0]}`];
            const longEma = emas[`ema${emaKeys[1]}`];
            if (shortEma > longEma) { signal = "BUY"; buyScore += 30; }
            else { signal = "SELL"; sellScore += 30; }
          }

          if (rsi < 30) { buyScore += 25; signal = "BUY"; }
          else if (rsi > 70) { sellScore += 25; signal = "SELL"; }
          else { buyScore += 5; }

          if (price > vwap) { buyScore += 10; }
          else { sellScore += 10; }

          // Determine final signal strength
          if (buyScore >= 70) signal = "STRONG BUY";
          else if (buyScore >= 40) signal = "BUY";
          else if (sellScore >= 70) signal = "STRONG SELL";
          else if (sellScore >= 40) signal = "SELL";
          else signal = "HOLD";

          // === SL and TP ===
          const slMult = timeframe === "intraday" ? 1 : 1.5;
          const tpMult = timeframe === "intraday" ? [1.5, 2] : [2, 3];
          const sl = Math.round((price - atr * slMult) * 100) / 100;
          const tp1 = Math.round((price + atr * tpMult[0]) * 100) / 100;
          const tp2 = Math.round((price + atr * tpMult[1]) * 100) / 100;

          // === EMA crossover detection ===
          const emaCrossover: any = { golden: false, death: false, cross: "none" };
          if (emaKeys.length >= 2 && closes.length > emaKeys[1]) {
            const shortArr = calcEMA(closes, emaKeys[0]);
            const longArr = calcEMA(closes, emaKeys[1]);
            const lastIdx = shortArr.length - 1;
            if (lastIdx > 0) {
              const wasBelow = shortArr[lastIdx - 1] <= longArr[lastIdx - 1];
              const nowAbove = shortArr[lastIdx] > longArr[lastIdx];
              const wasAbove = shortArr[lastIdx - 1] >= longArr[lastIdx - 1];
              const nowBelow = shortArr[lastIdx] < longArr[lastIdx];
              if (wasBelow && nowAbove) { emaCrossover.golden = true; emaCrossover.cross = "golden"; buyScore += 20; }
              else if (wasAbove && nowBelow) { emaCrossover.death = true; emaCrossover.cross = "death"; sellScore += 20; }
            }
          }

          // === Trend from EMA alignment ===
          let trend = "Sideways";
          if (emaKeys.length >= 3) {
            const e1 = emas[`ema${emaKeys[0]}`];
            const e2 = emas[`ema${emaKeys[1]}`];
            const e3 = emas[`ema${emaKeys[2]}`];
            if (e1 > e2 && e2 > e3) trend = "Up";
            else if (e1 < e2 && e2 < e3) trend = "Down";
            else trend = "Sideways";
          }

          // === Chart Pattern (basic) ===
          let chartPattern = "Consolidation";
          if (closes.length >= 10) {
            const recent = closes.slice(-10);
            const first3 = recent.slice(0, 3).reduce((a, b) => a + b, 0) / 3;
            const last3 = recent.slice(-3).reduce((a, b) => a + b, 0) / 3;
            const pctChange = ((last3 - first3) / first3) * 100;
            const highs10 = highs.slice(-10);
            const lows10 = lows.slice(-10);
            const range10 = Math.max(...highs10) - Math.min(...lows10);
            const avgPrice = recent.reduce((a, b) => a + b, 0) / recent.length;
            const rangePct = avgPrice ? (range10 / avgPrice) * 100 : 0;

            if (rangePct < 1.5) chartPattern = "Consolidation";
            else if (pctChange > 3) chartPattern = "Uptrend";
            else if (pctChange < -3) chartPattern = "Downtrend";
            else {
              // Check for higher highs / lower lows
              const mid = Math.floor(recent.length / 2);
              const firstHigh = Math.max(...highs10.slice(0, mid));
              const lastHigh = Math.max(...highs10.slice(mid));
              const firstLow = Math.min(...lows10.slice(0, mid));
              const lastLow = Math.min(...lows10.slice(mid));
              if (lastHigh > firstHigh && lastLow < firstLow) chartPattern = "Volatility Expansion";
              else if (lastHigh < firstHigh && lastLow > firstLow) chartPattern = "Contraction";
              else chartPattern = "Consolidation";
            }
          }

          // === ORB Signal (Opening Range Breakout) ===
          let orbSignal = "None";
          if (timeframe === "intraday" && closes.length > 0) {
            // First candle high/low as opening range
            if (highs.length > 0 && lows.length > 0) {
              if (price > highs[0]) orbSignal = "Bullish ORB";
              else if (price < lows[0]) orbSignal = "Bearish ORB";
              else orbSignal = "None";
            }
          }

          // === 52-week data ===
          const fiftyTwoWeekHigh = meta.fiftyTwoWeekHigh || 0;
          const fiftyTwoWeekLow = meta.fiftyTwoWeekLow || 0;
          const pctFrom52WeekHigh = fiftyTwoWeekHigh ? Math.round(((fiftyTwoWeekHigh - price) / fiftyTwoWeekHigh) * 100 * 100) / 100 : 0;

          buyScore = Math.min(100, buyScore);
          sellScore = Math.min(100, sellScore);

          return {
            symbol: sym,
            price: Math.round(price * 100) / 100,
            change: Math.round(change * 100) / 100,
            changePercent: Math.round(changePercent * 100) / 100,
            emas,
            rsi,
            atr,
            vwap,
            volumeRatio,
            support,
            resistance,
            signal,
            buyScore,
            sellScore,
            sl,
            tp1,
            tp2,
            emaCrossover,
            trend,
            chartPattern,
            orbSignal,
            fiftyTwoWeekHigh,
            fiftyTwoWeekLow,
            pctFrom52WeekHigh,
            dayHigh: meta.regularMarketDayHigh || price,
            dayLow: meta.regularMarketDayLow || price,
            previousClose: prev,
            error: false
          };
        } catch (e) {
          return { symbol: sym, error: true };
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
