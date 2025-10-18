import subprocess, shlex, json, sys, os, shutil, glob, time

CMD = "python mundo_scraper.py https://www.fplmundo.com/850022"
LABEL = "chmps"


def run_scrape(cmd, do_dump=False):
    if do_dump:
        cmd = cmd + " --dump"
    proc = subprocess.run(shlex.split(cmd), text=True, capture_output=True)
    output = (proc.stdout or "") + (proc.stderr or "")
    lines = [l.strip() for l in output.splitlines() if l.strip()]
    if do_dump:
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
    rc1, lines1 = run_scrape(CMD, do_dump=False)
    time.sleep(5)

    rc2, lines2 = run_scrape(CMD, do_dump=(rc2:=0) or False)
    if rc2 != 0 or not any(l.startswith("/publish_news ") for l in lines2):
        rc2, lines2 = run_scrape(CMD, do_dump=True)

    publish = [l for l in lines2 if l.startswith("/publish_news ")]
    print(json.dumps({"source": "championship", "commands": publish}, ensure_ascii=False, indent=2))

if __name__ == "__main__":
    main()
