require("dotenv").config();
const { REST, Routes, SlashCommandBuilder } = require("discord.js");

const commands = [
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
