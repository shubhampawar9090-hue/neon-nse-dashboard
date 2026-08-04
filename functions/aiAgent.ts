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

// ============================================
// --- PINE SCRIPT v6 LOGIC PORT ---
// Sniper Entry/Exit with SL&TP V.03
// SL = ATR × 2, TP1-5 at 1:1 / 1:2 / 1:3 / 1:4 / 1:5 RR
// ============================================

// Signal Score Weights (matching Pine Script defaults)
const WEIGHTS = {
  vwap: 1.0,
  rsi: 1.0,
  macd: 1.0,
  emaCross: 1.0,
  adx: 1.0,
  volume: 1.0,
  rsiMultiTF: 1.0
};

// EMA periods (Pine Script: 9 fast, 21 slow)
const EMA_FAST = 9;
const EMA_SLOW = 21;

// RSI settings
const RSI_LENGTH = 14;
const RSI_OVERBOUGHT = 70;
const RSI_OVERSOLD = 30;
const RSI_MIDLINE = 50;

// MACD settings
const MACD_FAST = 12;
const MACD_SLOW = 26;
const MACD_SIGNAL = 9;

// ADX settings
const ADX_LENGTH = 14;
const ADX_THRESHOLD = 25;

// Volume settings
const VOLUME_MA_PERIOD = 20;
const VOLUME_THRESHOLD = 1.0;

// ATR settings
const ATR_LENGTH = 14;
const ATR_MULTIPLIER = 2.0;  // SL = ATR × 2

// Risk Reward ratios for TP levels
const RR_TP1 = 1.0;
const RR_TP2 = 2.0;
const RR_TP3 = 3.0;
const RR_TP4 = 4.0;
const RR_TP5 = 5.0;

// --- TECHNICAL CALCULATION FUNCTIONS ---

function calcEMA(data, period) {
  if (data.length < period) return null;
  const k = 2 / (period + 1);
  let ema = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < data.length; i++) ema = data[i] * k + ema * (1 - k);
  return parseFloat(ema.toFixed(2));
}

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

function calcATR(highs, lows, closes, period) {
  if (closes.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < closes.length; i++) {
    trs.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    ));
  }
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
  }
  return parseFloat(atr.toFixed(2));
}

function calcMACD(data, fast, slow, signal) {
  const emaFast = calcEMA(data, fast);
  const emaSlow = calcEMA(data, slow);
  if (emaFast === null || emaSlow === null) return { macdLine: null, signalLine: null, histLine: null };
  
  // Calculate full MACD line
  const macdValues = [];
  const kFast = 2 / (fast + 1);
  const kSlow = 2 / (slow + 1);
  let eF = data.slice(0, fast).reduce((a, b) => a + b, 0) / fast;
  let eS = data.slice(0, slow).reduce((a, b) => a + b, 0) / slow;
  for (let i = fast; i < data.length; i++) {
    eF = data[i] * kFast + eF * (1 - kFast);
    if (i >= slow) {
      eS = data[i] * kSlow + eS * (1 - kSlow);
      macdValues.push(eF - eS);
    }
  }
  
  if (macdValues.length < signal) return { macdLine: parseFloat(macdValues[macdValues.length-1].toFixed(2)), signalLine: null, histLine: null };
  
  // Signal line = EMA of MACD values
  const kSig = 2 / (signal + 1);
  let sig = macdValues.slice(0, signal).reduce((a, b) => a + b, 0) / signal;
  for (let i = signal; i < macdValues.length; i++) {
    sig = macdValues[i] * kSig + sig * (1 - kSig);
  }
  
  const macdLine = parseFloat(macdValues[macdValues.length - 1].toFixed(2));
  const signalLine = parseFloat(sig.toFixed(2));
  const histLine = parseFloat((macdLine - signalLine).toFixed(2));
  
  return { macdLine, signalLine, histLine };
}

function calcADX(highs, lows, closes, period) {
  if (closes.length < period * 2) return { dmiPlus: null, dmiMinus: null, adx: null };
  
  const plusDM = [];
  const minusDM = [];
  const trs = [];
  
  for (let i = 1; i < closes.length; i++) {
    const upMove = highs[i] - highs[i - 1];
    const downMove = lows[i - 1] - lows[i];
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
    trs.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    ));
  }
  
  // Smoothed values (Wilder's method)
  let smoothTR = trs.slice(0, period).reduce((a, b) => a + b, 0);
  let smoothPlusDM = plusDM.slice(0, period).reduce((a, b) => a + b, 0);
  let smoothMinusDM = minusDM.slice(0, period).reduce((a, b) => a + b, 0);
  
  for (let i = period; i < trs.length; i++) {
    smoothTR = smoothTR - smoothTR / period + trs[i];
    smoothPlusDM = smoothPlusDM - smoothPlusDM / period + plusDM[i];
    smoothMinusDM = smoothMinusDM - smoothMinusDM / period + minusDM[i];
  }
  
  const dmiPlus = smoothTR > 0 ? parseFloat((smoothPlusDM / smoothTR * 100).toFixed(1)) : 0;
  const dmiMinus = smoothTR > 0 ? parseFloat((smoothMinusDM / smoothTR * 100).toFixed(1)) : 0;
  
  const dx = (dmiPlus + dmiMinus) > 0 ? Math.abs(dmiPlus - dmiMinus) / (dmiPlus + dmiMinus) * 100 : 0;
  
  return { dmiPlus, dmiMinus, adx: parseFloat(dx.toFixed(1)) };
}

function calcVWAP(highs, lows, closes, volumes) {
  let totalPV = 0, totalV = 0;
  for (let i = 0; i < closes.length; i++) {
    totalPV += ((highs[i] + lows[i] + closes[i]) / 3) * (volumes[i] || 0);
    totalV += volumes[i] || 0;
  }
  return totalV > 0 ? parseFloat((totalPV / totalV).toFixed(2)) : null;
}

// Fetch data for multi-timeframe RSI
async function fetchMultiTFRSI(sym, rsiLength) {
  const results = {};
  const intervals = [
    { tf: "5m", range: "5d", key: "5m" },
    { tf: "15m", range: "5d", key: "15m" },
    { tf: "60m", range: "1mo", key: "60m" }
  ];
  
  for (const { tf, range, key } of intervals) {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=${tf}&range=${range}`;
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
      if (!res.ok) continue;
      const json = await res.json();
      const result = json.chart?.result?.[0];
      const closes = result?.indicators?.quote?.[0]?.close?.filter(v => v != null) || [];
      if (closes.length >= rsiLength + 1) {
        results[key] = calcRSI(closes, rsiLength);
      }
    } catch (e) {}
  }
  
  return results;
}

// ============================================
// --- WEIGHTED SCORE LOGIC (Pine Script port) ---
// ============================================
function calcBullScore(params) {
  const { price, vwap, rsi, macdLine, signalLine, ema9, ema21, adx, volAvg, volume, close_open, rsi5m } = params;
  
  let score = 0;
  if (vwap !== null && price > vwap) score += WEIGHTS.vwap;
  if (rsi !== null && rsi > RSI_MIDLINE) score += WEIGHTS.rsi;
  if (macdLine !== null && signalLine !== null && macdLine > signalLine) score += WEIGHTS.macd;
  if (ema9 !== null && ema21 !== null && ema9 > ema21) score += WEIGHTS.emaCross;
  if (adx !== null && adx > ADX_THRESHOLD && price > ema9) score += WEIGHTS.adx;
  if (volAvg > 0 && volume > volAvg * VOLUME_THRESHOLD && close_open > 0) score += WEIGHTS.volume;
  if (rsi5m !== null && rsi5m > RSI_MIDLINE) score += WEIGHTS.rsiMultiTF;
  
  return score;
}

function calcBearScore(params) {
  const { price, vwap, rsi, macdLine, signalLine, ema9, ema21, adx, volAvg, volume, close_open, rsi5m } = params;
  
  let score = 0;
  if (vwap !== null && price < vwap) score += WEIGHTS.vwap;
  if (rsi !== null && rsi < RSI_MIDLINE) score += WEIGHTS.rsi;
  if (macdLine !== null && signalLine !== null && macdLine < signalLine) score += WEIGHTS.macd;
  if (ema9 !== null && ema21 !== null && ema9 < ema21) score += WEIGHTS.emaCross;
  if (adx !== null && adx > ADX_THRESHOLD && price < ema9) score += WEIGHTS.adx;
  if (volAvg > 0 && volume > volAvg * VOLUME_THRESHOLD && close_open < 0) score += WEIGHTS.volume;
  if (rsi5m !== null && rsi5m < RSI_MIDLINE) score += WEIGHTS.rsiMultiTF;
  
  return score;
}

const TOTAL_WEIGHT = WEIGHTS.vwap + WEIGHTS.rsi + WEIGHTS.macd + WEIGHTS.emaCross + WEIGHTS.adx + WEIGHTS.volume + WEIGHTS.rsiMultiTF;

// ============================================
// --- SIGNAL LOGIC (EMA 9/21 crossover) ---
// ============================================
function getSignal(ema9, ema21, ema9Prev, ema21Prev, bullScore, bearScore) {
  // EMA crossover detection (Pine Script: ta.crossover / ta.crossunder)
  const crossover = ema9Prev !== null && ema21Prev !== null && ema9Prev <= ema21Prev && ema9 > ema21;
  const crossunder = ema9Prev !== null && ema21Prev !== null && ema9Prev >= ema21Prev && ema9 < ema21;
  
  const bullPct = TOTAL_WEIGHT > 0 ? (bullScore / TOTAL_WEIGHT) * 100 : 0;
  const bearPct = TOTAL_WEIGHT > 0 ? (bearScore / TOTAL_WEIGHT) * 100 : 0;
  
  let signal = "HOLD";
  let action = "NONE";
  
  if (crossover) {
    signal = bullPct >= 70 ? "STRONG BUY" : "BUY";
    action = "BUY";
  } else if (crossunder) {
    signal = bearPct >= 70 ? "STRONG SELL" : "SELL";
    action = "SELL";
  } else if (bullPct >= 70) {
    signal = "BUY";
    action = "BUY";
  } else if (bearPct >= 70) {
    signal = "SELL";
    action = "SELL";
  }
  
  return { signal, action, bullPct: parseFloat(bullPct.toFixed(1)), bearPct: parseFloat(bearPct.toFixed(1)) };
}

// ============================================
// --- SL/TP CALCULATION (ATR × 2) ---
// ============================================
function calcSLTP(entryPrice, atr, action) {
  if (atr === null) return { sl: null, tp1: null, tp2: null, tp3: null, tp4: null, tp5: null };
  
  const risk = atr * ATR_MULTIPLIER;  // SL = ATR × 2
  const direction = action === "BUY" ? 1 : -1;
  
  return {
    sl: parseFloat((entryPrice - risk * direction).toFixed(2)),
    tp1: parseFloat((entryPrice + risk * RR_TP1 * direction).toFixed(2)),
    tp2: parseFloat((entryPrice + risk * RR_TP2 * direction).toFixed(2)),
    tp3: parseFloat((entryPrice + risk * RR_TP3 * direction).toFixed(2)),
    tp4: parseFloat((entryPrice + risk * RR_TP4 * direction).toFixed(2)),
    tp5: parseFloat((entryPrice + risk * RR_TP5 * direction).toFixed(2))
  };
}

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);
  
  let body;
  try { body = await req.json(); } catch { body = {}; }
  const query = body.content || body.query || body.question || "";
  const convId = body.conversation_id || null;
  const mode = body.mode || "analysis";  // "analysis" or "trade"

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

  for (const idx of indices) {
    for (const alias of idx.aliases) {
      if (queryLower.includes(alias.toLowerCase())) {
        if (!symbols.includes(idx.sym)) symbols.push(idx.sym);
        break;
      }
    }
  }

  for (const [ticker, aliases] of Object.entries(stockAliases)) {
    for (const alias of aliases) {
      if (queryLower.includes(alias.toLowerCase())) {
        if (!symbols.includes(ticker)) symbols.push(ticker);
        break;
      }
    }
  }

  const nsMatches = query.match(/[A-Z0-9&\-\.]+\.NS/gi);
  if (nsMatches) {
    for (const m of nsMatches) {
      const sym = m.toUpperCase();
      if (!symbols.includes(sym)) symbols.push(sym);
    }
  }

  const upperWords = query.match(/\b[A-Z][A-Z0-9&\-]{2,}\b/g);
  if (upperWords) {
    const nseSet = await getNseSymbols();
    if (nseSet) {
      for (const w of upperWords) {
        if (nseSet.has(w) && !symbols.includes(w + ".NS")) symbols.push(w + ".NS");
        }
      }
    }
  }

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
      response: "👋 Hi! I'm <b>Sniper AI</b> — your trading assistant with Pine Script v6 signal logic.\n\nI use <b>EMA 9/21 crossover</b> + <b>7-factor weighted scoring</b> (VWAP, RSI, MACD, EMA, ADX, Volume, Multi-TF RSI) with <b>ATR × 2 stop-loss</b> and TP1-5 at 1:1 to 1:5 risk ratios.\n\nTry:\n• <b>\"Analyze NIFTY\"</b> — full signal breakdown\n• <b>\"TCS buy or sell?\"</b> — entry/SL/TP\n• <b>\"Market today\"</b> — all indices snapshot",
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
      const opens = quotes.open?.filter(v => v != null) || [];
      const closes = quotes.close?.filter(v => v != null) || [];
      const highs = quotes.high?.filter(v => v != null) || [];
      const lows = quotes.low?.filter(v => v != null) || [];
      const volumes = quotes.volume?.filter(v => v != null) || [];
      if (closes.length < EMA_SLOW + 1) continue;

      const price = meta.regularMarketPrice || closes[closes.length - 1];
      const prevClose = meta.chartPreviousClose || meta.previousClose || closes[closes.length - 2] || price;
      const changePercent = prevClose ? parseFloat(((price - prevClose) / prevClose * 100).toFixed(2)) : 0;

      // --- PINE SCRIPT v6 INDICATORS ---
      
      // EMAs (9 fast, 21 slow)
      const ema9 = calcEMA(closes, EMA_FAST);
      const ema21 = calcEMA(closes, EMA_SLOW);
      const ema9Prev = calcEMA(closes.slice(0, -1), EMA_FAST);
      const ema21Prev = calcEMA(closes.slice(0, -1), EMA_SLOW);

      // RSI (14)
      const rsi = calcRSI(closes, RSI_LENGTH);

      // VWAP
      const vwap = calcVWAP(highs, lows, closes, volumes);

      // ATR (14)
      const atr = calcATR(highs, lows, closes, ATR_LENGTH);

      // MACD (12, 26, 9)
      const { macdLine, signalLine, histLine } = calcMACD(closes, MACD_FAST, MACD_SLOW, MACD_SIGNAL);

      // ADX/DMI (14)
      const { dmiPlus, dmiMinus, adx } = calcADX(highs, lows, closes, ADX_LENGTH);

      // Volume
      const volAvg = volumes.length > VOLUME_MA_PERIOD ? volumes.slice(-VOLUME_MA_PERIOD - 1, -1).reduce((a, b) => a + b, 0) / VOLUME_MA_PERIOD : 0;
      const currentVol = volumes[volumes.length - 1] || 0;
      const volumeRatio = volAvg > 0 ? parseFloat((currentVol / volAvg).toFixed(2)) : 1;
      const lastOpen = opens[opens.length - 1] || price;
      const close_open = price - lastOpen;  // for volume score direction

      // Multi-timeframe RSI
      const mtfRSI = await fetchMultiTFRSI(sym, RSI_LENGTH);
      const rsi5m = mtfRSI["5m"] || null;
      const rsi15m = mtfRSI["15m"] || null;
      const rsi60m = mtfRSI["60m"] || null;

      // --- WEIGHTED SCORE ---
      const scoreParams = {
        price, vwap, rsi, macdLine, signalLine, ema9, ema21, adx,
        volAvg, volume: currentVol, close_open, rsi5m
      };
      
      const bullScore = calcBullScore(scoreParams);
      const bearScore = calcBearScore(scoreParams);
      const bullPct = TOTAL_WEIGHT > 0 ? parseFloat((bullScore / TOTAL_WEIGHT * 100).toFixed(1)) : 0;
      const bearPct = TOTAL_WEIGHT > 0 ? parseFloat((bearScore / TOTAL_WEIGHT * 100).toFixed(1)) : 0;

      // --- SIGNAL (EMA 9/21 crossover + score) ---
      const { signal, action } = getSignal(ema9, ema21, ema9Prev, ema21Prev, bullScore, bearScore);

      // --- SL/TP (ATR × 2) ---
      const sltp = calcSLTP(price, atr, action === "BUY" ? "BUY" : "SELL");

      // --- PATTERN DETECTION ---
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

      let displayName = sym;
      const idxMap = { "^NSEI": "NIFTY 50", "^BSESN": "SENSEX", "^NSEBANK": "BANK NIFTY", "^CNXIT": "NIFTY IT", "^CNXAUTO": "NIFTY AUTO", "^CNXPHARMA": "NIFTY PHARMA" };
      if (idxMap[sym]) displayName = idxMap[sym];
      else displayName = sym.replace(/\.NS$/, "").replace(/\.BO$/, "");

      analysisResults.push({
        symbol: sym, name: displayName,
        price: parseFloat(price.toFixed(2)), changePercent,
        ema9, ema21, rsi, vwap, atr, adx,
        macdLine, signalLine, histLine,
        dmiPlus, dmiMinus,
        rsi5m, rsi15m, rsi60m,
        volumeRatio, pattern,
        signal, action,
        bullScore, bearScore, bullPct, bearPct,
        sl: sltp.sl, tp1: sltp.tp1, tp2: sltp.tp2, tp3: sltp.tp3, tp4: sltp.tp4, tp5: sltp.tp5,
        fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh, fiftyTwoWeekLow: meta.fiftyTwoWeekLow,
        dayHigh: meta.regularMarketDayHigh, dayLow: meta.regularMarketDayLow,
        atrMultiplier: ATR_MULTIPLIER,
        riskAmount: atr ? parseFloat((atr * ATR_MULTIPLIER).toFixed(2)) : null
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

  // --- TRADE MODE: Return structured signal data for AI Trading Agent ---
  if (mode === "trade") {
    return Response.json({
      success: true,
      mode: "trade",
      timestamp: Date.now(),
      results: analysisResults.map(d => ({
        symbol: d.symbol,
        name: d.name,
        price: d.price,
        signal: d.signal,
        action: d.action,
        bullScore: d.bullScore,
        bearScore: d.bearScore,
        bullPct: d.bullPct,
        bearPct: d.bearPct,
        sl: d.sl,
        tp1: d.tp1, tp2: d.tp2, tp3: d.tp3, tp4: d.tp4, tp5: d.tp5,
        atr: d.atr,
        rsi: d.rsi,
        ema9: d.ema9, ema21: d.ema21,
        adx: d.adx,
        macdLine: d.macdLine, signalLine: d.signalLine,
        vwap: d.vwap,
        riskAmount: d.riskAmount,
        pattern: d.pattern,
        volumeRatio: d.volumeRatio
      })),
      conversation_id: convId || crypto.randomUUID()
    });
  }

  // --- ANALYSIS MODE: Formatted response ---
  let response = "";
  if (analysisResults.length === 1) {
    const d = analysisResults[0];
    const changeIcon = d.changePercent >= 0 ? "🟢" : "🔴";
    const signalEmoji = d.signal.includes("BUY") ? "🟢" : d.signal.includes("SELL") ? "🔴" : "🟡";
    response = "<b>" + d.name + "</b> — " + changeIcon + " ₹" + d.price + " (" + (d.changePercent >= 0 ? "+" : "") + d.changePercent + "%)\n\n";
    response += "<b>" + signalEmoji + " Signal: " + d.signal + "</b>\n";
    response += "Bull Score: " + d.bullPct + "% | Bear Score: " + d.bearPct + "%\n\n";
    response += "<b>📊 Pine Script v6 Indicators</b>\n";
    response += "• EMA 9/21: " + d.ema9 + " / " + d.ema21 + " — " + (d.ema9 > d.ema21 ? "Bullish ↑" : d.ema9 < d.ema21 ? "Bearish ↓" : "Crossing") + "\n";
    response += "• RSI (14): " + d.rsi + (d.rsi < 30 ? " (Oversold)" : d.rsi > 70 ? " (Overbought)" : " (Neutral)") + "\n";
    response += "• VWAP: " + (d.vwap || "N/A") + (d.vwap ? (d.price > d.vwap ? " (Above ✓)" : " (Below ✗)") : "") + "\n";
    response += "• MACD: " + d.macdLine + " / Signal: " + d.signalLine + " — " + (d.macdLine > d.signalLine ? "Bullish" : "Bearish") + "\n";
    response += "• ADX: " + d.adx + (d.adx > 25 ? " (Strong trend)" : " (Weak trend)") + "\n";
    response += "• Multi-TF RSI: 5m=" + (d.rsi5m||"N/A") + " 15m=" + (d.rsi15m||"N/A") + " 60m=" + (d.rsi60m||"N/A") + "\n";
    response += "• ATR (14): " + d.atr + " | Volume: " + d.volumeRatio + "x\n";
    response += "• Pattern: " + d.pattern + "\n\n";
    response += "<b>🎯 Trade Levels (ATR × 2 SL)</b>\n";
    response += "• Entry: ₹" + d.price + "\n";
    response += "• Stop Loss: ₹" + d.sl + " (ATR × 2 = ₹" + d.riskAmount + ")\n";
    response += "• TP1: ₹" + d.tp1 + " (1:1 RR)\n";
    response += "• TP2: ₹" + d.tp2 + " (1:2 RR)\n";
    response += "• TP3: ₹" + d.tp3 + " (1:3 RR)\n";
    response += "• TP4: ₹" + d.tp4 + " (1:4 RR)\n";
    response += "• TP5: ₹" + d.tp5 + " (1:5 RR)\n\n";
    if (d.signal.includes("BUY")) {
      response += "<b>💡 Verdict:</b> Bullish — EMA 9/21 " + (d.ema9 > d.ema21 ? "stacked bullish" : "crossing up") + ", score " + d.bullPct + "%. Entry at ₹" + d.price + " with SL at ₹" + d.sl + " (ATR × 2).";
    } else if (d.signal.includes("SELL")) {
      response += "<b>💡 Verdict:</b> Bearish — EMA 9/21 " + (d.ema9 < d.ema21 ? "stacked bearish" : "crossing down") + ", score " + d.bearPct + "%. Short/sell at ₹" + d.price + " with SL at ₹" + d.sl + " (ATR × 2).";
    } else {
      response += "<b>💡 Verdict:</b> Neutral — wait for EMA 9/21 crossover with score confirmation above 70%.";
    }
  } else if (analysisResults.length <= 3) {
    for (const d of analysisResults) {
      const signalEmoji = d.signal.includes("BUY") ? "🟢" : d.signal.includes("SELL") ? "🔴" : "🟡";
      response += "<b>" + d.name + "</b> " + signalEmoji + " ₹" + d.price + " (" + (d.changePercent >= 0 ? "+" : "") + d.changePercent + "%)\n";
      response += "  " + d.signal + " | Score " + d.bullPct + "%B / " + d.bearPct + "%S | EMA " + d.ema9 + "/" + d.ema21 + " | RSI " + d.rsi + " | ADX " + d.adx + "\n";
      if (d.sl) response += "  SL: ₹" + d.sl + " (ATR×2) | TP1: ₹" + d.tp1 + " | TP2: ₹" + d.tp2 + " | TP3: ₹" + d.tp3 + "\n";
      response += "\n";
    }
    response += "Ask me about any specific stock for full SL/TP breakdown!";
  } else {
    response += "📊 <b>Market Snapshot — Pine Script v6</b>\n\n";
    const buyStocks = analysisResults.filter(d => d.signal.includes("BUY")).sort((a, b) => b.bullPct - a.bullPct);
    const sellStocks = analysisResults.filter(d => d.signal.includes("SELL")).sort((a, b) => a.bearPct - b.bearPct);
    const holdStocks = analysisResults.filter(d => d.signal === "HOLD");
    if (buyStocks.length > 0) {
      response += "🟢 <b>Bullish</b>\n";
      for (const d of buyStocks.slice(0, 5)) response += "  " + d.name + " ₹" + d.price + " (" + (d.changePercent >= 0 ? "+" : "") + d.changePercent + "%) — " + d.signal + " | " + d.bullPct + "% | SL ₹" + d.sl + " | TP2 ₹" + d.tp2 + "\n";
      response += "\n";
    }
    if (sellStocks.length > 0) {
      response += "🔴 <b>Bearish</b>\n";
      for (const d of sellStocks.slice(0, 5)) response += "  " + d.name + " ₹" + d.price + " (" + (d.changePercent >= 0 ? "+" : "") + d.changePercent + "%) — " + d.signal + " | " + d.bearPct + "% | SL ₹" + d.sl + "\n";
      response += "\n";
    }
    if (holdStocks.length > 0) {
      response += "🟡 <b>Neutral</b>\n";
      for (const d of holdStocks.slice(0, 3)) response += "  " + d.name + " ₹" + d.price + " — HOLD\n";
    }
    response += "\nATR × 2 stop-loss | TP1-5 at 1:1 to 1:5 RR | Ask for full breakdown!";
  }

  return Response.json({ success: true, response: response, conversation_id: convId || crypto.randomUUID() });
});
