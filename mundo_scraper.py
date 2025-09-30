#!/usr/bin/env python3
import sys, re, html, json, argparse, time, os
from typing import List, Tuple, Optional, Any, Dict
from urllib.parse import urlparse

SEASON_REVIEW_TAG = "GW-Review-2025/26"
STATE_PATH = "mundo_state.json"  # created by --seed
HOMEPAGE_MARKER = re.compile(r"The original FPL mini-league newspaper", re.I)
BLACKLIST_TITLES = {
    "MINI LEAGUE NEWS ROUNDUP","PREMATCH EDITION","POSTMATCH EDITION","FANS, KITS AND STADIUMS",
    "FOLLOW FOR UPDATES","NOT A REAL NEWSPAPER","FPL MUNDO SUPPORTER LEAGUES",
    "LETTERS FROM READERS","DISCLAIMER","OTHER TERMS AND PRIVACY","PRIVACY POLICY",
    "TERMS","COOKIE POLICY","WELCOME TO FPLMUNDO!",
}

def _clean(s: str) -> str:
    if not s: return ""
    s = html.unescape(s).replace("\u00a0"," ").replace("\u200b"," ")
    return re.sub(r"\s+"," ",s).strip()

def _sanitize(s: str, limit: int=6000) -> str:
    s = _clean(s)
    return s if len(s)<=limit else (s[:limit] + "…")

def _gw(text: str) -> Optional[str]:
    m = re.search(r"\bGW\s*([0-9]{1,2})\b", text, re.I) or re.search(r"\bGameweek\s*([0-9]{1,2})\b", text, re.I)
    return m.group(1) if m else None

def _league_tag(url: str) -> str:
    return "Premier" if "723566" in url else "Championship"

def _league_code(url: str) -> Optional[str]:
    m = re.search(r"/(\d{5,9})(?:/|$)", urlparse(url).path)
    return m.group(1) if m else None

def _cmd(gw: Optional[str], title: str, body: str, tag: str, image: Optional[str]) -> str:
    t = f"GW{gw} Review: {title}".strip() if gw else f"Review: {title}"
    return (f"/publish_news title: {t} content: { _sanitize(body) } "
            f"tags: {tag}, {SEASON_REVIEW_TAG} excerpt: { _sanitize(body) } image_url: {image or ''}")

def _bs4(html_text: str):
    from bs4 import BeautifulSoup
    try: return BeautifulSoup(html_text, "lxml")
    except Exception: return BeautifulSoup(html_text, "html.parser")

def _extract_cards(soup) -> List[Tuple[str,str,Optional[str]]]:
    sels = [
        ".elementor-post__card","article.elementor-post",".elementor-grid .elementor-grid-item",
        "article.post",".story,.story-card,.card","main section,main article,main div","section,div.elementor-widget-container"
    ]
    nodes=[]
    for sel in sels: nodes += soup.select(sel)
    out=[]
    for el in nodes:
        tit_el = el.select_one("h1,h2,h3,h4,.elementor-post__title") or el.select_one("a[rel='bookmark']")
        title = _clean(tit_el.get_text(" ", strip=True)) if tit_el else ""
        if not title or title.upper() in BLACKLIST_TITLES: continue
        body = _clean(" ".join(_clean(p.get_text(' ', strip=True)) for p in el.select("p,li") if _clean(p.get_text(' ', strip=True))))
        if len(body) < 80: continue
        if HOMEPAGE_MARKER.search(title + " " + body): continue
        img = el.select_one("img")
        img_src = img.get("src") if img and img.get("src") else None
        out.append((title, body, img_src))
    # de-dupe by title
    seen=set(); uniq=[]
    for t,b,i in out:
        k=t.lower()
        if k not in seen: uniq.append((t,b,i)); seen.add(k)
    return uniq

def _extract_headings(soup) -> List[Tuple[str,str,Optional[str]]]:
    heads = soup.select("main h1,main h2,main h3,main h4,h1,h2,h3,h4")
    out=[]
    all_nodes=list(soup.body.descendants) if soup.body else list(soup.descendants)
    idx={id(n):i for i,n in enumerate(all_nodes)}
    def next_h(i):
        for j in range(i+1,len(all_nodes)):
            n=all_nodes[j]; name=getattr(n,"name",None)
            if name and name.lower() in ("h1","h2","h3","h4"): return j
        return len(all_nodes)
    for h in heads:
        t=_clean(h.get_text(" ", strip=True))
        if not t or t.upper() in BLACKLIST_TITLES: continue
        si=idx.get(id(h)); 
        if si is None: continue
        ei=next_h(si)
        parts=[]; img=None
        for j in range(si+1,ei):
            n=all_nodes[j]; name=getattr(n,"name",None)
            if not name: continue
            ln=name.lower()
            if ln in ("p","li"):
                txt=_clean(getattr(n,"get_text",lambda *_:"")(" ", strip=True))
                if txt: parts.append(txt)
            elif ln=="img" and img is None:
                src=n.get("src"); 
                if src: img=src
        body=_clean(" ".join(parts))
        if len(body) >= 80 and not HOMEPAGE_MARKER.search(t+" "+body):
            out.append((t,body,img))
    # de-dupe
    seen=set(); uniq=[]
    for t,b,i in out:
        k=t.lower()
        if k not in seen: uniq.append((t,b,i)); seen.add(k)
    return uniq

def _mine_json(obj: Any) -> List[Tuple[str,str,Optional[str]]]:
    stories=[]
    def is_story(d: Dict[str,Any]):
        ks={k.lower() for k in d.keys()}
        return any(k in ks for k in ("title","header","headline","name")) and any(k in ks for k in ("content","body","text","description"))
    def get_t(d): 
        for k in ("title","header","headline","name"):
            v=d.get(k); 
            if isinstance(v,str): return v
        return ""
    def get_b(d):
        for k in ("content","body","text","description"):
            v=d.get(k)
            if isinstance(v,str): return v
            if isinstance(v,list):
                j=" ".join(x for x in v if isinstance(x,str))
                if j: return j
        return ""
    def get_i(d):
        for k in ("image","image_url","img","thumbnail","featuredImage","ogImage"):
            v=d.get(k)
            if isinstance(v,str) and v.strip(): return v
            if isinstance(v,dict):
                for kk in ("url","src","source"):
                    vv=v.get(kk)
                    if isinstance(vv,str) and vv.strip(): return vv
        return None
    def walk(x):
        if isinstance(x,dict):
            if is_story(x):
                t=_clean(get_t(x)); b=_clean(get_b(x)); i=get_i(x)
                if t and len(b)>=80 and t.upper() not in BLACKLIST_TITLES and not HOMEPAGE_MARKER.search(t+" "+b):
                    stories.append((t,b,i))
            for v in x.values(): walk(v)
        elif isinstance(x,list):
            for v in x: walk(v)
    walk(obj)
    # de-dupe
    seen=set(); uniq=[]
    for t,b,i in stories:
        k=t.lower()
        if k not in seen: uniq.append((t,b,i)); seen.add(k)
    return uniq

# ---------- Playwright helpers ----------
def seed_cookies(url: str):
    """Open headed browser, let user click 'I AGREE', then save storage state."""
    from playwright.sync_api import sync_playwright
    league = _league_code(url) or "723566"
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False, slow_mo=200)
        context = browser.new_context()  # fresh
        page = context.new_page()
        page.goto(f"https://www.fplmundo.com/{league}", wait_until="domcontentloaded", timeout=30000)
        try: page.wait_for_load_state("networkidle", timeout=10000)
        except Exception: pass
        print("\n>> If you see an 'I AGREE' banner, CLICK IT once.")
        print(">> If there is a league input, type the number and submit.")
        input(">> When your league page is visible (no banner), press Enter here to save state... ")
        context.storage_state(path=STATE_PATH)
        print(f">> Saved storage state to {STATE_PATH}")
        context.close()
        browser.close()

def scrape(url: str, dump: bool=False, headed: bool=False) -> List[str]:
    from playwright.sync_api import sync_playwright
    code = _league_code(url) or "723566"
    tag  = _league_tag(url)

    with sync_playwright() as p:
        # launch browser, create context (with or without saved storage)
        browser = p.chromium.launch(headless=not headed)
        if os.path.exists(STATE_PATH):
            context = browser.new_context(storage_state=STATE_PATH)
        else:
            context = browser.new_context()
        page = context.new_page()

        captured=[]
        def on_response(resp):
            try:
                ct = resp.headers.get("content-type","").lower()
                if "application/json" in ct or resp.request.resource_type in ("xhr","fetch"):
                    txt = resp.text()
                    if txt and txt.strip().startswith(("{","[")):
                        captured.append({"url": resp.url, "json": json.loads(txt)})
            except Exception:
                pass
        page.on("response", on_response)

        # direct to league
        page.goto(f"https://www.fplmundo.com/{code}", wait_until="domcontentloaded", timeout=30000)
        try: page.wait_for_load_state("networkidle", timeout=12000)
        except Exception: pass
        page.wait_for_timeout(1500)
        html_text = page.content()

        if dump:
            with open("mundo_dump.html","w",encoding="utf-8") as f: f.write(html_text)
            for i,blob in enumerate(captured[:6], start=1):
                with open(f"mundo_json_{i}.txt","w",encoding="utf-8") as f:
                    f.write(blob["url"]+"\n"); f.write(json.dumps(blob["json"], ensure_ascii=False, indent=2))

        context.close()
        browser.close()

    # parse DOM -> fallback to JSON
    soup = _bs4(html_text)
    page_text = _clean(soup.get_text(" ", strip=True))
    gw = _gw(page_text)

    stories = _extract_cards(soup)
    if len(stories) < 4:
        for t,b,i in _extract_headings(soup):
            if all(t.lower()!=s[0].lower() for s in stories):
                stories.append((t,b,i))
            if len(stories) >= 4: break

    if len(stories) < 4 and captured:
        mined=[]
        for blob in captured: mined += _mine_json(blob["json"])
        for t,b,i in mined:
            if all(t.lower()!=s[0].lower() for s in stories):
                stories.append((t,b,i))
            if len(stories) >= 4: break

    if not stories:
        raise RuntimeError("No stories found (did the consent cookie seed succeed?)")

    return [_cmd(gw, t, b, tag, i) for (t,b,i) in stories[:4]]

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("url", nargs="?", default="https://www.fplmundo.com/723566")
    ap.add_argument("--dump", action="store_true", help="Dump DOM and captured JSON")
    ap.add_argument("--headed", action="store_true", help="Run with a visible browser")
    ap.add_argument("--seed", action="store_true", help="Open headed browser to click consent and save state, then exit")
    args = ap.parse_args()

    if args.seed:
        seed_cookies(args.url)
        return

    cmds = scrape(args.url, dump=args.dump, headed=args.headed)
    for c in cmds:
        print(c)

if __name__ == "__main__":
    main()
