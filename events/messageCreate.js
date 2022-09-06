const { channels, ReplikaInstance } = require('../handlers.js');
module.exports = {
    name: 'messageCreate',
    async execute(message) {
        const channel_id = message.channel.id;
        const current = channels[channel_id];
        if (!current) {
            return;
        }
        if (current instanceof ReplikaInstance && !message.author.bot && !(message.author.username == "面包")) {
            current.send(message);
            current.watchdog.refresh();
        }
    },
};
