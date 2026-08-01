#!/usr/bin/env python3
"""Export all Supabase tables as JSON with efficient pagination using Range headers."""
import json
import urllib.request
import os

PROJECT_REF = "mmxkisgdoepojotignkg"
SUPABASE_URL = f"https://{PROJECT_REF}.supabase.co/rest/v1"
SERVICE_ROLE_KEY = open("supabase_backup/.service_role_key").read().strip()

TABLES = [
    "nse_symbols",
    "stock_daily_prices",
    "stock_ticks",
    "profiles",
    "watchlists",
    "saved_signals",
    "trade_journal",
    "user_alerts",
]

PAGE_SIZE = 1000

def fetch_page(table, offset):
    """Fetch a single page using Range header."""
    end = offset + PAGE_SIZE - 1
    url = f"{SUPABASE_URL}/{table}?select=*"
    headers = {
        "apikey": SERVICE_ROLE_KEY,
        "Authorization": f"Bearer {SERVICE_ROLE_KEY}",
        "Range": f"{offset}-{end}",
    }
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=120) as resp:
        data = resp.read()
        return json.loads(data)

def export_table(table):
    output_file = f"supabase_backup/tables/{table}.json"
    all_rows = []
    offset = 0
    
    while True:
        try:
            rows = fetch_page(table, offset)
        except Exception as e:
            print(f"  Error at offset {offset}: {e}")
            break
        
        if not rows:
            break
        
        all_rows.extend(rows)
        count = len(rows)
        print(f"  {table}: {count} rows at offset {offset} (total: {len(all_rows)})")
        
        if count < PAGE_SIZE:
            break
        
        offset += PAGE_SIZE
    
    with open(output_file, "w") as f:
        json.dump(all_rows, f, default=str)
    
    size_mb = os.path.getsize(output_file) / (1024 * 1024)
    print(f"  DONE {table}: {len(all_rows)} rows ({size_mb:.1f} MB)")
    return len(all_rows)

if __name__ == "__main__":
    total = 0
    for table in TABLES:
        print(f"=== {table} ===")
        count = export_table(table)
        total += count
    print(f"\nTotal: {total} rows across {len(TABLES)} tables")
