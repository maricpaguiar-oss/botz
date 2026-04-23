// bot.js - Compatível com Windows e Linux (Railway)
const { Client, GatewayIntentBits, EmbedBuilder, PermissionsBitField } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus } = require('@discordjs/voice');
const { exec, spawn } = require('child_process');
const ytSearch = require('yt-search');
const dotenv = require('dotenv');
const { PassThrough } = require('stream');
const express = require('express');

dotenv.config();

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMembers
    ]
});

const PREFIX = '!';
const queues = new Map();

// Detecta sistema operacional para usar o executável correto do yt-dlp
const YTDLP_PATH = process.platform === 'win32' ? './yt-dlp.exe' : 'yt-dlp';
const youtubeCookie = process.env.YOUTUBE_COOKIE;

// Servidor HTTP simples para evitar suspensão no Railway
const app = express();
app.get('/', (req, res) => res.send('✅ Bot online!'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 Servidor HTTP rodando na porta ${PORT}`));

async function playSong(guildId, song, voiceChannel, textChannel) {
    const queue = queues.get(guildId);
    if (!song) {
        queues.delete(guildId);
        return;
    }

    if (!song.url) {
        textChannel.send('❌ URL inválida.');
        queue.songs.shift();
        return playSong(guildId, queue.songs[0], voiceChannel, textChannel);
    }

    try {
        const connection = joinVoiceChannel({
            channelId: voiceChannel.id,
            guildId: voiceChannel.guild.id,
            adapterCreator: voiceChannel.guild.voiceAdapterCreator,
        });

        // Comando yt-dlp para extrair áudio como opus (melhor para Discord)
        const args = [
            '--extract-audio',
            '--audio-format', 'opus',
            '--audio-quality', '0',
            '-o', '-', // saída para stdout
            song.url
        ];
        if (youtubeCookie) {
            args.push('--cookie', youtubeCookie);
        }

        const ytProcess = spawn(YTDLP_PATH, args);
        const stream = new PassThrough();
        ytProcess.stdout.pipe(stream);

        ytProcess.stderr.on('data', (data) => {
            console.log(`yt-dlp: ${data}`);
        });

        ytProcess.on('error', (err) => {
            console.error('Erro ao iniciar yt-dlp:', err);
            textChannel.send('❌ Erro ao processar a música.');
            queue.songs.shift();
            playSong(guildId, queue.songs[0], voiceChannel, textChannel);
        });

        const resource = createAudioResource(stream);
        const player = createAudioPlayer();
        connection.subscribe(player);
        player.play(resource);

        player.on(AudioPlayerStatus.Idle, () => {
            queue.songs.shift();
            playSong(guildId, queue.songs[0], voiceChannel, textChannel);
        });

        player.on('error', error => {
            console.error('Erro no player:', error);
            textChannel.send('❌ Erro na reprodução. Pulando...');
            queue.songs.shift();
            playSong(guildId, queue.songs[0], voiceChannel, textChannel);
        });

        textChannel.send(`🎵 Tocando agora: **${song.title}**`);
    } catch (err) {
        console.error('Erro em playSong:', err);
        textChannel.send(`❌ Erro: ${err.message || 'Não foi possível tocar.'}`);
        queue.songs.shift();
        playSong(guildId, queue.songs[0], voiceChannel, textChannel);
    }
}

function rollDice(sides) {
    return Math.floor(Math.random() * sides) + 1;
}

function sendRollEmbed(message, diceType, result, color = 0x9b59b6) {
    const embed = new EmbedBuilder()
        .setColor(color)
        .setTitle(`🎲 Rolagem de ${diceType.toUpperCase()}`)
        .setDescription(`${message.author} rolou um dado de ${diceType}`)
        .addFields({ name: 'Resultado', value: `**${result}**`, inline: true })
        .setFooter({ text: `Sistema de RPG | ${diceType}` })
        .setTimestamp();
    message.channel.send({ embeds: [embed] });
}

client.once('ready', () => {
    console.log(`✅ Bot logado como ${client.user.tag}`);
    client.user.setActivity(`${PREFIX}help | Música (yt-dlp)`);
});

client.on('messageCreate', async message => {
    if (message.author.bot) return;
    if (!message.content.startsWith(PREFIX)) return;

    const args = message.content.slice(PREFIX.length).trim().split(/ +/);
    const command = args.shift().toLowerCase();
    const member = message.member;
    const guild = message.guild;

    if (command === 'play') {
        const query = args.join(' ');
        if (!query) return message.reply('❌ Digite o nome, link do YouTube ou SoundCloud.');
        const voiceChannel = member.voice.channel;
        if (!voiceChannel) return message.reply('❌ Entre em um canal de voz.');

        try {
            let song;
            if (query.startsWith('http')) {
                // Obtém título usando yt-dlp
                const titleArgs = ['--get-title', query];
                const titleProcess = spawn(YTDLP_PATH, titleArgs);
                let title = '';
                titleProcess.stdout.on('data', (data) => title += data);
                await new Promise((resolve) => {
                    titleProcess.on('close', () => resolve());
                });
                song = { title: title.trim() || 'Música', url: query };
            } else {
                const result = await ytSearch(query);
                if (!result || !result.videos.length) return message.reply('❌ Nada encontrado.');
                song = { title: result.videos[0].title, url: result.videos[0].url };
            }

            let queue = queues.get(guild.id);
            if (!queue) {
                queue = { songs: [], voiceChannel, textChannel: message.channel };
                queues.set(guild.id, queue);
            }
            queue.songs.push(song);
            if (queue.songs.length === 1) {
                playSong(guild.id, queue.songs[0], voiceChannel, message.channel);
            } else {
                message.reply(`✅ **${song.title}** adicionada à fila (posição ${queue.songs.length})`);
            }
        } catch (err) {
            console.error(err);
            message.reply('❌ Erro ao processar a solicitação.');
        }
    }
    else if (command === 'skip') {
        const queue = queues.get(guild.id);
        if (!queue || !queue.songs.length) return message.reply('❌ Nada tocando.');
        const connection = joinVoiceChannel({
            channelId: queue.voiceChannel.id,
            guildId: guild.id,
            adapterCreator: guild.voiceAdapterCreator,
        });
        const player = connection.state?.subscription?.player;
        if (player) player.stop();
        message.reply('⏭️ Pulou.');
    }
    else if (command === 'stop') {
        const queue = queues.get(guild.id);
        if (!queue) return message.reply('❌ Nada tocando.');
        const connection = joinVoiceChannel({
            channelId: queue.voiceChannel.id,
            guildId: guild.id,
            adapterCreator: guild.voiceAdapterCreator,
        });
        connection.destroy();
        queues.delete(guild.id);
        message.reply('⏹️ Parado e sai do canal.');
    }
    else if (command === 'queue') {
        const queue = queues.get(guild.id);
        if (!queue || !queue.songs.length) return message.reply('📭 Fila vazia.');
        let txt = '**Fila:**\n';
        queue.songs.forEach((s, i) => txt += `${i+1}. ${s.title}\n`);
        message.channel.send(txt);
    }
    else if (command === 'pause') {
        const queue = queues.get(guild.id);
        if (!queue) return message.reply('❌ Nada tocando.');
        const connection = joinVoiceChannel({
            channelId: queue.voiceChannel.id,
            guildId: guild.id,
            adapterCreator: guild.voiceAdapterCreator,
        });
        const player = connection.state?.subscription?.player;
        if (player && player.state.status === AudioPlayerStatus.Playing) {
            player.pause();
            message.reply('⏸️ Pausado.');
        } else message.reply('❌ Não está tocando.');
    }
    else if (command === 'resume') {
        const queue = queues.get(guild.id);
        if (!queue) return message.reply('❌ Nada tocando.');
        const connection = joinVoiceChannel({
            channelId: queue.voiceChannel.id,
            guildId: guild.id,
            adapterCreator: guild.voiceAdapterCreator,
        });
        const player = connection.state?.subscription?.player;
        if (player && player.state.status === AudioPlayerStatus.Paused) {
            player.unpause();
            message.reply('▶️ Retomado.');
        } else message.reply('❌ Não está pausado.');
    }

    // Dados individuais
    else if (command === 'd4') sendRollEmbed(message, 'd4', rollDice(4), 0x2ecc71);
    else if (command === 'd6') sendRollEmbed(message, 'd6', rollDice(6), 0x2ecc71);
    else if (command === 'd8') sendRollEmbed(message, 'd8', rollDice(8), 0x2ecc71);
    else if (command === 'd10') sendRollEmbed(message, 'd10', rollDice(10), 0x2ecc71);
    else if (command === 'd12') sendRollEmbed(message, 'd12', rollDice(12), 0x2ecc71);
    else if (command === 'd20') sendRollEmbed(message, 'd20', rollDice(20), 0x2ecc71);
    else if (command === 'roll') {
        const dice = args[0]?.toLowerCase();
        const valid = ['d4','d6','d8','d10','d12','d20'];
        if (!valid.includes(dice)) return message.reply('🎲 Use: !roll d4/d6/d8/d10/d12/d20');
        const sides = parseInt(dice.slice(1));
        sendRollEmbed(message, dice, rollDice(sides));
    }
    else if (command === 'rpg') {
        if (args[0] === 'roll' && args[1]) {
            const dice = args[1].toLowerCase();
            const valid = ['d4','d6','d8','d10','d12','d20'];
            if (!valid.includes(dice)) return message.reply('Dados válidos: d4 a d20');
            const sides = parseInt(dice.slice(1));
            const result = rollDice(sides);
            const embed = new EmbedBuilder()
                .setColor(0xe67e22)
                .setTitle('⚔️ Teste de Atributo RPG')
                .setDescription(`${message.author} rolou ${dice.toUpperCase()}`)
                .addFields({ name: 'Resultado', value: `**${result}**` })
                .setFooter({ text: 'Boa sorte aventureiro!' })
                .setTimestamp();
            message.channel.send({ embeds: [embed] });
        } else message.reply('📜 Use: `!rpg roll d20`');
    }
    else if (command === 'ping') {
        message.reply(`🏓 Pong! ${client.ws.ping}ms`);
    }
    else if (command === '8ball') {
        const pergunta = args.join(' ');
        if (!pergunta) return message.reply('❌ Faça uma pergunta.');
        const respostas = ['Sim','Não','Talvez','Com certeza','Duvidoso','Pergunte de novo','Sim, definitivamente','Melhor não'];
        const resposta = respostas[Math.floor(Math.random() * respostas.length)];
        const embed = new EmbedBuilder()
            .setColor(0x1abc9c)
            .setTitle('🎱 8Ball')
            .setDescription(`Pergunta: *${pergunta}*`)
            .addFields({ name: 'Resposta', value: `✨ ${resposta} ✨` });
        message.channel.send({ embeds: [embed] });
    }
    else if (command === 'meme') {
        const memes = ['https://i.imgur.com/2eW5rYt.jpg','https://i.imgur.com/3Kp6XxW.png','https://i.imgur.com/QTjZ7cO.jpg'];
        const random = memes[Math.floor(Math.random() * memes.length)];
        const embed = new EmbedBuilder().setColor(0xf1c40f).setTitle('😂 Meme').setImage(random);
        message.channel.send({ embeds: [embed] });
    }
    else if (command === 'kick') {
        if (!member.permissions.has(PermissionsBitField.Flags.KickMembers)) return message.reply('❌ Permissão negada.');
        const alvo = message.mentions.members.first();
        if (!alvo) return message.reply('❌ Mencione alguém.');
        if (!alvo.kickable) return message.reply('❌ Não posso expulsar.');
        const motivo = args.slice(1).join(' ') || 'Sem motivo';
        await alvo.kick(motivo);
        message.reply(`✅ ${alvo.user.tag} expulso. Motivo: ${motivo}`);
    }
    else if (command === 'ban') {
        if (!member.permissions.has(PermissionsBitField.Flags.BanMembers)) return message.reply('❌ Permissão negada.');
        const alvo = message.mentions.members.first();
        if (!alvo) return message.reply('❌ Mencione alguém.');
        if (!alvo.bannable) return message.reply('❌ Não posso banir.');
        const motivo = args.slice(1).join(' ') || 'Sem motivo';
        await alvo.ban({ reason: motivo });
        message.reply(`✅ ${alvo.user.tag} banido. Motivo: ${motivo}`);
    }
    else if (command === 'clear') {
        if (!member.permissions.has(PermissionsBitField.Flags.ManageMessages)) return message.reply('❌ Precisa de permissão.');
        const quantidade = parseInt(args[0]);
        if (isNaN(quantidade) || quantidade < 1 || quantidade > 100) return message.reply('❌ Número entre 1 e 100.');
        await message.channel.bulkDelete(quantidade, true);
        const msg = await message.channel.send(`🗑️ ${quantidade} mensagens apagadas.`);
        setTimeout(() => msg.delete(), 3000);
    }
    else if (command === 'say') {
        if (!member.permissions.has(PermissionsBitField.Flags.Administrator)) return message.reply('❌ Apenas admin.');
        const texto = args.join(' ');
        if (!texto) return message.reply('❌ Diga algo.');
        message.channel.send(texto);
        message.delete().catch(console.error);
    }
    else if (command === 'setnick') {
        if (!member.permissions.has(PermissionsBitField.Flags.ManageNicknames)) return message.reply('❌ Permissão negada.');
        const alvo = message.mentions.members.first();
        if (!alvo) return message.reply('❌ Mencione alguém.');
        const novo = args.slice(1).join(' ');
        if (!novo) return message.reply('❌ Novo apelido?');
        await alvo.setNickname(novo);
        message.reply(`✅ Apelido de ${alvo.user.tag} alterado para **${novo}**`);
    }
    else if (command === 'help') {
        const embed = new EmbedBuilder()
            .setColor(0x3498db)
            .setTitle('🎮 Comandos do Bot')
            .setDescription(`Prefixo: **${PREFIX}**`)
            .addFields(
                { name: '🎵 Música', value: '`play`, `skip`, `stop`, `queue`, `pause`, `resume`\n*YouTube e SoundCloud*', inline: true },
                { name: '🎲 Dados', value: '`!d4`, `!d6`, `!d8`, `!d10`, `!d12`, `!d20`, `!roll d20`, `!rpg roll d20`', inline: true },
                { name: '😂 Diversão', value: '`ping`, `8ball`, `meme`', inline: true },
                { name: '⚙️ Admin', value: '`kick`, `ban`, `clear`, `say`, `setnick`', inline: true }
            )
            .setFooter({ text: 'Rodando no Railway com yt-dlp' })
            .setTimestamp();
        message.channel.send({ embeds: [embed] });
    }
});

const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN) {
    console.error('❌ Token não encontrado no .env');
    process.exit(1);
}
client.login(TOKEN);