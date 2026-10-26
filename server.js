
const express = require("express");
const { Pool } = require("pg");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;
const DATABASE_URL = process.env.DATABASE_URL;

const HOURLY_REWARD = 1;
const DAILY_REWARD = 10;
const REFERRAL_REWARD = 25;

if (!BOT_TOKEN || !WEBHOOK_SECRET || !DATABASE_URL) {
  throw new Error(
    "Missing TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET or DATABASE_URL"
  );
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
  connectionTimeoutMillis: 10000
});

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      telegram_id BIGINT PRIMARY KEY,
      username TEXT,
      points BIGINT NOT NULL DEFAULT 0,
      referred_by BIGINT,
      last_mine TIMESTAMPTZ,
      last_checkin DATE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS referral_rewards (
      invited_user BIGINT PRIMARY KEY,
      referrer BIGINT NOT NULL,
      rewarded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function telegram(method, body = {}) {
  const response = await fetch(
    `https://api.telegram.org/bot${BOT_TOKEN}/${method}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }
  );

  const data = await response.json();

  if (!data.ok) {
    console.error("Telegram API error:", data.description);
  }

  return data;
}

async function sendMessage(chatId, text, keyboard) {
  const body = {
    chat_id: chatId,
    text,
    reply_markup: {
      keyboard: keyboard || [
        [{ text: "⛏️ Start Mining" }, { text: "🎁 Daily Check-in" }],
        [{ text: "👥 Invite Friends" }, { text: "💰 My Balance" }]
      ],
      resize_keyboard: true
    }
  };

  return telegram("sendMessage", body);
}

async function getUser(telegramId, username, referrerId = null) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(
      `INSERT INTO users (telegram_id, username, referred_by)
       VALUES ($1, $2, $3)
       ON CONFLICT (telegram_id)
       DO UPDATE SET username = EXCLUDED.username`,
      [
        telegramId,
        username || null,
        referrerId && String(referrerId) !== String(telegramId)
          ? referrerId
          : null
      ]
    );

    if (referrerId && String(referrerId) !== String(telegramId)) {
      const referrer = await client.query(
        "SELECT telegram_id FROM users WHERE telegram_id = $1 FOR UPDATE",
        [referrerId]
      );

      if (referrer.rowCount) {
        const reward = await client.query(
          `INSERT INTO referral_rewards (invited_user, referrer)
           VALUES ($1, $2)
           ON CONFLICT (invited_user) DO NOTHING
           RETURNING invited_user`,
          [telegramId, referrerId]
        );

        if (reward.rowCount) {
          await client.query(
            "UPDATE users SET points = points + $1 WHERE telegram_id = $2",
            [REFERRAL_REWARD, referrerId]
          );
        }
      }
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  const result = await pool.query(
    "SELECT * FROM users WHERE telegram_id = $1",
    [telegramId]
  );

  return result.rows[0];
}

async function handleMessage(message) {
  if (!message || !message.chat || !message.from) return;

  const chatId = message.chat.id;
  const userId = message.from.id;
  const username = message.from.username || message.from.first_name || "";

  const text = (message.text || "").trim();

  if (text.startsWith("/start")) {
    const parts = text.split(/\s+/);
    let referrerId = null;

    if (parts[1] && /^\d+$/.test(parts[1])) {
      referrerId = parts[1];
    }

    const user = await getUser(userId, username, referrerId);

    const botInfo = await telegram("getMe");
    const botUsername = botInfo.result?.username || "YOUR_BOT_USERNAME";

    const inviteLink =
      `https://t.me/${botUsername}?start=${userId}`;

    await sendMessage(
      chatId,
      `👋 Welcome to HERT Mining!\n\n` +
      `💰 Your points: ${user.points}\n\n` +
      `⛏️ Tap Start Mining to earn points.\n` +
      `🎁 Daily Check-in gives ${DAILY_REWARD} points once a day.\n` +
      `👥 Invite friends to earn ${REFERRAL_REWARD} points for each eligible new user.\n\n` +
      `🔗 Your invite link:\n${inviteLink}`
    );
    return;
  }

  const user = await getUser(userId, username);

  if (
    text === "⛏️ Start Mining" ||
    text === "/mine" ||
    text === "Mine"
  ) {
    const result = await pool.query(
      `UPDATE users
       SET points = points + $1, last_mine = NOW()
       WHERE telegram_id = $2
         AND (
           last_mine IS NULL
           OR last_mine <= NOW() - INTERVAL '1 hour'
         )
       RETURNING points`,
      [HOURLY_REWARD, userId]
    );

    if (!result.rowCount) {
      await sendMessage(
        chatId,
        "⏳ You have already mined this hour. Please try again later."
      );
      return;
    }

    await sendMessage(
      chatId,
      `⛏️ Mining successful!\n+${HOURLY_REWARD} point\n💰 Balance: ${result.rows[0].points}`
    );
    return;
  }

  if (
    text === "🎁 Daily Check-in" ||
    text === "/daily" ||
    text === "Daily Check-in"
  ) {
    const result = await pool.query(
      `UPDATE users
       SET points = points + $1, last_checkin = CURRENT_DATE
       WHERE telegram_id = $2
         AND (last_checkin IS NULL OR last_checkin < CURRENT_DATE)
       RETURNING points`,
      [DAILY_REWARD, userId]
    );

    if (!result.rowCount) {
      await sendMessage(chatId, "✅ You have already checked in today.");
      return;
    }

    await sendMessage(
      chatId,
      `🎁 Daily check-in successful!\n+${DAILY_REWARD} points\n💰 Balance: ${result.rows[0].points}`
    );
    return;
  }

  if (
    text === "👥 Invite Friends" ||
    text === "/invite" ||
    text === "Invite Friends"
  ) {
    const botInfo = await telegram("getMe");
    const botUsername = botInfo.result?.username || "YOUR_BOT_USERNAME";
    const inviteLink = `https://t.me/${botUsername}?start=${userId}`;

    await sendMessage(
      chatId,
      `👥 Invite friends to HERT Mining!\n\n` +
      `Your link:\n${inviteLink}\n\n` +
      `You earn ${REFERRAL_REWARD} points for each eligible new user.`
    );
    return;
  }

  if (
    text === "💰 My Balance" ||
    text === "/balance" ||
    text === "Balance"
  ) {
    await sendMessage(
      chatId,
      `💰 Your HERT points: ${user.points}`
    );
    return;
  }

  await sendMessage(
    chatId,
    "Choose an option from the menu below."
  );
}

app.get("/", (req, res) => {
  res.send("HERT Mining backend is running.");
});

app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok", database: "connected" });
  } catch (error) {
    console.error("Health check failed:", error.message);
    res.status(503).json({ status: "error", database: "disconnected" });
  }
});

app.post("/telegram/webhook", async (req, res) => {
  if (
    req.get("x-telegram-bot-api-secret-token") !== WEBHOOK_SECRET
  ) {
    return res.sendStatus(401);
  }

  res.sendStatus(200);

  try {
    if (req.body && req.body.message) {
      await handleMessage(req.body.message);
    }
  } catch (error) {
    console.error("Webhook processing error:", error);
  }
});

async function startServer() {
  await initDatabase();

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`HERT backend running on port ${PORT}`);
  });
}

startServer().catch((error) => {
  console.error("Startup failed:", error);
  process.exit(1);
});
