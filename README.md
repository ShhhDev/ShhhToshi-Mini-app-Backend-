# ShhhToshi Backend

Telegram Mini App API and bot service for **ShhhToshi**.

Built with Node.js, Express, and PostgreSQL. Designed for deployment on **Railway** with a **Supabase** database and a separately hosted frontend.

**Developer:** ShhhDev

---

## Stack

| Layer        | Technology              |
|-------------|-------------------------|
| Runtime     | Node.js                 |
| API         | Express                 |
| Database    | PostgreSQL (Supabase)   |
| Bot         | node-telegram-bot-api   |
| Hosting     | Railway                 |

---

## Project structure

```
├── server.js           # Express API + app bootstrap
├── bot.js              # Telegram bot handlers
├── db.js               # Database pool
├── seed-cosmetics.js   # Optional cosmetics seed script
├── package.json
└── .env.example        # Environment variable template
```

---

## Requirements

- Node.js 18+
- PostgreSQL database (Supabase recommended)
- Telegram bot token from [@BotFather](https://t.me/BotFather)
- Frontend deployed separately (e.g. Netlify)

---

## Environment variables

Configure these in Railway → **Variables**, or in a local `.env` file.

| Variable | Required | Description |
|----------|----------|-------------|
| `BOT_TOKEN` | Yes | Telegram bot token |
| `ADMIN_TELEGRAM_ID` | Yes | Admin Telegram numeric user ID |
| `DATABASE_URL` | Yes | Supabase Session Pooler connection URI |
| `MINI_APP_URL` | Yes | Public frontend URL |
| `NODE_ENV` | Yes | Use `production` on Railway |
| `ADMIN_PANEL_PASSWORD_SEED` | Optional | Initial admin panel password (hashed on first boot) |
| `TONCENTER_API_KEY` | Optional | TonCenter API key for payment checks |
| `WITHDRAWAL_LOG_CHAT_ID` | Optional | Channel/group ID for withdrawal logs |

`PORT` is assigned automatically by Railway. Do not set it in production.

See `.env.example` for a ready-to-copy template. **Never commit real secrets.**

---

## Database

On startup the server creates required tables if they do not exist.  
No manual schema setup is required for a new database.

For existing projects, point `DATABASE_URL` at your current Supabase instance to keep all user data.

---

## Deploy on Railway

1. Create a new project on [Railway](https://railway.app).
2. Deploy this repository (or upload this folder) as a service.
3. Add the environment variables listed above.
4. Deploy and open **Settings → Networking** to generate a public domain.
5. Use that domain as `API_BASE` in the frontend.

Start command (from `package.json`):

```bash
npm start
```

---

## Local development

```bash
cp .env.example .env
# Fill in .env with your values

npm install
npm start
```

The API listens on `PORT` (default `5000` locally if unset).

---

## Frontend connection

The mini app frontend must call this API using your Railway public URL:

```ts
export const API_BASE = "https://your-service.up.railway.app";
```

`MINI_APP_URL` on the backend must match the live frontend origin for CORS and Telegram web app buttons.

---

## Scripts

| Command | Description |
|---------|-------------|
| `npm start` | Start API and bot |
| `npm run bot` | Run bot module only |
| `node seed-cosmetics.js` | Seed cosmetics catalog (optional) |

---

## Security notes

- Keep `.env` and Railway variables private.
- Do not publish bot tokens, database URIs, or admin passwords.
- Rotate credentials if they were ever exposed in a public repo.

---

## License

Private project. All rights reserved.

**ShhhDev** · ShhhToshi
