import subprocess, shlex, json, sys, os, shutil, glob, time

CMD   = "python mundo_scraper.py https://www.fplmundo.com/723566"
LABEL = "prem"

# Placeholder strings that indicate the article isn't published yet
PLACEHOLDER_PATTERNS = [
    "WRITING IN PROGRESS",
    "PLEASE WAIT",
    "JOIN AS A MEMBER",
    "NEW EDITION EMAIL ALERTS",
    "COMING SOON",
]

def is_placeholder(lines):
    text = " ".join(lines).upper()
    return any(p in text for p in PLACEHOLDER_PATTERNS)

def run_scrape(cmd, do_dump=False):
    if do_dump:
        cmd = cmd + " --dump"
    proc = subprocess.run(shlex.split(cmd), text=True, capture_output=True)
    output = (proc.stdout or "") + (proc.stderr or "")
    lines = [l.strip() for l in output.splitlines() if l.strip()]
    if do_dump:
        if os.path.exists("mundo_dump.html"):
            try: os.replace("mundo_dump.html", f"{LABEL}_dump.html")
            except Exception: pass
        for i, path in enumerate(sorted(glob.glob("mundo_json_*.txt")), start=1):
            try: os.replace(path, f"{LABEL}_json_{i}.txt")
            except Exception: pass
    return proc.returncode, lines

def main():
    MAX_ATTEMPTS = 5
    RETRY_WAIT   = 60  # seconds between retries

    publish = []
    for attempt in range(1, MAX_ATTEMPTS + 1):
        is_last = attempt == MAX_ATTEMPTS
        rc, lines = run_scrape(CMD, do_dump=is_last)

        publish = [l for l in lines if l.startswith("/publish_news ")]

        if not publish:
            print(f"[attempt {attempt}] no /publish_news lines found", file=sys.stderr)
        elif is_placeholder(publish):
            print(f"[attempt {attempt}] placeholder content detected, retrying...", file=sys.stderr)
            publish = []
        else:
            print(f"[attempt {attempt}] real content found ({len(publish)} articles)", file=sys.stderr)
            break

        if not is_last:
            time.sleep(RETRY_WAIT)

    print(json.dumps({"source": "premier", "commands": publish}, ensure_ascii=False, indent=2))

if __name__ == "__main__":
    main()
