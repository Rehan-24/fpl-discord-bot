require("dotenv").config();

const { Client, GatewayIntentBits, Events } = require("discord.js");
const axios = require("axios");

/* -------------------- Env / Config -------------------- */
const TOKEN = process.env.BOT_TOKEN;
const BASE = process.env.BACKEND_URL || "https://tfpl.onrender.com/api"; // FastAPI base
const SITE_BASE = process.env.SITE_BASE || "https://tfpl.vercel.app";

const API_HEADERS = { "Content-Type": "application/json" };
// backend expects X-API-Key for secure writes (news, etc.)
if (process.env.API_KEY) API_HEADERS["X-Api-Key"] = process.env.API_KEY;

// permissions
const MOD_ROLE_ID = process.env.MOD_ROLE_ID || ""; // role that can edit others / publish
const ALLOWED_EDITOR_USER_IDS = (process.env.ALLOWED_EDITOR_USER_IDS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);
// optional: restrict publishing to one channel
const PUBLISH_CHANNEL_ID = process.env.PUBLISH_CHANNEL_ID || "";

/* -------------------- Discord Client -------------------- */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
  ],
});

client.once(Events.ClientReady, (c) => {
  console.log(`🤖 Logged in as ${c.user.tag}`);
});

/* -------------------- Helpers -------------------- */
function isModOrAllowed(interaction) {
  // Works only in guilds (not DMs)
  try {
    const member = interaction.member;
    const hasRole = MOD_ROLE_ID;
    const isWhitelisted = ALLOWED_EDITOR_USER_IDS.includes(interaction.user.id);
    return Boolean(hasRole || isWhitelisted);
  } catch {
    return false;
  }
}

function requirePublishPermissions(interaction) {
  if (PUBLISH_CHANNEL_ID && interaction.channelId !== PUBLISH_CHANNEL_ID) {
    return `Use this in <#${PUBLISH_CHANNEL_ID}>.`;
  }
  if (!isModOrAllowed(interaction)) {
    return "You don't have permission to publish news.";
  }
  return null;
}

/**
 * Decide who we're editing:
 * - If 'user' provided: target that Discord user (requires mod if not self).
 * - Else if 'name' provided: target by free-text name (requires mod).
 * - Else: target self.
 */
function resolveTarget(interaction, { allowSelfDefault = true } = {}) {
  const userOpt = interaction.options.getUser?.("user");
  const nameOpt = interaction.options.getString?.("name");

  if (userOpt) {
    const isSelf = userOpt.id === interaction.user.id;
    return { mode: "discord", isSelf, discordId: userOpt.id, display: `${userOpt.tag}` };
  }

  if (nameOpt && nameOpt.trim()) {
    return { mode: "name", isSelf: false, name: nameOpt.trim(), display: nameOpt.trim() };
  }

  if (allowSelfDefault) {
    return { mode: "discord", isSelf: true, discordId: interaction.user.id, display: interaction.user.tag };
  }

  return null;
}

function firstAttachmentUrl(interaction) {
  const att = interaction.options?.getAttachment?.("image_file");
  return att?.url || null;
}

/* ---- Backend calls (adjust endpoints if your API differs) ---- */
async function postNews(payload) {
  const res = await axios.post(`${BASE}/news`, payload, {
    headers: API_HEADERS,
    timeout: 20000,
  });
  return res.data; // { ok: true, id: "slug-YYYY-MM-DD" }
}

// Generic field updater; edit URLs if your backend uses different routes
async function updateUserField(field, value, target, editor) {
  // Suggested FastAPI endpoints:
  // POST /api/user/bio        { text, target_discord_id, target_name, editor }
  // POST /api/user/favorite   { club, target_discord_id, target_name, editor }
  // POST /api/user/social     { url,  target_discord_id, target_name, editor }
  // POST /api/user/image      { url,  target_discord_id, target_name, editor }

  const routes = {
    bio: `${BASE}/user/bio`,
    club: `${BASE}/user/favorite`,
    social: `${BASE}/user/social`,
    image: `${BASE}/user/image`,
  };

  const body = {
    target_discord_id: target.mode === "discord" ? target.discordId : null,
    target_name: target.mode === "name" ? target.name : null,
    editor,
  };

  // field-specific key
  if (field === "bio") body.text = value;
  if (field === "club") body.club = value;
  if (field === "social") body.url = value;
  if (field === "image") body.url = value;

  const url = routes[field];
  const res = await axios.post(url, body, {
    headers: API_HEADERS,
    timeout: 20000,
  });
  return res.data;
}

/* -------------------- Interaction router -------------------- */
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
    /* -------- ping -------- */
    if (interaction.commandName === "ping") {
      return interaction.reply({ content: "Pong 🏓", ephemeral: true });
    }

    /* -------- me -------- */
    if (interaction.commandName === "me") {
          await interaction.deferReply({ ephemeral: false }); // reply slot reserved
          const user = interaction.options.getUser("user");
          const targetId = user?.id || interaction.user.id;
          const profile = await getProfile(targetId);
          return await interaction.editReply({ embeds: [makeEmbed(profile)] });
    }

    /* -------- setbio -------- */
    if (interaction.commandName === "setbio") {
      const text = interaction.options.getString("text", true);
      const target = resolveTarget(interaction);
      if (!target.isSelf && !isModOrAllowed(interaction)) {
        return interaction.reply({ content: "❌ You don't have permission to edit other users.", ephemeral: true });
      }
      await interaction.deferReply({ ephemeral: false });
      await updateUserField("bio", text, target, `${interaction.user.tag} (${interaction.user.id})`);
      return interaction.editReply(`✅ Updated **bio** for **${target.display}**`);
    }

    /* -------- setclub -------- */
    if (interaction.commandName === "setclub") {
      const club = interaction.options.getString("club", true);
      const target = resolveTarget(interaction);
      if (!target.isSelf && !isModOrAllowed(interaction)) {
        return interaction.reply({ content: "❌ You don't have permission to edit other users.", ephemeral: true });
      }
      await interaction.deferReply({ ephemeral: false });
      await updateUserField("club", club, target, `${interaction.user.tag} (${interaction.user.id})`);
      return interaction.editReply(`✅ Updated **favorite club** for **${target.display}**`);
    }

    /* -------- setsocial -------- */
    if (interaction.commandName === "setsocial") {
      const url = interaction.options.getString("url", true);
      const target = resolveTarget(interaction);
      if (!target.isSelf && !isModOrAllowed(interaction)) {
        return interaction.reply({ content: "❌ You don't have permission to edit other users.", ephemeral: true });
      }
      await interaction.deferReply({ ephemeral: false });
      await updateUserField("social", url, target, `${interaction.user.tag} (${interaction.user.id})`);
      return interaction.editReply(`✅ Updated **social URL** for **${target.display}**`);
    }

    /* -------- setimage -------- */
    if (interaction.commandName === "setimage") {
      const url = interaction.options.getString("url", true);
      const target = resolveTarget(interaction);
      if (!target.isSelf && !isModOrAllowed(interaction)) {
        return interaction.reply({ content: "❌ You don't have permission to edit other users.", ephemeral: true });
      }
      await interaction.deferReply({ ephemeral: false });
      await updateUserField("image", url, target, `${interaction.user.tag} (${interaction.user.id})`);
      return interaction.editReply(`✅ Updated **image URL** for **${target.display}**`);
    }

    /* -------- publish_news -------- */
    if (interaction.commandName === "publish_news") {
      const permError = requirePublishPermissions(interaction);
      if (permError) {
        return interaction.reply({ content: `❌ ${permError}`, ephemeral: true });
      }

      const title = interaction.options.getString("title", true);
      const content = interaction.options.getString("content", true);
      const tags = interaction.options.getString("tags") || "";
      const excerpt = interaction.options.getString("excerpt") || "";
      const imageUrlInput = interaction.options.getString("image_url") || "";
      const imageFromFile = firstAttachmentUrl(interaction);
      const image_url = imageFromFile || imageUrlInput || null;

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
      return interaction.editReply(`✅ Published **${title}** — ${url}`);
    }

    /* -------- news_quick -------- */
    if (interaction.commandName === "news_quick") {
      const permError = requirePublishPermissions(interaction);
      if (permError) {
        return interaction.reply({ content: `❌ ${permError}`, ephemeral: true });
      }

      const title = interaction.options.getString("title", true);
      const content = interaction.options.getString("content", true);
      const tags = interaction.options.getString("tags") || "";
      const excerpt = interaction.options.getString("excerpt") || "";
      const image_url = interaction.options.getString("image_url") || null;

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
      return interaction.editReply(`✅ Published **${title}** — ${url}`);
    }

  } catch (err) {
    console.error(err?.response?.data || err);
    const detail =
      err?.response?.data?.detail ||
      err?.response?.data?.message ||
      err?.message ||
      "Unknown error";
    if (interaction.replied || interaction.deferred) {
      return interaction.followUp({ content: `❌ ${detail}`, ephemeral: true });
    }
    return interaction.reply({ content: `❌ ${detail}`, ephemeral: true });
  }
});

/* -------------------- Boot -------------------- */
if (!TOKEN) {
  console.error("Missing BOT_TOKEN in env.");
  process.exit(1);
}
client.login(TOKEN);
