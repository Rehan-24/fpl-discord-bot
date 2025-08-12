require("dotenv").config();
const { REST, Routes, SlashCommandBuilder } = require("discord.js");

/* --- News commands --- */
const publishNews = new SlashCommandBuilder()
  .setName("publish_news")
  .setDescription("Publish a News article to the site")
  // REQUIRED first
  .addStringOption(o =>
    o.setName("title").setDescription("Title").setRequired(true).setMaxLength(120)
  )
  .addStringOption(o =>
    o.setName("content").setDescription("Markdown content").setRequired(true).setMaxLength(1800)
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

const newsQuick = new SlashCommandBuilder()
  .setName("news_quick")
  .setDescription("Quick publish a News article")
  // REQUIRED first
  .addStringOption(o =>
    o.setName("title").setDescription("Title").setRequired(true).setMaxLength(120)
  )
  .addStringOption(o =>
    o.setName("content").setDescription("Markdown content").setRequired(true).setMaxLength(1800)
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

/* --- Your existing commands --- */
const baseCommands = [
  new SlashCommandBuilder().setName("ping").setDescription("Check if the bot is responsive"),

  new SlashCommandBuilder()
    .setName("me")
    .setDescription("Show a profile")
    .addUserOption(o =>
      o.setName("user").setDescription("User to view (defaults to you)")
    ),

  new SlashCommandBuilder()
    .setName("setbio")
    .setDescription("Set bio (self only unless mod)")
    .addStringOption(o =>
      o.setName("text").setDescription("Bio text").setRequired(true)
    )
    .addUserOption(o =>
      o.setName("user").setDescription("Target user (mods can edit anyone)")
    ),

  new SlashCommandBuilder()
    .setName("setclub")
    .setDescription("Set favorite club (self only unless mod)")
    .addStringOption(o =>
      o.setName("club").setDescription("Club name").setRequired(true)
    )
    .addUserOption(o =>
      o.setName("user").setDescription("Target user (mods can edit anyone)")
    ),

  new SlashCommandBuilder()
    .setName("setsocial")
    .setDescription("Set social URL (self only unless mod)")
    .addStringOption(o =>
      o.setName("url").setDescription("URL").setRequired(true)
    )
    .addUserOption(o =>
      o.setName("user").setDescription("Target user (mods can edit anyone)")
    ),

  new SlashCommandBuilder()
    .setName("setimage")
    .setDescription("Set image URL (self only unless mod)")
    .addStringOption(o =>
      o.setName("url").setDescription("Image URL").setRequired(true)
    )
    .addUserOption(o =>
      o.setName("user").setDescription("Target user (mods can edit anyone)")
    ),
];

/* --- Final payload: include the two news commands --- */
const commands = [...baseCommands, publishNews, newsQuick].map(c => c.toJSON());

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
