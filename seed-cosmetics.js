// One-time seed script — populates the cosmetics catalog with the starter
// items you listed, using ON CONFLICT DO NOTHING so it's safe to re-run
// (it will never overwrite anything you've since edited/deleted in the
// admin panel).
//
// Run once after deploying the migration:
//   node seed-cosmetics.js

const pool = require('./db');

const items = [
  // ── Block skins ──────────────────────────────────────────────────────
  { id: 'skin_classic',   category: 'block_skin', rarity: 'common',    name: 'Classic',   source: 'default' },
  { id: 'skin_lava',      category: 'block_skin', rarity: 'rare',      name: 'Lava 🔥',    source: 'shop', shhht_price: 500 },
  { id: 'skin_water',     category: 'block_skin', rarity: 'rare',      name: 'Water 💧',   source: 'shop', shhht_price: 500 },
  { id: 'skin_ice',       category: 'block_skin', rarity: 'rare',      name: 'Ice ❄️',     source: 'shop', shhht_price: 500 },
  { id: 'skin_lightning', category: 'block_skin', rarity: 'epic',      name: 'Lightning ⚡', source: 'mysterybox' },
  { id: 'skin_galaxy',    category: 'block_skin', rarity: 'epic',      name: 'Galaxy 🌌',  source: 'mysterybox' },
  { id: 'skin_crystal',   category: 'block_skin', rarity: 'epic',      name: 'Crystal 💎', source: 'quest' },
  { id: 'skin_emerald',   category: 'block_skin', rarity: 'rare',      name: 'Emerald 🍀', source: 'streak' },
  { id: 'skin_rainbow',   category: 'block_skin', rarity: 'legendary', name: 'Rainbow 🌈', source: 'milestone' },
  { id: 'skin_gold',      category: 'block_skin', rarity: 'mythic',    name: 'Gold 👑',    source: 'milestone' },

  // ── Board themes ─────────────────────────────────────────────────────
  { id: 'theme_classic',    category: 'board_theme', rarity: 'common',    name: 'Classic',         source: 'default' },
  { id: 'theme_space',      category: 'board_theme', rarity: 'rare',      name: 'Space',           source: 'shop', shhht_price: 750 },
  { id: 'theme_underwater', category: 'board_theme', rarity: 'rare',      name: 'Underwater',      source: 'shop', shhht_price: 750 },
  { id: 'theme_volcano',    category: 'board_theme', rarity: 'epic',      name: 'Volcano',         source: 'mysterybox' },
  { id: 'theme_jungle',     category: 'board_theme', rarity: 'rare',      name: 'Jungle',          source: 'quest' },
  { id: 'theme_cyberpunk',  category: 'board_theme', rarity: 'epic',      name: 'Cyberpunk',       source: 'mysterybox' },
  { id: 'theme_winter',     category: 'board_theme', rarity: 'rare',      name: 'Winter',          source: 'seasonal' },
  { id: 'theme_neon',       category: 'board_theme', rarity: 'epic',      name: 'Neon',            source: 'milestone' },
  { id: 'theme_shhhtoshi',  category: 'board_theme', rarity: 'legendary', name: 'ShhhToshi Theme', source: 'milestone' },

  // ── Visual effects ───────────────────────────────────────────────────
  { id: 'fx_combo_explosion', category: 'effect', rarity: 'rare',      name: 'Combo Explosion',       source: 'shop', shhht_price: 400 },
  { id: 'fx_sparkle',         category: 'effect', rarity: 'common',    name: 'Sparkle',                source: 'shop', shhht_price: 200 },
  { id: 'fx_fire_trail',      category: 'effect', rarity: 'epic',      name: 'Fire Trail',             source: 'mysterybox' },
  { id: 'fx_lightning_clear', category: 'effect', rarity: 'legendary', name: 'Lightning Clear',        source: 'milestone' },
  { id: 'fx_rainbow_clear',   category: 'effect', rarity: 'mythic',    name: 'Rainbow Clear',          source: 'milestone' },

  // ── Profile customization ────────────────────────────────────────────
  { id: 'frame_bronze', category: 'avatar_frame', rarity: 'common',    name: 'Bronze Frame',   source: 'streak' },
  { id: 'frame_silver', category: 'avatar_frame', rarity: 'rare',      name: 'Silver Frame',   source: 'streak' },
  { id: 'frame_gold',   category: 'avatar_frame', rarity: 'epic',      name: 'Gold Frame',     source: 'milestone' },
  { id: 'badge_puzzle_master', category: 'badge', rarity: 'epic',      name: 'Puzzle Master',  source: 'milestone' },
  { id: 'badge_block_king',   category: 'badge', rarity: 'legendary',  name: 'Block King',     source: 'milestone' },
  { id: 'namecolor_gold', category: 'name_color', rarity: 'rare',      name: 'Gold Name',      source: 'shop', shhht_price: 1000 },
  { id: 'namecolor_rainbow', category: 'name_color', rarity: 'legendary', name: 'Rainbow Name', source: 'mysterybox' },
  { id: 'title_puzzle_master', category: 'title', rarity: 'epic',      name: 'Puzzle Master',  source: 'milestone' },
  { id: 'title_block_king',    category: 'title', rarity: 'legendary', name: 'Block King',     source: 'milestone' }
];

async function seed() {
  let inserted = 0, skipped = 0;
  for (const item of items) {
    const r = await pool.query(
      `INSERT INTO cosmetic_items (id, category, rarity, name, source, shhht_price)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (id) DO NOTHING RETURNING id`,
      [item.id, item.category, item.rarity, item.name, item.source, item.shhht_price ?? null]
    );
    if (r.rows.length) inserted++; else skipped++;
  }
  console.log(`✅ Cosmetics seed complete — inserted ${inserted}, skipped ${skipped} (already existed).`);
  await pool.end();
}

seed().catch(err => {
  console.error('Seed failed:', err);
  process.exit(1);
});
