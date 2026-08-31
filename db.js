const { Pool } = require('pg');

// Supabase's Postgres always requires SSL, so we enable it whenever the
// connection string points at Supabase, or when NODE_ENV=production.
const isSupabase = /supabase\.(co|com)/.test(process.env.DATABASE_URL || '');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: (isSupabase || process.env.NODE_ENV === 'production')
    ? { rejectUnauthorized: false }
    : false
});

module.exports = pool;
