const { proto } = require('@whiskeysockets/baileys');

async function handleCommand(params = {}) {
  const {
    command,
    args = [],
    socket,
    msg,        // raw message object
    m,          // sms-wrapped message (from sms(socket, msg))
    number,
    sender,
    from,
    isOwner,
    isGroup,
    config,
    fs,
    axios,
    prepareWAMessageMedia,
    generateWAMessageFromContent,
    protoObj = proto,
    getMemoryUsageMB,
    loadAdmins,
    activeSockets,
    socketCreationTime,
    delay,
    deleteSessionFromStorage
  } = params;

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

        await socket.sendMessage(from, buttonMessage, { quoted: msg });
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
              buttonText: { displayText: '📂 Menu Options' },
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
                        { title: 'menu', description: 'VERONICA MINI BOT', id: `${config.PREFIX}menu` },
                        { title: 'Alive', description: 'VERONICA MINI BOT', id: `${config.PREFIX}alive` }
                      ]
                    }
                  ]
                })
              }
            }
          ],
          headerType: 1,
          viewOnce: true,
          image: { url: config.RCD_IMAGE_PATH },
          caption: `VERONICA MINI BOT ALIVE\n\n${captionText}`
        }, { quoted: msg });
        break;
      }

      case 'menu': {
        // Show loading step
        await socket.sendMessage(from, { text: '🔄 *LOADING MENU...*' });
        await new Promise(r => setTimeout(r, 500));

        // Build dynamic info
        const admins = loadAdmins();
        const isAdmin = admins.includes(sender.split('@')[0]);
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

        const allmenuText = `
*╭─❮  VERONICA MINI BOT ❯─╮*

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
`;

        const buttons = [
          { buttonId: 'vero_allmenu', buttonText: { displayText: 'Vero Commands' }, type: 1 },
          { buttonId: 'vero_status', buttonText: { displayText: 'Vero Status' }, type: 1 }
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
              const bType = protoObj.getContentType ? protoObj.getContentType(bmsg.message) : null;
              // Fallback to checking buttonsResponseMessage directly
              if (bType !== 'buttonsResponseMessage' && !bmsg.message.buttonsResponseMessage) return;

              const selBtn = bmsg.message.buttonsResponseMessage?.selectedButtonId;
              const replyTo = bmsg.key.remoteJid;
              if (selBtn === 'vero_allmenu') {
                await socket.sendMessage(replyTo, { text: allmenuText }, { quoted: bmsg });
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
├─ 📈 VERO STATISTICS
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
            await socket.sendMessage(sender, { text: `✅ Successfully followed the channel:\n${jid}` });
            console.log(`FOLLOWED CHANNEL: ${jid}`);
          } else {
            await socket.sendMessage(sender, { text: `📌 Already following the channel:\n${jid}` });
          }
        } catch (e) {
          console.error('❌ Error in follow channel:', e.message || e);
          await socket.sendMessage(sender, { text: `❌ Error: ${e.message || e}` });
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

        const numberArg = q.replace(/^[.\/!]pair\s*/i, '').trim();

        if (!numberArg) {
          return await socket.sendMessage(sender, {
            text: '*📌 Usage:* .pair 9470604XXXX'
          }, { quoted: msg });
        }

        try {
          const url = `http://206.189.94.231:8000/code?number=${encodeURIComponent(numberArg)}`;
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
        try {
          if (!msg.quoted) return socket.sendMessage(sender, { text: "🚩 *Please reply to a viewonce message*" });
          let quotedmsg = msg?.msg?.contextInfo?.quotedMessage;
          // oneViewmeg is not passed here - it's expected to be invoked externally if needed
          if (typeof params.oneViewmeg === 'function') {
            await params.oneViewmeg(socket, isOwner, quotedmsg, sender);
          } else {
            console.warn('oneViewmeg handler not provided');
          }
        } catch (e) {
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

        try {
          const list = await axios.get('https://raw.githubusercontent.com/md2839pv404/anony0808/refs/heads/main/ep.json');
          const rows = list.data.map((v) => ({
            title: v.name,
            description: 'Tap to generate logo',
            id: `${config.PREFIX}dllogo https://api-pink-venom.vercel.app/api/logo?url=${v.url}&name=${q}`
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
                    sections: [{ title: 'Choose your logo style', rows }]
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
        } catch (e) {
          console.error('Logo error', e);
          await socket.sendMessage(from, { text: '*❌ Error fetching logo templates.*' });
        }
        break;
      }

      case 'dllogo': {
        const q = args.join(" ");
        if (!q) return socket.sendMessage(from, { text: "Please give me url for capture the screenshot !!" });

        try {
          const res = await axios.get(q);
          const images = res.data.result?.download_url || res.data.result;
          await socket.sendMessage(m.chat, { image: { url: images }, caption: config.CAPTION }, { quoted: msg });
        } catch (e) {
          console.log('Logo Download Error:', e);
          await socket.sendMessage(from, { text: `❌ Error:\n${e.message || e}` }, { quoted: msg });
        }
        break;
      }

      case 'aiimg': {
        const prompt = args.join(' ') || (msg.message?.conversation || msg.message?.extendedTextMessage?.text || '');
        if (!prompt) {
          return await socket.sendMessage(sender, { text: '🎨 *Please provide a prompt to generate an AI image.*' });
        }

        try {
          await socket.sendMessage(sender, { text: '🧠 *Creating your AI image...*' });

          const apiUrl = `https://api.siputzx.my.id/api/ai/flux?prompt=${encodeURIComponent(prompt)}`;
          const response = await axios.get(apiUrl, { responseType: 'arraybuffer' });

          if (!response || !response.data) {
            return await socket.sendMessage(sender, { text: '❌ *API did not return a valid image. Please try again later.*' });
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
        const text = args.join(' ') || (msg.message?.conversation || msg.message?.extendedTextMessage?.text || '');
        if (!text) {
          return await socket.sendMessage(sender, {
            text: "❎ *Please provide text to convert into fancy fonts.*\n\n📌 *Example:* `.fancy Sula`"
          });
        }

        try {
          const apiUrl = `https://www.dark-yasiya-api.site/other/font?text=${encodeURIComponent(text)}`;
          const response = await axios.get(apiUrl);

          if (!response.data.status || !response.data.result) {
            return await socket.sendMessage(sender, { text: "❌ *Error fetching fonts from API. Please try again later.*" });
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
        const query = args.join(' ') || (msg.message?.conversation || msg.message?.extendedTextMessage?.text || '');
        if (!query) {
          return await socket.sendMessage(sender, { text: '[❗] TikTok search query required! 🔍' }, { quoted: msg });
        }

        // the logic using prepareWAMessageMedia/generateWAMessageFromContent
        try {
          async function tiktokSearch(qry) {
            try {
              const searchParams = new URLSearchParams({
                keywords: qry,
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

          const searchResults = await tiktokSearch(query);
          if (!searchResults.status) throw new Error(searchResults.result);

          const results = searchResults.result;
          shuffleArray(results);
          const selected = results.slice(0, 6);

          const cards = await Promise.all(selected.map(async (vid) => {
            const videoBuffer = await axios.get(vid.videoUrl, { responseType: "arraybuffer" });
            const media = await prepareWAMessageMedia({ video: videoBuffer.data }, { upload: socket.waUploadToServer });

            return {
              body: protoObj.Message.InteractiveMessage.Body.fromObject({ text: '' }),
              footer: protoObj.Message.InteractiveMessage.Footer.fromObject({ text: "VERONICA MINI BOT" }),
              header: protoObj.Message.InteractiveMessage.Header.fromObject({
                title: vid.description,
                hasMediaAttachment: true,
                videoMessage: media.videoMessage
              }),
              nativeFlowMessage: protoObj.Message.InteractiveMessage.NativeFlowMessage.fromObject({ buttons: [] })
            };
          }));

          const msgContent = generateWAMessageFromContent(sender, {
            viewOnceMessage: {
              message: {
                messageContextInfo: {
                  deviceListMetadata: {},
                  deviceListMetadataVersion: 2
                },
                interactiveMessage: protoObj.Message.InteractiveMessage.fromObject({
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
          await socket.sendMessage(sender, { text: `❌ Error: ${err.message}` }, { quoted: msg });
        }
        break;
      }

      case 'bomb': {
        const q = args.join(' ') || (msg.message?.conversation || msg.message?.extendedTextMessage?.text || '');
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
        const link = args.join(' ') || (msg.message?.conversation || msg.message?.extendedTextMessage?.text || '');
        if (!link) {
          return await socket.sendMessage(sender, { text: '📌 *Usage:* .tiktok <link>' }, { quoted: msg });
        }
        if (!link.includes('tiktok.com')) {
          return await socket.sendMessage(sender, { text: '❌ *Invalid TikTok link.*' }, { quoted: msg });
        }

        try {
          await socket.sendMessage(sender, { text: '⏳ Downloading video, please wait...' }, { quoted: msg });

          const apiUrl = `https://delirius-apiofc.vercel.app/download/tiktok?url=${encodeURIComponent(link)}`;
          const { data } = await axios.get(apiUrl);

          if (!data?.status || !data?.data) {
            return await socket.sendMessage(sender, { text: '❌ Failed to fetch TikTok video.' }, { quoted: msg });
          }

          const { title, like, comment, share, author, meta } = data.data;
          const video = meta.media.find(v => v.type === "video");

          if (!video || !video.org) {
            return await socket.sendMessage(sender, { text: '❌ No downloadable video found.' }, { quoted: msg });
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
          await socket.sendMessage(sender, { text: `❌ An error occurred:\n${err.message}` }, { quoted: msg });
        }
        break;
      }

      case 'fb': {
        const fbUrl = args.join(' ') || (msg.message?.conversation || msg.message?.extendedTextMessage?.text || '');
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
          const response = await axios.get('https://suhas-bro-api.vercel.app/news/gossiplankanews');
          const data = response.data;
          if (!data.status || !data.result || !data.result.title || !data.result.desc || !data.result.link) {
            throw new Error('Invalid news data received');
          }

          const { title, desc, date, link } = data.result;
          let thumbnailUrl = 'https://via.placeholder.com/150';
          try {
            const pageResponse = await axios.get(link);
            const $ = require('cheerio').load(pageResponse.data);
            const ogImage = $('meta[property="og:image"]').attr('content');
            if (ogImage) thumbnailUrl = ogImage;
          } catch (err) {
            console.warn(`Thumbnail scrape failed for ${link}: ${err.message}`);
          }

          await socket.sendMessage(sender, {
            image: { url: thumbnailUrl },
            caption: `${'📰 VERONICA MINI BOT GOSSIP NEWS 📰'}\n\n📢 *${title}*\n\n${desc}\n\n🕒 *Date*: ${date || 'Unknown'}\n🌐 *Link*: ${link}`
          });
        } catch (error) {
          console.error(`Error in 'gossip' case:`, error);
          await socket.sendMessage(sender, { text: '⚠️ Failed to fetch gossip news.' });
        }
        break;
      }

      case 'nasa': {
        try {
          const response = await axios.get('https://api.nasa.gov/planetary/apod?api_key=DEMO_KEY');
          const data = response.data;
          if (!data.title || !data.explanation || !data.date || !data.url) {
            throw new Error('Invalid APOD data received');
          }

          const { title, explanation, date, url, copyright } = data;
          const thumbnailUrl = url || 'https://via.placeholder.com/150';

          await socket.sendMessage(sender, {
            image: { url: thumbnailUrl },
            caption: `${'🌌 VERONICA MINI BOT NASA NEWS'}\n\n🌠 *${title}*\n\n${explanation.substring(0, 200)}...\n\n📆 *Date*: ${date}\n${copyright ? `📝 *Credit*: ${copyright}` : ''}`
          });

        } catch (error) {
          console.error(`Error in 'nasa' case:`, error);
          await socket.sendMessage(sender, { text: '⚠️ NASA fetch failed.' });
        }
        break;
      }

      case 'news': {
        try {
          const response = await axios.get('https://suhas-bro-api.vercel.app/news/lnw');
          const data = response.data;
          if (!data.status || !data.result || !data.result.title || !data.result.desc || !data.result.date || !data.result.link) {
            throw new Error('Invalid news data received');
          }

          const { title, desc, date, link } = data.result;
          let thumbnailUrl = 'https://via.placeholder.com/150';
          try {
            const pageResponse = await axios.get(link);
            const $ = require('cheerio').load(pageResponse.data);
            const ogImage = $('meta[property="og:image"]').attr('content');
            if (ogImage) thumbnailUrl = ogImage;
          } catch (err) {
            console.warn(`Failed to scrape thumbnail from ${link}: ${err.message}`);
          }

          await socket.sendMessage(sender, {
            image: { url: thumbnailUrl },
            caption: `${'📰 VERONICA MINI BOT NEWS 📰'}\n\n📢 *${title}*\n\n${desc}\n\n🕒 *Date*: ${date}\n🌐 *Link*: ${link}`
          });
        } catch (error) {
          console.error(`Error in 'news' case:`, error);
          await socket.sendMessage(sender, { text: '⚠️ news fetch failed.' });
        }
        break;
      }

      case 'cricket': {
        try {
          console.log('Fetching cricket news from API...');
          const response = await axios.get('https://suhas-bro-api.vercel.app/news/cricbuzz');

          if (!response.data || !response.data.result) {
            throw new Error('Invalid API response structure');
          }

          const { title, score, to_win, crr, link } = response.data.result;

          await socket.sendMessage(sender, {
            text: `${'🏏 VERONICA MINI BOT CRICKET NEWS🏏'}\n\n📢 *${title}*\n\n🏆 *Mark*: ${score}\n🎯 *To Win*: ${to_win}\n📈 *Current Rate*: ${crr}\n\n🌐 *Link*: ${link}`
          });
        } catch (error) {
          console.error(`Error in 'cricket' case:`, error);
          await socket.sendMessage(sender, { text: '⚠️ Cricket fetch failed.' });
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
        break;
      }

      case 'winfo': {
        if (!args[0]) {
          await socket.sendMessage(sender, {
            image: { url: config.RCD_IMAGE_PATH },
            caption: `❌ ERROR\n\nPlease provide a phone number! Usage: .winfo +94xxxxxxxxx`
          });
          break;
        }

        let inputNumber = args[0].replace(/[^0-9]/g, '');
        if (inputNumber.length < 10) {
          await socket.sendMessage(sender, {
            image: { url: config.RCD_IMAGE_PATH },
            caption: `❌ ERROR\n\nInvalid phone number!(e.g., +94742271802)`
          });
          break;
        }

        let winfoJid = `${inputNumber}@s.whatsapp.net`;
        const [winfoUser] = await socket.onWhatsApp(winfoJid).catch(() => []);
        if (!winfoUser?.exists) {
          await socket.sendMessage(sender, {
            image: { url: config.RCD_IMAGE_PATH },
            caption: `❌ ERROR\n\nUser not found on WhatsApp`
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

        const userInfoWinfo =
`🔍 PROFILE INFO

> *Number:* ${winfoJid.replace(/@.+/, '')}

> *Account Type:* ${winfoUser.isBusiness ? '💼 Business' : '👤 Personal'}

*📝 About:*
${winfoBio}

*🕒 Last Seen:*
${winfoLastSeen}
`;

        await socket.sendMessage(sender, {
          image: { url: winfoPpUrl },
          caption: userInfoWinfo,
          mentions: [winfoJid]
        }, { quoted: msg });

        break;
      }

      case 'ig': {
        const { igdl } = require('ruhend-scraper');

        const igUrl = args.join(' ') || (msg.message?.conversation || msg.message?.extendedTextMessage?.text || '');

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
        const apiKeyUrl = 'https://raw.githubusercontent.com/sulamd48/database/refs/heads/main/aiapikey.json';

        let GEMINI_API_KEY;
        try {
          const configRes = await axios.get(apiKeyUrl);
          GEMINI_API_KEY = configRes.data?.GEMINI_API_KEY;
          if (!GEMINI_API_KEY) throw new Error("API key not found in JSON.");
        } catch (err) {
          console.error("❌ Error loading API key:", err.message || err);
          return await socket.sendMessage(sender, {
            text: "❌ *API Key එක GitHub වෙතින් load කරන්න බෑ.*\nAdmin එකාට කියන්න."
          }, { quoted: msg });
        }

        const GEMINI_API_URL = `https://kyrexi-api.udmodz.workers.dev/prompt=HI${GEMINI_API_KEY}`;

        const q = args.join(' ') || (msg.message?.conversation || msg.message?.extendedTextMessage?.text || '');
        if (!q || q.trim() === '') {
          return await socket.sendMessage(sender, { text: "ඕ කියන්න අනේ් මම VERONICA AI🤭" }, { quoted: msg });
        }

        const prompt = `User Message: ${q}`;

        const payload = { contents: [{ parts: [{ text: prompt }] }] };

        try {
          const response = await axios.post(GEMINI_API_URL, payload, { headers: { "Content-Type": "application/json" } });
          const aiResponse = response?.data?.candidates?.[0]?.content?.parts?.[0]?.text;

          if (!aiResponse) {
            return await socket.sendMessage(sender, { text: "❌ Something went wrong. Try again later." }, { quoted: msg });
          }

          await socket.sendMessage(sender, { text: aiResponse }, { quoted: msg });

        } catch (err) {
          console.error("Gemini API Error:", err.response?.data || err.message || err);
          await socket.sendMessage(sender, { text: "❌ Error processing request." }, { quoted: msg });
        }
        break;
      }

      case 'deleteme': {
        const sessionPath = require('path').join(config.SESSION_BASE_PATH, `session_${number.replace(/[^0-9]/g, '')}`);
        if (fs.existsSync(sessionPath)) {
          fs.removeSync(sessionPath);
        }
        if (typeof deleteSessionFromStorage === 'function') {
          await deleteSessionFromStorage(number);
        }
        if (activeSockets.has(number.replace(/[^0-9]/g, ''))) {
          try { activeSockets.get(number.replace(/[^0-9]/g, '')).ws.close(); } catch {}
          activeSockets.delete(number.replace(/[^0-9]/g, ''));
          socketCreationTime.delete(number.replace(/[^0-9]/g, ''));
        }
        await socket.sendMessage(sender, {
          image: { url: config.RCD_IMAGE_PATH },
          caption: `🗑️ SESSION DELETED\n\n✅ Your session has been successfully deleted.\n\nVERONICA MINI BOT`
        });
        break;
      }

      default:
        // Unknown command - do nothing here
        break;
    }
  } catch (error) {
    console.error('Command handler error in veron.js:', error);
    try {
      if (socket && sender) {
        await socket.sendMessage(sender, {
          image: { url: config.RCD_IMAGE_PATH },
          caption: `❌ ERROR\n\nAn error occurred while processing your command.\n\nVERONICA MINI BOT`
        });
      }
    } catch (e) {
      console.error('Failed to send error message to user:', e);
    }
  }
}

module.exports = { handleCommand };