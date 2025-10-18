require("dotenv").config();
const {
  Client, GatewayIntentBits, EmbedBuilder, Events, Routes, REST
} = require("discord.js");
const axios = require("axios");
const cheerio = require("cheerio");
const { JSDOM } = require("jsdom");
const TurndownService = require("turndown");
const { Readability } = require("@mozilla/readability");
const express = require("express");
const app = express();
app.use(express.json({ limit: "1mb" }));

// ---- Robust GET with warm-up, cookies, Referer/Origin, backoff ----
const https = require("https");
const http = require("http");

const DEFAULT_UA =
  process.env.FPL_USER_AGENT ||
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36";

const BASE_HEADERS = {
  "User-Agent": DEFAULT_UA,
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.8",
  "Connection": "keep-alive",
};

const keepAliveAgent = {
  httpAgent: new http.Agent({ keepAlive: true, maxSockets: 50 }),
  httpsAgent: new https.Agent({ keepAlive: true, maxSockets: 50 }),
};

const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const MAX_RETRIES = Number(process.env.HTTP_MAX_RETRIES || 4);
const BASE_DELAY_MS = Number(process.env.HTTP_BASE_DELAY_MS || 350);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function jitter(ms) { return ms + Math.floor(Math.random() * 120); }

// Very small cookie jar (no external deps). Parses Set-Cookie -> Cookie header.
function parseSetCookieToCookieHeader(setCookieArr = []) {
  try {
    const cookies = [];
    for (const raw of setCookieArr) {
      // take only "name=value" before the first ';'
      const nv = String(raw).split(";")[0].trim();
      if (nv && nv.includes("=")) cookies.push(nv);
    }
    return cookies.join("; ");
  } catch {
    return "";
  }
}

async function warmUpFplAndGetCookies() {
  try {
    const res = await axios.get("https://fantasy.premierleague.com/", {
      ...keepAliveAgent,
      timeout: 10000,
      headers: {
        ...BASE_HEADERS,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      validateStatus: () => true,
    });
    const setCookie = res.headers?.["set-cookie"];
    const cookieHeader = Array.isArray(setCookie) ? parseSetCookieToCookieHeader(setCookie) : "";
    return cookieHeader;
  } catch {
    return "";
  }
}

/**
 * getWithRetries(url, opts)
 * opts: { headers, timeout, params, referer, origin, useFplWarmup }
 */
async function getWithRetries(url, { headers = {}, timeout = 15000, params, referer, origin, useFplWarmup } = {}) {
  let lastErr;
  let cachedCookie = ""; // we only warm up once per call-chain

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const hdrs = { ...BASE_HEADERS, ...headers };
      if (origin) hdrs["Origin"] = origin;
      if (referer) hdrs["Referer"] = referer;
      if (cachedCookie) hdrs["Cookie"] = cachedCookie;

      const res = await axios.get(url, {
        headers: hdrs,
        timeout,
        params,
        ...keepAliveAgent,
      });
      return res;
    } catch (e) {
      const status = e?.response?.status;
      const msg = e?.message || String(e);
      const retryable = status ? RETRYABLE.has(status) : true;

      // One-time warm-up if 503/429/5xx and caller asked for it
      if (!cachedCookie && useFplWarmup && retryable) {
        cachedCookie = await warmUpFplAndGetCookies();
      }

      if (attempt < MAX_RETRIES && retryable) {
        let delay = BASE_DELAY_MS * Math.pow(2, attempt);
        const ra = e?.response?.headers?.["retry-after"];
        if (ra) {
          const sec = Number(ra);
          if (!Number.isNaN(sec) && sec > 0) delay = Math.max(delay, sec * 1000);
        }
        delay = jitter(delay);
        console.log(`[retry ${attempt + 1}/${MAX_RETRIES}] GET ${url} failed (${status || "no-status"}: ${msg}); waiting ${delay}ms`);
        await sleep(delay);
        lastErr = e;
        continue;
      }
      throw e;
    }
  }
  throw lastErr || new Error(`Failed to GET ${url}`);
}

// ===== FPL Mundo scraping config =====
// --- DEBUG ---
const DEBUG_MUNDO = String(process.env.DEBUG_MUNDO || "").trim() !== "" && process.env.DEBUG_MUNDO !== "0";
function debugLog(...args) {
  if (DEBUG_MUNDO) console.log("[MUNDO]", ...args);
}

const FPL_MUNDO_PREMIER_URL =
  process.env.FPL_MUNDO_PREMIER_URL || "https://www.fplmundo.com/723566";
const FPL_MUNDO_CHAMP_URL =
  process.env.FPL_MUNDO_CHAMP_URL || "https://www.fplmundo.com/850022";
const FPL_MUNDO_PLACEHOLDER_IMAGE =
  process.env.FPL_MUNDO_PLACEHOLDER_IMAGE ||
  "https://fplvideotemplates.com/shop-all/templates/images/Gameweek-Review-Analysis-PPT-230802-1360x765-02.jpg";
const HAS_PUPPETEER = !!process.env.USE_PUPPETEER; // set USE_PUPPETEER=1 if you can run headless Chrome

// Robust article parsing stack
let puppeteerExtra = null;
try {
  if (HAS_PUPPETEER) {
    puppeteerExtra = require("puppeteer-extra");
    puppeteerExtra.use(require("puppeteer-extra-plugin-stealth")());
  }
} catch (_) { /* puppeteer optional */ }

// Tag for this season’s weekly reviews
const FPL_MUNDO_TAG = "GW-Review-2025/26";

// ===== Weekly Reviews article config =====
const WEEKLY_REVIEW_IMAGE =
  process.env.WEEKLY_REVIEW_IMAGE ||
  "https://news.bbcimg.co.uk/media/images/53844000/jpg/_53844767_012374172-1.jpg";
const WEEKLY_REVIEW_TAG =
  process.env.WEEKLY_REVIEW_TAG || "GW-Review-2025/26";

// Require the GW to be both finished AND data_checked before posting summaries.
// Set GW_SUMMARY_REQUIRE_FINALIZED=0 to relax to "finished only".
const GW_SUMMARY_REQUIRE_FINALIZED = process.env.GW_SUMMARY_REQUIRE_FINALIZED !== "0";

function isEventFinalized(ev) {
  if (!ev) return false;
  const finished = ev.is_finished === true || ev.finished === true;
  const checked  = ev.data_checked === true;
  return finished && (GW_SUMMARY_REQUIRE_FINALIZED ? checked : true);
}

async function safeDefer(interaction, opts = { ephemeral: false }) {
  try {
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferReply(opts);
    }
  } catch {
    try { if (!interaction.deferred && !interaction.replied) {
      await interaction.reply({ content: "Working on it…", ephemeral: true });
    }} catch {}
  }
}

// ===== CONFIG =====
const BASE = "https://tfpl.onrender.com/api".replace(/\/+$/, "");
if (!BASE) throw new Error("BACKEND_URL not set");
const API_HEADERS = {};
if (process.env.API_KEY) API_HEADERS["X-Api-Key"] = process.env.API_KEY;

const SITE_BASE = (process.env.SITE_BASE || "https://tfpl.vercel.app").replace(/\/+$/, "");

const PREVIEW_DEBUG = process.env.PREVIEW_DEBUG === "1";
const PREVIEW_DEBUG_NOTIFY = process.env.PREVIEW_DEBUG_NOTIFY === "1";
function logPreviewDebug(...args) {
  if (PREVIEW_DEBUG) console.log("[previews]", ...args);
}


function normalizeUrl(u) {
  if (!u) return u;
  try { new URL(u); return u; } catch (_) { /* not absolute */ }
  if (u.startsWith("/")) return `${SITE_BASE}${u}`;
  return u; // leave other non-absolute strings alone
}

// Mods: Rehan
const MOD_IDS = ["626536164236591120"];

function isMod(userId) { return MOD_IDS.includes(String(userId)); }

/**
 * Decide who we're targeting:
 * - If slash option "user" is provided => target that Discord user.
 * - Else if slash option "name" (non-empty) is provided => target by free-text name.
 * - Else default to self (Discord user).
 */
function resolveTarget(interaction) {
  const userOpt = interaction.options?.getUser?.("user");
  const nameOpt = interaction.options?.getString?.("name");

  if (userOpt) {
    const isSelf = userOpt.id === interaction.user.id;
    return { mode: "discord", isSelf, discordId: userOpt.id, display: `${userOpt.tag}` };
  }

  if (nameOpt && nameOpt.trim()) {
    return { mode: "name", isSelf: false, name: nameOpt.trim(), display: nameOpt.trim() };
  }

  // default to self
  return { mode: "discord", isSelf: true, discordId: interaction.user.id, display: interaction.user.tag };
}

function ensureCanEditFlexible(actorId, target) {
  actorId = String(actorId);
  if (isMod(actorId)) return; // mods can edit anyone
  if (target.mode === "discord" && target.discordId === actorId) return; // self-edit OK
  const err = new Error("You can only edit your own profile. Mods can edit anyone.");
  err.status = 403;
  throw err;
}

/* ===== Backend helpers: support discordId OR name ===== */
async function getProfileFlexible(target) {
  if (target.mode === "discord") return getProfileByDiscord(target.discordId);
  return getProfileByName(target.name);
}

async function getProfile(idOrName) {
  const url = `${BASE}/user/${encodeURIComponent(String(idOrName).trim())}`;
  const { data } = await axios.get(url, { headers: API_HEADERS });
  return data;
}

async function updateProfile(idOrName, fields, actorId) {
  const url = `${BASE}/user/${encodeURIComponent(String(idOrName).trim())}`;
  const headers = { ...API_HEADERS, 'X-Actor-Id': String(actorId) };
  const { data } = await axios.post(url, fields, { headers });
  return data;
}

function extractError(err) {
  const d = err?.response?.data?.detail;
  if (Array.isArray(d)) {
    // Pydantic-style errors
    return d.map(e => `${(e.loc || []).join('.')}: ${e.msg}`).join(' | ');
  }
  return d || err?.message || "Unknown error";
}

async function postNews(payload) {
  // accepts either content_html or content_markdown
  const normalized = {
    title: payload.title,
    excerpt: payload.excerpt || "",
    image_url: payload.image_url || null,
    content_html: payload.content_html || null,
    content_markdown: payload.content_markdown || null,
    tags: Array.isArray(payload.tags)
      ? payload.tags
      : String(payload.tags || "")
          .split(/[,\s#]+/)
          .map(s => s.trim())
          .filter(Boolean)
          .slice(0, 12),
    author: payload.author || null,
  };
  const res = await axios.post(`${BASE}/news`, normalized, { headers: API_HEADERS, timeout: 20000 });
  return res.data;
}

function firstAttachmentUrl(interaction) {
  const att = interaction.options?.getAttachment?.("image_file");
  return att?.url || null;
}

function makeEmbed(profile) {
  const imgRaw = profile.dynamic_image_url || profile.image_url;
  const img = normalizeUrl(imgRaw);

  const e = new EmbedBuilder()
    .setTitle(`${profile.name || "Unknown"}${profile.team ? ` (${profile.team})` : ""}`)
    .setDescription(profile.bio || "No bio set.")
    .addFields(
      { name: "Favorite Club", value: profile.favorite_club || "—", inline: true },
      { name: "Social", value: profile.social_url || "—", inline: true }
    )
    .setColor(0x5865f2);

  if (img) e.setThumbnail(img);
  return e;
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

// (Optional) auto-register commands on start for your guild
async function registerCommandsOnReady() {
  const rest = new REST({ version: "10" }).setToken(process.env.BOT_TOKEN);
  try {
    const cmds = await rest.get(Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID));
    console.log(`Guild has ${cmds.length} slash commands registered.`);
  } catch (e) {
    console.log("Tip: run `node deploy-commands.js` to register slash commands.");
  }
}

// ===== Manager mapping from backend =====
const MANAGERS_API = process.env.MANAGERS_API || `${BASE}/managers`;

function extractDiscordId(val) {
  if (!val) return null;
  const str = String(val);
  const m = str.match(/\d{17,20}/); // extract snowflake if present
  return m ? m[0] : null;
}

async function refreshManagerDiscordMap() {
  try {
    const res = await axios.get(MANAGERS_API, { headers: API_HEADERS });
    const data = res.data;

    const map = {};            // key: owner/team, value: discordId or null
    let total = 0, withId = 0, withoutId = 0;

    const pushRow = (row) => {
      total++;
      const owner =
        row.owner || row.owner_name || row.name || row.manager || row.display_name || row.username;
      const team = row.team || row.team_name;
      const rawId =
        row.discord_id || row.discordId || row.discord || row.discord_user_id || row.discordUserId;
      const did = extractDiscordId(rawId); // may be null

      if (did) withId++; else withoutId++;

      if (owner) map[owner] = did ?? null;
      if (team && !map[team]) map[team] = did ?? null; // don't overwrite if owner already set
    };

    if (Array.isArray(data)) {
      for (const m of data) pushRow(m);
    } else if (data && typeof data === "object") {
      for (const [, v] of Object.entries(data)) pushRow(v);
    }

    MANAGER_MAP = { ...MANAGER_MAP, ...map };
    console.log(
      `Manager map refreshed: ${withId} with IDs / ${withoutId} without (total rows: ${total}).`
    );
  } catch (e) {
    console.log("Failed to refresh manager map:", e?.response?.status || "", e?.message || e);
  }
}

// ===== FPL Mundo helpers =====

// Latest finished GW (prefers most recent finished event)
async function getLatestFinishedGwNumber() {
  const { data } = await axios.get("https://fantasy.premierleague.com/api/bootstrap-static/");
  const events = data?.events || [];
  const finished = events
    .filter(e => e.is_finished === true || e.finished === true)
    .sort((a, b) => b.id - a.id);
  return finished[0]?.id ?? null;
}

// Very light HTML -> Markdown-ish text (keeps paragraphs/line breaks)
function htmlToText(html) {
  if (!html) return "";
  // remove scripts/styles
  let s = html.replace(/<script[\s\S]*?<\/script>/gi, "")
              .replace(/<style[\s\S]*?<\/style>/gi, "");

  // prefer <article>, else <main>, else whole doc
  const art = s.match(/<article[\s\S]*?<\/article>/i)?.[0]
           || s.match(/<main[\s\S]*?<\/main>/i)?.[0]
           || s;

  // normalize line breaks
  s = art.replace(/<\s*br\s*\/?>/gi, "\n")
         .replace(/<\/p>/gi, "\n\n");

  // strip tags
  s = s.replace(/<[^>]+>/g, "");

  // condense whitespace
  s = s.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();

  return s;
}

function extractTitleFromHtml(html) {
  if (!html) return "Review";
  const og = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
  if (og && og[1]) return og[1].trim();
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1 && h1[1]) return h1[1].replace(/<[^>]+>/g, "").trim();
  const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (t && t[1]) return t[1].trim();
  return "Review";
}

// ===== Multi-article extraction from a single FPL Mundo page =====
const MUNDO_MAX_SECTIONS = parseInt(process.env.MUNDO_MAX_SECTIONS || "4", 10);
const MUNDO_SECTION_MIN_CHARS = parseInt(process.env.MUNDO_SECTION_MIN_CHARS || "600", 10);
const MUNDO_DEFAULT_IMAGE = process.env.MUNDO_DEFAULT_IMAGE || FPL_MUNDO_PLACEHOLDER_IMAGE;

function absUrl(href, base) {
  try {
    if (!href) return null;
    return new URL(href, base).toString();
  } catch (_) {
    return null;
  }
}

async function fetchRenderedHtml(url) {
  debugLog("fetchRenderedHtml:start", url);

  // 1) try plain HTTP (SSR or prerender)
  try {
    const res = await axios.get(url, {
      timeout: 20000,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": "https://www.fplmundo.com/",
      },
      transformResponse: [r => r],
      validateStatus: s => s >= 200 && s < 400,
    });
    const html = String(res.data || "");
    const looksLikeChallenge = /just a moment|cloudflare|cf-browser-verification|__cf_chl/i.test(html);
    const looksLikeShell = html.length < 2000 || />\s*Loading\s*<|id="__next"[^>]*>\s*<\/div>/i.test(html);
    debugLog("fetchRenderedHtml:plain", { len: html.length, looksLikeChallenge, looksLikeShell });
    if (!looksLikeChallenge && !looksLikeShell) return html;
  } catch (e) {
    debugLog("fetchRenderedHtml:plain:error", e?.message || e);
  }

  // 2) dynamic render w/ Puppeteer
  if (HAS_PUPPETEER) {
    debugLog("fetchRenderedHtml:puppeteer:enabled");
    const puppeteer = require("puppeteer");
    const browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    try {
      const page = await browser.newPage();
      await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36");
      await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
      debugLog("fetchRenderedHtml:puppeteer:navigated");

      const candidates = ['button', 'a[role="button"]', '[id*="accept"]', '[id*="agree"]', '[aria-label*="accept"]', '[data-testid*="accept"]'];
      for (const sel of candidates) {
        const handles = await page.$$(sel);
        for (const h of handles) {
          const txt = (await (await h.getProperty("innerText")).jsonValue() || "").toString().trim().toLowerCase();
          if (/(accept|agree|allow all|got it|ok)/i.test(txt)) {
            debugLog("fetchRenderedHtml:puppeteer:clickedConsent", txt);
            await h.click().catch(()=>{});
            await page.waitForTimeout(400);
            break;
          }
        }
      }

      await page.waitForFunction(
        () => document && document.body && document.body.innerText && document.body.innerText.length > 2000,
        { timeout: 25000 }
      ).catch(()=>{ debugLog("fetchRenderedHtml:puppeteer:waitForFunction:timeout"); });

      const html = await page.content();
      debugLog("fetchRenderedHtml:puppeteer:return", { len: html?.length || 0 });
      return html;
    } catch (e) {
      debugLog("fetchRenderedHtml:puppeteer:error", e?.message || e);
    } finally {
      await browser.close().catch(()=>{});
    }
  } else {
    debugLog("fetchRenderedHtml:puppeteer:disabled");
  }

  // 3) ultra-light prerender proxy (text only)
  const proxyUrl = `https://r.jina.ai/https://www.fplmundo.com/${url.split("/").pop()}`;
  debugLog("fetchRenderedHtml:proxy", proxyUrl);

  const { data: text } = await axios.get(proxyUrl, { timeout: 20000 });
  debugLog("fetchRenderedHtml:proxy:return", { len: String(text || "").length });

  return `<html><body><main>${String(text || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/\n/g,"<br/>")}</main></body></html>`;
}

/** Turn the full page HTML into multiple section-articles.
 *  Strategy:
 *   1) Prefer multiple <article> blocks with headings.
 *   2) Else split <main> by H2/H3 "section" headings.
 *   3) Skip tiny/empty sections.
 */
function extractSectionsFromHtml(html, pageUrl) {
  const $ = cheerio.load(html);
  const root = $("main").length ? $("main").first() : $("body");

  const pickTitle = ($scope) => {
    const h = $scope.find("h1,h2,h3").first();
    const t = h.text().trim();
    return t || "Review";
  };

  const firstImg = ($scope) => {
    const img = $scope.find("img[src]").first().attr("src");
    return absUrl(img, pageUrl) || null;
  };

  const sections = [];

  // (1) multiple <article> nodes?
  const $arts = root.find("article");
  if ($arts.length >= 2) {
    $arts.each((_, el) => {
      const $a = $(el);
      const title = pickTitle($a);
      const img = firstImg($a) || null;
      const htmlBlock = $.html($a);
      const text = htmlToText(htmlBlock);
      if (text && text.length >= MUNDO_SECTION_MIN_CHARS) {
        sections.push({
          title,
          excerpt: text.slice(0, 600),
          image_url: img || MUNDO_DEFAULT_IMAGE,
          content_markdown: `${text}\n\n[Read the original on FPL Mundo](${pageUrl})`,
        });
      }
    });
  }

  // (2) If not enough, split by H2/H3 headings under main
if (sections.length < 2) {
  const headers = root.find("h2,h3").toArray();

  const level = (el) => {
    const tag = (el.tagName || "").toLowerCase();
    return tag === "h2" ? 2 : tag === "h3" ? 3 : 9;
  };

  for (let i = 0; i < headers.length; i++) {
    const start = headers[i];
    const startLevel = level(start);

    // Collect nodes from start until the next header of same or higher level
    let htmlBlock = $.html(start);
    let n = start.next;
    while (n) {
      if (n.type === "tag" && /^(h2|h3)$/i.test(n.tagName) && level(n) <= startLevel) break;
      htmlBlock += $.html(n);
      n = n.next;
    }

    const section$ = cheerio.load(`<div>${htmlBlock}</div>`)("div");
    const title = section$.find("h2,h3").first().text().trim() || "Review";
    const img = firstImg(section$) || firstImg(root) || null;
    const text = htmlToText(htmlBlock);

    if (text && text.length >= MUNDO_SECTION_MIN_CHARS) {
      sections.push({
        title,
        excerpt: text.slice(0, 600),
        image_url: img || MUNDO_DEFAULT_IMAGE,
        content_markdown: `${text}\n\n[Read the original on FPL Mundo](${pageUrl})`,
      });
    }
    if (sections.length >= MUNDO_MAX_SECTIONS) break;
  }
}


  // (3) Fallback: treat the whole page as one
  if (!sections.length) {
    const bigText = htmlToText($.html(root));
    if (bigText && bigText.length >= 300) {
      const title = extractTitleFromHtml(html) || "Review";
      sections.push({
        title,
        excerpt: bigText.slice(0, 600),
        image_url: firstImg(root) || MUNDO_DEFAULT_IMAGE,
        content_markdown: `${bigText}\n\n[Read the original on FPL Mundo](${pageUrl})`,
      });
    }
  }

  // Trim to max N
  return sections.slice(0, MUNDO_MAX_SECTIONS);
}

async function publishFplMundoMulti(url, { tag = FPL_MUNDO_TAG, imageFallback = FPL_MUNDO_PLACEHOLDER_IMAGE } = {}) {
  const html = await fetchRenderedHtml(url);
  const sections = extractSectionsFromHtml(html, url);

  const results = [];
  for (const sec of sections) {
    const payload = {
      title: sec.title,
      excerpt: sec.excerpt || "",
      image_url: sec.image_url || imageFallback,
      content_markdown: sec.content_markdown,
      tags: Array.isArray(tag) ? tag : [tag],
      author: "FPL Mundo",
    };
    try {
      const posted = await postNews(payload);
      results.push({ ok: true, id: posted.id, title: payload.title });
    } catch (e) {
      results.push({ ok: false, error: extractError(e), title: payload.title });
    }
  }
  return { sections, results };
}


async function fetchFplMundoArticle(url) {
  // 1) try a fully rendered HTML (Puppeteer stealth)
  let html = "";
  if (puppeteerExtra) {
    try {
      html = await renderWithPuppeteer(url);
    } catch (_) { /* fall through */ }
  }

  // 2) try plain HTTP if puppeteer failed or returned nothing useful
  if (!html || html.length < 2000) {
    try {
      const res = await axios.get(url, {
        timeout: 20000,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9"
        },
        transformResponse: [r => r],
        validateStatus: s => s >= 200 && s < 400,
      });
      html = res.data || "";
    } catch (_) { /* fall through */ }
  }

  // 3) as a last resort, use a lightweight prerender proxy (text only)
  if (!html || html.length < 2000 || /__cf|just a moment|cloudflare/i.test(html)) {
    try {
      const proxyUrl = `https://r.jina.ai/https://www.fplmundo.com/${url.split("/").pop()}`;
      const { data: text } = await axios.get(proxyUrl, { timeout: 20000 });
      if (String(text || "").trim().length > 500) {
        const title = `FPL Mundo League ${url.split("/").pop()}`;
        return {
          title,
          excerpt: String(text).slice(0, 500),
          markdown: `${text}\n\n[Read the original on FPL Mundo](${url})`,
          image_url: null,
        };
      }
    } catch (_) { /* give up after this */ }
  }

  if (!html || html.length < 500) {
    throw new Error("Could not retrieve meaningful content from FPL Mundo.");
  }

  // ---- Parse article with Readability + Turndown ----
  const { article, og } = parseArticleWithReadability(html, url);
  const td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });

  // Preserve bold/italics/links/lists, strip scripts/styles
  td.addRule("keepStrongEm", {
    filter: ["strong", "b", "em", "i", "a", "ul", "ol", "li", "h1", "h2", "h3", "h4", "h5", "h6"],
    replacement: (content) => content,
  });

  const contentHtml = article?.content || preferArticleSection(html) || "";
  const markdown = td.turndown(contentHtml).trim();
  const title = (article?.title || extractTitleFromHtml(html) || "Review").trim();
  const excerpt = (article?.excerpt || htmlToText(contentHtml).slice(0, 600)).trim();

  // Pick best image: article first image → og:image → placeholder
  const firstImage = extractFirstImage(contentHtml, url);
  const image_url = normalizeUrl(firstImage || og?.image || null) || null;

  return {
    title,
    excerpt,
    markdown: `${markdown}\n\n[Read the original on FPL Mundo](${url})`,
    image_url,
  };
}

/* ---------- helpers used above ---------- */

// Headless render with stealth: click consent if present; wait for content.
async function renderWithPuppeteer(url) {
  const browser = await puppeteerExtra.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-features=site-per-process",
    ],
  });
  try {
    const page = await browser.newPage();

    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    );

    // block heavy assets for speed (keep images: we want hero URL to exist in DOM)
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const rtype = req.resourceType();
      if (["stylesheet", "font"].includes(rtype)) return req.abort();
      req.continue();
    });

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

    // consent banner(s)
    await clickLikelyConsent(page);

    // wait for something meaningful in the article area
    await page.waitForFunction(() => {
      const body = document.body?.innerText || "";
      const hasText = body.replace(/\s+/g, " ").length > 2000;
      const hasArticle = !!document.querySelector("article, main");
      return hasText && hasArticle;
    }, { timeout: 25000 }).catch(() => {});

    // small settle
    await page.waitForTimeout(500);

    const html = await page.evaluate(() => document.documentElement.outerHTML);
    return html || "";
  } finally {
    await browser.close().catch(()=>{});
  }
}

async function clickLikelyConsent(page) {
  const selectors = [
    'button[aria-label*="accept"]',
    'button:has-text("Accept")',
    'button:has-text("Agree")',
    'button:has-text("Allow all")',
    '[id*="accept"]',
    '[id*="agree"]',
    '[data-testid*="accept"]',
  ];
  for (const sel of selectors) {
    try {
      const btn = await page.$(sel);
      if (btn) { await btn.click(); await page.waitForTimeout(300); return; }
    } catch (_) {}
  }
}

// Prefer the <article> or <main> section when Readability fails
function preferArticleSection(html) {
  const $ = cheerio.load(html);
  const $art = $("article").first();
  if ($art.length) return $art.html() || "";
  const $main = $("main").first();
  if ($main.length) return $main.html() || "";
  return $("body").html() || "";
}

function parseArticleWithReadability(html, baseUrl) {
  const dom = new JSDOM(html, { url: baseUrl });
  const doc = dom.window.document;

  // OG hints
  const og = {
    title: doc.querySelector('meta[property="og:title"]')?.content || "",
    image: absolutize(doc.querySelector('meta[property="og:image"]')?.content || "", baseUrl),
  };

  // Strip scripts/styles for cleaner parse
  doc.querySelectorAll("script,style,noscript").forEach(n => n.remove());

  const reader = new Readability(doc, { keepClasses: false });
  const article = reader.parse(); // {title, content, textContent, excerpt}

  return { article, og };
}

function absolutize(u, base) {
  if (!u) return "";
  try { return new URL(u, base).toString(); } catch { return u; }
}

function extractFirstImage(html, baseUrl) {
  try {
    const $ = cheerio.load(html);
    const src =
      $("img[src]").first().attr("src") ||
      $("source[srcset]").first().attr("srcset")?.split(",")[0]?.trim().split(" ")[0] ||
      "";
    return src ? absolutize(src, baseUrl) : "";
  } catch { return ""; }
}



// Compute ms until next weekly time in a TZ (Tue=2) using the “offset trick”
function msUntilNextWeekly(weekday /*0-6*/, hour, minute, tz) {
  const now = new Date();
  const tzNow = new Date(now.toLocaleString("en-US", { timeZone: tz }));
  const offset = tzNow.getTime() - now.getTime(); // tz offset vs server clock

  const target = new Date(tzNow);
  const day = target.getDay();
  let addDays = (weekday - day + 7) % 7;
  // if it's today but time already passed, push a week
  const alreadyPassed =
    addDays === 0 &&
    (target.getHours() > hour ||
      (target.getHours() === hour && target.getMinutes() >= minute));
  if (alreadyPassed) addDays = 7;

  target.setDate(target.getDate() + addDays);
  target.setHours(hour, minute, 0, 0);

  const realTarget = new Date(target.getTime() - offset);
  return Math.max(0, realTarget.getTime() - now.getTime());
}

function scheduleWeeklyInTz(label, weekday, hour, minute, tz, fn) {
  const scheduleNext = () => {
    const ms = msUntilNextWeekly(weekday, hour, minute, tz);
    console.log(`[${label}] next run in ${Math.round(ms / 1000 / 60)} min`);
    setTimeout(async () => {
      try {
        await fn();
      } catch (e) {
        console.log(`[${label}] job error:`, e?.message || e);
      } finally {
        // recompute to handle DST changes
        scheduleNext();
      }
    }, ms);
  };
  scheduleNext();
}

// ---- DAILY scheduler in a specific TZ (DST-safe) ----
function msUntilNextDaily(hour, minute, tz) {
  const now = new Date();
  const tzNow = new Date(now.toLocaleString("en-US", { timeZone: tz }));
  const offset = tzNow.getTime() - now.getTime();

  const target = new Date(tzNow);
  target.setHours(hour, minute, 0, 0);
  if (target <= tzNow) target.setDate(target.getDate() + 1);

  const realTarget = new Date(target.getTime() - offset);
  return Math.max(0, realTarget.getTime() - now.getTime());
}

function scheduleDailyInTz(label, hour, minute, tz, fn) {
  const scheduleNext = () => {
    const ms = msUntilNextDaily(hour, minute, tz);
    console.log(`[${label}] next run in ${Math.round(ms / 60000)} min`);
    setTimeout(async () => {
      try {
        await fn();
      } catch (e) {
        console.log(`[${label}] job error:`, e?.message || e);
      } finally {
        scheduleNext(); // re-schedule (handles DST shifts too)
      }
    }, ms);
  };
  scheduleNext();
}

// ---- schedule a function at multiple local times each day (DST-safe) ----
function scheduleAtLocalTimes(label, times /* ["HH:MM", ...] */, tz, fn) {
  const parseHM = (s) => {
    const [h, m] = String(s).split(":").map(n => parseInt(n, 10));
    return [Number.isFinite(h) ? h : 0, Number.isFinite(m) ? m : 0];
  };

  const msUntilNext = () => {
    const now = new Date();
    const tzNow = new Date(now.toLocaleString("en-US", { timeZone: tz }));
    const offset = tzNow.getTime() - now.getTime();

    // build today candidates
    const cands = [];
    for (const t of times) {
      const [h, m] = parseHM(t);
      const targetLocal = new Date(tzNow);
      targetLocal.setHours(h, m, 0, 0);
      if (targetLocal > tzNow) {
        cands.push(new Date(targetLocal.getTime() - offset));
      }
    }
    // if none left today, take the earliest tomorrow
    if (!cands.length) {
      const [h0, m0] = parseHM(times[0]);
      const tomorrowLocal = new Date(tzNow);
      tomorrowLocal.setDate(tomorrowLocal.getDate() + 1);
      tomorrowLocal.setHours(h0, m0, 0, 0);
      cands.push(new Date(tomorrowLocal.getTime() - offset));
    }

    const next = cands.sort((a, b) => a - b)[0];
    return Math.max(0, next.getTime() - now.getTime());
  };

  const loop = () => {
    const ms = msUntilNext();
    console.log(`[${label}] next run in ${Math.round(ms/60000)} min`);
    setTimeout(async () => {
      try {
        await fn();
      } catch (e) {
        console.log(`[${label}] job error:`, e?.message || e);
      } finally {
        loop(); // schedule the next occurrence
      }
    }, ms);
  };
  loop();
}

function schedulePredictedFixedTimesPT(channel, times = (process.env.PREDICTED_LOCAL_TIMES || "08:00,11:00,15:30,17:30,18:00"), tz = "America/Los_Angeles") {
  const list = String(times).split(",").map(s => s.trim()).filter(Boolean);
  scheduleAtLocalTimes("Predicted Prices", list, tz, async () => {
    await postPredictedIfChanged(channel);
  });
}




// Post both Premier & Championship weekly FPL Mundo articles
async function postWeeklyFplMundoArticles() {
  const gw = await getLatestFinishedGwNumber();

  const [prem, champ] = await Promise.all([
    fetchFplMundoArticle(FPL_MUNDO_PREMIER_URL).catch(() => null),
    fetchFplMundoArticle(FPL_MUNDO_CHAMP_URL).catch(() => null),
  ]);

  // Title shape: "GW# Review: <FPL Mundo Title> (Premier/Championship)"
  if (prem) {
    const title = `GW${gw ?? "?"} Review: ${prem.title} (Premier)`;
    await postNews({
      title,
      excerpt: prem.excerpt,
      image_url: FPL_MUNDO_PLACEHOLDER_IMAGE,
      content_markdown: prem.markdown,
      tags: [FPL_MUNDO_TAG],
    }).catch(e => console.log("postNews (prem) failed:", e?.message || e));
  }

  if (champ) {
    const title = `GW${gw ?? "?"} Review: ${champ.title} (Championship)`;
    await postNews({
      title,
      excerpt: champ.excerpt,
      image_url: FPL_MUNDO_PLACEHOLDER_IMAGE,
      content_markdown: champ.markdown,
      tags: [FPL_MUNDO_TAG],
    }).catch(e => console.log("postNews (champ) failed:", e?.message || e));
  }

  console.log("FPL Mundo weekly posts completed.");
}

// Config for list mode
const MUNDO_MAX_LINKS = parseInt(process.env.MUNDO_MAX_LINKS || "4", 10);

// Pick likely post/article links from the league hub page
function extractPostLinksFromLeaguePage(html, baseUrl) {
  const $ = cheerio.load(html);
  const base = new URL(baseUrl);
  const seen = new Set();
  const out = [];

  // Prefer anchors in “contenty” areas first
  const candidates = [
    'main a[href]',
    'article a[href]',
    '.card a[href]',
    'section a[href]',
    'h1 a[href], h2 a[href], h3 a[href]'
  ].join(',');

  $(candidates).each((_, a) => {
    const raw = ($(a).attr('href') || '').trim();
    if (!looksLikeArticleLink(raw)) return;

    const url = absUrl(raw, baseUrl);
    if (!url) return;

    let u;
    try { u = new URL(url); } catch { return; }

    // Skip exact self and pure-hash
    const isSelf = u.href.replace(/\/+$/, '') === baseUrl.replace(/\/+$/, '');
    if (isSelf) return;
    if (u.hash && !u.pathname.replace(/\/+$/, '')) return;

    // Deduplicate by origin+path (strip trailing slash)
    const key = (u.origin + u.pathname).replace(/\/+$/, '');
    if (seen.has(key)) return;
    seen.add(key);

    // Heuristic score: posts/reviews/GW, numbers in path/text, etc.
    const text = ($(a).text() || $(a).attr('aria-label') || '').trim();
    const score =
      (/post|article|review|gw|gameweek|preview|recap|results/i.test(u.pathname) ? 5 : 0) +
      (/\d{2,4}/.test(u.pathname) || /\bGW\s*\d+\b/i.test(text) ? 2 : 0) +
      (/(read more|share story)/i.test(text) ? 1 : 0);

    const title =
      text ||
      $(a).closest('article, .card, section').find('h1,h2,h3').first().text().trim() ||
      u.hostname;

    out.push({ url: u.toString(), title, score });
  });

  // Fallback: if none matched, scan all anchors with the same heuristics
  if (!out.length) {
    $('a[href]').each((_, a) => {
      const raw = ($(a).attr('href') || '').trim();
      if (!looksLikeArticleLink(raw)) return;
      const url = absUrl(raw, baseUrl);
      if (!url) return;
      let u; try { u = new URL(url); } catch { return; }

      const isSelf = u.href.replace(/\/+$/, '') === baseUrl.replace(/\/+$/, '');
      if (isSelf) return;
      if (u.hash && !u.pathname.replace(/\/+$/, '')) return;

      const key = (u.origin + u.pathname).replace(/\/+$/, '');
      if (seen.has(key)) return;
      seen.add(key);

      const text = ($(a).text() || $(a).attr('aria-label') || '').trim();
      const score =
        (/post|article|review|gw|gameweek|preview|recap|results/i.test(u.pathname) ? 5 : 0) +
        (/\d{2,4}/.test(u.pathname) || /\bGW\s*\d+\b/i.test(text) ? 2 : 0);

      out.push({ url: u.toString(), title: text || u.hostname, score });
    });
  }

  // Sort by score (desc), keep DOM order as tiebreaker via original index
  const scored = out.map((o, i) => ({ ...o, i })).sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.i - b.i;
  });

  const top = scored.slice(0, MUNDO_MAX_LINKS).map(({ url, title }) => ({ url, title }));
  if (top.length) return top;

  // 🔧 Regex fallback (works on Jina text proxy output)
  debugLog("extractPostLinksFromLeaguePage: regex fallback");
  const htmlStr = String($.root().html() || "");
  //const base = new URL(baseUrl);

  const out1 = new Set();

  // Absolute like https://www.fplmundo.com/723566
  for (const m of htmlStr.matchAll(/https?:\/\/(?:www\.)?fplmundo\.com\/(\d{5,9})(?!\d)/gi)) {
    out1.add(`${base.origin}/${m[1]}`);
    if (out1.size >= MUNDO_MAX_LINKS) break;
  }

  // Relative like /723566
  if (out1.size < MUNDO_MAX_LINKS) {
    for (const m of htmlStr.matchAll(/(^|[^a-z0-9/_-])\/(\d{5,9})(?!\d)/gi)) {
      out1.add(`${base.origin}/${m[2]}`);
      if (out1.size >= MUNDO_MAX_LINKS) break;
    }
  }

  const final = Array.from(out1).slice(0, MUNDO_MAX_LINKS).map(u => ({ url: u, title: u }));
  debugLog("extractPostLinksFromLeaguePage:return:regex", final);
  return final;

  // // Return the top N (env: MUNDO_MAX_LINKS, default 4)
  // return scored.slice(0, MUNDO_MAX_LINKS).map(({ url, title }) => ({ url, title }));
}


// Open the league page, extract post links, fetch each post, and publish
async function publishFplMundoFromList(leagueUrl, {
  tag = FPL_MUNDO_TAG,
  imageFallback = FPL_MUNDO_PLACEHOLDER_IMAGE,
  max = MUNDO_MAX_LINKS,
  dryrun = false,
} = {}) {
  const html = await fetchRenderedHtml(leagueUrl);
  let links = extractPostLinksFromLeaguePage(html, leagueUrl).slice(0, max);

  // 🔧 Fallback: if the page came from the text proxy (no anchors), reuse our regex collector
  if (!links.length) {
    debugLog("publishFplMundoFromList: no anchors → trying regex fallback");
    const regexLinks = collectMundoArticleLinks(html, leagueUrl, max) || [];
    links = regexLinks.map(u => ({ url: u, title: u })); // adapt to the shape we expect
  }

  if (!links.length) {
    debugLog("publishFplMundoFromList: still no links after fallback");
    return { links: [], results: [], reason: "no-links" };
  }


  const results = [];
  for (const { url } of links) {
    try {
      const art = await fetchFplMundoArticle(url); // uses Readability+Turndown
      if (!art?.markdown || art.markdown.length < 300) {
        results.push({ ok: false, title: art?.title || url, error: "too-short-or-empty" });
        continue;
      }
      if (dryrun) {
        results.push({ ok: true, title: art.title, id: null, dryrun: true });
        continue;
      }
      const posted = await postNews({
        title: art.title,
        excerpt: art.excerpt || "",
        image_url: art.image_url || imageFallback,
        content_markdown: art.markdown,
        tags: [tag],
        author: "FPL Mundo",
      });
      results.push({ ok: true, id: posted.id, title: art.title });
      // polite tiny pause (Cloudflare friendliness)
      await new Promise(r => setTimeout(r, 300));
    } catch (e) {
      results.push({ ok: false, title: url, error: extractError(e) });
    }
  }

  return { links, results };
}


// Public function to kick off our weekly schedule (Tue 7:00 AM PT)
function scheduleWeeklyFplMundoPosts() {
  // Tuesday = 2
  scheduleWeeklyInTz("FPL Mundo Weekly", 2, 7, 0, "America/Los_Angeles", postWeeklyFplMundoArticles);
}



// ===== Rivalries support =====
const fs = require?.("fs");
const RIVALRIES_FILE = process.env.RIVALRIES_FILE;       // rivalry json file
let RIVALRIES = [];                                      // [{league?, a_owner?, b_owner?, a_team?, b_team?, label?, reason?}]

function normalizeStr(x){ return String(x||"").trim().toLowerCase(); }

function loadRivalriesSync() {
  try {
    if (RIVALRIES_FILE && fs && fs.existsSync(RIVALRIES_FILE)) {
      const txt = fs.readFileSync(RIVALRIES_FILE, "utf-8");
      const arr = JSON.parse(txt);
      if (Array.isArray(arr)) RIVALRIES = arr;
    }
    if (!Array.isArray(RIVALRIES)) RIVALRIES = [];
    console.log(`Loaded ${RIVALRIES.length} rivalries.`);
  } catch (e) {
    console.log("Failed to load rivalries:", e?.message || e);
  }
}

function rivalryMatches(league, a, b) {
  // Returns {label, reason} if a/b forms a rivalry row (owner or team match), else null
  const la = league && normalizeStr(league);
  const ao = normalizeStr(a.owner), at = normalizeStr(a.team);
  const bo = normalizeStr(b.owner), bt = normalizeStr(b.team);
  for (const r of RIVALRIES) {
    if (r.league && normalizeStr(r.league) !== la) continue;
    const ra = {ao: normalizeStr(r.a_owner), at: normalizeStr(r.a_team)};
    const rb = {bo: normalizeStr(r.b_owner), bt: normalizeStr(r.b_team)};
    const matchAB = ((ra.ao && ra.ao===ao) || (ra.at && ra.at===at)) &&
                    ((rb.bo && rb.bo===bo) || (rb.bt && rb.bt===bt));
    const matchBA = ((rb.bo && rb.bo===ao) || (rb.bt && rb.bt===at)) &&
                    ((ra.ao && ra.ao===bo) || (ra.at && ra.at===bt));
    if (matchAB || matchBA) {
      return { label: r.label || "Rivalry match!", reason: r.reason || "Historic grudge match." };
    }
  }
  return null;
}

function rememberPreviews(league, gw, picks) {
  if (!__LAST_PREVIEWS[league]) __LAST_PREVIEWS[league] = {};
  // store simplified fixture-like objects for matching later
  __LAST_PREVIEWS[league][gw] = picks.map(p => ({
    aTeam: p.pair[0].team,
    bTeam: p.pair[1].team,
    aOwner: p.pair[0].owner,
    bOwner: p.pair[1].owner
  }));
}

// ===== League preview helpers =====
const LEAGUES = (process.env.LEAGUES || "premier,championship")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

let MANAGER_MAP = {};
try {
  if (process.env.MANAGER_DISCORD_MAP) {
    MANAGER_MAP = JSON.parse(process.env.MANAGER_DISCORD_MAP);
  }
} catch (_) {}

function mentionForOwner(owner) {
  const id = MANAGER_MAP[owner];
  return id ? `<@${id}>` : owner;
}

async function fetchFplH2HStandingsAllPages(leagueId) {
  const base = `https://fantasy.premierleague.com/api/leagues-h2h/${leagueId}/standings/`;
  let page = 1, out = [], hasNext = true;

  while (hasNext) {
    const url = `${base}?page=${page}`;
    const { data } = await axios.get(url, { timeout: 15000 });
    const chunk = data?.standings?.results || [];
    out = out.concat(chunk);
    hasNext = !!data?.standings?.has_next;
    page += 1;
  }
  return out; // array of rows with entry_name, player_name, total, wins/losses/draws, etc.
}


// Try multiple endpoints to fetch league tables; return [] on failure
async function fetchLeagueTable(league) {
  const urls = [];
  const envKey = `LEAGUE_TABLE_ENDPOINT_${league.toUpperCase()}`;

  if (process.env[envKey]) {
    urls.push(process.env[envKey]);
    console.log("inside if - ", process.env[envKey]);
  }
  console.log("after if - ", urls);

  // Try backend then site fallbacks
  urls.push(
    `${BASE}/standings?league=${league}`,
    `${BASE}/league/${league}`,
    `${BASE}/${league}`,
    `${SITE_BASE}/api/${league}`
  );
  console.log("outside if - ", urls);

  for (const u of urls) {
    try {
      // Special-case: direct FPL H2H endpoint(s)
      if (/fantasy\.premierleague\.com\/api\/leagues-h2h\/\d+\/standings/i.test(u)) {
        const leagueId = (u.match(/leagues-h2h\/(\d+)\/standings/i) || [])[1];
        if (leagueId) {
          const all = await fetchFplH2HStandingsAllPages(leagueId);
          if (all.length) return all;
        }
      }

      const { data } = await axios.get(u, { timeout: 15000 });

      // Unified shape extraction (now includes FPL's shape):
      const arr =
        Array.isArray(data) ? data :
        Array.isArray(data?.rows) ? data.rows :
        Array.isArray(data?.data?.rows) ? data.data.rows :
        Array.isArray(data?.standings?.results) ? data.standings.results : // <-- FPL H2H
        (data?.teams || data?.table || []);

      console.log("arr - ", Array.isArray(arr) ? arr.length : typeof arr);
      if (Array.isArray(arr) && arr.length) return arr;
    } catch (e) {
      // try next URL
    }
  }
  return [];
}


// Basic normalize to known fields
function normalizeTeams(rows) {
  return rows.map((r, i) => {
    const position =
      Number(r.Position ?? r.position ?? r.rank ?? i + 1);

    // Add FPL H2H names
    const team =
      r.Team ?? r.team ?? r.team_name ?? r.entry_name ?? r.name ?? "Unknown Team";

    const owner =
      r.Owner ?? r.owner ?? r.manager ?? r.owner_name ?? r.player_name ?? r.user ?? r.coach ?? "Unknown";

    // Map season total and H2H points correctly
    const totalScore =
      Number(r.Score ?? r.total_score ?? r.points_for ?? r.season_points ?? 0);

    const h2hPoints =
      Number(r.Points ?? r.points ?? r.h2h_points ?? r.h2h ?? r.total ?? 0);

    const value =
      Number(r["Current Team Value"] ?? r.value ?? r.team_value ?? 0);

    const recent = r.form || r.recent || "";

    return { position, team, owner, totalScore, h2hPoints, value, recent };
  }).sort((a, b) => a.position - b.position);
}

// Heuristic "drama" scoring and pairing (not actual fixtures)
function selectDramaticMatchups(teams, {league, fixtures, gw} = {}) {
  console.log("teams lengthj", teams.length);
  if (teams.length < 6) return [];

  // If fixtures are available for the upcoming GW, score actual pairings.
  if (Array.isArray(fixtures) && fixtures.length) {
    const byName = {};
    for (const t of teams) {
      byName[normalizeStr(t.owner)] = t;
      byName[normalizeStr(t.team)] = t;
    }
    const scored = [];
    for (const fx of fixtures) {
      const { aOwner, bOwner, aTeam, bTeam } = normalizeFixture(fx);
      const a = byName[normalizeStr(aOwner)] || byName[normalizeStr(aTeam)];
      const b = byName[normalizeStr(bOwner)] || byName[normalizeStr(bTeam)];
      if (!a || !b) continue;
      // Drama score: closeness in H2H + sum of totalScore + rivalry bonus + table zone bonus
      let score = 0;
      const h2hGap = Math.abs((a.h2hPoints||0)-(b.h2hPoints||0));
      score += 100 - Math.min(100, h2hGap);
      score += (a.totalScore + b.totalScore)/1000;
      // Zone bonus: top6/mid/bottom proximity
      if (a.position<=6 && b.position<=6) score += 25;
      if (a.position>=teams.length-4 && b.position>=teams.length-4) score += 20; // relegation tension
      // Rivalry bonus
      const riv = rivalryMatches(league, a, b);
      if (riv) score += 100; // big boost
      scored.push({ a, b, score, riv });
    }
    scored.sort((x,y)=>y.score-x.score);
    const picks = [];
    const used = new Set();
    for (const s of scored) {
      const key = s.a.team+"|"+s.b.team;
      if (used.has(key)) continue;
      used.add(key);
      const reason = s.riv
        ? s.riv.reason
        : (s.a.position<=6 && s.b.position<=6
            ? "It's all to play for between two teams pushing for a place in Europe."
            : (s.a.position>=teams.length-4 && s.b.position>=teams.length-4
                ? "A six point swing matters all the more when you're facing the drop!"
                : "Not much between two teams trying to build momentum!"));
      picks.push({ pair:[s.a,s.b], label: `Matchup ${picks.length+1}`, reason });
      if (picks.length>=3) break;
    }
    return picks;
  }


  // Helper: neighbor pairs by position
  const neighbors = [];
  for (let i=0;i<teams.length-1;i++) {
    neighbors.push([teams[i], teams[i+1]]);
  }

  function diff(a,b, key) { return Math.abs((a[key]||0)-(b[key]||0)); }

  // Title chase: best pair among top 6 with close h2h and high total score
  const top6 = teams.slice(0, Math.min(6, teams.length));
  let titlePair = null, titleScore = -1;
  for (let i=0;i<top6.length-1;i++) {
    const a=top6[i], b=top6[i+1];
    const score = 100 - diff(a,b,'h2hPoints') + (a.totalScore + b.totalScore)/1000;
    if (score > titleScore) { titleScore = score; titlePair = [a,b]; }
  }

  // Mid-table thriller: pick pair around positions 8–12 with smallest totalScore diff
  const midStart = Math.min(7, Math.max(0, Math.floor(teams.length/2)-2));
  const midSlice = teams.slice(midStart, Math.min(midStart+6, teams.length));
  let midPair = null, midScore = 1e9;
  for (let i=0;i<midSlice.length-1;i++) {
    const a=midSlice[i], b=midSlice[i+1];
    const d = diff(a,b,'totalScore');
    if (d < midScore) { midScore = d; midPair = [a,b]; }
  }

  // Relegation battle: last 5, closest h2h points
  const bottom = teams.slice(-5);
  let relPair = null, relScore = 1e9;
  for (let i=0;i<bottom.length-1;i++) {
    const a=bottom[i], b=bottom[i+1];
    const d = diff(a,b,'h2hPoints');
    if (d < relScore) { relScore = d; relPair = [a,b]; }
  }

  const unique = [];
  const used = new Set();
  function add(pair,label,reason) {
    const key = pair.map(t=>t.team).join("|");
    if (used.has(key)) return;
    used.add(key);
    unique.push({ pair, label, reason });
  }


  if (titlePair) add(titlePair, "Matchup 1", "Top-of-the-table clash: separated by tiny H2H points.");
  if (midPair) add(midPair, "Matchup 2", "Neck-and-neck in the mid table — almost identical season totals!");
  if (relPair) add(relPair, "Matchup 3", "Six-pointer Survival — separated by only a whisker near the drop.");
 
  // If any missing, fill from remaining neighbor pairs with smallest h2h diff
  if (unique.length < 3) {
    const byDiff = neighbors
      .filter(p => !used.has(p.map(t=>t.team).join("|")))
      .map(p => ({ p, d: diff(p[0],p[1],'h2hPoints') }))
      .sort((a,b)=>a.d-b.d);
    for (const {p} of byDiff) {
      add(p, `Matchup ${unique.length+1}`, "Tighter than Eden Hazard's shorts!");
      if (unique.length >= 3) break;
    }
  }

  return unique.slice(0,3);
}

function formatPreviewMessage(league, evId, matchups) {
  const eye = "👀";
  let lines = [];
  lines.push(`${eye} GW ${evId} PREVIEWS: ${league[0].toUpperCase()+league.slice(1)} ${eye}`);
  matchups.forEach((m, idx) => {
    const [a,b] = m.pair;
    const aMent = mentionForOwner(a.owner);
    const bMent = mentionForOwner(b.owner);
    lines.push(`\nMatchup ${idx+1}:\n${a.team} (${aMent}) [${a.position}]  vs  ${b.team} (${bMent}) [${b.position}]`);
    lines.push(`${m.reason}`);
  });
  return lines.join("\n");
}

function formatInTZ(date, tz) {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(date);
  } catch (_) {
    return date.toISOString();
  }
}

// ===== Deadline reminders (FPL deadlines) =====
const REMINDER_CHANNEL_ID = process.env.DEADLINE_CHANNEL_ID;
const TZ = process.env.TZ || "America/Los_Angeles";

async function getNextFplEvent() {
  const { data } = await axios.get("https://fantasy.premierleague.com/api/bootstrap-static/");
  const now = new Date();
  const events = data?.events || [];
  const upcoming = events
    .filter(e => e.deadline_time && new Date(e.deadline_time) > now)
    .sort((a, b) => new Date(a.deadline_time) - new Date(b.deadline_time));
  return upcoming[0] || null;
}

let __scheduledTimeouts = [];
let __LAST_PREVIEWS = {};
let __LAST_SUMMARY_POSTED_GW = null; // { [league]: { [gw]: [{aTeam,bTeam,aOwner,bOwner}] } }
function clearReminders() {
  for (const t of __scheduledTimeouts) clearTimeout(t);
  __scheduledTimeouts = [];
}




// ===== Fixtures fetcher (optional) =====
// Provide env LEAGUE_FIXTURES_ENDPOINT_<LEAGUE> or LEAGUE_FIXTURES_ENDPOINT (global)
// Endpoint should return an array of fixtures like:
// [{home_owner, away_owner}] or [{home_team, away_team}] or generic {a_owner,b_owner,a_team,b_team}
const DEFAULT_FPL_H2H_IDS = { premier: "723566", championship: "850022" };
async function fetchFixtures(league, gw) {
  // ---- tiny helpers (scoped) ----
  const https = require("https");
  const http = require("http");

  const DEFAULT_UA =
    process.env.FPL_USER_AGENT ||
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36";

  const BASE_HEADERS = {
    "User-Agent": DEFAULT_UA,
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.8",
    "Connection": "keep-alive",
  };

  const keepAliveAgent = {
    httpAgent: new http.Agent({ keepAlive: true, maxSockets: 50 }),
    httpsAgent: new https.Agent({ keepAlive: true, maxSockets: 50 }),
  };

  const RETRYABLE = new Set([429, 500, 502, 503, 504]);
  const MAX_RETRIES = Number(process.env.HTTP_MAX_RETRIES || 4);
  const BASE_DELAY_MS = Number(process.env.HTTP_BASE_DELAY_MS || 350);
  const RATE_LIMIT_MS = Number(process.env.FPL_RATE_LIMIT_MS || 250);

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
  function jitter(ms) { return ms + Math.floor(Math.random() * 120); }

  function parseSetCookieToCookieHeader(setCookieArr = []) {
    try {
      const cookies = [];
      for (const raw of setCookieArr) {
        const nv = String(raw).split(";")[0].trim();
        if (nv && nv.includes("=")) cookies.push(nv);
      }
      return cookies.join("; ");
    } catch {
      return "";
    }
  }

  async function warmUpFplAndGetCookies() {
    try {
      const res = await axios.get("https://fantasy.premierleague.com/", {
        ...keepAliveAgent,
        timeout: 10000,
        headers: {
          ...BASE_HEADERS,
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
        validateStatus: () => true,
      });
      const setCookie = res.headers?.["set-cookie"];
      return Array.isArray(setCookie) ? parseSetCookieToCookieHeader(setCookie) : "";
    } catch {
      return "";
    }
  }

  async function getWithRetries(url, { headers = {}, timeout = 15000, params, referer, origin, useFplWarmup } = {}) {
    let lastErr;
    let cachedCookie = ""; // only warm once per call-chain

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const hdrs = { ...BASE_HEADERS, ...(globalThis.API_HEADERS || {}), ...headers };
        if (origin) hdrs["Origin"] = origin;
        if (referer) hdrs["Referer"] = referer;
        if (cachedCookie) hdrs["Cookie"] = cachedCookie;

        const res = await axios.get(url, {
          headers: hdrs,
          timeout,
          params,
          ...keepAliveAgent,
        });
        return res;
      } catch (e) {
        const status = e?.response?.status;
        const msg = e?.message || String(e);
        const retryable = status ? RETRYABLE.has(status) : true;

        if (!cachedCookie && useFplWarmup && retryable) {
          cachedCookie = await warmUpFplAndGetCookies();
        }

        if (attempt < MAX_RETRIES && retryable) {
          let delay = BASE_DELAY_MS * Math.pow(2, attempt);
          const ra = e?.response?.headers?.["retry-after"];
          if (ra) {
            const sec = Number(ra);
            if (!Number.isNaN(sec) && sec > 0) delay = Math.max(delay, sec * 1000);
          }
          delay = jitter(delay);
          console.log(`[retry ${attempt + 1}/${MAX_RETRIES}] GET ${url} failed (${status || "no-status"}: ${msg}); waiting ${delay}ms`);
          await sleep(delay);
          lastErr = e;
          continue;
        }
        throw e;
      }
    }
    throw lastErr || new Error(`Failed to GET ${url}`);
  }
  // ---- end helpers ----

  // 1) Try env-configured endpoints first
  const urls = [];
  const key = `LEAGUE_FIXTURES_ENDPOINT_${String(league).toUpperCase()}`; // e.g., PREMIER / CHAMPIONSHIP
  if (process.env[key]) urls.push(process.env[key]);
  if (process.env.LEAGUE_FIXTURES_ENDPOINT) urls.push(process.env.LEAGUE_FIXTURES_ENDPOINT);

  const hydrate = (u) => u
    .replace(/\{gw\}/g, String(gw))
    .replace(/\{league\}/g, String(league));

  for (let baseUrl of urls) {
    try {
      const u = hydrate(baseUrl);
      const { data } = await getWithRetries(u, { headers: (globalThis.API_HEADERS || {}) });
      const arr = Array.isArray(data) ? data : (data?.fixtures || data?.matches);
      if (Array.isArray(arr) && arr.length) {
        return arr;
      }
      console.log(`[fixtures] ${u} responded but no fixtures array found (keys: ${Object.keys(data || {}).join(",")})`);
    } catch (e) {
      console.log(`[fixtures] Env endpoint failed (${baseUrl}) →`, e?.response?.status || "", e?.message || e);
    }
  }

  // 2) Fallback to official FPL H2H endpoint with warm-up, cookies, referer/origin
  // league may be an alias; prefer numeric id from env if provided
  const leagueId = Number(process.env[`FPL_H2H_ID_${String(league).toUpperCase()}`] || league);
  //if (!Number.isFinite(leagueId)) {
  //  console.log(`[fixtures] Invalid league id for fallback: "${league}" → set FPL_H2H_ID_${String(league).toUpperCase()} or pass numeric id`);
  //  return [];
  //}

  const base = `https://fantasy.premierleague.com/api/leagues-h2h-matches/league/${leagueId}/`;
  let page = 1;
  const fixtures = [];

  try {
    while (true) {
      const url = `${base}?page=${page}&event=${gw}`;
      const referer = `https://fantasy.premierleague.com/leagues/${leagueId}/matches?event=${gw}`;
      const origin = "https://fantasy.premierleague.com";

      const { data } = await getWithRetries(url, {
        referer,
        origin,
        useFplWarmup: true,
      });

      const arr = data?.results || data?.matches || data?.fixtures || [];
      for (const fx of arr) {
        fixtures.push({
          a_owner: fx.entry_1_player_name,
          b_owner: fx.entry_2_player_name,
          a_team:  fx.entry_1_name,
          b_team:  fx.entry_2_name,
          a_points: fx.entry_1_points ?? fx.points_a ?? fx.total_points_a ?? null,
          b_points: fx.entry_2_points ?? fx.points_b ?? fx.total_points_b ?? null,
        });
      }

      const hasNext =
        Boolean(data?.has_next) ||
        Boolean(data?.standings?.has_next) ||
        Boolean(data?.matches?.has_next) ||
        false;

      if (!hasNext) break;
      page += 1;
      if (page > 50) break; // safety
      if (RATE_LIMIT_MS > 0) await sleep(RATE_LIMIT_MS);
    }

    if (fixtures.length) return fixtures;
  } catch (e) {
    console.log("FPL H2H fixtures fetch failed:", e?.response?.status || "", e?.message || e);
  }

  return [];
}


function normalizeFixture(fx) {
  const aOwner = fx.home_owner || fx.a_owner || fx.owner_a || fx.owner1 || fx.home_manager;
  const bOwner = fx.away_owner || fx.b_owner || fx.owner_b || fx.owner2 || fx.away_manager;
  const aTeam  = fx.home_team  || fx.a_team  || fx.team_a  || fx.team1  || fx.home;
  const bTeam  = fx.away_team  || fx.b_team  || fx.team_b  || fx.team2  || fx.away;
  return { aOwner, bOwner, aTeam, bTeam };
}

async function summarizePreviousGW(league, prevGw) {
  const fixtures = await fetchFixtures(league, prevGw);
  if (!fixtures.length) return null;
  // Build quick index for points
  const results = [];
  let hi = null, lo = null;
  for (const fx of fixtures) {
    const aOwner = fx.entry_1_player_name || fx.home_owner || fx.a_owner || fx.owner_a || fx.owner1 || fx.home_manager || fx.aOwner;
    const bOwner = fx.entry_2_player_name || fx.away_owner || fx.b_owner || fx.owner_b || fx.owner2 || fx.away_manager || fx.bOwner;
    const aTeam  = fx.entry_1_name        || fx.home_team  || fx.a_team  || fx.team_a  || fx.team1  || fx.home        || fx.aTeam;
    const bTeam  = fx.entry_2_name        || fx.away_team  || fx.b_team  || fx.team_b  || fx.team2  || fx.away        || fx.bTeam;
    const aPts   = fx.entry_1_points != null ? fx.entry_1_points : fx.points_a != null ? fx.points_a : fx.a_points;
    const bPts   = fx.entry_2_points != null ? fx.entry_2_points : fx.points_b != null ? fx.points_b : fx.b_points;
    // Only include if points available
    if (aPts == null || bPts == null) continue;
    results.push({ aOwner, bOwner, aTeam, bTeam, aPts, bPts });
    // Track highest/lowest scorers across the league
    const candidates = [
      { owner: aOwner, team: aTeam, pts: aPts },
      { owner: bOwner, team: bTeam, pts: bPts },
    ];
    for (const c of candidates) {
      if (!hi || c.pts > hi.pts) hi = c;
      if (!lo || c.pts < lo.pts) lo = c;
    }
  }
  if (!results.length) return null;

  // Pick which matchups to report: prefer the ones we highlighted before if present
  const remembered = __LAST_PREVIEWS?.[league]?.[prevGw] || [];
  let chosen = [];
  if (remembered.length) {
    // match by owner or team names
    for (const r of remembered) {
      const found = results.find(f =>
        (f.aOwner && r.aOwner && f.aOwner.toLowerCase() === r.aOwner.toLowerCase() && f.bOwner && r.bOwner && f.bOwner.toLowerCase() === r.bOwner.toLowerCase()) ||
        (f.aTeam && r.aTeam && f.aTeam.toLowerCase() === r.aTeam.toLowerCase() && f.bTeam && r.bTeam && f.bTeam.toLowerCase() === r.bTeam.toLowerCase())
      );
      if (found) chosen.push(found);
      if (chosen.length >= 3) break;
    }
  }
  // If not enough, fill with closest-score games
  if (chosen.length < 3) {
    const remaining = results.filter(fx => !chosen.includes(fx));
    remaining.sort((x,y)=>Math.abs((x.aPts-x.bPts)) - Math.abs((y.aPts-y.bPts)));
    for (const r of remaining) {
      chosen.push(r);
      if (chosen.length>=3) break;
    }
  }

  return { chosen, hi, lo };
}

function formatPrevGwSummaryMessage(league, prevGw, summary) {
  const lines = [];
  lines.push(`📊 **GW ${prevGw} SUMMARY: ${league[0].toUpperCase() + league.slice(1)}**`);

  // If we don't have any chosen matchups, still show hi/lo if available.
  if (!summary || !summary.chosen || !summary.chosen.length) {
    lines.push("No completed matchups found.");
    if (summary?.hi) {
      lines.push(`Highest scorer: **${summary.hi.team} (${mentionForOwner(summary.hi.owner)}) — ${summary.hi.pts}**`);
    }
    if (summary?.lo) {
      lines.push(`Lowest scorer: **${summary.lo.team} (${mentionForOwner(summary.lo.owner)}) — ${summary.lo.pts}**`);
    }
    return lines.join("\n");
  }

  // Normal path: list the 3 highlighted matchups, then hi/lo
  lines.push("");
  const { chosen, hi, lo } = summary;
  let i = 1;
  for (const m of chosen) {
    const aMent = mentionForOwner(m.aOwner);
    const bMent = mentionForOwner(m.bOwner);
    const a = `${m.aTeam} (${aMent}) — ${m.aPts}`;
    const b = `${m.bTeam} (${bMent}) — ${m.bPts}`;
    const winner = m.aPts === m.bPts ? "Draw" : (m.aPts > m.bPts ? `${m.aTeam}` : `${m.bTeam}`);
    lines.push(`Matchup ${i}:`);
    lines.push(`${a}  vs  ${b}`);
    lines.push(`Winner: **${winner}**`);
    lines.push("");
    lines.push("");
    i++;
  }
  if (hi) lines.push(`Highest scorer: **${hi.team} (${mentionForOwner(hi.owner)}) — ${hi.pts}**`);
  if (lo) lines.push(`Lowest scorer: **${lo.team} (${mentionForOwner(lo.owner)}) — ${lo.pts}**`);
  return lines.join("\n");
}

function htmlEscape(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

// turn **bold** into <strong>bold</strong>
function mdBoldToHtml(s) {
  return s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
}

function renderLeagueHtml(league, rawMsg) {
  // Drop the leading "📊 GWx SUMMARY: League" header if present
  const cleaned = rawMsg.replace(/^📊\s*GW\s*\d+\s*SUMMARY:\s*[^\n]+\n?/i, "").trim();
  const lines = cleaned.split(/\r?\n/);

  const title = league[0].toUpperCase() + league.slice(1);
  const out = [`<h3>📊 ${htmlEscape(title)}</h3>`];

  for (let ln of lines) {
    if (!ln.trim()) continue;

    // Bold+italicize "Matchup #:" lines
    if (/^Matchup\s*\d+:/i.test(ln)) {
      const body = mdBoldToHtml(htmlEscape(ln));
      out.push(`<p><strong><em>${body}</em></strong></p>`);
      continue;
    }

    // Everything else: escape + bold conversion
    const body = mdBoldToHtml(htmlEscape(ln));
    out.push(`<p>${body}</p>`);
  }

  return out.join("\n");
}


function schedulePrevGwSummaryDailyPT(
  hhmm = (process.env.SUMMARY_POST_LOCAL_TIME || "18:05"),
  tz   = (process.env.SUMMARY_POST_TZ || "America/Los_Angeles")
) {
  const [h, m] = String(hhmm).split(":").map(n => parseInt(n, 10));
  scheduleDailyInTz(
    "Prev GW Summary Daily",
    Number.isFinite(h) ? h : 18,
    Number.isFinite(m) ? m : 5,
    tz,
    async () => {
      try {
        await maybePostPrevGwSummaries(); // picks latest finished GW internally
      } catch (e) {
        console.log("summary daily error:", e?.message || e);
      }
    }
  );
}


async function maybePostPrevGwSummaries() {
  if (!REMINDER_CHANNEL_ID) return;

  // Fetch channel
  let channel;
  try {
    channel = await client.channels.fetch(REMINDER_CHANNEL_ID);
  } catch (e) {
    console.log("maybePostPrevGwSummaries: cannot fetch channel", e?.message || e);
    return;
  }

  // Fetch FPL events
  let bs;
  try {
    const { data } = await axios.get("https://fantasy.premierleague.com/api/bootstrap-static/");
    bs = data;
  } catch (e) {
    console.log("maybePostPrevGwSummaries: bootstrap fetch failed", e?.message || e);
    return;
  }

  const events = bs?.events || [];
  const now = new Date();

  const upcoming = events
    .filter(e => e.deadline_time && new Date(e.deadline_time) > now)
    .sort((a, b) => new Date(a.deadline_time) - new Date(b.deadline_time))[0] || null;

  // The target GW is the one immediately before the next deadline.
  const prevGw = upcoming ? (upcoming.id - 1) : (
    // fallback to most recent finished if no upcoming found
    (events.filter(e => e.is_finished || e.finished).sort((a,b)=>b.id-a.id)[0]?.id ?? null)
  );
  if (!prevGw || prevGw <= 0) return;

  const prevEvent = events.find(e => e.id === prevGw);
  if (!prevEvent) return;

  // don't post until the GW is actually finished (and data checked if required)
  if (!isEventFinalized(prevEvent)) {
    console.log(
      `Prev GW ${prevGw} not finalized yet — ` +
      `finished=${prevEvent.finished ?? prevEvent.is_finished}, data_checked=${prevEvent.data_checked}. Skipping.`
    );
    return;
  }

  if (__LAST_SUMMARY_POSTED_GW === prevGw) return;

  try {
    // 1) Build and send messages to Discord (same as before)
    const leagueMsgs = [];
    for (const league of LEAGUES) {
      const sum = await summarizePreviousGW(league, prevGw);
      // make sure there are scores
      const enough =
        sum && Array.isArray(sum.chosen) && sum.chosen.length >= 1; // chosen comes from fixtures with points
      if (!enough) {
        console.log(`GW${prevGw} summary looked incomplete — skipping for now.`);
        return;
      }
      const msg = formatPrevGwSummaryMessage(league, prevGw, sum);
      await channel.send(msg);
      leagueMsgs.push({ league, msg });
    }

    // 2) Also publish a website article that aggregates both leagues
    // Title: "GW# Reviews"
    const title = `GW${prevGw} Reviews`;
    const excerpt = "Review the biggest matchups and see who scored the most (and least) this week!";
    const content_html = leagueMsgs
      .map(({ league, msg }) => renderLeagueHtml(league, msg))
      .join("\n<hr/>\n");

    await postNews({
      title,
      excerpt,
      image_url: WEEKLY_REVIEW_IMAGE,
      content_html,                           // <-- HTML, not markdown
      tags: [WEEKLY_REVIEW_TAG],
    }).catch(e => console.log("postNews (weekly reviews) failed:", e?.message || e));

    __LAST_SUMMARY_POSTED_GW = prevGw;
    console.log(`Posted previous GW summaries for GW${prevGw} and published site article.`);
  } catch (e) {
    console.log("maybePostPrevGwSummaries: posting failed", e?.message || e);
  }
}

function unique(arr) { return [...new Set(arr)]; }
function looksLikeArticleLink(href) {
  if (!href) return false;
  const s = String(href).trim();

  // Keep absolute http(s) or site-relative; drop everything else
  if (!/^https?:|^\//i.test(s)) return false;

  // Skip anchors / non-content schemes
  if (s === "#" || /^#/.test(s)) return false;
  if (/^mailto:|^tel:/i.test(s)) return false;

  // Skip obvious non-articles: media files and common social sites
  if (/\.(jpg|jpeg|png|gif|webp|svg|avif|mp4|mov|webm|pdf)(\?.*)?$/i.test(s)) return false;
  if (/twitter\.com|x\.com|facebook\.com|linkedin\.com|whatsapp\.com|t\.me|instagram\.com|pinterest\.com|reddit\.com/i.test(s)) return false;

  // Skip auth/policy pages
  if (/\b(login|sign[- ]?in|signup|register|privacy|terms|cookies|policy)\b/i.test(s)) return false;

  return true;
}

function collectMundoArticleLinks(html, baseUrl, max = 4) {
  const $ = cheerio.load(html);
  const root = $("main").length ? $("main") : $("body");

  const candidates = [];
  root.find("a[href]").each((_, a) => {
    const rawHref = ($(a).attr("href") || "").trim();
    const href = absUrl(rawHref, baseUrl);
    const text = ($(a).text() || "").trim();
    const ok = looksLikeArticleLink(href);
    if (!ok) return;

    if (!href || href === baseUrl || /^#/.test(href)) return;

    const score =
      (/(gw|gameweek|review|results|round|match)/i.test(text) ? 5 : 0) +
      (/\d{2,4}/.test(text) ? 2 : 0) +
      (/(post|article)/i.test(text) ? 1 : 0);

    candidates.push({ href, text, score });
  });

  debugLog("collectMundoArticleLinks:anchors", { count: candidates.length });

  // dump first few for sanity
  candidates.slice(0, 10).forEach((c, i) => {
    debugLog(`anchor[${i}]`, { href: c.href, text: c.text.slice(0, 80), score: c.score });
  });

  // Dedup + top-N
  const seen = new Set();
  const deduped = [];
  for (const c of candidates) {
    if (seen.has(c.href)) continue;
    seen.add(c.href);
    deduped.push(c);
  }
  deduped.sort((a, b) => b.score - a.score);

  let links = unique(deduped.map(x => x.href)).slice(0, max);
  if (links.length) {
    debugLog("collectMundoArticleLinks:return:anchors", links);
    return links;
  }

  // Regex fallback
  debugLog("collectMundoArticleLinks:fallback:regex");
  const base = new URL(baseUrl);
  const out = new Set();
  const htmlStr = String(html || "");

  // Absolute URLs
  for (const m of htmlStr.matchAll(/https?:\/\/(?:www\.)?fplmundo\.com\/(\d{5,9})(?!\d)/gi)) {
    out.add(`https://www.fplmundo.com/${m[1]}`);
    if (out.size >= max) break;
  }

  // Relative numeric links
  if (out.size < max) {
    for (const m of htmlStr.matchAll(/(^|[^a-z0-9/_-])\/(\d{5,9})(?!\d)/gi)) {
      out.add(`${base.origin}/${m[2]}`);
      if (out.size >= max) break;
    }
  }

  // Plain bare IDs
  if (out.size < max) {
    for (const m of htmlStr.matchAll(/\b(\d{5,9})\b/g)) {
      out.add(`${base.origin}/${m[1]}`);
      if (out.size >= max) break;
    }
  }

  const final = Array.from(out).slice(0, max);
  debugLog("collectMundoArticleLinks:return:regex", final);
  return final;
}



async function publishFromMundoPage(url, { mode="auto", max=4, tag=FPL_MUNDO_TAG, imageFallback=FPL_MUNDO_PLACEHOLDER_IMAGE, dryrun=false } = {}) {
  const html = await fetchRenderedHtml(url);

  // 1) split mode: try multi-section on the same page
  if (mode === "split" || mode === "auto") {
    const sections = extractSectionsFromHtml(html, url);
    if (sections.length >= 2) {
      if (dryrun) return { modeUsed: "split", sections, results: [] };
      const results = [];
      for (const sec of sections) {
        try {
          const posted = await postNews({
            title: sec.title,
            excerpt: sec.excerpt || "",
            image_url: sec.image_url || imageFallback,
            content_markdown: sec.content_markdown,
            tags: [tag],
            author: "FPL Mundo",
          });
          results.push({ ok:true, id: posted.id, title: sec.title });
        } catch (e) {
          results.push({ ok:false, title: sec.title, error: extractError(e) });
        }
      }
      return { modeUsed: "split", sections, results };
    }
    if (mode === "split") {
      return { modeUsed: "split", sections: [], results: [], note: "No distinct sections found" };
    }
  }

  // 2) list mode: find child article links and publish each
  if (mode === "list" || mode === "auto") {
    const links = collectMundoArticleLinks(html, url, max);
    if (links.length) {
      const items = [];
      for (const link of links) {
        try {
          const art = await fetchFplMundoArticle(link);
          items.push({ link, art });
        } catch (e) {
          items.push({ link, error: e?.message || String(e) });
        }
      }
      if (dryrun) return { modeUsed: "list", items, results: [] };
      const results = [];
      for (const it of items) {
        if (!it.art) { results.push({ ok:false, title: it.link, error: it.error || "parse failed" }); continue; }
        try {
          const posted = await postNews({
            title: it.art.title,
            excerpt: it.art.excerpt,
            image_url: it.art.image_url || imageFallback,
            content_markdown: it.art.markdown,
            tags: [tag],
            author: "FPL Mundo",
          });
          results.push({ ok:true, id: posted.id, title: it.art.title });
        } catch (e) {
          results.push({ ok:false, title: it.art.title, error: extractError(e) });
        }
      }
      return { modeUsed: "list", items, results };
    }
  }

  // 3) fallback: treat the page as a single article
  try {
    const one = await fetchFplMundoArticle(url);
    if (dryrun) return { modeUsed: "single", one, results: [] };
    const posted = await postNews({
      title: one.title,
      excerpt: one.excerpt,
      image_url: one.image_url || imageFallback,
      content_markdown: one.markdown,
      tags: [tag],
      author: "FPL Mundo",
    });
    return { modeUsed: "single", one, results: [{ ok:true, id: posted.id, title: one.title }] };
  } catch (e) {
    return { modeUsed: "single", one: null, results: [{ ok:false, error: e?.message || String(e) }] };
  }
}



async function scheduleDeadlineReminders() {
  if (!REMINDER_CHANNEL_ID) {
    console.log("DEADLINE_CHANNEL_ID not set — skipping deadline reminders.");
    return;
  }

  // Fetch channel
  let channel;
  try {
    channel = await client.channels.fetch(REMINDER_CHANNEL_ID);
  } catch (e) {
    console.log("Unable to fetch reminder channel:", e?.message || e);
    return;
  }

// Next event (deadline)
const ev = await getNextFplEvent();
if (!ev) { console.log("No upcoming FPL event found to schedule."); return; }

const deadline = new Date(ev.deadline_time); // UTC from FPL API
const oneDayBefore  = new Date(deadline.getTime() - 24 * 60 * 60 * 1000);
const oneHourBefore = new Date(deadline.getTime() - 60 * 60 * 1000);

clearReminders();

// ---------- helper that actually generates & posts previews ----------
const runPreviews = async (label) => {
  logPreviewDebug(`runPreviews start (${label}) for GW${ev.id}`);

  const reasons = [];
  const previews = [];

  for (const league of LEAGUES) {
    try {
      const rows = await fetchLeagueTable(league);
      const teams = normalizeTeams(rows);
      if (!teams.length) {
        logPreviewDebug(`${league}: no league table data`);
        reasons.push(`${league}: no league table data`);
        continue;
      }

      const fixtures = await fetchFixtures(league, ev.id);
      if (!fixtures?.length) {
        logPreviewDebug(`${league}: no fixtures for GW${ev.id}`);
        reasons.push(`${league}: no fixtures`);
        continue;
      }

      console.log("teams sample", teams.slice(0, 3).map(t => ({
        position: t.position, team: t.team, owner: t.owner, h2hPoints: t.h2hPoints, totalScore: t.totalScore
      })));

      console.log("fixtures sample", fixtures.slice(0, 3).map(fx => ({
        aOwner: fx.a_owner || fx.owner_a || fx.entry_1_player_name,
        aTeam:  fx.a_team  || fx.team_a  || fx.entry_1_name,
        bOwner: fx.b_owner || fx.owner_b || fx.entry_2_player_name,
        bTeam:  fx.b_team  || fx.team_b  || fx.entry_2_name
      })));


      const picks = selectDramaticMatchups(teams, { league, fixtures, gw: ev.id });
      if (!picks.length) {
        logPreviewDebug(`${league}: no picks generated`);
        reasons.push(`${league}: no picks`);
        continue;
      }

      rememberPreviews(league, ev.id, picks);
      previews.push(formatPreviewMessage(league, ev.id, picks));
      logPreviewDebug(`${league}: ok (teams=${teams.length}, fixtures=${fixtures.length}, picks=${picks.length})`);
    } catch (e) {
      logPreviewDebug(`${league}: error`, e?.message || e);
      reasons.push(`${league}: error - ${e?.message || e}`);
    }
  }

  if (previews.length) {
    await channel.send(previews.join("\n\n"));
    logPreviewDebug(`posted ${previews.length} preview blocks for GW${ev.id} (${label})`);
  } else {
    console.log(`[previews] None generated for GW${ev.id} (${label}). Reasons: ${reasons.join("; ")}`);
    if (PREVIEW_DEBUG_NOTIFY) {
      await channel.send(
        `⚠️ Could not generate GW${ev.id} Ones to Watch (${label}).\n` +
        reasons.map(r => `• ${r}`).join("\n")
      ).catch(()=>{});
    }
  }
};

// ---------- schedule the reminders ----------
const scheduleAt = (when, label, fn) => {
  const ms = when.getTime() - Date.now();
  if (ms <= 0) return; // too late to schedule
  const t = setTimeout(async () => {
    try {
      const pst = formatInTZ(deadline, "America/Los_Angeles");
      const est = formatInTZ(deadline, "America/New_York");
      await channel.send(`🚨🚨🚨 @everyone 🚨🚨🚨 \n**GW${ev.id} is ${label}(s) away!**\n${pst} PST / ${est} EST`);
      if (typeof fn === "function") await fn();
    } catch (e) {
      console.error("Failed to send reminder:", e?.message || e);
    }
  }, ms);
  __scheduledTimeouts.push(t);
};

// T-24h: schedule if we’re earlier than that mark…
scheduleAt(oneDayBefore, "24-hour", async () => { await runPreviews("T-24h"); });

// …and if we’re already inside the 24h window (common after restarts), run a catch-up once.
const now = Date.now();
if (now > oneDayBefore.getTime() && now < oneHourBefore.getTime()) {
  logPreviewDebug("inside 24h window at (re)schedule time — running catch-up previews now");
  await runPreviews("catch-up");
}

// T-1h reminder (unchanged)
scheduleAt(oneHourBefore, "1-hour");

// re-arm for next GW after this deadline
const reschedMs = Math.max(deadline.getTime() - Date.now() + 60 * 1000, 60 * 60 * 1000);
__scheduledTimeouts.push(setTimeout(scheduleDeadlineReminders, reschedMs));

console.log(`Scheduled GW${ev.id} reminders: 24h @ ${oneDayBefore.toISOString()}, 1h @ ${oneHourBefore.toISOString()}, deadline @ ${deadline.toISOString()}`);

}

// ===== Price Change Watchers (LiveFPL predicted + confirmed) =====

// ===== Price change scheduling (predicted every 2h, confirmed daily at 01:30 UTC) =====
const PRICE_CHANNEL_ID = process.env.PRICE_CHANNEL_ID || process.env.DEADLINE_CHANNEL_ID;

// Defaults: predictions every 120 min; confirmed at 01:30 UTC (GMT)
const PREDICTED_PRICE_POLL_MIN = parseInt(process.env.PREDICTED_PRICE_POLL_MIN || "120", 10);
const CONFIRMED_PRICE_POST_UTC = process.env.CONFIRMED_PRICE_POST_UTC || "01:45"; // "HH:MM" 24h UTC

function msUntilNextUtc(hhmm) {
  const [h, m] = (hhmm || "01:30").split(":").map(Number);
  const now = new Date();
  const next = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), h, m, 0, 0
  ));
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}

// Poll predictions every N minutes, but only post when the set changes
function schedulePredictedEvery(channel, minutes = 120) {
  const run = async () => {
    try {
      // This helper should fetch https://www.livefpl.net/prices and ONLY post if changed
      await postPredictedIfChanged(channel);
    } catch (e) {
      console.log("predicted poll error:", e?.message || e);
    }
  };
  // Optional: run once on boot 
  run();
  setInterval(run, Math.max(1, minutes) * 60 * 1000);
}

// Post confirmed changes exactly once each day at 6:30 PM America/Los_Angeles
function scheduleConfirmedDailyPT(channel, hhmm = (process.env.CONFIRMED_PRICE_LOCAL_TIME || "18:45"), tz = (process.env.CONFIRMED_PRICE_TZ || "America/Los_Angeles")) {
  const [h, m] = String(hhmm).split(":").map(n => parseInt(n, 10));
  scheduleDailyInTz("Confirmed Prices Daily", Number.isFinite(h) ? h : 18, Number.isFinite(m) ? m : 45, tz, async () => {
    try {
      await postConfirmedIfChanged(channel);
    } catch (e) {
      console.log("confirmed daily error:", e?.message || e);
    }
  });
}


async function schedulePriceWatchers(client) {
  if (!PRICE_CHANNEL_ID) {
    console.log("PRICE_CHANNEL_ID not set — skipping price watchers.");
    return;
  }

  let channel;
  try {
    channel = await client.channels.fetch(PRICE_CHANNEL_ID);
  } catch (e) {
    console.log("Cannot fetch price channel:", e?.message || e);
    return;
  }

  // Predictions at fixed local times (PST/PDT)
  schedulePredictedFixedTimesPT(channel); // 08:00, 11:00, 15:30, 17:30, 18:00 by default

  if (typeof scheduleConfirmedDailyPT === "function") {
    scheduleConfirmedDailyPT(channel, process.env.CONFIRMED_PRICE_LOCAL_TIME || "18:45"); // 18:30 PT by default (can be env-controlled)
  } else {
    // otherwise your existing UTC-based function will still run
    scheduleConfirmedDaily(channel, CONFIRMED_PRICE_POST_UTC);
  }
}



// Cache to avoid duplicate posts
let __LAST_PRED_SIG = "";
let __LAST_CONF_SIG = "";

// Emojis
const UP = "📈";
const DOWN = "📉";

// Replace your old fmtPrice with these helpers
function toPriceFloat(x) {
  if (x == null) return NaN;
  const n = typeof x === "number" ? x : Number(String(x).replace(/[^\d.]/g, ""));
  if (!Number.isFinite(n)) return NaN;
  // Only treat as FPL now_cost (e.g. 105) when it's an INTEGER >= 20
  return Number.isInteger(n) && n >= 20 ? n / 10 : n;
}

function addDelta(x, delta) {
  const p = toPriceFloat(x);
  if (!Number.isFinite(p)) return NaN;
  // keep one decimal accuracy
  return Math.round((p + delta) * 10) / 10;
}

function fmtPrice(x) {
  const p = toPriceFloat(x);
  const v = Number.isFinite(p) ? p : 0;
  return `£${v.toFixed(1)}m`;
}

// --- helpers (put near your other top-level helpers) ---
function normalizePlayerKey(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD").replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9]+/g, "");
}

// Cache FPL team map: web_name -> team short_name
let __TEAM_MAP_CACHE = null;
async function fetchFplTeamMap() {
  if (__TEAM_MAP_CACHE) return __TEAM_MAP_CACHE;

  const { data } = await axios.get("https://fantasy.premierleague.com/api/bootstrap-static/", {
    timeout: 20000,
    headers: { "User-Agent": "tfpl-bot/1.0 (+https://tfpl.vercel.app)" }
  });

  const teams = {};
  for (const t of (data?.teams || [])) {
    teams[t.id] = t.short_name || t.name || "";
  }

  const byName = {}; // normalized web_name -> short team code
  for (const p of (data?.elements || [])) {
    const key = normalizePlayerKey(p.web_name);
    byName[key] = teams[p.team] || "";
  }

  __TEAM_MAP_CACHE = byName;
  return byName;
}

// Extract the "Summary of Predictions" section and read player cards
function parseSummaryFromLiveFPL(html) {
  const $ = cheerio.load(html);

  // Find "Summary of Predictions" heading and collect nodes until the next big section
  const hdr = $("h1,h2,h3,h4").filter((_, el) =>
    /summary of predictions/i.test($(el).text())
  ).first();

  if (!hdr.length) return [];

  const blockNodes = [];
  let n = hdr[0].nextSibling;
  while (n) {
    // stop at the start of the big "All Players" table/section
    if (n.type === "tag") {
      const txt = $(n).text().trim();
      if (/^player\s+progress/i.test(txt) || /^all\s+players/i.test(txt)) break;
    }
    blockNodes.push(n);
    n = n.nextSibling;
  }

  const section = $(blockNodes);
  const out = [];

  // Each player card usually has an h5/h6 (player name),
  // a line with position + "£<price>", and a line with "<percent>%"
  section.find("h5,h6").each((_, h) => {
    const name = $(h).text().trim();
    if (!name) return;

    // Use parent container text as a cheap way to grab price & percent
    const txt = $(h).parent().text().replace(/\s+/g, " ").trim();

    // Price like "£5.6" or "£10.4"
    const mPrice = txt.match(/£\s*([0-9]+(?:\.[0-9])?)/i);
    // Progress like "-103.7%" or "104.1%"
    const mPct = txt.match(/(-?\d+(?:\.\d+)?)\s*%/);

    if (!mPrice || !mPct) return;

    const price = parseFloat(mPrice[1]);
    const progress = parseFloat(mPct[1]); // positive = rise, negative = fall

    if (!isFinite(price) || !isFinite(progress)) return;
    out.push({ name, price, progress });
  });

  return out;
}


// ---------- PREDICTED (robust: JSON first, HTML fallback) ----------
async function fetchPredictedFromLiveFPL() {
  const url = "https://www.livefpl.net/prices";
  const { data: html } = await axios.get(url, {
    timeout: 20000,
    headers: {
      // a friendly UA helps some hosts serve full HTML to bots
      "User-Agent": "tfpl-bot/1.0 (+https://tfpl.vercel.app)"
    }
  });

  const cards = parseSummaryFromLiveFPL(html);       // [{name, price, progress}]
  if (!cards.length) return { risers: [], fallers: [] };

  // Thresholds:
  const risersRaw = cards.filter(c => c.progress >= 100);
  const fallersRaw = cards.filter(c => c.progress <= -100);

  // Enrich with team via FPL bootstrap
  const teamMap = await fetchFplTeamMap();
  const attachTeam = (arr) => arr.map(p => ({
    name: p.name,
    team: teamMap[normalizePlayerKey(p.name)] || "",
    price: p.price
  })).slice(0, 25);

  return {
    risers: attachTeam(risersRaw),
    fallers: attachTeam(fallersRaw),
  };
}


function buildPredictedMessage(pred) {
  const lines = [];
  lines.push("**POTENTIAL PRICE CHANGES:**");
  lines.push("");

  lines.push("**Predicted Risers:**");
  if (pred.risers.length) {
    pred.risers.forEach(p => {
      const cur = fmtPrice(p.price);
      const next = fmtPrice(addDelta(p.price, +0.1));
      lines.push(`${cur} ${UP} ${next} - **${p.name}** ${p.team ? `(${p.team})` : ""}`);
    });
  } else {
    lines.push("_None currently_");
  }

  lines.push("");
  lines.push("**Predicted Fallers:**");
  if (pred.fallers.length) {
    pred.fallers.forEach(p => {
      const cur = fmtPrice(p.price);
      const next = fmtPrice(addDelta(p.price, -0.1));
      lines.push(`${cur} ${DOWN} ${next} - **${p.name}** ${p.team ? `(${p.team})` : ""}`);
    });
  } else {
    lines.push("_None currently_");
  }

  return lines.join("\n");
}

function canonKey(p) {
  const name = String(p.name || "").trim().toLowerCase();
  const team = String(p.team || "").trim().toLowerCase();
  const price = Number(p.price);
  const priceStr = Number.isFinite(price) ? price.toFixed(1) : "";
  return `${name}|${team}|${priceStr}`;
}

async function postPredictedIfChanged(channel) {
  try {
    const pred = await fetchPredictedFromLiveFPL();

    const rSet = [...new Set(pred.risers.slice(0, 30).map(canonKey))].sort();
    const fSet = [...new Set(pred.fallers.slice(0, 30).map(canonKey))].sort();

    const sig = `r=${rSet.join(",")}&f=${fSet.join(",")}`;
    if (!sig || sig === __LAST_PRED_SIG) return;   // <- same names/prices, any order → skip
    __LAST_PRED_SIG = sig;

    const msg = buildPredictedMessage(pred);
    if (msg.trim()) await channel.send(msg);
  } catch (e) {
    console.log("Predicted price watcher error:", e?.message || e);
  }
}

// ---------- CONFIRMED (plan.livefpl.net/price_changes) ----------
function pickIndex(headers, patterns, fallback) {
  const joined = headers.map(h => h.toLowerCase().trim());
  for (const p of patterns) {
    const re = new RegExp(p, "i");
    const i = joined.findIndex(h => re.test(h));
    if (i !== -1) return i;
  }
  return fallback;
}

function parseNumberLikePrice(s) {
  if (s == null) return NaN;
  const n = Number(String(s).replace(/[^\d.]+/g, ""));
  // if something like 105 (FPL integer tenths), turn into 10.5
  return Number.isInteger(n) && n >= 20 ? n / 10 : n;
}


function indexOfHeader(headers, needles) {
  const H = headers.map(h => h.toLowerCase().trim());
  for (const n of needles) {
    const i = H.findIndex(h => h.includes(n.toLowerCase()));
    if (i !== -1) return i;
  }
  return -1;
}

// Find the REAL header row inside a table (often NOT the first <tr>)
function detectHeaderRow($, $table) {
  const rows = $table.find("tr").toArray();
  // Look through <thead> rows first, then the first few <tr> in the table
  const candidates = [
    ...$table.find("thead tr").toArray(),
    ...rows.slice(0, 6)  // scan first 6 rows for safety
  ];

  for (const tr of candidates) {
    const headers = $(tr).find("th,td").toArray().map(td => $(td).text().trim());
    if (!headers.length) continue;

    const idx = {
      name: indexOfHeader(headers, ["player", "name", "player name"]),
      team: indexOfHeader(headers, ["team", "club", "squad"]),
      old:  indexOfHeader(headers, ["old price", "old", "before", "prev"]),
      next: indexOfHeader(headers, ["new price", "new", "after"]),
    };

    // Must have name + old + new to consider it a proper header row
    if (idx.name !== -1 && idx.old !== -1 && idx.next !== -1) {
      return { headerRow: tr, headerIndex: rows.indexOf(tr), headers, idx };
    }
  }
  return null;
}

function parseConfirmedTable($, $table, meta, teamMap) {
  const out = [];
  if (!$table || !$table.length || !meta) return out;

  const rows = $table.find("tr").toArray();
  // Start parsing from the row AFTER the detected header row
  for (let i = meta.headerIndex + 1; i < rows.length; i++) {
    const $tds = $(rows[i]).find("td");
    if ($tds.length < 2) continue;

    const get = (ix) => (ix >= 0 && $tds.get(ix)) ? $($tds.get(ix)).text().trim() : "";

    const nameCell = get(meta.idx.name);
    if (!nameCell) continue;

    let team = meta.idx.team >= 0 ? get(meta.idx.team) : "";
    let name = nameCell;

    // Fallback: "Name (TEAM)" packed into the Player cell
    const paren = nameCell.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
    if (paren) {
      name = paren[1].trim();
      team = team || paren[2].trim();
    } else if (!team && teamMap) {
      const key = normalizePlayerKey(name);
      team = teamMap[key] || "";
    }

    const oldP = parseNumberLikePrice(get(meta.idx.old));
    const newP = parseNumberLikePrice(get(meta.idx.next));
    if (!Number.isFinite(oldP) || !Number.isFinite(newP)) continue;

    out.push({ name, team, old: oldP, next: newP });
  }

  return out;
}

async function fetchConfirmedPriceChanges() {
  const url = "https://plan.livefpl.net/price_changes";
  const { data: html } = await axios.get(url, {
    timeout: 20000,
    headers: {
      "User-Agent": "tfpl-bot/1.0 (+https://tfpl.vercel.app)",
      "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Referer": "https://plan.livefpl.net/",
      "Cache-Control": "no-cache",
      "Pragma": "no-cache",
    },
    transformResponse: [r => r],
    validateStatus: s => s >= 200 && s < 400,
  });

  if (/just a moment/i.test(html) && /cloudflare/i.test(html)) {
    throw new Error("Blocked by Cloudflare (challenge page).");
  }

  const $ = cheerio.load(html);
  const teamMap = await fetchFplTeamMap().catch(() => null);

  const $tables = $("table");
  if (process.env.LIVEFPL_DEBUG) {
    console.log(`[price_changes] tables found: ${$tables.length}`);
  }
  if (!$tables.length) return { risers: [], fallers: [] };

  // Build candidates with detected header rows (in DOM order)
  const candidates = [];
  $tables.each((_, el) => {
    const $t = $(el);
    const meta = detectHeaderRow($, $t);
    if (meta) {
      candidates.push({ $t, meta });
      if (process.env.LIVEFPL_DEBUG) {
        console.log("[price_changes] header:", meta.headers);
      }
    }
  });

  if (!candidates.length) {
    if (process.env.LIVEFPL_DEBUG) console.log("[price_changes] no header rows detected");
    return { risers: [], fallers: [] };
  }

  // Parse ONLY the first candidate (top-most = latest day)
  const { $t, meta } = candidates[0];
  const rows = parseConfirmedTable($, $t, meta, teamMap);

  // Classify
  let risers  = rows.filter(r => r.next > r.old);
  let fallers = rows.filter(r => r.next < r.old);

  // Dedup safety
  const key = p => `${normalizePlayerKey(p.name)}|${(p.team||"").toLowerCase()}|${p.old}->${p.next}`;
  const uniq = arr => arr.filter((x, i, self) => self.findIndex(y => key(y) === key(x)) === i);

  risers = uniq(risers);
  fallers = uniq(fallers);

  if (process.env.LIVEFPL_DEBUG) {
    console.log(`[price_changes] parsed rows: ${rows.length} (risers: ${risers.length}, fallers: ${fallers.length})`);
  }

  return { risers, fallers };
}




function buildConfirmedMessage(chg) {
  const lines = [];
  lines.push("**PRICE CHANGE:**", "");

  lines.push("**Risers:**");
  if (chg.risers.length) {
    chg.risers.forEach(p => {
      const teamText = p.team ? ` (${p.team})` : "";
      lines.push(`**${p.name}**${teamText} - ${fmtPrice(p.old)} ${UP} ${fmtPrice(p.next)}`);
    });
  } else {
    lines.push("_None_");
  }

  lines.push("", "**Fallers:**");
  if (chg.fallers.length) {
    chg.fallers.forEach(p => {
      const teamText = p.team ? ` (${p.team})` : "";
      lines.push(`**${p.name}**${teamText} - ${fmtPrice(p.old)} ${DOWN} ${fmtPrice(p.next)}`);
    });
  } else {
    lines.push("_None_");
  }

  // add the LiveFPL plan page link at the end
  //lines.push("", "Source: https://plan.livefpl.net/price_changes");

  return lines.join("\n");
}

// Append a source link cleanly to any message
function appendSource(msg, url) {
  const trimmed = (msg || "").trim();
  if (!trimmed) return trimmed;
  return `${trimmed}\n\nSource: ${url}`;
}

// On-demand: show current predicted changes
async function handlePricePredictionsCmd(interaction) {
  await interaction.deferReply({ ephemeral: false });
  try {
    const pred = await fetchPredictedFromLiveFPL();
    const noData = (!pred?.risers?.length && !pred?.fallers?.length);
    const msg = noData
      ? "**POTENTIAL PRICE CHANGES:**\n\n_No players are currently ≥100% to rise or ≤−100% to fall._"
      : buildPredictedMessage(pred);

    // Add LiveFPL link
    const withLink = appendSource(msg, "https://www.livefpl.net/prices");
    await interaction.editReply(withLink);
  } catch (e) {
    console.log("predictions slash error:", e?.message || e);
    await interaction.editReply("❌ Failed to fetch predicted price changes.");
  }
}

// On-demand: show last confirmed changes
async function handlePriceChangesCmd(interaction) {
  await interaction.deferReply({ ephemeral: false });
  try {
    const chg = await fetchConfirmedPriceChanges();
    const noData = (!chg?.risers?.length && !chg?.fallers?.length);
    const msg = noData
      ? "**PRICE CHANGE:**\n\n_No confirmed rises or falls posted yet._"
      : buildConfirmedMessage(chg);

    // Add plan.livefpl link (as requested)
    const withLink = appendSource(msg, "https://plan.livefpl.net/price_changes");
    await interaction.editReply(withLink);
  } catch (e) {
    console.log("confirmed slash error:", e?.message || e);
    await interaction.editReply("❌ Failed to fetch confirmed price changes.");
  }
}



async function postConfirmedIfChanged(channel) {
  try {
    const chg = await fetchConfirmedPriceChanges();

    // Compact signature to avoid duplicates if a restart happens around post time
    const sig = JSON.stringify({
      r: chg.risers.map(x => `${normalizePlayerKey(x.name)}|${(x.team||"").toLowerCase()}|${toPriceFloat(x.old)}->${toPriceFloat(x.next)}`).slice(0, 100),
      f: chg.fallers.map(x => `${normalizePlayerKey(x.name)}|${(x.team||"").toLowerCase()}|${toPriceFloat(x.old)}->${toPriceFloat(x.next)}`).slice(0, 100),
    });

    if (!sig || sig === __LAST_CONF_SIG) return;
    __LAST_CONF_SIG = sig;

    const msg = buildConfirmedMessage(chg);
    if (msg.trim()) await channel.send(msg);
  } catch (e) {
    console.log("Confirmed price watcher error:", e?.message || e);
  }
}


async function generateMatchupPreview(league, gameweek) {
  // Fetch league table and fixtures
  const rows = await fetchLeagueTable(league);
  //console.log("League table data:", rows);

  const teams = normalizeTeams(rows);

  if (!teams.length) {
    console.log("Preview Gen Failed - length of teams");
    return null;
  }

  const fixtures = await fetchFixtures(league, gameweek);
  console.log("Fetched fixtures:", fixtures);


  if (!fixtures || fixtures.length === 0) {
    console.log("Preview Gen Failed - length of fixtures");
    return null;
  }

  const matchups = selectDramaticMatchups(teams, { league, fixtures, gw: gameweek });
  console.log("Selected matchups:", matchups);

  
  if (!matchups || matchups.length === 0) {
    console.log("Preview Gen Failed - length of matchups");
    return null;
  }

  // Format the message for matchups
  // Format the message for matchups (in the style of automated preview messages)
  let lines = [];
  lines.push(`📊 **GW${gameweek} PREVIEW: ${league[0].toUpperCase() + league.slice(1)}** 📊`);

  matchups.forEach((m, idx) => {
    const [a, b] = m.pair;
    const aMent = mentionForOwner(a.owner);
    const bMent = mentionForOwner(b.owner);
    lines.push(`\n**Matchup ${idx + 1}:**`);
    lines.push(`**${a.team}** (${aMent}) [${a.position}] vs **${b.team}** (${bMent}) [${b.position}]`);
    lines.push(`${m.reason}`);
  });

  return lines.join("\n");
}




client.once(Events.ClientReady, async (c) => {
  //try { await maybePostPrevGwSummaries(); } catch (_) {}
  //try { setInterval(maybePostPrevGwSummaries, 24*60*60*1000); } catch (_) {}
  //try { setInterval(() => { maybePostPrevGwSummaries().catch(()=>{}); }, 24*60*60*1000); } catch (_) {}
  try { schedulePrevGwSummaryDailyPT(); } catch (e) { console.log("Summary schedule error:", e?.message || e); }
  try { loadRivalriesSync(); } catch (_) {}
  try { await refreshManagerDiscordMap(); } catch (_) {}
  try { setInterval(refreshManagerDiscordMap, 15*24*60*60*1000); } catch (_) {}
  try { await scheduleDeadlineReminders(); } catch (e) { console.log("Scheduling error:", e?.message || e); }
  try { scheduleWeeklyFplMundoPosts(); } catch (e) { console.log("FPL Mundo schedule error:", e?.message || e); }
  try { await schedulePriceWatchers(client); } catch (e) { console.log("Price schedule error:", e?.message || e); }


  console.log(`Logged in as ${c.user.tag}`);
  await registerCommandsOnReady();
});

// Interaction handler
client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.commandName === "ping") {
    await interaction.reply({ content: "Pong!", ephemeral: true });
    return;
  }

    // NEW: /price_predictions
  if (interaction.commandName === "price_predictions") {
    await handlePricePredictionsCmd(interaction);
    return;
  }

  // NEW: /price_changes
  if (interaction.commandName === "price_changes") {
    await handlePriceChangesCmd(interaction);
    return;
  }

   if (interaction.commandName === "matchup_previews") {
    await interaction.deferReply({ ephemeral: false });

    const league = interaction.options.getString("league", true);
    const gameweek = interaction.options.getInteger("gameweek", true);

    try {
      // Trigger the matchup preview generation
      const previewMessage = await generateMatchupPreview(league, gameweek);

      if (previewMessage) {
        await interaction.editReply(`Here is the matchup preview for GW${gameweek} in the ${league} league:\n\n${previewMessage}`);
      } else {
        await interaction.editReply(`No matchups found for GW${gameweek} in the ${league} league.`);
      }
    } catch (e) {
      console.error("Error generating matchup preview:", e);
      await interaction.editReply("❌ Failed to generate the matchup preview.");
    }
  }

  if (!interaction.isChatInputCommand()) return;

  try {
    // /me
    if (interaction.commandName === "me") {
      await interaction.deferReply({ ephemeral: false });

      const userOpt = interaction.options.getUser?.("user");
      const nameOpt = interaction.options.getString?.("name");
      const idOrName = userOpt ? userOpt.id : (nameOpt || interaction.user.id);

      try {
        const profile = await getProfile(idOrName);
        return await interaction.editReply({ embeds: [makeEmbed(profile)] });
      } catch (e) {
        const display = userOpt ? userOpt.tag : (nameOpt || interaction.user.tag);
        return await interaction.editReply(`❌ Could not find a profile for **${display}**.`);
      }
    }

    // /next_deadline
    if (interaction.commandName === "next_deadline") {
      await interaction.deferReply({ ephemeral: false });

      const ev = await getNextFplEvent();
      if (!ev) {
        return await interaction.editReply("No upcoming FPL deadline found.");
      }

      const deadline = new Date(ev.deadline_time); // UTC from bootstrap-static
      const pst = formatInTZ(deadline, "America/Los_Angeles");
      const est = formatInTZ(deadline, "America/New_York");

      const ms = deadline.getTime() - Date.now();
      const hours = Math.max(0, Math.floor(ms / (1000 * 60 * 60)));
      const mins = Math.max(0, Math.floor((ms % (1000 * 60 * 60)) / (1000 * 60)));
      const remaining = `${hours}h ${mins}m`;

      return await interaction.editReply(
        `🚨 **GW${ev.id} deadline**\n${pst} PST / ${est} EST\nTime remaining: ${remaining}`
      );
    }

    // /setbio
    if (interaction.commandName === "setbio") {
      
      await interaction.deferReply({ ephemeral: false });

      const userOpt = interaction.options.getUser?.("user");
      const nameOpt = interaction.options.getString?.("name");
      const idOrName = userOpt ? userOpt.id : (nameOpt || interaction.user.id);
      const actorId = interaction.user.id;
      const text = interaction.options.getString("text", true);
      

      try {
        ensureCanEditFlexible(actorId, idOrName); // only self or mod
      } catch (e) {
        return await interaction.editReply(`❌ ${e.message || "You don’t have permission to edit this profile."}`);
      }

      try {
        const res = await updateProfile(idOrName, { bio: text }, actorId);
        const display = userOpt ? userOpt.tag : (nameOpt || interaction.user.tag);
        await interaction.editReply(`✅ Bio updated for **${display}**.`);
        return await interaction.followUp({ embeds: [makeEmbed(res.user || res)] });
      } catch (e) {
        return await interaction.editReply(`❌ ${e?.response?.data?.detail || e.message || "Update failed"}`);
      }
    }

    // /setclub
    if (interaction.commandName === "setclub") {
      await interaction.deferReply({ ephemeral: false });

      const userOpt = interaction.options.getUser?.("user");
      const nameOpt = interaction.options.getString?.("name");
      //const idOrName = userOpt ? userOpt.id : (nameOpt || interaction.user.id);
      const actorId = interaction.user.id;
      const club = interaction.options.getString("club", true);
      const target = resolveTarget(interaction); // user/name/self

      try {
        ensureCanEditFlexible(actorId, target); // only self or mod
      } catch (e) {
        return await interaction.editReply(`❌ ${e.message || "You don’t have permission to edit this profile."}`);
      }

      try {
        const idOrName = target.mode === "discord" ? target.discordId : target.name;
        const res = await updateProfile(idOrName, { favorite_club: club }, actorId);
        //const display = userOpt ? userOpt.tag : (nameOpt || interaction.user.tag);
        const display = target.display;
        await interaction.editReply(`✅ Favorite club updated for **${display}**.`);
        return await interaction.followUp({ embeds: [makeEmbed(res.user || res)] });
      } catch (e) {
        return await interaction.editReply(`❌ ${e?.response?.data?.detail || e.message || "Update failed"}`);
      }
    }

    // /setsocial
    if (interaction.commandName === "setsocial") {
      await interaction.deferReply({ ephemeral: false });
      const url = interaction.options.getString("url", true);

      const userOpt = interaction.options.getUser?.("user");
      const nameOpt = interaction.options.getString?.("name");
      const idOrName = userOpt ? userOpt.id : (nameOpt || interaction.user.id);
      const actorId = interaction.user.id;

      try {
        ensureCanEditFlexible(actorId, idOrName); // only self or mod
      } catch (e) {
        return await interaction.editReply(`❌ ${e.message || "You don’t have permission to edit this profile."}`);
      }

      try {
        const res = await updateProfile(idOrName, { social_url: url }, actorId);
        const display = userOpt ? userOpt.tag : (nameOpt || interaction.user.tag);
        await interaction.editReply(`✅ Social URL updated for **${display}**.`);
        return await interaction.followUp({ embeds: [makeEmbed(res.user || res)] });
      } catch (e) {
        return await interaction.editReply(`❌ ${e?.response?.data?.detail || e.message || "Update failed"}`);
      }
    }

    // /setimage
    if (interaction.commandName === "setimage") {
      await interaction.deferReply({ ephemeral: false });
      const url = interaction.options.getString("url", true);

      const userOpt = interaction.options.getUser?.("user");
      const nameOpt = interaction.options.getString?.("name");
      const idOrName = userOpt ? userOpt.id : (nameOpt || interaction.user.id);
      const actorId = interaction.user.id;

      try {
        ensureCanEditFlexible(actorId, idOrName); // only self or mod
      } catch (e) {
        return await interaction.editReply(`❌ ${e.message || "You don’t have permission to edit this profile."}`);
      }

      try {
        const res = await updateProfile(idOrName, { image_url: url }, actorId);
        const display = userOpt ? userOpt.tag : (nameOpt || interaction.user.tag);
        await interaction.editReply(`✅ Image updated for **${display}**.`);
        return await interaction.followUp({ embeds: [makeEmbed(res.user || res)] });
      } catch (e) {
        return await interaction.editReply(`❌ ${e?.response?.data?.detail || e.message || "Update failed"}`);
      }
      
    }

    if (interaction.commandName === "mundo_publish") {
    //await interaction.deferReply({ ephemeral: false });
    await safeDefer(interaction, { ephemeral: false });
    const actorId = interaction.user.id;

    // Require mod (re-use your flexible check)
    try {
      ensureCanEditFlexible(actorId, { mode: "name", isSelf: false, name: "__publish__", display: "publish" });
    } catch (e) {
      return interaction.editReply(`❌ ${e.message || "You don’t have permission to publish."}`);
    }

    const league = interaction.options.getString("league", true);
    const overrideUrl = interaction.options.getString("url") || null;
    const mode = interaction.options.getString("mode") || "auto";
    const max  = interaction.options.getInteger("max") || 4;
    const dryrun = !!interaction.options.getBoolean("dryrun");

    const leagueUrl = overrideUrl ||
      (league === "premier" ? FPL_MUNDO_PREMIER_URL : FPL_MUNDO_CHAMP_URL);

    try {

      let publishedMsg = "";

      const doSplit = async () => await publishFplMundoMulti(leagueUrl, {
        tag: FPL_MUNDO_TAG, imageFallback: FPL_MUNDO_PLACEHOLDER_IMAGE
      });
      const doList  = async () => await publishFplMundoFromList(leagueUrl, {
        tag: FPL_MUNDO_TAG, imageFallback: FPL_MUNDO_PLACEHOLDER_IMAGE, max, dryrun
      });

      let out = null;
      if (mode === "split") {
        out = await doSplit();
        if (!out.sections?.length) {
          return interaction.editReply("⚠️ No sections found (split mode). Try `mode:list`.");
        }
        const ok = out.results.filter(r=>r.ok);
        const fail = out.results.filter(r=>!r.ok);
        publishedMsg =
          `✅ Published ${ok.length}/${out.sections.length} section(s) via split.\n` +
          (ok.length ? `Posted:\n${ok.map(o=>`• ${o.title} (id: ${o.id})`).join("\n")}\n` : "") +
          (fail.length ? `\n❌ Failed:\n${fail.map(f=>`• ${f.title} — ${f.error}`).join("\n")}` : "");
        return interaction.editReply(publishedMsg);
      }

      if (mode === "list") {
        const listOut = await doList();
        if (!listOut.links?.length) return interaction.editReply("⚠️ No article links found on that page.");
        if (dryrun) {
          return interaction.editReply(
            `📝 **Preview (list mode)** — found ${listOut.links.length} links:\n` +
            listOut.links.map((l,i)=>`• ${i+1}. ${l.title || l.url}`).join("\n")
          );
        }
        const ok = listOut.results.filter(r=>r.ok);
        const fail = listOut.results.filter(r=>!r.ok);
        publishedMsg =
          `✅ Published ${ok.length}/${listOut.links.length} post(s) from the page.\n` +
          (ok.length ? `Posted:\n${ok.map(o=>`• ${o.title} (id: ${o.id ?? "—"})`).join("\n")}\n` : "") +
          (fail.length ? `\n❌ Failed:\n${fail.map(f=>`• ${f.title} — ${f.error}`).join("\n")}` : "");
        return interaction.editReply(publishedMsg);
      }

      // mode === auto : try split first, then list as fallback
      let splitOut = await doSplit();
      if (splitOut.sections?.length >= 2) {
        const ok = splitOut.results.filter(r=>r.ok);
        const fail = splitOut.results.filter(r=>!r.ok);
        publishedMsg =
          `✅ Published ${ok.length}/${splitOut.sections.length} section(s) via split.\n` +
          (ok.length ? `Posted:\n${ok.map(o=>`• ${o.title} (id: ${o.id})`).join("\n")}\n` : "") +
          (fail.length ? `\n❌ Failed:\n${fail.map(f=>`• ${f.title} — ${f.error}`).join("\n")}` : "");
        return interaction.editReply(publishedMsg);
      }

      // fallback to list mode
      const listOut = await doList();
      if (!listOut.links?.length) {
        return interaction.editReply("⚠️ No sections and no article links found on that page.");
      }
      if (dryrun) {
        return interaction.editReply(
          `📝 **Preview (auto→list)** — found ${listOut.links.length} links:\n` +
          listOut.links.map((l,i)=>`• ${i+1}. ${l.title || l.url}`).join("\n")
        );
      }
      const ok = listOut.results.filter(r=>r.ok);
      const fail = listOut.results.filter(r=>!r.ok);
      publishedMsg =
        `✅ Published ${ok.length}/${listOut.links.length} post(s) (auto→list).\n` +
        (ok.length ? `Posted:\n${ok.map(o=>`• ${o.title} (id: ${o.id ?? "—"})`).join("\n")}\n` : "") +
        (fail.length ? `\n❌ Failed:\n${fail.map(f=>`• ${f.title} — ${f.error}`).join("\n")}` : "");
      return interaction.editReply(publishedMsg);

      // if (dryrun) {
      //   const titles = sections.map((s,i)=>`• ${i+1}. ${s.title}`).join("\n");
      //   return interaction.editReply(`📝 **Preview only** — found ${sections.length} sections on ${league} page:\n${titles}`);
      // }

      // // summarize published
      // const ok = results.filter(r => r.ok);
      // const fail = results.filter(r => !r.ok);
      // let msg = `✅ Published ${ok.length}/${sections.length} section(s) from the ${league} page.`;
      // if (ok.length) msg += `\nPosted:\n${ok.map(o=>`• ${o.title} (id: ${o.id})`).join("\n")}`;
      // if (fail.length) msg += `\n\n❌ Failed:\n${fail.map(f=>`• ${f.title} — ${f.error}`).join("\n")}`;
      // return interaction.editReply(msg);

    } catch (e) {
      console.error("mundo_publish error:", e);
      return interaction.editReply(`❌ Failed to process that page: ${e?.message || e}`);
    }
}




    // Publishing: still restricted to mods (uses ensureCanEditFlexible with dummy target)
    if (interaction.commandName === "publish_news") {
      const title = interaction.options.getString("title", true);
      const tags = interaction.options.getString("tags") || "";
      const excerpt = interaction.options.getString("excerpt") || "";
      const imageUrlInput = interaction.options.getString("image_url") || "";
      const imageFromFile = firstAttachmentUrl(interaction);
      const image_url = imageFromFile || imageUrlInput || null;
      const content = interaction.options.getString("content", true);
      const actorId = interaction.user.id;

      // Require mod: emulate a non-self edit to trigger mod requirement
      ensureCanEditFlexible(actorId, { mode: "name", isSelf: false, name: "__publish__", display: "publish" });

      await interaction.deferReply({ ephemeral: false });
      const result = await postNews({
        title,
        tags,                      // string accepted by backend; it's split there
        excerpt,
        image_url,
        content_markdown: content, // backend converts to HTML
        author: `${interaction.user.tag} (${interaction.user.id})`,
      });

      const url = `${SITE_BASE}/news/${result.id}`;
      return await interaction.editReply(`✅ Published **${title}** — ${url}`);
    }

    if (interaction.commandName === "news_quick") {
      const title = interaction.options.getString("title", true);
      const tags = interaction.options.getString("tags") || "";
      const content = interaction.options.getString("content", true);
      const excerpt = interaction.options.getString("excerpt") || "";
      const image_url = interaction.options.getString("image_url") || null;
      const actorId = interaction.user.id;

      // Require mod
      ensureCanEditFlexible(actorId, { mode: "name", isSelf: false, name: "__publish__", display: "publish" });

      await interaction.deferReply({ ephemeral: false });
      const result = await postNews({
        title,
        tags,
        excerpt,
        image_url,
        content_markdown: content,
        author: `${interaction.user.tag} (${interaction.user.id})`,
      });

      const url = `${SITE_BASE}/news/${result.id}`;
      return await interaction.editReply(`✅ Published **${title}** — ${url}`);
    }

  } catch (err) {
    console.error(err?.response?.data || err);
    const detail = err?.response?.data?.detail || err?.message || "Unknown error";
    if (interaction.replied || interaction.deferred) {
      return interaction.followUp({ content: `❌ ${detail}`, ephemeral: true });
    }
    return interaction.reply({ content: `❌ ${detail}`, ephemeral: true });
  }
});

// =================== FPL Mundo inbound endpoint (from GitHub Actions) ===================
// Set on Railway → Variables: BOT_SECRET = (strong random)
const BOT_SECRET = process.env.BOT_SECRET;

// Parse one "/publish_news ..." line into fields our postNews(...) expects
function parsePublishCommand(line) {
  if (!line || !/^\/publish_news\b/.test(line)) return null;

  // Find key positions: title|content|tags|excerpt|image_url
  const pattern = new RegExp(String.raw`(?:^|\s)(title|content|tags|excerpt|image_url):\s`, "ig");
  const positions = [];
  let m;
  while ((m = pattern.exec(line)) !== null) {
    positions.push({ key: m[1].toLowerCase(), index: m.index + m[0].length });
  }
  if (!positions.length) return null;

  const obj = {};
  for (let i = 0; i < positions.length; i++) {
    const { key, index } = positions[i];
    const end = (i + 1 < positions.length)
      ? positions[i + 1].index - positions[i + 1].key.length - 2
      : line.length;
    obj[key] = line.slice(index, end).trim();
  }
  return {
    title: (obj.title || "").trim(),
    content: (obj.content || "").trim(),
    tags: (obj.tags || "").trim(),
    excerpt: (obj.excerpt || "").trim(),
    image_url: (obj.image_url || "").trim() || null,
  };
}

// Trust reverse proxy (Railway) for correct IP logging
app.set("trust proxy", true);

// Simple health check so Actions can verify reachability
app.get("/health", (req, res) => {
  console.log(`[health] GET from ${req.ip || "unknown"} @ ${new Date().toISOString()}`);
  res.json({ ok: true, service: "fpl-discord-bot", ts: Date.now() });
});

// Enhanced logging for publish endpoint
app.post("/publish-news", async (req, res) => {
  console.log(`[publish-news] POST from ${req.ip || "unknown"} size=${(JSON.stringify(req.body)||"").length}`);
  try {
    if (!BOT_SECRET || req.get("x-auth") !== BOT_SECRET) {
      console.warn("[publish-news] unauthorized");
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    const payload = req.body;
    const cmds = Array.isArray(payload) ? payload
              : Array.isArray(payload?.commands) ? payload.commands
              : [];

    if (!cmds.length) {
      console.warn("[publish-news] empty commands");
      return res.status(400).json({ ok: false, error: "no commands" });
    }

    const results = [];
    for (const line of cmds) {
      const parsed = parsePublishCommand(String(line));
      if (!parsed) {
        results.push({ line: String(line).slice(0, 80), ok: false, error: "not a /publish_news line" });
        continue;
      }

      const news = {
        title: parsed.title,
        tags: parsed.tags, // change to split(',') if  backend expects array
        excerpt: parsed.excerpt,
        image_url: parsed.image_url || null,
        content_markdown: parsed.content,
        author: "FPL Mundo Bot (Action)",
      };

      try {
        const resNews = await postNews(news); //  existing function
        console.log(`[publish-news] Posted: "${parsed.title}" →`, resNews);
        if (resNews?.error || resNews?.status === "error") {
          results.push({ line: parsed.title, ok: false, error: resNews.error || "backend error" });
        } else {
          results.push({ line: parsed.title, ok: true, id: resNews?.id || null });
        }
      } catch (e) {
        const detail = e?.response?.data?.detail || e?.message || "publish failed";
        console.error(`[publish-news] FAILED for "${parsed.title}":`, detail);
        results.push({ line: parsed.title, ok: false, error: detail });
      }
    }

    // Discord summary
    const channelId = process.env.TFPLA_CHANNEL_ID;
    if (channelId) {
      try {
        const ch = await client.channels.fetch(channelId);
        if (ch) {
          const success = results.filter(r => r.ok).length;
          const failed = results.length - success;
          await ch.send(
            `📢 **FPL Mundo Auto-Publish** (${payload.source || "unknown"})\n` +
            `✅ ${success} succeeded, ❌ ${failed} failed.\n` +
            results.map(r =>
              `${r.ok ? "✅" : "❌"} ${r.line}${r.error ? ` → ${r.error}` : ""}`
            ).join("\n")
          );
        }
      } catch (err) {
        console.error("[publish-news] Failed to send Discord summary:", err);
      }
    }

    return res.json({ ok: true, count: results.length, results });
  } catch (err) {
    console.error("[/publish-news] error", err);
    return res.status(500).json({ ok: false, error: "server error" });
  }
});


// Railway will expose this port
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`[server] listening on ${PORT}`));


client.login(process.env.BOT_TOKEN);
