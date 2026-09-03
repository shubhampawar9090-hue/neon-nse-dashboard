// get-option-ltp — Supabase port of Base44 getOptionLtp (identical logic; public read-only)
// Fetches live option LTP from NSE option chain for portfolio P&L calculation
// Input: { instruments: ["NIFTY 04 AUG 24300 CE", ...] }
// Output: [{ instrument, ltp, change, percentChange }]

interface InstrumentData {
  instrument: string;
  underlying: string;
  expiry: string;
  strike: number;
  optionType: string;
}

function parseInstrument(name: string): InstrumentData | null {
  // Parse "NIFTY 04 AUG 24300 CE" or "BANKNIFTY 04 AUG 24300 PE"
  const match = name.match(/^(\w+)\s+(\d{2})\s+(\w{3})\s+(\d+)\s+(CE|PE)$/i);
  if (!match) return null;
  const [, underlying, day, month, strike, optionType] = match;
  const monthMap: Record<string, string> = {
    JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06',
    JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12'
  };
  const monthNum = monthMap[month.toUpperCase()];
  if (!monthNum) return null;
  // NSE expiry format: "04-AUG-2026" (we'll determine year from current date)
  const year = new Date().getFullYear();
  const expiry = `${day}-${month.toUpperCase()}-${year}`;
  return {
    instrument: name,
    underlying: underlying.toUpperCase(),
    expiry,
    strike: parseFloat(strike),
    optionType: optionType.toUpperCase()
  };
}

async function fetchNseOptionChain(symbol: string): Promise<any> {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
  };

  try {
    // Step 1: Get cookies from NSE homepage
    const homeResp = await fetch('https://www.nseindia.com', { headers });
    const cookies = homeResp.headers.get('set-cookie') || '';
    const cookieStr = cookies.split(',').map(c => c.split(';')[0].trim()).join('; ');

    // Step 2: Fetch option chain with cookies
    const expiryDate = ''; // Empty = all expiries
    const url = `https://www.nseindia.com/api/option-chain-indices?symbol=${symbol}`;
    const chainResp = await fetch(url, {
      headers: {
        ...headers,
        'Cookie': cookieStr,
        'Referer': 'https://www.nseindia.com/',
      }
    });
    const data = await chainResp.json();
    return data;
  } catch (e) {
    console.error('NSE fetch error:', e);
    return null;
  }
}

async function fetchNseStockOptionChain(symbol: string): Promise<any> {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Connection': 'keep-alive',
  };

  try {
    const homeResp = await fetch('https://www.nseindia.com', { headers });
    const cookies = homeResp.headers.get('set-cookie') || '';
    const cookieStr = cookies.split(',').map(c => c.split(';')[0].trim()).join('; ');

    const url = `https://www.nseindia.com/api/option-chain-equities?symbol=${symbol}`;
    const chainResp = await fetch(url, {
      headers: {
        ...headers,
        'Cookie': cookieStr,
        'Referer': 'https://www.nseindia.com/',
      }
    });
    const data = await chainResp.json();
    return data;
  } catch (e) {
    console.error('NSE stock option chain error:', e);
    return null;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*" } });
  return await getOptionLtp(req);
});

async function getOptionLtp(req: Request): Promise<Response> {
  try {
    const body = await req.json();
    const instruments: string[] = body.instruments || [];

    if (instruments.length === 0) {
      return new Response(JSON.stringify({ success: false, error: 'No instruments provided' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    // Parse all instruments
    const parsed = instruments.map(parseInstrument).filter(Boolean) as InstrumentData[];

    // Group by underlying
    const byUnderlying: Record<string, InstrumentData[]> = {};
    for ( const inst of parsed) {
      if (!byUnderlying[inst.underlying]) byUnderlying[inst.underlying] = [];
      byUnderlying[inst.underlying].push(inst);
    }

    // Fetch option chains for each underlying
    const results: any[] = [];
    const indexSymbols: Record<string, string> = {
      NIFTY: 'NIFTY',
      BANKNIFTY: 'BANKNIFTY',
      FINNIFTY: 'FINNIFTY',
      SENSEX: 'SENSEX',
      BANKEX: 'BANKEX',
    };

    for (const [underlying, insts] of Object.entries(byUnderlying)) {
      let chainData: any = null;

      if (indexSymbols[underlying]) {
        chainData = await fetchNseOptionChain(indexSymbols[underlying]);
      } else {
        chainData = await fetchNseStockOptionChain(underlying);
      }

      if (!chainData || !chainData.records || !chainData.records.data) {
        // If NSE fails, return 0 LTP for these instruments
        for (const inst of insts) {
          results.push({ instrument: inst.instrument, ltp: 0, change: 0, percentChange: 0, error: 'Failed to fetch option chain' });
        }
        continue;
      }

      // Find matching LTP for each instrument
      for (const inst of insts) {
        // Find records matching the expiry and strike
        const matching = chainData.records.data.filter((r: any) => {
          const expiryMatch = r.expiry === inst.expiry;
          const strikeMatch = parseFloat(r.strikePrice) === inst.strike;
          return expiryMatch && strikeMatch;
        });

        if (matching.length > 0) {
          const record = matching[0];
          const optionData = inst.optionType === 'CE' ? record.CE : record.PE;
          if (optionData) {
            results.push({
              instrument: inst.instrument,
              ltp: optionData.lastPrice || 0,
              change: optionData.change || 0,
              percentChange: optionData.pChange || 0,
              underlyingPrice: record.underlyingValue || chainData.records.underlyingValue || 0,
            });
          } else {
            results.push({ instrument: inst.instrument, ltp: 0, change: 0, percentChange: 0, error: 'Option type not found' });
          }
        } else {
          results.push({ instrument: inst.instrument, ltp: 0, change: 0, percentChange: 0, error: 'No matching strike/expiry' });
        }
      }
    }

    return new Response(JSON.stringify({ success: true, data: results }), {
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ success: false, error: e.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }
}
