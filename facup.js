// ============================================================
// FA Cup Discord Bot Module
// Drop this file into the fpl-discord-bot directory.
// Then add the following to index.js:
//
//   Near the top (after requires):
//     const facup = require("./facup");
//
//   In client.once(Events.ClientReady, ...) alongside the other schedulers:
//     try { facup.scheduleFaCupReminders(client); } catch(e) { console.log("FA Cup schedule error:", e?.message || e); }
//     try { facup.scheduleFaCupRoundSummary(client); } catch(e) { console.log("FA Cup summary error:", e?.message || e); }
//
//   In the interactionCreate handler:
//     if (interaction.commandName === "fa_opp") { await facup.handleFaOpp(interaction); return; }
//
//   In deploy-commands.js, add to the commands array:
//     require("./facup").faOppCommand,
// ============================================================

require("dotenv").config();
const axios = require("axios");
const { SlashCommandBuilder, EmbedBuilder } = require("discord.js");

// ── Config ────────────────────────────────────────────────────────────────────

const BASE          = "https://tfpl.onrender.com/api";
const SITE_BASE     = (process.env.SITE_BASE || "https://tfpl.vercel.app").replace(/\/$/, "");
const FACUP_URL     = `${SITE_BASE}/facup`;
const CHANNEL_ID    = process.env.DEADLINE_CHANNEL_ID;   // reuse same channel as deadline reminders
const TZ            = process.env.TZ || "America/Los_Angeles";
const FA_CUP_SEASON = process.env.FA_CUP_SEASON || "2025-26";

// FA Cup GW schedule — update these if the tournament GWs change
const FA_CUP_ROUNDS = [
  { round: "r1",    label: "Round 1",       gw: 31 },
  { round: "r32",   label: "Round of 32",   gw: 32 },
  { round: "r16",   label: "Round of 16",   gw: 33 },
  { round: "qf",    label: "Quarterfinals", gw: 34 },
  { round: "sf",    label: "Semifinals",    gw: 35 },
  { round: "final", label: "Final",         gw: 36 },
  { round: "3rd",   label: "3rd Place",     gw: 36 },
];

// match numbers mirror facupSeedings.ts matchNums assignment:
// R1: M1-M4, R32: M5-M20, R16: M21-M28, QF: M29-M32, SF: M33-M34, Final: M35, 3rd: M36
function getMatchNum(round, matchup_idx) {
  const offsets = { r1: 1, r32: 5, r16: 21, qf: 29, sf: 33, final: 35, "3rd": 36 };
  return (offsets[round] ?? 0) + matchup_idx;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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
    return date.toUTCString();
  }
}

function msUntilNextDaily(hour, minute, tz) {
  const now = new Date();
  const tzNow = new Date(now.toLocaleString("en-US", { timeZone: tz }));
  const offset = tzNow.getTime() - now.getTime();
  const target = new Date(tzNow);
  target.setHours(hour, minute, 0, 0);
  if (target <= tzNow) target.setDate(target.getDate() + 1);
  return Math.max(0, target.getTime() - offset - now.getTime());
}

function scheduleDailyInTz(label, hour, minute, tz, fn) {
  const scheduleNext = () => {
    const ms = msUntilNextDaily(hour, minute, tz);
    console.log(`[${label}] next run in ${Math.round(ms / 60000)} min`);
    setTimeout(async () => {
      try { await fn(); } catch (e) { console.log(`[${label}] error:`, e?.message || e); }
      finally { scheduleNext(); }
    }, ms);
  };
  scheduleNext();
}

async function fetchBootstrap() {
  const res = await axios.get(
    "https://fantasy.premierleague.com/api/bootstrap-static/",
    { timeout: 15000, headers: { "User-Agent": "tfpl-bot/1.0 (+https://tfpl.vercel.app)" } }
  );
  return res.data;
}

// Fetch FA Cup bracket from the backend
async function fetchBracket() {
  const res = await axios.get(`${BASE}/facup/bracket`, {
    params: { season: FA_CUP_SEASON },
    timeout: 15000,
  });
  return res.data?.bracket ?? [];
}

// Fetch FA Cup GW scores from the backend
async function fetchFaCupScores(gw) {
  const res = await axios.get(`${BASE}/facup/scores`, {
    params: { gw },
    timeout: 15000,
  });
  return res.data?.scores ?? [];
}

// Seed number → team name (mirrors facupSeedings.ts)
const SEED_TEAMS = {
  1:"Klopp's Resurgence", 2:"Cheeks FC", 3:"Cincy Til I Cry", 4:"FC Wincinnati",
  5:"Noni to be upset", 6:"Shege FC", 7:"Slopeds FC", 8:"wizards",
  9:"Bend It Like Declan", 10:"Beans and Rice", 11:"Too Slot To Handle", 12:"ReecesPieces",
  13:"Defense and DarkArts", 14:"I miss jamie vardy", 15:"Siuuuuu Later", 16:"2026 Champions",
  17:"Carter's Angels", 18:"Artetanyahu", 19:"Cech Mate", 20:"FirstPlaceBelow",
  21:"Peaky Reijnders", 22:"Liberties&Lotteries", 23:"Peps Lads", 24:"somethimg",
  25:"lamine yamal party", 26:"Rolls Rice", 27:"Eze Dub", 28:"The Tigers",
  29:"Boogie Woogie", 30:"halaand is washed", 31:"Aches and Pains", 32:"Fred's Red Army",
  33:"Bamford's Baddies", 34:"livin saliba loca", 35:"hands", 36:"ur dads fav team",
  37:"Mandem FC", 38:"Cheeks Fc", 39:"Soccer Team", 40:"Red_Devils",
};

function seedName(s) { return s ? (SEED_TEAMS[s] ?? `Seed ${s}`) : "TBD"; }

// Given a team name fragment, find their current bracket matchup
function findMatchupForTeam(bracket, query) {
  const q = query.trim().toLowerCase();
  for (const m of bracket) {
    const t1 = seedName(m.seed1).toLowerCase();
    const t2 = seedName(m.seed2).toLowerCase();
    if (
      (t1.includes(q) || t2.includes(q)) &&
      !m.winner_seed  // still active — not yet eliminated
    ) {
      return m;
    }
  }
  // Fallback: find most recent (highest round) matchup for this team
  const roundOrder = { r1:1, r32:2, r16:3, qf:4, sf:5, final:6, "3rd":7 };
  return bracket
    .filter(m => {
      const t1 = seedName(m.seed1).toLowerCase();
      const t2 = seedName(m.seed2).toLowerCase();
      return t1.includes(q) || t2.includes(q);
    })
    .sort((a, b) => (roundOrder[b.round] ?? 0) - (roundOrder[a.round] ?? 0))[0] ?? null;
}

// ── 1. FA Cup 36-hour reminder ────────────────────────────────────────────────
// Fires 36 hours before any GW that contains a FA Cup round.
// Piggybacks on the FPL bootstrap deadline data.

let __facupReminderTimeouts = [];

async function scheduleFaCupReminders(client) {
  if (!CHANNEL_ID) {
    console.log("[FA Cup Reminder] DEADLINE_CHANNEL_ID not set – skipping.");
    return;
  }

  // Clear any previously scheduled FA Cup reminders
  for (const t of __facupReminderTimeouts) clearTimeout(t);
  __facupReminderTimeouts = [];

  let channel;
  try {
    channel = await client.channels.fetch(CHANNEL_ID);
  } catch (e) {
    console.log("[FA Cup Reminder] Cannot fetch channel:", e?.message || e);
    return;
  }

  let bootstrap;
  try {
    bootstrap = await fetchBootstrap();
  } catch (e) {
    console.log("[FA Cup Reminder] Bootstrap fetch failed:", e?.message || e);
    // Retry in 1 hour
    setTimeout(() => scheduleFaCupReminders(client), 60 * 60 * 1000);
    return;
  }

  const events = bootstrap?.events ?? [];
  const now = new Date();

  // Max safe setTimeout delay — JS setTimeout overflows at ~24.8 days (2^31 ms)
  // and fires immediately. FA Cup rounds are weeks apart so we only schedule
  // the NEXT upcoming reminder; after it fires we re-run to pick up the next one.
  const MAX_TIMEOUT_MS = 2_000_000_000; // ~23 days, safely under 32-bit limit

  const upcomingRounds = FA_CUP_ROUNDS
    .filter(r => r.round !== "3rd")
    .map(r => {
      const event = events.find(e => e.id === r.gw);
      if (!event?.deadline_time) return null;
      const deadline = new Date(event.deadline_time);
      const fireAt   = new Date(deadline.getTime() - 36 * 60 * 60 * 1000);
      const msUntil  = fireAt.getTime() - now.getTime();
      return { round: r, deadline, fireAt, msUntil };
    })
    .filter(r => r !== null && r.msUntil > 0)
    .sort((a, b) => a.msUntil - b.msUntil); // soonest first

  if (!upcomingRounds.length) {
    console.log("[FA Cup Reminder] No upcoming FA Cup rounds to schedule — rechecking in 7 days.");
    __facupReminderTimeouts.push(
      setTimeout(() => scheduleFaCupReminders(client), 7 * 24 * 60 * 60 * 1000)
    );
    return;
  }

  // Only schedule the NEXT reminder. Re-run this function after it fires.
  const next = upcomingRounds[0];
  const scheduleMs = Math.min(next.msUntil, MAX_TIMEOUT_MS);
  const isDeferred  = scheduleMs < next.msUntil;

  console.log(
    `[FA Cup Reminder] ${isDeferred ? "Deferring" : "Scheduling"} ` +
    `${next.round.label} (GW${next.round.gw}) reminder for ` +
    `${next.fireAt.toISOString()} (in ${Math.round(next.msUntil / 3600000)}h)`
  );

  const t = setTimeout(async () => {
    if (isDeferred) {
      // Not time yet — just re-check closer to the actual fire time
      await scheduleFaCupReminders(client);
      return;
    }
    try {
      const { round, deadline } = next;
      const pst = formatInTZ(deadline, "America/Los_Angeles");
      const est = formatInTZ(deadline, "America/New_York");

      const embed = new EmbedBuilder()
        .setColor(0x5b329e)
        .setTitle(`⚽ FA Cup — ${round.label} kicks off in 36 hours!`)
        .setDescription(
          `**GW${round.gw} deadline:** ${pst} PST / ${est} EST\n\n` +
          `Make sure your squad is set — your GW${round.gw} score will decide your FA Cup matchup!\n\n` +
          `🏆 [View the full FA Cup bracket](${FACUP_URL})`
        )
        .setFooter({ text: "TFPL Fantasy FA Cup • tfpl.vercel.app/facup" });

      await channel.send({ content: "@everyone", embeds: [embed] });
      console.log(`[FA Cup Reminder] Sent ${round.label} reminder.`);
    } catch (e) {
      console.log(`[FA Cup Reminder] Failed to send reminder:`, e?.message || e);
    }
    // Re-run to schedule the next round's reminder
    await scheduleFaCupReminders(client);
  }, scheduleMs);

  __facupReminderTimeouts.push(t);
}

// ── 2. FA Cup round summary (posted after each round finishes) ─────────────────
// Runs daily at 18:05 PT (same as the GW summary).
// Checks if a FA Cup round just finished and posts results if it hasn't been posted yet.

let __lastPostedFaCupRound = null; // "r1", "r32", etc.

async function scheduleFaCupRoundSummary(client) {
  scheduleDailyInTz("FA Cup Round Summary", 18, 5, TZ, async () => {
    await maybePostFaCupRoundSummary(client);
  });
  // Also run once immediately in case bot restarted after a round ended
  await maybePostFaCupRoundSummary(client).catch(() => {});
}

async function maybePostFaCupRoundSummary(client) {
  if (!CHANNEL_ID) return;

  let channel;
  try {
    channel = await client.channels.fetch(CHANNEL_ID);
  } catch (e) {
    console.log("[FA Cup Summary] Cannot fetch channel:", e?.message || e);
    return;
  }

  // Fetch FPL bootstrap to figure out which GW just finished
  let bootstrap;
  try {
    bootstrap = await fetchBootstrap();
  } catch (e) {
    console.log("[FA Cup Summary] Bootstrap fetch failed:", e?.message || e);
    return;
  }

  const events    = bootstrap?.events ?? [];
  const now       = new Date();

  // Find the GW that most recently had its deadline pass and is finished/data_checked
  const recentFinished = events
    .filter(e => {
      const dl = e.deadline_time ? new Date(e.deadline_time) : null;
      return dl && dl < now && (e.finished || e.is_finished || e.data_checked);
    })
    .sort((a, b) => b.id - a.id)[0];

  if (!recentFinished) return;
  const finishedGw = recentFinished.id;

  // Find the FA Cup round(s) that used this GW
  const roundsThisGw = FA_CUP_ROUNDS.filter(r => r.gw === finishedGw);
  if (!roundsThisGw.length) return; // not a FA Cup GW

  // Check if we already posted this round
  const roundKey = roundsThisGw.map(r => r.round).join("+");
  if (__lastPostedFaCupRound === roundKey) return;

  // Fetch bracket
  let bracket;
  try {
    bracket = await fetchBracket();
  } catch (e) {
    console.log("[FA Cup Summary] Bracket fetch failed:", e?.message || e);
    return;
  }

  // For each round in this GW, find all completed matchups
  for (const round of roundsThisGw) {
    const matchups = bracket.filter(m => m.round === round.round);
    const completed = matchups.filter(m => m.winner_seed != null);
    if (!completed.length) {
      console.log(`[FA Cup Summary] ${round.label} has no completed matchups yet — skipping.`);
      return; // data not ready yet
    }

    // Build the results embed
    const resultsLines = completed.map(m => {
      const t1    = seedName(m.seed1);
      const t2    = seedName(m.seed2);
      const s1    = m.score1 ?? "?";
      const s2    = m.score2 ?? "?";
      const matchNum = getMatchNum(m.round, m.matchup_idx);
      const winner = m.winner_seed === m.seed1 ? t1 : t2;
      const loser  = m.winner_seed === m.seed1 ? t2 : t1;
      const ws     = m.winner_seed === m.seed1 ? s1 : s2;
      const ls     = m.winner_seed === m.seed1 ? s2 : s1;

      // Detect tiebreaker
      const tied = m.score1 != null && m.score2 != null && m.score1 === m.score2;
      const tieNote = tied ? " *(tiebreaker: goals)*" : "";

      return `**M${matchNum}** ✅ **${winner}** ${ws} – ${ls} ${loser}${tieNote}`;
    });

    // Count how many seeds from each league advanced
    const premAdv  = completed.filter(m => {
      const ws = SEED_TEAMS[m.winner_seed];
      return ws !== undefined; // basic check — you could add league lookup here
    }).length;

    const embed = new EmbedBuilder()
      .setColor(0x5b329e)
      .setTitle(`🏆 FA Cup — ${round.label} Results (GW${finishedGw})`)
      .setDescription(
        resultsLines.join("\n") +
        `\n\n[View the full bracket](${FACUP_URL})`
      )
      .setFooter({ text: "TFPL Fantasy FA Cup • tfpl.vercel.app/facup" });

    await channel.send({ embeds: [embed] });
    console.log(`[FA Cup Summary] Posted ${round.label} results for GW${finishedGw}.`);
  }

  __lastPostedFaCupRound = roundKey;
}

// ── 3. /fa_opp slash command ───────────────────────────────────────────────────
// Usage: /fa_opp name:ChaseAshman
// Returns: current FA Cup matchup for that manager

const faOppCommand = new SlashCommandBuilder()
  .setName("fa_opp")
  .setDescription("Look up someone's current FA Cup opponent")
  .addStringOption(o =>
    o.setName("name")
      .setDescription("Team name or manager name to look up")
      .setRequired(true)
  );

async function handleFaOpp(interaction) {
  await interaction.deferReply({ ephemeral: false });

  const query = interaction.options.getString("name", true).trim();

  let bracket;
  try {
    bracket = await fetchBracket();
  } catch (e) {
    await interaction.editReply("❌ Could not fetch the FA Cup bracket right now. Try again in a moment.");
    return;
  }

  if (!bracket.length) {
    await interaction.editReply("❌ FA Cup bracket data is not available yet.");
    return;
  }

  const matchup = findMatchupForTeam(bracket, query);

  if (!matchup) {
    await interaction.editReply(
      `❌ Couldn't find a team matching **"${query}"** in the FA Cup bracket.\n` +
      `Check the full bracket at ${FACUP_URL}`
    );
    return;
  }

  const t1       = seedName(matchup.seed1);
  const t2       = seedName(matchup.seed2);
  const matchNum = getMatchNum(matchup.round, matchup.matchup_idx);
  const roundInfo = FA_CUP_ROUNDS.find(r => r.round === matchup.round);
  const roundLabel = roundInfo?.label ?? matchup.round.toUpperCase();

  // Determine which team the user searched for and who their opponent is
  const q = query.toLowerCase();
  const userIsT1 = t1.toLowerCase().includes(q);
  const searched = userIsT1 ? t1 : t2;
  const opponent = userIsT1 ? t2 : t1;
  const searchedSeed = userIsT1 ? matchup.seed1 : matchup.seed2;
  const opponentSeed = userIsT1 ? matchup.seed2 : matchup.seed1;

  // Score lines if available
  let scoreLine = "";
  const s1 = matchup.score1, s2 = matchup.score2;
  if (s1 != null && s2 != null) {
    const searchedScore = userIsT1 ? s1 : s2;
    const opponentScore = userIsT1 ? s2 : s1;
    scoreLine = `\n**Current score:** ${searched} **${searchedScore}** – **${opponentScore}** ${opponent}`;

    // Tiebreaker info
    if (s1 === s2) {
      const g1 = matchup.goals1, g2 = matchup.goals2;
      if (g1 != null && g2 != null) {
        const sg = userIsT1 ? g1 : g2;
        const og = userIsT1 ? g2 : g1;
        scoreLine += `\n⚽ *Tied! Tiebreaker goals — ${searched}: ${sg}, ${opponent}: ${og}*`;
      } else {
        scoreLine += `\n⚽ *Currently tied — tiebreaker by goals in active squad*`;
      }
    }
  }

  // Winner info if already decided
  let resultLine = "";
  if (matchup.winner_seed) {
    const winnerName = seedName(matchup.winner_seed);
    resultLine = `\n\n✅ **Result:** ${winnerName} advanced`;
  }

  const gwInfo = roundInfo ? ` · GW${roundInfo.gw}` : "";

  const embed = new EmbedBuilder()
    .setColor(matchup.winner_seed ? 0x22c55e : 0x5b329e)
    .setTitle(`⚽ FA Cup — M${matchNum} · ${roundLabel}${gwInfo}`)
    .setDescription(
      `**${t1}** (Seed ${matchup.seed1 ?? "?"})` +
      `\nvs\n` +
      `**${t2}** (Seed ${matchup.seed2 ?? "?"})` +
      scoreLine +
      resultLine +
      `\n\n[View full bracket](${FACUP_URL})`
    )
    .setFooter({ text: "TFPL Fantasy FA Cup • tfpl.vercel.app/facup" });

  await interaction.editReply({ embeds: [embed] });
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  scheduleFaCupReminders,
  scheduleFaCupRoundSummary,
  handleFaOpp,
  faOppCommand,
};
