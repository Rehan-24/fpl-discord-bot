require("dotenv").config();
const {
  Client, GatewayIntentBits, EmbedBuilder, Events, Routes, REST
} = require("discord.js");
const axios = require("axios");

// ===== CONFIG =====
const BASE = "https://tfpl.onrender.com/api".replace(/\/+$/, "");
if (!BASE) throw new Error("BACKEND_URL not set");
const API_HEADERS = {};
if (process.env.API_KEY) API_HEADERS["X-Api-Key"] = process.env.API_KEY;

const SITE_BASE = (process.env.SITE_BASE || "https://tfpl.vercel.app").replace(/\/+$/, "");

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
  const headers = { ...API_HEADERS, actor_id: String(actorId) };
  const { data } = await axios.post(url, fields, { headers });
  return data;
}

async function postNews(payload) {
  // expects backend /api/news from your FastAPI router
  const res = await axios.post(`${BASE}/news`, payload, { headers: API_HEADERS, timeout: 20000 });
  return res.data; // { ok: true, id: "<slug-YYYY-MM-DD>" }
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

// Try multiple endpoints to fetch league tables; return [] on failure
async function fetchLeagueTable(league) {
  const urls = [];
  if (process.env[`LEAGUE_TABLE_ENDPOINT_${league.toUpperCase()}`]) {
    urls.push(process.env[`LEAGUE_TABLE_ENDPOINT_${league.toUpperCase()}`]);
  }
  // Try backend then site fallbacks
  urls.push(
    `${BASE}/league/${league}`,
    `${BASE}/${league}`,
    `${SITE_BASE}/api/${league}`
  );
  for (const u of urls) {
    try {
      const { data } = await axios.get(u);
      // Expect array of teams or {teams:[...]}
      const arr = Array.isArray(data) ? data : (data.teams || data.table || data.rows || []);
      if (Array.isArray(arr) && arr.length) return arr;
    } catch (e) {
      /* try next */
    }
  }
  return [];
}

// Basic normalize to known fields
function normalizeTeams(rows) {
  return rows.map((r, i) => ({
    position: Number(r.position || r.rank || i + 1),
    team: r.team || r.team_name || r.name || "Unknown Team",
    owner: r.owner || r.manager || r.owner_name || r.user || r.coach || "Unknown",
    totalScore: Number(r.total_score || r.score || r.total || r.season_points || 0),
    h2hPoints: Number(r.points || r.h2h_points || r.h2h || 0),
    value: Number(r.value || r.team_value || 0),
    recent: r.form || r.recent || "",
  })).sort((a,b)=>a.position-b.position);
}

// Heuristic "drama" scoring and pairing (not actual fixtures)
function selectDramaticMatchups(teams, {league, fixtures, gw} = {}) {
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
  const urls = [];
  const key = `LEAGUE_FIXTURES_ENDPOINT_${league.toUpperCase()}`;
  if (process.env[key]) urls.push(process.env[key]);
  if (process.env.LEAGUE_FIXTURES_ENDPOINT) urls.push(process.env.LEAGUE_FIXTURES_ENDPOINT);
  const hydrate = (u) => u.replace(/\{gw\}/g, String(gw)).replace(/\{league\}/g, league);
  for (let u of urls) {
    try {
      u = hydrate(u);
      const { data } = await axios.get(u, { headers: API_HEADERS });
      if (Array.isArray(data) && data.length) return data;
      const arr = data?.fixtures || data?.matches;
      if (Array.isArray(arr) && arr.length) return arr;
    } catch (e) { /* try next */ }
  }

  // Fallback: FPL public H2H endpoint if LEAGUE_FPL_H2H_ID_<LEAGUE> (or global) is set
  const idKey = `LEAGUE_FPL_H2H_ID_${league.toUpperCase()}`;
  const h2hId = process.env[idKey] || process.env.LEAGUE_FPL_H2H_ID || DEFAULT_FPL_H2H_IDS[league];
  if (h2hId) {
    try {
      // Paginate until has_next==false
      const fixtures = [];
      let page = 1, hasNext = true;
      while (hasNext) {
        const url = `https://fantasy.premierleague.com/api/leagues-h2h-matches/league/${h2hId}/?event=${gw}&page=${page}`;
        const { data } = await axios.get(url);
        const res = data?.results || data?.standings?.results || data?.matches_next?.results || data?.matches?.results;
        if (Array.isArray(res)) {
          for (const fx of res) {
            fixtures.push({
              a_owner: fx.entry_1_player_name,
              b_owner: fx.entry_2_player_name,
              a_team: fx.entry_1_name,
              b_team: fx.entry_2_name,
            });
          }
        }
        hasNext = !!data?.has_next || !!data?.standings?.has_next || !!data?.matches?.has_next || false;
        page += 1;
        if (page > 50) break; // safety
      }
      if (fixtures.length) return fixtures;
    } catch (e) {
      console.log("FPL H2H fixtures fetch failed:", e?.response?.status || "", e?.message || e);
    }
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
  lines.push(`📊 GW ${prevGw} SUMMARY: ${league[0].toUpperCase()+league.slice(1)}`);

async function maybePostPrevGwSummaries() {
  if (!REMINDER_CHANNEL_ID) return;
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
  const prev = events.find(e => e.is_previous);
  if (!prev) return;

  const prevGw = prev.id;
  if (__LAST_SUMMARY_POSTED_GW === prevGw) return; // already posted

  const deadline = new Date(prev.deadline_time); // end point for the GW in UTC
  const now = new Date();
  const elapsedMs = now.getTime() - deadline.getTime();

  // Wait until 12 hours after the deadline to allow final updates
  if (elapsedMs < 12*60*60*1000) {
    // Not yet time
    return;
  }

  try {
    for (const league of LEAGUES) {
      const sum = await summarizePreviousGW(league, prevGw);
      const msg = formatPrevGwSummaryMessage(league, prevGw, sum);
      await channel.send(msg);
    }
    __LAST_SUMMARY_POSTED_GW = prevGw;
    console.log(`Posted previous GW summaries for GW${prevGw}.`);
  } catch (e) {
    console.log("maybePostPrevGwSummaries: posting failed", e?.message || e);
  }
}

  if (!summary || !summary.chosen || !summary.chosen.length) {
    lines.push("No completed results found.");
    return lines.join("\n");
  }
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
    i++;
  }
  if (hi) lines.push(`Highest scorer: **${hi.team} (${mentionForOwner(hi.owner)}) — ${hi.pts}**`);
  if (lo) lines.push(`Lowest scorer: **${lo.team} (${mentionForOwner(lo.owner)}) — ${lo.pts}**`);
  return lines.join("\n");
}


async function scheduleDeadlineReminders() {
  if (!REMINDER_CHANNEL_ID) {
    console.log("DEADLINE_CHANNEL_ID not set — skipping deadline reminders.");
    return;
  }
  let channel;
  try {
    channel = await client.channels.fetch(REMINDER_CHANNEL_ID);
  } catch (e) {
    console.log("Unable to fetch reminder channel:", e?.message || e);
    return;
  }
  const ev = await getNextFplEvent();
  if (!ev) {
    console.log("No upcoming FPL event found to schedule.");
    return;
  }
  const deadline = new Date(ev.deadline_time); // UTC from FPL API
  const oneDayBefore = new Date(deadline.getTime() - 24 * 60 * 60 * 1000);
  const oneHourBefore = new Date(deadline.getTime() - 60 * 60 * 1000);
  const now = new Date();

  clearReminders();

const scheduleAt = (when, label) => {
  const ms = when.getTime() - now.getTime();
  if (ms <= 0) return;
  const t = setTimeout(async () => {
    try {
      const pst = formatInTZ(deadline, "America/Los_Angeles");
      const est = formatInTZ(deadline, "America/New_York");
      await channel.send(
        `🚨🚨🚨 @everyone 🚨🚨🚨 \n**GW${ev.id} is ${label}(s) away!**\n${pst} PST / ${est} EST`
      );
    } catch (e) {
      console.error("Failed to send reminder:", e?.message || e);
    }
  }, ms);
  __scheduledTimeouts.push(t);
};


  scheduleAt(oneDayBefore, "24-hour");

  // Also send GW previews per league at 24h
  try {
    const previews = [];
    for (const league of LEAGUES) {
      const rows = await fetchLeagueTable(league);
      const teams = normalizeTeams(rows);
      if (!teams.length) continue;
      const fixtures = await fetchFixtures(league, ev.id);
      const picks = selectDramaticMatchups(teams, {league, fixtures, gw: ev.id});
      if (!picks.length) continue;

      rememberPreviews(league, ev.id, picks);

      previews.push(formatPreviewMessage(league, ev.id, picks));
    }

    if (previews.length) {
      await channel.send(previews.join("\n\n"));
    }
  } catch (e) { console.log("Preview generation failed:", e?.message || e); }

  scheduleAt(oneHourBefore, "1-hour");

  // After the deadline passes, re-run scheduling to pick up the next GW.
  const reschedMs = Math.max(deadline.getTime() - now.getTime() + 60 * 1000, 60 * 60 * 1000);
  __scheduledTimeouts.push(setTimeout(scheduleDeadlineReminders, reschedMs));

  console.log(`Scheduled GW${ev.id} reminders: 24h @ ${oneDayBefore.toISOString()}, 1h @ ${oneHourBefore.toISOString()}, deadline @ ${deadline.toISOString()}`);
}
client.once(Events.ClientReady, async (c) => {
  try { await maybePostPrevGwSummaries(); } catch (_) {}
  try { setInterval(maybePostPrevGwSummaries, 24*60*60*1000); } catch (_) {}

  try { loadRivalriesSync(); } catch (_) {}

  try { await refreshManagerDiscordMap(); } catch (_) {}
  try { setInterval(refreshManagerDiscordMap, 15*24*60*60*1000); } catch (_) {}

  try { await scheduleDeadlineReminders(); } catch (e) { console.log("Scheduling error:", e?.message || e); }
  console.log(`Logged in as ${c.user.tag}`);
  await registerCommandsOnReady();
});

// Interaction handler
client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.commandName === "ping") {
    await interaction.reply({ content: "Pong!", ephemeral: true });
    return;
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
        ensureCanEditFlexible(actorId, target); // only self or mod
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
      const idOrName = userOpt ? userOpt.id : (nameOpt || interaction.user.id);
      const actorId = interaction.user.id;
      const club = interaction.options.getString("club", true);

      try {
        ensureCanEditFlexible(actorId, idOrName); // only self or mod
      } catch (e) {
        return await interaction.editReply(`❌ ${e.message || "You don’t have permission to edit this profile."}`);
      }

      try {
        const res = await updateProfile(idOrName, { favorite_club: club }, actorId);
        const display = userOpt ? userOpt.tag : (nameOpt || interaction.user.tag);
        await interaction.editReply(`✅ Favorite club updated for **${display}**.`);
        return await interaction.followUp({ embeds: [makeEmbed(res.user || res)] });
      } catch (e) {
        return await interaction.editReply(`❌ ${e?.response?.data?.detail || e.message || "Update failed"}`);
      }
    }

    // /setsocial
    if (interaction.commandName === "setsocial") {
      await interaction.deferReply({ ephemeral: true });
      const url = interaction.options.getString("url", true);

      const target = resolveTarget(interaction);
      const actorId = interaction.user.id;

      try {
        ensureCanEditFlexible(actorId, target); // only self or mod
      } catch (e) {
        return await interaction.editReply(`❌ ${e.message || "You don’t have permission to edit this profile."}`);
      }

      try {
        const res = await updateProfile(target, { social_url: url }, actorId);
        await interaction.editReply(`✅ Social URL updated for **${target.display}**.`);
        return await interaction.followUp({ embeds: [makeEmbed(res.user || res)] });
      } catch (e) {
        return await interaction.editReply(`❌ ${e?.response?.data?.detail || e.message || "Update failed"}`);
      }
    }

    // /setimage
    if (interaction.commandName === "setimage") {
      await interaction.deferReply({ ephemeral: true });
      const url = interaction.options.getString("url", true);

      const target = resolveTarget(interaction);
      const actorId = interaction.user.id;

      try {
        ensureCanEditFlexible(actorId, target); // only self or mod
      } catch (e) {
        return await interaction.editReply(`❌ ${e.message || "You don’t have permission to edit this profile."}`);
      }

      try {
        const res = await updateProfile(target, { image_url: url }, actorId);
        await interaction.editReply(`✅ Image updated for **${target.display}**.`);
        return await interaction.followUp({ embeds: [makeEmbed(res.user || res)] });
      } catch (e) {
        return await interaction.editReply(`❌ ${e?.response?.data?.detail || e.message || "Update failed"}`);
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

client.login(process.env.BOT_TOKEN);
