import json, os, sys, time
import urllib.request

SUPABASE_ACCESS_TOKEN = os.environ.get("SUPABASE_ACCESS_TOKEN", "")
PROJECT_REF = "mmxkisgdoepojotignkg"
SQL_URL = f"https://api.supabase.com/v1/projects/{PROJECT_REF}/database/query"
OUTPUT_PATH = "/tmp/supabase_backup/tables/stock_ticks.json"
TOTAL_ROWS = 1858147
BATCH_SIZE = 50000

NUM_BATCHES = (TOTAL_ROWS + BATCH_SIZE - 1) // BATCH_SIZE
print(f"Exporting stock_ticks: {TOTAL_ROWS} rows in {NUM_BATCHES} batches (sequential)", flush=True)

all_rows = []
start = time.time()

for i in range(NUM_BATCHES):
    offset = i * BATCH_SIZE
    query = f"SELECT id, symbol, price, change_pct, change_abs, volume, day_high, day_low, tick_time, created_at FROM public.stock_ticks ORDER BY id LIMIT {BATCH_SIZE} OFFSET {offset};"
    body = json.dumps({"query": query}).encode("utf-8")
    req = urllib.request.Request(SQL_URL, data=body, headers={
        "Authorization": f"Bearer {SUPABASE_ACCESS_TOKEN}",
        "Content-Type": "application/json"
    })
    
    retries = 0
    while retries < 3:
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                rows = json.loads(resp.read().decode("utf-8"))
                all_rows.extend(rows)
                break
        except Exception as e:
            retries += 1
            if retries < 3:
                print(f"  Batch {i} retry {retries}: {e}", flush=True)
                time.sleep(2)
            else:
                print(f"  Batch {i} FAILED after 3 retries: {e}", flush=True)
    
    if (i + 1) % 5 == 0 or i == 0 or i == NUM_BATCHES - 1:
        elapsed = time.time() - start
        print(f"  {i+1}/{NUM_BATCHES} batches, {len(all_rows)} rows so far, {elapsed:.1f}s", flush=True)
    
    # Small delay to respect rate limits
    time.sleep(0.3)

# Save
print(f"Saving {len(all_rows)} rows...", flush=True)
with open(OUTPUT_PATH, "w") as f:
    json.dump(all_rows, f)

file_size = os.path.getsize(OUTPUT_PATH) / 1024 / 1024
print(f"Done: {len(all_rows)} rows, {file_size:.1f} MB in {time.time()-start:.1f}s", flush=True)
