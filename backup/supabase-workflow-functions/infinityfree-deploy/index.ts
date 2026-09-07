export function authorized(req: Request): boolean {
  const auth = req.headers.get("Authorization") || "";
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (service && auth === `Bearer ${service}`) return true;
  const cronKey = req.headers.get("x-cron-key") || "";
  const secret = Deno.env.get("CRON_SECRET") || "";
  return !!(cronKey && secret && cronKey === secret);
}

function json(data: any, status = 200) { return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } }); }

async function deployHandler(req: Request): Promise<Response> {
  try {
    const body = await req.json().catch(() => ({}));
    const { content, password, path = '/htdocs/index.html' } = body;
    
    if (!content) {
      return json({ error: 'No file content provided' }, 400);
    }

    const ftpHost = 'ftpupload.net';
    const ftpUser = 'if0_42507297';
    const ftpPass = password || Deno.env.get('INFINITYFREE_FTP_PASSWORD') || '';
    
    // Try using Deno's connect for raw FTP
    const conn = await Deno.connect({ hostname: ftpHost, port: 21 });
    
    // Read welcome message
    const welcome = await readFtpResponse(conn);
    
    // Send USER
    await sendFtpCommand(conn, `USER ${ftpUser}`);
    const userResp = await readFtpResponse(conn);
    
    // Send PASS
    await sendFtpCommand(conn, `PASS ${ftpPass}`);
    const passResp = await readFtpResponse(conn);
    
    if (!passResp.startsWith('2')) {
      conn.close();
      return json({ error: `FTP login failed: ${passResp}`, userResp, welcome }, 401);
    }
    
    // Set to passive mode
    await sendFtpCommand(conn, 'TYPE I');
    await readFtpResponse(conn);
    
    await sendFtpCommand(conn, 'PASV');
    const pasvResp = await readFtpResponse(conn);
    
    // Parse passive mode address
    const pasvMatch = pasvResp.match(/\((\d+),(\d+),(\d+),(\d+),(\d+),(\d+)\)/);
    if (!pasvMatch) {
      conn.close();
      return json({ error: `PASV failed: ${pasvResp}` }, 500);
    }
    
    const dataHost = `${pasvMatch[1]}.${pasvMatch[2]}.${pasvMatch[3]}.${pasvMatch[4]}`;
    const dataPort = parseInt(pasvMatch[5]) * 256 + parseInt(pasvMatch[6]);
    
    // Connect to data port
    const dataConn = await Deno.connect({ hostname: dataHost, port: dataPort });
    
    // Send STOR command
    await sendFtpCommand(conn, `STOR ${path}`);
    const storResp = await readFtpResponse(conn);
    
    if (!storResp.startsWith('1')) {
      conn.close();
      dataConn.close();
      return json({ error: `STOR failed: ${storResp}` }, 500);
    }
    
    // Write file content — LOOP: Deno.Conn.write may accept only part of the
    // buffer (OS socket send buffer fills around ~50KB). Without a loop the
    // tail was silently dropped and InfinityFree served a truncated page.
    const bytes = new TextEncoder().encode(content);
    let off = 0;
    while (off < bytes.length) {
      const n = await dataConn.write(bytes.subarray(off));
      if (n == null || n <= 0) throw new Error(`FTP data write stalled at byte ${off} of ${bytes.length}`);
      off += n;
    }
    dataConn.close();
    
    // Read transfer complete response
    const completeResp = await readFtpResponse(conn);
    
    // Quit
    await sendFtpCommand(conn, 'QUIT');
    await readFtpResponse(conn);
    conn.close();
    
    return json({ 
      success: true, 
      message: 'File uploaded successfully',
      path,
      size: bytes.length,
      bytesWritten: off,
      response: completeResp
    });
    
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
}

async function sendFtpCommand(conn: Deno.Conn, cmd: string) {
  const encoder = new TextEncoder();
  await conn.write(encoder.encode(cmd + '\r\n'));
}

async function readFtpResponse(conn: Deno.Conn, timeoutMs = 8000): Promise<string> {
  // Single blocking read with timeout (multiline responses arrive in one TCP
  // segment for InfinityFree's Pure-FTPd; verified working 2026-09-03).
  const buf = new Uint8Array(4096);
  const readPromise = conn.read(buf);
  const timer = setTimeout(() => {}, 0);
  const timeoutPromise = new Promise<number>((res) => { setTimeout(() => res(-1), timeoutMs); });
  clearTimeout(timer);
  const n = await Promise.race([readPromise, timeoutPromise]);
  if (n === -1 || n === null) return '';
  return new TextDecoder().decode(buf.subarray(0, n)).trim();
}


Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: { 'Access-Control-Allow-Origin': '*' } });
  if (!authorized(req)) return json({ success: false, error: 'Unauthorized' }, 401);
  return deployHandler(req);
});
