// pre-market-briefing — Supabase port of Base44 "Pre-Market Briefing v3" workflow
// Runs megabull-agent full_scan (same data step), composes the briefing, saves to reports,
// then optionally pings the Base44 agent to add FII/DII web context and broadcast (notification only).
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

function istNow() {
  const now = new Date(Date.now() + 5.5 * 3600 * 1000);
  return { h: now.getUTCHours(), m: now.getUTCMinutes(), dow: now.getUTCDay() };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (!authorized(req)) return new Response(JSON.stringify({ success: false, error: "Unauthorized" }), { status: 401, headers: CORS });
  try {
    // Gate: weekdays only (original cron 1-5). Caller decides the time (cron fires 09:10 IST).
    const { dow } = istNow();
    if (dow === 0 || dow === 6) {
      return new Response(JSON.stringify({ success: true, skipped: "weekend" }), { headers: CORS });
    }

    // STEP 1 — same data step as the workflow: megabullAgent full_scan
    const scanRes = await fetch(`${SB}/functions/v1/megabull-agent`, {
      method: "POST", headers: sb(),
      body: JSON.stringify({ action: "full_scan" }),
    });
    const scan = await scanRes.json();
    if (!scan?.success) throw new Error("full_scan failed: " + JSON.stringify(scan).slice(0, 200));

    const ms = scan.marketStructure || {};
    const vix = ms.vix || {};
    const breadth = ms.breadth || {};
    const sectors = ms.sectors || [];
    const trend = ms.trendConfirmation || [];
    const optionSignals = (scan.optionSignals || []).slice(0, 5);
    const topBuys = (scan.stockSignals?.topBuys || []).slice(0, 5);
    const topSells = (scan.stockSignals?.topSells || []).slice(0, 5);
    const cap = scan.capital || {};

    // STEP 2 — compose the briefing (same sections as the original agent prompt)
    const lines: string[] = [];
    lines.push("NEON PRE-MARKET BRIEFING");
    lines.push(new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) + " IST");
    lines.push("");
    lines.push("1) INDEX + VIX");
    for (const t of trend) {
      lines.push(`• ${t.symbol}: ${t.swingTrend} (swing) / ${t.scalpTrend} (scalp) | confirmation: ${t.confirmation}`);
    }
    lines.push(`• India VIX: ${vix.value ?? "N/A"} (${vix.changePercent >= 0 ? "+" : ""}${vix.changePercent ?? "?"}%)`);
    lines.push("");
    lines.push("2) SENTIMENT");
    lines.push(`• Breadth: ${breadth.bullish} bullish / ${breadth.bearish} bearish (${breadth.buyRatio}% buy, ${breadth.sellRatio}% sell) → ${breadth.sentiment}`);
    lines.push("");
    lines.push("3) SECTOR OUTLOOK");
    for (const s of sectors.slice(0, 11)) {
      lines.push(`• ${s.symbol}: ${s.price} (${s.changePercent >= 0 ? "+" : ""}${s.changePercent}%)`);
    }
    lines.push("");
    lines.push("4) OPTION SIGNALS (with Greeks)");
    if (optionSignals.length === 0) lines.push("• No valid option signals");
    for (const o of optionSignals) {
      lines.push(`• ${o.symbol || o.tradingSymbol || "SIGNAL"} ${o.type || ""} | strike ${o.strike ?? "?"} | exp ${o.expiry ?? "?"} | delta ${o.delta ?? "?"} | theta ${o.theta ?? "?"} | est premium ${o.theoreticalPremium ?? o.premium ?? "?"} | signal ${o.signal ?? ""}`);
    }
    lines.push("");
    lines.push("5) STOCK TRADE PLAN (confirm live levels before entry)");
    for (const b of topBuys) lines.push(`• ${b.symbol} BUY: entry ${b.price} | buy score ${b.buyScore}${b.sl ? ` | SL ${b.sl}` : ""}${b.tp ? ` | TPs ${Array.isArray(b.tp) ? b.tp.join("/") : b.tp}` : ""}`);
    for (const s of topSells) lines.push(`• ${s.symbol} SELL: entry ${s.price} | sell score ${s.sellScore}${s.sl ? ` | SL ${s.sl}` : ""}`);
    lines.push("");
    lines.push("6) CAPITAL");
    lines.push(`• Total ₹${cap.total ?? "?"} | blocked ₹${cap.blocked ?? "?"} | available ₹${cap.available ?? "?"}`);
    lines.push("");
    lines.push("RISK NOTES");
    lines.push(`• VIX ${vix.value ?? "?"} — size positions accordingly; avoid averaging losers; trail quickly near support.`);
    lines.push(`• Top gainers: ${(ms.gainers || []).map((g: any) => `${g.symbol} ${g.changePercent}%`).join(", ") || "N/A"}`);
    lines.push(`• Top losers: ${(ms.losers || []).map((l: any) => `${l.symbol} ${l.changePercent}%`).join(", ") || "N/A"}`);
    const report = lines.join("\n");

    // STEP 3 — persist to reports table (dashboard-visible)
    const ins = await fetch(`${SB}/rest/v1/reports`, {
      method: "POST", headers: { ...sb(), Prefer: "return=representation" },
      body: JSON.stringify({ report_type: "pre_market", title: "Pre-Market Briefing " + new Date().toISOString().slice(0, 10), content: report, data: scan }),
    });
    const reportRow = (await ins.json() || [])[0];

    // STEP 4 — optional agent notification: adds FII/DII web context + broadcasts (same delivery as before)
    const cfgRes = await fetch(`${SB}/rest/v1/ai_agent_config?select=notify_via_agent&limit=1`, { headers: sb() });
    const notifyFlag = ((await cfgRes.json() || [])[0]?.notify_via_agent) ?? true;
    if (notifyFlag) {
      notifyAgent(
        `You are the Neon AI Trading Agent. Pre-market briefing data is ready (generated by Supabase).\n\n` +
        `Do two quick web searches: "NIFTY today market news" and "FII DII data today India".\n\n` +
        `Then broadcast a concise pre-market briefing to the owner using this data (add the FII/DII section and key news; keep the same section structure, phone-friendly):\n\n${report}\n\n` +
        `This is a notification task — do not place trades or modify config.`
      );
    }

    return new Response(JSON.stringify({ success: true, report_id: reportRow?.id, notify_via_agent: notifyFlag, report }), { headers: CORS });
  } catch (err: any) {
    return new Response(JSON.stringify({ success: false, error: String(err) }), { status: 500, headers: CORS });
  }
});
