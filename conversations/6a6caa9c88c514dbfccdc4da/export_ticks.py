import json, os, sys, time
from concurrent.futures import ThreadPoolExecutor, as_completed
import urllib.request

SUPABASE_ACCESS_TOKEN = os.environ.get("SUPABASE_ACCESS_TOKEN", "")
PROJECT_REF = "mmxkisgdoepojotignkg"
SQL_URL = f"https://api.supabase.com/v1/projects/{PROJECT_REF}/database/query"
OUTPUT_PATH = "/tmp/supabase_backup/tables/stock_ticks.json"
TOTAL_ROWS = 1858147
BATCH_SIZE = 50000
MAX_WORKERS = 20

NUM_BATCHES = (TOTAL_ROWS + BATCH_SIZE - 1) // BATCH_SIZE
print(f"Exporting stock_ticks: {TOTAL_ROWS} rows in {NUM_BATCHES} batches ({MAX_WORKERS} workers)", flush=True)

def fetch_batch(batch_idx):
    offset = batch_idx * BATCH_SIZE
    query = f"SELECT id, symbol, price, change_pct, change_abs, volume, day_high, day_low, tick_time, created_at FROM public.stock_ticks ORDER BY id LIMIT {BATCH_SIZE} OFFSET {offset};"
    body = json.dumps({"query": query}).encode("utf-8")
    req = urllib.request.Request(SQL_URL, data=body, headers={
        "Authorization": f"Bearer {SUPABASE_ACCESS_TOKEN}",
        "Content-Type": "application/json"
    })
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        print(f"  ERROR batch {batch_idx}: {e}", flush=True)
        return []

results = {}
completed = 0
start = time.time()

with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
    futures = {executor.submit(fetch_batch, i): i for i in range(NUM_BATCHES)}
    for future in as_completed(futures):
        idx = futures[future]
        try:
            results[idx] = future.result()
            completed += 1
            if completed % 5 == 0 or completed == NUM_BATCHES:
                print(f"  {completed}/{NUM_BATCHES} batches done ({time.time()-start:.1f}s)", flush=True)
        except Exception as e:
            print(f"  ERROR batch {idx}: {e}", flush=True)
            results[idx] = []

# Combine and save
print("Combining results...", flush=True)
all_rows = []
for i in range(NUM_BATCHES):
    if i in results:
        all_rows.extend(results[i])

with open(OUTPUT_PATH, "w") as f:
    json.dump(all_rows, f)

file_size = os.path.getsize(OUTPUT_PATH) / 1024 / 1024
print(f"Done: {len(all_rows)} rows, {file_size:.1f} MB in {time.time()-start:.1f}s", flush=True)
