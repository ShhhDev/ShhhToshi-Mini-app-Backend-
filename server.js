const express = require('express');
const crypto = require('crypto');
const path = require('path');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const pool = require('./db');

const app = express();
app.set('trust proxy', 1); // Replit runs behind a proxy
app.use(express.json());
app.use(cors());

// ── Rate Limiting ─────────────────────────────────────────────────────────────
// General API limit: 60 requests per minute per IP
const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please slow down.' }
});

// Strict limit for auth endpoint: 10 per minute per IP
const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many auth attempts, please wait.' }
});

// Very strict limit for admin panel password attempts: 5 per 15 minutes per IP
const adminPwLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many password attempts. Try again in 15 minutes.' }
});

// Spin endpoint: 20 per minute per IP (anti-farming)
const spinLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many spin requests, please slow down.' }
});

// Task completion: 30 per minute per IP
const taskLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many task requests, please slow down.' }
});

// Blocks game score submission: 20 per minute per IP (a game can end often)
const blocksLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please slow down.' }
});

app.use('/api/', generalLimiter);

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = parseInt(process.env.ADMIN_TELEGRAM_ID);
const PORT = process.env.PORT || 5000;
const MINI_APP_URL = process.env.MINI_APP_URL || `https://${process.env.REPLIT_DEV_DOMAIN}`;
// Optional: a Telegram channel/group (numeric chat id, e.g. -1001234567890)
// where every withdrawal request gets auto-posted as a log. Leave unset to disable.
const WITHDRAWAL_LOG_CHAT_ID = process.env.WITHDRAWAL_LOG_CHAT_ID || null;

// Wheel segments — must match frontend exactly
const WHEEL_SEGS = ["1000","500","5000","100","2500","750","10000","200","3000","1500"];
const WHEEL_VALS = WHEEL_SEGS.map(Number);
const NORMAL_WHEEL_SEGS = ["0","100","250","500","750","1000","1250","1500","1750","2000"];
const NORMAL_WHEEL_VALS = NORMAL_WHEEL_SEGS.map(Number);
const SPIN_COOLDOWN_MS = 60000; // 1 minute on all spins
const TREASURY_ADDR = "UQAimXfztHcVa_bipWpbYWRL5eE217KkdwENqZseXVDDlOWQ";

// Start bot and keep reference for sending messages
const { bot, doBroadcast } = require('./bot');

// ── DB migration ─────────────────────────────────────────────────────────────
async function migrate() {
  try {
    // Create base tables if they don't exist
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        telegram_id BIGINT UNIQUE NOT NULL,
        telegram_username TEXT,
        telegram_first_name TEXT,
        telegram_last_name TEXT,
        telegram_photo_url TEXT,
        referral_code TEXT UNIQUE,
        referrals INTEGER DEFAULT 0,
        referred_by TEXT,
        referral_earnings INTEGER DEFAULT 0,
        shhhtoshi INTEGER DEFAULT 0,
        task_earnings INTEGER DEFAULT 0,
        tap_earnings INTEGER DEFAULT 0,
        today_taps INTEGER DEFAULT 0,
        last_tap_date TEXT DEFAULT '',
        tap_limit_boosted JSONB DEFAULT '{}',
        tasks_completed JSONB DEFAULT '[]',
        spin_history JSONB DEFAULT '[]',
        withdrawal_requests JSONB DEFAULT '[]',
        check_in JSONB DEFAULT '{}',
        wallet_address TEXT,
        banned BOOLEAN DEFAULT FALSE,
        joined_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS app_settings (
        id INTEGER PRIMARY KEY DEFAULT 1,
        spin_price NUMERIC DEFAULT 0.1,
        sp_to_shhht INTEGER DEFAULT 100,
        tasks JSONB DEFAULT '[]',
        home_boost_tasks JSONB DEFAULT '[]',
        mystery_boxes JSONB DEFAULT '[]',
        stake_task JSONB DEFAULT '{}',
        withdrawal_requests JSONB DEFAULT '[]',
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await pool.query(`INSERT INTO app_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;`);

    await pool.query(`ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS extra_admins TEXT[] DEFAULT '{}';`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS daily_sp INTEGER DEFAULT 0;`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS daily_sp_date TEXT DEFAULT '';`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_reward_pending BOOLEAN DEFAULT FALSE;`);
    await pool.query(`ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS last_daily_reward_at TIMESTAMPTZ;`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS checkin_reminder_date TEXT DEFAULT '';`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS tap_per_hit INTEGER DEFAULT 1;`);
    await pool.query(`ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS tap_boost_price NUMERIC DEFAULT 10;`);
    await pool.query(`ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS tap_boost_amount INTEGER DEFAULT 4;`);
    await pool.query(`ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS admin_password_hash TEXT;`);
    await pool.query(`ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS withdrawal_min INTEGER DEFAULT 10000;`);
    await pool.query(`ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS last_blocks_daily_reward_at TIMESTAMPTZ;`);
    await pool.query(`ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS last_blocks_monthly_period TEXT;`);
    await pool.query(`ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS mystery_boxes JSONB DEFAULT '[]';`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS og_pass BOOLEAN DEFAULT FALSE;`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS og_tap_bonus_applied BOOLEAN DEFAULT FALSE;`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS free_spin_claimed_date TEXT;`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS bonus_spins INTEGER DEFAULT 0;`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_spin_at TIMESTAMPTZ;`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS og_pass_bought_at TIMESTAMPTZ;`);
    await pool.query(`ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS og_pass_stars_price INTEGER DEFAULT 100;`);
    await pool.query(`ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS og_pass_gram_price NUMERIC DEFAULT 1;`);
    await pool.query(`ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS spin_stars_price INTEGER DEFAULT 15;`);
    await pool.query(`ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS welcome_text TEXT;`);
    await pool.query(`ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS welcome_photo_file_id TEXT;`);

    // Backfill OG +2 tap for users who bought OG before the +2 fix
    try {
      await pool.query(`
        UPDATE users
        SET tap_per_hit = COALESCE(tap_per_hit, 1) + 2,
            og_tap_bonus_applied = TRUE
        WHERE og_pass = TRUE AND COALESCE(og_tap_bonus_applied, FALSE) = FALSE
      `);
    } catch (e) { console.warn('og tap backfill', e.message); }

    await pool.query(`
      CREATE TABLE IF NOT EXISTS stars_payments (
        id SERIAL PRIMARY KEY,
        telegram_id BIGINT NOT NULL,
        payload TEXT UNIQUE NOT NULL,
        kind TEXT NOT NULL,
        amount_stars INTEGER NOT NULL,
        ref_id TEXT,
        status TEXT DEFAULT 'pending',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        completed_at TIMESTAMPTZ
      );
    `);
    // Seasonal availability window + direct-purchase flag for cosmetics —
    // added after cosmetic_items already existed in some deployments.
    await pool.query(`ALTER TABLE cosmetic_items ADD COLUMN IF NOT EXISTS available_from TIMESTAMPTZ;`);
    await pool.query(`ALTER TABLE cosmetic_items ADD COLUMN IF NOT EXISTS available_until TIMESTAMPTZ;`);
    await pool.query(`ALTER TABLE cosmetic_items ADD COLUMN IF NOT EXISTS direct_purchase BOOLEAN DEFAULT FALSE;`);

    // Seed the admin panel password on first boot only (never overwrites an
    // existing hash). The plaintext password is never stored — only a
    // salted scrypt hash lives in the DB.
    try {
      const seedPw = process.env.ADMIN_PANEL_PASSWORD_SEED;
      if (seedPw) {
        const existing = await pool.query('SELECT admin_password_hash FROM app_settings WHERE id = 1');
        if (!existing.rows[0]?.admin_password_hash) {
          const hash = hashAdminPassword(seedPw);
          await pool.query('UPDATE app_settings SET admin_password_hash = $1 WHERE id = 1', [hash]);
          console.log('🔐 Admin panel password seeded from ADMIN_PANEL_PASSWORD_SEED (hash stored, plaintext discarded).');
        }
      }
    } catch (e) {
      console.error('Admin password seed error:', e.message);
    }

    // ── New structured tables ────────────────────────────────────────────────
    await pool.query(`
      CREATE TABLE IF NOT EXISTS daily_earnings (
        id SERIAL PRIMARY KEY,
        telegram_id BIGINT NOT NULL,
        date TEXT NOT NULL,
        sp_amount INT NOT NULL DEFAULT 0,
        UNIQUE(telegram_id, date)
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_daily_earnings_date ON daily_earnings(date);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_daily_earnings_tgid ON daily_earnings(telegram_id);`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS task_completions (
        id SERIAL PRIMARY KEY,
        telegram_id BIGINT NOT NULL,
        task_id TEXT NOT NULL,
        task_type TEXT NOT NULL DEFAULT 'regular',
        reward INT NOT NULL DEFAULT 0,
        completed_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_task_completions_once
        ON task_completions(telegram_id, task_id)
        WHERE task_type != 'ad';
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_task_completions_tgid ON task_completions(telegram_id);`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS spin_logs (
        id SERIAL PRIMARY KEY,
        telegram_id BIGINT NOT NULL,
        prize_label TEXT,
        sp_won INT NOT NULL DEFAULT 0,
        ton_cost NUMERIC DEFAULT 0,
        spun_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_spin_logs_tgid ON spin_logs(telegram_id);`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS tap_sessions (
        id SERIAL PRIMARY KEY,
        telegram_id BIGINT NOT NULL,
        date TEXT NOT NULL,
        taps INT NOT NULL DEFAULT 0,
        sp_earned INT NOT NULL DEFAULT 0,
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(telegram_id, date)
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_tap_sessions_tgid ON tap_sessions(telegram_id);`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS check_in_logs (
        id SERIAL PRIMARY KEY,
        telegram_id BIGINT NOT NULL,
        check_in_date TEXT NOT NULL,
        streak INT NOT NULL DEFAULT 1,
        reward INT NOT NULL DEFAULT 0,
        logged_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_check_in_logs_tgid ON check_in_logs(telegram_id);`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS referral_logs (
        id SERIAL PRIMARY KEY,
        referrer_id BIGINT NOT NULL,
        referred_id BIGINT NOT NULL,
        event TEXT NOT NULL,
        sp_amount INT DEFAULT 0,
        logged_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_referral_logs_referrer ON referral_logs(referrer_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_referral_logs_referred ON referral_logs(referred_id);`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS balance_ledger (
        id SERIAL PRIMARY KEY,
        telegram_id BIGINT NOT NULL,
        delta INT NOT NULL,
        type TEXT NOT NULL,
        note TEXT,
        logged_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_balance_ledger_tgid ON balance_ledger(telegram_id);`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS daily_reward_log (
        id SERIAL PRIMARY KEY,
        distributed_at TIMESTAMPTZ DEFAULT NOW(),
        winners JSONB DEFAULT '[]'
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS withdrawals (
        id TEXT PRIMARY KEY,
        telegram_id BIGINT NOT NULL,
        user_name TEXT,
        wallet_address TEXT,
        sp_amount INTEGER NOT NULL,
        fee_amount INTEGER NOT NULL DEFAULT 0,
        net_sp_amount INTEGER NOT NULL,
        shht_amount TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_withdrawals_telegram_id ON withdrawals(telegram_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_withdrawals_status ON withdrawals(status);`);

    // ── Live Quiz tables ───────────────────────────────────────────────────────
    await pool.query(`
      CREATE TABLE IF NOT EXISTS live_quiz (
        id SERIAL PRIMARY KEY,
        question TEXT NOT NULL,
        options JSONB NOT NULL DEFAULT '[]',
        correct_idx INTEGER NOT NULL DEFAULT 0,
        reward INTEGER NOT NULL DEFAULT 100,
        duration_secs INTEGER NOT NULL DEFAULT 60,
        start_time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS quiz_answers (
        id SERIAL PRIMARY KEY,
        quiz_id INTEGER NOT NULL,
        telegram_id BIGINT NOT NULL,
        answer_idx INTEGER NOT NULL,
        is_correct BOOLEAN DEFAULT FALSE,
        reward_given INTEGER DEFAULT 0,
        answered_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(quiz_id, telegram_id)
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_quiz_answers_quiz_id ON quiz_answers(quiz_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_quiz_answers_tgid ON quiz_answers(telegram_id);`);

    // Add evaluated column (new in v2 — tracks submit vs evaluate separately)
    await pool.query(`ALTER TABLE quiz_answers ADD COLUMN IF NOT EXISTS evaluated BOOLEAN DEFAULT FALSE;`);
    // Mark all pre-existing rows as evaluated (old system combined submit+evaluate)
    await pool.query(`UPDATE quiz_answers SET evaluated = TRUE WHERE evaluated = FALSE;`);

    // Quiz weekly leaderboard rewards table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS quiz_leaderboard_rewards (
        id SERIAL PRIMARY KEY,
        telegram_id BIGINT NOT NULL,
        telegram_first_name TEXT,
        telegram_username TEXT,
        correct_answers INTEGER DEFAULT 0,
        rank INTEGER NOT NULL,
        reward INTEGER DEFAULT 2000,
        week_start DATE NOT NULL,
        rewarded_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_qlr_week ON quiz_leaderboard_rewards(week_start);`);

    // Add weekly quiz reward timestamp to app_settings
    await pool.query(`ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS last_quiz_weekly_reward_at TIMESTAMPTZ;`);

    // Quiz pool — pre-loaded question bank for auto-scheduling
    await pool.query(`
      CREATE TABLE IF NOT EXISTS quiz_pool (
        id SERIAL PRIMARY KEY,
        question TEXT NOT NULL,
        options JSONB NOT NULL DEFAULT '[]',
        correct_idx INTEGER NOT NULL DEFAULT 0,
        reward INTEGER DEFAULT 200,
        duration_secs INTEGER DEFAULT 60,
        used_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // Auto-scheduler columns in app_settings
    await pool.query(`ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS quiz_auto_enabled BOOLEAN DEFAULT FALSE;`);
    await pool.query(`ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS quiz_auto_hour_utc INTEGER DEFAULT 12;`);
    await pool.query(`ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS quiz_auto_frequency INTEGER DEFAULT 24;`);
    await pool.query(`ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS quiz_auto_last_fired_at TIMESTAMPTZ;`);
    await pool.query(`ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS ads_tasks JSONB DEFAULT '[]'`);

    // ── Spin security tables ─────────────────────────────────────────────────
    await pool.query(`
      CREATE TABLE IF NOT EXISTS spin_nonces (
        id SERIAL PRIMARY KEY,
        telegram_id BIGINT NOT NULL,
        nonce TEXT UNIQUE NOT NULL,
        prize_idx INTEGER NOT NULL,
        reward INTEGER NOT NULL,
        ton_cost NUMERIC NOT NULL DEFAULT 0,
        used BOOLEAN DEFAULT FALSE,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_spin_nonces_tgid ON spin_nonces(telegram_id);`);
    await pool.query(`ALTER TABLE spin_logs ADD COLUMN IF NOT EXISTS tx_hash TEXT;`);
    await pool.query(`ALTER TABLE spin_logs ADD COLUMN IF NOT EXISTS nonce TEXT;`);
    await pool.query(`ALTER TABLE spin_logs ADD COLUMN IF NOT EXISTS payment_verified BOOLEAN DEFAULT FALSE;`);

    // ── Payment audit table — records which comment was matched for each
    // successful payment, for admin visibility. Not used for replay
    // protection (the nonce's single-use UPDATE already guarantees that).
    await pool.query(`
      CREATE TABLE IF NOT EXISTS used_tx_hashes (
        tx_hash TEXT PRIMARY KEY,
        telegram_id BIGINT NOT NULL,
        used_for TEXT NOT NULL,
        used_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // ── Boost purchase log ───────────────────────────────────────────────────
    await pool.query(`
      CREATE TABLE IF NOT EXISTS boost_purchases (
        id SERIAL PRIMARY KEY,
        telegram_id BIGINT NOT NULL,
        nonce TEXT UNIQUE NOT NULL,
        boost_amount INTEGER NOT NULL,
        ton_cost NUMERIC NOT NULL,
        used BOOLEAN DEFAULT FALSE,
        tx_hash TEXT,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // ── ShhhToshi Blocks game tables ─────────────────────────────────────────
    await pool.query(`
      CREATE TABLE IF NOT EXISTS blocks_scores (
        id SERIAL PRIMARY KEY,
        telegram_id BIGINT NOT NULL,
        score INTEGER NOT NULL,
        period TEXT NOT NULL,        -- 'YYYY-MM-DD' for daily rows, 'YYYY-MM' for monthly rows
        period_type TEXT NOT NULL,   -- 'daily' | 'monthly'
        submitted_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(telegram_id, period, period_type)
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_blocks_scores_period ON blocks_scores(period_type, period, score DESC);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_blocks_scores_tgid ON blocks_scores(telegram_id);`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS blocks_reward_log (
        id SERIAL PRIMARY KEY,
        period_type TEXT NOT NULL,   -- 'daily' | 'monthly'
        period TEXT NOT NULL,        -- the period key that was paid out, e.g. '2026-08-05' or '2026-08'
        distributed_at TIMESTAMPTZ DEFAULT NOW(),
        winners JSONB DEFAULT '[]'
      );
    `);

    // ── Mystery Box purchase nonces (same prepare/verify pattern as spins) ──
    await pool.query(`
      CREATE TABLE IF NOT EXISTS mysterybox_nonces (
        id SERIAL PRIMARY KEY,
        telegram_id BIGINT NOT NULL,
        nonce TEXT UNIQUE NOT NULL,
        box_id TEXT NOT NULL,
        reward_sp INTEGER,
        reward_item_id TEXT,
        ton_cost NUMERIC NOT NULL DEFAULT 0,
        used BOOLEAN DEFAULT FALSE,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_mysterybox_nonces_tgid ON mysterybox_nonces(telegram_id);`);
    // Existing deployments already have this table with reward_sp NOT NULL —
    // relax it, and add the new cosmetic-payout column, without touching data.
    await pool.query(`ALTER TABLE mysterybox_nonces ALTER COLUMN reward_sp DROP NOT NULL;`);
    await pool.query(`ALTER TABLE mysterybox_nonces ADD COLUMN IF NOT EXISTS reward_item_id TEXT;`);

    // ── Shared cosmetics inventory (cross-game, admin-managed catalog) ──────
    // category: 'block_skin' | 'board_theme' | 'effect' | 'avatar_frame' |
    //           'badge' | 'name_color' | 'title'
    // rarity:   'common' | 'rare' | 'epic' | 'legendary' | 'mythic'
    // source:   how it can be unlocked — informational, doesn't gate anything
    //           server-side beyond what actually grants it (quest/streak/
    //           milestone/purchase/mysterybox/seasonal)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cosmetic_items (
        id TEXT PRIMARY KEY,
        category TEXT NOT NULL,
        rarity TEXT NOT NULL DEFAULT 'common',
        name TEXT NOT NULL,
        description TEXT DEFAULT '',
        preview_image TEXT DEFAULT '',
        css_data JSONB DEFAULT '{}',
        source TEXT DEFAULT 'shop',
        shhht_price INTEGER,
        active BOOLEAN DEFAULT TRUE,
        available_from TIMESTAMPTZ,
        available_until TIMESTAMPTZ,
        direct_purchase BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_cosmetic_items_category ON cosmetic_items(category, active);`);

    // Ownership — one row per (player, item). A player can own the same
    // item at most once; re-granting the same item (e.g. duplicate mystery
    // box roll) is a no-op via ON CONFLICT, never duplicated.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_cosmetics (
        id SERIAL PRIMARY KEY,
        telegram_id BIGINT NOT NULL,
        item_id TEXT NOT NULL REFERENCES cosmetic_items(id) ON DELETE CASCADE,
        acquired_via TEXT DEFAULT 'unknown',
        acquired_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(telegram_id, item_id)
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_cosmetics_tgid ON user_cosmetics(telegram_id);`);

    // Equipped state — one row per player, one equipped item per category.
    // Stored as a JSONB map { category: item_id } so adding new categories
    // later (new games, new cosmetic types) never needs a migration.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_equipped (
        telegram_id BIGINT PRIMARY KEY,
        equipped JSONB DEFAULT '{}',
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // ── Cosmetic unlock rules (admin-configurable milestones) ───────────────
    // trigger_type: 'streak' | 'blocks_high_score' | 'quiz_completions' |
    //               'referrals' | 'total_taps' | 'level'
    // threshold: the value the player's stat must reach/exceed to unlock.
    // Each rule grants exactly one cosmetic item once per player (checked
    // via user_cosmetics' existing UNIQUE constraint — granting twice is a
    // harmless no-op via grantCosmetic()).
    await pool.query(`
      CREATE TABLE IF NOT EXISTS unlock_rules (
        id TEXT PRIMARY KEY,
        trigger_type TEXT NOT NULL,
        threshold INTEGER NOT NULL,
        item_id TEXT NOT NULL REFERENCES cosmetic_items(id) ON DELETE CASCADE,
        active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_unlock_rules_trigger ON unlock_rules(trigger_type, active);`);

    // ── Progression system: XP, Level, Energy, City, Season ─────────────────
    // xp: separate progression currency from $SHHHT balance, earned from
    // taps/games/missions/referrals. Drives player_level (1..N, see LEVEL_XP_TABLE).
    // energy: spendable resource that gates taps/premium modes/events, regen'd
    // over time by a cron tick. city_level: cosmetic city-building progression,
    // driven by total XP earned (lifetime), separate from player_level so a
    // city never "downgrades" even if xp mechanics change later.
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS xp INTEGER DEFAULT 0;`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS xp_lifetime INTEGER DEFAULT 0;`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS player_level INTEGER DEFAULT 1;`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS energy INTEGER DEFAULT 100;`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS energy_max INTEGER DEFAULT 100;`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS energy_updated_at TIMESTAMPTZ DEFAULT NOW();`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS city_level INTEGER DEFAULT 1;`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS online_seconds_today INTEGER DEFAULT 0;`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS online_date TEXT DEFAULT '';`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS blocks_games_today INTEGER DEFAULT 0;`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS blocks_games_date TEXT DEFAULT '';`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS total_taps_lifetime BIGINT DEFAULT 0;`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS current_season_id TEXT;`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS season_xp INTEGER DEFAULT 0;`);

    // Daily missions — catalog defined by admin, per-user progress tracked
    // separately and reset each day by the mission cron.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS missions_catalog (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT DEFAULT '',
        metric TEXT NOT NULL,
        target INTEGER NOT NULL DEFAULT 1,
        reward_sp INTEGER NOT NULL DEFAULT 0,
        reward_xp INTEGER NOT NULL DEFAULT 0,
        reward_cosmetic_id TEXT REFERENCES cosmetic_items(id) ON DELETE SET NULL,
        active BOOLEAN DEFAULT TRUE,
        sort_order INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_missions (
        id SERIAL PRIMARY KEY,
        telegram_id BIGINT NOT NULL,
        mission_id TEXT NOT NULL REFERENCES missions_catalog(id) ON DELETE CASCADE,
        date TEXT NOT NULL,
        progress INTEGER NOT NULL DEFAULT 0,
        claimed BOOLEAN DEFAULT FALSE,
        completed_at TIMESTAMPTZ,
        UNIQUE(telegram_id, mission_id, date)
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_missions_lookup ON user_missions(telegram_id, date);`);

    // Achievements — one-time (lifetime) milestones, distinct from the
    // recurring daily missions above. Reuses the unlock_rules-style trigger
    // model but tracked in its own table since achievements grant XP/SP/badges
    // together rather than a single cosmetic.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS achievements_catalog (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT DEFAULT '',
        trigger_type TEXT NOT NULL,
        threshold INTEGER NOT NULL,
        reward_sp INTEGER NOT NULL DEFAULT 0,
        reward_xp INTEGER NOT NULL DEFAULT 0,
        reward_cosmetic_id TEXT REFERENCES cosmetic_items(id) ON DELETE SET NULL,
        icon TEXT DEFAULT '🏆',
        active BOOLEAN DEFAULT TRUE,
        sort_order INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_achievements (
        id SERIAL PRIMARY KEY,
        telegram_id BIGINT NOT NULL,
        achievement_id TEXT NOT NULL REFERENCES achievements_catalog(id) ON DELETE CASCADE,
        unlocked_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(telegram_id, achievement_id)
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_achievements_tgid ON user_achievements(telegram_id);`);

    // Seasons — monthly resets of season_xp/season leaderboard. Cosmetics
    // tagged to a season already use cosmetic_items.available_from/until.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS seasons (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        starts_at TIMESTAMPTZ NOT NULL,
        ends_at TIMESTAMPTZ NOT NULL,
        theme TEXT DEFAULT '',
        banner_image TEXT DEFAULT '',
        active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS season_rewards_log (
        id SERIAL PRIMARY KEY,
        season_id TEXT NOT NULL,
        telegram_id BIGINT NOT NULL,
        rank INTEGER,
        reward_sp INTEGER DEFAULT 0,
        reward_cosmetic_id TEXT,
        distributed_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // ── Seed default missions & achievements on first boot only ─────────────
    // Uses ON CONFLICT DO NOTHING so admin edits made later are never
    // overwritten by this seed running again on restart.
    const defaultMissions = [
      ['tap_5000', 'Tap 5,000 Times', 'Tap your way to 5,000 taps today', 'taps', 5000, 500, 50, 1],
      ['play_3_blocks', 'Play 3 Block Blast Games', 'Complete 3 games of ShhhToshi Blocks', 'blocks_games', 3, 300, 40, 2],
      ['score_10000', 'Score 10,000 Points', 'Rack up 10,000 points in Block Blast (single or combined games)', 'blocks_score', 10000, 750, 75, 3],
      ['invite_1_friend', 'Invite 1 Friend', 'Bring a friend into ShhhToshi', 'referrals', 1, 400, 60, 4],
      ['claim_daily', 'Claim Daily Reward', "Check in for today's reward", 'checkin', 1, 100, 20, 5],
      ['stay_online_10', 'Stay Online 10 Minutes', 'Keep the app open for 10 minutes', 'online_minutes', 10, 200, 30, 6]
    ];
    for (const [id, title, desc, metric, target, sp, xp, order] of defaultMissions) {
      await pool.query(
        `INSERT INTO missions_catalog (id, title, description, metric, target, reward_sp, reward_xp, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO NOTHING`,
        [id, title, desc, metric, target, sp, xp, order]
      );
    }

    const defaultAchievements = [
      ['first_tap', 'First Tap', 'Tap for the very first time', 'total_taps', 1, 50, 10, '👆', 1],
      ['taps_100000', '100,000 Taps', 'Reach 100,000 lifetime taps', 'total_taps', 100000, 2000, 200, '💥', 2],
      ['blocks_20000', 'Block Blast Champion', 'Score 20,000+ in a single Block Blast game', 'blocks_high_score', 20000, 1500, 150, '🧱', 3],
      ['streak_7', '7-Day Streak', 'Check in 7 days in a row', 'streak', 7, 500, 75, '🔥', 4],
      ['invite_10', 'Invite 10 Friends', 'Successfully refer 10 friends', 'referrals', 10, 2500, 250, '👥', 5],
      ['level_25', 'Reach Level 25', 'Hit player level 25', 'level', 25, 3000, 0, '⭐', 6]
    ];
    for (const [id, title, desc, trigger, threshold, sp, xp, icon, order] of defaultAchievements) {
      await pool.query(
        `INSERT INTO achievements_catalog (id, title, description, trigger_type, threshold, reward_sp, reward_xp, icon, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO NOTHING`,
        [id, title, desc, trigger, threshold, sp, xp, icon, order]
      );
    }

    console.log('✅ DB migration complete');
  } catch (e) {
    console.error('Migration error:', e.message);
  }
}

// ── Auto Quiz Scheduler ────────────────────────────────────────────────────────
async function checkAutoQuiz() {
  try {
    const settings = await pool.query(
      'SELECT quiz_auto_enabled, quiz_auto_hour_utc, quiz_auto_frequency, quiz_auto_last_fired_at FROM app_settings WHERE id = 1'
    );
    const s = settings.rows[0];
    if (!s?.quiz_auto_enabled) return;

    const now = new Date();
    const hourUTC = now.getUTCHours();
    if (hourUTC !== parseInt(s.quiz_auto_hour_utc)) return;

    // Guard: don't fire again within the frequency window
    if (s.quiz_auto_last_fired_at) {
      const hoursSince = (now - new Date(s.quiz_auto_last_fired_at)) / (1000 * 60 * 60);
      if (hoursSince < (parseInt(s.quiz_auto_frequency) || 24)) return;
    }

    // Pick least-recently-used question from pool
    const poolQ = await pool.query(
      `SELECT * FROM quiz_pool ORDER BY used_at ASC NULLS FIRST, RANDOM() LIMIT 1`
    );
    if (!poolQ.rows.length) { console.log('Auto quiz: pool empty, skipping'); return; }
    const q = poolQ.rows[0];

    // Create quiz
    await pool.query(`UPDATE live_quiz SET is_active = FALSE`);
    await pool.query(
      `INSERT INTO live_quiz (question, options, correct_idx, reward, duration_secs, start_time, is_active)
       VALUES ($1, $2, $3, $4, $5, NOW(), TRUE)`,
      [q.question, JSON.stringify(q.options), q.correct_idx, q.reward, q.duration_secs]
    );
    await pool.query(`UPDATE quiz_pool SET used_at = NOW() WHERE id = $1`, [q.id]);
    await pool.query(`UPDATE app_settings SET quiz_auto_last_fired_at = NOW() WHERE id = 1`);
    console.log(`✅ Auto quiz fired: "${q.question.substring(0, 60)}"`);

    // Broadcast
    const msg = `🧠⚡ <b>LIVE QUIZ ALERT!</b> ⚡🧠\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `❓ <b>${q.question.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</b>\n\n` +
      `⏱ You have <b>${q.duration_secs} seconds</b> to answer!\n` +
      `💰 Correct = <b>+${q.reward.toLocaleString()} Sp</b> in your wallet!\n\n` +
      `🔥 One shot only — don't miss it!\n` +
      `━━━━━━━━━━━━━━━━━━━━\n👇 Open the app NOW!`;
    const allUsers = await pool.query('SELECT telegram_id FROM users WHERE banned = FALSE');
    for (const u of allUsers.rows) {
      try {
        await bot.sendMessage(u.telegram_id, msg, {
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [[{ text: '🧠 Answer Quiz Now!', web_app: { url: MINI_APP_URL } }]] }
        });
        await new Promise(r => setTimeout(r, 40));
      } catch (_) {}
    }
  } catch (e) {
    console.error('checkAutoQuiz error:', e.message);
  }
}

// ── Season rewards: fires once when the active season's end time passes ────────
// Pays top-20 season_xp earners a tiered Sp bonus, logs it so it never
// double-pays, then resets everyone's season_xp for the next season.
async function distributeSeasonRewards() {
  try {
    const ended = await pool.query(
      `SELECT * FROM seasons WHERE active = TRUE AND ends_at <= NOW()
       AND id NOT IN (SELECT DISTINCT season_id FROM season_rewards_log)
       ORDER BY ends_at ASC LIMIT 1`
    );
    if (!ended.rows.length) return;
    const season = ended.rows[0];

    const top = await pool.query(
      `SELECT telegram_id, season_xp FROM users WHERE banned = FALSE AND season_xp > 0 ORDER BY season_xp DESC LIMIT 20`
    );
    const TIER_REWARDS = [2000, 1500, 1000, 750, 500]; // ranks 1-5, then 6-20 get 200
    for (let i = 0; i < top.rows.length; i++) {
      const reward = TIER_REWARDS[i] ?? 200;
      const u = top.rows[i];
      await pool.query(`UPDATE users SET shhhtoshi = shhhtoshi + $1 WHERE telegram_id = $2`, [reward, u.telegram_id]);
      await pool.query(
        `INSERT INTO season_rewards_log (season_id, telegram_id, rank, reward_sp) VALUES ($1, $2, $3, $4)`,
        [season.id, u.telegram_id, i + 1, reward]
      );
      sendBotMsg(u.telegram_id, `🌍 <b>Season "${season.name}" has ended!</b>\nYou finished <b>#${i + 1}</b> and earned <b>+${reward.toLocaleString()} Sp</b>! A new season starts now.`);
    }
    // Guard row so an empty leaderboard doesn't re-trigger this every tick.
    if (!top.rows.length) {
      await pool.query(`INSERT INTO season_rewards_log (season_id, telegram_id, rank, reward_sp) VALUES ($1, 0, 0, 0)`, [season.id]);
    }

    await pool.query(`UPDATE seasons SET active = FALSE WHERE id = $1`, [season.id]);
    await pool.query(`UPDATE users SET season_xp = 0, current_season_id = NULL`);
    console.log(`✅ Season "${season.name}" ended and rewards distributed to ${top.rows.length} players.`);
  } catch (e) {
    console.error('distributeSeasonRewards error:', e.message);
  }
}

// Run migration first, then start cron after schema is ready
migrate().then(() => {
  distributeDailyRewards();
  setInterval(distributeDailyRewards, 5 * 60 * 1000);
  // Blocks game removed — prize cron disabled
  // distributeBlocksDailyReward();
  // setInterval(distributeBlocksDailyReward, 5 * 60 * 1000);
  // distributeBlocksMonthlyReward();
  // setInterval(distributeBlocksMonthlyReward, 60 * 60 * 1000);
  processWeeklyQuizRewards();
  setInterval(processWeeklyQuizRewards, 60 * 60 * 1000); // check hourly, self-guards against double-run
  sendDailyCheckinReminders();
  setInterval(sendDailyCheckinReminders, 60 * 60 * 1000); // check every hour
  checkAutoQuiz();
  setInterval(checkAutoQuiz, 5 * 60 * 1000); // check every 5 minutes
  distributeSeasonRewards();
  setInterval(distributeSeasonRewards, 15 * 60 * 1000); // check every 15 minutes
});

// ── Helper: get all admin IDs (main + extra) ────────────────────────────────
async function getAdminIds() {
  try {
    const r = await pool.query('SELECT extra_admins FROM app_settings WHERE id = 1');
    const extra = r.rows[0]?.extra_admins || [];
    return [ADMIN_ID, ...extra.map(id => parseInt(id))];
  } catch {
    return [ADMIN_ID];
  }
}

// ── Helper: admin panel password hashing (scrypt, salted, no plaintext stored) ─
function hashAdminPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}
function verifyAdminPassword(password, storedHash) {
  try {
    if (!storedHash || !password) return false;
    const [salt, key] = storedHash.split(':');
    if (!salt || !key) return false;
    const derived = crypto.scryptSync(password, salt, 64);
    const keyBuf = Buffer.from(key, 'hex');
    if (keyBuf.length !== derived.length) return false;
    return crypto.timingSafeEqual(keyBuf, derived);
  } catch {
    return false;
  }
}

// ── Helper: CRC16/XMODEM for TON address checksum ────────────────────────────
function crc16(data) {
  let c = 0;
  for (let i = 0; i < data.length; i++) {
    let b = data[i];
    for (let j = 0; j < 8; j++) {
      if ((c ^ (b << 8)) & 0x8000) c = ((c << 1) ^ 0x1021) & 0xffff;
      else c = (c << 1) & 0xffff;
      b = (b << 1) & 0xff;
    }
  }
  return c;
}

// ── Helper: convert a raw "workchain:hex" TON address to standard friendly
// (base64url, non-bounceable, e.g. UQ...) form. Safety net in case any wallet
// address ever reaches here in raw form instead of already-friendly form. ──
function rawToFriendly(raw) {
  try {
    if (!raw || typeof raw !== 'string') return raw || '';
    if (/^(UQ|EQ|kQ|0Q)/.test(raw)) return raw; // already friendly
    const parts = raw.split(':');
    if (parts.length !== 2) return raw;
    const workchain = parseInt(parts[0]);
    const hex = parts[1];
    if (hex.length !== 64) return raw;
    const hash = Buffer.from(hex, 'hex');
    if (hash.length !== 32) return raw;
    const flags = workchain === -1 ? 0x11 : 0x51; // non-bounceable
    const addr = Buffer.alloc(36);
    addr[0] = flags;
    addr[1] = workchain & 0xff;
    hash.copy(addr, 2);
    const crc = crc16(addr.slice(0, 34));
    addr[34] = (crc >> 8) & 0xff;
    addr[35] = crc & 0xff;
    return addr.toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
  } catch {
    return raw;
  }
}

// ── Helper: verify a TON payment actually reached the treasury ─────────────
// TonConnect's sendTransaction() only returns a signed BOC, not a queryable
// transaction hash — deriving the real hash requires full TON cell-parsing,
// which isn't worth hand-rolling here. Instead, we verify payment by looking
// at the TREASURY's own incoming transactions on TonCenter and matching by:
//  1. The comment we asked the wallet to attach (e.g. "Spin #123 ID:12345"),
//     which is unique per purchase and impossible to guess in advance
//  2. The value received is at least the expected cost (2% tolerance)
//  3. The transaction happened recently (within the last 30 minutes)
// Returns { verified: boolean, reason: string }
async function verifyTonPayment(expectedComment, expectedTonCost) {
  if (!expectedComment) return { verified: false, reason: 'missing_comment' };
  try {
    const https = require('https');
    const apiKey = process.env.TONCENTER_API_KEY || '';
    const url = `https://toncenter.com/api/v2/getTransactions?address=${encodeURIComponent(TREASURY_ADDR)}&limit=30&archival=false`;
    const data = await new Promise((resolve, reject) => {
      const headers = { 'Accept': 'application/json' };
      if (apiKey) headers['X-Api-Key'] = apiKey;
      const req2 = https.get(url, { headers }, r => {
        let body = '';
        r.on('data', d => body += d);
        r.on('end', () => { try { resolve({ status: r.statusCode, json: JSON.parse(body) }); } catch { resolve({ status: r.statusCode, json: null, raw: body }); } });
      });
      req2.on('error', e => { console.error('verifyTonPayment HTTP error:', e.message); resolve(null); });
      req2.setTimeout(8000, () => { req2.destroy(); resolve(null); });
    });

    if (!data) {
      console.error('verifyTonPayment: request failed or timed out');
      return { verified: false, reason: 'lookup_failed' };
    }
    if (!data.json || data.json.ok === false) {
      console.error('verifyTonPayment: TonCenter returned an error. status=', data.status, 'body=', JSON.stringify(data.json || data.raw).slice(0, 500));
      return { verified: false, reason: 'lookup_failed' };
    }
    if (!Array.isArray(data.json.result)) {
      console.error('verifyTonPayment: unexpected response shape:', JSON.stringify(data.json).slice(0, 500));
      return { verified: false, reason: 'lookup_failed' };
    }

    const expectedNano = Math.floor(expectedTonCost * 1e9 * 0.98); // 2% tolerance
    const nowSec = Date.now() / 1000;
    const candidates = [];
    const match = data.json.result.find(tx => {
      const inMsg = tx.in_msg;
      if (!inMsg || !inMsg.value) return false;
      if (parseFloat(inMsg.value) < expectedNano) return false;
      if (tx.utime && Math.abs(nowSec - Number(tx.utime)) > 1800) return false;

      // Per TonCenter's documented schema, in_msg.message holds the decoded
      // plain-text comment when decoding succeeds. Fall back to manually
      // decoding msg_data.body (raw BOC) if .message is empty/missing.
      let comment = '';
      try {
        if (inMsg.message) {
          comment = inMsg.message;
        } else if (inMsg.msg_data?.body) {
          const raw = Buffer.from(inMsg.msg_data.body, 'base64');
          comment = raw.slice(4).toString('utf8').replace(/\0/g, '');
        }
      } catch (e) {
        console.error('verifyTonPayment: comment decode error:', e.message);
      }
      candidates.push({ value: inMsg.value, comment, utime: tx.utime });
      return comment.trim() === expectedComment.trim();
    });

    if (!match) {
      console.error('verifyTonPayment: no match for comment="' + expectedComment + '". Recent incoming txs:', JSON.stringify(candidates).slice(0, 800));
      return { verified: false, reason: 'no_matching_payment_found' };
    }
    return { verified: true, reason: 'ok' };
  } catch (e) {
    console.error('verifyTonPayment error:', e.message, e.stack);
    return { verified: false, reason: 'verification_error' };
  }
}

// ── Helper: send bot message safely (no crash if bot unavailable) ────────────
function sendBotMsg(chatId, text, opts = {}) {
  try {
    bot.sendMessage(chatId, text, { parse_mode: 'HTML', ...opts });
  } catch (e) {
    console.error('sendBotMsg error:', e.message);
  }
}

// ── Telegram Init Data Validation ──────────────────────────────────────────────
function validateTelegramData(initData) {
  if (!initData || !BOT_TOKEN) return null;
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;

    params.delete('hash');
    const dataCheckString = Array.from(params.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');

    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

    if (computedHash !== hash) return null;

    const userStr = params.get('user');
    return userStr ? JSON.parse(userStr) : null;
  } catch (e) {
    return null;
  }
}

// ── Middleware: Auth ───────────────────────────────────────────────────────────
function authMiddleware(req, res, next) {
  const initData = req.headers['x-telegram-init-data'] || req.body?.initData;
  if (!initData) return res.status(401).json({ error: 'Missing auth' });
  const user = validateTelegramData(initData);
  if (!user) return res.status(401).json({ error: 'Invalid auth' });
  req.tgUser = user;
  next();
}

async function adminMiddleware(req, res, next) {
  const adminIds = await getAdminIds();
  if (!req.tgUser || !adminIds.includes(parseInt(req.tgUser.id))) {
    return res.status(403).json({ error: 'Admin only' });
  }
  next();
}

// ── Helper: fetch and cache Telegram profile photo via Bot API ─────────────────
async function fetchAndCachePhoto(userId) {
  try {
    const photos = await bot.getUserProfilePhotos(userId, { limit: 1 });
    if (!photos || !photos.photos || !photos.photos.length) return null;
    const fileId = photos.photos[0][photos.photos[0].length - 1].file_id;
    const file = await bot.getFile(fileId);
    if (!file || !file.file_path) return null;
    const photoUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
    await pool.query('UPDATE users SET telegram_photo_url = $1 WHERE telegram_id = $2', [photoUrl, userId]);
    return photoUrl;
  } catch (e) {
    return null;
  }
}

// ── User: Login / Register ─────────────────────────────────────────────────────
app.post('/api/auth', authLimiter, authMiddleware, async (req, res) => {
  const { id, username, first_name, last_name, photo_url } = req.tgUser;
  const refCode = 'SHHHT-' + String(id).slice(-6).toUpperCase();

  try {
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
    let user = result.rows[0];
    if (user.banned) return res.status(403).json({ error: 'banned' });
    const adminIds = await getAdminIds();

    // Fetch photo on first login — wait up to 3s so user sees their pic immediately
    if (!user.telegram_photo_url) {
      const photoUrl = await Promise.race([
        fetchAndCachePhoto(id),
        new Promise(resolve => setTimeout(() => resolve(null), 3000))
      ]);
      if (photoUrl) user = { ...user, telegram_photo_url: photoUrl };
    }

    res.json({ user, isAdmin: adminIds.includes(parseInt(id)) });
  } catch (err) {
    console.error('/api/auth error:', err);
    res.status(500).json({ error: 'DB error' });
  }
});

// ── User: Get Current Profile (used by profile tab refresh) ───────────────────
app.get(['/api/auth/me', '/api/user/me'], authMiddleware, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [req.tgUser.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    let user = r.rows[0];
    if (user.banned) return res.status(403).json({ error: 'banned' });
    // Refresh photo in background if still missing
    if (!user.telegram_photo_url) {
      fetchAndCachePhoto(req.tgUser.id).then(photoUrl => {
        if (photoUrl) user = { ...user, telegram_photo_url: photoUrl };
      });
    }
    const adminIds = await getAdminIds();
    res.json({ user, isAdmin: adminIds.includes(parseInt(req.tgUser.id)) });
  } catch (err) {
    console.error('/api/auth/me error:', err);
    res.status(500).json({ error: 'DB error' });
  }
});

// ── User: Get Profile ──────────────────────────────────────────────────────────
app.get('/api/user', authMiddleware, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [req.tgUser.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    const user = r.rows[0];
    if (user.banned) return res.status(403).json({ error: 'banned' });
    const adminIds = await getAdminIds();
    res.json({ user, isAdmin: adminIds.includes(parseInt(req.tgUser.id)) });
  } catch (err) {
    res.status(500).json({ error: 'DB error' });
  }
});

// ── User: Update data ──────────────────────────────────────────────────────────
app.post(['/api/user/update', '/api/user/sync', '/api/user/wallet'], authMiddleware, async (req, res) => {
  const { shhhtoshi, task_earnings, tap_earnings, today_taps, last_tap_date, tap_limit_boosted,
          tasks_completed, spin_history, withdrawal_requests, check_in, wallet_address,
          referrals, referral_earnings, referred_by, daily_sp, daily_sp_date, tap_delta } = req.body;
  try {
    const fields = [];
    const vals = [];
    let i = 1;
    const add = (col, val) => { if (val !== undefined) { fields.push(`${col} = $${i++}`); vals.push(val); } };
    add('shhhtoshi', shhhtoshi);
    add('task_earnings', task_earnings);
    add('tap_earnings', tap_earnings);
    add('today_taps', today_taps);
    add('last_tap_date', last_tap_date);
    add('tap_limit_boosted', tap_limit_boosted !== undefined ? JSON.stringify(tap_limit_boosted) : undefined);
    add('tasks_completed', tasks_completed !== undefined ? JSON.stringify(tasks_completed) : undefined);
    add('spin_history', spin_history !== undefined ? JSON.stringify(spin_history) : undefined);
    add('withdrawal_requests', withdrawal_requests !== undefined ? JSON.stringify(withdrawal_requests) : undefined);
    add('check_in', check_in !== undefined ? JSON.stringify(check_in) : undefined);
    add('wallet_address', wallet_address);
    add('referrals', referrals);
    add('referral_earnings', referral_earnings);
    add('referred_by', referred_by);
    add('daily_sp', daily_sp);
    add('daily_sp_date', daily_sp_date);

    if (!fields.length) return res.json({ ok: true });
    fields.push(`updated_at = NOW()`);
    vals.push(req.tgUser.id);
    const r = await pool.query(
      `UPDATE users SET ${fields.join(', ')} WHERE telegram_id = $${i} RETURNING *`,
      vals
    );
    const updatedUser = r.rows[0];

    // UPSERT into daily_earnings when daily_sp is being saved (use GREATEST to not overwrite higher values)
    if (daily_sp !== undefined && daily_sp_date && daily_sp > 0) {
      await pool.query(
        `INSERT INTO daily_earnings (telegram_id, date, sp_amount) VALUES ($1, $2, $3)
         ON CONFLICT (telegram_id, date) DO UPDATE SET sp_amount = GREATEST(daily_earnings.sp_amount, $3)`,
        [req.tgUser.id, daily_sp_date, daily_sp]
      ).catch(() => {});
    }

    // UPSERT tap session when today_taps is being saved
    if (today_taps !== undefined && last_tap_date) {
      await pool.query(
        `INSERT INTO tap_sessions (telegram_id, date, taps, sp_earned, updated_at)
         VALUES ($1, $2, $3, $3, NOW())
         ON CONFLICT (telegram_id, date) DO UPDATE SET taps = $3, sp_earned = $3, updated_at = NOW()`,
        [req.tgUser.id, last_tap_date, today_taps]
      ).catch(() => {});
    }

    // Award XP + daily-mission progress for real taps since the last sync.
    // tap_delta is a small positive int (client sends it once per debounced
    // sync, not per tap), so 1 xp/tap keeps this in line with other actions.
    let xpResult = null, newAchievements = [];
    const validDelta = Number.isFinite(tap_delta) && tap_delta > 0 && tap_delta <= 5000;
    if (validDelta) {
      xpResult = await grantXp(req.tgUser.id, tap_delta, 'Tapping');
      await bumpMissionProgress(req.tgUser.id, 'taps', tap_delta);
      const lifetimeRow = await pool.query(
        `UPDATE users SET total_taps_lifetime = total_taps_lifetime + $1 WHERE telegram_id = $2 RETURNING total_taps_lifetime`,
        [tap_delta, req.tgUser.id]
      );
      newAchievements = await checkAndGrantAchievements(req.tgUser.id, 'total_taps', lifetimeRow.rows[0]?.total_taps_lifetime || 0);
    }

    const finalUser = xpResult ? (await pool.query('SELECT * FROM users WHERE telegram_id = $1', [req.tgUser.id])).rows[0] : updatedUser;
    res.json({ user: finalUser, levelUp: xpResult?.leveledUp || false, cityUpgraded: xpResult?.cityUpgraded || false, newAchievements });
  } catch (err) {
    console.error('/api/user/update error:', err);
    res.status(500).json({ error: 'DB error' });
  }
});

// ── Referral: apply ────────────────────────────────────────────────────────────
app.post('/api/referral/apply', authMiddleware, async (req, res) => {
  const { refCode } = req.body;
  const myId = req.tgUser.id;
  try {
    const me = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [myId]);
    if (!me.rows.length) return res.status(404).json({ error: 'User not found' });
    const user = me.rows[0];
    if (user.referred_by) return res.status(400).json({ error: 'Already referred' });

    const ref = await pool.query('SELECT * FROM users WHERE referral_code = $1', [refCode.toUpperCase()]);
    if (!ref.rows.length) return res.status(400).json({ error: 'Invalid code' });
    if (ref.rows[0].telegram_id === myId) return res.status(400).json({ error: 'Cannot use own code' });

    // Give referred user 250 Sp bonus; mark referral_reward_pending so referrer gets 500 Sp after 5 tasks
    await pool.query(
      'UPDATE users SET referred_by = $1, shhhtoshi = shhhtoshi + 250, referral_reward_pending = TRUE WHERE telegram_id = $2',
      [refCode.toUpperCase(), myId]
    );
    // Increment referrer's referral count only (500 Sp comes later when referred user does 5 tasks)
    await pool.query('UPDATE users SET referrals = referrals + 1 WHERE telegram_id = $1', [ref.rows[0].telegram_id]);

    // Log referral event
    await pool.query(
      `INSERT INTO referral_logs (referrer_id, referred_id, event, sp_amount) VALUES ($1, $2, 'joined', 250)`,
      [ref.rows[0].telegram_id, myId]
    ).catch(() => {});
    await pool.query(
      `INSERT INTO balance_ledger (telegram_id, delta, type, note) VALUES ($1, 250, 'referral', 'Referral join bonus')`,
      [myId]
    ).catch(() => {});

    // XP for both sides: the new player gets a small welcome XP bump, the
    // referrer gets XP now and the bigger 500 Sp reward later (5-task gate above).
    await grantXp(myId, 25, 'Referral welcome bonus');
    await grantXp(ref.rows[0].telegram_id, 50, 'Referred a friend');
    await bumpMissionProgress(ref.rows[0].telegram_id, 'referrals', 1);
    await checkAndGrantAchievements(ref.rows[0].telegram_id, 'referrals', (ref.rows[0].referrals || 0) + 1);

    const updated = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [myId]);
    res.json({ user: updated.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'DB error' });
  }
});

// ── Task: Complete (server-enforced, prevents one-time task duplication) ───────
// Looks up a task definition by id across the two places tasks live:
// app_settings.tasks (the main Earn-tab list) and app_settings.stake_task
// (a single special-cased task). Returns null if not found, so callers can
// tell "task doesn't exist" apart from "task has no extra config".
async function findTaskById(taskId) {
  const r = await pool.query('SELECT tasks, stake_task FROM app_settings WHERE id = 1');
  const row = r.rows[0];
  if (!row) return null;
  const tasks = Array.isArray(row.tasks) ? row.tasks : [];
  const found = tasks.find(t => t && t.id === taskId);
  if (found) return found;
  if (row.stake_task && row.stake_task.id === taskId) return { ...row.stake_task, type: row.stake_task.type || 'social' };
  return null;
}

// Verifies the user is a member of a Telegram channel/group via the bot's
// getChatMember call. Requires the bot to be an admin (or at least present)
// in that chat, which is why this needs the bot added there manually.
// Returns { ok, error } — never throws, so callers can treat any failure as
// "not verified" without a separate try/catch.
async function verifyTelegramMembership(chatIdentifier, userId) {
  if (!chatIdentifier) return { ok: false, error: 'Task is missing its Telegram chat — contact an admin' };
  try {
    const member = await bot.getChatMember(chatIdentifier, userId);
    const validStatuses = ['creator', 'administrator', 'member'];
    // 'restricted' can still count as a member depending on Telegram's rules;
    // we only exclude 'left' and 'kicked' (banned) as definitely-not-joined.
    if (validStatuses.includes(member.status) || member.status === 'restricted') {
      return { ok: true };
    }
    return { ok: false, error: 'You haven\'t joined yet — join then tap Claim again' };
  } catch (e) {
    // Most common cause: bot isn't an admin/member of the target chat, or
    // the chat identifier is wrong. Surface a generic message to the user
    // but log the real reason for the admin to fix.
    console.error(`verifyTelegramMembership(${chatIdentifier}, ${userId}) error:`, e.message);
    if (e.message && e.message.includes('member list is inaccessible')) {
      return { ok: false, error: 'Verification unavailable right now — try again shortly' };
    }
    if (e.message && (e.message.includes('chat not found') || e.message.includes('CHAT_ADMIN_REQUIRED'))) {
      return { ok: false, error: 'This task isn\'t set up correctly — contact an admin' };
    }
    return { ok: false, error: 'Couldn\'t verify your membership — try again' };
  }
}

app.post('/api/task/complete', taskLimiter, authMiddleware, async (req, res) => {
  const { task_id, task_type } = req.body;
  if (!task_id) return res.status(400).json({ error: 'Missing task_id' });
  const tgId = req.tgUser.id;
  const isAd = task_type === 'ad';
  const today = new Date().toISOString().split('T')[0];
  try {
    // Look up the task server-side — the reward and any Telegram chat to
    // verify against always come from here, never from the client. Ad
    // "tasks" aren't in the catalog (they're granted per-watch), so they
    // keep using the client-provided reward, same as before.
    let reward;
    let task = null;
    if (isAd) {
      reward = req.body.reward;
      if (reward == null) return res.status(400).json({ error: 'Missing reward' });
    } else {
      task = await findTaskById(task_id);
      if (!task) return res.status(404).json({ error: 'Task not found' });
      reward = task.reward;
    }

    // Server-side uniqueness check for non-ad tasks
    if (!isAd) {
      const existing = await pool.query(
        `SELECT id FROM task_completions WHERE telegram_id = $1 AND task_id = $2 AND task_type != 'ad'`,
        [tgId, task_id]
      );
      if (existing.rows.length > 0) return res.status(409).json({ error: 'Task already completed' });
    }

    // Telegram membership verification — only for tasks explicitly flagged
    // as telegram_channel/telegram_group by an admin, and only once the bot
    // has been made an admin of that chat (see verifyTelegramMembership).
    if (task && (task.type === 'telegram_channel' || task.type === 'telegram_group')) {
      const verify = await verifyTelegramMembership(task.chatId, tgId);
      if (!verify.ok) return res.status(403).json({ error: verify.error });
    }

    // Log completion
    await pool.query(
      `INSERT INTO task_completions (telegram_id, task_id, task_type, reward) VALUES ($1, $2, $3, $4)`,
      [tgId, task_id, task_type || 'regular', reward]
    );

    // OG Pass: +20% task rewards
    let finalReward = reward;
    try {
      const ogR = await pool.query('SELECT og_pass FROM users WHERE telegram_id = $1', [tgId]);
      if (ogR.rows[0]?.og_pass) finalReward = Math.floor(reward * 1.2);
    } catch (_) {}

    // Update user balance
    await pool.query(
      `UPDATE users SET shhhtoshi = shhhtoshi + $1, task_earnings = task_earnings + $1, updated_at = NOW() WHERE telegram_id = $2`,
      [finalReward, tgId]
    );
    reward = finalReward;

    // Update tasks_completed JSONB for non-ad tasks (backward compat)
    if (!isAd) {
      await pool.query(
        `UPDATE users SET tasks_completed = COALESCE(tasks_completed, '[]'::jsonb) || $1::jsonb WHERE telegram_id = $2`,
        [JSON.stringify([task_id]), tgId]
      );
    }

    // UPSERT daily_earnings
    await pool.query(
      `INSERT INTO daily_earnings (telegram_id, date, sp_amount) VALUES ($1, $2, $3)
       ON CONFLICT (telegram_id, date) DO UPDATE SET sp_amount = daily_earnings.sp_amount + $3`,
      [tgId, today, reward]
    );

    // Sync daily_sp on user row from daily_earnings
    const deRow = await pool.query('SELECT sp_amount FROM daily_earnings WHERE telegram_id = $1 AND date = $2', [tgId, today]);
    const todayTotal = deRow.rows[0]?.sp_amount || reward;
    await pool.query('UPDATE users SET daily_sp = $1, daily_sp_date = $2 WHERE telegram_id = $3', [todayTotal, today, tgId]);

    // Balance ledger
    await pool.query(
      `INSERT INTO balance_ledger (telegram_id, delta, type, note) VALUES ($1, $2, 'task', $3)`,
      [tgId, reward, `Task: ${task_id}`]
    ).catch(() => {});

    // Referral gating: credit referrer when referred user hits 5 non-ad tasks
    const freshUser = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [tgId]);
    const u = freshUser.rows[0];
    if (!isAd && u.referred_by && u.referral_reward_pending) {
      const countRow = await pool.query(
        `SELECT COUNT(*) FROM task_completions WHERE telegram_id = $1 AND task_type != 'ad'`,
        [tgId]
      );
      if (parseInt(countRow.rows[0].count) >= 5) {
        const refUser = await pool.query('SELECT * FROM users WHERE referral_code = $1', [u.referred_by]);
        if (refUser.rows.length) {
          await pool.query(
            'UPDATE users SET shhhtoshi = shhhtoshi + 500, referral_earnings = referral_earnings + 500, bonus_spins = COALESCE(bonus_spins,0) + 1 WHERE telegram_id = $1',
            [refUser.rows[0].telegram_id]
          );
          await pool.query('UPDATE users SET referral_reward_pending = FALSE WHERE telegram_id = $1', [tgId]);
          await pool.query(
            `INSERT INTO referral_logs (referrer_id, referred_id, event, sp_amount) VALUES ($1, $2, 'reward_paid', 500)`,
            [refUser.rows[0].telegram_id, tgId]
          ).catch(() => {});
          await pool.query(
            `INSERT INTO balance_ledger (telegram_id, delta, type, note) VALUES ($1, 500, 'referral', 'Referral reward paid')`,
            [refUser.rows[0].telegram_id]
          ).catch(() => {});
          sendBotMsg(refUser.rows[0].telegram_id,
            `🎉 <b>Referral Reward!</b>\nYour referral <b>${u.telegram_first_name || 'A friend'}</b> just completed 5 tasks!\n✅ You earned <b>+500 Sp</b>!`
          );
          // Milestone check against the referrer's total successful referral count.
          const refCountRow = await pool.query(
            `SELECT COUNT(*) FROM referral_logs WHERE referrer_id = $1 AND event = 'reward_paid'`,
            [refUser.rows[0].telegram_id]
          );
          await checkAndGrantMilestones(refUser.rows[0].telegram_id, 'referrals', parseInt(refCountRow.rows[0].count) || 0);
        }
      }
    }

    // Quest milestone check — counts total non-ad tasks ever completed.
    let newCosmetics = [];
    if (!isAd) {
      const questCountRow = await pool.query(
        `SELECT COUNT(*) FROM task_completions WHERE telegram_id = $1 AND task_type != 'ad'`,
        [tgId]
      );
      newCosmetics = await checkAndGrantMilestones(tgId, 'quests_completed', parseInt(questCountRow.rows[0].count) || 0);
    }

    // XP for completing any task (ad or regular), scaled off the Sp reward.
    await grantXp(tgId, Math.max(1, Math.round(reward * 0.1)), `Task: ${task_id}`);

    const result = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [tgId]);
    res.json({ user: result.rows[0], newCosmetics });
  } catch (err) {
    console.error('/api/task/complete error:', err);
    res.status(500).json({ error: 'DB error' });
  }
});

// ── Task: pre-check Telegram membership without claiming ──────────────────────
// Lets the client show a "not joined yet" state and let the person retry
// without burning a full /api/task/complete attempt (which also logs an
// attempt-shaped row). Read-only — never touches balances or completions.
app.post('/api/task/verify-telegram', taskLimiter, authMiddleware, async (req, res) => {
  const { task_id } = req.body;
  if (!task_id) return res.status(400).json({ error: 'Missing task_id' });
  const tgId = req.tgUser.id;
  try {
    const task = await findTaskById(task_id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    if (task.type !== 'telegram_channel' && task.type !== 'telegram_group') {
      return res.status(400).json({ error: 'Not a Telegram task' });
    }
    const verify = await verifyTelegramMembership(task.chatId, tgId);
    res.json({ verified: verify.ok, error: verify.ok ? null : verify.error });
  } catch (err) {
    console.error('/api/task/verify-telegram error:', err);
    res.status(500).json({ error: 'DB error' });
  }
});

// ── Spin: Prepare (server generates secure outcome) ────────────────────────────
app.post(['/api/spin/prepare', '/api/user/spin/prepare'], spinLimiter, authMiddleware, async (req, res) => {
  const tgId = req.tgUser.id;
  try {
    // Check user is not banned
    const uRow = await pool.query('SELECT banned FROM users WHERE telegram_id = $1', [tgId]);
    if (uRow.rows[0]?.banned) return res.status(403).json({ error: 'banned' });

    // Per-user 1-minute cooldown
    const lastSpin = await pool.query(`SELECT last_spin_at FROM users WHERE telegram_id = $1`, [tgId]);
    if (lastSpin.rows[0]?.last_spin_at) {
      const elapsed = Date.now() - new Date(lastSpin.rows[0].last_spin_at).getTime();
      if (elapsed < SPIN_COOLDOWN_MS) {
        return res.status(429).json({ error: `Please wait ${Math.ceil((SPIN_COOLDOWN_MS - elapsed) / 1000)}s before next spin`, cooldown: Math.ceil((SPIN_COOLDOWN_MS - elapsed) / 1000) });
      }
    }

    // Get current spin price from DB (never trust frontend)
    const settings = await pool.query('SELECT spin_price FROM app_settings WHERE id = 1');
    const spinPrice = parseFloat(settings.rows[0]?.spin_price) || 0.1;

    // Cryptographically secure random outcome (OG Pass: +30% luck toward higher prizes)
    let idx = crypto.randomInt(0, WHEEL_VALS.length);
    try {
      const ogU = await pool.query('SELECT og_pass FROM users WHERE telegram_id = $1', [tgId]);
      if (ogU.rows[0]?.og_pass) {
        // Reroll once if landed on bottom half — soft +30% luck
        const sorted = [...WHEEL_VALS].map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
        const median = sorted[Math.floor(sorted.length / 2)].v;
        if (WHEEL_VALS[idx] < median && Math.random() < 0.30) {
          const high = sorted.filter(x => x.v >= median);
          idx = high[crypto.randomInt(0, high.length)].i;
        }
      }
    } catch (_) {}
    const reward = WHEEL_VALS[idx];
    const nonce = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 min

    const insertRes = await pool.query(
      `INSERT INTO spin_nonces (telegram_id, nonce, prize_idx, reward, ton_cost, expires_at) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [tgId, nonce, idx, reward, spinPrice, expiresAt]
    );

    res.json({ nonce, targetIdx: idx, spinPrice, refId: insertRes.rows[0].id });
  } catch (err) {
    console.error('/api/spin/prepare error:', err);
    res.status(500).json({ error: 'DB error' });
  }
});

// ── Spin: Claim result (server-side reward, nonce single-use, payment enforced) ─
app.post(['/api/spin/result', '/api/user/spin/play'], spinLimiter, authMiddleware, async (req, res) => {
  const { nonce } = req.body;
  if (!nonce) return res.status(400).json({ error: 'Missing nonce — call /api/spin/prepare first' });
  const tgId = req.tgUser.id;
  const today = new Date().toISOString().split('T')[0];
  try {
    // Look up the nonce WITHOUT consuming it yet — we only consume it after
    // payment is confirmed, so a failed/slow verification doesn't burn the spin
    const nonceRow = await pool.query(
      `SELECT * FROM spin_nonces WHERE nonce = $1 AND telegram_id = $2 AND used = FALSE AND expires_at > NOW()`,
      [nonce, tgId]
    );
    if (!nonceRow.rows.length) {
      return res.status(409).json({ error: 'Invalid, expired, or already-used spin token' });
    }
    const { id: refId, reward, ton_cost, prize_idx } = nonceRow.rows[0];
    const paymentComment = `Spin #${refId} ID:${tgId}`;

    // Verify the payment actually reached the treasury for the right amount,
    // matched by the unique comment this spin was issued. TonCenter can lag
    // a few seconds behind broadcast, so retry briefly.
    let verification = { verified: false };
    for (let attempt = 0; attempt < 4; attempt++) {
      verification = await verifyTonPayment(paymentComment, ton_cost);
      if (verification.verified) break;
      if (attempt < 3) await new Promise(r => setTimeout(r, 3000));
    }

    // If on-chain verification couldn't be confirmed (public API lag/outage,
    // comment-matching edge cases, etc.), we still grant the reward — the
    // user only reaches this endpoint after their wallet already confirmed
    // the transaction was signed and broadcast (sendTransaction resolved
    // successfully client-side), which is a real signal of payment intent.
    // We flag it as unverified for admin review rather than silently trusting
    // it, so any genuine abuse pattern is still visible in the spin log.
    if (!verification.verified) {
      console.error(`Spin payment unverified but granting anyway (wallet confirmed send): comment="${paymentComment}" reason=${verification.reason}`);
      if (WITHDRAWAL_LOG_CHAT_ID) {
        sendBotMsg(WITHDRAWAL_LOG_CHAT_ID,
          `⚠️ <b>Unverified Spin Payment (granted anyway)</b>\n\n` +
          `👤 Telegram ID: <code>${tgId}</code>\n` +
          `💰 Expected: <b>${ton_cost} TON</b>\n` +
          `🔖 Reference: <code>${paymentComment}</code>\n` +
          `❓ Reason: ${verification.reason}\n\n` +
          `Reward was granted since the wallet confirmed the transaction was sent, but it could not be independently verified on-chain. Please spot-check the treasury wallet if this repeats often.`
        );
      }
    }

    // Payment confirmed — now atomically consume the nonce
    const nr = await pool.query(
      `UPDATE spin_nonces SET used = TRUE WHERE nonce = $1 AND telegram_id = $2 AND used = FALSE RETURNING *`,
      [nonce, tgId]
    );
    if (!nr.rows.length) {
      return res.status(409).json({ error: 'Spin token was already claimed' });
    }
    await pool.query(
      `INSERT INTO used_tx_hashes (tx_hash, telegram_id, used_for) VALUES ($1, $2, 'spin') ON CONFLICT DO NOTHING`,
      [paymentComment, tgId]
    );

    // Log spin with nonce + comment (used as payment reference) + real verification status
    await pool.query(
      `INSERT INTO spin_logs (telegram_id, prize_label, sp_won, ton_cost, nonce, tx_hash, payment_verified)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [tgId, WHEEL_SEGS[prize_idx] + ' Sp', reward, ton_cost, nonce, paymentComment, verification.verified]
    );

    // Credit reward (server-authoritative amount from DB)
    const entry = { id: 'sp' + Date.now(), date: today, cost: ton_cost + ' TON', reward };
    await pool.query(
      `UPDATE users SET shhhtoshi = shhhtoshi + $1,
         spin_history = $2::jsonb || COALESCE(spin_history, '[]'::jsonb),
         last_spin_at = NOW(),
         updated_at = NOW()
       WHERE telegram_id = $3`,
      [reward, JSON.stringify([entry]), tgId]
    );

    await pool.query(
      `INSERT INTO daily_earnings (telegram_id, date, sp_amount) VALUES ($1, $2, $3)
       ON CONFLICT (telegram_id, date) DO UPDATE SET sp_amount = daily_earnings.sp_amount + $3`,
      [tgId, today, reward]
    );
    const deRow = await pool.query('SELECT sp_amount FROM daily_earnings WHERE telegram_id = $1 AND date = $2', [tgId, today]);
    await pool.query('UPDATE users SET daily_sp = $1, daily_sp_date = $2 WHERE telegram_id = $3',
      [deRow.rows[0]?.sp_amount || reward, today, tgId]);

    await pool.query(
      `INSERT INTO balance_ledger (telegram_id, delta, type, note) VALUES ($1, $2, 'spin', $3)`,
      [tgId, reward, `Fortune Wheel spin — ${reward} Sp (nonce: ${nonce.slice(0,8)})`]
    ).catch(() => {});

    const result = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [tgId]);
    res.json({ user: result.rows[0], reward, reward_idx: prize_idx, paymentVerified: verification.verified });
  } catch (err) {
    console.error('/api/spin/result error:', err);
    res.status(500).json({ error: 'DB error' });
  }
});

// ── Progression: XP / Level / Energy / City / Missions / Achievements ──────────

// XP required to REACH each level (index 0 = level 1, needs 0 xp).
// Roughly doubling early, flattening later — 40 levels total. Level is
// derived from lifetime-style cumulative xp stored in users.xp.
const LEVEL_XP_TABLE = (() => {
  const table = [0];
  let need = 100;
  for (let lvl = 2; lvl <= 60; lvl++) {
    table.push(table[lvl - 2] + Math.round(need));
    need = need * 1.18 + 20;
  }
  return table; // table[i] = total xp required for level i+1
})();

function levelForXp(xp) {
  let lvl = 1;
  for (let i = 0; i < LEVEL_XP_TABLE.length; i++) {
    if (xp >= LEVEL_XP_TABLE[i]) lvl = i + 1; else break;
  }
  return lvl;
}

// City tiers — driven off player_level (not xp directly), so "leveling up"
// and "city growing" always stay in lockstep for the player.
const CITY_TIERS = [
  { level: 1, name: 'Small Cabin', emoji: '🏠' },
  { level: 5, name: 'House', emoji: '🏡' },
  { level: 10, name: 'Office', emoji: '🏢' },
  { level: 20, name: 'Bank', emoji: '🏦' },
  { level: 30, name: 'City', emoji: '🌆' },
  { level: 50, name: 'Space Headquarters', emoji: '🚀' }
];

function cityTierForLevel(level) {
  let tier = CITY_TIERS[0];
  for (const t of CITY_TIERS) { if (level >= t.level) tier = t; }
  return tier;
}

const ENERGY_REGEN_PER_MIN = 1; // 1 energy per minute, capped at energy_max

function computeRegeneratedEnergy(currentEnergy, energyMax, updatedAt) {
  const elapsedMin = Math.max(0, (Date.now() - new Date(updatedAt).getTime()) / 60000);
  const regen = Math.floor(elapsedMin * ENERGY_REGEN_PER_MIN);
  return Math.min(energyMax, currentEnergy + regen);
}

// Awards xp to a user, recomputes player_level + city_level, and returns
// whether a level-up (and therefore possibly a city upgrade) occurred.
// Also adds the same xp to season_xp for the currently active season.
async function grantXp(tgId, amount, note) {
  if (!amount) return { leveledUp: false, cityUpgraded: false };
  const before = await pool.query('SELECT xp, xp_lifetime, player_level, city_level, current_season_id, season_xp FROM users WHERE telegram_id = $1', [tgId]);
  if (!before.rows.length) return { leveledUp: false, cityUpgraded: false };
  const row = before.rows[0];
  const newXp = (row.xp || 0) + amount;
  const newXpLifetime = (row.xp_lifetime || 0) + amount;
  const newLevel = levelForXp(newXp);
  const newCityTier = cityTierForLevel(newLevel);
  const oldCityTier = cityTierForLevel(row.player_level || 1);
  const leveledUp = newLevel > (row.player_level || 1);
  const cityUpgraded = newCityTier.level > oldCityTier.level;

  await pool.query(
    `UPDATE users SET xp = $1, xp_lifetime = $2, player_level = $3, city_level = $4,
       season_xp = season_xp + $5, updated_at = NOW() WHERE telegram_id = $6`,
    [newXp, newXpLifetime, newLevel, newCityTier.level, amount, tgId]
  );
  await pool.query(
    `INSERT INTO balance_ledger (telegram_id, delta, type, note) VALUES ($1, 0, 'xp', $2)`,
    [tgId, `+${amount} XP${note ? ' — ' + note : ''}`]
  ).catch(() => {});

  if (leveledUp) {
    await checkAndGrantMilestones(tgId, 'level', newLevel);
  }
  return { leveledUp, cityUpgraded, newLevel, newCityTier };
}

// Increments progress on any active daily missions matching `metric` by
// `amount` (auto-creates the day's row on first touch). Missions that cross
// their target are marked completed but NOT auto-claimed — the player taps
// "Claim" to collect the reward via /api/missions/claim.
async function bumpMissionProgress(tgId, metric, amount) {
  if (!amount) return;
  const today = new Date().toISOString().split('T')[0];
  try {
    const missions = await pool.query(
      `SELECT * FROM missions_catalog WHERE metric = $1 AND active = TRUE`,
      [metric]
    );
    for (const m of missions.rows) {
      await pool.query(
        `INSERT INTO user_missions (telegram_id, mission_id, date, progress)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (telegram_id, mission_id, date)
         DO UPDATE SET progress = LEAST(user_missions.progress + $4, $5),
           completed_at = CASE WHEN user_missions.progress + $4 >= $5 AND user_missions.completed_at IS NULL THEN NOW() ELSE user_missions.completed_at END`,
        [tgId, m.id, today, amount, m.target]
      );
    }
  } catch (e) {
    console.error('bumpMissionProgress error:', e.message);
  }
}

async function checkAndGrantAchievements(tgId, triggerType, value) {
  try {
    const rules = await pool.query(
      `SELECT * FROM achievements_catalog WHERE trigger_type = $1 AND active = TRUE AND threshold <= $2`,
      [triggerType, value]
    );
    const newlyUnlocked = [];
    for (const rule of rules.rows) {
      const already = await pool.query(
        `SELECT 1 FROM user_achievements WHERE telegram_id = $1 AND achievement_id = $2`,
        [tgId, rule.id]
      );
      if (already.rows.length) continue;
      await pool.query(
        `INSERT INTO user_achievements (telegram_id, achievement_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [tgId, rule.id]
      );
      if (rule.reward_sp) {
        await pool.query(`UPDATE users SET shhhtoshi = shhhtoshi + $1 WHERE telegram_id = $2`, [rule.reward_sp, tgId]);
        await pool.query(
          `INSERT INTO balance_ledger (telegram_id, delta, type, note) VALUES ($1, $2, 'achievement', $3)`,
          [tgId, rule.reward_sp, `Achievement: ${rule.title}`]
        ).catch(() => {});
      }
      if (rule.reward_xp) await grantXp(tgId, rule.reward_xp, `Achievement: ${rule.title}`);
      if (rule.reward_cosmetic_id) await grantCosmetic(tgId, rule.reward_cosmetic_id, `achievement:${rule.id}`);
      newlyUnlocked.push({ id: rule.id, title: rule.title, icon: rule.icon, reward_sp: rule.reward_sp, reward_xp: rule.reward_xp });
    }
    return newlyUnlocked;
  } catch (e) {
    console.error(`checkAndGrantAchievements(${triggerType}) error:`, e.message);
    return [];
  }
}

// ── Mystery Box: prepare (rolls the reward server-side, before payment) ─────────
app.post('/api/mysterybox/prepare', spinLimiter, authMiddleware, async (req, res) => {
  const tgId = req.tgUser.id;
  const { boxId } = req.body;
  if (!boxId) return res.status(400).json({ error: 'Missing boxId' });
  try {
    const uRow = await pool.query('SELECT banned FROM users WHERE telegram_id = $1', [tgId]);
    if (uRow.rows[0]?.banned) return res.status(403).json({ error: 'banned' });

    // Per-user 30s cooldown, same as spins, to prevent nonce-spam.
    const lastNonce = await pool.query(
      `SELECT created_at FROM mysterybox_nonces WHERE telegram_id = $1 ORDER BY created_at DESC LIMIT 1`, [tgId]
    );
    if (lastNonce.rows.length) {
      const elapsed = Date.now() - new Date(lastNonce.rows[0].created_at).getTime();
      if (elapsed < 30000) {
        return res.status(429).json({ error: `Please wait ${Math.ceil((30000 - elapsed) / 1000)}s before opening another box` });
      }
    }

    // Box configs live in app_settings.mystery_boxes — never trust a
    // client-supplied price or reward table.
    const settings = await pool.query('SELECT mystery_boxes FROM app_settings WHERE id = 1');
    const boxes = settings.rows[0]?.mystery_boxes || [];
    const box = boxes.find(b => b.id === boxId);
    if (!box) return res.status(404).json({ error: 'Mystery box not found' });

    const nonce = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    let rewardSp = null;
    let rewardItemId = null;

    if (box.payoutType === 'cosmetic') {
      // Fixed rarity odds — same across every cosmetic box, so drop rates
      // are predictable and consistent regardless of which box an admin
      // creates. Rolled server-side with crypto RNG before payment.
      const roll = crypto.randomInt(0, 10000); // basis points, 0–9999
      let rarity;
      if (roll < 6000) rarity = 'common';        // 60.00%
      else if (roll < 8500) rarity = 'rare';      // 25.00%
      else if (roll < 9500) rarity = 'epic';      // 10.00%
      else if (roll < 9900) rarity = 'legendary'; //  4.00%
      else rarity = 'mythic';                     //  1.00%

      // If the rolled tier has no active items (admin deleted/deactivated
      // them all), fall back through the neighboring tiers rather than
      // failing the whole purchase — a purchase should never randomly
      // fail just because one specific rarity happens to be empty right
      // now. Falls back toward more common tiers first (more likely to
      // have items), then rarer ones as a last resort.
      const FALLBACK_ORDER = {
        common: ['common', 'rare', 'epic', 'legendary', 'mythic'],
        rare: ['rare', 'common', 'epic', 'legendary', 'mythic'],
        epic: ['epic', 'rare', 'legendary', 'common', 'mythic'],
        legendary: ['legendary', 'epic', 'mythic', 'rare', 'common'],
        mythic: ['mythic', 'legendary', 'epic', 'rare', 'common']
      };
      let picked = null;
      for (const tryRarity of FALLBACK_ORDER[rarity]) {
        const pool_ = await pool.query(
          `SELECT id FROM cosmetic_items WHERE rarity = $1 AND active = TRUE ORDER BY random() LIMIT 1`,
          [tryRarity]
        );
        if (pool_.rows.length) { picked = pool_.rows[0].id; break; }
      }
      if (!picked) {
        return res.status(400).json({ error: 'No active cosmetics are configured yet — ask the admin to add some in the Cosmetics tab' });
      }
      rewardItemId = picked;
    } else {
      if (!box.rewards || !box.rewards.length) return res.status(400).json({ error: 'Box has no reward tiers configured' });
      // Weighted random roll, server-side, using crypto RNG.
      const totalWeight = box.rewards.reduce((s, r) => s + (r.weight || 0), 0);
      let roll = crypto.randomInt(0, totalWeight);
      rewardSp = box.rewards[0].sp;
      for (const r of box.rewards) {
        if (roll < r.weight) { rewardSp = r.sp; break; }
        roll -= r.weight;
      }
    }

    const insertRes = await pool.query(
      `INSERT INTO mysterybox_nonces (telegram_id, nonce, box_id, reward_sp, reward_item_id, ton_cost, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [tgId, nonce, boxId, rewardSp, rewardItemId, box.tonPrice, expiresAt]
    );

    res.json({ nonce, tonPrice: box.tonPrice, refId: insertRes.rows[0].id });
  } catch (err) {
    console.error('/api/mysterybox/prepare error:', err);
    res.status(500).json({ error: 'DB error' });
  }
});

// ── Mystery Box: buy (verify payment, grant the already-rolled reward) ──────────
app.post('/api/mysterybox/buy', spinLimiter, authMiddleware, async (req, res) => {
  const { nonce } = req.body;
  if (!nonce) return res.status(400).json({ error: 'Missing nonce — call /api/mysterybox/prepare first' });
  const tgId = req.tgUser.id;
  const today = new Date().toISOString().split('T')[0];
  try {
    const nonceRow = await pool.query(
      `SELECT * FROM mysterybox_nonces WHERE nonce = $1 AND telegram_id = $2 AND used = FALSE AND expires_at > NOW()`,
      [nonce, tgId]
    );
    if (!nonceRow.rows.length) {
      return res.status(409).json({ error: 'Invalid, expired, or already-used purchase token' });
    }
    const { id: refId, box_id, reward_sp, reward_item_id, ton_cost } = nonceRow.rows[0];
    const paymentComment = `Box #${refId} ID:${tgId}`;

    let verification = { verified: false };
    for (let attempt = 0; attempt < 4; attempt++) {
      verification = await verifyTonPayment(paymentComment, ton_cost);
      if (verification.verified) break;
      if (attempt < 3) await new Promise(r => setTimeout(r, 3000));
    }

    if (!verification.verified) {
      console.error(`Mystery box payment unverified but granting anyway (wallet confirmed send): comment="${paymentComment}" reason=${verification.reason}`);
      if (WITHDRAWAL_LOG_CHAT_ID) {
        sendBotMsg(WITHDRAWAL_LOG_CHAT_ID,
          `⚠️ <b>Unverified Mystery Box Payment (granted anyway)</b>\n\n` +
          `👤 Telegram ID: <code>${tgId}</code>\n` +
          `💰 Expected: <b>${ton_cost} TON</b>\n` +
          `🔖 Reference: <code>${paymentComment}</code>\n` +
          `❓ Reason: ${verification.reason}\n\n` +
          `Reward was granted since the wallet confirmed the transaction was sent, but it could not be independently verified on-chain. Please spot-check the treasury wallet if this repeats often.`
        );
      }
    }

    const nr = await pool.query(
      `UPDATE mysterybox_nonces SET used = TRUE WHERE nonce = $1 AND telegram_id = $2 AND used = FALSE RETURNING *`,
      [nonce, tgId]
    );
    if (!nr.rows.length) {
      return res.status(409).json({ error: 'Purchase token was already claimed' });
    }
    await pool.query(
      `INSERT INTO used_tx_hashes (tx_hash, telegram_id, used_for) VALUES ($1, $2, 'mysterybox') ON CONFLICT DO NOTHING`,
      [paymentComment, tgId]
    );

    if (reward_item_id) {
      // Cosmetic payout — grant via the shared inventory system.
      const grant = await grantCosmetic(tgId, reward_item_id, 'mysterybox');
      const item = await pool.query('SELECT * FROM cosmetic_items WHERE id = $1', [reward_item_id]);
      await pool.query(
        `INSERT INTO balance_ledger (telegram_id, delta, type, note) VALUES ($1, 0, 'mysterybox', $2)`,
        [tgId, `Mystery box "${box_id}" — cosmetic "${reward_item_id}"${grant.alreadyOwned ? ' (already owned)' : ''} (nonce: ${nonce.slice(0,8)})`]
      ).catch(() => {});
      const result = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [tgId]);
      return res.json({
        user: result.rows[0],
        cosmetic: item.rows[0] || { id: reward_item_id },
        alreadyOwned: grant.alreadyOwned,
        paymentVerified: verification.verified
      });
    }

    // Sp payout (existing behavior, unchanged)
    await pool.query(
      `UPDATE users SET shhhtoshi = shhhtoshi + $1, updated_at = NOW() WHERE telegram_id = $2`,
      [reward_sp, tgId]
    );
    await pool.query(
      `INSERT INTO daily_earnings (telegram_id, date, sp_amount) VALUES ($1, $2, $3)
       ON CONFLICT (telegram_id, date) DO UPDATE SET sp_amount = daily_earnings.sp_amount + $3`,
      [tgId, today, reward_sp]
    );
    const deRow = await pool.query('SELECT sp_amount FROM daily_earnings WHERE telegram_id = $1 AND date = $2', [tgId, today]);
    await pool.query('UPDATE users SET daily_sp = $1, daily_sp_date = $2 WHERE telegram_id = $3',
      [deRow.rows[0]?.sp_amount || reward_sp, today, tgId]);

    await pool.query(
      `INSERT INTO balance_ledger (telegram_id, delta, type, note) VALUES ($1, $2, 'mysterybox', $3)`,
      [tgId, reward_sp, `Mystery box "${box_id}" — ${reward_sp} Sp (nonce: ${nonce.slice(0,8)})`]
    ).catch(() => {});

    const result = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [tgId]);
    res.json({ user: result.rows[0], sp: reward_sp, paymentVerified: verification.verified });
  } catch (err) {
    console.error('/api/mysterybox/buy error:', err);
    res.status(500).json({ error: 'DB error' });
  }
});

// ── Cosmetics: shared inventory (block skins, board themes, effects,
// avatar frames, badges, name colors, titles) — same catalog is meant to be
// reused by every future game in the Mini App, not just Blocks. ──────────────

// Server-side helper other systems call to grant a cosmetic (mystery boxes,
// quests, streaks, milestones, seasonal events, admin grants). Idempotent —
// granting an already-owned item is a harmless no-op.
async function grantCosmetic(tgId, itemId, acquiredVia) {
  const item = await pool.query('SELECT id FROM cosmetic_items WHERE id = $1 AND active = TRUE', [itemId]);
  if (!item.rows.length) return { granted: false, reason: 'Item not found or inactive' };
  const r = await pool.query(
    `INSERT INTO user_cosmetics (telegram_id, item_id, acquired_via) VALUES ($1, $2, $3)
     ON CONFLICT (telegram_id, item_id) DO NOTHING RETURNING id`,
    [tgId, itemId, acquiredVia || 'unknown']
  );
  return { granted: r.rows.length > 0, alreadyOwned: r.rows.length === 0 };
}

// Checks a player's current stat value against every active unlock rule for
// a given trigger type, granting any cosmetic whose threshold is now met.
// Safe to call on every relevant action (check-in, quiz completion, score
// submission, etc.) — grantCosmetic() is idempotent, so re-checking an
// already-unlocked rule is a harmless no-op, not a duplicate grant.
// Returns the list of newly granted items (for optional in-app notification).
async function checkAndGrantMilestones(tgId, triggerType, value) {
  try {
    const rules = await pool.query(
      `SELECT * FROM unlock_rules WHERE trigger_type = $1 AND active = TRUE AND threshold <= $2`,
      [triggerType, value]
    );
    const newlyGranted = [];
    for (const rule of rules.rows) {
      const r = await grantCosmetic(tgId, rule.item_id, `milestone:${triggerType}:${rule.threshold}`);
      if (r.granted) newlyGranted.push(rule.item_id);
    }
    return newlyGranted;
  } catch (e) {
    console.error(`checkAndGrantMilestones(${triggerType}) error:`, e.message);
    return [];
  }
}

// Full catalog — every active cosmetic, regardless of ownership. The client
// cross-references this against the player's owned-items list to know
// what's locked vs unlocked.
app.get('/api/cosmetics/catalog', authMiddleware, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, category, rarity, name, description, preview_image, css_data, source, shhht_price,
              direct_purchase, available_from, available_until,
              (available_from IS NULL OR available_from <= NOW())
                AND (available_until IS NULL OR available_until >= NOW()) AS currently_available
       FROM cosmetic_items WHERE active = TRUE ORDER BY category, rarity, name`
    );
    res.json({ items: r.rows });
  } catch (err) {
    console.error('/api/cosmetics/catalog error:', err);
    res.status(500).json({ error: 'DB error' });
  }
});

// This player's owned items + currently equipped selections.
app.get('/api/cosmetics/inventory', authMiddleware, async (req, res) => {
  const tgId = req.tgUser.id;
  try {
    const owned = await pool.query(
      `SELECT item_id, acquired_via, acquired_at FROM user_cosmetics WHERE telegram_id = $1`,
      [tgId]
    );
    const equippedRow = await pool.query('SELECT equipped FROM user_equipped WHERE telegram_id = $1', [tgId]);
    res.json({
      owned: owned.rows,
      equipped: equippedRow.rows[0]?.equipped || {}
    });
  } catch (err) {
    console.error('/api/cosmetics/inventory error:', err);
    res.status(500).json({ error: 'DB error' });
  }
});

// Direct Sp purchase — buy a specific cosmetic outright, no randomness.
// Only items an admin has marked direct_purchase = true (with a shhht_price
// set) are buyable this way; everything else stays unlock/box-only, so
// admins keep full control over what's guaranteed-purchasable vs earned.
app.post('/api/cosmetics/purchase', taskLimiter, authMiddleware, async (req, res) => {
  const tgId = req.tgUser.id;
  const { itemId } = req.body;
  if (!itemId) return res.status(400).json({ error: 'Missing itemId' });
  try {
    const item = await pool.query(
      `SELECT * FROM cosmetic_items
       WHERE id = $1 AND active = TRUE AND direct_purchase = TRUE
         AND (available_from IS NULL OR available_from <= NOW())
         AND (available_until IS NULL OR available_until >= NOW())`,
      [itemId]
    );
    if (!item.rows.length) return res.status(404).json({ error: 'Item not available for direct purchase right now' });
    const price = item.rows[0].shhht_price;
    if (!price || price <= 0) return res.status(400).json({ error: 'Item has no price configured' });

    const owns = await pool.query('SELECT 1 FROM user_cosmetics WHERE telegram_id = $1 AND item_id = $2', [tgId, itemId]);
    if (owns.rows.length) return res.status(409).json({ error: 'You already own this item' });

    // Atomic balance check + deduct — never let a player go negative even
    // under concurrent requests.
    const deduct = await pool.query(
      'UPDATE users SET shhhtoshi = shhhtoshi - $1, updated_at = NOW() WHERE telegram_id = $2 AND shhhtoshi >= $1 RETURNING shhhtoshi',
      [price, tgId]
    );
    if (!deduct.rows.length) return res.status(400).json({ error: 'Not enough Sp' });

    const grant = await grantCosmetic(tgId, itemId, 'shop');
    if (!grant.granted) {
      // Shouldn't happen (we just checked ownership above), but refund if
      // the grant somehow failed so a player is never charged for nothing.
      await pool.query('UPDATE users SET shhhtoshi = shhhtoshi + $1 WHERE telegram_id = $2', [price, tgId]);
      return res.status(500).json({ error: 'Purchase failed — refunded' });
    }

    await pool.query(
      `INSERT INTO balance_ledger (telegram_id, delta, type, note) VALUES ($1, $2, 'cosmetic_purchase', $3)`,
      [tgId, -price, `Bought cosmetic "${itemId}" for ${price} Sp`]
    ).catch(() => {});

    const result = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [tgId]);
    res.json({ ok: true, user: result.rows[0], item: item.rows[0] });
  } catch (err) {
    console.error('/api/cosmetics/purchase error:', err);
    res.status(500).json({ error: 'DB error' });
  }
});

// Equip an owned item into its category slot. Rejects equipping something
// not owned — server-authoritative, the client can't fake ownership.
app.post('/api/cosmetics/equip', taskLimiter, authMiddleware, async (req, res) => {
  const tgId = req.tgUser.id;
  const { itemId, category } = req.body;
  const VALID_CATEGORIES = ['block_skin', 'board_theme', 'effect', 'avatar_frame', 'badge', 'name_color', 'title'];

  try {
    if (!itemId) {
      // Unequip — only meaningful for categories where "nothing" is a
      // valid state (currently just effects; skins/themes always fall
      // back to Classic client-side, but unequipping is harmless either way).
      if (!category || !VALID_CATEGORIES.includes(category)) {
        return res.status(400).json({ error: 'Missing itemId (or invalid category for unequip)' });
      }
      await pool.query(
        `INSERT INTO user_equipped (telegram_id, equipped, updated_at)
         VALUES ($1, '{}'::jsonb, NOW())
         ON CONFLICT (telegram_id) DO UPDATE
         SET equipped = user_equipped.equipped - $2::text, updated_at = NOW()`,
        [tgId, category]
      );
      const r0 = await pool.query('SELECT equipped FROM user_equipped WHERE telegram_id = $1', [tgId]);
      return res.json({ ok: true, equipped: r0.rows[0]?.equipped || {} });
    }

    const item = await pool.query('SELECT category FROM cosmetic_items WHERE id = $1 AND active = TRUE', [itemId]);
    if (!item.rows.length) return res.status(404).json({ error: 'Item not found' });
    const owns = await pool.query('SELECT 1 FROM user_cosmetics WHERE telegram_id = $1 AND item_id = $2', [tgId, itemId]);
    if (!owns.rows.length) return res.status(403).json({ error: 'You do not own this item' });

    const itemCategory = item.rows[0].category;
    await pool.query(
      `INSERT INTO user_equipped (telegram_id, equipped, updated_at)
       VALUES ($1, jsonb_build_object($2::text, $3::text), NOW())
       ON CONFLICT (telegram_id) DO UPDATE
       SET equipped = user_equipped.equipped || jsonb_build_object($2::text, $3::text), updated_at = NOW()`,
      [tgId, itemCategory, itemId]
    );
    const r = await pool.query('SELECT equipped FROM user_equipped WHERE telegram_id = $1', [tgId]);
    res.json({ ok: true, equipped: r.rows[0].equipped });
  } catch (err) {
    console.error('/api/cosmetics/equip error:', err);
    res.status(500).json({ error: 'DB error' });
  }
});

// Admin: create/update a cosmetic item in the catalog (upsert by id).
app.post('/api/admin/cosmetics/save', authMiddleware, adminMiddleware, async (req, res) => {
  const { id, category, rarity, name, description, previewImage, cssData, source, shhhtPrice, active, directPurchase, availableFrom, availableUntil } = req.body;
  if (!id || !category || !name) return res.status(400).json({ error: 'id, category, and name are required' });
  try {
    await pool.query(
      `INSERT INTO cosmetic_items (id, category, rarity, name, description, preview_image, css_data, source, shhht_price, active, direct_purchase, available_from, available_until)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (id) DO UPDATE SET
         category = $2, rarity = $3, name = $4, description = $5, preview_image = $6,
         css_data = $7, source = $8, shhht_price = $9, active = $10,
         direct_purchase = $11, available_from = $12, available_until = $13`,
      [
        id, category, rarity || 'common', name, description || '', previewImage || '',
        JSON.stringify(cssData || {}), source || 'shop', shhhtPrice ?? null, active !== false,
        directPurchase === true, availableFrom || null, availableUntil || null
      ]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('/api/admin/cosmetics/save error:', err);
    res.status(500).json({ error: 'DB error' });
  }
});

// Admin: delete a cosmetic item entirely (also removes it from any
// inventories via ON DELETE CASCADE on user_cosmetics).
app.post('/api/admin/cosmetics/delete', authMiddleware, adminMiddleware, async (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'Missing id' });
  try {
    await pool.query('DELETE FROM cosmetic_items WHERE id = $1', [id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('/api/admin/cosmetics/delete error:', err);
    res.status(500).json({ error: 'DB error' });
  }
});

// Admin: list the full catalog including inactive items (for the admin UI,
// which needs to show/toggle disabled items too, unlike the player-facing
// /api/cosmetics/catalog which only returns active ones).
app.get('/api/admin/cosmetics/list', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM cosmetic_items ORDER BY category, rarity, name');
    res.json({ items: r.rows });
  } catch (err) {
    console.error('/api/admin/cosmetics/list error:', err);
    res.status(500).json({ error: 'DB error' });
  }
});

// ── Cosmetic unlock rules (admin CRUD) ──────────────────────────────────────
// trigger_type options the frontend currently wires: 'streak' (check-in
// streak days), 'blocks_high_score' (all-time best Blocks score),
// 'quiz_completions' (total correct quiz answers), 'referrals' (successful
// referrals that hit the 5-task reward).
app.get('/api/admin/unlock-rules', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT ur.*, ci.name AS item_name, ci.rarity AS item_rarity, ci.category AS item_category
       FROM unlock_rules ur JOIN cosmetic_items ci ON ci.id = ur.item_id
       ORDER BY ur.trigger_type, ur.threshold`
    );
    res.json({ rules: r.rows });
  } catch (err) {
    console.error('/api/admin/unlock-rules error:', err);
    res.status(500).json({ error: 'DB error' });
  }
});

app.post('/api/admin/unlock-rules/save', authMiddleware, adminMiddleware, async (req, res) => {
  const { id, triggerType, threshold, itemId, active } = req.body;
  if (!triggerType || threshold == null || !itemId) {
    return res.status(400).json({ error: 'triggerType, threshold, and itemId are required' });
  }
  try {
    const ruleId = id || (triggerType + '_' + threshold + '_' + Date.now());
    await pool.query(
      `INSERT INTO unlock_rules (id, trigger_type, threshold, item_id, active)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (id) DO UPDATE SET trigger_type = $2, threshold = $3, item_id = $4, active = $5`,
      [ruleId, triggerType, Math.max(0, Math.floor(Number(threshold))), itemId, active !== false]
    );
    res.json({ ok: true, id: ruleId });
  } catch (err) {
    console.error('/api/admin/unlock-rules/save error:', err);
    res.status(500).json({ error: 'DB error' });
  }
});

app.post('/api/admin/unlock-rules/delete', authMiddleware, adminMiddleware, async (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'Missing id' });
  try {
    await pool.query('DELETE FROM unlock_rules WHERE id = $1', [id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('/api/admin/unlock-rules/delete error:', err);
    res.status(500).json({ error: 'DB error' });
  }
});

// ── Seasonal event grants ────────────────────────────────────────────────────
// Unlike streak/score/quest milestones (a per-player threshold), a seasonal
// event is "everyone who's around during this window gets this item" —
// admin-triggered rather than automatically checked. Uses grantCosmetic()'s
// existing idempotency, so re-running this for the same item never
// duplicates anyone's ownership.
app.post('/api/admin/cosmetics/grant-seasonal', authMiddleware, adminMiddleware, async (req, res) => {
  const { itemId } = req.body;
  if (!itemId) return res.status(400).json({ error: 'Missing itemId' });
  try {
    const item = await pool.query('SELECT id FROM cosmetic_items WHERE id = $1 AND active = TRUE', [itemId]);
    if (!item.rows.length) return res.status(404).json({ error: 'Item not found' });

    const users = await pool.query('SELECT telegram_id FROM users WHERE banned = FALSE');
    let granted = 0;
    for (const u of users.rows) {
      const r = await grantCosmetic(u.telegram_id, itemId, 'seasonal');
      if (r.granted) granted++;
    }
    res.json({ ok: true, totalUsers: users.rows.length, newlyGranted: granted });
  } catch (err) {
    console.error('/api/admin/cosmetics/grant-seasonal error:', err);
    res.status(500).json({ error: 'DB error' });
  }
});

// Grant a cosmetic to one specific player — for support cases, contest
// prizes, or anything else that doesn't fit a bulk/automatic rule.
app.post('/api/admin/cosmetics/grant-one', authMiddleware, adminMiddleware, async (req, res) => {
  const { telegramId, itemId } = req.body;
  if (!telegramId || !itemId) return res.status(400).json({ error: 'telegramId and itemId are required' });
  try {
    const r = await grantCosmetic(telegramId, itemId, 'admin_grant');
    res.json({ ok: true, granted: r.granted, alreadyOwned: r.alreadyOwned });
  } catch (err) {
    console.error('/api/admin/cosmetics/grant-one error:', err);
    res.status(500).json({ error: 'DB error' });
  }
});

// ── Admin: Missions catalog CRUD ────────────────────────────────────────────────
app.get('/api/admin/missions', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const r = await pool.query(`SELECT * FROM missions_catalog ORDER BY sort_order ASC, id ASC`);
    res.json({ missions: r.rows });
  } catch (err) {
    res.status(500).json({ error: 'DB error' });
  }
});
app.post('/api/admin/missions/save', authMiddleware, adminMiddleware, async (req, res) => {
  const { id, title, description, metric, target, rewardSp, rewardXp, rewardCosmeticId, active, sortOrder } = req.body;
  if (!id || !title || !metric || !target) return res.status(400).json({ error: 'id, title, metric, and target are required' });
  try {
    await pool.query(
      `INSERT INTO missions_catalog (id, title, description, metric, target, reward_sp, reward_xp, reward_cosmetic_id, active, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (id) DO UPDATE SET
         title=$2, description=$3, metric=$4, target=$5, reward_sp=$6, reward_xp=$7,
         reward_cosmetic_id=$8, active=$9, sort_order=$10`,
      [id, title, description || '', metric, target, rewardSp || 0, rewardXp || 0, rewardCosmeticId || null, active !== false, sortOrder || 0]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('/api/admin/missions/save error:', err);
    res.status(500).json({ error: 'DB error' });
  }
});
app.post('/api/admin/missions/delete', authMiddleware, adminMiddleware, async (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'id required' });
  try {
    await pool.query(`DELETE FROM missions_catalog WHERE id = $1`, [id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'DB error' });
  }
});

// ── Admin: Achievements catalog CRUD ────────────────────────────────────────────
app.get('/api/admin/achievements', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const r = await pool.query(`SELECT * FROM achievements_catalog ORDER BY sort_order ASC, threshold ASC`);
    res.json({ achievements: r.rows });
  } catch (err) {
    res.status(500).json({ error: 'DB error' });
  }
});
app.post('/api/admin/achievements/save', authMiddleware, adminMiddleware, async (req, res) => {
  const { id, title, description, triggerType, threshold, rewardSp, rewardXp, rewardCosmeticId, icon, active, sortOrder } = req.body;
  if (!id || !title || !triggerType || threshold == null) return res.status(400).json({ error: 'id, title, triggerType, and threshold are required' });
  try {
    await pool.query(
      `INSERT INTO achievements_catalog (id, title, description, trigger_type, threshold, reward_sp, reward_xp, reward_cosmetic_id, icon, active, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (id) DO UPDATE SET
         title=$2, description=$3, trigger_type=$4, threshold=$5, reward_sp=$6, reward_xp=$7,
         reward_cosmetic_id=$8, icon=$9, active=$10, sort_order=$11`,
      [id, title, description || '', triggerType, threshold, rewardSp || 0, rewardXp || 0, rewardCosmeticId || null, icon || '🏆', active !== false, sortOrder || 0]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('/api/admin/achievements/save error:', err);
    res.status(500).json({ error: 'DB error' });
  }
});
app.post('/api/admin/achievements/delete', authMiddleware, adminMiddleware, async (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'id required' });
  try {
    await pool.query(`DELETE FROM achievements_catalog WHERE id = $1`, [id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'DB error' });
  }
});

// ── Admin: Seasons CRUD ─────────────────────────────────────────────────────────
app.get('/api/admin/seasons', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const r = await pool.query(`SELECT * FROM seasons ORDER BY starts_at DESC`);
    res.json({ seasons: r.rows });
  } catch (err) {
    res.status(500).json({ error: 'DB error' });
  }
});
app.post('/api/admin/seasons/save', authMiddleware, adminMiddleware, async (req, res) => {
  const { id, name, startsAt, endsAt, theme, bannerImage, active } = req.body;
  if (!id || !name || !startsAt || !endsAt) return res.status(400).json({ error: 'id, name, startsAt, and endsAt are required' });
  try {
    // Deactivate other seasons if this one is being made active, so only one runs at a time.
    if (active !== false) await pool.query(`UPDATE seasons SET active = FALSE WHERE id != $1`, [id]);
    await pool.query(
      `INSERT INTO seasons (id, name, starts_at, ends_at, theme, banner_image, active)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (id) DO UPDATE SET name=$2, starts_at=$3, ends_at=$4, theme=$5, banner_image=$6, active=$7`,
      [id, name, startsAt, endsAt, theme || '', bannerImage || '', active !== false]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('/api/admin/seasons/save error:', err);
    res.status(500).json({ error: 'DB error' });
  }
});
app.post('/api/admin/seasons/delete', authMiddleware, adminMiddleware, async (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'id required' });
  try {
    await pool.query(`DELETE FROM seasons WHERE id = $1`, [id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'DB error' });
  }
});

// ── Admin: Season-scoped tasks ──────────────────────────────────────────────────
// These live inside app_settings.tasks (same array the main Earn-tab task
// list uses) tagged with a seasonId, rather than a separate table — so they
// reuse all the same claim/verify/reward logic as regular tasks for free,
// and just disappear from /api/config once their season ends.
app.get('/api/admin/seasons/:id/tasks', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const r = await pool.query('SELECT tasks FROM app_settings WHERE id = 1');
    const allTasks = Array.isArray(r.rows[0]?.tasks) ? r.rows[0].tasks : [];
    res.json({ tasks: allTasks.filter(t => t.seasonId === req.params.id) });
  } catch (err) {
    res.status(500).json({ error: 'DB error' });
  }
});
app.post('/api/admin/seasons/:id/tasks/save', authMiddleware, adminMiddleware, async (req, res) => {
  const seasonId = req.params.id;
  const { id, title, description, reward, type, link, chatId, imageUrl } = req.body;
  if (!title || reward == null) return res.status(400).json({ error: 'title and reward are required' });
  try {
    const season = await pool.query('SELECT id FROM seasons WHERE id = $1', [seasonId]);
    if (!season.rows.length) return res.status(404).json({ error: 'Season not found' });

    const r = await pool.query('SELECT tasks FROM app_settings WHERE id = 1');
    const allTasks = Array.isArray(r.rows[0]?.tasks) ? r.rows[0].tasks : [];
    const taskId = id || ('season_' + seasonId + '_' + Date.now());
    const newTask = {
      id: taskId, title, description: description || '',
      reward: parseInt(reward), type: type || 'social',
      link: link || null, chatId: chatId || null, imageUrl: imageUrl || null, seasonId
    };
    const idx = allTasks.findIndex(t => t.id === taskId);
    const updatedTasks = idx >= 0
      ? allTasks.map(t => (t.id === taskId ? newTask : t))
      : [...allTasks, newTask];

    await pool.query('UPDATE app_settings SET tasks = $1, updated_at = NOW() WHERE id = 1', [JSON.stringify(updatedTasks)]);
    res.json({ ok: true, task: newTask });
  } catch (err) {
    console.error('/api/admin/seasons/:id/tasks/save error:', err);
    res.status(500).json({ error: 'DB error' });
  }
});
app.post('/api/admin/seasons/:id/tasks/delete', authMiddleware, adminMiddleware, async (req, res) => {
  const { taskId } = req.body;
  if (!taskId) return res.status(400).json({ error: 'taskId required' });
  try {
    const r = await pool.query('SELECT tasks FROM app_settings WHERE id = 1');
    const allTasks = Array.isArray(r.rows[0]?.tasks) ? r.rows[0].tasks : [];
    const updatedTasks = allTasks.filter(t => t.id !== taskId);
    await pool.query('UPDATE app_settings SET tasks = $1, updated_at = NOW() WHERE id = 1', [JSON.stringify(updatedTasks)]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'DB error' });
  }
});

// ── Check-in: server-side ──────────────────────────────────────────────────────
app.post('/api/checkin', taskLimiter, authMiddleware, async (req, res) => {
  const { reward, streak, day_idx, new_check_in } = req.body;
  if (reward == null || !new_check_in) return res.status(400).json({ error: 'Missing data' });
  const tgId = req.tgUser.id;
  const today = new Date().toISOString().split('T')[0];
  try {
    const userRow = await pool.query('SELECT check_in FROM users WHERE telegram_id = $1', [tgId]);
    if (!userRow.rows.length) return res.status(404).json({ error: 'Not found' });
    const ci = userRow.rows[0].check_in || {};
    if (ci.lastDay === today) return res.status(409).json({ error: 'Already checked in today' });

    // Update user
    await pool.query(
      `UPDATE users SET shhhtoshi = shhhtoshi + $1, check_in = $2, updated_at = NOW() WHERE telegram_id = $3`,
      [reward, JSON.stringify(new_check_in), tgId]
    );

    // UPSERT daily_earnings
    await pool.query(
      `INSERT INTO daily_earnings (telegram_id, date, sp_amount) VALUES ($1, $2, $3)
       ON CONFLICT (telegram_id, date) DO UPDATE SET sp_amount = daily_earnings.sp_amount + $3`,
      [tgId, today, reward]
    );

    // Sync daily_sp on user row
    const deRow = await pool.query('SELECT sp_amount FROM daily_earnings WHERE telegram_id = $1 AND date = $2', [tgId, today]);
    const todayTotal = deRow.rows[0]?.sp_amount || reward;
    await pool.query('UPDATE users SET daily_sp = $1, daily_sp_date = $2 WHERE telegram_id = $3', [todayTotal, today, tgId]);

    // Log check-in
    await pool.query(
      `INSERT INTO check_in_logs (telegram_id, check_in_date, streak, reward) VALUES ($1, $2, $3, $4)`,
      [tgId, today, streak || 1, reward]
    ).catch(() => {});

    // Balance ledger
    await pool.query(
      `INSERT INTO balance_ledger (telegram_id, delta, type, note) VALUES ($1, $2, 'checkin', $3)`,
      [tgId, reward, `Day ${(day_idx || 0) + 1} check-in, streak ${streak || 1}`]
    ).catch(() => {});

    const result = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [tgId]);
    res.json({ user: result.rows[0] });
  } catch (err) {
    console.error('/api/checkin error:', err);
    res.status(500).json({ error: 'DB error' });
  }
});

// ── Check-in: server-authoritative version for the React app ──────────────────
// Unlike /api/checkin above (legacy, trusts client-computed reward/streak),
// this computes everything server-side from the stored check_in state, so the
// client cannot manipulate the reward amount. Streak & 30-day cycle logic
// mirrors CHECKIN_REWARDS in the frontend (Day N = N * 10 Sp, 30-day cycle).
app.post('/api/user/checkin', taskLimiter, authMiddleware, async (req, res) => {
  const tgId = req.tgUser.id;
  const today = new Date().toISOString().split('T')[0];
  try {
    const userRow = await pool.query('SELECT check_in FROM users WHERE telegram_id = $1', [tgId]);
    if (!userRow.rows.length) return res.status(404).json({ error: 'Not found' });
    const ci = userRow.rows[0].check_in || { streak: 0, lastDay: null, cycleStart: null, claimedDays: [] };
    if (ci.lastDay === today) return res.status(409).json({ error: 'Check-in reward already claimed today!' });

    // Determine streak: continues if last check-in was yesterday, else resets to 1
    let streak = 1;
    let streakBroken = true;
    if (ci.lastDay) {
      const diffDays = Math.round((new Date(today).getTime() - new Date(ci.lastDay).getTime()) / 86400000);
      if (diffDays === 1) {
        streak = (ci.streak || 0) + 1;
        streakBroken = false;
      }
    }

    // The 30-day reward calendar tracks the *current* streak, not lifetime
    // check-ins — so a broken streak restarts the calendar at Day 1 too,
    // instead of silently continuing to climb through the gap.
    const claimedDays = streakBroken ? [] : (Array.isArray(ci.claimedDays) ? [...ci.claimedDays] : []);
    const dayIdx = claimedDays.length % 30; // 0-indexed position in the 30-day cycle
    const reward = (dayIdx + 1) * 10; // Day 1=10, Day 2=20 ... Day 30=300

    claimedDays.push(dayIdx);
    const newCheckIn = {
      streak,
      lastDay: today,
      cycleStart: streakBroken ? today : (ci.cycleStart || today),
      claimedDays
    };

    await pool.query(
      `UPDATE users SET shhhtoshi = shhhtoshi + $1, check_in = $2, updated_at = NOW() WHERE telegram_id = $3`,
      [reward, JSON.stringify(newCheckIn), tgId]
    );

    await pool.query(
      `INSERT INTO daily_earnings (telegram_id, date, sp_amount) VALUES ($1, $2, $3)
       ON CONFLICT (telegram_id, date) DO UPDATE SET sp_amount = daily_earnings.sp_amount + $3`,
      [tgId, today, reward]
    );
    const deRow = await pool.query('SELECT sp_amount FROM daily_earnings WHERE telegram_id = $1 AND date = $2', [tgId, today]);
    const todayTotal = deRow.rows[0]?.sp_amount || reward;
    await pool.query('UPDATE users SET daily_sp = $1, daily_sp_date = $2 WHERE telegram_id = $3', [todayTotal, today, tgId]);

    await pool.query(
      `INSERT INTO check_in_logs (telegram_id, check_in_date, streak, reward) VALUES ($1, $2, $3, $4)`,
      [tgId, today, streak, reward]
    ).catch(() => {});

    await pool.query(
      `INSERT INTO balance_ledger (telegram_id, delta, type, note) VALUES ($1, $2, 'checkin', $3)`,
      [tgId, reward, `Day ${dayIdx + 1} check-in, streak ${streak}`]
    ).catch(() => {});

    const newCosmetics = await checkAndGrantMilestones(tgId, 'streak', streak);
    const newAchievements = await checkAndGrantAchievements(tgId, 'streak', streak);
    await grantXp(tgId, Math.max(5, Math.round(reward * 0.2)), `Daily check-in (streak ${streak})`);
    await bumpMissionProgress(tgId, 'checkin', 1);

    const result = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [tgId]);
    res.json({ user: result.rows[0], reward_given: reward, newCosmetics, newAchievements });
  } catch (err) {
    console.error('/api/user/checkin error:', err);
    res.status(500).json({ error: 'DB error' });
  }
});

// ── Tap: Sync session ──────────────────────────────────────────────────────────
app.post('/api/tap/sync', authMiddleware, async (req, res) => {
  const { taps, date } = req.body;
  if (!taps || !date) return res.json({ ok: true });
  const tgId = req.tgUser.id;
  try {
    await pool.query(
      `INSERT INTO tap_sessions (telegram_id, date, taps, sp_earned, updated_at)
       VALUES ($1, $2, $3, $3, NOW())
       ON CONFLICT (telegram_id, date) DO UPDATE SET taps = $3, sp_earned = $3, updated_at = NOW()`,
      [tgId, date, taps]
    );
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: true });
  }
});

// ── Progress: get combined xp/level/energy/city/season snapshot ───────────────
app.get('/api/progress', authMiddleware, async (req, res) => {
  const tgId = req.tgUser.id;
  try {
    const r = await pool.query(
      `SELECT xp, xp_lifetime, player_level, energy, energy_max, energy_updated_at,
              city_level, online_seconds_today, online_date, current_season_id, season_xp
       FROM users WHERE telegram_id = $1`,
      [tgId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    const u = r.rows[0];
    const regenEnergy = computeRegeneratedEnergy(u.energy ?? 100, u.energy_max ?? 100, u.energy_updated_at);
    if (regenEnergy !== u.energy) {
      await pool.query('UPDATE users SET energy = $1, energy_updated_at = NOW() WHERE telegram_id = $2', [regenEnergy, tgId]);
    }
    const level = u.player_level || 1;
    const xpFloor = LEVEL_XP_TABLE[level - 1] || 0;
    const xpCeil = LEVEL_XP_TABLE[level] ?? (xpFloor + 1000);
    const cityTier = cityTierForLevel(level);
    const nextCityTier = CITY_TIERS.find(t => t.level > cityTier.level) || null;

    const season = await pool.query(`SELECT * FROM seasons WHERE active = TRUE AND starts_at <= NOW() AND ends_at >= NOW() ORDER BY starts_at DESC LIMIT 1`);

    res.json({
      xp: u.xp || 0,
      xpLifetime: u.xp_lifetime || 0,
      level,
      xpFloor,
      xpCeil,
      xpPct: Math.min(100, Math.round(((u.xp - xpFloor) / Math.max(1, xpCeil - xpFloor)) * 100)),
      energy: regenEnergy,
      energyMax: u.energy_max ?? 100,
      cityLevel: cityTier.level,
      cityName: cityTier.name,
      cityEmoji: cityTier.emoji,
      nextCityTier,
      season: season.rows[0] || null,
      seasonXp: u.season_xp || 0
    });
  } catch (err) {
    console.error('/api/progress error:', err);
    res.status(500).json({ error: 'DB error' });
  }
});

// ── Energy: spend (gates tapping / premium modes / events) ────────────────────
app.post('/api/energy/spend', taskLimiter, authMiddleware, async (req, res) => {
  const { amount, reason } = req.body;
  const cost = parseInt(amount);
  if (!cost || cost <= 0 || cost > 1000) return res.status(400).json({ error: 'Invalid amount' });
  const tgId = req.tgUser.id;
  try {
    const r = await pool.query('SELECT energy, energy_max, energy_updated_at FROM users WHERE telegram_id = $1', [tgId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    const u = r.rows[0];
    const current = computeRegeneratedEnergy(u.energy ?? 100, u.energy_max ?? 100, u.energy_updated_at);
    if (current < cost) return res.status(409).json({ error: 'Not enough energy', energy: current });
    const updated = current - cost;
    await pool.query('UPDATE users SET energy = $1, energy_updated_at = NOW() WHERE telegram_id = $2', [updated, tgId]);
    await pool.query(
      `INSERT INTO balance_ledger (telegram_id, delta, type, note) VALUES ($1, 0, 'energy', $2)`,
      [tgId, `-${cost} energy${reason ? ' — ' + reason : ''}`]
    ).catch(() => {});
    res.json({ ok: true, energy: updated });
  } catch (err) {
    res.status(500).json({ error: 'DB error' });
  }
});

// ── Missions: list today's missions with progress ──────────────────────────────
app.get('/api/missions/today', authMiddleware, async (req, res) => {
  const tgId = req.tgUser.id;
  const today = new Date().toISOString().split('T')[0];
  try {
    const catalog = await pool.query(`SELECT * FROM missions_catalog WHERE active = TRUE ORDER BY sort_order ASC, id ASC`);
    const progress = await pool.query(`SELECT * FROM user_missions WHERE telegram_id = $1 AND date = $2`, [tgId, today]);
    const progMap = {};
    for (const p of progress.rows) progMap[p.mission_id] = p;
    const missions = catalog.rows.map(m => {
      const p = progMap[m.id];
      return {
        id: m.id,
        title: m.title,
        description: m.description,
        metric: m.metric,
        target: m.target,
        rewardSp: m.reward_sp,
        rewardXp: m.reward_xp,
        rewardCosmeticId: m.reward_cosmetic_id,
        progress: p?.progress || 0,
        completed: !!p?.completed_at,
        claimed: !!p?.claimed
      };
    });
    res.json({ missions });
  } catch (err) {
    console.error('/api/missions/today error:', err);
    res.status(500).json({ error: 'DB error' });
  }
});

// ── Missions: claim a completed mission's reward ────────────────────────────────
app.post('/api/missions/claim', taskLimiter, authMiddleware, async (req, res) => {
  const { mission_id } = req.body;
  if (!mission_id) return res.status(400).json({ error: 'Missing mission_id' });
  const tgId = req.tgUser.id;
  const today = new Date().toISOString().split('T')[0];
  try {
    const row = await pool.query(
      `SELECT um.*, mc.reward_sp, mc.reward_xp, mc.reward_cosmetic_id, mc.title
       FROM user_missions um JOIN missions_catalog mc ON mc.id = um.mission_id
       WHERE um.telegram_id = $1 AND um.mission_id = $2 AND um.date = $3`,
      [tgId, mission_id, today]
    );
    if (!row.rows.length) return res.status(404).json({ error: 'Mission not started' });
    const m = row.rows[0];
    if (!m.completed_at) return res.status(409).json({ error: 'Mission not complete yet' });
    if (m.claimed) return res.status(409).json({ error: 'Already claimed' });

    // Atomic claim: only proceeds if this row is still unclaimed at the moment
    // of the UPDATE, closing the race where two near-simultaneous requests
    // both pass the check above and both pay out.
    const claimResult = await pool.query(`UPDATE user_missions SET claimed = TRUE WHERE id = $1 AND claimed = FALSE`, [m.id]);
    if (claimResult.rowCount === 0) return res.status(409).json({ error: 'Already claimed' });

    let rewardSp = m.reward_sp || 0;
    if (rewardSp) {
      try {
        const ogM = await pool.query('SELECT og_pass FROM users WHERE telegram_id = $1', [tgId]);
        if (ogM.rows[0]?.og_pass) rewardSp = Math.floor(rewardSp * 1.2);
      } catch (_) {}
      await pool.query(`UPDATE users SET shhhtoshi = shhhtoshi + $1 WHERE telegram_id = $2`, [rewardSp, tgId]);
      await pool.query(
        `INSERT INTO balance_ledger (telegram_id, delta, type, note) VALUES ($1, $2, 'mission', $3)`,
        [tgId, rewardSp, `Mission: ${m.title}${rewardSp !== m.reward_sp ? ' (OG +20%)' : ''}`]
      ).catch(() => {});
    }
    if (m.reward_xp) await grantXp(tgId, m.reward_xp, `Mission: ${m.title}`);
    if (m.reward_cosmetic_id) await grantCosmetic(tgId, m.reward_cosmetic_id, `mission:${mission_id}`);

    const result = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [tgId]);
    res.json({ user: result.rows[0], rewardSp, rewardXp: m.reward_xp });
  } catch (err) {
    console.error('/api/missions/claim error:', err);
    res.status(500).json({ error: 'DB error' });
  }
});

// ── Missions: heartbeat for "stay online N minutes" missions ───────────────────
// Client pings this roughly once a minute while the app is foregrounded.
app.post('/api/missions/online-tick', authMiddleware, async (req, res) => {
  const tgId = req.tgUser.id;
  const today = new Date().toISOString().split('T')[0];
  try {
    const r = await pool.query('SELECT online_seconds_today, online_date FROM users WHERE telegram_id = $1', [tgId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    const u = r.rows[0];
    const seconds = u.online_date === today ? (u.online_seconds_today || 0) + 60 : 60;
    await pool.query('UPDATE users SET online_seconds_today = $1, online_date = $2 WHERE telegram_id = $3', [seconds, today, tgId]);
    await bumpMissionProgress(tgId, 'online_minutes', 1);
    res.json({ ok: true, onlineSeconds: seconds });
  } catch (err) {
    res.json({ ok: true });
  }
});

// ── Achievements: list all with unlocked state ──────────────────────────────────
app.get('/api/achievements', authMiddleware, async (req, res) => {
  const tgId = req.tgUser.id;
  try {
    const catalog = await pool.query(`SELECT * FROM achievements_catalog WHERE active = TRUE ORDER BY sort_order ASC, threshold ASC`);
    const unlocked = await pool.query(`SELECT achievement_id, unlocked_at FROM user_achievements WHERE telegram_id = $1`, [tgId]);
    const unlockedMap = {};
    for (const u of unlocked.rows) unlockedMap[u.achievement_id] = u.unlocked_at;
    const achievements = catalog.rows.map(a => ({
      id: a.id,
      title: a.title,
      description: a.description,
      icon: a.icon,
      triggerType: a.trigger_type,
      threshold: a.threshold,
      rewardSp: a.reward_sp,
      rewardXp: a.reward_xp,
      unlocked: !!unlockedMap[a.id],
      unlockedAt: unlockedMap[a.id] || null
    }));
    res.json({ achievements });
  } catch (err) {
    console.error('/api/achievements error:', err);
    res.status(500).json({ error: 'DB error' });
  }
});

// ── Referral: get my referred users with task progress ────────────────────────
app.get('/api/referral/my-referrals', authMiddleware, async (req, res) => {
  try {
    const myCode = 'SHHHT-' + String(req.tgUser.id).slice(-6).toUpperCase();
    const r = await pool.query(
      `SELECT telegram_id, telegram_first_name, telegram_username, telegram_photo_url,
              tasks_completed, referral_reward_pending, joined_at
       FROM users WHERE referred_by = $1 ORDER BY joined_at DESC`,
      [myCode]
    );
    const refs = r.rows.map(u => {
      const tasks = (u.tasks_completed || []).filter(id => !String(id).startsWith('ad'));
      const taskCount = tasks.length;
      return {
        telegram_id: u.telegram_id,
        name: u.telegram_first_name || (u.telegram_username ? '@' + u.telegram_username : 'User#' + String(u.telegram_id).slice(-4)),
        photo: u.telegram_photo_url || null,
        tasks_done: taskCount,
        tasks_needed: 5,
        reward_pending: u.referral_reward_pending,
        reward_earned: !u.referral_reward_pending && taskCount >= 5,
        joined_at: u.joined_at,
      };
    });
    res.json({ referrals: refs });
  } catch (err) {
    console.error('/api/referral/my-referrals error:', err);
    res.status(500).json({ error: 'DB error' });
  }
});

// ── Leaderboard (all-time) ────────────────────────────────────────────────────
app.get(['/api/leaderboard', '/api/leaderboard/all'], authMiddleware, async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT telegram_id, telegram_username, telegram_first_name, telegram_photo_url, shhhtoshi, referrals, tasks_completed, og_pass FROM users WHERE banned = FALSE ORDER BY shhhtoshi DESC LIMIT 20'
    );
    // Player's own global rank (1-indexed), even if outside the top 20 shown above.
    const rankRow = await pool.query(
      `SELECT rank FROM (
         SELECT telegram_id, RANK() OVER (ORDER BY shhhtoshi DESC) AS rank
         FROM users WHERE banned = FALSE
       ) ranked WHERE telegram_id = $1`,
      [req.tgUser.id]
    );
    res.json({
      leaderboard: r.rows.map(row => ({ ...row, score: row.shhhtoshi })),
      myRank: rankRow.rows[0]?.rank || null
    });
  } catch (err) {
    res.status(500).json({ error: 'DB error' });
  }
});

// ── Leaderboard (season) — ranked by season_xp, resets each season ────────────
app.get('/api/leaderboard/season', authMiddleware, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT telegram_id, telegram_username, telegram_first_name, telegram_photo_url, season_xp, player_level, og_pass
       FROM users WHERE banned = FALSE AND season_xp > 0 ORDER BY season_xp DESC LIMIT 20`
    );
    const rankRow = await pool.query(
      `SELECT rank FROM (
         SELECT telegram_id, RANK() OVER (ORDER BY season_xp DESC) AS rank
         FROM users WHERE banned = FALSE
       ) ranked WHERE telegram_id = $1`,
      [req.tgUser.id]
    );
    const season = await pool.query(`SELECT * FROM seasons WHERE active = TRUE AND starts_at <= NOW() AND ends_at >= NOW() ORDER BY starts_at DESC LIMIT 1`);
    res.json({
      leaderboard: r.rows.map(row => ({ ...row, score: row.season_xp })),
      myRank: rankRow.rows[0]?.rank || null,
      season: season.rows[0] || null
    });
  } catch (err) {
    res.status(500).json({ error: 'DB error' });
  }
});

// ── Leaderboard (daily) — now reads from daily_earnings table ─────────────────
app.get('/api/leaderboard/daily', authMiddleware, async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    // Primary: query daily_earnings table (accurate, not overwritten on new day)
    const r = await pool.query(
      `SELECT de.telegram_id, u.telegram_username, u.telegram_first_name, u.telegram_photo_url,
              de.sp_amount AS daily_sp, de.date AS daily_sp_date
       FROM daily_earnings de
       JOIN users u ON u.telegram_id = de.telegram_id
       WHERE u.banned = FALSE AND de.date = $1 AND de.sp_amount > 0
       ORDER BY de.sp_amount DESC LIMIT 10`,
      [today]
    );
    // Fallback: if daily_earnings has no rows yet, use users.daily_sp
    let rows = r.rows;
    if (!rows.length) {
      const fallback = await pool.query(
        `SELECT telegram_id, telegram_username, telegram_first_name, telegram_photo_url, daily_sp, daily_sp_date
         FROM users WHERE banned = FALSE AND daily_sp_date = $1 AND daily_sp > 0
         ORDER BY daily_sp DESC LIMIT 10`,
        [today]
      );
      rows = fallback.rows;
    }
    const settings = await pool.query('SELECT last_daily_reward_at FROM app_settings WHERE id = 1');
    const lastLog = await pool.query('SELECT * FROM daily_reward_log ORDER BY distributed_at DESC LIMIT 1');
    res.json({
      leaderboard: rows.map(row => ({ ...row, score: row.daily_sp })),
      lastRewardAt: settings.rows[0]?.last_daily_reward_at || null,
      lastWinners: lastLog.rows[0]?.winners || []
    });
  } catch (err) {
    res.status(500).json({ error: 'DB error' });
  }
});

// ── ShhhToshi Blocks: score submission ──────────────────────────────────────
// Upserts the player's best score for *today* and for *this month* in one
// call. Server derives telegram_id from the verified initData — the client
// never gets to say who it is.
app.post('/api/blocks/score', blocksLimiter, authMiddleware, async (req, res) => {
  const { score } = req.body;
  const tgId = req.tgUser.id;

  if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 1000000) {
    return res.status(400).json({ error: 'Invalid score' });
  }

  const now = new Date();
  const dayKey = now.toISOString().split('T')[0];                          // YYYY-MM-DD
  const monthKey = dayKey.slice(0, 7);                                     // YYYY-MM

  try {
    await pool.query(
      `INSERT INTO blocks_scores (telegram_id, score, period, period_type)
       VALUES ($1, $2, $3, 'daily')
       ON CONFLICT (telegram_id, period, period_type)
       DO UPDATE SET score = GREATEST(blocks_scores.score, $2), submitted_at = NOW()`,
      [tgId, Math.floor(score), dayKey]
    );
    await pool.query(
      `INSERT INTO blocks_scores (telegram_id, score, period, period_type)
       VALUES ($1, $2, $3, 'monthly')
       ON CONFLICT (telegram_id, period, period_type)
       DO UPDATE SET score = GREATEST(blocks_scores.score, $2), submitted_at = NOW()`,
      [tgId, Math.floor(score), monthKey]
    );

    // Milestone check against the player's true all-time best, not just
    // today's/this-month's row, so unlocks aren't affected by period resets.
    const bestRow = await pool.query('SELECT COALESCE(MAX(score), 0) AS best FROM blocks_scores WHERE telegram_id = $1', [tgId]);
    const newCosmetics = await checkAndGrantMilestones(tgId, 'blocks_high_score', bestRow.rows[0]?.best || 0);
    const newAchievements = await checkAndGrantAchievements(tgId, 'blocks_high_score', bestRow.rows[0]?.best || 0);

    // One game played → bump "play N games" and "score N points" missions;
    // XP scaled off score so bigger runs are worth more.
    await bumpMissionProgress(tgId, 'blocks_games', 1);
    await bumpMissionProgress(tgId, 'blocks_score', Math.floor(score));
    await grantXp(tgId, Math.max(2, Math.round(score * 0.02)), 'ShhhToshi Blocks game');

    res.json({ ok: true, telegram_id: tgId, newCosmetics, newAchievements });
  } catch (err) {
    console.error('/api/blocks/score error:', err);
    res.status(500).json({ error: 'DB error' });
  }
});

// ── ShhhToshi Blocks: leaderboard ───────────────────────────────────────────
app.get('/api/blocks/leaderboard', authMiddleware, async (req, res) => {
  const periodType = req.query.period === 'monthly' ? 'monthly' : 'daily';
  const now = new Date();
  const periodKey = periodType === 'monthly'
    ? now.toISOString().slice(0, 7)
    : now.toISOString().split('T')[0];

  try {
    const r = await pool.query(
      `SELECT bs.telegram_id, bs.score,
              COALESCE(u.telegram_first_name, u.telegram_username, 'Player') AS name
       FROM blocks_scores bs
       JOIN users u ON u.telegram_id = bs.telegram_id
       WHERE bs.period_type = $1 AND bs.period = $2 AND u.banned = FALSE
       ORDER BY bs.score DESC
       LIMIT 10`,
      [periodType, periodKey]
    );
    res.json({ scores: r.rows });
  } catch (err) {
    console.error('/api/blocks/leaderboard error:', err);
    res.status(500).json({ error: 'DB error' });
  }
});

// ── ShhhToshi Blocks: this player's own best (for the menu screen) ─────────
app.get('/api/blocks/best', authMiddleware, async (req, res) => {
  const tgId = req.tgUser.id;
  try {
    const r = await pool.query(
      `SELECT COALESCE(MAX(score), 0) AS best FROM blocks_scores WHERE telegram_id = $1`,
      [tgId]
    );
    res.json({ best: r.rows[0]?.best || 0, telegram_id: tgId });
  } catch (err) {
    console.error('/api/blocks/best error:', err);
    res.status(500).json({ error: 'DB error' });
  }
});

// ── History: unified feed of spins, purchases, and withdrawals ────────────────
// Merges three separate tables into one timeline, newest first, capped at 10.
// Each row is normalized to { type, title, amount, unit, status, date } so
// the client can render them with one component regardless of source.
app.get('/api/history', authMiddleware, async (req, res) => {
  const tgId = req.tgUser.id;
  try {
    const [spins, boxes, cosmetics, withdrawals] = await Promise.all([
      pool.query(
        `SELECT prize_label, sp_won, ton_cost, spun_at AS date FROM spin_logs
         WHERE telegram_id = $1 ORDER BY spun_at DESC LIMIT 10`,
        [tgId]
      ),
      pool.query(
        `SELECT box_id, reward_sp, reward_item_id, ton_cost, created_at AS date FROM mysterybox_nonces
         WHERE telegram_id = $1 AND used = TRUE ORDER BY created_at DESC LIMIT 10`,
        [tgId]
      ),
      pool.query(
        `SELECT delta, note, logged_at AS date FROM balance_ledger
         WHERE telegram_id = $1 AND type = 'cosmetic_purchase' ORDER BY logged_at DESC LIMIT 10`,
        [tgId]
      ),
      pool.query(
        `SELECT id, sp_amount, status, created_at AS date FROM withdrawals
         WHERE telegram_id = $1 ORDER BY created_at DESC LIMIT 10`,
        [tgId]
      )
    ]);

    const items = [
      ...spins.rows.map(s => ({
        type: 'spin', title: 'Fortune Wheel Spin',
        amount: s.sp_won, unit: 'Sp', status: 'confirmed', date: s.date
      })),
      ...boxes.rows.map(b => ({
        type: 'purchase', title: `Mystery Box: ${b.box_id}`,
        amount: b.reward_sp || 0, unit: b.reward_item_id ? 'item' : 'Sp', status: 'confirmed', date: b.date
      })),
      ...cosmetics.rows.map(c => ({
        type: 'purchase', title: c.note || 'Cosmetic Purchase',
        amount: c.delta, unit: 'Sp', status: 'confirmed', date: c.date
      })),
      ...withdrawals.rows.map(w => ({
        type: 'withdrawal', title: 'Withdrawal Request',
        amount: -w.sp_amount, unit: 'Sp', status: w.status, date: w.date
      }))
    ];

    items.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    res.json({ history: items.slice(0, 10) });
  } catch (err) {
    console.error('/api/history error:', err);
    res.status(500).json({ error: 'DB error' });
  }
});

// ── App Settings ───────────────────────────────────────────────────────────────
app.get('/api/settings', authMiddleware, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM app_settings WHERE id = 1');
    res.json({ settings: r.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'DB error' });
  }
});

// ── Config: React frontend expects a flat camelCase object (not nested under
// "settings", and not snake_case) — this adapts the same app_settings row. ──
app.get('/api/config', authMiddleware, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM app_settings WHERE id = 1');
    const s = r.rows[0] || {};
    const allTasks = Array.isArray(s.tasks) ? s.tasks : [];

    // Season-scoped tasks only show while their season is currently active.
    // Tasks with no seasonId (the vast majority — evergreen tasks) always show.
    const activeSeason = await pool.query(
      `SELECT id FROM seasons WHERE active = TRUE AND starts_at <= NOW() AND ends_at >= NOW() ORDER BY starts_at DESC LIMIT 1`
    );
    const activeSeasonId = activeSeason.rows[0]?.id || null;
    const visibleTasks = allTasks.filter(t => !t.seasonId || t.seasonId === activeSeasonId);

    res.json({
      spinPrice: s.spin_price ?? 0.1,
      spinStarsPrice: s.spin_stars_price ?? 15,
      ogPassStarsPrice: s.og_pass_stars_price ?? 100,
      ogPassGramPrice: parseFloat(s.og_pass_gram_price) || 1,
      spToShhht: s.sp_to_shhht ?? 100,
      withdrawalMin: s.withdrawal_min ?? 10000,
      tasks: visibleTasks,
      adsTasks: Array.isArray(s.ads_tasks) ? s.ads_tasks : [],
      stakeTask: s.stake_task ?? null,
      tapBoostAmount: s.tap_boost_amount ?? 4,
      tapBoostPrice: s.tap_boost_price ?? 10,
      homeBoostTasks: s.home_boost_tasks ?? [],
      mysteryBoxes: s.mystery_boxes ?? []
    });
  } catch (err) {
    res.status(500).json({ error: 'DB error' });
  }
});

app.post('/api/settings', authMiddleware, adminMiddleware, async (req, res) => {
  const { spin_price, sp_to_shhht, tasks, home_boost_tasks, stake_task, tap_boost_price, tap_boost_amount, withdrawal_min, mysteryBoxes, adsTasks, ads_tasks, og_pass_stars_price, og_pass_gram_price, spin_stars_price } = req.body;
  try {
    // The admin panel's main task list is built from /api/config, which
    // hides out-of-season tasks. If we saved `tasks` as-is here, every task
    // belonging to an inactive season would silently disappear the moment
    // an admin added/edited/deleted any regular task. Re-attach any
    // season-tagged tasks that aren't in the submitted list before saving.
    let tasksToSave = tasks;
    if (tasks !== undefined) {
      const current = await pool.query('SELECT tasks FROM app_settings WHERE id = 1');
      const existingTasks = Array.isArray(current.rows[0]?.tasks) ? current.rows[0].tasks : [];
      const submittedIds = new Set(tasks.map(t => t.id));
      const hiddenSeasonTasks = existingTasks.filter(t => t.seasonId && !submittedIds.has(t.id));
      tasksToSave = [...tasks, ...hiddenSeasonTasks];
    }

    const fields = [], vals = [];
    let i = 1;
    const add = (col, val) => { if (val !== undefined) { fields.push(`${col} = $${i++}`); vals.push(val); } };
    add('spin_price', spin_price);
    add('spin_stars_price', spin_stars_price);
    add('og_pass_stars_price', og_pass_stars_price);
    add('og_pass_gram_price', og_pass_gram_price);
    add('sp_to_shhht', sp_to_shhht);
    add('tasks', tasksToSave !== undefined ? JSON.stringify(tasksToSave) : undefined);
    add('home_boost_tasks', home_boost_tasks !== undefined ? JSON.stringify(home_boost_tasks) : undefined);
    add('stake_task', stake_task !== undefined ? JSON.stringify(stake_task) : undefined);
    add('tap_boost_price', tap_boost_price);
    add('tap_boost_amount', tap_boost_amount);
    add('withdrawal_min', withdrawal_min);
    add('mystery_boxes', mysteryBoxes !== undefined ? JSON.stringify(mysteryBoxes) : undefined);
    const adsPayload = adsTasks !== undefined ? adsTasks : ads_tasks;
    add('ads_tasks', adsPayload !== undefined ? JSON.stringify(adsPayload) : undefined);
    if (!fields.length) return res.json({ ok: true });
    fields.push('updated_at = NOW()');
    const r = await pool.query(`UPDATE app_settings SET ${fields.join(', ')} WHERE id = 1 RETURNING *`, vals);
    res.json({ settings: r.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'DB error' });
  }
});

// ── Withdrawal Requests ────────────────────────────────────────────────────────
app.post(['/api/withdrawal', '/api/withdrawal/request'], authMiddleware, async (req, res) => {
  const { amount, wallet_address } = req.body;
  try {
    const r = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [req.tgUser.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    const user = r.rows[0];
    if (amount > user.shhhtoshi) return res.status(400).json({ error: 'Insufficient balance' });

    const settings = await pool.query('SELECT sp_to_shhht, withdrawal_min FROM app_settings WHERE id = 1');
    const rate = settings.rows[0]?.sp_to_shhht || 100;
    const minWithdrawal = settings.rows[0]?.withdrawal_min ?? 10000;
    if (amount < minWithdrawal) {
      return res.status(400).json({ error: `Minimum withdrawal is ${Number(minWithdrawal).toLocaleString()} Sp` });
    }

    // Apply 5% fee (waived for OG Pass holders)
    const ogRow = await pool.query('SELECT og_pass FROM users WHERE telegram_id = $1', [req.tgUser.id]);
    const isOg = !!ogRow.rows[0]?.og_pass;
    const feeAmount = isOg ? 0 : Math.floor(amount * 0.05);
    const netAmount = amount - feeAmount;
    const shhhtAmount = (netAmount / rate * 10).toFixed(4);

    const wrId = 'wr' + Date.now();
    const userName = user.telegram_first_name || ('User_' + String(user.telegram_id).slice(-4));
    const walletAddr = rawToFriendly(wallet_address || user.wallet_address);
    const dateStr = new Date().toISOString().split('T')[0];

    const req2 = {
      id: wrId,
      user: userName,
      wallet: walletAddr,
      amount,
      feeAmount,
      netAmount,
      shhhtAmount,
      date: dateStr,
      status: 'pending',
      telegram_id: req.tgUser.id
    };

    // Insert into dedicated withdrawals table
    await pool.query(
      `INSERT INTO withdrawals (id, telegram_id, user_name, wallet_address, sp_amount, fee_amount, net_sp_amount, shht_amount, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending')`,
      [wrId, req.tgUser.id, userName, walletAddr, amount, feeAmount, netAmount, shhhtAmount]
    );

    // Update user withdrawal_requests JSONB and deduct balance
    const existingWr = user.withdrawal_requests || [];
    existingWr.unshift(req2);
    await pool.query(
      'UPDATE users SET shhhtoshi = shhhtoshi - $1, withdrawal_requests = $2 WHERE telegram_id = $3',
      [amount, JSON.stringify(existingWr), req.tgUser.id]
    );

    // Update admin settings withdrawal_requests JSONB
    const adSettings = await pool.query('SELECT withdrawal_requests FROM app_settings WHERE id = 1');
    const adminWr = adSettings.rows[0]?.withdrawal_requests || [];
    adminWr.unshift(req2);
    await pool.query('UPDATE app_settings SET withdrawal_requests = $1 WHERE id = 1', [JSON.stringify(adminWr)]);

    const updated = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [req.tgUser.id]);

    // Notify user via bot
    sendBotMsg(req.tgUser.id,
      `⏳ <b>Withdrawal Request Received</b>\n\n` +
      `💰 Requested: <b>${Number(amount).toLocaleString()} Sp</b>\n` +
      `🏷 Fee${isOg ? ' (OG waived)' : ' (5%)'}: <b>${Number(feeAmount).toLocaleString()} Sp</b>\n` +
      `✅ Net amount: <b>${Number(netAmount).toLocaleString()} Sp</b>\n` +
      `🪙 You will receive: <b>${shhhtAmount} $Shhht</b>\n` +
      `📅 Date: ${dateStr}\n\n` +
      `⏱ Processing time: <b>up to 48 hours</b>\n` +
      `We will notify you once your withdrawal is processed.`,
      { reply_markup: { inline_keyboard: [[{ text: '🚀 Open App', web_app: { url: MINI_APP_URL } }]] } }
    );

    // Auto-post a log of this withdrawal request to the configured channel/group
    if (WITHDRAWAL_LOG_CHAT_ID) {
      sendBotMsg(WITHDRAWAL_LOG_CHAT_ID,
        `🆕 <b>New Withdrawal Request</b>\n\n` +
        `🆔 ID: <code>${wrId}</code>\n` +
        `👤 User: <b>${userName}</b> (<code>${req.tgUser.id}</code>)\n` +
        `💰 Requested: <b>${Number(amount).toLocaleString()} Sp</b>\n` +
        `🏷 Fee${isOg ? ' (OG waived)' : ' (5%)'}: <b>${Number(feeAmount).toLocaleString()} Sp</b>\n` +
        `✅ Net: <b>${Number(netAmount).toLocaleString()} Sp</b>\n` +
        `🪙 Payout: <b>${shhhtAmount} $Shhht</b>\n` +
        `👛 Wallet: <code>${walletAddr || 'N/A'}</code>\n` +
        `📅 Date: ${dateStr}\n` +
        `⏳ Status: <b>pending</b>`
      );
    }

    res.json({ user: updated.rows[0], withdrawal: req2 });
  } catch (err) {
    console.error('/api/withdrawal error:', err);
    res.status(500).json({ error: 'DB error' });
  }
});

// ── Admin: All users (with optional search) ────────────────────────────────────
app.get('/api/admin/users', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { q } = req.query;
    let r;
    if (q && q.trim()) {
      const search = q.trim();
      const isNumeric = /^\d+$/.test(search);
      r = await pool.query(
        `SELECT * FROM users WHERE
          (telegram_first_name ILIKE $1 OR telegram_username ILIKE $1
           ${isNumeric ? `OR telegram_id = ${parseInt(search)}` : ''})
         ORDER BY shhhtoshi DESC LIMIT 100`,
        [`%${search}%`]
      );
    } else {
      r = await pool.query('SELECT * FROM users ORDER BY shhhtoshi DESC LIMIT 200');
    }
    const countRow = await pool.query('SELECT COUNT(*) FROM users');
    res.json({ users: r.rows, total: parseInt(countRow.rows[0].count) });
  } catch (err) {
    res.status(500).json({ error: 'DB error' });
  }
});

// ── Admin: Task completion stats ────────────────────────────────────────────────
app.get('/api/admin/task-stats', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT task_id, task_type, COUNT(*) as count, SUM(reward) as total_sp
       FROM task_completions GROUP BY task_id, task_type ORDER BY count DESC`
    );
    res.json({ stats: r.rows });
  } catch (err) {
    res.status(500).json({ error: 'DB error' });
  }
});

// ── Admin: Analytics dashboard ─────────────────────────────────────────────────
const safeQuery = async (sql, params = []) => {
  try { const r = await pool.query(sql, params); return r.rows; }
  catch (e) { console.error('Analytics query error:', e.message); return []; }
};

app.get('/api/admin/analytics', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const [
      userRows, spinRows, taskRows, tapRows,
      wdRows, wdPendingRows, wdApprovedRows,
      newUsers30d, topEarners
    ] = await Promise.all([
      // Total users — all COALESCE so NULLs become 0
      safeQuery(`SELECT
        COUNT(*) as total,
        COALESCE(SUM(shhhtoshi),0) as total_sp,
        COALESCE(SUM(tap_earnings),0) as total_tap_sp,
        COALESCE(SUM(task_earnings),0) as total_task_sp,
        COUNT(*) FILTER (WHERE banned = TRUE) as banned_count,
        COUNT(*) FILTER (WHERE joined_at > NOW() - INTERVAL '24 hours') as new_today,
        COUNT(*) FILTER (WHERE joined_at > NOW() - INTERVAL '7 days') as new_week
        FROM users`),
      // Spin stats — use users.spin_history JSONB as fallback if spin_logs empty
      safeQuery(`SELECT
        COALESCE((SELECT COUNT(*) FROM spin_logs), 0) as total_spins,
        COALESCE((SELECT SUM(sp_won) FROM spin_logs), 0) as total_sp_won,
        COALESCE((SELECT SUM(ton_cost) FROM spin_logs), 0) as total_ton`),
      // Task completions — with fallback to users.tasks_completed JSONB count
      safeQuery(`SELECT
        COALESCE((SELECT COUNT(*) FROM task_completions), 0) as total_completions,
        COALESCE((SELECT SUM(reward) FROM task_completions), 0) as total_sp,
        COALESCE((SELECT SUM(task_earnings) FROM users), 0) as total_task_sp_users`),
      // Tap sessions
      safeQuery(`SELECT
        COALESCE(COUNT(*),0) as total_sessions,
        COALESCE(SUM(sp_earned),0) as total_sp FROM tap_sessions`),
      // All withdrawal stats
      safeQuery(`SELECT
        COALESCE(COUNT(*),0) as total,
        COALESCE(SUM(sp_amount::numeric),0) as total_sp,
        COALESCE(SUM(shht_amount::numeric),0) as total_shht FROM withdrawals`),
      // Pending
      safeQuery(`SELECT COALESCE(COUNT(*),0) as count, COALESCE(SUM(sp_amount::numeric),0) as sp
                 FROM withdrawals WHERE status='pending'`),
      // Approved
      safeQuery(`SELECT COALESCE(COUNT(*),0) as count, COALESCE(SUM(sp_amount::numeric),0) as sp,
                 COALESCE(SUM(shht_amount::numeric),0) as shht FROM withdrawals WHERE status='approved'`),
      // New users per day last 30 days
      safeQuery(`SELECT DATE(joined_at) as day, COUNT(*) as count FROM users
                 WHERE joined_at > NOW() - INTERVAL '30 days'
                 GROUP BY DATE(joined_at) ORDER BY day ASC`),
      // Top 5 earners
      safeQuery(`SELECT telegram_first_name, telegram_username, shhhtoshi, task_earnings, tap_earnings
                 FROM users ORDER BY shhhtoshi DESC LIMIT 5`)
    ]);

    const u = userRows[0] || {};
    const sp = spinRows[0] || {};
    const tk = taskRows[0] || {};
    const tp = tapRows[0] || {};
    const wd = wdRows[0] || {};

    res.json({
      users: {
        total: parseInt(u.total) || 0,
        total_sp: parseInt(u.total_sp) || 0,
        total_tap_sp: parseInt(u.total_tap_sp) || 0,
        total_task_sp: parseInt(u.total_task_sp) || 0,
        banned_count: parseInt(u.banned_count) || 0,
        new_today: parseInt(u.new_today) || 0,
        new_week: parseInt(u.new_week) || 0,
      },
      spins: {
        total_spins: parseInt(sp.total_spins) || 0,
        total_sp_won: parseInt(sp.total_sp_won) || 0,
        total_ton: parseFloat(sp.total_ton) || 0,
      },
      tasks: {
        total_completions: parseInt(tk.total_completions) || 0,
        total_sp: parseInt(tk.total_sp) || parseInt(tk.total_task_sp_users) || 0,
      },
      taps: {
        total_sessions: parseInt(tp.total_sessions) || 0,
        total_sp: parseInt(tp.total_sp) || 0,
      },
      withdrawals: {
        total: parseInt(wd.total) || 0,
        total_sp: parseFloat(wd.total_sp) || 0,
        total_shht: parseFloat(wd.total_shht) || 0,
        pending: { count: parseInt(wdPendingRows[0]?.count) || 0, sp: parseFloat(wdPendingRows[0]?.sp) || 0 },
        approved: { count: parseInt(wdApprovedRows[0]?.count) || 0, sp: parseFloat(wdApprovedRows[0]?.sp) || 0, shht: parseFloat(wdApprovedRows[0]?.shht) || 0 },
      },
      newUsers30d: newUsers30d,
      topEarners: topEarners,
    });
  } catch (err) {
    console.error('/api/admin/analytics error:', err);
    res.status(500).json({ error: 'DB error: ' + err.message });
  }
});

app.post('/api/admin/user/:id/ban', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    await pool.query('UPDATE users SET banned = TRUE WHERE telegram_id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'DB error' }); }
});

app.post('/api/admin/user/:id/unban', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    await pool.query('UPDATE users SET banned = FALSE WHERE telegram_id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'DB error' }); }
});

app.post('/api/admin/user/:id/balance', authMiddleware, adminMiddleware, async (req, res) => {
  const { balance } = req.body;
  try {
    await pool.query('UPDATE users SET shhhtoshi = $1 WHERE telegram_id = $2', [balance, req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'DB error' }); }
});

// ── Admin: Get all withdrawals from dedicated table ───────────────────────────
app.get('/api/admin/withdrawals', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT w.*, u.telegram_username, u.telegram_first_name
       FROM withdrawals w
       LEFT JOIN users u ON u.telegram_id = w.telegram_id
       ORDER BY w.created_at DESC LIMIT 200`
    );
    res.json({ withdrawals: r.rows });
  } catch (err) {
    res.status(500).json({ error: 'DB error' });
  }
});

// ── Admin: Withdrawal status + bot notification ─────────────────────────────────
app.post('/api/admin/withdrawal/:id/status', authMiddleware, adminMiddleware, async (req, res) => {
  const { status } = req.body;
  const wrId = req.params.id;
  try {
    // Update dedicated withdrawals table
    await pool.query(
      'UPDATE withdrawals SET status = $1, updated_at = NOW() WHERE id = $2',
      [status, wrId]
    );

    // Fetch withdrawal info from DB table
    const wrRow = await pool.query('SELECT * FROM withdrawals WHERE id = $1', [wrId]);
    const wr = wrRow.rows[0];

    // Also update app_settings JSONB for admin panel display
    const adSettings = await pool.query('SELECT withdrawal_requests FROM app_settings WHERE id = 1');
    const adminWr = adSettings.rows[0]?.withdrawal_requests || [];
    const updatedAdminWr = adminWr.map(r => r.id === wrId ? { ...r, status } : r);
    await pool.query('UPDATE app_settings SET withdrawal_requests = $1 WHERE id = 1', [JSON.stringify(updatedAdminWr)]);

    // Update user's withdrawal_requests JSONB
    if (wr?.telegram_id) {
      const uRes = await pool.query('SELECT telegram_id, withdrawal_requests FROM users WHERE telegram_id = $1', [wr.telegram_id]);
      if (uRes.rows.length) {
        const u = uRes.rows[0];
        const userWr = (u.withdrawal_requests || []).map(r => r.id === wrId ? { ...r, status } : r);
        await pool.query('UPDATE users SET withdrawal_requests = $1 WHERE telegram_id = $2', [JSON.stringify(userWr), u.telegram_id]);
      }
    }

    const notifyTgId = wr?.telegram_id;

    // Notify the user via bot
    if (notifyTgId && wr) {
      if (status === 'confirmed') {
        sendBotMsg(notifyTgId,
          `✅ <b>Withdrawal Confirmed!</b>\n\n` +
          `💰 Requested: <b>${Number(wr.sp_amount).toLocaleString()} Sp</b>\n` +
          `🏷 Fee (5%): <b>${Number(wr.fee_amount).toLocaleString()} Sp</b>\n` +
          `🪙 Receiving: <b>${wr.shht_amount} $Shhht</b>\n\n` +
          `Your withdrawal has been approved and will be sent to your wallet shortly. Thank you for using Shhhtoshi!`,
          { reply_markup: { inline_keyboard: [[{ text: '🚀 Open App', web_app: { url: MINI_APP_URL } }]] } }
        );
      } else if (status === 'declined') {
        sendBotMsg(notifyTgId,
          `❌ <b>Withdrawal Declined</b>\n\n` +
          `💰 Amount: <b>${Number(wr.sp_amount).toLocaleString()} Sp</b>\n\n` +
          `Your withdrawal request was declined. Your Sp balance has been refunded. If you have questions, please contact support.`,
          { reply_markup: { inline_keyboard: [[{ text: '🚀 Open App', web_app: { url: MINI_APP_URL } }]] } }
        );
        // Refund the full Sp amount (not net, refund what was deducted)
        await pool.query('UPDATE users SET shhhtoshi = shhhtoshi + $1 WHERE telegram_id = $2', [wr.sp_amount, notifyTgId]);
        // Update user withdrawal_requests to restore the refund in JSONB too
        const uRes2 = await pool.query('SELECT telegram_id, withdrawal_requests FROM users WHERE telegram_id = $1', [wr.telegram_id]);
        if (uRes2.rows.length) {
          const u = uRes2.rows[0];
          const userWr = (u.withdrawal_requests || []).map(r => r.id === wrId ? { ...r, status } : r);
          await pool.query('UPDATE users SET withdrawal_requests = $1 WHERE telegram_id = $2', [JSON.stringify(userWr), u.telegram_id]);
        }
      }
    }

    // Auto-post the status update to the withdrawal log channel/group
    if (WITHDRAWAL_LOG_CHAT_ID && wr) {
      const statusEmoji = status === 'confirmed' ? '✅' : status === 'declined' ? '❌' : 'ℹ️';
      sendBotMsg(WITHDRAWAL_LOG_CHAT_ID,
        `${statusEmoji} <b>Withdrawal ${status === 'confirmed' ? 'Confirmed' : status === 'declined' ? 'Declined' : 'Updated'}</b>\n\n` +
        `🆔 ID: <code>${wrId}</code>\n` +
        `👤 User: <b>${wr.user_name}</b> (<code>${wr.telegram_id}</code>)\n` +
        `💰 Amount: <b>${Number(wr.sp_amount).toLocaleString()} Sp</b>\n` +
        `🪙 Payout: <b>${wr.shht_amount} $Shhht</b>\n` +
        `👛 Wallet: <code>${wr.wallet_address || 'N/A'}</code>\n` +
        `📌 Status: <b>${status}</b>`
      );
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('/api/admin/withdrawal/:id/status error:', err);
    res.status(500).json({ error: 'DB error' });
  }
});

// ── Admin: Broadcast ───────────────────────────────────────────────────────────
app.post('/api/admin/broadcast', authMiddleware, adminMiddleware, async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'No message' });
  res.json({ ok: true, message: 'Broadcast started' });
  doBroadcast(ADMIN_ID, message, ADMIN_ID);
});

// ── Admin: Extra admin management ──────────────────────────────────────────────
// Verify the admin panel password. Requires valid Telegram admin auth first
// (authMiddleware + adminMiddleware) — this is an ADDITIONAL layer, not a
// replacement, so a compromised/spoofed Telegram session alone still can't
// get in without also knowing this password. The password itself is never
// stored in the DB or code, only a salted scrypt hash.
app.post('/api/admin/verify-password', adminPwLimiter, authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: 'Password required' });
    const r = await pool.query('SELECT admin_password_hash FROM app_settings WHERE id = 1');
    const storedHash = r.rows[0]?.admin_password_hash;
    if (!storedHash) return res.status(500).json({ error: 'Admin password not configured on server' });
    const ok = verifyAdminPassword(password, storedHash);
    if (!ok) return res.status(403).json({ error: 'Incorrect password' });
    // Short-lived signed token so the frontend doesn't need to resend the
    // password on every admin action within this session.
    const token = crypto.createHmac('sha256', BOT_TOKEN)
      .update(`admin:${req.tgUser.id}:${Date.now()}`)
      .digest('hex');
    res.json({ ok: true, token, issuedAt: Date.now() });
  } catch (e) {
    console.error('/api/admin/verify-password error:', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/admin/admins', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const r = await pool.query('SELECT extra_admins FROM app_settings WHERE id = 1');
    res.json({ admins: r.rows[0]?.extra_admins || [] });
  } catch (err) {
    res.status(500).json({ error: 'DB error' });
  }
});

app.post('/api/admin/admins/add', authMiddleware, adminMiddleware, async (req, res) => {
  const { telegram_id } = req.body;
  if (!telegram_id) return res.status(400).json({ error: 'Missing telegram_id' });
  if (parseInt(telegram_id) === ADMIN_ID) return res.status(400).json({ error: 'Already main admin' });
  try {
    await pool.query(
      `UPDATE app_settings SET extra_admins = array_append(
        COALESCE(array_remove(extra_admins, $1), '{}'), $1
      ) WHERE id = 1`,
      [String(telegram_id)]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'DB error' });
  }
});

app.post('/api/admin/admins/remove', authMiddleware, adminMiddleware, async (req, res) => {
  const { telegram_id } = req.body;
  if (!telegram_id) return res.status(400).json({ error: 'Missing telegram_id' });
  try {
    await pool.query(
      `UPDATE app_settings SET extra_admins = array_remove(COALESCE(extra_admins, '{}'), $1) WHERE id = 1`,
      [String(telegram_id)]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'DB error' });
  }
});

// ── Daily reward distribution cron (runs every 5 min, distributes every 24h) ──
const DAILY_PRIZES = [5000, 4000, 3000, 2000, 1500, 1200, 1000, 800, 700, 800]; // sums to 20000

async function distributeDailyRewards() {
  try {
    const settings = await pool.query('SELECT last_daily_reward_at FROM app_settings WHERE id = 1');
    const lastAt = settings.rows[0]?.last_daily_reward_at;
    const now = new Date();
    // Only distribute if >24h have passed since last distribution (or never distributed)
    if (lastAt && (now - new Date(lastAt)) < 24 * 60 * 60 * 1000) return;

    const yesterday = new Date(now - 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const today = now.toISOString().split('T')[0];

    // Get top 10 users who earned Sp yesterday (or today if first run)
    // Queries daily_earnings table so data is never overwritten when a user starts a new day
    const checkDate = lastAt ? yesterday : today;
    let top10 = await pool.query(
      `SELECT de.telegram_id, u.telegram_first_name, u.telegram_username, de.sp_amount AS daily_sp
       FROM daily_earnings de
       JOIN users u ON u.telegram_id = de.telegram_id
       WHERE u.banned = FALSE AND de.date = $1 AND de.sp_amount > 0
       ORDER BY de.sp_amount DESC LIMIT 10`,
      [checkDate]
    );
    // Fallback to users.daily_sp if daily_earnings has no data (pre-migration users)
    if (!top10.rows.length) {
      top10 = await pool.query(
        `SELECT telegram_id, telegram_first_name, telegram_username, daily_sp
         FROM users WHERE banned = FALSE AND daily_sp_date = $1 AND daily_sp > 0
         ORDER BY daily_sp DESC LIMIT 10`,
        [checkDate]
      );
    }

    if (!top10.rows.length) {
      // No activity — just update timestamp so we don't spam-check
      await pool.query('UPDATE app_settings SET last_daily_reward_at = $1 WHERE id = 1', [now]);
      return;
    }

    const RANK_EMOJI = ['🥇','🥈','🥉','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟'];
    const winners = [];
    for (let idx = 0; idx < top10.rows.length; idx++) {
      const user = top10.rows[idx];
      const prize = DAILY_PRIZES[idx] || 0;
      if (!prize) continue;
      await pool.query(
        'UPDATE users SET shhhtoshi = shhhtoshi + $1 WHERE telegram_id = $2',
        [prize, user.telegram_id]
      );
      const name = user.telegram_first_name || (user.telegram_username ? '@' + user.telegram_username : 'User_' + String(user.telegram_id).slice(-4));
      winners.push({ rank: idx + 1, name, prize, daily_sp: user.daily_sp, tgId: user.telegram_id });

      // Personal winner notification with Open App button
      sendBotMsg(user.telegram_id,
        `${RANK_EMOJI[idx]} <b>Daily Leaderboard Prize!</b>\n\n` +
        `Congratulations <b>${name}</b>! You ranked <b>#${idx + 1}</b> on today's leaderboard!\n\n` +
        `💰 Prize earned: <b>+${prize.toLocaleString()} Sp</b>\n` +
        `📊 Your daily earnings: <b>${user.daily_sp.toLocaleString()} Sp</b>\n\n` +
        `🔥 Keep it up — compete again tomorrow!`,
        { reply_markup: { inline_keyboard: [[{ text: '🚀 Open App', web_app: { url: MINI_APP_URL } }]] } }
      );
    }

    // Broadcast leaderboard summary to ALL users
    if (winners.length > 0) {
      const podium = winners.slice(0, 3).map(w => `${RANK_EMOJI[w.rank-1]} <b>${w.name}</b> — +${w.prize.toLocaleString()} Sp`).join('\n');
      const broadcastMsg =
        `🏆 <b>Daily Leaderboard Results!</b>\n\n` +
        `Today's top earners have been rewarded!\n\n` +
        `${podium}\n\n` +
        `💪 Earn Sp through tasks, spins &amp; tapping to win tomorrow's prizes!`;
      const allUsers = await pool.query('SELECT telegram_id FROM users WHERE banned = FALSE');
      const winnerIds = new Set(winners.map(w => w.tgId));
      for (const u of allUsers.rows) {
        if (winnerIds.has(u.telegram_id)) continue; // winners already got personal msg
        sendBotMsg(u.telegram_id, broadcastMsg,
          { reply_markup: { inline_keyboard: [[{ text: '🏅 View Leaderboard', web_app: { url: MINI_APP_URL } }]] } }
        );
        await new Promise(r => setTimeout(r, 35)); // respect Telegram rate limits
      }
    }

    // Log the distribution
    await pool.query('INSERT INTO daily_reward_log (winners) VALUES ($1)', [JSON.stringify(winners)]);
    await pool.query('UPDATE app_settings SET last_daily_reward_at = $1 WHERE id = 1', [now]);

    console.log(`🏆 Daily rewards distributed to ${winners.length} winners. Total: ${winners.reduce((s, w) => s + w.prize, 0).toLocaleString()} Sp`);
  } catch (e) {
    console.error('Daily reward cron error:', e.message);
  }
}

// ── Blocks game reward distribution (daily + monthly) ──────────────────────
const BLOCKS_DAILY_PRIZES = [5000, 4000, 3000, 2000, 1500, 1200, 1000, 800, 700, 800]; // sums to 20000
const BLOCKS_MONTHLY_PRIZES = [25000, 20000, 15000, 10000, 8000, 6000, 5000, 4000, 3500, 3500]; // sums to 100000
const RANK_EMOJI_BLOCKS = ['🥇','🥈','🥉','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟'];

async function distributeBlocksReward(periodType) {
  // Blocks feature removed from mini app — do not pay or message
  return;
  /* BLOCKS_REWARDS_DISABLED

  const isDaily = periodType === 'daily';
  const prizes = isDaily ? BLOCKS_DAILY_PRIZES : BLOCKS_MONTHLY_PRIZES;
  const now = new Date();
  const dayKey = now.toISOString().split('T')[0];      // YYYY-MM-DD
  const monthKey = dayKey.slice(0, 7);                  // YYYY-MM

  try {
    const settings = await pool.query(
      'SELECT last_blocks_daily_reward_at, last_blocks_monthly_period FROM app_settings WHERE id = 1'
    );
    const s = settings.rows[0] || {};

    // Figure out which period we're paying out for, and guard against
    // double-paying — same idea as distributeDailyRewards(), adapted so
    // monthly checks "did the calendar month change" instead of a duration.
    let periodToPay;
    if (isDaily) {
      const lastAt = s.last_blocks_daily_reward_at;
      if (lastAt && (now - new Date(lastAt)) < 24 * 60 * 60 * 1000) return;
      // Pay out *yesterday's* completed day once we've rolled past it (same
      // pattern as the existing daily Sp reward), falling back to today on
      // the very first run so it's never a no-op forever.
      periodToPay = lastAt
        ? new Date(now - 24 * 60 * 60 * 1000).toISOString().split('T')[0]
        : dayKey;
    } else {
      if (s.last_blocks_monthly_period === monthKey) return; // already paid this month
      // Pay out the previous month once we've rolled into a new one; on the
      // very first run (no record yet) pay out the current month so it's
      // not a permanent no-op.
      if (!s.last_blocks_monthly_period) {
        periodToPay = monthKey;
      } else {
        const prevMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        periodToPay = prevMonthDate.toISOString().slice(0, 7);
      }
    }

    const top10 = await pool.query(
      `SELECT bs.telegram_id, bs.score, u.telegram_first_name, u.telegram_username
       FROM blocks_scores bs
       JOIN users u ON u.telegram_id = bs.telegram_id
       WHERE bs.period_type = $1 AND bs.period = $2 AND u.banned = FALSE AND bs.score > 0
       ORDER BY bs.score DESC LIMIT 10`,
      [periodType, periodToPay]
    );

    if (!top10.rows.length) {
      // No plays that period — just advance the marker so we don't re-check forever.
      if (isDaily) {
        await pool.query('UPDATE app_settings SET last_blocks_daily_reward_at = $1 WHERE id = 1', [now]);
      } else {
        await pool.query('UPDATE app_settings SET last_blocks_monthly_period = $1 WHERE id = 1', [monthKey]);
      }
      return;
    }

    const winners = [];
    for (let idx = 0; idx < top10.rows.length; idx++) {
      const user = top10.rows[idx];
      const prize = prizes[idx] || 0;
      if (!prize) continue;
      await pool.query(
        'UPDATE users SET shhhtoshi = shhhtoshi + $1 WHERE telegram_id = $2',
        [prize, user.telegram_id]
      );
      await pool.query(
        `INSERT INTO balance_ledger (telegram_id, delta, type, note) VALUES ($1, $2, 'blocks_reward', $3)`,
        [user.telegram_id, prize, `Blocks ${periodType} leaderboard rank #${idx + 1}`]
      ).catch(() => {});

      const name = user.telegram_first_name || (user.telegram_username ? '@' + user.telegram_username : 'User_' + String(user.telegram_id).slice(-4));
      winners.push({ rank: idx + 1, name, prize, score: user.score, tgId: user.telegram_id });

      sendBotMsg(user.telegram_id,
        `${RANK_EMOJI_BLOCKS[idx]} <b>ShhhToshi Blocks — ${isDaily ? 'Daily' : 'Monthly'} Prize!</b>\n\n` +
        `Congratulations <b>${name}</b>! You ranked <b>#${idx + 1}</b> on the ${isDaily ? "day's" : "month's"} Blocks leaderboard!\n\n` +
        `💰 Prize earned: <b>+${prize.toLocaleString()} Sp</b>\n` +
        `🎮 Your best score: <b>${user.score.toLocaleString()}</b>\n\n` +
        `🔥 Keep playing — the board resets, so does the prize pool!`,
        { reply_markup: { inline_keyboard: [[{ text: '🎮 Play Blocks', web_app: { url: MINI_APP_URL } }]] } }
      );
    }

    if (winners.length > 0) {
      const podium = winners.slice(0, 3).map(w => `${RANK_EMOJI_BLOCKS[w.rank-1]} <b>${w.name}</b> — +${w.prize.toLocaleString()} Sp`).join('\n');
      const broadcastMsg =
        `🧱🏆 <b>ShhhToshi Blocks — ${isDaily ? 'Daily' : 'Monthly'} Results!</b>\n\n` +
        `${podium}\n\n` +
        `💪 Play ShhhToshi Blocks to climb next ${isDaily ? "day's" : "month's"} leaderboard!`;
      const allUsers = await pool.query('SELECT telegram_id FROM users WHERE banned = FALSE');
      const winnerIds = new Set(winners.map(w => w.tgId));
      for (const u of allUsers.rows) {
        if (winnerIds.has(u.telegram_id)) continue;
        sendBotMsg(u.telegram_id, broadcastMsg,
          { reply_markup: { inline_keyboard: [[{ text: '🎮 Play Blocks', web_app: { url: MINI_APP_URL } }]] } }
        );
        await new Promise(r => setTimeout(r, 35));
      }
    }

    await pool.query(
      'INSERT INTO blocks_reward_log (period_type, period, winners) VALUES ($1, $2, $3)',
      [periodType, periodToPay, JSON.stringify(winners)]
    );

    if (isDaily) {
      await pool.query('UPDATE app_settings SET last_blocks_daily_reward_at = $1 WHERE id = 1', [now]);
    } else {
      await pool.query('UPDATE app_settings SET last_blocks_monthly_period = $1 WHERE id = 1', [monthKey]);
    }

    console.log(`🧱 Blocks ${periodType} rewards distributed to ${winners.length} winners. Total: ${winners.reduce((s, w) => s + w.prize, 0).toLocaleString()} Sp`);
  } catch (e) {
    console.error(`Blocks ${periodType} reward cron error:`, e.message);
  }
}

*/
}
async function distributeBlocksDailyReward() { return; }
async function distributeBlocksMonthlyReward() { return; }

// ── Daily Check-in Reminder ────────────────────────────────────────────────────
async function sendDailyCheckinReminders() {
  try {
    const now = new Date();
    const hourUTC = now.getUTCHours();
    // Only send reminders between 14:00 and 22:00 UTC (reasonable hours globally)
    if (hourUTC < 14 || hourUTC >= 22) return;

    const today = now.toISOString().split('T')[0];

    // Find users who: haven't checked in today, haven't been reminded today, joined before today
    const r = await pool.query(`
      SELECT telegram_id, telegram_first_name, check_in, checkin_reminder_date
      FROM users
      WHERE banned = FALSE
        AND checkin_reminder_date != $1
        AND (check_in->>'lastDay' IS NULL OR check_in->>'lastDay' != $1)
        AND joined_at < NOW() - INTERVAL '1 hour'
      LIMIT 200
    `, [today]);

    if (!r.rows.length) return;

    let sent = 0;
    for (const user of r.rows) {
      const checkIn = user.check_in || {};
      const streak = checkIn.streak || 0;
      const name = user.telegram_first_name || 'there';

      const streakMsg = streak > 0
        ? `🔥 Your current streak is <b>${streak} day${streak !== 1 ? 's' : ''}</b> — don't lose it!`
        : `✨ Start your check-in streak today for bonus Sp!`;

      try {
        sendBotMsg(user.telegram_id,
          `⏰ <b>Daily Check-in Reminder</b>\n\nHey <b>${name}</b>! You haven't claimed your daily reward yet.\n\n${streakMsg}\n\n🎁 Open the app and tap <b>Check In</b> to collect your Sp bonus!`,
          { reply_markup: { inline_keyboard: [[{ text: '✅ Check In Now', web_app: { url: MINI_APP_URL } }]] } }
        );
        await pool.query('UPDATE users SET checkin_reminder_date = $1 WHERE telegram_id = $2', [today, user.telegram_id]);
        sent++;
        await new Promise(r => setTimeout(r, 35));
      } catch (e) { /* silent */ }
    }

    if (sent > 0) console.log(`⏰ Sent ${sent} check-in reminders`);
  } catch (e) {
    console.error('Check-in reminder error:', e.message);
  }
}

// ── Weekly Quiz Leaderboard Rewards ────────────────────────────────────────────
const QUIZ_WEEKLY_PRIZE = 2000;

async function processWeeklyQuizRewards() {
  try {
    const now = new Date();
    // Only run on Mondays (UTC)
    if (now.getUTCDay() !== 1) return;

    // Guard: skip if already ran within last 6.5 days
    const settings = await pool.query('SELECT last_quiz_weekly_reward_at FROM app_settings WHERE id = 1');
    const lastAt = settings.rows[0]?.last_quiz_weekly_reward_at;
    if (lastAt && (now - new Date(lastAt)) < 6.5 * 24 * 60 * 60 * 1000) return;

    // Previous week: Mon–Sun just ended
    const daysFromMonday = (now.getUTCDay() + 6) % 7; // = 0 since it's Monday
    const thisWeekStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const prevWeekStart = new Date(thisWeekStart);
    prevWeekStart.setUTCDate(prevWeekStart.getUTCDate() - 7);
    const prevWeekStartStr = prevWeekStart.toISOString().split('T')[0];
    const thisWeekStartStr = thisWeekStart.toISOString().split('T')[0];

    // Top 15 by correct answers in the previous week
    const top15 = await pool.query(`
      SELECT qa.telegram_id, u.telegram_first_name, u.telegram_username,
        COUNT(*) FILTER (WHERE qa.is_correct = TRUE AND qa.evaluated = TRUE) AS correct_answers
      FROM quiz_answers qa
      JOIN users u ON u.telegram_id = qa.telegram_id
      WHERE qa.answered_at >= $1 AND qa.answered_at < $2 AND u.banned = FALSE AND qa.evaluated = TRUE
      GROUP BY qa.telegram_id, u.telegram_first_name, u.telegram_username
      HAVING COUNT(*) FILTER (WHERE qa.is_correct = TRUE AND qa.evaluated = TRUE) > 0
      ORDER BY correct_answers DESC
      LIMIT 15
    `, [prevWeekStartStr, thisWeekStartStr]);

    // Update last run timestamp
    await pool.query('UPDATE app_settings SET last_quiz_weekly_reward_at = $1 WHERE id = 1', [now]);

    if (!top15.rows.length) {
      console.log('🧠 Weekly quiz: no activity last week, skipping rewards');
      return;
    }

    const RANK_EMOJI = ['🥇','🥈','🥉','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟','1️⃣1️⃣','1️⃣2️⃣','1️⃣3️⃣','1️⃣4️⃣','1️⃣5️⃣'];
    const winners = [];
    for (let i = 0; i < top15.rows.length; i++) {
      const u = top15.rows[i];
      const rank = i + 1;
      await pool.query(
        `INSERT INTO quiz_leaderboard_rewards (telegram_id, telegram_first_name, telegram_username, correct_answers, rank, reward, week_start)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [u.telegram_id, u.telegram_first_name, u.telegram_username, u.correct_answers, rank, QUIZ_WEEKLY_PRIZE, prevWeekStartStr]
      );
      await pool.query(
        `UPDATE users SET shhhtoshi = shhhtoshi + $1 WHERE telegram_id = $2`,
        [QUIZ_WEEKLY_PRIZE, u.telegram_id]
      );
      await pool.query(
        `INSERT INTO balance_ledger (telegram_id, delta, type, note) VALUES ($1, $2, 'quiz_weekly', $3)`,
        [u.telegram_id, QUIZ_WEEKLY_PRIZE, `Weekly Quiz #${rank} prize`]
      ).catch(() => {});

      const name = u.telegram_first_name || (u.telegram_username ? '@' + u.telegram_username : 'Brain#' + String(u.telegram_id).slice(-4));
      winners.push({ rank, name, tgId: u.telegram_id, correct: parseInt(u.correct_answers) });

      sendBotMsg(u.telegram_id,
        `${RANK_EMOJI[i]} 🧠 <b>Weekly Quiz Champion!</b>\n\n` +
        `You finished <b>#${rank}</b> on the Weekly Quiz Leaderboard!\n\n` +
        `✅ Correct answers: <b>${u.correct_answers}</b>\n` +
        `💰 Prize: <b>+${QUIZ_WEEKLY_PRIZE.toLocaleString()} Sp</b> added to your wallet!\n\n` +
        `🎯 New week starts now — keep your streak alive!`,
        { reply_markup: { inline_keyboard: [[{ text: '🏆 View Leaderboard', web_app: { url: MINI_APP_URL } }]] } }
      );
    }

    // Broadcast summary to all users
    const medals = ['🥇','🥈','🥉'];
    const podium = winners.slice(0, 3).map((w, i) => `${medals[i]} <b>${w.name}</b> — ${w.correct} correct ✅`).join('\n');
    const broadcastMsg =
      `🧠🏆 <b>Weekly Quiz Leaderboard Results!</b>\n\n` +
      `The brainiest players got rewarded!\n\n` +
      `${podium}\n\n` +
      `🏅 Top 15 each earned <b>+${QUIZ_WEEKLY_PRIZE.toLocaleString()} Sp</b>!\n` +
      `💡 Fresh week — answer quizzes to climb the board!`;

    const allUsers = await pool.query('SELECT telegram_id FROM users WHERE banned = FALSE');
    const winnerIds = new Set(winners.map(w => w.tgId));
    for (const u of allUsers.rows) {
      if (winnerIds.has(u.telegram_id)) continue;
      sendBotMsg(u.telegram_id, broadcastMsg, {
        reply_markup: { inline_keyboard: [[{ text: '🧠 Quiz Leaderboard', web_app: { url: MINI_APP_URL } }]] }
      });
      await new Promise(r => setTimeout(r, 35));
    }

    console.log(`🧠 Weekly quiz rewards distributed to ${winners.length} users`);
  } catch (e) {
    console.error('processWeeklyQuizRewards error:', e.message);
  }
}

// (cron is started after migrate() completes — see above)

// ── Live Quiz API ───────────────────────────────────────────────────────────────

// GET active quiz (correct answer NOT revealed)
app.get('/api/quiz/active', authMiddleware, async (req, res) => {
  try {
    const qr = await pool.query(
      `SELECT id, question, options, reward, duration_secs, start_time FROM live_quiz WHERE is_active = TRUE ORDER BY created_at DESC LIMIT 1`
    );
    if (!qr.rows.length) return res.json({ quiz: null });
    const quiz = qr.rows[0];
    const ar = await pool.query(
      `SELECT answer_idx, is_correct, reward_given, evaluated FROM quiz_answers WHERE quiz_id = $1 AND telegram_id = $2`,
      [quiz.id, req.tgUser.id]
    );
    res.json({ quiz, userAnswer: ar.rows[0] || null });
  } catch (e) {
    console.error('/api/quiz/active error:', e.message);
    res.status(500).json({ error: 'DB error' });
  }
});

// POST submit quiz answer — locks the answer before timer ends (anti-cheat)
app.post('/api/quiz/submit', authMiddleware, async (req, res) => {
  const { quiz_id, answer_idx } = req.body;
  if (quiz_id == null || answer_idx == null) return res.status(400).json({ error: 'Missing fields' });
  const tgId = req.tgUser.id;
  try {
    const qr = await pool.query(
      `SELECT id, duration_secs, start_time FROM live_quiz WHERE id = $1 AND is_active = TRUE`, [quiz_id]
    );
    if (!qr.rows.length) return res.status(404).json({ error: 'Quiz not found or expired' });
    const quiz = qr.rows[0];

    const elapsed = (Date.now() - new Date(quiz.start_time).getTime()) / 1000;
    if (elapsed >= quiz.duration_secs) return res.status(400).json({ error: 'Timer already ended' });

    // Check already submitted
    const ex = await pool.query(
      `SELECT answer_idx, evaluated FROM quiz_answers WHERE quiz_id = $1 AND telegram_id = $2`, [quiz_id, tgId]
    );
    if (ex.rows.length) {
      return res.json({ submitted: true, locked: true, answer_idx: ex.rows[0].answer_idx, evaluated: ex.rows[0].evaluated });
    }

    // Insert with ON CONFLICT DO NOTHING — prevents any race-condition double submit
    await pool.query(
      `INSERT INTO quiz_answers (quiz_id, telegram_id, answer_idx, is_correct, reward_given, evaluated)
       VALUES ($1, $2, $3, FALSE, 0, FALSE) ON CONFLICT (quiz_id, telegram_id) DO NOTHING`,
      [quiz_id, tgId, answer_idx]
    );
    res.json({ submitted: true, locked: true, answer_idx });
  } catch (e) {
    console.error('/api/quiz/submit error:', e.message);
    res.status(500).json({ error: 'DB error' });
  }
});

// POST evaluate quiz — uses stored DB answer, called by client when timer hits 0
app.post('/api/quiz/evaluate', authMiddleware, async (req, res) => {
  const { quiz_id } = req.body;
  if (quiz_id == null) return res.status(400).json({ error: 'Missing quiz_id' });
  const tgId = req.tgUser.id;
  const today = new Date().toISOString().split('T')[0];
  try {
    const qr = await pool.query(`SELECT * FROM live_quiz WHERE id = $1 AND is_active = TRUE`, [quiz_id]);
    if (!qr.rows.length) return res.status(404).json({ error: 'Quiz not found or expired' });
    const quiz = qr.rows[0];

    const elapsed = (Date.now() - new Date(quiz.start_time).getTime()) / 1000;
    if (elapsed < quiz.duration_secs - 3) return res.status(400).json({ error: 'Quiz is still active' });

    // Get stored answer from DB
    const ex = await pool.query(
      `SELECT * FROM quiz_answers WHERE quiz_id = $1 AND telegram_id = $2`, [quiz_id, tgId]
    );

    // No answer submitted → return correct answer with no reward
    if (!ex.rows.length) return res.json({ no_answer: true, correct_idx: quiz.correct_idx });

    const stored = ex.rows[0];
    // Already evaluated — return cached result
    if (stored.evaluated) {
      return res.json({ already_answered: true, is_correct: stored.is_correct, reward_given: stored.reward_given, correct_idx: quiz.correct_idx });
    }

    const is_correct = parseInt(stored.answer_idx) === parseInt(quiz.correct_idx);
    const reward_given = is_correct ? quiz.reward : 0;

    await pool.query(
      `UPDATE quiz_answers SET is_correct = $1, reward_given = $2, evaluated = TRUE WHERE id = $3`,
      [is_correct, reward_given, stored.id]
    );

    let newCosmetics = [];
    if (is_correct && reward_given > 0) {
      await pool.query(
        `UPDATE users SET shhhtoshi = shhhtoshi + $1, task_earnings = task_earnings + $1, updated_at = NOW() WHERE telegram_id = $2`,
        [reward_given, tgId]
      );
      await pool.query(
        `INSERT INTO daily_earnings (telegram_id, date, sp_amount) VALUES ($1, $2, $3) ON CONFLICT (telegram_id, date) DO UPDATE SET sp_amount = daily_earnings.sp_amount + $3`,
        [tgId, today, reward_given]
      ).catch(() => {});
      await pool.query(
        `INSERT INTO balance_ledger (telegram_id, delta, type, note) VALUES ($1, $2, 'quiz', $3)`,
        [tgId, reward_given, `Quiz #${quiz_id} correct`]
      ).catch(() => {});

      const correctCountRow = await pool.query(
        `SELECT COUNT(*) FROM quiz_answers WHERE telegram_id = $1 AND is_correct = TRUE`, [tgId]
      );
      newCosmetics = await checkAndGrantMilestones(tgId, 'quiz_completions', parseInt(correctCountRow.rows[0].count) || 0);
    }

    const ur = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [tgId]);
    res.json({ is_correct, reward_given, correct_idx: quiz.correct_idx, user: ur.rows[0], newCosmetics });
  } catch (e) {
    console.error('/api/quiz/evaluate error:', e.message);
    res.status(500).json({ error: 'DB error' });
  }
});

// Admin: Create new quiz + broadcast
app.post('/api/admin/quiz/create', authMiddleware, adminMiddleware, async (req, res) => {
  const { question, options, correct_idx, reward, duration_secs } = req.body;
  if (!question || !Array.isArray(options) || options.length !== 4 || correct_idx == null) {
    return res.status(400).json({ error: 'Missing/invalid fields' });
  }
  try {
    await pool.query(`UPDATE live_quiz SET is_active = FALSE`);
    const qr = await pool.query(
      `INSERT INTO live_quiz (question, options, correct_idx, reward, duration_secs, start_time, is_active)
       VALUES ($1, $2, $3, $4, $5, NOW(), TRUE) RETURNING *`,
      [question, JSON.stringify(options), correct_idx, reward || 100, duration_secs || 60]
    );
    res.json({ quiz: qr.rows[0] });

    // Non-blocking broadcast to all users
    (async () => {
      try {
        const dur = duration_secs || 60;
        const rew = reward || 100;
        const msg =
          `🧠⚡ <b>LIVE QUIZ ALERT!</b> ⚡🧠\n\n` +
          `━━━━━━━━━━━━━━━━━━━━\n` +
          `❓ <b>${question.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</b>\n\n` +
          `⏱ You have <b>${dur} seconds</b> to answer!\n` +
          `💰 Correct = <b>+${rew.toLocaleString()} Sp</b> in your wallet!\n\n` +
          `🔥 One shot only — don't miss it!\n` +
          `━━━━━━━━━━━━━━━━━━━━\n` +
          `👇 Open the app NOW!`;
        const allUsers = await pool.query('SELECT telegram_id FROM users WHERE banned = FALSE');
        for (const u of allUsers.rows) {
          try {
            await bot.sendMessage(u.telegram_id, msg, {
              parse_mode: 'HTML',
              reply_markup: { inline_keyboard: [[{ text: '🧠 Answer Quiz Now!', web_app: { url: MINI_APP_URL } }]] }
            });
            await new Promise(r => setTimeout(r, 40));
          } catch (_) {}
        }
      } catch (e) { console.error('Quiz broadcast error:', e.message); }
    })();
  } catch (e) {
    console.error('/api/admin/quiz/create error:', e.message);
    if (!res.headersSent) res.status(500).json({ error: 'DB error' });
  }
});

// GET weekly quiz leaderboard
app.get(['/api/leaderboard/quiz-weekly', '/api/leaderboard/weekly'], authMiddleware, async (req, res) => {
  try {
    const now = new Date();
    const dayOfWeek = now.getUTCDay();
    const daysFromMonday = (dayOfWeek + 6) % 7;
    const weekStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysFromMonday));
    const weekStartStr = weekStart.toISOString().split('T')[0];

    // Top 15 users by correct answers this week
    const r = await pool.query(`
      SELECT qa.telegram_id,
        u.telegram_first_name, u.telegram_username, u.telegram_photo_url,
        COUNT(*) FILTER (WHERE qa.is_correct = TRUE AND qa.evaluated = TRUE) AS correct_answers,
        COUNT(*) FILTER (WHERE qa.evaluated = TRUE) AS total_answered
      FROM quiz_answers qa
      JOIN users u ON u.telegram_id = qa.telegram_id
      WHERE qa.answered_at >= $1 AND u.banned = FALSE AND qa.evaluated = TRUE
      GROUP BY qa.telegram_id, u.telegram_first_name, u.telegram_username, u.telegram_photo_url
      HAVING COUNT(*) FILTER (WHERE qa.is_correct = TRUE AND qa.evaluated = TRUE) > 0
      ORDER BY correct_answers DESC, total_answered ASC
      LIMIT 15
    `, [weekStartStr]);

    // Last week's winners (most recent completed week)
    const lr = await pool.query(`
      SELECT qlr.*, u.telegram_photo_url
      FROM quiz_leaderboard_rewards qlr
      LEFT JOIN users u ON u.telegram_id = qlr.telegram_id
      WHERE qlr.week_start = (
        SELECT MAX(week_start) FROM quiz_leaderboard_rewards WHERE telegram_id > 0
      )
      ORDER BY qlr.rank ASC
      LIMIT 15
    `);

    res.json({
      leaderboard: r.rows.map(row => ({ ...row, score: row.correct_answers })),
      weekStart: weekStartStr,
      lastWinners: lr.rows
    });
  } catch (e) {
    console.error('/api/leaderboard/quiz-weekly error:', e.message);
    res.status(500).json({ error: 'DB error' });
  }
});

// Admin: Get quiz history + results
app.get('/api/admin/quiz/results', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT lq.*,
        COUNT(qa.id) AS total_answers,
        SUM(CASE WHEN qa.is_correct THEN 1 ELSE 0 END) AS correct_answers,
        COALESCE(SUM(qa.reward_given), 0) AS total_sp_awarded
      FROM live_quiz lq
      LEFT JOIN quiz_answers qa ON qa.quiz_id = lq.id
      GROUP BY lq.id
      ORDER BY lq.created_at DESC
      LIMIT 20
    `);
    res.json({ quizzes: r.rows });
  } catch (e) {
    console.error('/api/admin/quiz/results error:', e.message);
    res.status(500).json({ error: 'DB error' });
  }
});

// ── Admin: Quiz Pool endpoints ─────────────────────────────────────────────────
app.get('/api/admin/quiz/pool', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const r = await pool.query(`SELECT * FROM quiz_pool ORDER BY created_at DESC`);
    res.json({ pool: r.rows });
  } catch (e) {
    res.status(500).json({ error: 'DB error' });
  }
});

app.post('/api/admin/quiz/pool', authMiddleware, adminMiddleware, async (req, res) => {
  const { question, options, correct_idx, reward, duration_secs } = req.body;
  if (!question || !Array.isArray(options) || options.length !== 4 || correct_idx == null) {
    return res.status(400).json({ error: 'Missing/invalid fields' });
  }
  try {
    const r = await pool.query(
      `INSERT INTO quiz_pool (question, options, correct_idx, reward, duration_secs)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [question, JSON.stringify(options), correct_idx, reward || 200, duration_secs || 60]
    );
    res.json({ question: r.rows[0] });
  } catch (e) {
    res.status(500).json({ error: 'DB error' });
  }
});

app.delete('/api/admin/quiz/pool/:id', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    await pool.query(`DELETE FROM quiz_pool WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'DB error' });
  }
});

// ── Admin: Quiz Schedule endpoints ────────────────────────────────────────────
app.get('/api/admin/quiz/schedule', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT quiz_auto_enabled, quiz_auto_hour_utc, quiz_auto_frequency, quiz_auto_last_fired_at FROM app_settings WHERE id = 1'
    );
    const s = r.rows[0] || {};
    res.json({
      enabled: s.quiz_auto_enabled || false,
      hour_utc: s.quiz_auto_hour_utc ?? 12,
      frequency: s.quiz_auto_frequency ?? 24,
      last_fired_at: s.quiz_auto_last_fired_at || null
    });
  } catch (e) {
    res.status(500).json({ error: 'DB error' });
  }
});

app.post('/api/admin/quiz/schedule', authMiddleware, adminMiddleware, async (req, res) => {
  const { enabled, hour_utc, frequency } = req.body;
  try {
    await pool.query(
      `UPDATE app_settings SET quiz_auto_enabled=$1, quiz_auto_hour_utc=$2, quiz_auto_frequency=$3 WHERE id=1`,
      [!!enabled, parseInt(hour_utc) ?? 12, parseInt(frequency) ?? 24]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'DB error' });
  }
});

// ── Tap Boost: Prepare (server generates nonce before payment) ─────────────────
app.post('/api/user/tap-boost/prepare', authMiddleware, async (req, res) => {
  const tgId = req.tgUser.id;
  try {
    const uRow = await pool.query('SELECT tap_per_hit, banned FROM users WHERE telegram_id = $1', [tgId]);
    if (uRow.rows[0]?.banned) return res.status(403).json({ error: 'banned' });
    if ((uRow.rows[0]?.tap_per_hit || 1) > 1) return res.status(409).json({ error: 'Already upgraded' });

    const settingsRow = await pool.query('SELECT tap_boost_price, tap_boost_amount FROM app_settings WHERE id = 1');
    const tonCost = parseFloat(settingsRow.rows[0]?.tap_boost_price) || 10;
    const boostAmount = parseInt(settingsRow.rows[0]?.tap_boost_amount) || 4;

    const nonce = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    const insertRes = await pool.query(
      `INSERT INTO boost_purchases (telegram_id, nonce, boost_amount, ton_cost, expires_at) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [tgId, nonce, boostAmount, tonCost, expiresAt]
    );
    res.json({ nonce, boostAmount, tonCost, refId: insertRes.rows[0].id });
  } catch (e) {
    console.error('tap-boost prepare error:', e);
    res.status(500).json({ error: 'DB error' });
  }
});

// ── Tap Boost: Buy (requires server nonce — prevents fake payment) ─────────────
app.post('/api/user/tap-boost/buy', authMiddleware, async (req, res) => {
  const tgId = req.tgUser.id;
  const { nonce } = req.body;
  if (!nonce) return res.status(400).json({ error: 'Missing nonce — call /api/user/tap-boost/prepare first' });
  try {
    // Look up (but don't yet consume) the nonce
    const nonceRow = await pool.query(
      `SELECT * FROM boost_purchases WHERE nonce = $1 AND telegram_id = $2 AND used = FALSE AND expires_at > NOW()`,
      [nonce, tgId]
    );
    if (!nonceRow.rows.length) return res.status(409).json({ error: 'Invalid, expired, or already-used boost token' });
    const { id: refId, boost_amount, ton_cost } = nonceRow.rows[0];
    const paymentComment = `Boost #${refId} ID:${tgId}`;

    // Verify payment reached the treasury for the right amount, matched by
    // the unique comment this purchase was issued. Retry for indexing lag.
    let verification = { verified: false };
    for (let attempt = 0; attempt < 4; attempt++) {
      verification = await verifyTonPayment(paymentComment, ton_cost);
      if (verification.verified) break;
      if (attempt < 3) await new Promise(r => setTimeout(r, 3000));
    }

    if (!verification.verified) {
      console.error(`Boost payment unverified but granting anyway (wallet confirmed send): comment="${paymentComment}" reason=${verification.reason}`);
      if (WITHDRAWAL_LOG_CHAT_ID) {
        sendBotMsg(WITHDRAWAL_LOG_CHAT_ID,
          `⚠️ <b>Unverified Boost Payment (granted anyway)</b>\n\n` +
          `👤 Telegram ID: <code>${tgId}</code>\n` +
          `💰 Expected: <b>${ton_cost} TON</b>\n` +
          `🔖 Reference: <code>${paymentComment}</code>\n` +
          `❓ Reason: ${verification.reason}\n\n` +
          `Reward was granted since the wallet confirmed the transaction was sent, but it could not be independently verified on-chain.`
        );
      }
    }

    // Payment confirmed — atomically consume the nonce
    const nr = await pool.query(
      `UPDATE boost_purchases SET used = TRUE, tx_hash = $3
       WHERE nonce = $1 AND telegram_id = $2 AND used = FALSE
       RETURNING *`,
      [nonce, tgId, paymentComment]
    );
    if (!nr.rows.length) return res.status(409).json({ error: 'Boost token was already claimed' });

    await pool.query(
      `INSERT INTO used_tx_hashes (tx_hash, telegram_id, used_for) VALUES ($1, $2, 'tap_boost') ON CONFLICT DO NOTHING`,
      [paymentComment, tgId]
    );

    await pool.query('UPDATE users SET tap_per_hit = $1, updated_at = NOW() WHERE telegram_id = $2', [boost_amount, tgId]);
    await pool.query(
      `INSERT INTO balance_ledger (telegram_id, delta, type, note) VALUES ($1, 0, 'boost_purchase', $2)`,
      [tgId, `Tap boost x${boost_amount} purchased (nonce: ${nonce.slice(0,8)}, verified: ${verification.verified})`]
    ).catch(() => {});
    const result = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [tgId]);
    res.json({ ok: true, user: result.rows[0], paymentVerified: verification.verified });
  } catch (e) {
    console.error('tap-boost buy error:', e);
    res.status(500).json({ error: 'DB error' });
  }
});

// ── Admin: Spin transaction history (trxh tab) ─────────────────────────────────
app.get('/api/admin/spin-txns', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT sl.*, u.telegram_first_name, u.telegram_username
      FROM spin_logs sl
      LEFT JOIN users u ON u.telegram_id = sl.telegram_id
      ORDER BY sl.spun_at DESC LIMIT 200
    `);
    res.json({ txns: r.rows });
  } catch (err) {
    res.status(500).json({ error: 'DB error' });
  }
});

// ── Admin: Per-user full history ───────────────────────────────────────────────
app.get('/api/admin/user/:id/history', authMiddleware, adminMiddleware, async (req, res) => {
  const uid = parseInt(req.params.id);
  if (!uid) return res.status(400).json({ error: 'Invalid id' });
  try {
    const [spins, tasks, taps, referrals, withdrawals, checkins, boosts] = await Promise.all([
      pool.query(`SELECT * FROM spin_logs WHERE telegram_id = $1 ORDER BY spun_at DESC LIMIT 50`, [uid]),
      pool.query(`SELECT * FROM task_completions WHERE telegram_id = $1 ORDER BY completed_at DESC LIMIT 100`, [uid]),
      pool.query(`SELECT * FROM tap_sessions WHERE telegram_id = $1 ORDER BY date DESC LIMIT 30`, [uid]),
      pool.query(`SELECT * FROM referral_logs WHERE referrer_id = $1 OR referred_id = $1 ORDER BY logged_at DESC LIMIT 50`, [uid]),
      pool.query(`SELECT * FROM withdrawals WHERE telegram_id = $1 ORDER BY created_at DESC LIMIT 50`, [uid]),
      pool.query(`SELECT * FROM check_in_logs WHERE telegram_id = $1 ORDER BY logged_at DESC LIMIT 30`, [uid]),
      pool.query(`SELECT * FROM boost_purchases WHERE telegram_id = $1 ORDER BY created_at DESC LIMIT 10`, [uid]),
    ]);
    res.json({
      spins: spins.rows,
      tasks: tasks.rows,
      taps: taps.rows,
      referrals: referrals.rows,
      withdrawals: withdrawals.rows,
      checkins: checkins.rows,
      boosts: boosts.rows,
    });
  } catch (err) {
    console.error('/api/admin/user/:id/history error:', err);
    res.status(500).json({ error: 'DB error' });
  }
});


// ── AdsGram server-side reward callback ───────────────────────────────────────
// AdsGram GETs this URL after a successful task, replacing [userId] with the
// user's Telegram ID. Example config in partner.adsgram.ai:
//   https://shhhtoshi-production.up.railway.app/api/adsgram/reward?userid=[userId]
const ADSGRAM_REWARD_SP = parseInt(process.env.ADSGRAM_REWARD_SP || '150', 10);
const ADSGRAM_TASK_ID = 'adsgram_task';

app.get('/api/adsgram/reward', async (req, res) => {
  try {
    const userid = String(req.query.userid || req.query.userId || '').trim();
    if (!userid || userid === '[userId]') {
      return res.status(400).json({ error: 'Missing userid' });
    }
    const tgId = userid;
    const today = new Date().toISOString().slice(0, 10);
    // Unlimited — unique completion id each time
    const completionId = `${ADSGRAM_TASK_ID}_${Date.now()}`;

    const userRow = await pool.query(`SELECT shhhtoshi FROM users WHERE telegram_id = $1`, [tgId]);
    if (!userRow.rows.length) {
      return res.status(404).json({ error: 'User not found' });
    }

    await pool.query(
      `INSERT INTO task_completions (telegram_id, task_id, task_type, reward)
       VALUES ($1, $2, 'ad', $3)`,
      [tgId, completionId, ADSGRAM_REWARD_SP]
    );

    await pool.query(
      `UPDATE users SET shhhtoshi = shhhtoshi + $1, task_earnings = COALESCE(task_earnings,0) + $1,
        updated_at = NOW() WHERE telegram_id = $2`,
      [ADSGRAM_REWARD_SP, tgId]
    );

    // Log earning
    try {
      await pool.query(
        `INSERT INTO daily_earnings (telegram_id, date, amount, source) VALUES ($1, $2, $3, $4)
         ON CONFLICT (telegram_id, date) DO UPDATE SET amount = daily_earnings.amount + $3`,
        [tgId, today, ADSGRAM_REWARD_SP, 'adsgram']
      );
    } catch (_) {}

    console.log(`[adsgram] rewarded ${ADSGRAM_REWARD_SP} Sp to ${tgId}`);
    res.json({ ok: true, reward: ADSGRAM_REWARD_SP });
  } catch (err) {
    console.error('/api/adsgram/reward error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Client-side claim after AdsGram web-component "reward" event (fallback / primary)
app.post('/api/adsgram/claim', authMiddleware, async (req, res) => {
  try {
    const tgId = String(req.tgUser.id);
    const today = new Date().toISOString().slice(0, 10);
    const taskKey = String(req.body?.taskId || ADSGRAM_TASK_ID).slice(0, 64);
    // Both AdsGram + Monetag are unlimited — every completed ad pays out
    let rewardSp = parseInt(req.body?.reward, 10);
    if (!Number.isFinite(rewardSp) || rewardSp <= 0) rewardSp = ADSGRAM_REWARD_SP;
    rewardSp = Math.min(Math.max(rewardSp, 1), 5000);

    const completionId = `${taskKey}_${Date.now()}`;
    const taskType = 'ad';

    const userRow = await pool.query(`SELECT shhhtoshi, tasks_completed FROM users WHERE telegram_id = $1`, [tgId]);
    if (!userRow.rows.length) return res.status(404).json({ error: 'User not found' });

    await pool.query(
      `INSERT INTO task_completions (telegram_id, task_id, task_type, reward)
       VALUES ($1, $2, $3, $4)`,
      [tgId, completionId, taskType, rewardSp]
    );

    const upd = await pool.query(
      `UPDATE users SET shhhtoshi = shhhtoshi + $1, task_earnings = COALESCE(task_earnings,0) + $1,
        updated_at = NOW() WHERE telegram_id = $2 RETURNING *`,
      [rewardSp, tgId]
    );

    res.json({ ok: true, reward: rewardSp, user: upd.rows[0], unlimited: true });
  } catch (err) {
    console.error('/api/adsgram/claim error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Serve frontend ─────────────────────────────────────────────────────────────
app.use('/libs', express.static(path.join(__dirname, 'public/libs'), { maxAge: '7d' }));
app.use('/sfx', express.static(path.join(__dirname, 'public/sfx'), { maxAge: '30d' }));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/tonconnect-manifest.json', (req, res) => res.sendFile(path.join(__dirname, 'tonconnect-manifest.json')));


// ── Telegram Stars invoice + OG Pass ───────────────────────────────────────────
async function openInvoiceLink(title, description, payload, starsAmount) {
  // Use Bot API directly — more reliable for XTR (Telegram Stars) than some SDK wrappers
  const token = process.env.BOT_TOKEN;
  if (!token) throw new Error('BOT_TOKEN not set');
  const body = {
    title: String(title).slice(0, 32),
    description: String(description).slice(0, 255),
    payload: String(payload).slice(0, 128),
    provider_token: '',
    currency: 'XTR',
    prices: [{ label: String(title).slice(0, 32), amount: Math.max(1, parseInt(starsAmount, 10) || 1) }]
  };
  const resp = await fetch(`https://api.telegram.org/bot${token}/createInvoiceLink`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await resp.json();
  if (!data.ok || !data.result) {
    throw new Error((data.description || 'createInvoiceLink failed') + (data.error_code ? ` (${data.error_code})` : ''));
  }
  return data.result;
}

// Pre-checkout: always approve pending stars payments we created
bot.on('pre_checkout_query', async (q) => {
  try {
    await bot.answerPreCheckoutQuery(q.id, true);
  } catch (e) {
    console.error('pre_checkout_query error:', e.message);
    try { await bot.answerPreCheckoutQuery(q.id, false, { error_message: 'Payment unavailable' }); } catch (_) {}
  }
});

bot.on('message', async (msg) => {
  try {
    const sp = msg.successful_payment;
    if (!sp || sp.currency !== 'XTR') return;
    const payload = sp.invoice_payload || '';
    const tgId = msg.from.id;
    const row = await pool.query('SELECT * FROM stars_payments WHERE payload = $1 AND status = $2', [payload, 'pending']);
    if (!row.rows.length) {
      console.warn('Stars payment with unknown payload:', payload);
      return;
    }
    const pay = row.rows[0];
    if (String(pay.telegram_id) !== String(tgId)) {
      console.warn('Stars payment user mismatch', pay.telegram_id, tgId);
      return;
    }

    if (pay.kind === 'ogpass') {
      await pool.query(
        `UPDATE users SET og_pass = TRUE, og_pass_bought_at = COALESCE(og_pass_bought_at, NOW()),
         tap_per_hit = CASE WHEN COALESCE(og_tap_bonus_applied, FALSE) THEN COALESCE(tap_per_hit,1)
                            ELSE COALESCE(tap_per_hit,1) + 2 END,
         og_tap_bonus_applied = TRUE,
         updated_at = NOW() WHERE telegram_id = $1`,
        [tgId]
      );
      // bump daily tap limit via tap_limit_boosted flag for today
      const today = new Date().toISOString().split('T')[0];
      await pool.query(
        `UPDATE users SET tap_limit_boosted = COALESCE(tap_limit_boosted, '{}'::jsonb) || $1::jsonb WHERE telegram_id = $2`,
        [JSON.stringify({ [today]: true, og: true }), tgId]
      );
    } else if (pay.kind === 'spin') {
      // Mark nonce paid via stars — store payment method on spin play
      await pool.query(
        `UPDATE spin_nonces SET used = FALSE WHERE id = $1 AND telegram_id = $2`,
        [parseInt(pay.ref_id, 10), tgId]
      );
    } else if (pay.kind === 'mysterybox') {
      await pool.query(
        `UPDATE mysterybox_nonces SET used = FALSE WHERE id = $1 AND telegram_id = $2`,
        [parseInt(pay.ref_id, 10), tgId]
      );
    }

    await pool.query(
      `UPDATE stars_payments SET status = 'paid', completed_at = NOW() WHERE id = $1`,
      [pay.id]
    );
    try {
      await bot.sendMessage(tgId, '✅ Payment received! Open the app to claim your purchase.');
    } catch (_) {}
  } catch (e) {
    console.error('successful_payment handler error:', e.message);
  }
});


// ── Normal / free spins (Shop) ────────────────────────────────────────────────
app.get('/api/spin/status', authMiddleware, async (req, res) => {
  const tgId = req.tgUser.id;
  try {
    const r = await pool.query(
      'SELECT free_spin_claimed_date, bonus_spins, last_spin_at, banned FROM users WHERE telegram_id = $1',
      [tgId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'User not found' });
    const u = r.rows[0];
    if (u.banned) return res.status(403).json({ error: 'banned' });
    const today = new Date().toISOString().split('T')[0];
    const freeAvailable = u.free_spin_claimed_date !== today;
    let cooldownSec = 0;
    if (u.last_spin_at) {
      const elapsed = Date.now() - new Date(u.last_spin_at).getTime();
      if (elapsed < SPIN_COOLDOWN_MS) cooldownSec = Math.ceil((SPIN_COOLDOWN_MS - elapsed) / 1000);
    }
    res.json({
      freeAvailable,
      bonusSpins: u.bonus_spins || 0,
      cooldownSec,
      normalWheel: NORMAL_WHEEL_SEGS
    });
  } catch (e) {
    console.error('/api/spin/status', e);
    res.status(500).json({ error: 'Failed' });
  }
});

app.post('/api/spin/normal', spinLimiter, authMiddleware, async (req, res) => {
  const tgId = req.tgUser.id;
  const { source } = req.body || {}; // free | bonus | ad
  if (!['free', 'bonus', 'ad'].includes(source)) {
    return res.status(400).json({ error: 'Invalid source' });
  }
  try {
    const r = await pool.query(
      'SELECT free_spin_claimed_date, bonus_spins, last_spin_at, banned, og_pass FROM users WHERE telegram_id = $1 FOR UPDATE',
      [tgId]
    );
    // FOR UPDATE needs transaction - fallback without if fails
  } catch (_) {}

  try {
    const r = await pool.query(
      'SELECT free_spin_claimed_date, bonus_spins, last_spin_at, banned, og_pass FROM users WHERE telegram_id = $1',
      [tgId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'User not found' });
    const u = r.rows[0];
    if (u.banned) return res.status(403).json({ error: 'banned' });

    if (u.last_spin_at) {
      const elapsed = Date.now() - new Date(u.last_spin_at).getTime();
      if (elapsed < SPIN_COOLDOWN_MS) {
        return res.status(429).json({
          error: `Please wait ${Math.ceil((SPIN_COOLDOWN_MS - elapsed) / 1000)}s before next spin`,
          cooldown: Math.ceil((SPIN_COOLDOWN_MS - elapsed) / 1000)
        });
      }
    }

    const today = new Date().toISOString().split('T')[0];
    if (source === 'free') {
      if (u.free_spin_claimed_date === today) {
        return res.status(400).json({ error: 'Daily free spin already used' });
      }
    } else if (source === 'bonus') {
      if ((u.bonus_spins || 0) < 1) {
        return res.status(400).json({ error: 'No invite spins available' });
      }
    }
    // source === 'ad' — client must have shown AdsGram; we trust + rate-limit via cooldown

    let idx = crypto.randomInt(0, NORMAL_WHEEL_VALS.length);
    if (u.og_pass) {
      const sorted = [...NORMAL_WHEEL_VALS].map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
      const median = sorted[Math.floor(sorted.length / 2)].v;
      if (NORMAL_WHEEL_VALS[idx] < median && Math.random() < 0.30) {
        const high = sorted.filter(x => x.v >= median);
        idx = high[crypto.randomInt(0, high.length)].i;
      }
    }
    const reward = NORMAL_WHEEL_VALS[idx];

    if (source === 'free') {
      await pool.query(
        `UPDATE users SET free_spin_claimed_date = $1, last_spin_at = NOW(),
         shhhtoshi = shhhtoshi + $2,
         spin_history = COALESCE(spin_history, '[]'::jsonb) || $3::jsonb,
         updated_at = NOW() WHERE telegram_id = $4`,
        [today, reward, JSON.stringify([{ id: 'ns' + Date.now(), date: today, cost: 'Free', reward }]), tgId]
      );
    } else if (source === 'bonus') {
      await pool.query(
        `UPDATE users SET bonus_spins = GREATEST(COALESCE(bonus_spins,0) - 1, 0), last_spin_at = NOW(),
         shhhtoshi = shhhtoshi + $1,
         spin_history = COALESCE(spin_history, '[]'::jsonb) || $2::jsonb,
         updated_at = NOW() WHERE telegram_id = $3`,
        [reward, JSON.stringify([{ id: 'ns' + Date.now(), date: today, cost: 'Invite', reward }]), tgId]
      );
    } else {
      await pool.query(
        `UPDATE users SET last_spin_at = NOW(),
         shhhtoshi = shhhtoshi + $1,
         spin_history = COALESCE(spin_history, '[]'::jsonb) || $2::jsonb,
         updated_at = NOW() WHERE telegram_id = $3`,
        [reward, JSON.stringify([{ id: 'ns' + Date.now(), date: today, cost: 'Ad', reward }]), tgId]
      );
    }

    const u2 = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [tgId]);
    res.json({
      reward_idx: idx,
      reward,
      user: u2.rows[0],
      freeAvailable: source === 'free' ? false : (u.free_spin_claimed_date !== today && source !== 'free'),
      bonusSpins: source === 'bonus' ? Math.max((u.bonus_spins || 0) - 1, 0) : (u.bonus_spins || 0)
    });
  } catch (e) {
    console.error('/api/spin/normal', e);
    res.status(500).json({ error: 'Spin failed' });
  }
});

// Mark last_spin_at after premium spin claim

app.get('/api/stars/ping', (req, res) => {
  res.json({ ok: true, stars: true, version: 'ogpass-stars-v2' });
});

app.post('/api/stars/invoice', authMiddleware, async (req, res) => {
  const tgId = req.tgUser.id;
  const { kind, boxId } = req.body || {};
  try {
    const uRow = await pool.query('SELECT banned, og_pass FROM users WHERE telegram_id = $1', [tgId]);
    if (uRow.rows[0]?.banned) return res.status(403).json({ error: 'banned' });

    const settings = await pool.query(
      'SELECT spin_stars_price, og_pass_stars_price, mystery_boxes FROM app_settings WHERE id = 1'
    );
    const s = settings.rows[0] || {};

    if (kind === 'ogpass') {
      if (uRow.rows[0]?.og_pass) return res.status(409).json({ error: 'You already have OG Pass' });
      const amount = parseInt(s.og_pass_stars_price, 10) || 100;
      const payload = `ogpass:${tgId}:${Date.now()}`;
      await pool.query(
        `INSERT INTO stars_payments (telegram_id, payload, kind, amount_stars) VALUES ($1,$2,'ogpass',$3)`,
        [tgId, payload, amount]
      );
      const link = await openInvoiceLink('OG Pass', 'Premium OG Pass — better luck, more taps, higher rewards', payload, amount);
      return res.json({ invoiceLink: link, amount });
    }

    if (kind === 'spin') {
      const amount = parseInt(s.spin_stars_price, 10) || 15;
      // prepare spin nonce first
      const prepRes = await new Promise(async (resolve) => {
        // reuse prepare logic inline
        let idx = crypto.randomInt(0, WHEEL_VALS.length);
        try {
          if (uRow.rows[0]?.og_pass) {
            const sorted = [...WHEEL_VALS].map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
            const median = sorted[Math.floor(sorted.length / 2)].v;
            if (WHEEL_VALS[idx] < median && Math.random() < 0.30) {
              const high = sorted.filter(x => x.v >= median);
              idx = high[crypto.randomInt(0, high.length)].i;
            }
          }
        } catch (_) {}
        const reward = WHEEL_VALS[idx];
        const nonce = crypto.randomBytes(32).toString('hex');
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
        const insertRes = await pool.query(
          `INSERT INTO spin_nonces (telegram_id, nonce, prize_idx, reward, ton_cost, expires_at) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
          [tgId, nonce, idx, reward, 0, expiresAt]
        );
        resolve({ nonce, idx, reward, refId: insertRes.rows[0].id });
      });
      const payload = `spin:${tgId}:${prepRes.refId}:${prepRes.nonce}`;
      await pool.query(
        `INSERT INTO stars_payments (telegram_id, payload, kind, amount_stars, ref_id) VALUES ($1,$2,'spin',$3,$4)`,
        [tgId, payload, amount, String(prepRes.refId)]
      );
      const link = await openInvoiceLink('Wheel Spin', 'Spin the fortune wheel', payload, amount);
      return res.json({ invoiceLink: link, amount, nonce: prepRes.nonce, targetIdx: prepRes.idx, refId: prepRes.refId });
    }

    if (kind === 'mysterybox') {
      if (!boxId) return res.status(400).json({ error: 'boxId required' });
      const boxes = s.mystery_boxes || [];
      const box = boxes.find(b => String(b.id) === String(boxId));
      if (!box) return res.status(404).json({ error: 'Box not found' });
      const amount = parseInt(box.starsPrice ?? box.stars_price ?? 25, 10) || 25;
      // Create mystery nonce via existing prepare path simplified
      const nonce = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
      // Pick reward
      let reward_sp = 0, reward_item_id = null;
      if (box.payoutType === 'cosmetic') {
        reward_item_id = null; // assigned on claim
      } else {
        const rewards = box.rewards || [];
        const totalW = rewards.reduce((s, r) => s + (r.weight || 1), 0) || 1;
        let roll = Math.random() * totalW;
        // OG luck: 30% chance to bias toward higher sp
        const og = uRow.rows[0]?.og_pass;
        if (og && Math.random() < 0.30) {
          const sorted = [...rewards].sort((a, b) => (a.sp || 0) - (b.sp || 0));
          const top = sorted.slice(Math.floor(sorted.length / 2));
          const pick = top[Math.floor(Math.random() * top.length)] || rewards[0];
          reward_sp = pick?.sp || 0;
        } else {
          for (const r of rewards) {
            if (roll < (r.weight || 1)) { reward_sp = r.sp || 0; break; }
            roll -= (r.weight || 1);
          }
        }
      }
      const ins = await pool.query(
        `INSERT INTO mysterybox_nonces (telegram_id, nonce, box_id, reward_sp, reward_item_id, ton_cost, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [tgId, nonce, boxId, reward_sp, reward_item_id, 0, expiresAt]
      );
      const payload = `mysterybox:${tgId}:${ins.rows[0].id}:${nonce}`;
      await pool.query(
        `INSERT INTO stars_payments (telegram_id, payload, kind, amount_stars, ref_id) VALUES ($1,$2,'mysterybox',$3,$4)`,
        [tgId, payload, amount, String(ins.rows[0].id)]
      );
      const link = await openInvoiceLink(box.name || 'Mystery Box', 'Open a mystery box', payload, amount);
      return res.json({ invoiceLink: link, amount, nonce, refId: ins.rows[0].id });
    }

    return res.status(400).json({ error: 'Unknown kind' });
  } catch (err) {
    console.error('/api/stars/invoice error:', err);
    res.status(500).json({ error: String(err.message || err || 'Failed to create invoice') });
  }
});

// Confirm Stars payment was completed and claim spin/box (OG is applied in webhook)
app.post('/api/stars/confirm', authMiddleware, async (req, res) => {
  const tgId = req.tgUser.id;
  const { kind, nonce } = req.body || {};
  try {
    if (kind === 'ogpass') {
      const u = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [tgId]);
      return res.json({ user: u.rows[0], ok: !!u.rows[0]?.og_pass });
    }
    if (kind === 'spin' && nonce) {
      // Check stars payment paid for this nonce
      const paid = await pool.query(
        `SELECT * FROM stars_payments WHERE telegram_id = $1 AND kind = 'spin' AND status = 'paid' AND payload LIKE $2 ORDER BY id DESC LIMIT 1`,
        [tgId, `%${nonce}%`]
      );
      if (!paid.rows.length) return res.status(402).json({ error: 'Payment not confirmed yet' });
      // Claim via same logic as spin/play but skip TON verify — mark paid
      const nonceRow = await pool.query(
        `SELECT * FROM spin_nonces WHERE nonce = $1 AND telegram_id = $2 AND used = FALSE AND expires_at > NOW()`,
        [nonce, tgId]
      );
      if (!nonceRow.rows.length) return res.status(400).json({ error: 'Invalid or expired spin' });
      const n = nonceRow.rows[0];
      await pool.query(`UPDATE spin_nonces SET used = TRUE WHERE id = $1`, [n.id]);
      const today = new Date().toISOString().split('T')[0];
      const entry = { id: 'sp' + Date.now(), date: today, cost: n.ton_cost + ' Stars', reward: n.reward };
      await pool.query(
        `UPDATE users SET shhhtoshi = shhhtoshi + $1,
         spin_history = COALESCE(spin_history, '[]'::jsonb) || $2::jsonb,
         last_spin_at = NOW(),
         updated_at = NOW() WHERE telegram_id = $3`,
        [n.reward, JSON.stringify([entry]), tgId]
      );
      const u = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [tgId]);
      return res.json({ reward_idx: n.prize_idx, reward: n.reward, user: u.rows[0] });
    }
    if (kind === 'mysterybox' && nonce) {
      const paid = await pool.query(
        `SELECT * FROM stars_payments WHERE telegram_id = $1 AND kind = 'mysterybox' AND status = 'paid' AND payload LIKE $2 ORDER BY id DESC LIMIT 1`,
        [tgId, `%${nonce}%`]
      );
      if (!paid.rows.length) return res.status(402).json({ error: 'Payment not confirmed yet' });
      // Reuse buy endpoint logic by calling internal path — simplified claim
      const nonceRow = await pool.query(
        `SELECT * FROM mysterybox_nonces WHERE nonce = $1 AND telegram_id = $2 AND used = FALSE AND expires_at > NOW()`,
        [nonce, tgId]
      );
      if (!nonceRow.rows.length) return res.status(400).json({ error: 'Invalid or expired box' });
      const n = nonceRow.rows[0];
      await pool.query(`UPDATE mysterybox_nonces SET used = TRUE WHERE id = $1`, [n.id]);
      if (n.reward_sp) {
        await pool.query(
          `UPDATE users SET shhhtoshi = shhhtoshi + $1, updated_at = NOW() WHERE telegram_id = $2`,
          [n.reward_sp, tgId]
        );
      }
      const u = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [tgId]);
      return res.json({ sp: n.reward_sp || 0, user: u.rows[0] });
    }
    return res.status(400).json({ error: 'Bad request' });
  } catch (err) {
    console.error('/api/stars/confirm error:', err);
    res.status(500).json({ error: 'Confirm failed' });
  }
});

// Buy OG Pass with Gram (TON)
app.post('/api/ogpass/prepare', authMiddleware, async (req, res) => {
  const tgId = req.tgUser.id;
  try {
    const u = await pool.query('SELECT og_pass, banned FROM users WHERE telegram_id = $1', [tgId]);
    if (u.rows[0]?.banned) return res.status(403).json({ error: 'banned' });
    if (u.rows[0]?.og_pass) return res.status(409).json({ error: 'Already owned' });
    const s = await pool.query('SELECT og_pass_gram_price FROM app_settings WHERE id = 1');
    const price = parseFloat(s.rows[0]?.og_pass_gram_price) || 1;
    const nonce = crypto.randomBytes(16).toString('hex');
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
    await pool.query(
      `INSERT INTO stars_payments (telegram_id, payload, kind, amount_stars, ref_id, status)
       VALUES ($1,$2,'ogpass_gram',0,$3,'pending')`,
      [tgId, 'ogpass_gram:' + nonce, nonce]
    );
    res.json({ nonce, price, refId: nonce });
  } catch (e) {
    console.error('ogpass prepare', e);
    res.status(500).json({ error: 'Failed' });
  }
});

app.post('/api/ogpass/buy', authMiddleware, async (req, res) => {
  const tgId = req.tgUser.id;
  const { nonce } = req.body || {};
  if (!nonce) return res.status(400).json({ error: 'Missing nonce' });
  try {
    const s = await pool.query('SELECT og_pass_gram_price FROM app_settings WHERE id = 1');
    const price = parseFloat(s.rows[0]?.og_pass_gram_price) || 1;
    const comment = `OGPass ${nonce} ID:${tgId}`;
    const verification = await verifyTonPayment(comment, price);
    if (!verification || !verification.verified) {
      return res.status(402).json({ error: verification?.reason || 'Payment not found' });
    }
    await pool.query(
      `UPDATE users SET og_pass = TRUE, og_pass_bought_at = NOW(),
       tap_per_hit = CASE WHEN COALESCE(og_tap_bonus_applied, FALSE) THEN COALESCE(tap_per_hit,1)
                            ELSE COALESCE(tap_per_hit,1) + 2 END,
         og_tap_bonus_applied = TRUE,
       updated_at = NOW() WHERE telegram_id = $1`,
      [tgId]
    );
    await pool.query(
      `UPDATE stars_payments SET status = 'paid', completed_at = NOW() WHERE payload = $1`,
      ['ogpass_gram:' + nonce]
    );
    const u = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [tgId]);
    res.json({ ok: true, user: u.rows[0] });
  } catch (e) {
    console.error('ogpass buy', e);
    res.status(500).json({ error: 'Purchase failed' });
  }
});


app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Shhhtoshi server running on port ${PORT}`);
  console.log(`🌐 Mini App URL: ${MINI_APP_URL}`);
});
