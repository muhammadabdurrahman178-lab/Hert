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
  ssl: { rejectUnauthorized: false }
});

let botUsername = process
