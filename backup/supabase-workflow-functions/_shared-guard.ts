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
