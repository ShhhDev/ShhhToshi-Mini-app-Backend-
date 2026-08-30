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
  if (err.code === 'ETELEGRAM' && err.message && err.message.includes('409')) return; // suppress 409 conflicts
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
          // Give referred user 250 Sp bonus & mark reward pending (referrer gets 500 Sp after 5 tasks)
          await pool.query(
            'UPDATE users SET referred_by = $1, shhhtoshi = shhhtoshi + 250, referral_reward_pending = TRUE WHERE telegram_id = $2',
            [refCode, tgUser.id]
          );
          // Increment referrer's referral count only — 500 Sp reward comes when referred user hits 5 tasks
          await pool.query(
            'UPDATE users SET referrals = referrals + 1 WHERE telegram_id = $1',
            [ref.telegram_id]
          );
          // Notify referrer that someone joined (but reward comes later)
          try {
            await bot.sendMessage(ref.telegram_id,
              `👥 <b>New Referral!</b>\n\n<b>${escapeHtml(tgUser.first_name || tgUser.username || 'Someone')}</b> joined using your invite link!\n\n⏳ They need to complete <b>5 tasks</b> before you earn your <b>+500 Sp</b> reward.\n\nCheck their progress in the app 👉`,
              { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '🚀 View Progress', web_app: { url: MINI_APP_URL } }]] } }
            );
          } catch (e) {}
        }
      }
    }

    const keyboard = {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🚀 Open Shhhtoshi App', web_app: { url: MINI_APP_URL } }],
          [{ text: '📋 My Stats', callback_data: 'stats' }, { text: '👥 Referral Link', callback_data: 'ref' }]
        ]
      },
      parse_mode: 'HTML'
    };

    const greeting = `👋 Welcome to <b>Shhhtoshi</b>${user.telegram_first_name ? ', ' + escapeHtml(user.telegram_first_name) : ''}!\n\n🏆 Your Web3 Rewards Hub\n\n💰 Balance: <b>${user.shhhtoshi} Sp</b>\n🎯 Complete tasks, tap to earn, spin the wheel!\n\n👇 Tap below to open the app:`;

    await bot.sendMessage(chatId, greeting, keyboard);
  } catch (err) {
    console.error('/start error:', err);
    await bot.sendMessage(chatId, '⚠️ Something went wrong. Please try again.');
  }
});

bot.onText(/\/stats/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    const res = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [msg.from.id]);
    if (!res.rows.length) return bot.sendMessage(chatId, 'No account found. Use /start first.');
    const u = res.rows[0];
    const text = `📊 <b>Your Stats</b>\n\n👤 <b>${escapeHtml(u.telegram_first_name || 'User')}${u.telegram_username ? ' (@' + escapeHtml(u.telegram_username) + ')' : ''}</b>\n\n💰 Balance: <b>${u.shhhtoshi} Sp</b>\n🎯 Tasks done: <b>${Array.isArray(u.tasks_completed) ? u.tasks_completed.length : 0}</b>\n👆 Tap earnings: <b>${u.tap_earnings} Sp</b>\n👥 Referrals: <b>${u.referrals}</b>\n🔗 Your code: <code>${u.referral_code}</code>`;
    bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
  } catch (err) {
    console.error('/stats error:', err);
  }
});

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const userId = query.from.id;

  try {
    if (query.data === 'stats') {
      const res = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [userId]);
      if (!res.rows.length) return bot.answerCallbackQuery(query.id, { text: 'No account yet.' });
      const u = res.rows[0];
      const text = `📊 <b>Your Stats</b>\n\n💰 Balance: <b>${u.shhhtoshi} Sp</b>\n🎯 Tasks done: <b>${Array.isArray(u.tasks_completed) ? u.tasks_completed.length : 0}</b>\n👆 Tap earnings: <b>${u.tap_earnings} Sp</b>\n👥 Referrals: <b>${u.referrals}</b>`;
      await bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
      bot.answerCallbackQuery(query.id);
    } else if (query.data === 'ref') {
      const res = await pool.query('SELECT referral_code FROM users WHERE telegram_id = $1', [userId]);
      if (!res.rows.length) return bot.answerCallbackQuery(query.id, { text: 'No account yet.' });
      const code = res.rows[0].referral_code;
      const link = `https://t.me/${(await bot.getMe()).username}?start=ref=${code}`;
      await bot.sendMessage(chatId, `🔗 <b>Your Referral Link</b>\n\n<code>${link}</code>\n\nShare this with friends! You earn <b>+500 Sp</b> per invite, they get <b>+250 Sp</b> bonus.`, { parse_mode: 'HTML' });
      bot.answerCallbackQuery(query.id);
    }
  } catch (err) {
    console.error('callback_query error:', err);
    bot.answerCallbackQuery(query.id, { text: 'Error occurred.' });
  }
});

bot.onText(/\/broadcast (.+)/, async (msg, match) => {
  if (!isAdmin(msg.from.id)) return bot.sendMessage(msg.chat.id, '⛔ Admin only.');
  const message = match[1];
  await doBroadcast(msg.chat.id, message, msg.from.id);
});

bot.onText(/\/broadcast$/, async (msg) => {
  if (!isAdmin(msg.from.id)) return bot.sendMessage(msg.chat.id, '⛔ Admin only.');
  bot.sendMessage(msg.chat.id, '📢 Usage: /broadcast <your message here>');
});

async function doBroadcast(adminChatId, message, adminId) {
  try {
    await bot.sendMessage(adminChatId, '⏳ Starting broadcast...');
    const users = await pool.query('SELECT telegram_id FROM users WHERE banned = FALSE');
    let sent = 0, failed = 0;

    for (const user of users.rows) {
      try {
        await bot.sendMessage(user.telegram_id, message, { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '🚀 Open App', web_app: { url: MINI_APP_URL } }]] } });
        sent++;
        await new Promise(r => setTimeout(r, 35));
      } catch (e) {
        failed++;
      }
    }

    await pool.query(
      'INSERT INTO broadcasts (message, sent_by, total_sent, total_failed) VALUES ($1, $2, $3, $4)',
      [message, adminId, sent, failed]
    );

    bot.sendMessage(adminChatId, `✅ <b>Broadcast Complete</b>\n\n📨 Sent: ${sent}\n❌ Failed: ${failed}`, { parse_mode: 'HTML' });
  } catch (err) {
    console.error('broadcast error:', err);
    bot.sendMessage(adminChatId, '❌ Broadcast failed: ' + err.message);
  }
}

bot.onText(/\/admin/, async (msg) => {
  if (!isAdmin(msg.from.id)) return bot.sendMessage(msg.chat.id, '⛔ Admin only.');
  const userCount = await pool.query('SELECT COUNT(*) FROM users');
  const total = userCount.rows[0].count;
  bot.sendMessage(msg.chat.id,
    `⚙️ <b>Admin Panel</b>\n\n👥 Total users: <b>${total}</b>\n\n<b>Commands:</b>\n/broadcast &lt;message&gt; — Send to all users\n/stats — Your stats\n/ban &lt;telegram_id&gt; — Ban a user\n/unban &lt;telegram_id&gt; — Unban a user\n/setbalance &lt;telegram_id&gt; &lt;amount&gt; — Set user balance`,
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
  const text = `📖 <b>Shhhtoshi Bot Commands</b>\n\n/start — Launch the app\n/stats — View your stats\n/help — Show this help${isAdm ? '\n\n<b>Admin Commands:</b>\n/admin — Admin panel\n/broadcast &lt;msg&gt; — Broadcast\n/ban &lt;id&gt; — Ban user\n/unban &lt;id&gt; — Unban user\n/setbalance &lt;id&gt; &lt;amount&gt; — Set balance' : ''}`;
  bot.sendMessage(msg.chat.id, text, { parse_mode: 'HTML' });
});

module.exports = { bot, doBroadcast };
console.log('🤖 Shhhtoshi bot started!');
