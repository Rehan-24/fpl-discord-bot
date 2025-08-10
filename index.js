require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const axios = require('axios');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

client.on('ready', () => {
    console.log(`Logged in as ${client.user.tag}`);
});

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    if (message.content.startsWith('!setname ')) {
        const newName = message.content.split(' ').slice(1).join(' ');
        try {
            await axios.post(`${process.env.BACKEND_URL}/user/${message.author.id}`, { name: newName });
            message.reply(`Your name has been updated to "${newName}"`);
        } catch (err) {
            console.error(err.response?.data || err);
            message.reply(`Could not update your name.`);
        }
    }

    if (message.content === '!getinfo') {
        try {
            const res = await axios.get(`${process.env.BACKEND_URL}/user/${message.author.id}`);
            message.reply(`📄 Your data: ${JSON.stringify(res.data)}`);
        } catch (err) {
            console.error(err.response?.data || err);
            message.reply(`❌ Could not retrieve your data.`);
        }
    }
});

client.login(process.env.BOT_TOKEN);
