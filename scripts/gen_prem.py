import subprocess, shlex, json

cmd = "python mundo_scraper.py https://www.fplmundo.com/723566"
runs = []
for _ in range(2):  # run twice
    out = subprocess.check_output(shlex.split(cmd), text=True, stderr=subprocess.STDOUT)
    lines = [l.strip() for l in out.splitlines() if l.strip()]
    runs.append(lines)

seen = set()
merged = []
for lines in runs:
    for l in lines:
        if l not in seen:
            merged.append(l)
            seen.add(l)

print(json.dumps({"source": "premier", "commands": merged}, ensure_ascii=False, indent=2))
