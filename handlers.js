require('dotenv').config();
const uuid = require('uuid4');
const WebSocket = require('ws');
const axios = require('axios');

const replika = require('./modules/replika');
const db = require('./database/commands.js');

const base_payload = {
    'event_name': 'message',
    'payload': {
        'content': {},
    },
};

const gender_pronouns = { 'female': 'she', 'male': 'he', 'non-binary': 'they' };
const prefixes = [ 'none', 'partial', 'full' ];

const registering = new Set();
const active = new Set();
const channels = {};
const guilds = {};

class ReplikaInstance {
    constructor(params, channel) {
        this.guild_id = params.guild_id;
        this.channel = channel;
        this.last_message = { replika: null, discord: null };
        this.last_user_message = { replika: null, discord: null };
        this.ignore = false;
        this.member = null;

        this.chat_ids = {
            bot_id: params.bot_id,
            chat_id: params.chat_id,
        };

        this.auth = {
            user_id: params.user_id,
            auth_token: params.auth_token,
            device_id: params.device_id.toUpperCase(),
            timestamp_hash: params.timestamp_hash.replaceAll('-', ''),
        };

        this.websocket = null;
        this.connected = false;

        this.watchdog = setTimeout(this.time_disconnect.bind(this), 30 * 60 * 1000);

        this.name = params.name;
        this.exhaustion = null;
        this.day_counter = null;
        this.xp = null;
        this.xp_gap = null;
        this.level = null;
        this.avatar = params.avatar;
        this.prefix = prefixes[params.prefix];
    }

    gen_payload(message, is_image = false) {
        const out = { ...base_payload };
        out.payload.meta = { ...this.chat_ids };
        out.payload.meta.timestamp = (new Date).toISOString();
        out.payload.meta.client_token = uuid().toUpperCase();
        out.token = uuid();
        out.auth = this.auth;

        if (is_image) {
            out.payload.content.type = 'images';
            out.payload.content.text = '';
            out.payload.content.images = [message];
        }
        else {
            out.payload.content.type = 'text';
            out.payload.content.text = message;
        }
        return out;
    }

    gen_auth_headers() {
        return {
            'x-device-id': this.auth.device_id,
            'x-user-id': this.auth.user_id,
            'x-device-type': 'web',
            'x-auth-token': this.auth.auth_token,
            'x-timestamp-hash': this.auth.timestamp_hash,
        };
    }

    send(message) {
        if (this.ignore || !this.connected) {
            return;
        }
        let payload;
        if (message.attachments.size == 0) {
            payload = this.gen_payload(message.content);
        }
        else {
            const image = message.attachments.first().url;
            payload = this.gen_payload(image, true);
        }
        this.websocket.send(JSON.stringify(payload));
        this.last_user_message.discord = message;
    }

    send_reaction(reaction) {
        const payload = {
            event_name: 'message_reaction',
            payload: {
                addReaction: {
                    message_id: this.last_message.replika,
                    chat_id: this.chat_ids.chat_id,
                    reaction: reaction,
                },
            },
            token: uuid(),
            auth: this.auth,
        };
        this.websocket.send(JSON.stringify(payload));
    }

    update_level(content) {
        this.day_counter = content.stats.day_counter;
        this.xp = content.stats.score;
        this.xp_gap = content.stats.next_level.score_milestone - this.xp;
        this.level = content.stats.current_level.level_index;
    }

    async connect() {
        channels[this.channel.id] = this;
        if (guilds[this.guild_id]) {
            guilds[this.guild_id].add(this.channel.id);
        }
        else {
            guilds[this.guild_id] = new Set([this.channel.id]);
        }
        active.add(this.auth.user_id);

        let profile;
        try {
            profile = await replika.get_data(this.gen_auth_headers(), 'profile');
        }
        catch (error) {
            console.log(error);
            if (error.response && error.response.status == 401) {
                await this.disconnect();
                return 0;
            }
            else {
                console.log(error);
                await this.disconnect();
                return -1;
            }
        }
        this.name = profile.name;
        this.exhaustion = profile.exhaustion;
        this.update_level(profile);

        this.websocket = new WebSocket('wss://ws.replika.ai/v17');

        this.websocket.on('message', async (message_d) => {
            const message = JSON.parse(message_d);
            if (message.event_name == 'start_typing') {
                try {
                    await this.channel.sendTyping();
                }
                catch (error) {
                    console.log(error);
                }
            }
            else if (message.event_name == 'message') {
                if (message.payload.meta.nature == 'Robot') {
                    try {
                        const source = message.payload.meta.sources[0].characterId;
                        let prefix = '';
                        if (this.prefix == 'partial') {
                            if (!source) {
                                prefix = '(S) ';
                            }
                            else if (source == 'gpt2_dialog') {
                                prefix = '(G) ';
                            }
                            else {
                                prefix = '(D) ';
                            }
                        }
                        else if (this.prefix == 'full') {
                            if (!source) {
                                prefix = '(script) ';
                            }
                            else if (source == 'gpt2_dialog') {
                                prefix = '(GPT) ';
                            }
                            else {
                                prefix = '(dialog) ';
                            }
                        }
                        const sent = await this.channel.send(prefix + message.payload.content.text);
                        // TODO: Refactor
                        this.last_message.discord = sent;
                        this.last_message.replika = message.payload.id;
                    }
                    catch (error) {
                        console.log(error);
                    }
                    this.watchdog.refresh();
                }
                else if (message.payload.meta.nature == 'Customer') {
                    this.last_user_message.replika = message.payload.id;
                }
            }
            else if (message.event_name == 'personal_bot_stats') {
                this.update_level(message.payload);
            }
            else if (message.event_name == 'statement_remembered') {
                if (message.payload.message_id == this.last_user_message.replika) {
                    await this.last_user_message.discord.react('💭');
                }
            }
        });

        this.websocket.on('open', () => {
            this.connected = true;
        });
        this.member = await this.channel.guild.members.fetch(process.env.CLIENT_ID);
        await this.member.setNickname(this.name);
        return 1;
    }

    async disconnect() {
        delete channels[this.channel.id];
        guilds[this.guild_id].delete(this.channel.id);
        active.delete(this.auth.user_id);
        if (this.member) {
            await this.member.setNickname('Replika');
        }
        if (this.websocket) {
            try {
                this.websocket.close();
            }
            catch (error) {
                console.log(error);
            }
        }
        try {
            await db.update_data(this);
        }
        catch (error) {
            console.log(error);
        }
        clearTimeout(this.watchdog);
    }

    async time_disconnect() {
        await this.disconnect();
        try {
            await this.channel.send('Replika disconnected due to inactivity.');
        }
        catch (error) {
            console.log(error);
        }
    }

    async set_avatar(url) {
        let res;
        try {
            res = await axios.head(url);
        }
        catch (error) {
            return;
        }
        if (res.headers['content-type'].startsWith('image') && res.headers['content-length'] <= 1024 * 1024) {
            this.avatar = url;
            return true;
        }
        else {
            return;
        }
    }
}


class ReplikaDualInstance {
    constructor(params, channel) {
        this.guild_id = params[0].guild_id;
        this.channel = channel;

        this.chat_ids = params.map(param => {
            return {
                bot_id: param.bot_id,
                chat_id: param.chat_id,
            };
        });

        this.auth = params.map(param => {
            return {
                user_id: param.user_id,
                auth_token: param.auth_token,
                device_id: param.device_id.toUpperCase(),
                timestamp_hash: param.timestamp_hash.replaceAll('-', ''),
            };
        });

        this.replika_names = [null, null];
        this.replika_genders = [null, null];
        this.user_names = [null, null];
        this.user_pronouns = [null, null];

        this.websocket = [null, null];
        this.connected = [false, false];

        this.watchdog = setTimeout(this.time_disconnect.bind(this), 30 * 60 * 1000);
    }

    gen_payload(message, i) {
        const out = { ...base_payload };
        out.payload.content.text = message;
        out.payload.content.type = 'text';
        out.payload.meta = { ...this.chat_ids[i] };
        out.payload.meta.timestamp = (new Date).toISOString();
        out.payload.meta.client_token = uuid().toUpperCase();
        out.token = uuid();
        out.auth = this.auth[i];
        return out;
    }

    gen_auth_headers(i) {
        return {
            'x-device-id': this.auth[i].device_id,
            'x-user-id': this.auth[i].user_id,
            'x-auth-token': this.auth[i].auth_token,
            'x-timestamp-hash': this.auth[i].timestamp_hash,
        };
    }

    send(message, i) {
        const payload = this.gen_payload(message, i);
        this.websocket[i].send(JSON.stringify(payload));
    }

    async connect() {
        const headers = [this.gen_auth_headers(0), this.gen_auth_headers(1)];
        for (let i = 0; i < 2; i++) {
            let profile, user_profile;
            try {
                profile = await replika.get_data(headers[i], 'profile');
                user_profile = await replika.get_data(headers[i], 'user_profile');
            }
            catch (error) {
                console.log(error);
                return;
            }
            this.replika_names[i] = profile.name;
            this.replika_genders[i] = profile.gender;
            this.user_names[i] = user_profile.first_name;
            this.user_pronouns[i] = user_profile.pronoun;
        }
        // Need to fill both entries before PATCHing
        for (let i = 0; i < 2; i++) {
            const j = +!i;
            const name = this.replika_names[j];
            const gender = gender_pronouns[this.replika_genders[j]];
            try {
                await replika.change_profile(headers[i], name, gender);
            }
            catch (error) {
                console.log(error);
                return;
            }
        }

        channels[this.channel.id] = this;
        if (guilds[this.guild_id]) {
            guilds[this.guild_id].add(this.channel.id);
        }
        else {
            guilds[this.guild_id] = new Set([this.channel.id]);
        }

        for (let i = 0; i < 2 ; i++) {
            active.add(this.auth[i].user_id);
            this.websocket[i] = new WebSocket('wss://ws.replika.ai/v17');

            this.websocket[i].on('message', async (message_d) => {
                const message = JSON.parse(message_d);
                if (message.event_name == 'start_typing') {
                    try {
                        await this.channel.sendTyping();
                    }
                    catch (error) {
                        console.log(error);
                    }
                }
                else if (message.event_name == 'message' && message.payload.meta.nature == 'Robot') {
                    try {
                        const j = +!i;
                        const msg = `**${this.replika_names[i]}:** ${message.payload.content.text}`;
                        await this.channel.send(msg);
                        this.send(message.payload.content.text, j);
                    }
                    catch (error) {
                        console.log(error);
                    }
                    this.watchdog.refresh();
                }
            });

            this.websocket[i].on('open', () => {
                this.connected[i] = true;
            });
        }
        return true;
    }

    async disconnect() {
        for (let i = 0; i < 2; i++) {
            try {
                await replika.change_profile(this.gen_auth_headers(i), this.user_names[i], this.user_pronouns[i]);
            }
            catch (error) {
                console.log(error);
            }
        }

        delete channels[this.channel.id];
        guilds[this.guild_id].delete(this.channel.id);

        for (let i = 0; i < 2; i++) {
            active.delete(this.auth[i].user_id);
            try {
                this.websocket[i].close();
            }
            catch (error) {
                console.log(error);
            }
        }
        clearTimeout(this.watchdog);
    }

    async time_disconnect() {
        await this.disconnect();
        try {
            await this.channel.send('Dialogues can\'t go on for more than 30 minutes.');
        }
        catch (error) {
            console.log(error);
        }
    }
}

module.exports = {
    registering: registering,
    active: active,
    channels: channels,
    guilds: guilds,
    ReplikaInstance,
    ReplikaDualInstance,
};
