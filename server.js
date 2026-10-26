
const express = require("express");
const { Pool } = require("pg");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;
const DATABASE_URL = process.env.DATABASE_URL;

if (!BOT_TOKEN || !WEBHOOK_SECRET || !DATABASE_URL) {
  throw new Error(
    "Missing required environment variables: TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, DATABASE_URL"
  );
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function telegram(method, data) {
  const response = await fetch(
    `https://api.telegram.org/bot${BOT_TOKEN}/${method}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data)
    }
  );

  const result = await response.json();

  if (!response.ok || !result.ok) {
    throw new Error(`Telegram API error: ${JSON.stringify(result)}`);
  }

  return result;
}

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS hert_users (
      telegram_id BIGINT PRIMARY KEY,
      username TEXT,
      balance NUMERIC(20, 4) NOT NULL DEFAULT 0,
      mining_started_at TIMESTAMPTZ,
      last_mining_update TIMESTAMPTZ,
      last_checkin_date DATE
    )
  `);
}

async function getUser(user) {
  await pool.query(
    `INSERT INTO hert_users (telegram_id, username)
     VALUES ($1, $2)
     ON CONFLICT (telegram_id)
     DO UPDATE SET username = EXCLUDED.username`,
    [user.id, user.username || null]
  );
}

async function updateMiningRewards(userId) {
  await pool.query(
    `UPDATE hert_users
     SET balance = balance +
       LEAST(
         24,
         GREATEST(
           0,
           FLOOR(
             EXTRACT(
               EPOCH FROM (
                 NOW() - COALESCE(last_mining_update, NOW())
               )
             ) / 3600
           )
         )
       ),
       last_mining_update = NOW()
     WHERE telegram_id = $1
       AND mining_started_at IS NOT NULL`,
    [userId]
  );
}

async function getBalance(userId) {
  const result = await pool.query(
    "SELECT balance FROM hert_users WHERE telegram_id = $1",
    [userId]
  );

  return Number(result.rows[0]?.balance || 0).toFixed(4);
}

async function sendMenu(chatId, message) {
  return telegram("sendMessage", {
    chat_id: chatId,
    text: message,
    reply_markup: {
      inline_keyboard: [
        [
          { text: "⛏️ Start Mining", callback_data: "mine" },
          { text: "📅 Daily Check-in", callback_data: "checkin" }
        ],
        [
          { text: "💰 My Balance", callback_data: "balance" }
        ]
      ]
    }
  });
}

app.get("/", (req, res) => {
  res.status(200).send("HERT Mining backend is running.");
});

app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok", database: "connected" });
  } catch (error) {
    console.error("Health check failed:", error.message);
    res.status(500).json({
      status: "error",
      database: "disconnected"
    });
  }
});

app.post("/telegram/webhook", async (req, res) => {
  if (
    req.get("X-Telegram-Bot-Api-Secret-Token") !== WEBHOOK_SECRET
  ) {
    return res.sendStatus(401);
  }

  res.sendStatus(200);

  try {
    const update = req.body;

    if (update.message) {
      const message = update.message;
      const user = message.from;

      if (!user || !message.chat) return;

      await getUser(user);

      await sendMenu(
        message.chat.id,
        message.text === "/start"
          ? "Welcome to HERT Mining! ⛏️\nChoose an option below."
          : "Welcome to HERT Mining! Choose an option below."
      );

      return;
    }

    if (!update.callback_query) return;

    const query = update.callback_query;
    const user = query.from;
    const chatId = query.message?.chat?.id;

    if (!user || !chatId) return;

    await telegram("answerCallbackQuery", {
      callback_query_id: query.id
    });

    await getUser(user);

    if (query.data === "mine") {
      await pool.query(
        `UPDATE hert_users
         SET mining_started_at = COALESCE(mining_started_at, NOW()),
             last_mining_update = COALESCE(last_mining_update, NOW())
         WHERE telegram_id = $1`,
        [user.id]
      );

      await sendMenu(
        chatId,
        "⛏️ HERT mining has started!\nCheck your balance later to collect eligible mining rewards."
      );

      return;
    }

    if (query.data === "balance") {
      await updateMiningRewards(user.id);
      const balance = await getBalance(user.id);

      await sendMenu(
        chatId,
        `💰 Your HERT balance: ${balance}`
      );

      return;
    }

    if (query.data === "checkin") {
      const result = await pool.query(
        `UPDATE hert_users
         SET balance = balance + 10,
             last_checkin_date = CURRENT_DATE
         WHERE telegram_id = $1
           AND (
             last_checkin_date IS NULL
             OR last_checkin_date < CURRENT_DATE
           )
         RETURNING balance`,
        [user.id]
      );

      if (result.rowCount > 0) {
        const balance = Number(result.rows[0].balance).toFixed(4);

        await sendMenu(
          chatId,
          `✅ Daily check-in successful!\nYou received 10 HERT.\n💰 Balance: ${balance}`
        );
      } else {
        await sendMenu(
          chatId,
          "📅 You have already checked in today. Come back tomorrow!"
        );
      }
    }
  } catch (error) {
    console.error("Webhook error:", error.message);
  }
});

async function startServer() {
  await initDatabase();

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`HERT backend running on port ${PORT}`);
  });
}

startServer().catch((error) => {
  console.error("Startup error:", error);
  process.exit(1);
});
