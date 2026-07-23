const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

// ===== PINE SCRIPT STRATEGY PARAMETERS =====
const EMA9_LENGTH = 9;
const EMA21_LENGTH = 21;
const ATR_LENGTH = 14;
const ATR_MULT_TARGET = 2.0;      // atr_multiplier_target
const ATR_MULT_STOPLOSS = 1.5;     // atr_multiplier_stoploss
const TARGET3_MULT = 3.0;          // target3_multiplier
const ATR_TRAILING_MULT = 1.0;     // atr_trailing_mult
const VOLUME_MA_LENGTH = 20;       // volume_ma_length
const RSI_LENGTH = 14;
const RISK_PERCENT = 1.0;          // risk_percent
const INITIAL_CAPITAL = 10000;     // initial_capital
const USE_VOLUME_FILTER = true;
const USE_RSI_FILTER = false;      // disabled in Pine Script
const RSI_OVERBOUGHT = 70;
const RSI_OVERSOLD = 30;

// ===== HELPER FUNCTIONS =====

function calcEMA(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const ema: number[] = [values[0]];
  for (let i = 1; i < values.length; i++) {
    ema.push(values[i] * k + ema[i - 1] * (1 - k));
  }
  return ema;
}

function calcRSI(values: number[], period: number = RSI_LENGTH): number {
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

function calcSMA(values: number[], period: number): number {
  if (values.length < period) return values.reduce((a, b) => a + b, 0) / values.length;
  const recent = values.slice(-period);
  return recent.reduce((a, b) => a + b, 0) / recent.length;
}

function calcATRSeries(highs: number[], lows: number[], closes: number[], period: number = ATR_LENGTH): number[] {
  if (closes.length < 2) return [0];
  const trs: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
    trs.push(tr);
  }
  const atrs: number[] = [];
  if (trs.length < period) {
    const avg = trs.reduce((a, b) => a + b, 0) / trs.length;
    for (let i = 0; i < trs.length; i++) atrs.push(avg);
    return atrs;
  }
  let prevATR = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  atrs.push(prevATR);
  for (let i = period; i < trs.length; i++) {
    prevATR = (prevATR * (period - 1) + trs[i]) / period;
    atrs.push(prevATR);
  }
  return atrs;
}

function calcATR(highs: number[], lows: number[], closes: number[], period: number = ATR_LENGTH): number {
  const atrs = calcATRSeries(highs, lows, closes, period);
  return atrs[atrs.length - 1] || 0;
}

function calcVWAP(closes: number[], volumes: number[]): number {
  let pv = 0, vv = 0;
  for (let i = 0; i < closes.length; i++) {
    if (i < volumes.length && volumes[i]) {
      pv += closes[i] * volumes[i];
      vv += volumes[i];
    }
  }
  return vv ? pv / vv : (closes[closes.length - 1] || 0);
}

// ===== MAIN STRATEGY: 9/21 EMA CROSSOVER PRO =====

interface StrategyResult {
  signal: string;
  entry: number | null;
  sl: number | null;
  tp1: number | null;
  tp2: number | null;
  tp3: number | null;
  trailingStop: number | null;
  positionSize: number | null;
  buyScore: number;
  sellScore: number;
  emaCrossover: { golden: boolean; death: boolean; cross: string };
  trendStrength: number;
  volumeCondition: boolean;
  activePosition: string | null;
  positionStatus: string | null;
}

function runStrategy(
  closes: number[], highs: number[], lows: number[], volumes: number[],
  price: number, ema9Arr: number[], ema21Arr: number[]
): StrategyResult {
  const len = closes.length;
  const lastIdx = len - 1;

  const ema9 = ema9Arr[lastIdx];
  const ema21 = ema21Arr[lastIdx];

  const atrSeries = calcATRSeries(highs, lows, closes, ATR_LENGTH);
  const atrCurrent = atrSeries[atrSeries.length - 1] || 0;

  const volSMA = calcSMA(volumes, VOLUME_MA_LENGTH);
  const volCurrent = volumes[lastIdx] || 0;
  const volumeCondition = !USE_VOLUME_FILTER || volCurrent > volSMA;

  const rsi = calcRSI(closes, RSI_LENGTH);

  const trendStrength = ema21 ? Math.abs(ema9 - ema21) / ema21 * 100 : 0;

  // ===== DETECT CROSSOVERS THROUGH HISTORY =====
  let lastBullishCrossIdx = -1;
  let lastBearishCrossIdx = -1;

  for (let i = 1; i <= lastIdx; i++) {
    if (ema9Arr[i] == null || ema21Arr[i] == null) continue;
    const wasBelow = ema9Arr[i - 1] <= ema21Arr[i - 1];
    const nowAbove = ema9Arr[i] > ema21Arr[i];
    const wasAbove = ema9Arr[i - 1] >= ema21Arr[i - 1];
    const nowBelow = ema9Arr[i] < ema21Arr[i];

    if (wasBelow && nowAbove) lastBullishCrossIdx = i;
    if (wasAbove && nowBelow) lastBearishCrossIdx = i;
  }

  let activePosition: string | null = null;
  let entryPrice: number | null = null;
  let slPrice: number | null = null;
  let tp1: number | null = null;
  let tp2: number | null = null;
  let tp3: number | null = null;
  let trailingStop: number | null = null;
  let positionSize: number | null = null;
  let positionStatus: string | null = null;
  let signal = "HOLD";
  let buyScore = 0;
  let sellScore = 0;
  let crossoverResult = { golden: false, death: false, cross: "none" };

  const hasBullishCross = lastBullishCrossIdx === lastIdx;
  const hasBearishCross = lastBearishCrossIdx === lastIdx;

  if (hasBullishCross) crossoverResult = { golden: true, death: false, cross: "golden" };
  if (hasBearishCross) crossoverResult = { golden: false, death: true, cross: "death" };

  const mostRecentCrossIdx = Math.max(lastBullishCrossIdx, lastBearishCrossIdx);
  const isMostRecentBullish = lastBullishCrossIdx > lastBearishCrossIdx;

  if (mostRecentCrossIdx >= 0) {
    const crossIdx = mostRecentCrossIdx;
    const atrAtCross = atrSeries[Math.min(crossIdx - 1, atrSeries.length - 1)] || atrCurrent;
    const entryAtCross = closes[crossIdx];

    if (isMostRecentBullish) {
      // === LONG POSITION (Bullish 9/21 Crossover) ===
      const slCalc = entryAtCross - (atrAtCross * ATR_MULT_STOPLOSS);
      const tp1Calc = entryAtCross + (atrAtCross * ATR_MULT_TARGET * 0.5);
      const tp2Calc = entryAtCross + (atrAtCross * ATR_MULT_TARGET);
      const tp3Calc = entryAtCross + (atrAtCross * TARGET3_MULT);

      let highestSinceLong = entryAtCross;
      let trailingLongStop = slCalc;
      let status = "ACTIVE";

      for (let i = crossIdx; i <= lastIdx; i++) {
        highestSinceLong = Math.max(highestSinceLong, highs[i]);
        trailingLongStop = Math.max(trailingLongStop, highestSinceLong - (atrAtCross * ATR_TRAILING_MULT));

        if (highs[i] >= tp3Calc) { status = "TP3_HIT"; break; }
        if (highs[i] >= tp2Calc) { status = "TP2_HIT"; break; }
        if (highs[i] >= tp1Calc) { status = "TP1_HIT"; break; }
        if (lows[i] <= trailingLongStop) { status = "SL_HIT"; break; }
      }

      if (status === "ACTIVE") {
        activePosition = "LONG";
        entryPrice = Math.round(entryAtCross * 100) / 100;
        slPrice = Math.round(trailingLongStop * 100) / 100;
        tp1 = Math.round(tp1Calc * 100) / 100;
        tp2 = Math.round(tp2Calc * 100) / 100;
        tp3 = Math.round(tp3Calc * 100) / 100;
        trailingStop = Math.round(trailingLongStop * 100) / 100;
        positionStatus = "ACTIVE";
        signal = "BUY";

        const riskPerShare = Math.abs(entryAtCross - slCalc);
        if (riskPerShare > 0) {
          positionSize = Math.floor((INITIAL_CAPITAL * RISK_PERCENT / 100) / riskPerShare);
        }
      } else {
        positionStatus = status;
        signal = "HOLD";
        entryPrice = Math.round(entryAtCross * 100) / 100;
        slPrice = Math.round(slCalc * 100) / 100;
        tp1 = Math.round(tp1Calc * 100) / 100;
        tp2 = Math.round(tp2Calc * 100) / 100;
        tp3 = Math.round(tp3Calc * 100) / 100;
        trailingStop = Math.round(trailingLongStop * 100) / 100;
      }
    } else {
      // === SHORT POSITION (Bearish 9/21 Crossover) ===
      const slCalc = entryAtCross + (atrAtCross * ATR_MULT_STOPLOSS);
      const tp1Calc = entryAtCross - (atrAtCross * ATR_MULT_TARGET * 0.5);
      const tp2Calc = entryAtCross - (atrAtCross * ATR_MULT_TARGET);
      const tp3Calc = entryAtCross - (atrAtCross * TARGET3_MULT);

      let lowestSinceShort = entryAtCross;
      let trailingShortStop = slCalc;
      let status = "ACTIVE";

      for (let i = crossIdx; i <= lastIdx; i++) {
        lowestSinceShort = Math.min(lowestSinceShort, lows[i]);
        trailingShortStop = Math.min(trailingShortStop, lowestSinceShort + (atrAtCross * ATR_TRAILING_MULT));

        if (lows[i] <= tp3Calc) { status = "TP3_HIT"; break; }
        if (lows[i] <= tp2Calc) { status = "TP2_HIT"; break; }
        if (lows[i] <= tp1Calc) { status = "TP1_HIT"; break; }
        if (highs[i] >= trailingShortStop) { status = "SL_HIT"; break; }
      }

      if (status === "ACTIVE") {
        activePosition = "SHORT";
        entryPrice = Math.round(entryAtCross * 100) / 100;
        slPrice = Math.round(trailingShortStop * 100) / 100;
        tp1 = Math.round(tp1Calc * 100) / 100;
        tp2 = Math.round(tp2Calc * 100) / 100;
        tp3 = Math.round(tp3Calc * 100) / 100;
        trailingStop = Math.round(trailingShortStop * 100) / 100;
        positionStatus = "ACTIVE";
        signal = "SELL";

        const riskPerShare = Math.abs(slCalc - entryAtCross);
        if (riskPerShare > 0) {
          positionSize = Math.floor((INITIAL_CAPITAL * RISK_PERCENT / 100) / riskPerShare);
        }
      } else {
        positionStatus = status;
        signal = "HOLD";
        entryPrice = Math.round(entryAtCross * 100) / 100;
        slPrice = Math.round(slCalc * 100) / 100;
        tp1 = Math.round(tp1Calc * 100) / 100;
        tp2 = Math.round(tp2Calc * 100) / 100;
        tp3 = Math.round(tp3Calc * 100) / 100;
        trailingStop = Math.round(trailingShortStop * 100) / 100;
      }
    }
  }

  // ===== SCORING (frontend compatibility) =====
  if (signal === "BUY") {
    buyScore = 60 + Math.round(trendStrength * 2);
    if (volumeCondition) buyScore += 15;
    if (rsi < RSI_OVERSOLD) buyScore += 10;
    if (price > calcVWAP(closes, volumes)) buyScore += 10;
    buyScore = Math.min(100, buyScore);
    sellScore = Math.max(0, 20 - Math.round(trendStrength));
  } else if (signal === "SELL") {
    sellScore = 60 + Math.round(trendStrength * 2);
    if (volumeCondition) sellScore += 15;
    if (rsi > RSI_OVERBOUGHT) sellScore += 10;
    if (price < calcVWAP(closes, volumes)) sellScore += 10;
    sellScore = Math.min(100, sellScore);
    buyScore = Math.max(0, 20 - Math.round(trendStrength));
  } else {
    if (ema9 > ema21) {
      buyScore = 30 + Math.round(trendStrength);
      sellScore = 10;
    } else {
      buyScore = 10;
      sellScore = 30 + Math.round(trendStrength);
    }
  }

  return {
    signal, entry: entryPrice, sl: slPrice, tp1, tp2, tp3,
    trailingStop, positionSize, buyScore, sellScore,
    emaCrossover: crossoverResult, trendStrength: Math.round(trendStrength * 100) / 100,
    volumeCondition, activePosition, positionStatus,
  };
}

// ===== MAIN HANDLER =====

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
          let interval: string, range: string;
          if (timeframe === "intraday" || timeframe === "5m") { interval = "5m"; range = "1mo"; }
          else if (timeframe === "15m") { interval = "15m"; range = "1mo"; }
          else if (timeframe === "1h") { interval = "60m"; range = "3mo"; }
          else { interval = "1d"; range = "6mo"; } // swing
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

          if (closes.length < 25) return { symbol: sym, error: true };

          const price = meta.regularMarketPrice || closes[closes.length - 1];
          const prev = meta.chartPreviousClose || meta.previousClose || closes[closes.length - 2] || price;
          const change = price - prev;
          const changePercent = prev ? (change / prev) * 100 : 0;

          // === EMA calculations (9 and 21 primary) ===
          const ema9Arr = calcEMA(closes, EMA9_LENGTH);
          const ema21Arr = calcEMA(closes, EMA21_LENGTH);
          const ema9 = Math.round(ema9Arr[ema9Arr.length - 1] * 100) / 100;
          const ema21 = Math.round(ema21Arr[ema21Arr.length - 1] * 100) / 100;

          // Additional EMAs for frontend compatibility
          const emas: Record<string, number> = { ema9, ema21 };
          const extraPeriods = timeframe === "swing" ? [50, 100] : timeframe === "1h" ? [50, 100] : [5, 13, 26];
          for (const p of extraPeriods) {
            if (closes.length >= p) {
              const arr = calcEMA(closes, p);
              emas[`ema${p}`] = Math.round(arr[arr.length - 1] * 100) / 100;
            }
          }

          // === RSI ===
          const rsi = Math.round(calcRSI(closes, RSI_LENGTH) * 100) / 100;

          // === ATR ===
          const atr = Math.round(calcATR(highs, lows, closes, ATR_LENGTH) * 100) / 100;

          // === VWAP ===
          const vwap = Math.round(calcVWAP(closes, volumes) * 100) / 100;

          // === Volume Ratio ===
          let volumeRatio = 0;
          const regVol = meta.regularMarketVolume || 0;
          const nonZeroVols = volumes.filter((v: number) => v != null && v > 0);
          if (regVol && nonZeroVols.length >= 2) {
            const recent = nonZeroVols.slice(-20, -1);
            const avgRecent = recent.length ? recent.reduce((a: number, b: number) => a + b, 0) / recent.length : 0;
            const candlesPerDay = (timeframe === "intraday" || timeframe === "5m") ? 75 : timeframe === "15m" ? 25 : timeframe === "1h" ? 6 : 1;
            const estAvgDaily = avgRecent * candlesPerDay;
            volumeRatio = estAvgDaily ? Math.round((regVol / estAvgDaily) * 100) / 100 : 0;
          }

          // === Support/Resistance ===
          const lookback = (timeframe === "intraday" || timeframe === "5m") ? 5 : timeframe === "15m" ? 10 : 20;
          const recentHighs = highs.slice(-lookback);
          const recentLows = lows.slice(-lookback);
          const resistance = Math.round(Math.max(...recentHighs) * 100) / 100;
          const support = Math.round(Math.min(...recentLows) * 100) / 100;

          // === RUN 9/21 EMA CROSSOVER STRATEGY ===
          const strat = runStrategy(closes, highs, lows, volumes, price, ema9Arr, ema21Arr);

          // === Trend ===
          let trend = "Sideways";
          if (ema9 > ema21) trend = "Up";
          else if (ema9 < ema21) trend = "Down";

          // === Chart Pattern ===
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

          // === ORB ===
          let orbSignal = "None";
          if ((timeframe === "intraday" || timeframe === "5m" || timeframe === "15m") && closes.length > 0) {
            if (highs.length > 0 && lows.length > 0) {
              if (price > highs[0]) orbSignal = "Bullish ORB";
              else if (price < lows[0]) orbSignal = "Bearish ORB";
            }
          }

          // === 52-week data ===
          const fiftyTwoWeekHigh = meta.fiftyTwoWeekHigh || 0;
          const fiftyTwoWeekLow = meta.fiftyTwoWeekLow || 0;
          const pctFrom52WeekHigh = fiftyTwoWeekHigh ? Math.round(((fiftyTwoWeekHigh - price) / fiftyTwoWeekHigh) * 100 * 100) / 100 : 0;

          // EMA crossover for frontend
          const emaCrossover: any = strat.emaCrossover;
          let emaCrossSignal = "None";
          if (emaCrossover.cross === "golden") emaCrossSignal = "Golden Cross";
          else if (emaCrossover.cross === "death") emaCrossSignal = "Death Cross";

          return {
            symbol: sym,
            price: Math.round(price * 100) / 100,
            change: Math.round(change * 100) / 100,
            changePercent: Math.round(changePercent * 100) / 100,
            emas, rsi, atr, vwap, volumeRatio, support, resistance,
            // Strategy outputs
            signal: strat.signal,
            buyScore: strat.buyScore,
            sellScore: strat.sellScore,
            entry: strat.entry,
            sl: strat.sl,
            tp1: strat.tp1,
            tp2: strat.tp2,
            tp3: strat.tp3,
            trailingStop: strat.trailingStop,
            positionSize: strat.positionSize,
            positionStatus: strat.positionStatus,
            activePosition: strat.activePosition,
            trendStrength: strat.trendStrength,
            volumeCondition: strat.volumeCondition,
            // Legacy compatibility
            emaCrossover,
            emaCrossSignal,
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
