import re, json, os, sys

functions_dir = "/tmp/supabase_backup/functions"
os.makedirs(functions_dir, exist_ok=True)

slugs = []
with open("/tmp/functions_list.txt") as f:
    for line in f:
        parts = line.strip().split("|")
        if len(parts) >= 2:
            slugs.append(parts[1])

for slug in slugs:
    bin_path = f"/tmp/func_{slug}.bin"
    if not os.path.exists(bin_path):
        print(f"  {slug}: binary file not found, skipping")
        continue
    
    with open(bin_path, "rb") as f:
        data = f.read()
    
    extracted = False
    
    # Method 1: Find source map JSON with sourcesContent
    idx = data.find(b'{"version":3')
    if idx >= 0:
        depth = 0
        end = idx
        in_string = False
        escape = False
        for i in range(idx, len(data)):
            c = data[i:i+1]
            if escape:
                escape = False
                continue
            if c == b'\\':
                escape = True
                continue
            if c == b'"':
                in_string = not in_string
                continue
            if in_string:
                continue
            if c == b'{':
                depth += 1
            elif c == b'}':
                depth -= 1
                if depth == 0:
                    end = i + 1
                    break
        
        json_str = data[idx:end].decode("utf-8", errors="replace")
        try:
            sm = json.loads(json_str)
            if "sourcesContent" in sm and sm["sourcesContent"]:
                source_code = sm["sourcesContent"][0]
                if source_code and len(source_code) > 50:
                    with open(f"{functions_dir}/{slug}.ts", "w") as out:
                        out.write(source_code)
                    print(f"  {slug}: extracted {len(source_code)} chars (source map)")
                    extracted = True
                    continue
        except (json.JSONDecodeError, IndexError) as e:
            print(f"  {slug}: source map parse error: {e}")
    
    # Method 2: Extract from text blocks (compiled JS)
    if not extracted:
        text_blocks = re.findall(b'[\x20-\x7e\n\r\t]{100,}', data)
        if text_blocks:
            code_blocks = []
            for block in text_blocks:
                decoded = block.decode("utf-8", errors="replace")
                if not decoded.strip().startswith("{") or "sourcesContent" not in decoded:
                    code_blocks.append(decoded)
            
            if code_blocks:
                combined = "\n\n".join(code_blocks)
                with open(f"{functions_dir}/{slug}.ts", "w") as out:
                    out.write(combined)
                print(f"  {slug}: extracted {len(combined)} chars (text blocks)")
                extracted = True
    
    if not extracted:
        print(f"  {slug}: FAILED to extract source")

print("\nDone. Files:")
for f in sorted(os.listdir(functions_dir)):
    path = os.path.join(functions_dir, f)
    print(f"  {f}: {os.path.getsize(path)} bytes")
