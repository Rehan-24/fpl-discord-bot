// index.js
require("dotenv").config();
const { Client, GatewayIntentBits, EmbedBuilder } = require("discord.js");
const axios = require("axios");

// ===== CONFIG =====
const PREFIX = "!";
const BASE = process.env.BACKEND_URL; 
if (!BASE) throw new Error("BACKEND_URL is not set");
// Optional shared secret support (backend check):
const API_HEADERS = {}; // e.g., { "X-Api-Key": process.env.API_KEY }

// ===== MODS =====
const MOD_IDS = ["626536164236591120"];

function isMod(userId) {
  return MOD_IDS.includes(String(userId));
}
function ensureCanEdit(actorId, targetId) {
  actorId = String(actorId);
  targetId = String(targetId);
  if (actorId === targetId) return;      // self-edit allowed
  if (isMod(actorId)) return;            // mods can edit anyone
  const err = new Error("You can only edit your own profile. Mods can edit anyone.");
  err.status = 403;
  throw err;
}

// ===== DISCORD CLIENT =====
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// ===== HELPERS =====
function parseTargetId(message, args) {
  // If a user is mentioned, use that. Else if last arg looks like an ID, use it. Otherwise use author.
  const mention = message.mentions.users.first();
  if (mention) return mention.id;
  const last = args[args.length - 1];
  if (last && /^\d{15,20}$/.test(last)) {
    args.pop(); // remove ID from args so it's not part of the field value
    return last;
  }
  return message.author.id;
}

async function getProfile(discordId) {
  const url = `${BASE}/user/${discordId}`;
  const { data } = await axios.get(url, { headers: API_HEADERS });
  return data;
}

async function updateProfile(discordId, fields) {
  const url = `${BASE}/user/${discordId}`;
  const { data } = await axios.post(url, fields, { headers: API_HEADERS });
  return data;
}

function makeEmbed(profile) {
  const e = new EmbedBuilder()
    .setTitle(`${profile.name || "Unknown"}${profile.team ? ` (${profile.team})` : ""}`)
    .setDescription(profile.bio || "No bio set.")
    .addFields(
      { name: "Favorite Club", value: profile.favorite_club || "—", inline: true },
      { name: "Social", value: profile.social_url || "—", inline: true }
    )
    .setColor(0x5865f2);

  const img = profile.dynamic_image_url || profile.image_url;
  if (img) e.setThumbnail(img);
  return e;
}

// ===== COMMAND HANDLER =====
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (!message.content.startsWith(PREFIX)) return;

  const [cmd, ...rest] = message.content.slice(PREFIX.length).trim().split(/\s+/);
  const command = (cmd || "").toLowerCase();

  try {
    // Show profile
    if (command === "me") {
      const targetId = parseTargetId(message, rest);
      const profile = await getProfile(targetId);
      return void message.reply({ embeds: [makeEmbed(profile)] });
    }

    // Update BIO
    if (command === "setbio") {
      if (rest.length === 0) return void message.reply("Usage: `!setbio <text> [@user|id]`");
      const actorId = message.author.id;
      const targetId = parseTargetId(message, rest);
      ensureCanEdit(actorId, targetId);

      const bio = rest.join(" ").trim();
      const res = await updateProfile(targetId, { bio });
      await message.reply(`✅ Bio updated for <@${targetId}>.`);
      return void message.channel.send({ embeds: [makeEmbed(res.user)] });
    }

    // Update Favorite Club
    if (command === "setclub") {
      if (rest.length === 0) return void message.reply("Usage: `!setclub <club name> [@user|id]`");
      const actorId = message.author.id;
      const targetId = parseTargetId(message, rest);
      ensureCanEdit(actorId, targetId);

      const favorite_club = rest.join(" ").trim();
      const res = await updateProfile(targetId, { favorite_club });
      await message.reply(`✅ Favorite club updated for <@${targetId}>.`);
      return void message.channel.send({ embeds: [makeEmbed(res.user)] });
    }

    // Update Social URL
    if (command === "setsocial") {
      if (rest.length === 0) return void message.reply("Usage: `!setsocial <url> [@user|id]`");
      const actorId = message.author.id;
      const targetId = parseTargetId(message, rest);
      ensureCanEdit(actorId, targetId);

      const social_url = rest.join(" ").trim();
      const res = await updateProfile(targetId, { social_url });
      await message.reply(`✅ Social URL updated for <@${targetId}>.`);
      return void message.channel.send({ embeds: [makeEmbed(res.user)] });
    }

    // Update Image URL
    if (command === "setimage") {
      if (rest.length === 0) return void message.reply("Usage: `!setimage <image-url> [@user|id]`");
      const actorId = message.author.id;
      const targetId = parseTargetId(message, rest);
      ensureCanEdit(actorId, targetId);

      const image_url = rest.join(" ").trim();
      // Optional quick validation:
      // try { new URL(image_url); } catch { return void message.reply("Provide a valid URL."); }
      const res = await updateProfile(targetId, { image_url });
      await message.reply(`✅ Image URL updated for <@${targetId}>.`);
      return void message.channel.send({ embeds: [makeEmbed(res.user)] });
    }

    if (command === "help") {
      return void message.reply(
        [
          "**Commands:**",
          "`!me [@user|id]` – show profile",
          "`!setbio <text> [@user|id]`",
          "`!setclub <club> [@user|id]`",
          "`!setsocial <url> [@user|id]`",
          "`!setimage <url> [@user|id]`",
          "",
          "_You can only edit your own profile unless you’re one of them._",
        ].join("\n")
      );
    }

  } catch (err) {
    console.error(err?.response?.data || err);
    const detail = err?.response?.data?.detail || err?.message || "Unknown error";
    return void message.reply(`❌ Error: ${detail}`);
  }
});

// ===== BOOT =====
client.once("ready", () => {
  console.log(`Logged in as ${client.user.tag}`);
});
client.login(process.env.BOT_TOKEN);
