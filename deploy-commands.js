require("dotenv").config();
const { REST, Routes, SlashCommandBuilder } = require("discord.js");

// /next_deadline — show next FPL deadline (PST/EST)
const nextDeadline = new SlashCommandBuilder()
  .setName("next_deadline")
  .setDescription("Show the next FPL deadline with PST/EST times");


/* -------------------- News commands -------------------- */
// /publish_news — required first, then optional
const publishNews = new SlashCommandBuilder()
  .setName("publish_news")
  .setDescription("Publish a News article to the site")
  // REQUIRED first
  .addStringOption(o =>
    o.setName("title").setDescription("Title").setRequired(true).setMaxLength(120)
  )
  .addStringOption(o =>
    o.setName("content").setDescription("Markdown content").setRequired(true).setMaxLength(2000)
  )
  // OPTIONAL after required
  .addStringOption(o =>
    o.setName("tags").setDescription("Comma-separated tags (e.g. announcement, rules)")
  )
  .addStringOption(o =>
    o.setName("excerpt").setDescription("Short teaser shown in the list")
  )
  .addStringOption(o =>
    o.setName("image_url").setDescription("Image URL (optional)")
  )
  .addAttachmentOption(o =>
    o.setName("image_file").setDescription("Or upload an image instead")
  );

// /news_quick — required first, then optional
const newsQuick = new SlashCommandBuilder()
  .setName("news_quick")
  .setDescription("Quick publish a News article")
  // REQUIRED first
  .addStringOption(o =>
    o.setName("title").setDescription("Title").setRequired(true).setMaxLength(120)
  )
  .addStringOption(o =>
    o.setName("content").setDescription("Markdown content").setRequired(true).setMaxLength(2000)
  )
  // OPTIONAL after required
  .addStringOption(o =>
    o.setName("tags").setDescription("Comma-separated tags")
  )
  .addStringOption(o =>
    o.setName("excerpt").setDescription("Short teaser")
  )
  .addStringOption(o =>
    o.setName("image_url").setDescription("Image URL")
  );

/* -------------------- Profile commands -------------------- */
const ping = new SlashCommandBuilder()
  .setName("ping")
  .setDescription("Check if the bot is responsive");

const meCmd = new SlashCommandBuilder()
  .setName("me")
  .setDescription("Show a profile")
  .addUserOption(o =>
    o.setName("user").setDescription("User to view (defaults to you)")
  );

const setbio = new SlashCommandBuilder()
  .setName("setbio")
  .setDescription("Set bio (self only unless mod)")
  // REQUIRED first
  .addStringOption(o =>
    o.setName("text").setDescription("Bio text").setRequired(true)
  )
  // OPTIONAL selectors
  .addStringOption(o =>
    o.setName("name").setDescription("Target full name (if not in Discord)")
  )
  .addUserOption(o =>
    o.setName("user").setDescription("Target user (mods can edit anyone)")
  );

const setclub = new SlashCommandBuilder()
  .setName("setclub")
  .setDescription("Set favorite club (self only unless mod)")
  // REQUIRED first
  .addStringOption(o =>
    o.setName("club").setDescription("Club name").setRequired(true)
  )
  // OPTIONAL selectors
  .addStringOption(o =>
    o.setName("name").setDescription("Target full name (if not in Discord)")
  )
  .addUserOption(o =>
    o.setName("user").setDescription("Target user (mods can edit anyone)")
  );

const setsocial = new SlashCommandBuilder()
  .setName("setsocial")
  .setDescription("Set social URL (self only unless mod)")
  // REQUIRED first
  .addStringOption(o =>
    o.setName("url").setDescription("URL").setRequired(true)
  )
  // OPTIONAL selectors
  .addStringOption(o =>
    o.setName("name").setDescription("Target full name (if not in Discord)")
  )
  .addUserOption(o =>
    o.setName("user").setDescription("Target user (mods can edit anyone)")
  );

const setimage = new SlashCommandBuilder()
  .setName("setimage")
  .setDescription("Set image URL (self only unless mod)")
  // REQUIRED first
  .addStringOption(o =>
    o.setName("url").setDescription("Image URL").setRequired(true)
  )
  // OPTIONAL selectors
  .addStringOption(o =>
    o.setName("name").setDescription("Target full name (if not in Discord)")
  )
  .addUserOption(o =>
    o.setName("user").setDescription("Target user (mods can edit anyone)")
  );

/* -------------------- Final payload -------------------- */
const commands = [
  ping,
  meCmd,
  setbio,
  setclub,
  setsocial,
  setimage,
  publishNews,
  newsQuick,
  nextDeadline,
].map(c => c.toJSON());

(async () => {
  try {
    const rest = new REST({ version: "10" }).setToken(process.env.BOT_TOKEN);
    await rest.put(
      Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
      { body: commands }
    );
    console.log("✅ Slash commands registered (guild scope).");
  } catch (err) {
    console.error("Failed to register commands:", err);
    process.exit(1);
  }
})();
