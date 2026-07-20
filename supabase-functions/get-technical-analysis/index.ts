

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

// EMA calculation
function calcEMA(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const ema: number[] = [values[0]];
  for (let i = 1; i < values.length; i++) {
    ema.push(values[i] * k + ema[i - 1] * (1 - k));
  }
  return ema;
}

// RSI calculation
function calcRSI(values: number[], period: number = 14): number {
  if (values.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = values.length - period; i < values.length; i++) {
    const change = values[i] - values[i - 1];
    if (change >= 0) gains += change;
    else losses -= change;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// ATR calculation
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
          const candles = result.indicators.quote[0];
          const closes = (candles.close || []).filter((v: number) => v != null);
          const highs = (candles.high || []).filter((v: number) => v != null);
          const lows = (candles.low || []).filter((v: number) => v != null);
          const volumes = (candles.volume || []).filter((v: number) => v != null);

          if (closes.length < 5) return { symbol: sym, error: true };

          const price = closes[closes.length - 1];
          
          // EMA calculations
          const emaPeriods = timeframe === "intraday" ? [5, 13, 26] : [9, 21, 50];
          const emas: Record<string, number> = {};
          emaPeriods.forEach(p => {
            if (closes.length >= p) {
              const emaArr = calcEMA(closes, p);
              emas[`ema${p}`] = Math.round(emaArr[emaArr.length - 1] * 100) / 100;
            }
          });

          // RSI
          const rsi = Math.round(calcRSI(closes, 14) * 100) / 100;

          // ATR
          const atr = Math.round(calcATR(highs, lows, closes, 14) * 100) / 100;

          // VWAP
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

          // Support/Resistance (recent highs and lows)
          const lookback = timeframe === "intraday" ? 5 : 20;
          const recentHighs = highs.slice(-lookback);
          const recentLows = lows.slice(-lookback);
          const resistance = Math.round(Math.max(...recentHighs) * 100) / 100;
          const support = Math.round(Math.min(...recentLows) * 100) / 100;

          // Signal logic
          const emaKeys = Object.keys(emas).map(k => parseInt(k.replace("ema", "")));
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

          // SL and TP based on ATR
          const slMult = timeframe === "intraday" ? 1 : 1.5;
          const tpMult = timeframe === "intraday" ? [1.5, 2] : [2, 3];
          const sl = Math.round((price - atr * slMult) * 100) / 100;
          const tp1 = Math.round((price + atr * tpMult[0]) * 100) / 100;
          const tp2 = Math.round((price + atr * tpMult[1]) * 100) / 100;

          // EMA crossover detection
          const emaCrossover = { golden: false, death: false, cross: "none" };
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

          buyScore = Math.min(100, buyScore);
          sellScore = Math.min(100, sellScore);

          return {
            symbol: sym,
            price: Math.round(price * 100) / 100,
            emas,
            rsi,
            atr,
            vwap,
            support,
            resistance,
            signal,
            buyScore,
            sellScore,
            sl,
            tp1,
            tp2,
            emaCrossover,
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
