t corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Methods": "GET, POST, OPTIONS",
};

// ===== STRATEGY PARAMETERS =====
const EMA9_LENGTH = 9;
const EMA21_LENGTH = 21;
const ATR_LENGTH = 14;
const ATR_MULT_TARGET = 2.0;
const ATR_MULT_STOPLOSS = 2.0;       // CHANGED: was 1.5, now 2.0 to avoid fake signals
const TARGET3_MULT = 3.0;
const VOLUME_MA_LENGTH = 20;
const VOLUME_SURGE_MULT = 1.5;       // NEW: require 1.5x volume SMA for confirmation
const RSI_LENGTH = 14;
const RISK_PERCENT = 1.0;
const INITIAL_CAPITAL = 10000;
const USE_VOLUME_FILTER = true;
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

// ===== CANDLESTICK PATTERN DETECTION =====
function detectCandlePattern(highs: number[], lows: number[], opens: number[], closes: number[]): {pattern: string, type: string} {
  const n = closes.length;
  if (n < 3) return {pattern: "None", type: "neutral"};
  
  const i = n - 1;      // current candle
  const i1 = n - 2;     // previous candle
  const i2 = n - 3;     // two candles ago
  
  const body = Math.abs(closes[i] - opens[i]);
  const body1 = Math.abs(closes[i1] - opens[i1]);
  const range = highs[i] - lows[i];
  const range1 = highs[i1] - lows[i1];
  const upperWick = highs[i] - Math.max(closes[i], opens[i]);
  const lowerWick = Math.min(closes[i], opens[i]) - lows[i];
  const isBull = closes[i] > opens[i];
  const isBear = closes[i] < opens[i];
  const isBull1 = closes[i1] > opens[i1];
  const isBear1 = closes[i1] < opens[i1];
  const avgBody = (body + body1) / 2;
  
  // Doji
  if (body <= range * 0.1) {
    return {pattern: "Doji", type: "neutral"};
  }
  
  // Hammer (bullish reversal)
  if (lowerWick > body * 2 && upperWick < body * 0.5 && isBull) {
    return {pattern: "Hammer", type: "bullish"};
  }
  // Hanging Man (bearish)
  if (lowerWick > body * 2 && upperWick < body * 0.5 && isBear) {
    return {pattern: "Hanging Man", type: "bearish"};
  }
  // Shooting Star (bearish reversal)
  if (upperWick > body * 2 && lowerWick < body * 0.5 && isBear) {
    return {pattern: "Shooting Star", type: "bearish"};
  }
  // Inverted Hammer (bullish)
  if (upperWick > body * 2 && lowerWick < body * 0.5 && isBull) {
    return {pattern: "Inverted Hammer", type: "bullish"};
  }
  
  // Bullish Engulfing
  if (isBear1 && isBull && closes[i] >= opens[i1] && opens[i] <= closes[i1] && body > body1) {
    return {pattern: "Bullish Engulfing", type: "bullish"};
  }
  // Bearish Engulfing
  if (isBull1 && isBear && opens[i] >= closes[i1] && closes[i] <= opens[i1] && body > body1) {
    return {pattern: "Bearish Engulfing", type: "bearish"};
  }
  
  // Morning Star (bullish 3-candle)
  if (isBear1 && body1 > avgBody) {
    const midBody = Math.abs(closes[n-2] - opens[n-2]);
    if (midBody < body1 * 0.5 && isBull && closes[i] > (opens[i1] + closes[i1]) / 2) {
      return {pattern: "Morning Star", type: "bullish"};
    }
  }
  // Evening Star (bearish 3-candle)
  if (isBull1 && body1 > avgBody) {
    const midBody = Math.abs(closes[n-2] - opens[n-2]);
    if (midBody < body1 * 0.5 && isBear && closes[i] < (opens[i1] + closes[i1]) / 2) {
      return {pattern: "Evening Star", type: "bearish"};
    }
  }
  
  // Piercing Line (bullish)
  if (isBear1 && isBull && opens[i] < lows[i1] && closes[i] > (opens[i1] + closes[i1]) / 2 && closes[i] < opens[i1]) {
    return {pattern: "Piercing Line", type: "bullish"};
  }
  // Dark Cloud Cover (bearish)
  if (isBull1 && isBear && opens[i] > highs[i1] && closes[i] < (opens[i1] + closes[i1]) / 2 && closes[i] > opens[i1]) {
    return {pattern: "Dark Cloud Cover", type: "bearish"};
  }
  
  // Marubozu (strong directional)
  if (upperWick < body * 0.05 && lowerWick < body * 0.05 && body > range * 0.9) {
    return {pattern: isBull ? "Bullish Marubozu" : "Bearish Marubozu", type: isBull ? "bullish" : "bearish"};
  }
  
  // Spinning Top (indecision)
  if (body < range * 0.3 && upperWick > body * 0.5 && lowerWick > body * 0.5) {
    return {pattern: "Spinning Top", type: "neutral"};
  }
  
  return {pattern: "None", type: "neutral"};
}

// ===== CHART PATTERN DETECTION =====
function detectChartPattern(highs: number[], lows: number[], closes: number[]): {pattern: string, type: string} {
  const n = closes.length;
  if (n < 20) return {pattern: "Insufficient Data", type: "neutral"};
  
  const recentHighs = highs.slice(-20);
  const recentLows = lows.slice(-20);
  const recentCloses = closes.slice(-20);
  
  // Find swing highs and lows (peaks and troughs)
  const swingHighs: {idx: number, val: number}[] = [];
  const swingLows: {idx: number, val: number}[] = [];
  for (let i = 2; i < 18; i++) {
    if (highs[i] > highs[i-1] && highs[i] > highs[i-2] && highs[i] > highs[i+1] && highs[i] > highs[i+2]) {
      swingHighs.push({idx: i, val: highs[i]});
    }
    if (lows[i] < lows[i-1] && lows[i] < lows[i-2] && lows[i] < lows[i+1] && lows[i] < lows[i+2]) {
      swingLows.push({idx: i, val: lows[i]});
    }
  }
  
  // Double Top
  if (swingHighs.length >= 2) {
    const h1 = swingHighs[swingHighs.length-2];
    const h2 = swingHighs[swingHighs.length-1];
    const threshold = h1.val * 0.02; // 2% tolerance
    if (Math.abs(h1.val - h2.val) < threshold && h2.idx - h1.idx >= 3) {
      return {pattern: "Double Top", type: "bearish"};
    }
  }
  // Double Bottom
  if (swingLows.length >= 2) {
    const l1 = swingLows[swingLows.length-2];
    const l2 = swingLows[swingLows.length-1];
    const threshold = l1.val * 0.02;
    if (Math.abs(l1.val - l2.val) < threshold && l2.idx - l1.idx >= 3) {
      return {pattern: "Double Bottom", type: "bullish"};
    }
  }
  
  // Head and Shoulders
  if (swingHighs.length >= 3) {
    const [s1, s2, s3] = swingHighs.slice(-3);
    if (s2.val > s1.val && s2.val > s3.val && Math.abs(s1.val - s3.val) < s1.val * 0.03) {
      return {pattern: "Head & Shoulders", type: "bearish"};
    }
  }
  // Inverse Head and Shoulders
  if (swingLows.length >= 3) {
    const [s1, s2, s3] = swingLows.slice(-3);
    if (s2.val < s1.val && s2.val < s3.val && Math.abs(s1.val - s3.val) < s1.val * 0.03) {
      return {pattern: "Inv Head & Shoulders", type: "bullish"};
    }
  }
  
  // Triangle detection
  if (swingHighs.length >= 2 && swingLows.length >= 2) {
    const hh = swingHighs.slice(-2);
    const ll = swingLows.slice(-2);
    const highSlope = (hh[1].val - hh[0].val) / (hh[1].idx - hh[0].idx);
    const lowSlope = (ll[1].val - ll[0].val) / (ll[1].idx - ll[0].idx);
    
    if (highSlope < -0.01 && lowSlope > 0.01) return {pattern: "Symmetric Triangle", type: "neutral"};
    if (Math.abs(highSlope) < 0.005 && lowSlope > 0.01) return {pattern: "Ascending Triangle", type: "bullish"};
    if (highSlope < -0.01 && Math.abs(lowSlope) < 0.005) return {pattern: "Descending Triangle", type: "bearish"};
  }
  
  // Flag / Channel
  const firstHalf = recentCloses.slice(0, 10);
  const secondHalf = recentCloses.slice(10);
  const firstAvg = firstHalf.reduce((a,b)=>a+b,0) / firstHalf.length;
  const secondAvg = secondHalf.reduce((a,b)=>a+b,0) / secondHalf.length;
  const pctChange = ((secondAvg - firstAvg) / firstAvg) * 100;
  
  const rangePct = ((Math.max(...recentHighs) - Math.min(...recentLows)) / firstAvg) * 100;
  
  if (rangePct < 2) return {pattern: "Consolidation", type: "neutral"};
  if (pctChange > 5) return {pattern: "Uptrend", type: "bullish"};
  if (pctChange < -5) return {pattern: "Downtrend", type: "bearish"};
  
  // Rising/Falling Wedge
  if (swingHighs.length >= 2 && swingLows.length >= 2) {
    const hh = swingHighs.slice(-2);
    const ll = swingLows.slice(-2);
    const highSlope = (hh[1].val - hh[0].val) / (hh[1].idx - hh[0].idx);
    const lowSlope = (ll[1].val - ll[0].val) / (ll[1].idx - ll[0].idx);
    if (highSlope > 0.01 && lowSlope > 0.01 && lowSlope > highSlope) {
      return {pattern: "Rising Wedge", type: "bearish"};
    }
    if (highSlope < -0.01 && lowSlope < -0.01 && highSlope > lowSlope) {
      return {pattern: "Falling Wedge", type: "bullish"};
    }
  }
  
  return {pattern: "Consolidation", type: "neutral"};
}

// ===== MULTI-TIMEFRAME SUPPORT/RESISTANCE =====
async function fetchDailySR(yahooSym: string): Promise<{d1_support: number, d1_resistance: number, d1_pivot: number, h4_support: number, h4_resistance: number, h1_support: number, h1_resistance: number}> {
  try {
    // Fetch daily data for SR computation
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${yahooSym}?interval=1d&range=3mo`;
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) throw new Error("Daily fetch failed");
    const j = await res.json();
    if (!j?.chart?.result?.[0]) throw new Error("No daily data");
    
    const candles = j.chart.result[0].indicators?.quote?.[0];
    if (!candles) throw new Error("No daily candles");
    
    const dHighs = (candles.high || []).filter((v: number) => v != null);
    const dLows = (candles.low || []).filter((v: number) => v != null);
    const dCloses = (candles.close || []).filter((v: number) => v != null);
    
    if (dCloses.length < 5) throw new Error("Insufficient daily data");
    
    // Daily SR: 20-day lookback
    const d1Lookback = Math.min(20, dHighs.length);
    const d1Highs = dHighs.slice(-d1Lookback);
    const d1Lows = dLows.slice(-d1Lookback);
    const d1_resistance = Math.round(Math.max(...d1Highs) * 100) / 100;
    const d1_support = Math.round(Math.min(...d1Lows) * 100) / 100;
    
    // Pivot point (classic)
    const lastClose = dCloses[dCloses.length - 1];
    const lastHigh = dHighs[dHighs.length - 1];
    const lastLow = dLows[dLows.length - 1];
    const d1_pivot = Math.round(((lastHigh + lastLow + lastClose) / 3) * 100) / 100;
    
    // 4h SR: 5-day lookback on daily (approximation)
    const h4Lookback = Math.min(5, dHighs.length);
    const h4_resistance = Math.round(Math.max(...dHighs.slice(-h4Lookback)) * 100) / 100;
    const h4_support = Math.round(Math.min(...dLows.slice(-h4Lookback)) * 100) / 100;
    
    // 1h SR: 2-day lookback (approximation)
    const h1Lookback = Math.min(2, dHighs.length);
    const h1_resistance = Math.round(Math.max(...dHighs.slice(-h1Lookback)) * 100) / 100;
    const h1_support = Math.round(Math.min(...dLows.slice(-h1Lookback)) * 100) / 100;
    
    return { d1_support, d1_resistance, d1_pivot, h4_support, h4_resistance, h1_support, h1_resistance };
  } catch {
    return { d1_support: 0, d1_resistance: 0, d1_pivot: 0, h4_support: 0, h4_resistance: 0, h1_support: 0, h1_resistance: 0 };
  }
}

// ===== SR CONFIRMATION =====
function checkSRConfirmation(price: number, sr: any, isBullish: boolean): {confirmed: boolean, level: string, detail: string} {
  if (!sr.d1_support && !sr.d1_resistance) return {confirmed: false, level: "none", detail: "No SR data"};
  
  const tolerance = 0.01; // 1% tolerance
  const levels = [
    {name: "D1 Support", val: sr.d1_support, type: "support"},
    {name: "D1 Resistance", val: sr.d1_resistance, type: "resistance"},
    {name: "H4 Support", val: sr.h4_support, type: "support"},
    {name: "H4 Resistance", val: sr.h4_resistance, type: "resistance"},
    {name: "H1 Support", val: sr.h1_support, type: "support"},
    {name: "H1 Resistance", val: sr.h1_resistance, type: "resistance"},
    {name: "D1 Pivot", val: sr.d1_pivot, type: "pivot"},
  ];
  
  for (const lvl of levels) {
    if (!lvl.val) continue;
    const dist = Math.abs(price - lvl.val) / price;
    if (dist < tolerance) {
      if (isBullish && (lvl.type === "support" || lvl.type === "pivot")) {
        return {confirmed: true, level: lvl.name, detail: `Price near ${lvl.name} ₹${lvl.val} — bullish confirmation`};
      }
      if (!isBullish && (lvl.type === "resistance" || lvl.type === "pivot")) {
        return {confirmed: true, level: lvl.name, detail: `Price near ${lvl.name} ₹${lvl.val} — bearish confirmation`};
      }
    }
  }
  return {confirmed: false, level: "none", detail: "Price not near key SR levels"};
}

// ===== FALLBACK HELPER =====
function getTVTicker(symbol: string): string {
  if (symbol === "^NSEI") return "NSE:NIFTY";
  if (symbol === "^NSEBANK") return "NSE:BANKNIFTY";
  if (symbol === "^BSESN") return "BSE:SENSEX";
  if (symbol.includes(":")) return symbol;
  return `NSE:${symbol}`;
}

async function fetchTradingView(tvTicker: string) {
  try {
    const res = await fetch("https://scanner.tradingview.com/india/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        symbols: { tickers: [tvTicker], query: { types: [] } },
        columns: ["close", "change", "change_abs", "volume", "high", "low", "open"]
      })
    });
    if (!res.ok) return null;
    const j = await res.json();
    if (j?.data?.length > 0) {
      const d = j.data[0].d;
      if (d) return { close: Number(d[0]), change_pct: Number(d[1]), change_abs: Number(d[2]), volume: Number(d[3]), high: Number(d[4]), low: Number(d[5]), open: Number(d[6]) };
    }
  } catch (e: any) { console.error(`TV fetch failed for ${tvTicker}:`, e); }
  return null;
}

// ===== MAIN STRATEGY: 9/21 EMA CROSSOVER PRO — NO AUTO-RESET =====

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
  volumeSurge: boolean;
  activePosition: string | null;
  positionStatus: string | null;
}

function runStrategy(
  closes: number[], highs: number[], lows: number[], volumes: number[],
  price: number, ema9Arr: number[], ema21Arr: number[],
  candlePattern: {pattern: string, type: string},
  srConfirm: {confirmed: boolean, level: string, detail: string}
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
  const volumeSurge = volCurrent > volSMA * VOLUME_SURGE_MULT;
  const rsi = calcRSI(closes, RSI_LENGTH);
  const trendStrength = ema21 ? Math.abs(ema9 - ema21) / ema21 * 100 : 0;

  // ===== DETECT CROSSOVERS =====
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
      // === LONG POSITION ===
      // FIXED SL at ATR*2 — NO TRAILING, NO AUTO-RESET
      const slCalc = entryAtCross - (atrAtCross * ATR_MULT_STOPLOSS);
      const tp1Calc = entryAtCross + (atrAtCross * ATR_MULT_TARGET * 0.5);
      const tp2Calc = entryAtCross + (atrAtCross * ATR_MULT_TARGET);
      const tp3Calc = entryAtCross + (atrAtCross * TARGET3_MULT);

      // Check if any target or SL was hit
      let status = "ACTIVE";
      let highestHigh = entryAtCross;
      for (let i = crossIdx; i <= lastIdx; i++) {
        highestHigh = Math.max(highestHigh, highs[i]);
        if (highs[i] >= tp3Calc) { status = "TP3_HIT"; break; }
        if (highs[i] >= tp2Calc) { status = "TP2_HIT"; break; }
        if (highs[i] >= tp1Calc) { status = "TP1_HIT"; break; }
        if (lows[i] <= slCalc) { status = "SL_HIT"; break; }
      }

      // DON'T auto-reset: keep signal as BUY even if SL hit
      // Only revert to HOLD if ALL targets are hit (trade complete)
      activePosition = "LONG";
      entryPrice = Math.round(entryAtCross * 100) / 100;
      slPrice = Math.round(slCalc * 100) / 100;  // FIXED SL, no trailing
      tp1 = Math.round(tp1Calc * 100) / 100;
      tp2 = Math.round(tp2Calc * 100) / 100;
      tp3 = Math.round(tp3Calc * 100) / 100;
      trailingStop = Math.round(slCalc * 100) / 100;  // same as SL
      positionStatus = status;

      // Signal stays BUY unless TP3 is hit (trade fully complete)
      if (status === "TP3_HIT") {
        signal = "HOLD";
      } else if (status === "SL_HIT") {
        // Keep BUY signal but mark SL hit — don't auto-reset
        signal = "BUY";
      } else {
        signal = "BUY";
      }

      // Volume confirmation: downgrade to HOLD if no volume
      if (signal === "BUY" && !volumeCondition) {
        signal = "HOLD";
        positionStatus = "WAIT_VOL";
      }

      // Scoring with candle + SR confirmation
      buyScore = 60 + Math.round(trendStrength * 2);
      if (volumeSurge) buyScore += 15;
      else if (volumeCondition) buyScore += 10;
      if (rsi < RSI_OVERSOLD) buyScore += 10;
      if (price > calcVWAP(closes, volumes)) buyScore += 5;
      if (candlePattern.type === "bullish") buyScore += 10;
      if (srConfirm.confirmed) buyScore += 10;
      buyScore = Math.min(100, buyScore);
      sellScore = Math.max(0, 20 - Math.round(trendStrength));

      const riskPerShare = Math.abs(entryAtCross - slCalc);
      if (riskPerShare > 0) positionSize = Math.floor((INITIAL_CAPITAL * RISK_PERCENT / 100) / riskPerShare);

    } else {
      // === SHORT POSITION ===
      const slCalc = entryAtCross + (atrAtCross * ATR_MULT_STOPLOSS);
      const tp1Calc = entryAtCross - (atrAtCross * ATR_MULT_TARGET * 0.5);
      const tp2Calc = entryAtCross - (atrAtCross * ATR_MULT_TARGET);
      const tp3Calc = entryAtCross - (atrAtCross * TARGET3_MULT);

      let status = "ACTIVE";
      let lowestLow = entryAtCross;
      for (let i = crossIdx; i <= lastIdx; i++) {
        lowestLow = Math.min(lowestLow, lows[i]);
        if (lows[i] <= tp3Calc) { status = "TP3_HIT"; break; }
        if (lows[i] <= tp2Calc) { status = "TP2_HIT"; break; }
        if (lows[i] <= tp1Calc) { status = "TP1_HIT"; break; }
        if (highs[i] >= slCalc) { status = "SL_HIT"; break; }
      }

      activePosition = "SHORT";
      entryPrice = Math.round(entryAtCross * 100) / 100;
      slPrice = Math.round(slCalc * 100) / 100;
      tp1 = Math.round(tp1Calc * 100) / 100;
      tp2 = Math.round(tp2Calc * 100) / 100;
      tp3 = Math.round(tp3Calc * 100) / 100;
      trailingStop = Math.round(slCalc * 100) / 100;
      positionStatus = status;

      if (status === "TP3_HIT") {
        signal = "HOLD";
      } else if (status === "SL_HIT") {
        signal = "SELL";  // Keep SELL, don't auto-reset
      } else {
        signal = "SELL";
      }

      if (signal === "SELL" && !volumeCondition) {
        signal = "HOLD";
        positionStatus = "WAIT_VOL";
      }

      sellScore = 60 + Math.round(trendStrength * 2);
      if (volumeSurge) sellScore += 15;
      else if (volumeCondition) sellScore += 10;
      if (rsi > RSI_OVERBOUGHT) sellScore += 10;
      if (price < calcVWAP(closes, volumes)) sellScore += 5;
      if (candlePattern.type === "bearish") sellScore += 10;
      if (srConfirm.confirmed) sellScore += 10;
      sellScore = Math.min(100, sellScore);
      buyScore = Math.max(0, 20 - Math.round(trendStrength));

      const riskPerShare = Math.abs(slCalc - entryAtCross);
      if (riskPerShare > 0) positionSize = Math.floor((INITIAL_CAPITAL * RISK_PERCENT / 100) / riskPerShare);
    }
  } else {
    // No crossover found
    if (ema9 > ema21) { buyScore = 30 + Math.round(trendStrength); sellScore = 10; }
    else { buyScore = 10; sellScore = 30 + Math.round(trendStrength); }
  }

  return {
    signal, entry: entryPrice, sl: slPrice, tp1, tp2, tp3,
    trailingStop, positionSize, buyScore, sellScore,
    emaCrossover: crossoverResult, trendStrength: Math.round(trendStrength * 100) / 100,
    volumeCondition, volumeSurge, activePosition, positionStatus,
  };
}

// ===== MAIN HANDLER =====
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = await req.json();
    const symbols: string[] = body.symbols || [];
    const timeframe: string = body.timeframe || "intraday";

    const results = await Promise.all(
      symbols.map(async (sym: string) => {
        let yahooSym = sym;
        if (!yahooSym.startsWith('^') && !yahooSym.includes('.')) yahooSym = yahooSym + '.NS';
        try {
          let interval: string, range: string;
          if (timeframe === "intraday" || timeframe === "5m") { interval = "5m"; range = "1mo"; }
          else if (timeframe === "15m") { interval = "15m"; range = "1mo"; }
          else if (timeframe === "1h") { interval = "60m"; range = "3mo"; }
          else { interval = "1d"; range = "6mo"; }
          
          const url = `https://query1.finance.yahoo.com/v8/finance/chart/${yahooSym}?interval=${interval}&range=${range}`;
          const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
          let j: any;
          try { j = await res.json(); } catch { throw new Error("Yahoo JSON parsing failed"); }
          if (!j?.chart?.result?.length) throw new Error("Yahoo returned empty result");

          const result = j.chart.result[0];
          const meta = result.meta || {};
          const candles = result.indicators?.quote?.[0];
          if (!candles) throw new Error("Missing candle data");

          // Build clean arrays — keep opens too for candlestick patterns
          const rawCloses = candles.close || [];
          const rawHighs = candles.high || [];
          const rawLows = candles.low || [];
          const rawOpens = candles.open || [];
          const rawVolumes = candles.volume || [];
          
          // Filter nulls but keep alignment
          const validIdx: number[] = [];
          for (let i = 0; i < rawCloses.length; i++) {
            if (rawCloses[i] != null && rawHighs[i] != null && rawLows[i] != null && rawOpens[i] != null) {
              validIdx.push(i);
            }
          }
          const closes = validIdx.map(i => Number(rawCloses[i]));
          const highs = validIdx.map(i => Number(rawHighs[i]));
          const lows = validIdx.map(i => Number(rawLows[i]));
          const opens = validIdx.map(i => Number(rawOpens[i]));
          const volumes = validIdx.map(i => Number(rawVolumes[i]) || 0);

          if (closes.length < 25) throw new Error("Insufficient candles (<25)");

          const price = meta.regularMarketPrice || closes[closes.length - 1];
          const prev = meta.chartPreviousClose || meta.previousClose || closes[closes.length - 2] || price;
          const change = price - prev;
          const changePercent = prev ? (change / prev) * 100 : 0;

          // === EMAs ===
          const ema9Arr = calcEMA(closes, EMA9_LENGTH);
          const ema21Arr = calcEMA(closes, EMA21_LENGTH);
          const ema9 = Math.round(ema9Arr[ema9Arr.length - 1] * 100) / 100;
          const ema21 = Math.round(ema21Arr[ema21Arr.length - 1] * 100) / 100;
          const emas: Record<string, number> = { ema9, ema21 };
          const extraPeriods = timeframe === "swing" ? [50, 100] : timeframe === "1h" ? [50, 100] : [5, 13, 26];
          for (const p of extraPeriods) {
            if (closes.length >= p) {
              const arr = calcEMA(closes, p);
              emas[`ema${p}`] = Math.round(arr[arr.length - 1] * 100) / 100;
            }
          }

          const rsi = Math.round(calcRSI(closes, RSI_LENGTH) * 100) / 100;
          const atr = Math.round(calcATR(highs, lows, closes, ATR_LENGTH) * 100) / 100;
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

          // === Support/Resistance (current timeframe) ===
          const lookback = (timeframe === "intraday" || timeframe === "5m") ? 5 : timeframe === "15m" ? 10 : 20;
          const resistance = Math.round(Math.max(...highs.slice(-lookback)) * 100) / 100;
          const support = Math.round(Math.min(...lows.slice(-lookback)) * 100) / 100;

          // === CANDLESTICK PATTERN ===
          const candlePat = detectCandlePattern(highs, lows, opens, closes);

          // === CHART PATTERN ===
          const chartPat = detectChartPattern(highs, lows, closes);

          // === MULTI-TIMEFRAME SR (fetch daily data) ===
          const dailySR = await fetchDailySR(yahooSym);
          
          // === SR CONFIRMATION ===
          const isBullish = ema9 > ema21;
          const srConfirm = checkSRConfirmation(price, dailySR, isBullish);

          // === RUN STRATEGY with all confirmations ===
          const strat = runStrategy(closes, highs, lows, volumes, price, ema9Arr, ema21Arr, candlePat, srConfirm);

          // === Trend ===
          let trend = "Sideways";
          if (ema9 > ema21) trend = "Up";
          else if (ema9 < ema21) trend = "Down";

          // === ORB ===
          let orbSignal = "None";
          if ((timeframe === "intraday" || timeframe === "5m" || timeframe === "15m") && highs.length > 0 && lows.length > 0) {
            if (price > highs[0]) orbSignal = "Bullish ORB";
            else if (price < lows[0]) orbSignal = "Bearish ORB";
          }

          // === 52-week data ===
          const fiftyTwoWeekHigh = meta.fiftyTwoWeekHigh || 0;
          const fiftyTwoWeekLow = meta.fiftyTwoWeekLow || 0;
          const pctFrom52WeekHigh = fiftyTwoWeekHigh ? Math.round(((fiftyTwoWeekHigh - price) / fiftyTwoWeekHigh) * 100 * 100) / 100 : 0;

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
            tp1: strat.tp1, tp2: strat.tp2, tp3: strat.tp3,
            trailingStop: strat.trailingStop,
            positionSize: strat.positionSize,
            positionStatus: strat.positionStatus,
            activePosition: strat.activePosition,
            trendStrength: strat.trendStrength,
            volumeCondition: strat.volumeCondition,
            volumeSurge: strat.volumeSurge,
            // Pattern detection
            candlePattern: candlePat.pattern,
            candlePatternType: candlePat.type,
            chartPattern: chartPat.pattern,
            chartPatternType: chartPat.type,
            // Multi-timeframe SR
            srLevels: dailySR,
            srConfirmation: srConfirm.confirmed,
            srLevel: srConfirm.level,
            srDetail: srConfirm.detail,
            // Legacy
            emaCrossover, emaCrossSignal, trend, orbSignal,
            fiftyTwoWeekHigh, fiftyTwoWeekLow, pctFrom52WeekHigh,
            dayHigh: meta.regularMarketDayHigh || price,
            dayLow: meta.regularMarketDayLow || price,
            previousClose: prev,
            error: false
          };
        } catch (yahooErr: any) {
          // === FALLBACK: DB + TradingView ===
          console.warn(`Yahoo failed for ${sym}: ${yahooErr.message}. Trying fallback...`);
          try {
            const tvTicker = getTVTicker(sym);
            const tv = await fetchTradingView(tvTicker);
            const supabaseUrl = "https://mmxkisgdoepojotignkg.supabase.co";
            const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
            const dbUrl = `${supabaseUrl}/rest/v1/stock_daily_prices?symbol=eq.${sym}&order=trade_date.desc&limit=100`;
            const dbRes = await fetch(dbUrl, {
              headers: { "apikey": supabaseKey, "Authorization": `Bearer ${supabaseKey}`, "Content-Type": "application/json" }
            });
            if (!dbRes.ok) throw new Error(`DB fetch failed: ${dbRes.status}`);
            const dbRows = await dbRes.json();
            if (!Array.isArray(dbRows)) throw new Error("DB response not array");
            
            const sortedRows = dbRows.slice().reverse();
            const closes = sortedRows.map((r: any) => Number(r.close));
            const highs = sortedRows.map((r: any) => Number(r.high));
            const lows = sortedRows.map((r: any) => Number(r.low));
            const opens = sortedRows.map((r: any) => Number(r.open || r.close));
            const volumes = sortedRows.map((r: any) => Number(r.volume));
            if (tv) { closes.push(Number(tv.close)); highs.push(Number(tv.high)); lows.push(Number(tv.low)); volumes.push(Number(tv.volume)); opens.push(Number(tv.open || tv.close)); }
            
            if (closes.length < 25) {
              const price = tv ? tv.close : (closes[closes.length - 1] || 0);
              const changePercent = tv ? tv.change_pct : (sortedRows[sortedRows.length - 1]?.change_percent || 0);
              const change = tv ? tv.change_abs : (sortedRows[sortedRows.length - 1]?.change_val || 0);
              const prev = tv ? (tv.close - tv.change_abs) : (sortedRows[sortedRows.length - 1]?.prev_close || price - change);
              return {
                symbol: sym, price: Math.round(price * 100) / 100, change: Math.round(change * 100) / 100,
                changePercent: Math.round(changePercent * 100) / 100, emas: {}, rsi: null, atr: null, vwap: null,
                volumeRatio: 0, support: null, resistance: null, signal: "HOLD", buyScore: 0, sellScore: 0,
                entry: null, sl: null, tp1: null, tp2: null, tp3: null, trailingStop: null, positionSize: null,
                positionStatus: null, activePosition: null, trendStrength: 0, volumeCondition: false, volumeSurge: false,
                candlePattern: "Unknown", candlePatternType: "neutral", chartPattern: "Unknown", chartPatternType: "neutral",
                srLevels: {}, srConfirmation: false, srLevel: "none", srDetail: "No SR data",
                emaCrossover: { golden: false, death: false, cross: "none" }, emaCrossSignal: "None",
                trend: "Sideways", orbSignal: "None",
                fiftyTwoWeekHigh: 0, fiftyTwoWeekLow: 0, pctFrom52WeekHigh: 0,
                dayHigh: tv ? tv.high : price, dayLow: tv ? tv.low : price, previousClose: prev, error: false, note: "TA unavailable"
              };
            }

            const price = tv ? tv.close : (closes[closes.length - 1] || 0);
            const changePercent = tv ? tv.change_pct : (sortedRows[sortedRows.length - 1]?.change_percent || 0);
            const change = tv ? tv.change_abs : (sortedRows[sortedRows.length - 1]?.change_val || 0);
            const prev = tv ? (tv.close - tv.change_abs) : (sortedRows[sortedRows.length - 1]?.prev_close || price - change);

            const ema9Arr = calcEMA(closes, EMA9_LENGTH);
            const ema21Arr = calcEMA(closes, EMA21_LENGTH);
            const ema9 = Math.round(ema9Arr[ema9Arr.length - 1] * 100) / 100;
            const ema21 = Math.round(ema21Arr[ema21Arr.length - 1] * 100) / 100;
            const emas: Record<string, number> = { ema9, ema21 };
            const extraPeriods = timeframe === "swing" ? [50, 100] : [5, 13, 26];
            for (const p of extraPeriods) { if (closes.length >= p) { const arr = calcEMA(closes, p); emas[`ema${p}`] = Math.round(arr[arr.length - 1] * 100) / 100; } }

            const rsi = Math.round(calcRSI(closes, RSI_LENGTH) * 100) / 100;
            const atr = Math.round(calcATR(highs, lows, closes, ATR_LENGTH) * 100) / 100;
            const vwap = Math.round(calcVWAP(closes, volumes) * 100) / 100;

            let volumeRatio = 0;
            const regVol = tv ? tv.volume : (volumes[volumes.length - 1] || 0);
            const nonZeroVols = volumes.filter((v: number) => v > 0);
            if (regVol && nonZeroVols.length >= 2) {
              const recent = nonZeroVols.slice(-20, -1);
              const avgRecent = recent.length ? recent.reduce((a: number, b: number) => a + b, 0) / recent.length : 0;
              const candlesPerDay = (timeframe === "intraday" || timeframe === "5m") ? 75 : 1;
              const estAvgDaily = avgRecent * candlesPerDay;
              volumeRatio = estAvgDaily ? Math.round((regVol / estAvgDaily) * 100) / 100 : 0;
            }

            const lookback = 20;
            const resistance = Math.round(Math.max(...highs.slice(-lookback)) * 100) / 100;
            const support = Math.round(Math.min(...lows.slice(-lookback)) * 100) / 100;

            const candlePat = detectCandlePattern(highs, lows, opens, closes);
            const chartPat = detectChartPattern(highs, lows, closes);
            const dailySR = await fetchDailySR(yahooSym);
            const srConfirm = checkSRConfirmation(price, dailySR, ema9 > ema21);
            const strat = runStrategy(closes, highs, lows, volumes, price, ema9Arr, ema21Arr, candlePat, srConfirm);

            let trend = "Sideways";
            if (ema9 > ema21) trend = "Up"; else if (ema9 < ema21) trend = "Down";

            const fiftyTwoWeekHigh = highs.length ? Math.max(...highs) : price;
            const fiftyTwoWeekLow = lows.length ? Math.min(...lows) : price;
            const pctFrom52WeekHigh = fiftyTwoWeekHigh ? Math.round(((fiftyTwoWeekHigh - price) / fiftyTwoWeekHigh) * 100 * 100) / 100 : 0;

            const emaCrossover: any = strat.emaCrossover;
            let emaCrossSignal = "None";
            if (emaCrossover.cross === "golden") emaCrossSignal = "Golden Cross";
            else if (emaCrossover.cross === "death") emaCrossSignal = "Death Cross";

            return {
              symbol: sym, price: Math.round(price * 100) / 100, change: Math.round(change * 100) / 100,
              changePercent: Math.round(changePercent * 100) / 100, emas, rsi, atr, vwap, volumeRatio, support, resistance,
              signal: strat.signal, buyScore: strat.buyScore, sellScore: strat.sellScore,
              entry: strat.entry, sl: strat.sl, tp1: strat.tp1, tp2: strat.tp2, tp3: strat.tp3,
              trailingStop: strat.trailingStop, positionSize: strat.positionSize,
              positionStatus: strat.positionStatus, activePosition: strat.activePosition,
              trendStrength: strat.trendStrength, volumeCondition: strat.volumeCondition, volumeSurge: strat.volumeSurge,
              candlePattern: candlePat.pattern, candlePatternType: candlePat.type,
              chartPattern: chartPat.pattern, chartPatternType: chartPat.type,
              srLevels: dailySR, srConfirmation: srConfirm.confirmed, srLevel: srConfirm.level, srDetail: srConfirm.detail,
              emaCrossover, emaCrossSignal, trend, orbSignal: "None",
              fiftyTwoWeekHigh: Math.round(fiftyTwoWeekHigh * 100) / 100, fiftyTwoWeekLow: Math.round(fiftyTwoWeekLow * 100) / 100,
              pctFrom52WeekHigh, dayHigh: tv ? tv.high : price, dayLow: tv ? tv.low : price,
              previousClose: Math.round(prev * 100) / 100, error: false, note: "Computed via fallback (DB + TV)"
            };
          } catch (fallbackErr: any) {
            console.error(`Fallback failed for ${sym}:`, fallbackErr);
            return { symbol: sym, error: true, note: `Yahoo and Fallback failed: ${fallbackErr.message}` };
          }
        }
      })
    );

    return new Response(JSON.stringify({ success: true, data: results }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ success: false, error: e.message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
