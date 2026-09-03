// daily-pnl-report — Supabase port of Base44 "Daily P&L Report" workflow
// Same 3 data steps (positions, profile, report) + composed report → reports table + optional agent broadcast.
import { authorized } from "../_shared-guard.ts";

const SB = Deno.env.get("SUPABASE_URL") || "";
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
function sb() { return { apikey: SRK, Authorization: `Bearer ${SRK}`, "Content-Type": "application/json" }; }
const CORS = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

function notifyAgent(content: string) {
  const p = fetch(`https://app.base44.com/api/agents/6a5b3772e2193d1b5140a8e3/conversations/${Deno.env.get("AGENT_CONVERSATION_ID")}/messages`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${Deno.env.get("BASE44_SERVICE_TOKEN")}`, "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  }).catch((e) => console.error("agent notify failed:", String(e)));
  EdgeRuntime.waitUntil(p);
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
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (!authorized(req)) return new Response(JSON.stringify({ success: false, error: "Unauthorized" }), { status: 401, headers: CORS });
  try {
    const { dow } = (() => { const d = new Date(Date.now() + 5.5 * 3600 * 1000); return { dow: d.getUTCDay() }; })();
    if (dow === 0 || dow === 6) return new Response(JSON.stringify({ success: true, skipped: "weekend" }), { headers: CORS });

    // Same data steps as the workflow
    const today = new Date().toISOString().split("T")[0];
    const [positions, profile, report] = await Promise.all([
      megaFetch("/api/position/my"),
      megaFetch("/api/user/my"),
      megaFetch(`/api/report/virtual/${today}/${today}`),
    ]);

    const pos: any[] = Array.isArray(positions) ? positions : (positions?.data || []);
    const capital = {
      total: profile?.virtualMoney || 0,
      blocked: profile?.virtualMoneyBlocked || 0,
      available: profile?.virtualMoneyLeft || 0,
    };
    const openPnL = pos.reduce((s: number, p: any) => s + (p.pl || 0), 0);

    // Today's executed orders from the report
    const tradesToday: any[] = [];
    if (Array.isArray(report)) tradesToday.push(...report);
    else if (report?.executed) tradesToday.push(...report.executed);
    else if (report?.data) tradesToday.push(...(Array.isArray(report.data) ? report.data : []));

    const lines: string[] = [];
    lines.push("DAILY P&L REPORT — " + new Date().toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", weekday: "short", day: "numeric", month: "short", year: "numeric" }));
    lines.push("");
    lines.push("1) TODAY'S TRADES: " + tradesToday.length + " executed.");
    for (const t of tradesToday.slice(0, 15)) {
      lines.push(`• ${t.tradingSymbol || t.instrumentName || t.symbol || "?"} ${t.type || ""} qty ${t.qty ?? "?"} @ ${t.price ?? "?"}`);
    }
    lines.push("");
    lines.push("2) OPEN POSITIONS");
    if (pos.length === 0) lines.push("• None.");
    for (const p of pos) {
      lines.push(`• ${p.instrumentName || p.symbol}: qty ${p.qty} avg ${p.priceAvg || p.avgBuyPrice || 0} | P&L ₹${p.pl || 0}`);
    }
    lines.push("");
    lines.push("3) CAPITAL");
    lines.push(`• Total ₹${capital.total} | blocked ₹${capital.blocked} | available ₹${capital.available}`);
    lines.push("");
    lines.push("4) TOTAL P&L: ₹" + Math.round((openPnL + Number(report?.totalPnL ?? 0)) * 100) / 100);
    lines.push("");
    lines.push("5) TOMORROW: watch opening trend, momentum and fresh TA signals before taking positions.");
    const text = lines.join("\n");

    const ins = await fetch(`${SB}/rest/v1/reports`, {
      method: "POST", headers: { ...sb(), Prefer: "return=representation" },
      body: JSON.stringify({ report_type: "daily_pnl", title: "Daily P&L " + today, content: text, data: { positions: pos, capital, report } }),
    });
    const reportRow = (await ins.json() || [])[0];

    const cfgRes = await fetch(`${SB}/rest/v1/ai_agent_config?select=notify_via_agent&limit=1`, { headers: sb() });
    const notifyFlag = ((await cfgRes.json() || [])[0]?.notify_via_agent) ?? true;
    if (notifyFlag) {
      notifyAgent(
        `The market just closed. A daily P&L report was generated by Supabase. Broadcast it to the owner (concise, phone-friendly, bullet points, same sections). Add key TA signal notes from today's analysis if available. Do not perform any other actions.\n\n${text}`
      );
    }

    return new Response(JSON.stringify({ success: true, report_id: reportRow?.id, trades_today: tradesToday.length, open_positions: pos.length, notify_via_agent: notifyFlag }), { headers: CORS });
  } catch (err: any) {
    return new Response(JSON.stringify({ success: false, error: String(err) }), { status: 500, headers: CORS });
  }
});
