import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
import urllib.request

SERVICE_ROLE_KEY = os.environ.get("SERVICE_ROLE_KEY", "")
if not SERVICE_ROLE_KEY:
    with open("/tmp/service_role_key.txt") as f:
        SERVICE_ROLE_KEY = f.read().strip()

PROJECT_REF = "mmxkisgdoepojotignkg"
SUPABASE_URL = f"https://{PROJECT_REF}.supabase.co/rest/v1"
TABLES_DIR = "/tmp/supabase_backup/tables"
BATCH_SIZE = 1000
MAX_WORKERS = 20

tables_info = [
    ("nse_symbols", 2384),
    ("stock_daily_prices", 16688),
    ("stock_ticks", 1858147),
]

def fetch_batch(table, offset, limit):
    """Fetch a single batch of rows from a table."""
    url = f"{SUPABASE_URL}/{table}?select=*&order=id.asc&limit={limit}&offset={offset}"
    req = urllib.request.Request(url, headers={
        "apikey": SERVICE_ROLE_KEY,
        "Authorization": f"Bearer {SERVICE_ROLE_KEY}",
        "Accept": "application/json"
    })
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        print(f"  ERROR fetching {table} offset={offset}: {e}", flush=True)
        return []

def export_table(table, total_rows):
    """Export a full table using parallel batches."""
    num_batches = (total_rows + BATCH_SIZE - 1) // BATCH_SIZE
    print(f"\nExporting {table}: {total_rows} rows in {num_batches} batches ({MAX_WORKERS} workers)...", flush=True)
    
    results = {}
    completed = 0
    
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
        futures = {}
        for i in range(num_batches):
            offset = i * BATCH_SIZE
            future = executor.submit(fetch_batch, table, offset, BATCH_SIZE)
            futures[future] = i
        
        for future in as_completed(futures):
            batch_idx = futures[future]
            try:
                rows = future.result()
                results[batch_idx] = rows
                completed += 1
                if completed % 50 == 0 or completed == num_batches:
                    print(f"  {table}: {completed}/{num_batches} batches done ({len(rows)} rows in last batch)", flush=True)
            except Exception as e:
                print(f"  ERROR in batch {batch_idx}: {e}", flush=True)
                results[batch_idx] = []
    
    # Combine all batches in order
    all_rows = []
    for i in range(num_batches):
        if i in results:
            all_rows.extend(results[i])
    
    # Save
    output_path = f"{TABLES_DIR}/{table}.json"
    with open(output_path, "w") as f:
        json.dump(all_rows, f)
    
    file_size = os.path.getsize(output_path)
    print(f"  {table}: {len(all_rows)} rows saved, {file_size / 1024 / 1024:.1f} MB", flush=True)
    return len(all_rows)

# Export each table
start_time = time.time()
for table, total in tables_info:
    export_table(table, total)

elapsed = time.time() - start_time
print(f"\nAll tables exported in {elapsed:.1f}s")

# Show file sizes
print("\nFinal file sizes:")
for f in sorted(os.listdir(TABLES_DIR)):
    path = os.path.join(TABLES_DIR, f)
    print(f"  {f}: {os.path.getsize(path) / 1024 / 1024:.1f} MB")
