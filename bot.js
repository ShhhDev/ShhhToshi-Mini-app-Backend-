const TelegramBot = require('node-telegram-bot-api');
const pool = require('./db');

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = parseInt(process.env.ADMIN_TELEGRAM_ID);
const MINI_APP_URL = process.env.MINI_APP_URL || `https://${process.env.REPLIT_DEV_DOMAIN}`;

if (!BOT_TOKEN) {
  console.error('BOT_TOKEN not set');
  process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, {
  polling: {
    interval: 1000,
    autoStart: true,
    params: { timeout: 10 }
  }
});

bot.on('polling_error', (err) => {
  if (err.code === 'ETELEGRAM' && err.message && err.message.includes('409')) return;
  console.error('[Bot polling error]', err.message);
});

const isAdmin = (id) => parseInt(id) === ADMIN_ID;

function escapeHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Admin conversation state: chatId -> { mode, draft, buttons, step }
const adminState = new Map();

function clearState(chatId) {
  adminState.delete(chatId);
}

function openAppKeyboard() {
  return {
    inline_keyboard: [[{ text: '🚀 Open Shhhtoshi App', web_app: { url: MINI_APP_URL } }]]
  };
}

async function getWelcomeConfig() {
  try {
    const r = await pool.query('SELECT welcome_text, welcome_photo_file_id FROM app_settings WHERE id = 1');
    return {
      text: r.rows[0]?.welcome_text || null,
      photo: r.rows[0]?.welcome_photo_file_id || null
    };
  } catch {
    return { text: null, photo: null };
  }
}

async function getOrCreateUser(tgUser) {
  const { id, username, first_name, last_name, photo_url } = tgUser;
  const refCode = 'SHHHT-' + String(id).slice(-6).toUpperCase();

  const result = await pool.query(
    `INSERT INTO users (telegram_id, telegram_username, telegram_first_name, telegram_last_name, telegram_photo_url, referral_code)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (telegram_id) DO UPDATE SET
       telegram_username = EXCLUDED.telegram_username,
       telegram_first_name = EXCLUDED.telegram_first_name,
       telegram_last_name = EXCLUDED.telegram_last_name,
       updated_at = NOW()
     RETURNING *`,
    [id, username || null, first_name || null, last_name || null, photo_url || null, refCode]
  );
  return result.rows[0];
}

function streakFromUser(u) {
  const ci = u.check_in || {};
  return Number(ci.streak || 0) || 0;
}

// ── /start ────────────────────────────────────────────────────────────────────
bot.onText(/\/start(.*)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const tgUser = msg.from;
  const param = match[1] ? match[1].trim() : '';

  try {
    const user = await getOrCreateUser(tgUser);

    if (param.startsWith('ref=') || param.startsWith('ref_')) {
      const refCode = param.replace('ref=', '').replace('ref_', '').toUpperCase();
      if (!user.referred_by && refCode !== user.referral_code) {
        const refUser = await pool.query('SELECT * FROM users WHERE referral_code = $1', [refCode]);
        if (refUser.rows.length > 0) {
          const ref = refUser.rows[0];
          await pool.query(
            'UPDATE users SET referred_by = $1, shhhtoshi = shhhtoshi + 250, referral_reward_pending = TRUE WHERE telegram_id = $2',
            [refCode, tgUser.id]
          );
          await pool.query(
            'UPDATE users SET referrals = referrals + 1 WHERE telegram_id = $1',
            [ref.telegram_id]
          );
          try {
            await bot.sendMessage(ref.telegram_id,
              `👥 <b>New Referral!</b>\n\n<b>${escapeHtml(tgUser.first_name || tgUser.username || 'Someone')}</b> joined using your invite link!\n\n⏳ They need to complete <b>5 tasks</b> before you earn your <b>+500 Sp</b> reward.\n\nCheck their progress in the app 👉`,
              { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '🚀 View Progress', web_app: { url: MINI_APP_URL } }]] } }
            );
          } catch (e) {}
        }
      }
    }

    const welcome = await getWelcomeConfig();
    const keyboard = { reply_markup: openAppKeyboard(), parse_mode: 'HTML' };

    if (welcome.text || welcome.photo) {
      const text = (welcome.text || 'Welcome to ShhhToshi!')
        .replace(/\{name\}/g, escapeHtml(user.telegram_first_name || ''))
        .replace(/\{balance\}/g, String(user.shhhtoshi || 0));
      if (welcome.photo) {
        await bot.sendPhoto(chatId, welcome.photo, { caption: text, ...keyboard });
      } else {
        await bot.sendMessage(chatId, text, keyboard);
      }
    } else {
      const greeting = `👋 Welcome to <b>Shhhtoshi</b>${user.telegram_first_name ? ', ' + escapeHtml(user.telegram_first_name) : ''}!\n\n🏆 Your Web3 Rewards Hub\n\n💰 Balance: <b>${user.shhhtoshi} Sp</b>\n🎯 Complete tasks, tap to earn, spin the wheel!\n\n👇 Tap below to open the app:`;
      await bot.sendMessage(chatId, greeting, keyboard);
    }
  } catch (err) {
    console.error('/start error:', err);
    await bot.sendMessage(chatId, '⚠️ Something went wrong. Please try again.');
  }
});

// ── /stats — streak matches mini app (check_in.streak) ────────────────────────
bot.onText(/\/stats/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    const res = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [msg.from.id]);
    if (!res.rows.length) return bot.sendMessage(chatId, 'No account found. Use /start first.');
    const u = res.rows[0];
    const streak = streakFromUser(u);
    const text =
      `📊 <b>Your Stats</b>\n\n` +
      `👤 <b>${escapeHtml(u.telegram_first_name || 'User')}${u.telegram_username ? ' (@' + escapeHtml(u.telegram_username) + ')' : ''}</b>\n\n` +
      `💰 Balance: <b>${u.shhhtoshi} Sp</b>\n` +
      `🔥 Streak: <b>${streak} day${streak !== 1 ? 's' : ''}</b>\n` +
      `🎯 Tasks done: <b>${Array.isArray(u.tasks_completed) ? u.tasks_completed.length : 0}</b>\n` +
      `👆 Tap earnings: <b>${u.tap_earnings} Sp</b>\n` +
      `👥 Referrals: <b>${u.referrals}</b>\n` +
      `🔗 Your code: <code>${u.referral_code}</code>`;
    bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
  } catch (err) {
    console.error('/stats error:', err);
  }
});

// ── Broadcast (rich media + preview + optional inline buttons) ────────────────
bot.onText(/\/broadcast(?:\s+([\s\S]+))?$/, async (msg, match) => {
  if (!isAdmin(msg.from.id)) return bot.sendMessage(msg.chat.id, '⛔ Admin only.');
  const inline = match[1] ? match[1].trim() : '';
  if (inline) {
    // Legacy one-shot text broadcast
    await doBroadcast(msg.chat.id, { type: 'text', text: inline }, []);
    return;
  }
  adminState.set(msg.chat.id, { mode: 'broadcast_wait_content', buttons: [] });
  await bot.sendMessage(msg.chat.id,
    '📢 <b>Broadcast mode</b>\n\n' +
    'Send the message content now:\n' +
    '• Text\n• Photo\n• GIF / animation\n• Sticker\n\n' +
    'Or /cancel to abort.',
    { parse_mode: 'HTML' }
  );
});

bot.onText(/\/setwelcome$/, async (msg) => {
  if (!isAdmin(msg.from.id)) return bot.sendMessage(msg.chat.id, '⛔ Admin only.');
  adminState.set(msg.chat.id, { mode: 'welcome_wait_content' });
  const cur = await getWelcomeConfig();
  await bot.sendMessage(msg.chat.id,
    '✏️ <b>Edit Welcome Message</b>\n\n' +
    'Send new <b>text</b> or a <b>photo with caption</b>.\n' +
    'Inline buttons stay: <i>Open ShhhToshi App</i>\n\n' +
    'Placeholders: <code>{name}</code> <code>{balance}</code>\n\n' +
    (cur.text ? `Current text:\n${escapeHtml(cur.text).slice(0, 400)}\n\n` : 'No custom text set.\n\n') +
    (cur.photo ? '📷 A welcome photo is currently set.\n\n' : '') +
    'Send /clearwelcome to reset to default.\n/cancel to abort.',
    { parse_mode: 'HTML' }
  );
});

bot.onText(/\/clearwelcome$/, async (msg) => {
  if (!isAdmin(msg.from.id)) return bot.sendMessage(msg.chat.id, '⛔ Admin only.');
  await pool.query('UPDATE app_settings SET welcome_text = NULL, welcome_photo_file_id = NULL WHERE id = 1');
  clearState(msg.chat.id);
  bot.sendMessage(msg.chat.id, '✅ Welcome message reset to default.');
});

bot.onText(/\/cancel$/, async (msg) => {
  if (!isAdmin(msg.from.id)) return;
  clearState(msg.chat.id);
  bot.sendMessage(msg.chat.id, 'Cancelled.');
});

// Capture media/text for admin flows
bot.on('message', async (msg) => {
  if (!msg.from || !isAdmin(msg.from.id)) return;
  if (msg.text && msg.text.startsWith('/')) return; // commands handled elsewhere

  const state = adminState.get(msg.chat.id);
  if (!state) return;

  try {
    // ── Broadcast: receive content ──
    if (state.mode === 'broadcast_wait_content') {
      const draft = extractContent(msg);
      if (!draft) {
        return bot.sendMessage(msg.chat.id, 'Unsupported message. Send text, photo, gif, or sticker.');
      }
      state.draft = draft;
      state.mode = 'broadcast_preview';
      adminState.set(msg.chat.id, state);

      await bot.sendMessage(msg.chat.id, '👁 <b>Preview:</b>', { parse_mode: 'HTML' });
      await sendContent(msg.chat.id, draft, []);
      await bot.sendMessage(msg.chat.id,
        'What next?\n\n' +
        '• /send — broadcast to all users now\n' +
        '• /addbutton Label | https://link.com — add an inline URL button\n' +
        '• /cancel — abort',
        { parse_mode: 'HTML' }
      );
      return;
    }

    // ── Welcome: receive content ──
    if (state.mode === 'welcome_wait_content') {
      let text = msg.caption || msg.text || '';
      let photo = null;
      if (msg.photo && msg.photo.length) {
        photo = msg.photo[msg.photo.length - 1].file_id;
      }
      if (!text && !photo) {
        return bot.sendMessage(msg.chat.id, 'Send text or a photo (with optional caption).');
      }
      await pool.query(
        `UPDATE app_settings SET
           welcome_text = COALESCE($1, welcome_text),
           welcome_photo_file_id = COALESCE($2, welcome_photo_file_id)
         WHERE id = 1`,
        [text || null, photo]
      );
      // If only photo sent with no caption, keep old text; if text-only, keep old photo unless /clearwelcome
      if (text && !photo) {
        await pool.query('UPDATE app_settings SET welcome_text = $1 WHERE id = 1', [text]);
      }
      if (photo && text) {
        await pool.query('UPDATE app_settings SET welcome_text = $1, welcome_photo_file_id = $2 WHERE id = 1', [text, photo]);
      }
      if (photo && !text) {
        await pool.query('UPDATE app_settings SET welcome_photo_file_id = $1 WHERE id = 1', [photo]);
      }
      clearState(msg.chat.id);
      await bot.sendMessage(msg.chat.id, '✅ Welcome message updated. Preview:');
      const w = await getWelcomeConfig();
      const preview = (w.text || 'Welcome!').replace(/\{name\}/g, msg.from.first_name || 'User').replace(/\{balance\}/g, '0');
      if (w.photo) {
        await bot.sendPhoto(msg.chat.id, w.photo, { caption: preview, reply_markup: openAppKeyboard(), parse_mode: 'HTML' });
      } else {
        await bot.sendMessage(msg.chat.id, preview, { reply_markup: openAppKeyboard(), parse_mode: 'HTML' });
      }
      return;
    }
  } catch (e) {
    console.error('admin message handler', e);
    bot.sendMessage(msg.chat.id, 'Error: ' + e.message);
  }
});

bot.onText(/\/addbutton (.+)/, async (msg, match) => {
  if (!isAdmin(msg.from.id)) return;
  const state = adminState.get(msg.chat.id);
  if (!state || state.mode !== 'broadcast_preview' || !state.draft) {
    return bot.sendMessage(msg.chat.id, 'Start with /broadcast first.');
  }
  const raw = match[1].trim();
  const parts = raw.split('|').map(s => s.trim());
  if (parts.length < 2 || !parts[1].startsWith('http')) {
    return bot.sendMessage(msg.chat.id, 'Usage: /addbutton Button Label | https://example.com');
  }
  state.buttons = state.buttons || [];
  state.buttons.push({ text: parts[0], url: parts[1] });
  adminState.set(msg.chat.id, state);
  await bot.sendMessage(msg.chat.id, `✅ Button added: <b>${escapeHtml(parts[0])}</b>\nTotal buttons: ${state.buttons.length}\n\nAdd more or /send`, { parse_mode: 'HTML' });
  await bot.sendMessage(msg.chat.id, 'Updated preview:');
  await sendContent(msg.chat.id, state.draft, state.buttons);
});

bot.onText(/\/send$/, async (msg) => {
  if (!isAdmin(msg.from.id)) return;
  const state = adminState.get(msg.chat.id);
  if (!state || !state.draft) {
    return bot.sendMessage(msg.chat.id, 'Nothing to send. Use /broadcast first.');
  }
  const draft = state.draft;
  const buttons = state.buttons || [];
  clearState(msg.chat.id);
  await doBroadcast(msg.chat.id, draft, buttons);
});

function extractContent(msg) {
  if (msg.photo && msg.photo.length) {
    return { type: 'photo', fileId: msg.photo[msg.photo.length - 1].file_id, caption: msg.caption || '' };
  }
  if (msg.animation) {
    return { type: 'animation', fileId: msg.animation.file_id, caption: msg.caption || '' };
  }
  if (msg.sticker) {
    return { type: 'sticker', fileId: msg.sticker.file_id };
  }
  if (msg.text) {
    return { type: 'text', text: msg.text };
  }
  if (msg.video) {
    return { type: 'video', fileId: msg.video.file_id, caption: msg.caption || '' };
  }
  return null;
}

async function sendContent(chatId, draft, buttons) {
  const opts = {};
  if (buttons && buttons.length) {
    opts.reply_markup = {
      inline_keyboard: buttons.map(b => [{ text: b.text, url: b.url }])
    };
  }
  if (draft.type === 'text') {
    return bot.sendMessage(chatId, draft.text, { parse_mode: 'HTML', ...opts });
  }
  if (draft.type === 'photo') {
    return bot.sendPhoto(chatId, draft.fileId, { caption: draft.caption || undefined, parse_mode: 'HTML', ...opts });
  }
  if (draft.type === 'animation') {
    return bot.sendAnimation(chatId, draft.fileId, { caption: draft.caption || undefined, parse_mode: 'HTML', ...opts });
  }
  if (draft.type === 'video') {
    return bot.sendVideo(chatId, draft.fileId, { caption: draft.caption || undefined, parse_mode: 'HTML', ...opts });
  }
  if (draft.type === 'sticker') {
    await bot.sendSticker(chatId, draft.fileId);
    if (buttons && buttons.length) {
      return bot.sendMessage(chatId, '⬆️', opts);
    }
    return;
  }
}

async function doBroadcast(adminChatId, draft, buttons) {
  try {
    await bot.sendMessage(adminChatId, '⏳ Starting broadcast...');
    const users = await pool.query('SELECT telegram_id FROM users WHERE banned = FALSE');
    let sent = 0, failed = 0;
    for (const user of users.rows) {
      try {
        await sendContent(user.telegram_id, draft, buttons);
        sent++;
      } catch (e) {
        failed++;
      }
      await new Promise(r => setTimeout(r, 40));
    }
    try {
      const label = draft.type === 'text' ? (draft.text || '').slice(0, 200) : `[${draft.type}]`;
      await pool.query(
        'INSERT INTO broadcasts (message, sent_by, total_sent, total_failed) VALUES ($1, $2, $3, $4)',
        [label, adminChatId, sent, failed]
      );
    } catch (_) {}
    await bot.sendMessage(adminChatId, `✅ <b>Broadcast Complete</b>\n\n📨 Sent: ${sent}\n❌ Failed: ${failed}`, { parse_mode: 'HTML' });
  } catch (err) {
    console.error('broadcast error:', err);
    bot.sendMessage(adminChatId, '❌ Broadcast failed: ' + err.message);
  }
}

// Keep exported name used by server.js
async function doBroadcastText(adminChatId, message) {
  return doBroadcast(adminChatId, { type: 'text', text: message }, []);
}

bot.onText(/\/admin/, async (msg) => {
  if (!isAdmin(msg.from.id)) return bot.sendMessage(msg.chat.id, '⛔ Admin only.');
  const userCount = await pool.query('SELECT COUNT(*) FROM users');
  const total = userCount.rows[0].count;
  bot.sendMessage(msg.chat.id,
    `⚙️ <b>Admin Panel</b>\n\n👥 Total users: <b>${total}</b>\n\n` +
    `<b>Commands:</b>\n` +
    `/broadcast — Rich broadcast (text/photo/gif/sticker)\n` +
    `/setwelcome — Edit welcome text/photo\n` +
    `/clearwelcome — Reset welcome to default\n` +
    `/stats — Your stats\n` +
    `/ban &lt;id&gt; — Ban user\n` +
    `/unban &lt;id&gt; — Unban user\n` +
    `/setbalance &lt;id&gt; &lt;amount&gt; — Set balance`,
    { parse_mode: 'HTML' }
  );
});

bot.onText(/\/ban (\d+)/, async (msg, match) => {
  if (!isAdmin(msg.from.id)) return bot.sendMessage(msg.chat.id, '⛔ Admin only.');
  const targetId = parseInt(match[1]);
  await pool.query('UPDATE users SET banned = TRUE WHERE telegram_id = $1', [targetId]);
  bot.sendMessage(msg.chat.id, `🚫 User ${targetId} has been banned.`);
});

bot.onText(/\/unban (\d+)/, async (msg, match) => {
  if (!isAdmin(msg.from.id)) return bot.sendMessage(msg.chat.id, '⛔ Admin only.');
  const targetId = parseInt(match[1]);
  await pool.query('UPDATE users SET banned = FALSE WHERE telegram_id = $1', [targetId]);
  bot.sendMessage(msg.chat.id, `✅ User ${targetId} has been unbanned.`);
});

bot.onText(/\/setbalance (\d+) (\d+)/, async (msg, match) => {
  if (!isAdmin(msg.from.id)) return bot.sendMessage(msg.chat.id, '⛔ Admin only.');
  const targetId = parseInt(match[1]);
  const amount = parseInt(match[2]);
  await pool.query('UPDATE users SET shhhtoshi = $1 WHERE telegram_id = $2', [amount, targetId]);
  bot.sendMessage(msg.chat.id, `✅ Set balance of ${targetId} to ${amount} Sp.`);
});

bot.onText(/\/help/, (msg) => {
  const isAdm = isAdmin(msg.from.id);
  const text = `📖 <b>Shhhtoshi Bot Commands</b>\n\n/start — Launch the app\n/stats — View your stats\n/help — Show this help` +
    (isAdm
      ? `\n\n<b>Admin:</b>\n/admin\n/broadcast\n/setwelcome\n/clearwelcome\n/ban &lt;id&gt;\n/unban &lt;id&gt;\n/setbalance &lt;id&gt; &lt;amount&gt;`
      : '');
  bot.sendMessage(msg.chat.id, text, { parse_mode: 'HTML' });
});

module.exports = { bot, doBroadcast: doBroadcastText };
console.log('🤖 Shhhtoshi bot started!');
