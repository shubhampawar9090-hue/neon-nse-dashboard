// megabull-agent — Supabase port of Base44 megabullAgent v4.1 (identical logic; adds key guard)
// Shared: simple key guard for cron-internal edge functions.
// Accepts either the service-role bearer or the x-cron-key secret.
export function authorized(req: Request): boolean {
  const auth = req.headers.get("Authorization") || "";
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (service && auth === `Bearer ${service}`) return true;
  const cronKey = req.headers.get("x-cron-key") || "";
  const secret = Deno.env.get("CRON_SECRET") || "";
  return !!(cronKey && secret && cronKey === secret);
}

// MegaBull Trading Agent v4.1 - Full Scan + Greeks + FII/DII
// Actions: full_scan, analyze, analyze_options, execute, positions, orders, holdings, profile, report, resolve, cancel

const SUPABASE_URL = 'https://jqmhcalsabexjjiceoux.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpxbWhjYWxzYWJleGpqaWNlb3V4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU0MjM1MTMsImV4cCI6MjEwMDk5OTUxM30.nleTw2AsZfQubBEYYWsPKuzqzGFmB9ueR93gmvKYek8';



// === Black-Scholes Greeks Calculation ===
function erf(x: number): number {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1; x = Math.abs(x);
  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return sign * y;
}

function normCDF(x: number): number { return 0.5 * (1 + erf(x / Math.sqrt(2))); }
function normPDF(x: number): number { return Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI); }

function calculateGreeks(S: number, K: number, T: number, r: number, sigma: number, type: string) {
  if (T <= 0 || sigma <= 0 || S <= 0 || K <= 0) return null;
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + sigma * sigma / 2) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  const discountK = K * Math.exp(-r * T);
  const nPrimeD1 = normPDF(d1);

  let delta: number, theta: number;
  if (type === 'CE') {
    delta = normCDF(d1);
    theta = (-S * nPrimeD1 * sigma / (2 * sqrtT) - r * discountK * normCDF(d2)) / 365;
  } else {
    delta = normCDF(d1) - 1;
    theta = (-S * nPrimeD1 * sigma / (2 * sqrtT) + r * discountK * normCDF(-d2)) / 365;
  }
  const gamma = nPrimeD1 / (S * sigma * sqrtT);
  const vega = S * nPrimeD1 * sqrtT / 100;

  // Theoretical premium
  let premium: number;
  if (type === 'CE') {
    premium = S * normCDF(d1) - discountK * normCDF(d2);
  } else {
    premium = discountK * normCDF(-d2) - S * normCDF(-d1);
  }

  return {
    delta: parseFloat(delta.toFixed(4)),
    gamma: parseFloat(gamma.toFixed(6)),
    theta: parseFloat(theta.toFixed(2)),
    vega: parseFloat(vega.toFixed(2)),
    theoreticalPremium: parseFloat(premium.toFixed(2)),
    intrinsicValue: type === 'CE' ? Math.max(0, S - K) : Math.max(0, K - S),
    timeValue: parseFloat((Math.max(0, type === 'CE' ? S - K : K - S) > 0 ? premium - Math.max(0, type === 'CE' ? S - K : K - S) : premium).toFixed(2)),
    moneyness: type === 'CE' ? (S > K ? 'ITM' : S < K ? 'OTM' : 'ATM') : (S < K ? 'ITM' : S > K ? 'OTM' : 'ATM'),
  };
}

function parseExpiryToDays(expiry: string): number {
  const monthMap: Record<string, number> = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
  const m = expiry.match(/^(\d{2})([A-Z]{3})$/);
  if (!m) return 30;
  const day = parseInt(m[1]); const month = monthMap[m[2]]; if (month === undefined) return 30;
  const now = new Date();
  let year = now.getFullYear();
  let expiryDate = new Date(year, month, day, 15, 30, 0);
  if (expiryDate < now) expiryDate = new Date(year + 1, month, day, 15, 30, 0);
  const diffMs = expiryDate.getTime() - now.getTime();
  return Math.max(1, Math.ceil(diffMs / (1000 * 60 * 60 * 24)));
}

// === Instrument & Option Chain Cache ===
let symbolMap: Record<string, { megaSymbol: string; instrumentToken: string }> | null = null;
let optionChain: Record<string, any[]> | null = null;
let mapExpiry = 0;

async function loadInstruments() {
  if (symbolMap && optionChain && Date.now() < mapExpiry) return;
  try {
    const instRes = await megaFetch('/api/marketwatch/instruments');
    if (!instRes?.downloadUrl) throw new Error('No CSV URL');
    const csvRes = await fetch(instRes.downloadUrl);
    const csvText = await csvRes.text();
    const lines = csvText.trim().split('\n');
    symbolMap = {}; optionChain = { NIFTY: [], BANKNIFTY: [], SENSEX: [] };
    const suffixRegex = /-(BE|BZ|IV|RR|E1|N1|B1|S1)$/;
    for (let i = 1; i < lines.length; i++) {
      const match = lines[i].match(/"([^"]+)","([^"]*)","([^"]+)"/);
      if (!match) continue;
      const sym = match[1]; const token = match[3];
      symbolMap[sym] = { megaSymbol: sym, instrumentToken: token };
      const base = sym.replace(suffixRegex, '');
      if (base !== sym && !symbolMap[base]) symbolMap[base] = { megaSymbol: sym, instrumentToken: token };
      const optMatch = sym.match(/^(NIFTY|BANKNIFTY|SENSEX)(\d{2}[A-Z]{3})(\d+)(CE|PE)$/);
      if (optMatch) {
        const [, underlying, expiry, strike, type] = optMatch;
        if (!optionChain[underlying]) optionChain[underlying] = [];
        optionChain[underlying].push({ symbol: sym, token, strike: parseInt(strike), type, expiry, underlying });
      }
    }
    for (const k of Object.keys(optionChain)) optionChain[k].sort((a, b) => a.strike - b.strike);
    mapExpiry = Date.now() + 3600000;
  } catch (e) {
    if (!symbolMap) symbolMap = {};
    if (!optionChain) optionChain = { NIFTY: [], BANKNIFTY: [], SENSEX: [] };
  }
}

async function getSymbolMap() { await loadInstruments(); return symbolMap!; }
async function getOptionChain() { await loadInstruments(); return optionChain!; }

function findATMOption(chain: any[], indexLevel: number, type: string, stepSize: number) {
  const atmStrike = Math.round(indexLevel / stepSize) * stepSize;
  let best: any = null; let minDiff = Infinity;
  for (const opt of chain) { if (opt.type !== type) continue; const diff = Math.abs(opt.strike - atmStrike); if (diff < minDiff) { minDiff = diff; best = opt; } }
  return best;
}

function getNearestExpiry(chain: any[]) {
  const counts: Record<string, number> = {};
  for (const opt of chain) counts[opt.expiry] = (counts[opt.expiry] || 0) + 1;
  let best = ''; let max = 0;
  for (const [exp, count] of Object.entries(counts)) if (count > max) { max = count; best = exp; }
  return best;
}

async function getTA(symbols: string[], timeframe: string = 'swing') {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/get-technical-analysis`, {
    method: 'POST', headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ symbols, timeframe })
  });
  return res.json();
}

async function getPrices(symbols: string[]) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/get-nse-data`, {
    method: 'POST', headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ symbols })
  });
  return res.json();
}

async function getMovers() {
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/get-nse-movers`, {
      method: 'POST', headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' }
    });
    return res.json();
  } catch { return { data: {} }; }
}

function parseTA(taData: any, priceData: any[], symMap: Record<string, any>) {
  return (taData.data || []).map((ta: any) => {
    const megaInfo = symMap[ta.symbol] || null;
    const price = priceData.find((p: any) => p.symbol === ta.symbol);
    return {
      symbol: ta.symbol, megaSymbol: megaInfo?.megaSymbol || null,
      instrumentToken: megaInfo?.instrumentToken || null, available: !!megaInfo,
      price: ta.price, changePercent: ta.changePercent, signal: ta.signal,
      buyScore: ta.buyScore, sellScore: ta.sellScore, rsi: ta.rsi, trend: ta.trend,
      ema9: ta.emas?.ema9, ema21: ta.emas?.ema21, ema50: ta.emas?.ema50, ema100: ta.emas?.ema100,
      entry: ta.entry, sl: ta.sl, tp1: ta.tp1, tp2: ta.tp2, tp3: ta.tp3,
      trailingStop: ta.trailingStop, positionSize: ta.positionSize,
      activePosition: ta.activePosition, trendStrength: ta.trendStrength,
      volumeCondition: ta.volumeCondition, volumeSurge: ta.volumeSurge,
      candlePattern: ta.candlePattern, chartPattern: ta.chartPattern,
      chartPatternType: ta.chartPatternType, srLevel: ta.srLevel, srDetail: ta.srDetail,
      support: ta.support, resistance: ta.resistance, vwap: ta.vwap, atr: ta.atr,
      volumeRatio: ta.volumeRatio, currentPrice: price?.price,
      dayHigh: price?.dayHigh, dayLow: price?.dayLow, volume: price?.volume
    };
  });
}

function addGreeksToOption(opt: any, indexLevel: number, expiry: string, vix: number) {
  if (!opt) return null;
  const daysToExpiry = parseExpiryToDays(expiry);
  const T = daysToExpiry / 365;
  const r = 0.07; // 7% risk-free rate for India
  const sigma = (vix || 15) / 100; // Use VIX as volatility proxy
  const greeks = calculateGreeks(indexLevel, opt.strike, T, r, sigma, opt.type || 'CE');
  return { ...opt, greeks, daysToExpiry };
}

function parseOptionSignals(taData: any, priceData: any[], chain: any[], vixValue: number) {
  const indexMap: Record<string, { underlying: string; stepSize: number }> = {
    '^NSEI': { underlying: 'NIFTY', stepSize: 50 },
    '^NSEBANK': { underlying: 'BANKNIFTY', stepSize: 100 },
  };
  const results: any[] = [];
  for (const ta of (taData.data || [])) {
    const idxInfo = indexMap[ta.symbol]; if (!idxInfo) continue;
    const price = priceData.find((p: any) => p.symbol === ta.symbol);
    const indexLevel = price?.price || ta.price || 0; if (!indexLevel) continue;
    const underlying = idxInfo.underlying; const stepSize = idxInfo.stepSize;
    const allOpts = chain[underlying] || [];
    const expiry = getNearestExpiry(allOpts);
    const expiryOpts = allOpts.filter(o => o.expiry === expiry);
    const isBullish = ta.signal === 'BUY' || ta.buyScore >= 65;
    const isBearish = ta.signal === 'SELL' || ta.sellScore >= 65;
    if (!isBullish && !isBearish) {
      results.push({ index: ta.symbol, underlying, indexLevel, signal: ta.signal,
        buyScore: ta.buyScore, sellScore: ta.sellScore, rsi: ta.rsi, trend: ta.trend,
        recommendation: 'HOLD', reason: 'No strong signal', expiry });
      continue;
    }
    const optType = isBullish ? 'CE' : 'PE';
    const atmOpt = findATMOption(expiryOpts, indexLevel, optType, stepSize);
    if (!atmOpt) continue;
    const otmStrike = isBullish ? atmOpt.strike + stepSize : atmOpt.strike - stepSize;
    const otmOpt = expiryOpts.find(o => o.strike === otmStrike && o.type === optType);
    const itmStrike = isBullish ? atmOpt.strike - stepSize : atmOpt.strike + stepSize;
    const itmOpt = expiryOpts.find(o => o.strike === itmStrike && o.type === optType);

    // Add Greeks to each option
    const atmWithGreeks = addGreeksToOption(
      { symbol: atmOpt.symbol, token: atmOpt.token, strike: atmOpt.strike, type: optType },
      indexLevel, expiry, vixValue
    );
    const otmWithGreeks = otmOpt ? addGreeksToOption(
      { symbol: otmOpt.symbol, token: otmOpt.token, strike: otmOpt.strike, type: optType },
      indexLevel, expiry, vixValue
    ) : null;
    const itmWithGreeks = itmOpt ? addGreeksToOption(
      { symbol: itmOpt.symbol, token: itmOpt.token, strike: itmOpt.strike, type: optType },
      indexLevel, expiry, vixValue
    ) : null;

    results.push({
      index: ta.symbol, underlying, indexLevel, signal: ta.signal,
      buyScore: ta.buyScore, sellScore: ta.sellScore, rsi: ta.rsi, trend: ta.trend,
      trendStrength: ta.trendStrength, chartPattern: ta.chartPattern,
      chartPatternType: ta.chartPatternType, srLevel: ta.srLevel, srDetail: ta.srDetail,
      support: ta.support, resistance: ta.resistance,
      recommendation: `BUY ${optType}`, optionType: optType, expiry,
      atm: atmWithGreeks, otm: otmWithGreeks, itm: itmWithGreeks,
      greeksSummary: atmWithGreeks?.greeks ? {
        delta: atmWithGreeks.greeks.delta,
        theta: atmWithGreeks.greeks.theta,
        gamma: atmWithGreeks.greeks.gamma,
        vega: atmWithGreeks.greeks.vega,
        theoreticalPremium: atmWithGreeks.greeks.theoreticalPremium,
        moneyness: atmWithGreeks.greeks.moneyness,
        daysToExpiry: atmWithGreeks.daysToExpiry,
      } : null,
      indexLevels: { entry: ta.entry || indexLevel, sl: ta.sl, tp1: ta.tp1, tp2: ta.tp2, tp3: ta.tp3 },
      reason: isBullish
        ? `Bullish (buyScore: ${ta.buyScore}) on ${ta.symbol}. Trend: ${ta.trend}. Buy CE ATM ${atmOpt.strike}. Delta: ${atmWithGreeks?.greeks?.delta || 'N/A'}, Theta: ${atmWithGreeks?.greeks?.theta || 'N/A'}.`
        : `Bearish (sellScore: ${ta.sellScore}) on ${ta.symbol}. Trend: ${ta.trend}. Buy PE ATM ${atmOpt.strike}. Delta: ${atmWithGreeks?.greeks?.delta || 'N/A'}, Theta: ${atmWithGreeks?.greeks?.theta || 'N/A'}.`
    });
  }
  return results;
}

async function placeTrade(tradingSymbol: string, instrumentToken: string, qty: number, type: string, duration: string, orderType: string, price?: number, triggerPrice?: number) {
  const body: any = { tradingSymbol, instrumentToken, qty, type, duration, orderType, price: price || 0 };
  if (triggerPrice) body.triggerPrice = triggerPrice;
  return megaFetch('/api/order/buysell', 'POST', body);
}

// Shared MegaBull client: api-key + auto-healing Bearer JWT.
// Data endpoints now require Authorization: Bearer <jwt>; if the stored JWT is
// expired/missing we sign in, persist the fresh JWT to ai_agent_config, and retry once.
const MEGA_API = 'https://api.megabull.in';
const MEGA_KEY = '5bd189e7-ef64-4571-82d1-d4c7eac7aa8f';
const MEGA_EMAIL = 'shubhampawar9090@gmail.com';
const MEGA_PASSWORD = 'NeonNSE@2026';
const _SB = Deno.env.get("SUPABASE_URL") || "";
const _SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
function _sbh() { return { apikey: _SRK, Authorization: `Bearer ${_SRK}`, "Content-Type": "application/json" }; }
let _jwtCache: { jwt: string; ts: number } | null = null;

async function _storedJwt(): Promise<string> {
  if (_jwtCache && Date.now() - _jwtCache.ts < 60000) return _jwtCache.jwt;
  try {
    const res = await fetch(`${_SB}/rest/v1/ai_agent_config?select=mega_bull_jwt&limit=1`, { headers: _sbh() });
    const cfg = (await res.json() || [])[0];
    _jwtCache = { jwt: cfg?.mega_bull_jwt || "", ts: Date.now() };
    return _jwtCache.jwt;
  } catch { return ""; }
}

async function _megaLogin(): Promise<string> {
  const res = await fetch(`${MEGA_API}/api/auth/signin`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'api-key': MEGA_KEY },
    body: JSON.stringify({ emailId: MEGA_EMAIL, password: MEGA_PASSWORD }),
  });
  const data = await res.json();
  if (!data.token) throw new Error('MegaBull login failed: ' + JSON.stringify(data).slice(0, 150));
  try {
    const cfgRes = await fetch(`${_SB}/rest/v1/ai_agent_config?select=id&limit=1`, { headers: _sbh() });
    const cfg = (await cfgRes.json() || [])[0];
    if (cfg?.id) {
      await fetch(`${_SB}/rest/v1/ai_agent_config?id=eq.${cfg.id}`, {
        method: 'PATCH', headers: _sbh(),
        body: JSON.stringify({
          mega_bull_jwt: data.token,
          mega_bull_refresh_token: data.refreshToken || null,
          mega_bull_token_expiry: data.expiryTimeStamp || null,
          updated_at: new Date().toISOString(),
        }),
      });
    }
  } catch (e) { console.error('jwt store failed:', String(e)); }
  _jwtCache = { jwt: data.token, ts: Date.now() };
  return data.token;
}

async function megaFetch(path: string, method: string = 'GET', body?: any) {
  let jwt = await _storedJwt();
  const doFetch = (t: string) => fetch(`${MEGA_API}${path}`, {
    method,
    headers: { 'api-key': MEGA_KEY, 'Authorization': `Bearer ${t}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let res = await doFetch(jwt);
  if (res.status === 401 || res.status === 403) {
    const txt = await res.text();
    try {
      const j = JSON.parse(txt);
      if (j.error === 'AuthenticationException' || j.status === 'UNAUTHORIZED' || /api key/i.test(j.message?.join?.('') || j.message || '')) {
        jwt = await _megaLogin();
        res = await doFetch(jwt);
      }
    } catch { /* non-json 401 — retry with fresh login anyway */ 
      jwt = await _megaLogin();
      res = await doFetch(jwt);
    }
  }
  return res.json();
}


Deno.serve(async (req) => {
  const CORS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (!authorized(req)) return new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), { status: 401, headers: CORS });
  try {
    const body = await req.json();
    const { action, params } = body;
    let result: any;
    switch (action) {
      case 'full_scan': {
        const stockSymbols = params?.stocks || ['RELIANCE','INFY','HDFCBANK','TCS','SBIN','ICICIBANK','TATAPOWER','WIPRO','AXISBANK','LT','ITC','BHARTIARTL','MARUTI','HCLTECH','SUNPHARMA','KOTAKBANK','BAJFINANCE','ASIANPAINT','TITAN','TATASTEEL'];
        const indexSymbols = ['^NSEI', '^NSEBANK'];
        const sectorSymbols = ['^INDIAVIX','^CNXIT','^CNXAUTO','^CNXFMCG','^CNXMETAL','^CNXENERGY','^CNXPHARMA','^CNXMEDIA','^CNXREALTY','^CNXPSUBANK','NIFTY FIN SERVICE'];
        const allPriceSymbols = [...indexSymbols, ...stockSymbols, ...sectorSymbols];
        const symMap = await getSymbolMap();
        const chain = await getOptionChain();
        const [taIndexSwing, taIndexScalp, taStocksSwing, taStocksScalp, priceData, moversData, positions, profile] = await Promise.all([
          getTA(indexSymbols, 'swing'), getTA(indexSymbols, 'scalp'),
          getTA(stockSymbols, 'swing'), getTA(stockSymbols, 'scalp'),
          getPrices(allPriceSymbols), getMovers(),
          megaFetch('/api/position/my'), megaFetch('/api/user/my'),
        ]);
        const indexSwing = parseTA(taIndexSwing, priceData.data || [], {});
        const indexScalp = parseTA(taIndexScalp, priceData.data || [], {});
        const stockSwing = parseTA(taStocksSwing, priceData.data || [], symMap);
        const stockScalp = parseTA(taStocksScalp, priceData.data || [], symMap);
        const vix = (priceData.data || []).find((p: any) => p.symbol === '^INDIAVIX' && !p.error);
        const vixValue = vix?.price || 15;
        const optionSignals = parseOptionSignals(taIndexSwing, priceData.data || [], chain, vixValue);
        const sectors = (priceData.data || []).filter((p: any) => sectorSymbols.includes(p.symbol) && !p.error)
          .map((p: any) => ({ symbol: p.symbol, price: p.price, change: p.change, changePercent: p.changePercent }));
        const movers = moversData.data || {};
        const gainers = (movers.gainers || []).slice(0, 10);
        const losers = (movers.losers || []).slice(0, 10);
        const buySignals = stockSwing.filter((s: any) => s.signal === 'BUY' && s.buyScore >= 65);
        const sellSignals = stockSwing.filter((s: any) => s.signal === 'SELL' && s.sellScore >= 65);
        const neutralCount = stockSwing.length - buySignals.length - sellSignals.length;
        const breadth = {
          total: stockSwing.length, bullish: buySignals.length, bearish: sellSignals.length, neutral: neutralCount,
          sentiment: buySignals.length > sellSignals.length ? 'BULLISH' : sellSignals.length > buySignals.length ? 'BEARISH' : 'NEUTRAL',
          buyRatio: stockSwing.length > 0 ? (buySignals.length / stockSwing.length * 100).toFixed(1) : '0',
          sellRatio: stockSwing.length > 0 ? (sellSignals.length / stockSwing.length * 100).toFixed(1) : '0',
        };
        const trendConfirmation = indexSwing.map((s: any) => {
          const scalp = indexScalp.find((sc: any) => sc.symbol === s.symbol);
          const aligned = s.trend === scalp?.trend;
          return { symbol: s.symbol, swingTrend: s.trend, scalpTrend: scalp?.trend,
            swingSignal: s.signal, scalpSignal: scalp?.signal,
            swingBuyScore: s.buyScore, scalpBuyScore: scalp?.buyScore,
            swingSellScore: s.sellScore, scalpSellScore: scalp?.sellScore,
            aligned, confirmation: aligned ? (s.trend === 'Up' ? 'STRONG_BULLISH' : s.trend === 'Down' ? 'STRONG_BEARISH' : 'RANGEBOUND') : 'MIXED' };
        });
        result = {
          success: true,
          marketStructure: {
            vix: vix ? { value: vix.price, change: vix.change, changePercent: vix.changePercent } : null,
            sentiment: breadth.sentiment, breadth, sectors, trendConfirmation,
            gainers: gainers.slice(0, 5).map((g: any) => ({ symbol: g.symbol, changePercent: g.changePercent, price: g.price })),
            losers: losers.slice(0, 5).map((l: any) => ({ symbol: l.symbol, changePercent: l.changePercent, price: l.price })),
            summary: `${breadth.sentiment} | Breadth: ${breadth.bullish}B/${breadth.bearish}S/${breadth.neutral}N | VIX: ${vix?.price || 'N/A'}`,
          },
          optionSignals,
          stockSignals: { swing: stockSwing, scalp: stockScalp,
            topBuys: buySignals.sort((a: any, b: any) => b.buyScore - a.buyScore).slice(0, 5),
            topSells: sellSignals.sort((a: any, b: any) => b.sellScore - a.sellScore).slice(0, 5) },
          indexAnalysis: { swing: indexSwing, scalp: indexScalp },
          positions: positions || [],
          capital: { total: profile?.virtualMoney, blocked: profile?.virtualMoneyBlocked, available: profile?.virtualMoneyLeft },
        };
        break;
      }
      case 'analyze': {
        const symbols = params?.symbols || ['RELIANCE','INFY','HDFCBANK','TCS','SBIN'];
        const timeframe = params?.timeframe || 'swing';
        const [taData, priceData, positions, profile] = await Promise.all([
          getTA(symbols, timeframe), getPrices(symbols), megaFetch('/api/position/my'), megaFetch('/api/user/my')]);
        const symMap = await getSymbolMap();
        result = { success: true, signals: parseTA(taData, priceData.data || [], symMap), positions: positions || [],
          capital: { total: profile?.virtualMoney, blocked: profile?.virtualMoneyBlocked, available: profile?.virtualMoneyLeft } };
        break;
      }
      case 'analyze_options': {
        const indices = params?.indices || ['^NSEI', '^NSEBANK'];
        const timeframe = params?.timeframe || 'swing';
        const [taData, priceData, positions, profile] = await Promise.all([
          getTA(indices, timeframe), getPrices([...indices, '^INDIAVIX']), megaFetch('/api/position/my'), megaFetch('/api/user/my')]);
        const chain = await getOptionChain();
        const vix = (priceData.data || []).find((p: any) => p.symbol === '^INDIAVIX' && !p.error);
        result = { success: true, optionSignals: parseOptionSignals(taData, priceData.data || [], chain, vix?.price || 15), positions: positions || [],
          capital: { total: profile?.virtualMoney, blocked: profile?.virtualMoneyBlocked, available: profile?.virtualMoneyLeft } };
        break;
      }
      case 'execute': {
        const trades = params?.trades || [];
        const symMap = await getSymbolMap();
        const results: any[] = [];
        for (const trade of trades) {
          try {
            let megaSym = trade.tradingSymbol; let token = trade.instrumentToken;
            if (!token && trade.nseSymbol) {
              const resolved = symMap[trade.nseSymbol];
              if (!resolved) { results.push({ symbol: trade.nseSymbol, status: 'REJECTED', error: 'Symbol not found' }); continue; }
              megaSym = resolved.megaSymbol; token = resolved.instrumentToken;
            }
            const r = await placeTrade(megaSym, token, trade.qty, trade.type, trade.duration || 'MIS', trade.orderType || 'MKT', trade.price, trade.triggerPrice);
            results.push({ symbol: trade.nseSymbol || megaSym, megaSymbol: megaSym, type: trade.type, qty: trade.qty, status: r.status, orderId: r.id, price: r.price, msg: r.msg, error: r.error });
          } catch (e: any) { results.push({ symbol: trade.nseSymbol || trade.tradingSymbol, type: trade.type, qty: trade.qty, status: 'ERROR', error: e.message }); }
        }
        result = { success: true, results };
        break;
      }
      case 'resolve': { const symMap = await getSymbolMap(); result = { success: true, nseSymbol: params?.symbol, megaInfo: symMap[params?.symbol] || null }; break; }
      case 'positions': result = { success: true, data: await megaFetch('/api/position/my') }; break;
      case 'orders': result = { success: true, data: await megaFetch('/api/order/my') }; break;
      case 'holdings': result = { success: true, data: await megaFetch('/api/holding/my') }; break;
      case 'profile': result = { success: true, data: await megaFetch('/api/user/my') }; break;
      case 'cancel': result = { success: true, data: await megaFetch('/api/order/bulk/cancel', 'PUT', { orderIds: params?.orderIds || [] }) }; break;
      case 'report': { const today = new Date().toISOString().split('T')[0]; result = { success: true, data: await megaFetch(`/api/report/virtual/${params?.start || today}/${params?.end || today}`) }; break; }
      default: result = { success: false, error: `Unknown action: ${action}` };
    }
    return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
  } catch (error: any) {
    return new Response(JSON.stringify({ success: false, error: error.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
});