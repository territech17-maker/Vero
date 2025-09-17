require('dotenv').config();
const express = require('express');
const fs = require('fs-extra');
const path = require('path');
const { exec } = require('child_process');
const router = express.Router();
const pino = require('pino');
const cheerio = require('cheerio');
const mongoose = require('mongoose');
const moment = require('moment-timezone');
const Jimp = require('jimp');
const crypto = require('crypto');
const axios = require('axios');
const { sms, downloadMediaMessage } = require("./msg");
const FileType = require('file-type');

const {
    default: makeWASocket,
    useMultiFileAuthState,
    delay,
    getContentType,
    makeCacheableSignalKeyStore,
    Browsers,
    jidNormalizedUser,
    downloadContentFromMessage,
    proto,
    prepareWAMessageMedia,
    generateWAMessageFromContent,
    S_WHATSAPP_NET
} = require('@whiskeysockets/baileys');

const config = require('./config');

// MongoDB Connection
const connectMongoDB = async () => {
    try {
        await mongoose.connect(config.MONGODB_URI, {
            useNewUrlParser: true,
            useUnifiedTopology: true,
            serverSelectionTimeoutMS: 5000,
            socketTimeoutMS: 45000,
        });
        
        console.log('✅ Connected to MongoDB successfully');
        
        // Create indexes for better performance
        await mongoose.connection.db.collection('sessions').createIndex({ number: 1 }, { unique: true });
        await mongoose.connection.db.collection('sessions').createIndex({ updatedAt: 1 });
        
    } catch (error) {
        console.error('❌ MongoDB connection failed:', error.message);
        process.exit(1);
    }
};

// Call MongoDB connection on startup
connectMongoDB();

// Session Schema
const sessionSchema = new mongoose.Schema({
    number: { 
        type: String, 
        required: true, 
        unique: true,
        trim: true,
        match: /^\d+$/
    },
    creds: { 
        type: mongoose.Schema.Types.Mixed, 
        required: true 
    },
    config: { 
        type: mongoose.Schema.Types.Mixed, 
        default: {} 
    },
    lastActive: { 
        type: Date, 
        default: Date.now 
    },
    createdAt: { 
        type: Date, 
        default: Date.now 
    },
    updatedAt: { 
        type: Date, 
        default: Date.now 
    }
});

// Update timestamp before saving
sessionSchema.pre('save', function(next) {
    this.updatedAt = Date.now();
    next();
});

const Session = mongoose.model('Session', sessionSchema);

const activeSockets = new Map();
const socketCreationTime = new Map();
const SESSION_BASE_PATH = config.SESSION_BASE_PATH;
const NUMBER_LIST_PATH = config.NUMBER_LIST_PATH;
const otpStore = new Map();

if (!fs.existsSync(SESSION_BASE_PATH)) {
    fs.mkdirSync(SESSION_BASE_PATH, { recursive: true });
}

function loadAdmins() {
    try {
        if (fs.existsSync(config.ADMIN_LIST_PATH)) {
            return JSON.parse(fs.readFileSync(config.ADMIN_LIST_PATH, 'utf8'));
        }
        return [];
    } catch (error) {
        console.error('Failed to load admin list:', error);
        return [];
    }
}

function formatMessage(title, content, footer) {
    return `*${title}*\n\n${content}\n\n> *${footer}*`;
}

function generateOTP() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

function getSriLankaTimestamp() {
    return moment().tz('Africa/Kampala').format('YYYY-MM-DD HH:mm:ss');
}

async function cleanDuplicateFiles(number) {
    // No need for this with MongoDB - automatic deduplication
    console.log(`Session management for ${number} handled by MongoDB`);
}

async function joinGroup(socket) {
    let retries = config.MAX_RETRIES;
    const inviteCode = config.GROUP_INVITE_CODE; // Use the code directly

    if (!inviteCode) {
        console.error('No group invite code configured');
        return { status: 'failed', error: 'No group invite code configured' };
    }

    while (retries > 0) {
        try {
            const response = await socket.groupAcceptInvite(inviteCode);
            if (response?.gid) {
                console.log(`Successfully joined group with ID: ${response.gid}`);
                return { status: 'success', gid: response.gid };
            }
            throw new Error('No group ID in response');
        } catch (error) {
            retries--;
            let errorMessage = error.message || 'Unknown error';
            if (error.message && error.message.includes('not-authorized')) {
                errorMessage = 'Bot is not authorized to join (possibly banned)';
            } else if (error.message && error.message.includes('conflict')) {
                errorMessage = 'Bot is already a member of the group';
            } else if (error.message && error.message.includes('gone')) {
                errorMessage = 'Group invite code is invalid or expired';
            }
            console.warn(`Failed to join group, retries left: ${retries}`, errorMessage);
            if (retries === 0) {
                return { status: 'failed', error: errorMessage };
            }
            await delay(2000 * (config.MAX_RETRIES - retries));
        }
    }
    return { status: 'failed', error: 'Max retries reached' };
}
async function sendAdminConnectMessage(socket, number, groupResult) {
    const admins = loadAdmins();
    const groupStatus = groupResult.status === 'success'
        ? `Joined (ID: ${groupResult.gid})`
        : `Failed to join group: ${groupResult.error}`;
    const caption = formatMessage(
        '👻 VERONICA MINI BOT CONNECTED 🧚‍♀️',
        `📞 Number: ${number}\n🩵 Status: Connected\n📢 Group: ${groupStatus}`,
        'VERONICA MINI BOT'
    );

    for (const admin of admins) {
        try {
            await socket.sendMessage(
                `${admin}@s.whatsapp.net`,
                {
                    image: { url: config.RCD_IMAGE_PATH },
                    caption
                }
            );
        } catch (error) {
            console.error(`Failed to send connect message to admin ${admin}:`, error);
        }
    }
}

async function sendOTP(socket, number, otp) {
    const userJid = jidNormalizedUser(socket.user.id);
    const message = formatMessage(
        '🔐 OTP VERIFICATION',
        `Your OTP for config update is: *${otp}*\nThis OTP will expire in ${Math.floor(config.OTP_EXPIRY / 60000)} minutes.`,
        'VERONICA MINI BOT'
    );

    try {
        await socket.sendMessage(userJid, { text: message });
        console.log(`OTP ${otp} sent to ${number}`);
    } catch (error) {
        console.error(`Failed to send OTP to ${number}:`, error);
        throw error;
    }
}

function setupNewsletterHandlers(socket) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const message = messages[0];
        if (!message?.key) return;

        const allNewsletterJIDs = await loadNewsletterJIDsFromRaw();
        const jid = message.key.remoteJid;

        if (!allNewsletterJIDs.includes(jid)) return;

        try {
            const emojis = ['🩵', '🔥', '😀', '👍', '🐭'];
            const randomEmoji = emojis[Math.floor(Math.random() * emojis.length)];
            const messageId = message.newsletterServerId;

            if (!messageId) {
                console.warn('No newsletterServerId found in message:', message);
                return;
            }

            let retries = 3;
            while (retries-- > 0) {
                try {
                    await socket.newsletterReactMessage(jid, messageId.toString(), randomEmoji);
                    console.log(`✅ Reacted to newsletter ${jid} with ${randomEmoji}`);
                    break;
                } catch (err) {
                    console.warn(`❌ Reaction attempt failed (${3 - retries}/3):`, err.message || err);
                    await delay(1500);
                }
            }
        } catch (error) {
            console.error('⚠️ Newsletter reaction handler failed:', error.message || error);
        }
    });
}

async function setupStatusHandlers(socket) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const message = messages[0];
        if (!message?.key || message.key.remoteJid !== 'status@broadcast' || !message.key.participant || message.key.remoteJid === config.NEWSLETTER_JID) return;

        try {
            if (config.AUTO_RECORDING === 'true' && message.key.remoteJid) {
                await socket.sendPresenceUpdate("recording", message.key.remoteJid);
            }

            if (config.AUTO_VIEW_STATUS === 'true') {
                let retries = config.MAX_RETRIES;
                while (retries > 0) {
                    try {
                        await socket.readMessages([message.key]);
                        break;
                    } catch (error) {
                        retries--;
                        console.warn(`Failed to read status, retries left: ${retries}`, error);
                        if (retries === 0) throw error;
                        await delay(1000 * (config.MAX_RETRIES - retries));
                    }
                }
            }

            if (config.AUTO_LIKE_STATUS === 'true') {
                const randomEmoji = config.AUTO_LIKE_EMOJI[Math.floor(Math.random() * config.AUTO_LIKE_EMOJI.length)];
                let retries = config.MAX_RETRIES;
                while (retries > 0) {
                    try {
                        await socket.sendMessage(
                            message.key.remoteJid,
                            { react: { text: randomEmoji, key: message.key } },
                            { statusJidList: [message.key.participant] }
                        );
                        console.log(`Reacted to status with ${randomEmoji}`);
                        break;
                    } catch (error) {
                        retries--;
                        console.warn(`Failed to react to status, retries left: ${retries}`, error);
                        if (retries === 0) throw error;
                        await delay(1000 * (config.MAX_RETRIES - retries));
                    }
                }
            }
        } catch (error) {
            console.error('Status handler error:', error);
        }
    });
}

async function handleMessageRevocation(socket, number) {
    socket.ev.on('messages.delete', async ({ keys }) => {
        if (!keys || keys.length === 0) return;

        const messageKey = keys[0];
        const userJid = jidNormalizedUser(socket.user.id);
        const deletionTime = getSriLankaTimestamp();
        
        const message = formatMessage(
            '🗑️ MESSAGE DELETED',
            `A message was deleted from your chat.\n📋 From: ${messageKey.remoteJid}\n🍁 Deletion Time: ${deletionTime}`,
            'VERONICA MINI BOT'
        );

        try {
            await socket.sendMessage(userJid, {
                image: { url: config.RCD_IMAGE_PATH },
                caption: message
            });
            console.log(`Notified ${number} about message deletion: ${messageKey.id}`);
        } catch (error) {
            console.error('Failed to send deletion notification:', error);
        }
    });
}

async function resize(image, width, height) {
    let oyy = await Jimp.read(image);
    let kiyomasa = await oyy.resize(width, height).getBufferAsync(Jimp.MIME_JPEG);
    return kiyomasa;
}

function capital(string) {
    return string.charAt(0).toUpperCase() + string.slice(1);
}

const createSerial = (size) => {
    return crypto.randomBytes(size).toString('hex').slice(0, size);
}

async function oneViewmeg(socket, isOwner, msg ,sender) {
    if (isOwner) {  
        try {
            const akuru = sender;
            const quot = msg;
            if (quot) {
                if (quot.imageMessage?.viewOnce) {
                    let cap = quot.imageMessage?.caption || "";
                    let anu = await socket.downloadAndSaveMediaMessage(quot.imageMessage);
                    await socket.sendMessage(akuru, { image: { url: anu }, caption: cap });
                } else if (quot.videoMessage?.viewOnce) {
                    let cap = quot.videoMessage?.caption || "";
                    let anu = await socket.downloadAndSaveMediaMessage(quot.videoMessage);
                    await socket.sendMessage(akuru, { video: { url: anu }, caption: cap });
                } else if (quot.audioMessage?.viewOnce) {
                    let cap = quot.audioMessage?.caption || "";
                    let anu = await socket.downloadAndSaveMediaMessage(quot.audioMessage);
                    await socket.sendMessage(akuru, { audio: { url: anu }, caption: cap });
                } else if (quot.viewOnceMessageV2?.message?.imageMessage){
                    let cap = quot.viewOnceMessageV2?.message?.imageMessage?.caption || "";
                    let anu = await socket.downloadAndSaveMediaMessage(quot.viewOnceMessageV2.message.imageMessage);
                    await socket.sendMessage(akuru, { image: { url: anu }, caption: cap });
                } else if (quot.viewOnceMessageV2?.message?.videoMessage){
                    let cap = quot.viewOnceMessageV2?.message?.videoMessage?.caption || "";
                    let anu = await socket.downloadAndSaveMediaMessage(quot.viewOnceMessageV2.message.videoMessage);
                    await socket.sendMessage(akuru, { video: { url: anu }, caption: cap });
                } else if (quot.viewOnceMessageV2Extension?.message?.audioMessage){
                    let cap = quot.viewOnceMessageV2Extension?.message?.audioMessage?.caption || "";
                    let anu = await socket.downloadAndSaveMediaMessage(quot.viewOnceMessageV2Extension.message.audioMessage);
                    await socket.sendMessage(akuru, { audio: { url: anu }, caption: cap });
                }
            }        
        } catch (error) {
            console.error('oneViewmeg error:', error);
        }
    }
}

function getMemoryUsageMB() {
    const mem = process.memoryUsage();
    return `${(mem.rss / 1024 / 1024).toFixed(2)} MB`;
}

function setupCommandHandlers(socket, number) {
    // Contact message for verified context (used as quoted message)
    const verifiedContact = {
        key: {
            fromMe: false,
            participant: `0@s.whatsapp.net`,
            remoteJid: "status@broadcast"
        },
        message: {
            contactMessage: {
                displayName: "VERONICA AI",
                vcard: "BEGIN:VCARD\nVERSION:3.0\nFN: VERONICA\nORG:VERONICA MINI BOT;\nTEL;type=CELL;type=VOICE;waid=256752792178:+256784670936\nEND:VCARD"
            }
        }
    };

    socket.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.remoteJid === 'status@broadcast' || msg.key.remoteJid === config.NEWSLETTER_JID) return;

        const type = getContentType(msg.message);
        if (!msg.message) return;
        msg.message = (getContentType(msg.message) === 'ephemeralMessage') ? msg.message.ephemeralMessage.message : msg.message;
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const m = sms(socket, msg);
        const quoted =
            type == "extendedTextMessage" &&
            msg.message.extendedTextMessage.contextInfo != null
            ? msg.message.extendedTextMessage.contextInfo.quotedMessage || []
            : [];
        const body = (type === 'conversation') ? msg.message.conversation 
            : msg.message?.extendedTextMessage?.contextInfo?.hasOwnProperty('quotedMessage') 
            ? msg.message.extendedTextMessage.text 
            : (type == 'interactiveResponseMessage') 
            ? msg.message.interactiveResponseMessage?.nativeFlowResponseMessage 
                && JSON.parse(msg.message.interactiveResponseMessage.nativeFlowResponseMessage.paramsJson)?.id 
            : (type == 'templateButtonReplyMessage') 
            ? msg.message.templateButtonReplyMessage?.selectedId 
            : (type === 'extendedTextMessage') 
            ? msg.message.extendedTextMessage.text 
            : (type == 'imageMessage') && msg.message.imageMessage.caption 
            ? msg.message.imageMessage.caption 
            : (type == 'videoMessage') && msg.message.videoMessage.caption 
            ? msg.message.videoMessage.caption 
            : (type == 'buttonsResponseMessage') 
            ? msg.message.buttonsResponseMessage?.selectedButtonId 
            : (type == 'listResponseMessage') 
            ? msg.message.listResponseMessage?.singleSelectReply?.selectedRowId 
            : (type == 'messageContextInfo') 
            ? (msg.message.buttonsResponseMessage?.selectedButtonId 
                || msg.message.listResponseMessage?.singleSelectReply?.selectedRowId 
                || msg.text) 
            : (type === 'viewOnceMessage') 
            ? msg.message[type]?.message[getContentType(msg.message[type].message)] 
            : (type === "viewOnceMessageV2") 
            ? (msg.msg.message.imageMessage?.caption || msg.msg.message.videoMessage?.caption || "") 
            : '';
        let sender = msg.key.remoteJid;
        const nowsender = msg.key.fromMe ? (socket.user.id.split(':')[0] + '@s.whatsapp.net' || socket.user.id) : (msg.key.participant || msg.key.remoteJid);
        const senderNumber = nowsender.split('@')[0];
        const developers = `${config.OWNER_NUMBER}`;
        const botNumber = socket.user.id.split(':')[0];
        const isbot = botNumber.includes(senderNumber);
        const isOwner = isbot ? isbot : developers.includes(senderNumber);
        var prefix = config.PREFIX;
        var isCmd = (body || '').startsWith(prefix);
        const from = msg.key.remoteJid;
        const isGroup = from.endsWith("@g.us");
        const command = isCmd ? body.slice(prefix.length).trim().split(' ').shift().toLowerCase() : '.';
        var args = (body || '').trim().split(/ +/).slice(1);

        socket.downloadAndSaveMediaMessage = async(message, filename = (Date.now()).toString(), attachExtension = true) => {
            let quoted = message.msg ? message.msg : message;
            let mime = (message.msg || message).mimetype || '';
            let messageType = message.mtype ? message.mtype.replace(/Message/gi, '') : mime.split('/')[0];
            const stream = await downloadContentFromMessage(quoted, messageType);
            let buffer = Buffer.from([]);
            for await (const chunk of stream) {
                buffer = Buffer.concat([buffer, chunk]);
            }
            let type = await FileType.fromBuffer(buffer);
            const trueFileName = attachExtension ? (filename + '.' + (type ? type.ext : 'bin')) : filename;
            await fs.writeFileSync(trueFileName, buffer);
            return trueFileName;
        }

        if (!command) return;

        try {
            switch (command) {
              case 'button': {
                const buttons = [
                    {
                        buttonId: 'button1',
                        buttonText: { displayText: 'Button 1' },
                        type: 1
                    },
                    {
                        buttonId: 'button2',
                        buttonText: { displayText: 'Button 2' },
                        type: 1
                    }
                ];

                const captionText = 'VERONICA MINI BOT';
                const footerText = 'VERONICA MINI BOT';

                const buttonMessage = {
                    image: { url: config.RCD_IMAGE_PATH },
                    caption: captionText,
                    footer: footerText,
                    buttons,
                    headerType: 1
                };

                socket.sendMessage(from, buttonMessage, { quoted: msg });
                break;
              }

              case 'alive': {
                const startTime = socketCreationTime.get(number) || Date.now();
                const uptime = Math.floor((Date.now() - startTime) / 1000);
                const hours = Math.floor(uptime / 3600);
                const minutes = Math.floor((uptime % 3600) / 60);
                const seconds = Math.floor(uptime % 60);

                const captionText = `
╭────◉◉◉────៚
⏰ Bot Uptime: ${hours}h ${minutes}m ${seconds}s
🟢 Active Bots: ${activeSockets.size}
╰────◉◉◉────៚

🔢 Your Number: ${number}
`;

                await socket.sendMessage(m.chat, {
                    buttons: [
                        {
                            buttonId: `${config.PREFIX}menu`,
                            buttonText: {
                                displayText: '📂 Menu Options'
                            },
                            type: 4,
                            nativeFlowInfo: {
                                name: 'single_select',
                                paramsJson: JSON.stringify({
                                    title: 'Click Here ❏',
                                    sections: [
                                        {
                                            title: `VERONICA MINI BOT`,
                                            highlight_label: '',
                                            rows: [
                                                {
                                                    title: 'menu',
                                                    description: 'VERONICA MINI BOT',
                                                    id: `${config.PREFIX}menu`,
                                                },
                                                {
                                                    title: 'Alive',
                                                    description: 'VERONICA MINI BOT',
                                                    id: `${config.PREFIX}alive`,
                                                },
                                            ],
                                        },
                                    ],
                                }),
                            },
                        },
                    ],
                    headerType: 1,
                    viewOnce: true,
                    image: { url: config.RCD_IMAGE_PATH },
                    caption: `VERONICA MINI BOT ALIVE\n\n${captionText}`,
                }, { quoted: msg });
                break;
              }

              case 'menu': {
                let loadingSteps = [
                    '🔄 *LOADING... 20%*',
                    '🔄 *LOADING... 30%*',
                    '🔄 *LOADING... 40%*',
                    '🔄 *LOADING... 50%*',
                    '✅ *COMPLETE!*'
                ];

                for (let step of loadingSteps) {
                    await socket.sendMessage(from, { text: step });
                    await new Promise(r => setTimeout(r, 500));
                }

                let menuText = `
*╭───❮  VERONICA MINI BOT MENU ❯───╮*

*💠 General*
• ${config.PREFIX}alive
• ${config.PREFIX}ai
• ${config.PREFIX}fancy
• ${config.PREFIX}logo 

*🎵 Media Tools*
• ${config.PREFIX}play
• ${config.PREFIX}aiimg
• ${config.PREFIX}tiktok 
• ${config.PREFIX}fb 
• ${config.PREFIX}ig
• ${config.PREFIX}ts

*📰 News & Info*
• ${config.PREFIX}news
• ${config.PREFIX}nasa 
• ${config.PREFIX}gossip
• ${config.PREFIX}cricket

*🛠 Tools*
• ${config.PREFIX}winfo
• ${config.PREFIX}bomb
• ${config.PREFIX}deleteme

*╰─❮ VERONICA MINI BOT❯────────╯*
`;

                await socket.sendMessage(from, {
                    image: { url: config.RCD_IMAGE_PATH },
                    caption: formatMessage(
                        'VERONICA MINI BOT MENU',
                        menuText,
                        'VERONICA MINI BOT'
                    ),
                    contextInfo: {
                        mentionedJid: [msg.key.participant || sender],
                        forwardingScore: 999,
                        isForwarded: true,
                        forwardedNewsletterMessageInfo: {
                            newsletterJid: (config.NEWSLETTER_JID || '').trim(),
                            newsletterName: 'I AM ALIVE🍀🧚‍♀️',
                            serverMessageId: 143
                        }
                    }
                }, { quoted: verifiedContact });

                break;
              }

              case 'allmenu': {
                // Build dynamic info
                const admins = loadAdmins();
                const isAdmin = admins.includes(senderNumber);
                const userType = isAdmin ? 'admin' : 'guest';
                const prefixLocal = config.PREFIX;
                const startTime = socketCreationTime.get(number) || Date.now();
                const uptime = Math.floor((Date.now() - startTime) / 1000);
                const hours = Math.floor(uptime / 3600);
                const minutes = Math.floor((uptime % 3600) / 60);
                const seconds = Math.floor(uptime % 60);
                const uptimeString = `${hours}h ${minutes}m ${seconds}s`;
                const memory = getMemoryUsageMB();

                // Derive daily users count from numbers.json
                let dailyUsers = 0;
                try {
                    if (fs.existsSync(config.NUMBER_LIST_PATH)) {
                        const nlist = JSON.parse(fs.readFileSync(config.NUMBER_LIST_PATH, "utf8"));
                        dailyUsers = Array.isArray(nlist) ? nlist.length : 0;
                    }
                } catch (e) { dailyUsers = 0; }

                const totalCommands = 48;

                const owner = config.OWNER_NUMBER;

                const infoMsg =
`╭─『 VERONICA MINI BOT 』   
│ 👤 ᴜsᴇʀ: ${userType}
│ 📍 ᴘʀᴇғɪx: ${prefixLocal}
│ ⏰ ᴜᴘᴛɪᴍᴇ: ${uptimeString}
│ 💾 ᴍᴇᴍᴏʀʏ: ${memory}
│ 🔮 total commands: ${totalCommands}
│ 👥 ᴅᴀɪʟʏ ᴜsᴇʀs: ${dailyUsers}
│ 🇿🇼 ᴏᴡɴᴇʀ: ${owner}
╰────◉◉◉────៚`;

                const statusMsg =
`╭────◉◉◉────៚
📈 BOT STATISTICS
├─ ⏰ Uptime: ${uptimeString}
├─ 💾 Memory: ${memory}
├─ 👥 Active Users: ${dailyUsers}
├─ 🟢 Your Number: ${number}
├─ 🌐 Version: 1.0.0
╰────◉◉◉────៚`;

                const menuText = `
*╭───❮  VERONICA MINI BOT — ALL COMMANDS ❯───╮*

*💠 General*
• ${prefixLocal}alive
• ${prefixLocal}ai
• ${prefixLocal}fancy
• ${prefixLocal}logo

*🎵 Media Tools*
• ${prefixLocal}song
• ${prefixLocal}aiimg
• ${prefixLocal}tiktok
• ${prefixLocal}fb
• ${prefixLocal}ig
• ${prefixLocal}ts

*📰 News & Info*
• ${prefixLocal}news
• ${prefixLocal}nasa
• ${prefixLocal}gossip
• ${prefixLocal}cricket

*🛠 Tools*
• ${prefixLocal}winfo
• ${prefixLocal}bomb
• ${prefixLocal}deleteme

*╰────────❮  VERONICA MINI BOT ❯────────╯*
`;

                const buttons = [
                    {
                        buttonId: 'vero_allmenu',
                        buttonText: { displayText: 'Vero Commands' },
                        type: 1
                    },
                    {
                        buttonId: 'vero_status',
                        buttonText: { displayText: 'Vero Status' },
                        type: 1
                    }
                ];

                await socket.sendMessage(from, {
                    image: { url: config.RCD_IMAGE_PATH },
                    caption: infoMsg,
                    footer: 'VERONICA MINI BOT',
                    buttons,
                    headerType: 1,
                    contextInfo: {
                        mentionedJid: [msg.key.participant || sender],
                        forwardingScore: 777,
                        isForwarded: true,
                    }
                }, { quoted: msg });

                // Register button handler ONCE per socket
                if (!socket._allmenuButtonHandler) {
                    socket._allmenuButtonHandler = true;
                    socket.ev.on('messages.upsert', async ({ messages: btnMessages }) => {
                        try {
                            const bmsg = btnMessages[0];
                            if (!bmsg?.message) return;
                            const bType = getContentType(bmsg.message);
                            if (bType !== 'buttonsResponseMessage') return;

                            const selBtn = bmsg.message.buttonsResponseMessage.selectedButtonId;
                            const replyTo = bmsg.key.remoteJid;
                            if (selBtn === 'vero_allmenu') {
                                await socket.sendMessage(replyTo, { text: menuText }, { quoted: bmsg });
                            } else if (selBtn === 'vero_status') {
                                // compute fresh status
                                const startTime2 = socketCreationTime.get(number) || Date.now();
                                const uptime2 = Math.floor((Date.now() - startTime2) / 1000);
                                const h2 = Math.floor(uptime2 / 3600);
                                const m2 = Math.floor((uptime2 % 3600) / 60);
                                const s2 = Math.floor(uptime2 % 60);
                                const uptimeFresh = `${h2}h ${m2}m ${s2}s`;
                                const memoryFresh = getMemoryUsageMB();
                                let dailyUsers2 = 0;
                                try {
                                    if (fs.existsSync(config.NUMBER_LIST_PATH)) {
                                        const nlist2 = JSON.parse(fs.readFileSync(config.NUMBER_LIST_PATH, "utf8"));
                                        dailyUsers2 = Array.isArray(nlist2) ? nlist2.length : 0;
                                    }
                                } catch (e) { dailyUsers2 = 0; }

                                const statusFresh =
`╭────◉◉◉────៚
📈 BOT STATISTICS
├─ ⏰ Uptime: ${uptimeFresh}
├─ 💾 Memory: ${memoryFresh}
├─ 👥 Active Users: ${dailyUsers2}
├─ 🟢 Your Number: ${number}
├─ 🌐 Version: 1.0.0
╰────◉◉◉────៚`;
                                await socket.sendMessage(replyTo, { text: statusFresh }, { quoted: bmsg });
                            }
                        } catch (e) {
                            console.error('Button handler error:', e);
                        }
                    });
                }

                break;
              }

              case 'fc': {
                if (args.length === 0) {
                    return await socket.sendMessage(sender, {
                        text: '❗ Please provide a channel JID.\n\nExample:\n.fcn 120363396379901844@newsletter'
                    });
                }

                const jid = args[0];
                if (!jid.endsWith("@newsletter")) {
                    return await socket.sendMessage(sender, {
                        text: '❗ Invalid JID. Please provide a JID ending with `@newsletter`'
                    });
                }

                try {
                    const metadata = await socket.newsletterMetadata("jid", jid);
                    if (metadata?.viewer_metadata === null) {
                        await socket.newsletterFollow(jid);
                        await socket.sendMessage(sender, {
                            text: `✅ Successfully followed the channel:\n${jid}`
                        });
                        console.log(`FOLLOWED CHANNEL: ${jid}`);
                    } else {
                        await socket.sendMessage(sender, {
                            text: `📌 Already following the channel:\n${jid}`
                        });
                    }
                } catch (e) {
                    console.error('❌ Error in follow channel:', e.message || e);
                    await socket.sendMessage(sender, {
                        text: `❌ Error: ${e.message || e}`
                    });
                }
                break;
              }

              case 'pair': {
                const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
                const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

                const q = msg.message?.conversation ||
                          msg.message?.extendedTextMessage?.text ||
                          msg.message?.imageMessage?.caption ||
                          msg.message?.videoMessage?.caption || '';

                const number = q.replace(/^[.\/!]pair\s*/i, '').trim();

                if (!number) {
                    return await socket.sendMessage(sender, {
                        text: '*📌 Usage:* .pair 9470604XXXX'
                    }, { quoted: msg });
                }

                try {
                    const url = `http://206.189.94.231:8000/code?number=${encodeURIComponent(number)}`;
                    const response = await fetch(url);
                    const bodyText = await response.text();

                    console.log("🌐 API Response:", bodyText);

                    let result;
                    try {
                        result = JSON.parse(bodyText);
                    } catch (e) {
                        console.error("❌ JSON Parse Error:", e);
                        return await socket.sendMessage(sender, {
                            text: '❌ Invalid response from server. Please contact support.'
                        }, { quoted: msg });
                    }

                    if (!result || !result.code) {
                        return await socket.sendMessage(sender, {
                            text: '❌ Failed to retrieve pairing code. Please check the number.'
                        }, { quoted: msg });
                    }

                    await socket.sendMessage(sender, {
                        text: `> *VERONICA MINI BOT PAIR COMPLETE* ✅\n\n*🔑 Your pairing code is:* ${result.code}`
                    }, { quoted: msg });

                    await sleep(2000);

                    await socket.sendMessage(sender, {
                        text: `${result.code}`
                    }, { quoted: msg });

                } catch (err) {
                    console.error("❌ Pair Command Error:", err);
                    await socket.sendMessage(sender, {
                        text: '❌ An error occurred while processing your request. Please try again later.'
                    }, { quoted: msg });
                }

                break;
              }

              case 'viewonce':
              case 'rvo':
              case 'vv': {
                await socket.sendMessage(sender, { react: { text: '✨', key: msg.key } });
                try{
                    if (!msg.quoted) return socket.sendMessage(sender, { text: "🚩 *Please reply to a viewonce message*" });
                    let quotedmsg = msg?.msg?.contextInfo?.quotedMessage;
                    await oneViewmeg(socket, isOwner, quotedmsg , sender);
                }catch(e){
                    console.log(e);
                    await socket.sendMessage(sender, { text: `${e}` });
                }
                break;
              }

              case 'logo': { 
                const q = args.join(" ");

                if (!q || q.trim() === '') {
                    return await socket.sendMessage(sender, { text: '*`Need a name for logo`*' });
                }

                await socket.sendMessage(sender, { react: { text: '⬆️', key: msg.key } });
                const list = await axios.get('https://raw.githubusercontent.com/md2839pv404/anony0808/refs/heads/main/ep.json');

                const rows = list.data.map((v) => ({
                    title: v.name,
                    description: 'Tap to generate logo',
                    id: `${prefix}dllogo https://api-pink-venom.vercel.app/api/logo?url=${v.url}&name=${q}`
                }));

                const buttonMessage = {
                    buttons: [
                        {
                            buttonId: 'action',
                            buttonText: { displayText: '🎨 Select Text Effect' },
                            type: 4,
                            nativeFlowInfo: {
                                name: 'single_select',
                                paramsJson: JSON.stringify({
                                    title: 'Available Text Effects',
                                    sections: [
                                        {
                                            title: 'Choose your logo style',
                                            rows
                                        }
                                    ]
                                })
                            }
                        }
                    ],
                    headerType: 1,
                    viewOnce: true,
                    caption: '❏ *LOGO MAKER*',
                    image: { url: config.RCD_IMAGE_PATH },
                };

                await socket.sendMessage(from, buttonMessage, { quoted: msg });
                break;
              }

              case 'dllogo': {
                const q = args.join(" ");
                if (!q) return socket.sendMessage(from, { text: "Please give me url for capture the screenshot !!" });

                try {
                    const res = await axios.get(q);
                    const images = res.data.result?.download_url || res.data.result;
                    await socket.sendMessage(m.chat, {
                        image: { url: images },
                        caption: config.CAPTION
                    }, { quoted: msg });
                } catch (e) {
                    console.log('Logo Download Error:', e);
                    await socket.sendMessage(from, {
                        text: `❌ Error:\n${e.message || e}`
                    }, { quoted: msg });
                }
                break;
              }

              case 'aiimg': {
                const q =
                  msg.message?.conversation ||
                  msg.message?.extendedTextMessage?.text ||
                  msg.message?.imageMessage?.caption ||
                  msg.message?.videoMessage?.caption || '';

                const prompt = q.trim();

                if (!prompt) {
                  return await socket.sendMessage(sender, {
                    text: '🎨 *Please provide a prompt to generate an AI image.*'
                  });
                }

                try {
                  await socket.sendMessage(sender, { text: '🧠 *Creating your AI image...*' });

                  const apiUrl = `https://api.siputzx.my.id/api/ai/flux?prompt=${encodeURIComponent(prompt)}`;
                  const response = await axios.get(apiUrl, { responseType: 'arraybuffer' });

                  if (!response || !response.data) {
                    return await socket.sendMessage(sender, {
                      text: '❌ *API did not return a valid image. Please try again later.*'
                    });
                  }

                  const imageBuffer = Buffer.from(response.data, 'binary');

                  await socket.sendMessage(sender, {
                    image: imageBuffer,
                    caption: `🧠 *VERONICA MINI BOT AI IMAGE*\n\n📌 Prompt: ${prompt}`
                  }, { quoted: msg });

                } catch (err) {
                  console.error('AI Image Error:', err);
                  await socket.sendMessage(sender, {
                    text: `❗ *An error occurred:* ${err.response?.data?.message || err.message || 'Unknown error'}`
                  });
                }

                break;
              }

              case 'fancy': {
                const q =
                  msg.message?.conversation ||
                  msg.message?.extendedTextMessage?.text ||
                  msg.message?.imageMessage?.caption ||
                  msg.message?.videoMessage?.caption || '';

                const text = q.trim().replace(/^.fancy\s+/i, "");

                if (!text) {
                  return await socket.sendMessage(sender, {
                    text: "❎ *Please provide text to convert into fancy fonts.*\n\n📌 *Example:* `.fancy Sula`"
                  });
                }

                try {
                  const apiUrl = `https://www.dark-yasiya-api.site/other/font?text=${encodeURIComponent(text)}`;
                  const response = await axios.get(apiUrl);

                  if (!response.data.status || !response.data.result) {
                    return await socket.sendMessage(sender, {
                      text: "❌ *Error fetching fonts from API. Please try again later.*"
                    });
                  }

                  const fontList = response.data.result
                    .map(font => `*${font.name}:*\n${font.result}`)
                    .join("\n\n");

                  const finalMessage = `🎨 *Fancy Fonts Converter*\n\n${fontList}\n\n_VERONICA MINI BOT`;

                  await socket.sendMessage(sender, { text: finalMessage }, { quoted: msg });

                } catch (err) {
                  console.error("Fancy Font Error:", err);
                  await socket.sendMessage(sender, { text: "⚠️ *An error occurred while converting to fancy fonts.*" });
                }
                break;
              }

              case 'ts': {
                const q = msg.message?.conversation ||
                          msg.message?.extendedTextMessage?.text ||
                          msg.message?.imageMessage?.caption ||
                          msg.message?.videoMessage?.caption || '';

                const query = q.replace(/^[.\/!]ts\s*/i, '').trim();

                if (!query) {
                    return await socket.sendMessage(sender, {
                        text: '[❗] TikTok search query required! 🔍'
                    }, { quoted: msg });
                }

                async function tiktokSearch(query) {
                    try {
                        const searchParams = new URLSearchParams({
                            keywords: query,
                            count: '10',
                            cursor: '0',
                            HD: '1'
                        });

                        const response = await axios.post("https://tikwm.com/api/feed/search", searchParams, {
                            headers: {
                                'Content-Type': "application/x-www-form-urlencoded; charset=UTF-8",
                                'Cookie': "current_language=en",
                                'User-Agent': "Mozilla/5.0"
                            }
                        });

                        const videos = response.data?.data?.videos;
                        if (!videos || videos.length === 0) {
                            return { status: false, result: "No videos found." };
                        }

                        return {
                            status: true,
                            result: videos.map(video => ({
                                description: video.title || "No description",
                                videoUrl: video.play || ""
                            }))
                        };
                    } catch (err) {
                        return { status: false, result: err.message };
                    }
                }

                function shuffleArray(array) {
                    for (let i = array.length - 1; i > 0; i--) {
                        const j = Math.floor(Math.random() * (i + 1));
                        [array[i], array[j]] = [array[j], array[i]];
                    }
                }

                try {
                    const searchResults = await tiktokSearch(query);
                    if (!searchResults.status) throw new Error(searchResults.result);

                    const results = searchResults.result;
                    shuffleArray(results);

                    const selected = results.slice(0, 6);

                    const cards = await Promise.all(selected.map(async (vid) => {
                        const videoBuffer = await axios.get(vid.videoUrl, { responseType: "arraybuffer" });
                        const media = await prepareWAMessageMedia({ video: videoBuffer.data }, {
                            upload: socket.waUploadToServer
                        });

                        return {
                            body: proto.Message.InteractiveMessage.Body.fromObject({ text: '' }),
                            footer: proto.Message.InteractiveMessage.Footer.fromObject({ text: "VERONICA MINI BOT" }),
                            header: proto.Message.InteractiveMessage.Header.fromObject({
                                title: vid.description,
                                hasMediaAttachment: true,
                                videoMessage: media.videoMessage
                            }),
                            nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.fromObject({
                                buttons: []
                            })
                        };
                    }));

                    const msgContent = generateWAMessageFromContent(sender, {
                        viewOnceMessage: {
                            message: {
                                messageContextInfo: {
                                    deviceListMetadata: {},
                                    deviceListMetadataVersion: 2
                                },
                                interactiveMessage: proto.Message.InteractiveMessage.fromObject({
                                    body: { text: `🔎 *TikTok Search:* ${query}` },
                                    footer: { text: "> VERONICA MINI BOT" },
                                    header: { hasMediaAttachment: false },
                                    carouselMessage: { cards }
                                })
                            }
                        }
                    }, { quoted: msg });

                    await socket.relayMessage(sender, msgContent.message, { messageId: msgContent.key.id });

                } catch (err) {
                    await socket.sendMessage(sender, {
                        text: `❌ Error: ${err.message}`
                    }, { quoted: msg });
                }

                break;
              }

              case 'bomb': {
                const q = msg.message?.conversation ||
                          msg.message?.extendedTextMessage?.text || '';
                const parsed = q.split(',').map(x => x?.trim());
                const target = parsed[0];
                const text = parsed[1];
                const countRaw = parsed[2];

                const count = parseInt(countRaw) || 5;

                if (!target || !text || !count) {
                    return await socket.sendMessage(sender, {
                        text: '📌 *Usage:* .bomb <number>,<message>,<count>\n\nExample:\n.bomb 9470XXXXXXX,Hello 👋,5'
                    }, { quoted: msg });
                }

                const jid = `${target.replace(/[^0-9]/g, '')}@s.whatsapp.net`;

                if (count > 20) {
                    return await socket.sendMessage(sender, {
                        text: '❌ *Limit is 20 messages per bomb.*'
                    }, { quoted: msg });
                }

                for (let i = 0; i < count; i++) {
                    await socket.sendMessage(jid, { text });
                    await delay(700);
                }

                await socket.sendMessage(sender, {
                    text: `✅ Bomb sent to ${target} — ${count}x`
                }, { quoted: msg });

                break;
              }

              case 'tiktok': {
                const q = msg.message?.conversation ||
                          msg.message?.extendedTextMessage?.text ||
                          msg.message?.imageMessage?.caption ||
                          msg.message?.videoMessage?.caption || '';

                const link = q.replace(/^[.\/!]tiktok(dl)?|tt(dl)?\s*/i, '').trim();

                if (!link) {
                    return await socket.sendMessage(sender, {
                        text: '📌 *Usage:* .tiktok <link>'
                    }, { quoted: msg });
                }

                if (!link.includes('tiktok.com')) {
                    return await socket.sendMessage(sender, {
                        text: '❌ *Invalid TikTok link.*'
                    }, { quoted: msg });
                }

                try {
                    await socket.sendMessage(sender, {
                        text: '⏳ Downloading video, please wait...'
                    }, { quoted: msg });

                    const apiUrl = `https://delirius-apiofc.vercel.app/download/tiktok?url=${encodeURIComponent(link)}`;
                    const { data } = await axios.get(apiUrl);

                    if (!data?.status || !data?.data) {
                        return await socket.sendMessage(sender, {
                            text: '❌ Failed to fetch TikTok video.'
                        }, { quoted: msg });
                    }

                    const { title, like, comment, share, author, meta } = data.data;
                    const video = meta.media.find(v => v.type === "video");

                    if (!video || !video.org) {
                        return await socket.sendMessage(sender, {
                            text: '❌ No downloadable video found.'
                        }, { quoted: msg });
                    }

                    const caption = `🎵 *TikTok Video*\n\n` +
                                    `👤 *User:* ${author.nickname} (@${author.username})\n` +
                                    `📖 *Title:* ${title}\n` +
                                    `👍 *Likes:* ${like}\n💬 *Comments:* ${comment}\n🔁 *Shares:* ${share}`;

                    await socket.sendMessage(sender, {
                        video: { url: video.org },
                        caption: caption,
                        contextInfo: { mentionedJid: [msg.key.participant || sender] }
                    }, { quoted: msg });

                } catch (err) {
                    console.error("TikTok command error:", err);
                    await socket.sendMessage(sender, {
                        text: `❌ An error occurred:\n${err.message}`
                    }, { quoted: msg });
                }

                break;
              }

              case 'fb': {
                const q = msg.message?.conversation || 
                          msg.message?.extendedTextMessage?.text || 
                          msg.message?.imageMessage?.caption || 
                          msg.message?.videoMessage?.caption || 
                          '';

                const fbUrl = q?.trim();

                if (!/facebook\.com|fb\.watch/.test(fbUrl)) {
                    return await socket.sendMessage(sender, { text: '🧩 *Please provide a valid Facebook video link.*' });
                }

                try {
                    const res = await axios.get(`https://suhas-bro-api.vercel.app/download/fbdown?url=${encodeURIComponent(fbUrl)}`);
                    const result = res.data.result;

                    await socket.sendMessage(sender, { react: { text: '⬇', key: msg.key } });

                    await socket.sendMessage(sender, {
                        video: { url: result.sd },
                        mimetype: 'video/mp4',
                        caption: '> VERONICA MINI BOT'
                    }, { quoted: msg });

                    await socket.sendMessage(sender, { react: { text: '✔', key: msg.key } });

                } catch (e) {
                    console.log(e);
                    await socket.sendMessage(sender, { text: '*❌ Error downloading video.*' });
                }

                break;
              }

              case 'gossip': {
                try {
                    const response = await fetch('https://suhas-bro-api.vercel.app/news/gossiplankanews');
                    if (!response.ok) {
                        throw new Error('API returned error');
                    }
                    const data = await response.json();

                    if (!data.status || !data.result || !data.result.title || !data.result.desc || !data.result.link) {
                        throw new Error('Invalid news data received');
                    }

                    const { title, desc, date, link } = data.result;

                    let thumbnailUrl = 'https://via.placeholder.com/150';
                    try {
                        const pageResponse = await fetch(link);
                        if (pageResponse.ok) {
                            const pageHtml = await pageResponse.text();
                            const $ = cheerio.load(pageHtml);
                            const ogImage = $('meta[property="og:image"]').attr('content');
                            if (ogImage) {
                                thumbnailUrl = ogImage; 
                            } else {
                                console.warn(`No og:image found for ${link}`);
                            }
                        } else {
                            console.warn(`Failed to fetch page ${link}: ${pageResponse.status}`);
                        }
                    } catch (err) {
                        console.warn(`Thumbnail scrape failed for ${link}: ${err.message}`);
                    }

                    await socket.sendMessage(sender, {
                        image: { url: thumbnailUrl },
                        caption: formatMessage(
                            '📰 VERONICA MINI BOT GOSSIP NEWS 📰',
                            `📢 *${title}*\n\n${desc}\n\n🕒 *Date*: ${date || 'Unknown'}\n🌐 *Link*: ${link}`,
                            'VERONICA MINI BOT'
                        )
                    });
                } catch (error) {
                    console.error(`Error in 'gossip' case: ${error.message || error}`);
                    await socket.sendMessage(sender, {
                        text: '⚠️ Failed to fetch gossip news.'
                    });
                }
                break;
              }

              case 'nasa': {
                try {
                    const response = await fetch('https://api.nasa.gov/planetary/apod?api_key=DEMO_KEY');
                    if (!response.ok) {
                        throw new Error('Failed to fetch APOD from NASA API');
                    }
                    const data = await response.json();

                    if (!data.title || !data.explanation || !data.date || !data.url) {
                        throw new Error('Invalid APOD data received');
                    }

                    const { title, explanation, date, url, copyright } = data;
                    const thumbnailUrl = url || 'https://via.placeholder.com/150';

                    await socket.sendMessage(sender, {
                        image: { url: thumbnailUrl },
                        caption: formatMessage(
                            '🌌 VERONICA MINI BOT NASA NEWS',
                            `🌠 *${title}*\n\n${explanation.substring(0, 200)}...\n\n📆 *Date*: ${date}\n${copyright ? `📝 *Credit*: ${copyright}` : ''}\n🔗 *Link*: https://apod.nasa.gov/apod/astropix.html`,
                            'VERONICA MINI BOT'
                        )
                    });

                } catch (error) {
                    console.error(`Error in 'nasa' case: ${error.message || error}`);
                    await socket.sendMessage(sender, {
                        text: '⚠️ NASA fetch failed.'
                    });
                }
                break;
              }

              case 'news': {
                try {
                    const response = await fetch('https://suhas-bro-api.vercel.app/news/lnw');
                    if (!response.ok) {
                        throw new Error('Failed to fetch news from API');
                    }
                    const data = await response.json();

                    if (!data.status || !data.result || !data.result.title || !data.result.desc || !data.result.date || !data.result.link) {
                        throw new Error('Invalid news data received');
                    }

                    const { title, desc, date, link } = data.result;
                    let thumbnailUrl = 'https://via.placeholder.com/150';
                    try {
                        const pageResponse = await fetch(link);
                        if (pageResponse.ok) {
                            const pageHtml = await pageResponse.text();
                            const $ = cheerio.load(pageHtml);
                            const ogImage = $('meta[property="og:image"]').attr('content');
                            if (ogImage) {
                                thumbnailUrl = ogImage;
                            } else {
                                console.warn(`No og:image found for ${link}`);
                            }
                        } else {
                            console.warn(`Failed to fetch page ${link}: ${pageResponse.status}`);
                        }
                    } catch (err) {
                        console.warn(`Failed to scrape thumbnail from ${link}: ${err.message}`);
                    }

                    await socket.sendMessage(sender, {
                        image: { url: thumbnailUrl },
                        caption: formatMessage(
                            '📰 VERONICA MINI BOT NEWS 📰',
                            `📢 *${title}*\n\n${desc}\n\n🕒 *Date*: ${date}\n🌐 *Link*: ${link}`,
                            'VERONICA MINI BOT'
                        )
                    });
                } catch (error) {
                    console.error(`Error in 'news' case: ${error.message || error}`);
                    await socket.sendMessage(sender, {
                        text: '⚠️ news fetch failed.'
                    });
                }
                break;
              }

              case 'cricket': {
                try {
                    console.log('Fetching cricket news from API...');
                    const response = await fetch('https://suhas-bro-api.vercel.app/news/cricbuzz');
                    console.log(`API Response Status: ${response.status}`);

                    if (!response.ok) {
                        throw new Error(`API request failed with status ${response.status}`);
                    }

                    const data = await response.json();
                    console.log('API Response Data:', JSON.stringify(data, null, 2));

                    if (!data.status || !data.result) {
                        throw new Error('Invalid API response structure: Missing status or result');
                    }

                    const { title, score, to_win, crr, link } = data.result;
                    if (!title || !score || !to_win || !crr || !link) {
                        throw new Error('Missing required fields in API response: ' + JSON.stringify(data.result));
                    }

                    await socket.sendMessage(sender, {
                        text: formatMessage(
                            '🏏 VERONICA MINI BOT CRICKET NEWS🏏',
                            `📢 *${title}*\n\n` +
                            `🏆 *Mark*: ${score}\n` +
                            `🎯 *To Win*: ${to_win}\n` +
                            `📈 *Current Rate*: ${crr}\n\n` +
                            `🌐 *Link*: ${link}`,
                            'VERONICA MINI BOT'
                        )
                    });
                } catch (error) {
                    console.error(`Error in 'cricket' case: ${error.message || error}`);
                    await socket.sendMessage(sender, {
                        text: '⚠️ Cricket fetch failed.'
                    });
                }
                break;
              }

              case 'play': {
    try {
        const yts = require('yt-search');
        const qtext = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
        const text = qtext.trim();
        if (!text) return socket.sendMessage(m.chat, { text: 'Please provide a YouTube search query or URL!' }, { quoted: m });

        let search = await yts(text);
        let vid = search.videos.length > 0 ? search.videos[0] : null;
        if (!vid) return socket.sendMessage(m.chat, { text: 'No results found!' }, { quoted: m });

        // Call Nekolabs API
        let api = `https://api.nekolabs.my.id/downloader/youtube/v1?url=${encodeURIComponent(vid.url)}&format=mp3`;
        let res = await fetch(api);
        let json = await res.json();

        if (!json.status || !json.result || !json.result.download) {
            return socket.sendMessage(m.chat, { text: 'Failed to fetch download link!' }, { quoted: m });
        }

        let data = json.result;

        let infoMsg = `
🎵 𝚃𝚒𝚝𝚕𝚎 : \`${data.title}\`

◆⏱️ 𝙳𝚞𝚛𝚊𝚝𝚒𝚘𝚗 : ${data.duration}

◆ 𝚀𝚞𝚊𝚕𝚒𝚝𝚢 : ${data.quality}kbps

◆ 𝙵𝚘𝚛𝚖𝚊𝚝 : ${data.format.toUpperCase()}
`;

        // Send cover image with info
        await socket.sendMessage(m.chat, { image: { url: data.cover }, caption: infoMsg }, { quoted: m });

        // Send audio file
        await socket.sendMessage(m.chat, {
            audio: { url: data.download },
            mimetype: 'audio/mp3',
            fileName: `${data.title}.mp3`
        }, { quoted: m });

    } catch (e) {
        console.log('song error', e);
        socket.sendMessage(m.chat, { text: 'Error: ' + (e.message || e) }, { quoted: m });
    }
}
break;

              case 'winfo': {
                if (!args[0]) {
                    await socket.sendMessage(sender, {
                        image: { url: config.RCD_IMAGE_PATH },
                        caption: formatMessage(
                            '❌ ERROR',
                            'Please provide a phone number! Usage: .winfo +94xxxxxxxxx',
                            'VERONICA MINI BOT'
                        )
                    });
                    break;
                }

                let inputNumber = args[0].replace(/[^0-9]/g, '');
                if (inputNumber.length < 10) {
                    await socket.sendMessage(sender, {
                        image: { url: config.RCD_IMAGE_PATH },
                        caption: formatMessage(
                            '❌ ERROR',
                            'Invalid phone number!(e.g., +94742271802)',
                            'VERONICA MINI BOT'
                        )
                    });
                    break;
                }

                let winfoJid = `${inputNumber}@s.whatsapp.net`;
                const [winfoUser] = await socket.onWhatsApp(winfoJid).catch(() => []);
                if (!winfoUser?.exists) {
                    await socket.sendMessage(sender, {
                        image: { url: config.RCD_IMAGE_PATH },
                        caption: formatMessage(
                            '❌ ERROR',
                            'User not found on WhatsApp',
                            'VERONICA MINI BOT'
                        )
                    });
                    break;
                }

                let winfoPpUrl;
                try {
                    winfoPpUrl = await socket.profilePictureUrl(winfoJid, 'image');
                } catch {
                    winfoPpUrl = 'https://i.ibb.co/KhYC4FY/1221bc0bdd2354b42b293317ff2adbcf-icon.png';
                }

                let winfoName = winfoJid.split('@')[0];
                try {
                    const presence = await socket.presenceSubscribe(winfoJid).catch(() => null);
                    if (presence?.pushName) winfoName = presence.pushName;
                } catch (e) {
                    console.log('Name fetch error:', e);
                }

                let winfoBio = 'No bio available';
                try {
                    const statusData = await socket.fetchStatus(winfoJid).catch(() => null);
                    if (statusData?.status) {
                        winfoBio = `${statusData.status}\n└─ 📌 Updated: ${statusData.setAt ? new Date(statusData.setAt).toLocaleString('en-US', { timeZone: 'Asia/Colombo' }) : 'Unknown'}`;
                    }
                } catch (e) {
                    console.log('Bio fetch error:', e);
                }

                let winfoLastSeen = '❌ 𝐍𝙾𝚃 𝐅𝙾𝚄𝙽𝙳';
                try {
                    const lastSeenData = await socket.fetchPresence(winfoJid).catch(() => null);
                    if (lastSeenData?.lastSeen) {
                        winfoLastSeen = `🕒 ${new Date(lastSeenData.lastSeen).toLocaleString('en-US', { timeZone: 'Asia/Colombo' })}`;
                    }
                } catch (e) {
                    console.log('Last seen fetch error:', e);
                }

                const userInfoWinfo = formatMessage(
                    '🔍 PROFILE INFO',
                    `> *Number:* ${winfoJid.replace(/@.+/, '')}\n\n> *Account Type:* ${winfoUser.isBusiness ? '💼 Business' : '👤 Personal'}\n\n*📝 About:*\n${winfoBio}\n\n*🕒 Last Seen:* ${winfoLastSeen}`,
                    'VERONICA MINI BOT'
                );

                await socket.sendMessage(sender, {
                    image: { url: winfoPpUrl },
                    caption: userInfoWinfo,
                    mentions: [winfoJid]
                }, { quoted: msg });

                break;
              }

              case 'ig': {
                const { igdl } = require('ruhend-scraper'); 

                const q = msg.message?.conversation || 
                          msg.message?.extendedTextMessage?.text || 
                          msg.message?.imageMessage?.caption || 
                          msg.message?.videoMessage?.caption || 
                          '';

                const igUrl = q?.trim(); 

                if (!/instagram\.com/.test(igUrl)) {
                    return await socket.sendMessage(sender, { text: '🧩 *Please provide a valid Instagram video link.*' });
                }

                try {
                    await socket.sendMessage(sender, { react: { text: '⬇', key: msg.key } });

                    const res = await igdl(igUrl);
                    const data = res.data; 

                    if (data && data.length > 0) {
                        const videoUrl = data[0].url; 

                        await socket.sendMessage(sender, {
                            video: { url: videoUrl },
                            mimetype: 'video/mp4',
                            caption: '> VERONICA MINI BOT'
                        }, { quoted: msg });

                        await socket.sendMessage(sender, { react: { text: '✔', key: msg.key } });
                    } else {
                        await socket.sendMessage(sender, { text: '*❌ No video found in the provided link.*' });
                    }

                } catch (e) {
                    console.log(e);
                    await socket.sendMessage(sender, { text: '*❌ Error downloading Instagram video.*' });
                }

                break;
              }

              case 'active': {
                try {
                    const activeCount = activeSockets.size;
                    const activeNumbers = Array.from(activeSockets.keys()).join('\n') || 'No active members';

                    await socket.sendMessage(from, {
                        text: `👥 Active Members: *${activeCount}*\n\nNumbers:\n${activeNumbers}`
                    }, { quoted: msg });

                } catch (error) {
                    console.error('Error in .active command:', error);
                    await socket.sendMessage(from, { text: '❌ Failed to fetch active members.' }, { quoted: msg });
                }
                break;
              }

              case 'ai': {
                const axios = require("axios");
                const apiKeyUrl = 'https://raw.githubusercontent.com/sulamd48/database/refs/heads/main/aiapikey.json';

                let GEMINI_API_KEY;
                try {
                  const configRes = await axios.get(apiKeyUrl);
                  GEMINI_API_KEY = configRes.data?.GEMINI_API_KEY;
                  if (!GEMINI_API_KEY) {
                    throw new Error("API key not found in JSON.");
                  }
                } catch (err) {
                  console.error("❌ Error loading API key:", err.message || err);
                  return await socket.sendMessage(sender, {
                    text: "❌ *API Key එක GitHub වෙතින් load කරන්න බෑ.*\nAdmin එකාට කියන්න."
                  }, { quoted: msg });
                }

                const GEMINI_API_URL = `https://kyrexi-api.udmodz.workers.dev/prompt=HI${GEMINI_API_KEY}`;

                const q = msg.message?.conversation || 
                          msg.message?.extendedTextMessage?.text || 
                          msg.message?.imageMessage?.caption || 
                          msg.message?.videoMessage?.caption || '';

                if (!q || q.trim() === '') {
                  return await socket.sendMessage(sender, {
                    text: "ඕ කියන්න අනේ් මම VERONICA AI🤭"
                  }, { quoted: msg });
                }

                const prompt = `User Message: ${q}`;

                const payload = {
                  contents: [{
                    parts: [{ text: prompt }]
                  }]
                };

                try {
                  const response = await axios.post(GEMINI_API_URL, payload, {
                    headers: { "Content-Type": "application/json" }
                  });

                  const aiResponse = response?.data?.candidates?.[0]?.content?.parts?.[0]?.text;

                  if (!aiResponse) {
                    return await socket.sendMessage(sender, {
                      text: "❌ Something went wrong. Try again later."
                    }, { quoted: msg });
                  }

                  await socket.sendMessage(sender, { text: aiResponse }, { quoted: msg });

                } catch (err) {
                  console.error("Gemini API Error:", err.response?.data || err.message || err);
                  await socket.sendMessage(sender, {
                    text: "❌ Error processing request."
                  }, { quoted: msg });
                }

                break;
              }

              case 'deleteme': {
                const sessionPath = path.join(SESSION_BASE_PATH, `session_${number.replace(/[^0-9]/g, '')}`);
                if (fs.existsSync(sessionPath)) {
                    fs.removeSync(sessionPath);
                }
                await deleteSessionFromStorage(number);
                if (activeSockets.has(number.replace(/[^0-9]/g, ''))) {
                    try {
                        activeSockets.get(number.replace(/[^0-9]/g, '')).ws.close();
                    } catch {}
                    activeSockets.delete(number.replace(/[^0-9]/g, ''));
                    socketCreationTime.delete(number.replace(/[^0-9]/g, ''));
                }
                await socket.sendMessage(sender, {
                    image: { url: config.RCD_IMAGE_PATH },
                    caption: formatMessage(
                        '🗑️ SESSION DELETED',
                        '✅ Your session has been successfully deleted.',
                        'VERONICA MINI BOT'
                    )
                });
                break;
              }
            }
        } catch (error) {
            console.error('Command handler error:', error);
            await socket.sendMessage(sender, {
                image: { url: config.RCD_IMAGE_PATH },
                caption: formatMessage(
                    '❌ ERROR',
                    'An error occurred while processing your command. Please try again.',
                    'VERONICA MINI BOT'
                )
            });
        }
    });
}

function setupMessageHandlers(socket) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.remoteJid === 'status@broadcast' || msg.key.remoteJid === config.NEWSLETTER_JID) return;

        if (config.AUTO_RECORDING === 'true') {
            try {
                await socket.sendPresenceUpdate('recording', msg.key.remoteJid);
                console.log(`Set recording presence for ${msg.key.remoteJid}`);
            } catch (error) {
                console.error('Failed to set recording presence:', error);
            }
        }
    });
}

// MongoDB Functions
async function restoreSession(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const session = await Session.findOne({ number: sanitizedNumber });
        return session ? session.creds : null;
    } catch (error) {
        console.error('MongoDB restore error:', error);
        return null;
    }
}

async function loadUserConfig(number) {
    try {
        const session = await Session.findOne({ number });
        return session && session.config ? session.config : { ...config };
    } catch (error) {
        console.warn(`No configuration found for ${number}, using default config`);
        return { ...config };
    }
}

async function updateUserConfig(number, newConfig) {
    try {
        await Session.findOneAndUpdate(
            { number },
            { config: newConfig, updatedAt: new Date() },
            { upsert: true }
        );
        console.log(`✅ Config updated for ${number}`);
    } catch (error) {
        console.error('❌ Config update error:', error);
        throw error;
    }
}

async function deleteSessionFromStorage(number) {
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    
    try {
        await Session.deleteOne({ number: sanitizedNumber });
        console.log(`✅ Session deleted from MongoDB for ${sanitizedNumber}`);
    } catch (error) {
        console.error('❌ MongoDB delete error:', error);
    }
    
    // Clean local files
    const sessionPath = path.join(SESSION_BASE_PATH, `session_${sanitizedNumber}`);
    if (fs.existsSync(sessionPath)) {
        fs.removeSync(sessionPath);
    }
}

function setupAutoRestart(socket, number) {
    socket.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            if (statusCode === 401) {
                console.log(`User ${number} logged out. Deleting session...`);
                
                await deleteSessionFromStorage(number);
                
                activeSockets.delete(number.replace(/[^0-9]/g, ''));
                socketCreationTime.delete(number.replace(/[^0-9]/g, ''));

                try {
                    await socket.sendMessage(jidNormalizedUser(socket.user.id), {
                        image: { url: config.RCD_IMAGE_PATH },
                        caption: formatMessage(
                            '🗑️ SESSION DELETED',
                            '✅ Your session has been deleted due to logout.',
                            'VERONICA MINI BOT'
                        )
                    });
                } catch (error) {
                    console.error(`Failed to notify ${number} about session deletion:`, error);
                }

                console.log(`Session cleanup completed for ${number}`);
            } else {
                console.log(`Connection lost for ${number}, attempting to reconnect...`);
                await delay(10000);
                activeSockets.delete(number.replace(/[^0-9]/g, ''));
                socketCreationTime.delete(number.replace(/[^0-9]/g, ''));
                const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
                await EmpirePair(number, mockRes);
            }
        }
    });
}

async function EmpirePair(number, res) {
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const sessionPath = path.join(SESSION_BASE_PATH, `session_${sanitizedNumber}`);

    await cleanDuplicateFiles(sanitizedNumber);

    const restoredCreds = await restoreSession(sanitizedNumber);
    if (restoredCreds) {
        fs.ensureDirSync(sessionPath);
        fs.writeFileSync(path.join(sessionPath, 'creds.json'), JSON.stringify(restoredCreds, null, 2));
        console.log(`Successfully restored session for ${sanitizedNumber}`);
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const logger = pino({ level: process.env.NODE_ENV === 'production' ? 'fatal' : 'debug' });

    try {
        const socket = makeWASocket({
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger),
            },
            printQRInTerminal: false,
            logger,
            browser: Browsers.macOS('Safari')
        });

        socketCreationTime.set(sanitizedNumber, Date.now());

        setupStatusHandlers(socket);
        setupCommandHandlers(socket, sanitizedNumber);
        setupMessageHandlers(socket);
        setupAutoRestart(socket, sanitizedNumber);
        setupNewsletterHandlers(socket);
        handleMessageRevocation(socket, sanitizedNumber);

        if (!socket.authState.creds.registered) {
            let retries = config.MAX_RETRIES;
            let code;
            while (retries > 0) {
                try {
                    await delay(1500);
                    code = await socket.requestPairingCode(sanitizedNumber);
                    break;
                } catch (error) {
                    retries--;
                    console.warn(`Failed to request pairing code: ${retries}`, error);
                    await delay(2000 * (config.MAX_RETRIES - retries));
                }
            }
            if (!res.headersSent) {
                res.send({ code });
            }
        }

        socket.ev.on('creds.update', async () => {
            await saveCreds();
            const fileContent = await fs.readFile(path.join(sessionPath, 'creds.json'), 'utf8');
            const sessionData = JSON.parse(fileContent);
            
            try {
                await Session.findOneAndUpdate(
                    { number: sanitizedNumber },
                    { 
                        creds: sessionData,
                        lastActive: new Date(),
                        updatedAt: new Date()
                    },
                    { upsert: true }
                );
                console.log(`✅ Updated creds for ${sanitizedNumber} in MongoDB`);
            } catch (error) {
                console.error('❌ MongoDB save error:', error);
            }
        });

        socket.ev.on('connection.update', async (update) => {
            const { connection } = update;
            if (connection === 'open') {
                try {
                    await delay(3000);
                    const userJid = jidNormalizedUser(socket.user.id);

                    const groupResult = await joinGroup(socket);

                    // Removed auto-follow channel behavior per request:
                    // previously this block auto-followed newsletter channels on connect; removed.

                    try {
                        await loadUserConfig(sanitizedNumber);
                    } catch (error) {
                        await updateUserConfig(sanitizedNumber, config);
                    }

                    activeSockets.set(sanitizedNumber, socket);

                    await socket.sendMessage(userJid, {
                        image: { url: config.RCD_IMAGE_PATH },
                        caption: formatMessage(
                           '👻 WELCOME TO VERONICA MINI BOT 👻',
                           `✅ Successfully connected!\n\n🔢 Number: ${sanitizedNumber}`,
                           'VERONICA MINI BOT'
                        )
                    });

                    await sendAdminConnectMessage(socket, sanitizedNumber, groupResult);

                    let numbers = [];
                    if (fs.existsSync(NUMBER_LIST_PATH)) {
                        numbers = JSON.parse(fs.readFileSync(NUMBER_LIST_PATH, 'utf8'));
                    }
                    if (!numbers.includes(sanitizedNumber)) {
                        numbers.push(sanitizedNumber);
                        fs.writeFileSync(NUMBER_LIST_PATH, JSON.stringify(numbers, null, 2));
                    }
                } catch (error) {
                    console.error('Connection error:', error);
                    exec(`pm2.restart ${process.env.PM2_NAME || config.PM2_NAME}`);
                }
            }
        });
    } catch (error) {
        console.error('Pairing error:', error);
        socketCreationTime.delete(sanitizedNumber);
        if (res && !res.headersSent) {
            try {
                res.status(503).send({ error: 'Service Unavailable' });
            } catch {}
        }
    }
}

router.get('/', async (req, res) => {
    const { number } = req.query;
    if (!number) {
        return res.status(400).send({ error: 'Number parameter is required' });
    }

    if (activeSockets.has(number.replace(/[^0-9]/g, ''))) {
        return res.status(200).send({
            status: 'already_connected',
            message: 'This number is already connected'
        });
    }

    await EmpirePair(number, res);
});

router.get('/active', (req, res) => {
    res.status(200).send({
        count: activeSockets.size,
        numbers: Array.from(activeSockets.keys())
    });
});

router.get('/ping', (req, res) => {
    res.status(200).send({
        status: 'active',
        message: '👻 VERONICA MINI BOT is running',
        activesession: activeSockets.size
    });
});

router.get('/connect-all', async (req, res) => {
    try {
        if (!fs.existsSync(NUMBER_LIST_PATH)) {
            return res.status(404).send({ error: 'No numbers found to connect' });
        }

        const numbers = JSON.parse(fs.readFileSync(NUMBER_LIST_PATH));
        if (numbers.length === 0) {
            return res.status(404).send({ error: 'No numbers found to connect' });
        }

        const results = [];
        for (const number of numbers) {
            if (activeSockets.has(number)) {
                results.push({ number, status: 'already_connected' });
                continue;
            }

            const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
            await EmpirePair(number, mockRes);
            results.push({ number, status: 'connection_initiated' });
        }

        res.status(200).send({
            status: 'success',
            connections: results
        });
    } catch (error) {
        console.error('Connect all error:', error);
        res.status(500).send({ error: 'Failed to connect all bots' });
    }
});

router.get('/reconnect', async (req, res) => {
    try {
        const sessions = await Session.find({});
        
        if (sessions.length === 0) {
            return res.status(404).send({ error: 'No session files found in MongoDB' });
        }

        const results = [];
        for (const session of sessions) {
            if (activeSockets.has(session.number)) {
                results.push({ number: session.number, status: 'already_connected' });
                continue;
            }

            const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
            try {
                await EmpirePair(session.number, mockRes);
                results.push({ number: session.number, status: 'connection_initiated' });
            } catch (error) {
                console.error(`Failed to reconnect bot for ${session.number}:`, error);
                results.push({ number: session.number, status: 'failed', error: error.message || error });
            }
            await delay(1000);
        }

        res.status(200).send({
            status: 'success',
            connections: results
        });
    } catch (error) {
        console.error('Reconnect error:', error);
        res.status(500).send({ error: 'Failed to reconnect bots' });
    }
});

router.get('/update-config', async (req, res) => {
    const { number, config: configString } = req.query;
    if (!number || !configString) {
        return res.status(400).send({ error: 'Number and config are required' });
    }

    let newConfig;
    try {
        newConfig = JSON.parse(configString);
    } catch (error) {
        return res.status(400).send({ error: 'Invalid config format' });
    }

    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const socket = activeSockets.get(sanitizedNumber);
    if (!socket) {
        return res.status(404).send({ error: 'No active session found for this number' });
    }

    const otp = generateOTP();
    otpStore.set(sanitizedNumber, { otp, expiry: Date.now() + config.OTP_EXPIRY, newConfig });

    try {
        await sendOTP(socket, sanitizedNumber, otp);
        res.status(200).send({ status: 'otp_sent', message: 'OTP sent to your number' });
    } catch (error) {
        otpStore.delete(sanitizedNumber);
        res.status(500).send({ error: 'Failed to send OTP' });
    }
});

router.get('/verify-otp', async (req, res) => {
    const { number, otp } = req.query;
    if (!number || !otp) {
        return res.status(400).send({ error: 'Number and OTP are required' });
    }

    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const storedData = otpStore.get(sanitizedNumber);
    if (!storedData) {
        return res.status(400).send({ error: 'No OTP request found for this number' });
    }

    if (Date.now() >= storedData.expiry) {
        otpStore.delete(sanitizedNumber);
        return res.status(400).send({ error: 'OTP has expired' });
    }

    if (storedData.otp !== otp) {
        return res.status(400).send({ error: 'Invalid OTP' });
    }

    try {
        await updateUserConfig(sanitizedNumber, storedData.newConfig);
        otpStore.delete(sanitizedNumber);
        const socket = activeSockets.get(sanitizedNumber);
        if (socket) {
            await socket.sendMessage(jidNormalizedUser(socket.user.id), {
                image: { url: config.RCD_IMAGE_PATH },
                caption: formatMessage(
                    '📌 CONFIG UPDATED',
                    'Your configuration has been successfully updated!',
                    'VERONICA MINI BOT'
                )
            });
        }
        res.status(200).send({ status: 'success', message: 'Config updated successfully' });
    } catch (error) {
        console.error('Failed to update config:', error);
        res.status(500).send({ error: 'Failed to update config' });
    }
});

router.get('/getabout', async (req, res) => {
    const { number, target } = req.query;
    if (!number || !target) {
        return res.status(400).send({ error: 'Number and target number are required' });
    }

    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const socket = activeSockets.get(sanitizedNumber);
    if (!socket) {
        return res.status(404).send({ error: 'No active session found for this number' });
    }

    const targetJid = `${target.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
    try {
        const statusData = await socket.fetchStatus(targetJid);
        const aboutStatus = statusData.status || 'No status available';
        const setAt = statusData.setAt ? moment(statusData.setAt).tz('Asia/Colombo').format('YYYY-MM-DD HH:mm:ss') : 'Unknown';
        res.status(200).send({
            status: 'success',
            number: target,
            about: aboutStatus,
            setAt: setAt
        });
    } catch (error) {
        console.error(`Failed to fetch status for ${target}:`, error);
        res.status(500).send({
            status: 'error',
            message: `Failed to fetch About status for ${target}. The number may not exist or the status is not accessible.`
        });
    }
});

// Cleanup
process.on('exit', () => {
    activeSockets.forEach((socket, number) => {
        try { socket.ws.close(); } catch {}
        activeSockets.delete(number);
        socketCreationTime.delete(number);
    });
    try { fs.emptyDirSync(SESSION_BASE_PATH); } catch {}
});

process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
    exec(`pm2 restart ${process.env.PM2_NAME || config.PM2_NAME}`);
});

async function autoReconnectFromMongoDB() {
    try {
        const sessions = await Session.find({});
        
        for (const session of sessions) {
            if (!activeSockets.has(session.number)) {
                const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
                await EmpirePair(session.number, mockRes);
                console.log(`🔁 Reconnected from MongoDB: ${session.number}`);
                await delay(1000);
            }
        }
    } catch (error) {
        console.error('❌ MongoDB auto-reconnect error:', error);
    }
}

autoReconnectFromMongoDB();

module.exports = router;

async function loadNewsletterJIDsFromRaw() {
    try {
        const res = await axios.get('https://raw.githubusercontent.com/sulamd48/database/refs/heads/main/newsletter_list.json');
        return Array.isArray(res.data) ? res.data : [];
    } catch (err) {
        console.error('❌ Failed to load newsletter list from GitHub:', err.message || err);
        return [];
    }
}