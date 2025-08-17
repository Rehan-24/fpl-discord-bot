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
async function getProfileByDiscord(discordId) {
  const url = `${BASE}/user/${discordId}`;
  const { data } = await axios.get(url, { headers: API_HEADERS });
  return data;
}
async function getProfileByName(name) {
  const url = `${BASE}/user/by-name`;
  const { data } = await axios.get(url, { headers: API_HEADERS, params: { name } });
  return data;
}
async function getProfileFlexible(target) {
  if (target.mode === "discord") return getProfileByDiscord(target.discordId);
  return getProfileByName(target.name);
}

async function updateProfileByDiscord(discordId, fields, actorId) {
  const url = `${BASE}/user/${discordId}`;
  const headers = { ...API_HEADERS, actor_id: String(actorId) };
  const { data } = await axios.post(url, fields, { headers });
  return data;
}
async function updateProfileByName(name, fields, actorId) {
  const url = `${BASE}/user/by-name`;
  const headers = { ...API_HEADERS, actor_id: String(actorId) };
  const { data } = await axios.post(url, { name, ...fields }, { headers });
  return data;
}
async function updateProfileFlexible(target, fields, actorId) {
  if (target.mode === "discord") {
    return updateProfileByDiscord(target.discordId, fields, actorId);
  }
  return updateProfileByName(target.name, fields, actorId);
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

function formatInTZ(date) {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: TZ,
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

let __scheduledTimeouts = [];
function clearReminders() {
  for (const t of __scheduledTimeouts) clearTimeout(t);
  __scheduledTimeouts = [];
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
  scheduleAt(oneHourBefore, "1-hour");

  // After the deadline passes, re-run scheduling to pick up the next GW.
  const reschedMs = Math.max(deadline.getTime() - now.getTime() + 60 * 1000, 60 * 60 * 1000);
  __scheduledTimeouts.push(setTimeout(scheduleDeadlineReminders, reschedMs));

  console.log(`Scheduled GW${ev.id} reminders: 24h @ ${oneDayBefore.toISOString()}, 1h @ ${oneHourBefore.toISOString()}, deadline @ ${deadline.toISOString()}`);
}
client.once(Events.ClientReady, async (c) => {
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
    
    // /next_deadline
    if (interaction.commandName === "next_deadline") {
      await interaction.deferReply({ ephemeral: false });
      const ev = await getNextFplEvent();
      if (!ev) {
        return await interaction.editReply("No upcoming FPL deadline found.");
      }
      const deadline = new Date(ev.deadline_time); // UTC
      const pst = formatInTZ(deadline, "America/Los_Angeles");
      const est = formatInTZ(deadline, "America/New_York");
      const ms = deadline.getTime() - Date.now();
      const hours = Math.max(0, Math.floor(ms / (1000*60*60)));
      const mins = Math.max(0, Math.floor((ms % (1000*60*60)) / (1000*60)));
      const remaining = `${hours}h ${mins}m`;

      return await interaction.editReply(
        `🚨 **GW${ev.id} deadline**\n${pst} PST / ${est} EST\nTime remaining: ${remaining}`
      );
    }

if (interaction.commandName === "me") {
      await interaction.deferReply({ ephemeral: false });
      const target = resolveTarget(interaction); // now supports "name"
      const profile = await getProfileFlexible(target);
      return await interaction.editReply({ embeds: [makeEmbed(profile)] });
    }

    // /setbio
    if (interaction.commandName === "setbio") {
      await interaction.deferReply({ ephemeral: true });
      const text = interaction.options.getString("text", true);
      const target = resolveTarget(interaction); // user OR name OR self
      const actorId = interaction.user.id;

      ensureCanEditFlexible(actorId, target);
      const res = await updateProfileFlexible(target, { bio: text }, actorId);
      await interaction.editReply(`✅ Bio updated for **${target.display}**.`);
      return await interaction.followUp({ embeds: [makeEmbed(res.user || res)] });
    }

    // /setclub
    if (interaction.commandName === "setclub") {
      await interaction.deferReply({ ephemeral: true });
      const club = interaction.options.getString("club", true);
      const target = resolveTarget(interaction);
      const actorId = interaction.user.id;

      ensureCanEditFlexible(actorId, target);
      const res = await updateProfileFlexible(target, { favorite_club: club }, actorId);
      await interaction.editReply(`✅ Favorite club updated for **${target.display}**.`);
      return await interaction.followUp({ embeds: [makeEmbed(res.user || res)] });
    }

    // /setsocial
    if (interaction.commandName === "setsocial") {
      await interaction.deferReply({ ephemeral: true });
      const url = interaction.options.getString("url", true);
      const target = resolveTarget(interaction);
      const actorId = interaction.user.id;

      ensureCanEditFlexible(actorId, target);
      const res = await updateProfileFlexible(target, { social_url: url }, actorId);
      await interaction.editReply(`✅ Social URL updated for **${target.display}**.`);
      return await interaction.followUp({ embeds: [makeEmbed(res.user || res)] });
    }

    // /setimage
    if (interaction.commandName === "setimage") {
      await interaction.deferReply({ ephemeral: true });
      const url = interaction.options.getString("url", true);
      const target = resolveTarget(interaction);
      const actorId = interaction.user.id;

      ensureCanEditFlexible(actorId, target);
      const res = await updateProfileFlexible(target, { image_url: url }, actorId);
      await interaction.editReply(`✅ Image URL updated for **${target.display}**.`);
      return await interaction.followUp({ embeds: [makeEmbed(res.user || res)] });
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
