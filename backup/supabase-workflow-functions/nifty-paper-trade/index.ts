// nifty-paper-trade — read-only virtual broker state API
// Actions: state (default) | open | history
import { serve } from "https://deno.land/std@0.208.0/http/server.ts";

const SB = Deno.env.get("SUPABASE_URL")!;
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const H = { apikey: SRK, Authorization: `Bearer ${SRK}`, "Content-Type": "application/json" };

const json = (body: any, status = 200) =>
  new Response(JSON.stringify(body, null, 2), { status, headers: { "Content-Type": "application/json", ...cors() } });
const cors = () => ({ "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" });

async function get(url: string) {
  const r = await fetch(url, { headers: H });
  return await r.json();
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors() });
  let action = "state";
  try { const b = await req.json(); action = (b.action || "state").toLowerCase(); } catch (_) {}
  try {
    const [account] = await get(`${SB}/rest/v1/virtual_account?select=*&limit=1`);
    const open = await get(`${SB}/rest/v1/ai_trades?broker=eq.VIRTUAL&execution_status=eq.OPEN&select=id,symbol,qty,entry_price,price,peak_ltp,trailing_stop,sl,tp1,tp2,tp3,strategy,reason,created_date&order=created_date.desc`);
    if (action === "open") return json({ success: true, action, account, open_positions: open });
    const history = await get(`${SB}/rest/v1/ai_trades?broker=eq.VIRTUAL&execution_status=eq.CLOSED&select=id,symbol,qty,entry_price,price,pnl,reason,updated_date&order=updated_date.desc&limit=25`);
    if (action === "history") return json({ success: true, action, history });
    if (action !== "state") return json({ success: false, error: `unknown action '${action}' — use state | open | history` }, 400);

    // state: full snapshot
    const deployed = open.reduce((s: number, t: any) => s + t.entry_price * t.qty, 0);
    const unrealized = open.reduce((s: number, t: any) => s + ((t.price ?? t.entry_price) - t.entry_price) * t.qty, 0);
    const equity = Number(account?.cash ?? 0) + deployed + unrealized;
    return json({
      success: true, action: "state", as_of: new Date().toISOString(),
      account: { starting_capital: account?.starting_capital ?? 0, cash: account?.cash ?? 0, realized_pnl: account?.realized_pnl ?? 0 },
      snapshot: { open_positions: open.length, deployed: Math.round(deployed * 100) / 100, unrealized_pnl: Math.round(unrealized * 100) / 100, equity: Math.round(equity * 100) / 100 },
      positions: open, recent_closed: history.slice(0, 5),
    });
  } catch (e: any) {
    return json({ success: false, error: e?.message || String(e) }, 500);
  }
});
