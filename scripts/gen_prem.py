import subprocess, shlex, json, sys, os, shutil, glob, time

CMD = "python mundo_scraper.py https://www.fplmundo.com/723566"
LABEL = "prem"

def run_scrape(cmd, do_dump=False):
    if do_dump:
        cmd = cmd + " --dump"
    proc = subprocess.run(shlex.split(cmd), text=True, capture_output=True)
    output = (proc.stdout or "") + (proc.stderr or "")
    lines = [l.strip() for l in output.splitlines() if l.strip()]
    if do_dump:
        # rename dumps so CI uploads them with league-specific names
        if os.path.exists("mundo_dump.html"):
            try:
                os.replace("mundo_dump.html", f"{LABEL}_dump.html")
            except Exception:
                pass
        for i, path in enumerate(sorted(glob.glob("mundo_json_*.txt")), start=1):
            try:
                os.replace(path, f"{LABEL}_json_{i}.txt")
            except Exception:
                pass
    return proc.returncode, lines

def main():
    
    # 1) warm-up pass (often shows placeholders)
    rc1, lines1 = run_scrape(CMD, do_dump=False)
    # brief pause so SPA/APIs settle
    time.sleep(5)

    # 2) real pass — only use THIS output
    rc2, lines2 = run_scrape(CMD, do_dump=(rc2:=0) or False)  # placeholder to define rc2
    # If second run failed, try once more with --dump for artifacts
    if rc2 != 0 or not any(l.startswith("/publish_news ") for l in lines2):
        rc2, lines2 = run_scrape(CMD, do_dump=True)

    # Keep only /publish_news lines from second run
    publish = [l for l in lines2 if l.startswith("/publish_news ")]
    print(json.dumps({"source": "premier", "commands": publish}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
