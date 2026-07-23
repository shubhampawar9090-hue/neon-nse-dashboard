/**
 * Supabase to Google Drive Backup
 * 
 * Exports Supabase database tables to Google Drive as CSV files.
 * Triggered manually or via workflow.
 * 
 * Tables backed up:
 * - nse_symbols (2,384 stocks)
 * - stock_daily_prices (daily OHLC data)
 * - stock_ticks (latest snapshot only)
 * - profiles, watchlists, saved_signals, trade_journal, user_alerts
 */

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "https://vpjbjzrcbxgdrfjbyfiu.supabase.co";
const SUPABASE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const DRIVE_FOLDER_ID = "1n1LicKAMerHF72JxNUr8TCOp_AATLSjw"; // Neon-Dashboard-Backups folder

async function fetchTable(tableName, limit = 10000) {
  const url = `${SUPABASE_URL}/rest/v1/${tableName}?limit=${limit}&order=created_at.desc`;
  const res = await fetch(url, {
    headers: {
      "apikey": SUPABASE_KEY,
      "Authorization": `Bearer ${SUPABASE_KEY}`,
    },
  });
  if (!res.ok) {
    return { error: `Failed to fetch ${tableName}: ${res.status}`, data: [] };
  }
  const data = await res.json();
  return { data };
}

function toCSV(data) {
  if (!data || data.length === 0) return "";
  const keys = Object.keys(data[0]);
  const header = keys.join(",");
  const rows = data.map(row => 
    keys.map(k => {
      const val = row[k];
      if (val === null || val === undefined) return "";
      if (typeof val === "string") return `"${val.replace(/"/g, '""')}"`;
      if (typeof val === "object") return `"${JSON.stringify(val).replace(/"/g, '""')}"`;
      return String(val);
    }).join(",")
  );
  return [header, ...rows].join("\n");
}

async function uploadToDrive(filename, content, mimeType = "text/csv") {
  // Get fresh Google Drive token from Base44
  const base44 = (await import("https://esm.sh/@base44/node@latest")).createClientFromRequest?.(null);
  
  // Use the token injected as env var
  const driveToken = Deno.env.get("GOOGLEDRIVE_ACCESS_TOKEN");
  if (!driveToken) {
    return { error: "No Google Drive token available" };
  }

  const boundary = "-------supabase_backup_" + Date.now();
  const delimiter = `\r\n--${boundary}\r\n`;
  const closeDelim = `\r\n--${boundary}--`;

  const metadata = JSON.stringify({
    name: filename,
    parents: [DRIVE_FOLDER_ID],
  });

  const body = 
    delimiter + 
    "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
    metadata +
    delimiter +
    `Content-Type: ${mimeType}\r\n\r\n` +
    content +
    closeDelim;

  const res = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${driveToken}`,
      "Content-Type": `multipart/related; boundary=${boundary}`,
    },
    body,
  });

  if (!res.ok) {
    const err = await res.text();
    return { error: `Drive upload failed: ${err}` };
  }

  const result = await res.json();
  return { id: result.id, name: result.name };
}

export default async function handler(req) {
  try {
    const body = await req.json().catch(() => ({}));
    const tables = body.tables || [
      "nse_symbols",
      "stock_daily_prices", 
      "stock_ticks",
      "profiles",
      "watchlists",
      "saved_signals",
      "trade_journal",
      "user_alerts",
    ];

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const results = [];

    for (const table of tables) {
      console.log(`Backing up ${table}...`);
      
      // Fetch data from Supabase
      const { data, error } = await fetchTable(table, table === "stock_ticks" ? 1000 : 10000);
      
      if (error) {
        results.push({ table, status: "error", error });
        continue;
      }

      if (data.length === 0) {
        results.push({ table, status: "empty", rows: 0 });
        continue;
      }

      // Convert to CSV
      const csv = toCSV(data);
      
      // Upload to Google Drive
      const filename = `${table}_${timestamp}.csv`;
      const uploadResult = await uploadToDrive(filename, csv);
      
      if (uploadResult.error) {
        results.push({ table, status: "upload_error", error: uploadResult.error, rows: data.length });
      } else {
        results.push({ table, status: "success", rows: data.length, fileId: uploadResult.id, filename });
      }
    }

    return Response.json({
      success: true,
      timestamp,
      folderId: DRIVE_FOLDER_ID,
      results,
    });
  } catch (error) {
    return Response.json({ success: false, error: error.message });
  }
}
