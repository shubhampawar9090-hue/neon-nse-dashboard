export default async function triggerTvTicks(req: Request): Promise<Response> {
  const SB_URL = "https://vpjbjzrcbxgdrfjbyfiu.supabase.co";
  const SB_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZwamJqenJjYnhnZHJmamJ5Zml1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ0Mzk2MzUsImV4cCI6MjEwMDAxNTYzNX0.8p5JYClZwNoTctvMO0xeLohO-Kg9UqNrGK5UBK8hDSY";
  
  try {
    const resp = await fetch(`${SB_URL}/functions/v1/save-tv-ticks`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${SB_ANON}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });
    
    const data = await resp.json();
    
    return new Response(JSON.stringify({
      success: data.success || false,
      ticks_saved: data.ticks_saved || 0,
      ticks_fetched: data.ticks_fetched || 0,
      total_symbols: data.total_symbols || 0,
      time_s: data.total_time_s || 0,
      timestamp: data.timestamp || new Date().toISOString(),
    }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(JSON.stringify({
      success: false,
      error: error.message,
    }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
