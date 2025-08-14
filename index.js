require("dotenv").config();
const {
  Client, GatewayIntentBits, EmbedBuilder, Events, Routes, REST
} = require("discord.js");
const axios = require("axios");

// ===== CONFIG =====
const BASE = "https://tfpl.onrender.com".replace(/\/+$/, "");
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
function ensureCanEdit(actorId, targetId) {
  actorId = String(actorId); targetId = String(targetId);
  if (isMod(actorId)) return;
  if (actorId === targetId) return;
  const err = new Error("You can only edit your own profile. Mods can edit anyone.");
  err.status = 403;
  throw err;
}

async function getProfile(discordId) {
  const url = `${BASE}/user/${discordId}`;
  const { data } = await axios.get(url, { headers: API_HEADERS });
  return data;
}

async function updateProfile(discordId, fields, actorId) {
  const url = `${BASE}/user/${discordId}`;
  const headers = { ...API_HEADERS, actor_id: String(actorId) }; // backend can enforce if added
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

client.once(Events.ClientReady, async (c) => {
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
    await interaction.deferReply({ ephemeral: false }); // reply slot reserved
    const user = interaction.options.getUser("user");
    const targetId = user?.id || interaction.user.id;
    const profile = await getProfile(targetId);
    return await interaction.editReply({ embeds: [makeEmbed(profile)] });
    }

    // /setbio
    if (interaction.commandName === "setbio") {
    await interaction.deferReply({ ephemeral: true }); // updates can be quiet
    const text = interaction.options.getString("text", true);
    const user = interaction.options.getUser("user");
    const actorId = interaction.user.id;
    const targetId = user?.id || actorId;

    ensureCanEdit(actorId, targetId);
    const res = await updateProfile(targetId, { bio: text }, actorId);
    await interaction.editReply(`✅ Bio updated for <@${targetId}>.`);
    return await interaction.followUp({ embeds: [makeEmbed(res.user)] });
    }

    // /setclub
    if (interaction.commandName === "setclub") {
    await interaction.deferReply({ ephemeral: true });
    const club = interaction.options.getString("club", true);
    const user = interaction.options.getUser("user");
    const actorId = interaction.user.id;
    const targetId = user?.id || actorId;

    ensureCanEdit(actorId, targetId);
    const res = await updateProfile(targetId, { favorite_club: club }, actorId);
    await interaction.editReply(`✅ Favorite club updated for <@${targetId}>.`);
    return await interaction.followUp({ embeds: [makeEmbed(res.user)] });
    }

    // /setsocial
    if (interaction.commandName === "setsocial") {
    await interaction.deferReply({ ephemeral: true });
    const url = interaction.options.getString("url", true);
    const user = interaction.options.getUser("user");
    const actorId = interaction.user.id;
    const targetId = user?.id || actorId;

    ensureCanEdit(actorId, targetId);
    const res = await updateProfile(targetId, { social_url: url }, actorId);
    await interaction.editReply(`✅ Social URL updated for <@${targetId}>.`);
    return await interaction.followUp({ embeds: [makeEmbed(res.user)] });
    }

    // /setimage
    if (interaction.commandName === "setimage") {
    await interaction.deferReply({ ephemeral: true });
    const url = interaction.options.getString("url", true);
    const user = interaction.options.getUser("user");
    const actorId = interaction.user.id;
    const targetId = user?.id || actorId;

    ensureCanEdit(actorId, targetId);
    const res = await updateProfile(targetId, { image_url: url }, actorId);
    await interaction.editReply(`✅ Image URL updated for <@${targetId}>.`);
    return await interaction.followUp({ embeds: [makeEmbed(res.user)] });
    }

    if (interaction.commandName === "publish_news") {
      const title = interaction.options.getString("title", true);
      const tags = interaction.options.getString("tags") || "";
      const excerpt = interaction.options.getString("excerpt") || "";
      const imageUrlInput = interaction.options.getString("image_url") || "";
      const imageFromFile = firstAttachmentUrl(interaction);
      const image_url = imageFromFile || imageUrlInput || null;
      const content = interaction.options.getString("content", true);
	  const actorId = interaction.user.id;
	  
	  ensureCanEdit(actorId, 0);

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
	  
	  ensureCanEdit(actorId, 0);

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
