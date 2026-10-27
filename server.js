'use strict';

const crypto = require('crypto');
const dns = require('dns');
const express = require('express');
const { Pool } = require('pg');

dns.setDefaultResultOrder('ipv4first');

function cleanEnv(raw) {
  if (!raw) return '';
  return String(raw).trim().replace(/^['"]+|['"]+$/g, '').trim();
}

const PORT = Number(process.env.PORT || 3000);
const DATABASE_URL = cleanEnv(process.env.DATABASE_URL);
const BOT_TOKEN = cleanEnv(process.env.TELEGRAM_BOT_TOKEN);
const BOT_USERNAME = cleanEnv(process.env.TELEGRAM_BOT_USERNAME || 'HERTCoinBot').replace(/^@/, '');
const MINI_APP_SHORT_NAME = cleanEnv(process.env.TELEGRAM_MINI_APP_SHORT_NAME || 'Hert').replace(/^\/+|\/+$/g, '');
const WEBHOOK_SECRET = cleanEnv(process.env.TELEGRAM_WEBHOOK_SECRET);
const PUBLIC_WEBAPP_URL = cleanEnv(
  process.env.PUBLIC_WEBAPP_URL || process.env.WEBAPP_URL || 'https://hert-mining.ai.studio'
).replace(/\/+$/, '');
const RENDER_EXTERNAL_URL = cleanEnv(process.env.RENDER_EXTERNAL_URL).replace(/\/+$/, '');
const CHANNEL_ID = cleanEnv(process.env.HERT_TELEGRAM_CHANNEL_ID || '@hertchannels');
const CHANNEL_URL = cleanEnv(process.env.HERT_TELEGRAM_CHANNEL_URL || 'https://t.me/hertchannels');
const BOOST_URL = cleanEnv(process.env.HERT_TELEGRAM_BOOST_URL || 'https://t.me/boost/hertchannels');

const BASE_RATE_CENTS_PER_HOUR = 3000;
const REFERRAL_BOOST_PER_FRIEND_CENTS = 300;
const MAX_REFERRAL_BOOST_FRIENDS = 10;
const CYCLE_DURATION_MS = 4 * 60 * 60 * 1000;
const MIN_HARVEST_SECONDS = 60;
const BOOST_DURATION_MS = 24 * 60 * 60 * 1000;

const INVITER_JOIN_BONUS_CENTS = 5000; // +50.00 HERT
const FRIEND_WELCOME_BONUS_CENTS = 2500; // +25.00 HERT
const REFERRAL_COMMISSION_RATE = 0.1;
const DAILY_CHECKIN_REWARD_CENTS = 1000; // +10.00 HERT once per calendar day
const DAILY_REWARDS_CENTS = [1000, 1000, 1000, 1000, 1000, 1000, 1000];
const START_MINING_ACTIVATION_BONUS_CENTS = 100; // +1.00 HERT (max 1/hr)
const START_MINING_BONUS_COOLDOWN_MS = 60 * 60 * 1000;
const TASK_VERIFY_WAIT_MS = 6000;

const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILED_ADMIN_ATTEMPTS = 8;
const failedAdminAttempts = new Map();

const BOOST_CATALOG = [
  {
    id: 'overclock_50',
    name: 'Overclock Core',
    tagline: '+50% base rate (+15.00 pts/hr) for 24 hours',
    costCents: 1500,
    bonusRateCentsPerHour: 1500,
    boostPercent: 50,
    durationMs: BOOST_DURATION_MS,
  },
  {
    id: 'conduit_100',
    name: 'Emerald Conduit',
    tagline: '+100% base rate (+30.00 pts/hr) for 24 hours',
    costCents: 5000,
    bonusRateCentsPerHour: 3000,
    boostPercent: 100,
    durationMs: BOOST_DURATION_MS,
  },
  {
    id: 'sovereign_200',
    name: 'Sovereign Reactor',
    tagline: '+200% base rate (+60.00 pts/hr) for 24 hours',
    costCents: 12000,
    bonusRateCentsPerHour: 6000,
    boostPercent: 200,
    durationMs: BOOST_DURATION_MS,
  },
];

const TASK_CATALOG = [
  {
    id: 'join_tg_channel',
    title: 'Join Official HERT Channel (@hertchannels)',
    description: 'Subscribe to @hertchannels on Telegram for verified ecosystem & TGE updates.',
    category: 'social',
    platform: 'telegram',
    rewardCents: 3000,
    actionUrl: CHANNEL_URL,
    targetTab: null,
    actionLabel: 'Join Channel',
  },
  {
    id: 'boost_tg_channel',
    title: 'Boost Official HERT Channel',
    description: 'Boost @hertchannels on Telegram to unlock community perks and bonus HERT Points.',
    category: 'social',
    platform: 'boost',
    rewardCents: 7500,
    actionUrl: BOOST_URL,
    targetTab: null,
    actionLabel: 'Boost Channel',
  },
  {
    id: 'link_ton_wallet',
    title: 'Connect Non-Custodial TON Wallet',
    description: 'Link Tonkeeper, Telegram Wallet, or MyTonWallet via TON Connect 2.0.',
    category: 'milestone',
    platform: 'ton',
    rewardCents: 5000,
    actionUrl: null,
    targetTab: 'wallet',
    actionLabel: 'Connect Wallet',
  },
  {
    id: 'complete_first_cycle',
    title: 'Claim Your First Mining Session',
    description: 'Start and harvest HERT Points from at least 1 mining session.',
    category: 'milestone',
    platform: 'mining',
    rewardCents: 3500,
    actionUrl: null,
    targetTab: 'mining',
    actionLabel: 'Start Mining',
  },
  {
    id: 'complete_first_checkin',
    title: 'Claim Your First Daily Check-In',
    description: 'Complete at least 1 daily check-in to start your streak.',
    category: 'milestone',
    platform: 'checkin',
    rewardCents: 2000,
    actionUrl: null,
    targetTab: 'checkin',
    actionLabel: 'Daily Check-In',
  },
  {
    id: 'activate_first_boost',
    title: 'Activate Any 24-Hour Rate Boost',
    description: 'Power up your mining chamber with any 24h HERT speed boost.',
    category: 'milestone',
    platform: 'boost',
    rewardCents: 3000,
    actionUrl: null,
    targetTab: 'mining',
    actionLabel: 'View Boosts',
  },
];

const isLocalDb =
  DATABASE_URL.includes('localhost') ||
  DATABASE_URL.includes('127.0.0.1') ||
  DATABASE_URL.includes('sslmode=disable');

const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: isLocalDb ? false : { rejectUnauthorized: false },
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    })
  : null;

function generateReferralCode(telegramId) {
  const hash = crypto
    .createHash('sha256')
    .update(`hert-ref:${telegramId}`)
    .digest('hex')
    .slice(0, 6)
    .toUpperCase();
  return `HERT-${hash}`;
}

function getUtcDateKey(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function getNextUtcMidnightMs(ms) {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0, 0);
}

function safeEqualSecret(candidate, expected) {
  if (!candidate || !expected) return false;
  const a = crypto.createHash('sha256').update(String(candidate), 'utf8').digest();
  const b = crypto.createHash('sha256').update(String(expected), 'utf8').digest();
  return crypto.timingSafeEqual(a, b);
}

function getConfiguredAdminSecret() {
  const token = cleanEnv(process.env.ADMIN_DASHBOARD_TOKEN || process.env.ADMIN_SECRET);
  if (!token || token.length < 8) return '';
  return token;
}

function getConfiguredAdminTelegramIds() {
  const raw = cleanEnv(process.env.ADMIN_TELEGRAM_IDS || process.env.ADMIN_TELEGRAM_ID);
  if (!raw) return new Set();
  return new Set(
    raw
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter((s) => /^\d{4,20}$/.test(s))
  );
}

function deriveAdminSigningKey(adminSecret) {
  return crypto
    .createHmac('sha256', 'hert-admin-session-signing-key-v1')
    .update(`${adminSecret}:${BOT_TOKEN || 'no-bot-token'}`)
    .digest();
}

function issueAdminSessionToken(adminSecret) {
  const expiresAt = Date.now() + ADMIN_SESSION_TTL_MS;
  const nonce = crypto.randomBytes(16).toString('hex');
  const payload = `${expiresAt}.${nonce}`;
  const sig = crypto
    .createHmac('sha256', deriveAdminSigningKey(adminSecret))
    .update(payload)
    .digest('hex');
  return { sessionToken: `hert_adm.${payload}.${sig}`, expiresAt };
}

function verifyAdminSessionOrRawToken(provided, adminSecret) {
  if (!provided || !adminSecret) return false;
  if (provided.startsWith('hert_adm.')) {
    const parts = provided.split('.');
    if (parts.length !== 4) return false;
    const [, expiresAtStr, nonce, receivedSig] = parts;
    const expiresAt = Number(expiresAtStr);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return false;
    if (!/^[0-9a-f]{32}$/.test(nonce) || !/^[0-9a-f]{64}$/i.test(receivedSig)) return false;
    const expectedSig = crypto
      .createHmac('sha256', deriveAdminSigningKey(adminSecret))
      .update(`${expiresAtStr}.${nonce}`)
      .digest('hex');
    return safeEqualSecret(receivedSig.toLowerCase(), expectedSig.toLowerCase());
  }
  return safeEqualSecret(provided, adminSecret);
}

function isVerifiedTelegramAdmin(tgUser) {
  if (!tgUser || !tgUser.verified) return false;
  return getConfiguredAdminTelegramIds().has(String(tgUser.telegramId));
}

function verifyAdminRequest(req) {
  const adminSecret = getConfiguredAdminSecret();
  const adminIds = getConfiguredAdminTelegramIds();
  const isConfigured = Boolean(adminSecret) || (Boolean(BOT_TOKEN) && adminIds.size > 0);
  if (!isConfigured) {
    const err = new Error(
      'Admin access is disabled until ADMIN_DASHBOARD_TOKEN or ADMIN_TELEGRAM_IDS is configured in server environment variables.'
    );
    err.status = 503;
    throw err;
  }

  const headerToken = (req.header('x-admin-token') || '').trim();
  const authHeader = (req.header('authorization') || '').trim();
  const bearerToken = authHeader.toLowerCase().startsWith('bearer ')
    ? authHeader.slice(7).trim()
    : '';
  const providedToken = headerToken || bearerToken;

  if (providedToken && adminSecret && verifyAdminSessionOrRawToken(providedToken, adminSecret)) {
    return { method: 'admin_token', adminTelegramId: null };
  }

  const tmaInitData = authHeader.toLowerCase().startsWith('tma ')
    ? authHeader.slice(4).trim()
    : '';
  const rawInitData = (req.header('x-telegram-init-data') || tmaInitData).trim();
  if (rawInitData && BOT_TOKEN) {
    try {
      const tgUser = verifyTelegramInitData(rawInitData, BOT_TOKEN);
      if (isVerifiedTelegramAdmin(tgUser)) {
        return { method: 'telegram_id', adminTelegramId: tgUser.telegramId };
      }
      if (!providedToken) {
        const err = new Error(
          'Access denied. Your Telegram account is not authorized to view the HERT Admin Dashboard.'
        );
        err.status = 403;
        throw err;
      }
    } catch (e) {
      if (e.status === 403) throw e;
    }
  }

  const err = new Error('Admin authentication required. Enter your valid admin access token to continue.');
  err.status = 401;
  throw err;
}

function extractReferralTarget(raw) {
  if (!raw) return null;
  let cleaned = String(raw).trim();
  if (!cleaned) return null;

  try {
    if (cleaned.startsWith('http://') || cleaned.startsWith('https://') || cleaned.includes('t.me/')) {
      const normalizedUrl = cleaned.startsWith('http') ? cleaned : `https://${cleaned}`;
      const u = new URL(normalizedUrl);
      const param =
        u.searchParams.get('startapp') ||
        u.searchParams.get('ref') ||
        u.searchParams.get('start') ||
        '';
      if (param) cleaned = param.trim();
    }
  } catch {
    // ignore URL parse errors
  }

  cleaned = cleaned.replace(/^ref_/i, '').trim();
  if (!cleaned) return null;

  if (/^\d{4,20}$/.test(cleaned)) {
    return { referralCode: generateReferralCode(cleaned), numericTelegramId: cleaned };
  }

  const upper = cleaned.toUpperCase();
  const normalizedCode = upper.startsWith('HERT-') ? upper : `HERT-${upper}`;
  if (/^HERT-[A-Z0-9]{4,12}$/.test(normalizedCode)) {
    return { referralCode: normalizedCode, numericTelegramId: null };
  }
  return null;
}

function verifyTelegramInitData(initDataRaw, botToken) {
  const params = new URLSearchParams(initDataRaw);
  const receivedHash = params.get('hash');
  if (!receivedHash) throw new Error('Missing hash in Telegram initData.');

  const pairs = [];
  params.forEach((value, key) => {
    if (key !== 'hash') pairs.push(`${key}=${value}`);
  });
  pairs.sort();

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const calculatedHash = crypto.createHmac('sha256', secretKey).update(pairs.join('\n')).digest('hex');

  const a = Buffer.from(calculatedHash.toLowerCase(), 'hex');
  const b = Buffer.from(receivedHash.toLowerCase(), 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new Error('Invalid Telegram initData signature.');
  }

  const authDate = Number(params.get('auth_date') || '0');
  const nowSec = Math.floor(Date.now() / 1000);
  if (authDate > 0 && nowSec - authDate > 7 * 86400) {
    throw new Error('Telegram session expired. Please reopen HERT Mining from Telegram.');
  }

  const userJson = params.get('user');
  if (!userJson) throw new Error('Missing user payload in Telegram initData.');
  const parsed = JSON.parse(userJson);
  if (!parsed || !parsed.id) throw new Error('Malformed user object in Telegram initData.');

  return {
    telegramId: String(parsed.id),
    username: parsed.username || null,
    firstName: parsed.first_name || 'Miner',
    lastName: parsed.last_name || null,
    photoUrl: parsed.photo_url || null,
    isPremium: Boolean(parsed.is_premium),
    startParam: params.get('start_param') || null,
    verified: true,
  };
}

function resolveRequestUser(req) {
  const authHeader = cleanEnv(req.header('authorization'));
  const tmaInitData = authHeader.toLowerCase().startsWith('tma ')
    ? authHeader.slice(4).trim()
    : '';
  const initDataRaw = (req.header('x-telegram-init-data') || tmaInitData).trim();
  const headerStartParam = (req.header('x-start-param') || '').trim() || null;

  if (initDataRaw && BOT_TOKEN) {
    const user = verifyTelegramInitData(initDataRaw, BOT_TOKEN);
    if (!user.startParam && headerStartParam) user.startParam = headerStartParam;
    return user;
  }

  if (initDataRaw && !BOT_TOKEN) {
    const params = new URLSearchParams(initDataRaw);
    const userJson = params.get('user');
    if (userJson) {
      const parsed = JSON.parse(userJson);
      if (parsed && parsed.id) {
        return {
          telegramId: String(parsed.id),
          username: parsed.username || null,
          firstName: parsed.first_name || 'Miner',
          lastName: parsed.last_name || null,
          photoUrl: parsed.photo_url || null,
          isPremium: Boolean(parsed.is_premium),
          startParam: params.get('start_param') || headerStartParam,
          verified: false,
        };
      }
    }
  }

  throw new Error(
    'Telegram authentication required. Please open HERT Mining directly inside Telegram (@HERTCoinBot).'
  );
}

async function initDatabase() {
  if (!pool) {
    console.warn('[HERT Backend] DATABASE_URL is not configured.');
    return;
  }

  // Non-destructive PostgreSQL schema matching server/db.ts & schema.sql 100%
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      telegram_id BIGINT PRIMARY KEY,
      username TEXT,
      points BIGINT NOT NULL DEFAULT 0,
      referred_by BIGINT,
      last_mine TIMESTAMPTZ,
      last_checkin DATE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS referral_rewards (
      invited_user BIGINT PRIMARY KEY,
      referrer BIGINT NOT NULL,
      rewarded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE users ADD COLUMN IF NOT EXISTS username TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS first_name TEXT DEFAULT 'Miner';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS last_name TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS photo_url TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS is_premium INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS points BIGINT NOT NULL DEFAULT 0;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS points_cents BIGINT DEFAULT 0;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS total_mined_cents BIGINT NOT NULL DEFAULT 0;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS completed_cycles INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS checkin_streak INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS last_checkin_at BIGINT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS last_mine_at BIGINT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at_ms BIGINT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at BIGINT;

    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_referral_code
      ON users(referral_code) WHERE referral_code IS NOT NULL;

    CREATE TABLE IF NOT EXISTS mining_sessions (
      id BIGSERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      started_at BIGINT NOT NULL,
      ends_at BIGINT NOT NULL,
      claimed_at BIGINT,
      rate_cents_per_hour INTEGER NOT NULL,
      banked_cents BIGINT NOT NULL DEFAULT 0,
      rate_anchor_at BIGINT,
      earned_cents BIGINT NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active'
    );
    CREATE INDEX IF NOT EXISTS idx_mining_user_status ON mining_sessions(user_id, status);

    CREATE TABLE IF NOT EXISTS mining_boosts (
      id BIGSERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      boost_tier TEXT NOT NULL,
      boost_name TEXT NOT NULL,
      cost_cents BIGINT NOT NULL,
      bonus_rate_cents_per_hour INTEGER NOT NULL,
      activated_at BIGINT NOT NULL,
      expires_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_boosts_user_expires ON mining_boosts(user_id, expires_at DESC);

    CREATE TABLE IF NOT EXISTS task_claims (
      id BIGSERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'started',
      started_at BIGINT NOT NULL,
      claimed_at BIGINT,
      reward_cents BIGINT NOT NULL DEFAULT 0,
      UNIQUE(user_id, task_id)
    );
    CREATE INDEX IF NOT EXISTS idx_task_claims_user ON task_claims(user_id, status);

    CREATE TABLE IF NOT EXISTS daily_checkins (
      id BIGSERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      checked_in_at BIGINT NOT NULL,
      checkin_date TEXT,
      streak_day INTEGER NOT NULL,
      reward_cents INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_checkins_user_date
      ON daily_checkins(user_id, checkin_date) WHERE checkin_date IS NOT NULL;

    CREATE TABLE IF NOT EXISTS referrals (
      id BIGSERIAL PRIMARY KEY,
      referrer_id TEXT NOT NULL,
      referred_id TEXT NOT NULL UNIQUE,
      bonus_cents INTEGER NOT NULL,
      commission_earned_cents BIGINT NOT NULL DEFAULT 0,
      created_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals(referrer_id);

    CREATE TABLE IF NOT EXISTS point_ledger (
      id BIGSERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      entry_type TEXT NOT NULL,
      amount_cents BIGINT NOT NULL,
      description TEXT NOT NULL,
      created_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ledger_user_time ON point_ledger(user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS wallet_connections (
      user_id TEXT PRIMARY KEY,
      ton_address TEXT NOT NULL,
      raw_address TEXT,
      wallet_app_name TEXT NOT NULL,
      public_key TEXT,
      proof_verified INTEGER NOT NULL DEFAULT 0,
      connected_at BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS wallet_proof_nonces (
      nonce TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS allocation_history (
      id BIGSERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      milestone_key TEXT NOT NULL,
      milestone_label TEXT NOT NULL,
      readiness_completed INTEGER NOT NULL,
      readiness_total INTEGER NOT NULL,
      points_snapshot_cents BIGINT NOT NULL,
      recorded_at BIGINT NOT NULL,
      UNIQUE(user_id, milestone_key)
    );
  `);

  await pool.query(`
    UPDATE users
    SET points_cents = GREATEST(COALESCE(points_cents, 0), COALESCE(points, 0) * 100)
    WHERE COALESCE(points, 0) * 100 > COALESCE(points_cents, 0) OR points_cents IS NULL
  `);

  await pool.query(`
    UPDATE users
    SET created_at_ms = COALESCE(
      created_at_ms,
      (EXTRACT(EPOCH FROM COALESCE(created_at, NOW())) * 1000)::BIGINT
    )
    WHERE created_at_ms IS NULL
  `);

  await pool.query(`
    UPDATE users
    SET last_mine_at = (EXTRACT(EPOCH FROM last_mine) * 1000)::BIGINT
    WHERE last_mine IS NOT NULL AND last_mine_at IS NULL
  `);

  await pool.query(`
    UPDATE users
    SET last_checkin_at = (EXTRACT(EPOCH FROM last_checkin::TIMESTAMPTZ) * 1000)::BIGINT,
        checkin_streak = GREATEST(COALESCE(checkin_streak, 0), 1)
    WHERE last_checkin IS NOT NULL AND last_checkin_at IS NULL
  `);

  await pool.query(`
    INSERT INTO daily_checkins (user_id, streak_day, reward_cents, checkin_date, checked_in_at)
    SELECT telegram_id::TEXT, GREATEST(COALESCE(checkin_streak, 0), 1), 1000, TO_CHAR(last_checkin, 'YYYY-MM-DD'),
           COALESCE(last_checkin_at, (EXTRACT(EPOCH FROM last_checkin::TIMESTAMPTZ) * 1000)::BIGINT)
    FROM users
    WHERE last_checkin IS NOT NULL
    ON CONFLICT (user_id, checkin_date) WHERE checkin_date IS NOT NULL DO NOTHING
  `);

  const missingCodes = await pool.query(
    `SELECT telegram_id::TEXT AS tid FROM users WHERE referral_code IS NULL`
  );
  for (const row of missingCodes.rows) {
    await pool.query(
      `UPDATE users SET referral_code = $1 WHERE telegram_id::TEXT = $2 AND referral_code IS NULL`,
      [generateReferralCode(row.tid), row.tid]
    );
  }

  await pool.query(`
    INSERT INTO referrals (referrer_id, referred_id, bonus_cents, commission_earned_cents, created_at)
    SELECT referrer::TEXT, invited_user::TEXT, 5000, 0,
           (EXTRACT(EPOCH FROM COALESCE(rewarded_at, NOW())) * 1000)::BIGINT
    FROM referral_rewards
    ON CONFLICT (referred_id) DO NOTHING
  `);

  console.log('[HERT Backend] PostgreSQL tables verified and synchronized.');
}

async function getActiveBoostRow(client, userId, now) {
  const res = await client.query(
    `SELECT * FROM mining_boosts
     WHERE user_id = $1 AND expires_at > $2
     ORDER BY bonus_rate_cents_per_hour DESC, expires_at DESC
     LIMIT 1`,
    [userId, now]
  );
  return res.rows[0] || null;
}

async function computeEffectiveRateCents(client, userId, now) {
  const refRes = await client.query(
    `SELECT COUNT(*)::INT AS cnt FROM referrals WHERE referrer_id = $1`,
    [userId]
  );
  const invitedCount = Number(refRes.rows[0]?.cnt || 0);
  const boostFriends = Math.min(invitedCount, MAX_REFERRAL_BOOST_FRIENDS);
  const activeBoost = await getActiveBoostRow(client, userId, now);
  const boostBonus = activeBoost ? Number(activeBoost.bonus_rate_cents_per_hour) : 0;
  return BASE_RATE_CENTS_PER_HOUR + boostFriends * REFERRAL_BOOST_PER_FRIEND_CENTS + boostBonus;
}

function computeSessionState(row, now) {
  const startedAt = Number(row.started_at);
  const endsAt = Number(row.ends_at);
  const rateCentsPerHour = Number(row.rate_cents_per_hour);
  const bankedCents = Number(row.banked_cents || 0);
  const rateAnchorAt = Number(row.rate_anchor_at || startedAt);

  const clampedNow = Math.max(startedAt, Math.min(now, endsAt));
  const elapsedMs = clampedNow - startedAt;
  const remainingMs = Math.max(0, endsAt - now);

  const anchorClamped = Math.max(startedAt, Math.min(rateAnchorAt, clampedNow));
  const deltaSinceAnchorMs = Math.max(0, clampedNow - anchorClamped);
  const deltaAccrued = Math.floor((deltaSinceAnchorMs * rateCentsPerHour) / 3600000);
  const accruedCents = bankedCents + deltaAccrued;

  const totalRemainingFromAnchorMs = Math.max(0, endsAt - anchorClamped);
  const maxCycleRewardCents =
    bankedCents + Math.round((totalRemainingFromAnchorMs * rateCentsPerHour) / 3600000);

  const isComplete = now >= endsAt;
  const canClaim = (isComplete || elapsedMs >= MIN_HARVEST_SECONDS * 1000) && accruedCents > 0;
  const progressPercent = Math.min(100, (elapsedMs / CYCLE_DURATION_MS) * 100);

  return {
    id: Number(row.id),
    startedAt,
    endsAt,
    rateCentsPerHour,
    bankedCents,
    rateAnchorAt: anchorClamped,
    maxCycleRewardCents,
    accruedCents,
    elapsedMs,
    remainingMs,
    progressPercent,
    canClaim,
    isComplete,
    minHarvestSeconds: MIN_HARVEST_SECONDS,
  };
}

async function applyReferralInTx(client, inviteeId, rawInput, now) {
  const target = extractReferralTarget(rawInput);
  if (!target) return { applied: false, reason: 'Invalid referral code format.' };

  const inviteeRes = await client.query(
    `SELECT telegram_id::TEXT AS tid, referred_by::TEXT AS referred_by, completed_cycles
     FROM users WHERE telegram_id::TEXT = $1`,
    [inviteeId]
  );
  const invitee = inviteeRes.rows[0];
  if (!invitee) return { applied: false, reason: 'User account not found.' };
  if (invitee.referred_by) return { applied: false, reason: 'An inviter is already linked to your account.' };
  if (Number(invitee.completed_cycles) > 0) {
    return { applied: false, reason: 'Referral codes can only be applied before completing your first mining cycle.' };
  }

  let inviterRes;
  if (target.numericTelegramId) {
    inviterRes = await client.query(
      `SELECT telegram_id::TEXT AS tid, first_name FROM users WHERE telegram_id::TEXT = $1`,
      [target.numericTelegramId]
    );
  } else {
    inviterRes = await client.query(
      `SELECT telegram_id::TEXT AS tid, first_name FROM users WHERE referral_code = $1`,
      [target.referralCode]
    );
  }

  const inviter = inviterRes.rows[0];
  if (!inviter) return { applied: false, reason: 'Referral code not found.' };
  if (inviter.tid === inviteeId) return { applied: false, reason: 'You cannot use your own referral code.' };

  const existingPair = await client.query(
    `SELECT id FROM referrals WHERE referred_id = $1`,
    [inviteeId]
  );
  if (existingPair.rows.length > 0) {
    return { applied: false, reason: 'Referral bonus already claimed.' };
  }

  if (/^-?\d+$/.test(inviter.tid)) {
    await client.query(
      `UPDATE users
       SET referred_by = $1::BIGINT,
           points_cents = COALESCE(points_cents, 0) + $2,
           points = FLOOR((COALESCE(points_cents, 0) + $2) / 100.0)::BIGINT
       WHERE telegram_id::TEXT = $3`,
      [inviter.tid, FRIEND_WELCOME_BONUS_CENTS, inviteeId]
    );
  } else {
    await client.query(
      `UPDATE users
       SET points_cents = COALESCE(points_cents, 0) + $1,
           points = FLOOR((COALESCE(points_cents, 0) + $1) / 100.0)::BIGINT
       WHERE telegram_id::TEXT = $2`,
      [FRIEND_WELCOME_BONUS_CENTS, inviteeId]
    );
  }

  await client.query(
    `UPDATE users
     SET points_cents = COALESCE(points_cents, 0) + $1,
         points = FLOOR((COALESCE(points_cents, 0) + $1) / 100.0)::BIGINT
     WHERE telegram_id::TEXT = $2`,
    [INVITER_JOIN_BONUS_CENTS, inviter.tid]
  );

  await client.query(
    `INSERT INTO referrals (referrer_id, referred_id, bonus_cents, commission_earned_cents, created_at)
     VALUES ($1, $2, $3, 0, $4)
     ON CONFLICT (referred_id) DO NOTHING`,
    [inviter.tid, inviteeId, INVITER_JOIN_BONUS_CENTS, now]
  );

  if (/^-?\d+$/.test(inviteeId) && /^-?\d+$/.test(inviter.tid)) {
    await client.query(
      `INSERT INTO referral_rewards (invited_user, referrer, rewarded_at)
       VALUES ($1::BIGINT, $2::BIGINT, NOW())
       ON CONFLICT (invited_user) DO NOTHING`,
      [inviteeId, inviter.tid]
    );
  }

  await client.query(
    `INSERT INTO point_ledger (user_id, entry_type, amount_cents, description, created_at)
     VALUES ($1, 'welcome_bonus', $2, $3, $4)`,
    [inviteeId, FRIEND_WELCOME_BONUS_CENTS, `Welcome bonus via ${inviter.first_name || 'Miner'}`, now]
  );

  await client.query(
    `INSERT INTO point_ledger (user_id, entry_type, amount_cents, description, created_at)
     VALUES ($1, 'referral_bonus', $2, 'Invited new HERT miner', $3)`,
    [inviter.tid, INVITER_JOIN_BONUS_CENTS, now]
  );

  return { applied: true };
}

async function ensureUserInTx(client, tgUser, now) {
  const existingRes = await client.query(
    `SELECT telegram_id::TEXT AS tid, referral_code, first_name FROM users WHERE telegram_id::TEXT = $1`,
    [tgUser.telegramId]
  );
  const referralCode = existingRes.rows[0]?.referral_code || generateReferralCode(tgUser.telegramId);

  if (existingRes.rows.length === 0) {
    await client.query(
      `INSERT INTO users (
        telegram_id, username, first_name, last_name, photo_url, is_premium,
        referral_code, points, points_cents, total_mined_cents, completed_cycles,
        checkin_streak, created_at, created_at_ms, updated_at
      ) VALUES ($1::BIGINT, $2, $3, $4, $5, $6, $7, 0, 0, 0, 0, 0, NOW(), $8, $8)`,
      [
        tgUser.telegramId,
        tgUser.username,
        tgUser.firstName || 'Miner',
        tgUser.lastName,
        tgUser.photoUrl,
        tgUser.isPremium ? 1 : 0,
        referralCode,
        now,
      ]
    );
  } else {
    await client.query(
      `UPDATE users
       SET username = COALESCE($1, username),
           first_name = COALESCE($2, first_name),
           last_name = COALESCE($3, last_name),
           photo_url = COALESCE($4, photo_url),
           is_premium = $5,
           referral_code = COALESCE(referral_code, $6),
           points_cents = GREATEST(COALESCE(points_cents, 0), COALESCE(points, 0) * 100),
           updated_at = $7
       WHERE telegram_id::TEXT = $8`,
      [
        tgUser.username,
        tgUser.firstName || existingRes.rows[0].first_name || 'Miner',
        tgUser.lastName,
        tgUser.photoUrl,
        tgUser.isPremium ? 1 : 0,
        referralCode,
        now,
        tgUser.telegramId,
      ]
    );
  }

  // Auto-settle any completed unclaimed 4-hour mining session
  const finishedSessions = await client.query(
    `SELECT * FROM mining_sessions
     WHERE user_id = $1 AND claimed_at IS NULL AND ends_at <= $2
     ORDER BY id ASC`,
    [tgUser.telegramId, now]
  );

  for (const s of finishedSessions.rows) {
    const computed = computeSessionState(s, Number(s.ends_at));
    if (computed.accruedCents > 0) {
      await client.query(
        `UPDATE mining_sessions SET status = 'claimed', claimed_at = $1, earned_cents = $2 WHERE id = $3`,
        [now, computed.accruedCents, s.id]
      );
      await client.query(
        `UPDATE users
         SET points_cents = COALESCE(points_cents, 0) + $1,
             points = FLOOR((COALESCE(points_cents, 0) + $1) / 100.0)::BIGINT,
             total_mined_cents = COALESCE(total_mined_cents, 0) + $1,
             completed_cycles = COALESCE(completed_cycles, 0) + 1
         WHERE telegram_id::TEXT = $2`,
        [computed.accruedCents, tgUser.telegramId]
      );
      await client.query(
        `INSERT INTO point_ledger (user_id, entry_type, amount_cents, description, created_at)
         VALUES ($1, 'mining_claim', $2, 'Completed 4h mining cycle settled', $3)`,
        [tgUser.telegramId, computed.accruedCents, now]
      );
    }
  }

  if (tgUser.startParam) {
    await applyReferralInTx(client, tgUser.telegramId, tgUser.startParam, now);
  }
}

async function withTransaction(fn) {
  if (!pool) {
    throw new Error('PostgreSQL DATABASE_URL is not configured on Render.');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function checkTelegramChannelMembership(telegramId, chatId) {
  if (!BOT_TOKEN || !/^\d+$/.test(telegramId)) return null;
  try {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/getChatMember?chat_id=${encodeURIComponent(chatId)}&user_id=${encodeURIComponent(telegramId)}`;
    const resp = await fetch(url);
    const data = await resp.json();
    if (!data.ok || !data.result?.status) return null;
    return ['creator', 'administrator', 'member', 'restricted'].includes(data.result.status);
  } catch {
    return null;
  }
}

async function buildDashboardPayload(tgUser, appOrigin) {
  const now = Date.now();
  return withTransaction(async (client) => {
    await ensureUserInTx(client, tgUser, now);

    const userRes = await client.query(
      `SELECT telegram_id::TEXT AS telegram_id, username, first_name, last_name, photo_url,
              is_premium, referral_code, referred_by::TEXT AS referred_by,
              points, points_cents, total_mined_cents, completed_cycles,
              checkin_streak, last_checkin_at,
              COALESCE(created_at_ms, (EXTRACT(EPOCH FROM created_at) * 1000)::BIGINT) AS created_at_ms
       FROM users WHERE telegram_id::TEXT = $1`,
      [tgUser.telegramId]
    );
    const userRow = userRes.rows[0];
    const effectivePointsCents = Math.max(
      Number(userRow.points_cents || 0),
      Number(userRow.points || 0) * 100
    );

    const activeBoostRow = await getActiveBoostRow(client, tgUser.telegramId, now);
    const activeBoost = activeBoostRow
      ? {
          id: Number(activeBoostRow.id),
          tierId: activeBoostRow.boost_tier,
          name: activeBoostRow.boost_name,
          bonusRateCentsPerHour: Number(activeBoostRow.bonus_rate_cents_per_hour),
          activatedAt: Number(activeBoostRow.activated_at),
          expiresAt: Number(activeBoostRow.expires_at),
          remainingMs: Math.max(0, Number(activeBoostRow.expires_at) - now),
        }
      : null;

    const effectiveRateCentsPerHour = await computeEffectiveRateCents(client, tgUser.telegramId, now);

    const activeSessionRes = await client.query(
      `SELECT * FROM mining_sessions WHERE user_id = $1 AND claimed_at IS NULL ORDER BY id DESC LIMIT 1`,
      [tgUser.telegramId]
    );
    const activeSessionRow = activeSessionRes.rows[0];
    const activeSession = activeSessionRow ? computeSessionState(activeSessionRow, now) : null;

    const todayKey = getUtcDateKey(now);
    const yesterdayKey = getUtcDateKey(now - 86400000);
    const lastCheckInAt = userRow.last_checkin_at ? Number(userRow.last_checkin_at) : null;
    const lastCheckInKey = lastCheckInAt ? getUtcDateKey(lastCheckInAt) : null;

    const checkedInTodayRes = await client.query(
      `SELECT id FROM daily_checkins WHERE user_id = $1 AND checkin_date = $2 LIMIT 1`,
      [tgUser.telegramId, todayKey]
    );
    const alreadyCheckedInToday = checkedInTodayRes.rows.length > 0 || lastCheckInKey === todayKey;
    const canCheckIn = !alreadyCheckedInToday;
    const nextEligibleAt = canCheckIn ? 0 : getNextUtcMidnightMs(now);
    const cooldownRemainingMs = canCheckIn ? 0 : Math.max(0, nextEligibleAt - now);

    const storedStreak = Number(userRow.checkin_streak || 0);
    let currentStreak = storedStreak;
    let nextStreakDay = 1;
    if (alreadyCheckedInToday) {
      currentStreak = Math.max(1, storedStreak);
      nextStreakDay = currentStreak >= 7 ? 1 : currentStreak + 1;
    } else if (lastCheckInKey === yesterdayKey && storedStreak > 0) {
      currentStreak = storedStreak;
      nextStreakDay = storedStreak >= 7 ? 1 : storedStreak + 1;
    } else {
      currentStreak = 0;
      nextStreakDay = 1;
    }

    const checkInTotalsRes = await client.query(
      `SELECT COUNT(*)::INT AS cnt, COALESCE(SUM(reward_cents), 0)::BIGINT AS total
       FROM daily_checkins WHERE user_id = $1`,
      [tgUser.telegramId]
    );

    let referredByCode = null;
    if (userRow.referred_by) {
      const invRes = await client.query(
        `SELECT referral_code FROM users WHERE telegram_id::TEXT = $1`,
        [userRow.referred_by]
      );
      referredByCode = invRes.rows[0]?.referral_code || null;
    }

    const friendsRes = await client.query(
      `SELECT r.referred_id, r.bonus_cents, r.commission_earned_cents, r.created_at,
              u.first_name, u.username, u.completed_cycles
       FROM referrals r
       JOIN users u ON u.telegram_id::TEXT = r.referred_id
       WHERE r.referrer_id = $1
       ORDER BY r.created_at DESC
       LIMIT 50`,
      [tgUser.telegramId]
    );

    const referralSumRes = await client.query(
      `SELECT COUNT(*)::INT AS cnt,
              COALESCE(SUM(bonus_cents + commission_earned_cents), 0)::BIGINT AS total
       FROM referrals WHERE referrer_id = $1`,
      [tgUser.telegramId]
    );

    const referralCode = userRow.referral_code || generateReferralCode(tgUser.telegramId);
    const startAppPayload = `ref_${referralCode.replace('HERT-', '')}`;
    const telegramDeepLink = BOT_USERNAME
      ? MINI_APP_SHORT_NAME
        ? `https://t.me/${BOT_USERNAME}/${MINI_APP_SHORT_NAME}?startapp=${startAppPayload}`
        : `https://t.me/${BOT_USERNAME}?start=${startAppPayload}`
      : null;
    const webInviteLink = `${PUBLIC_WEBAPP_URL || appOrigin}/?ref=${encodeURIComponent(referralCode)}`;

    const walletRes = await client.query(
      `SELECT * FROM wallet_connections WHERE user_id = $1`,
      [tgUser.telegramId]
    );
    const walletRow = walletRes.rows[0];
    const wallet = walletRow
      ? {
          connected: true,
          tonAddress: walletRow.ton_address,
          rawAddress: walletRow.raw_address,
          walletAppName: walletRow.wallet_app_name,
          proofVerified: Boolean(walletRow.proof_verified),
          connectedAt: Number(walletRow.connected_at),
        }
      : {
          connected: false,
          tonAddress: null,
          rawAddress: null,
          walletAppName: null,
          proofVerified: false,
          connectedAt: null,
        };

    const totalCheckInsCount = Number(checkInTotalsRes.rows[0]?.cnt || 0);
    const anyBoostCountRes = await client.query(
      `SELECT COUNT(*)::INT AS cnt FROM mining_boosts WHERE user_id = $1`,
      [tgUser.telegramId]
    );
    const hasEverBoosted = Number(anyBoostCountRes.rows[0]?.cnt || 0) > 0;

    const userTaskRes = await client.query(
      `SELECT * FROM task_claims WHERE user_id = $1`,
      [tgUser.telegramId]
    );
    const taskMap = new Map(userTaskRes.rows.map((r) => [r.task_id, r]));

    const taskItems = TASK_CATALOG.map((def) => {
      const rec = taskMap.get(def.id);
      if (rec && rec.status === 'claimed') {
        return {
          ...def,
          status: 'claimed',
          verifyWaitRemainingSeconds: 0,
          claimedAt: rec.claimed_at ? Number(rec.claimed_at) : now,
        };
      }

      if (def.category === 'milestone') {
        let met = false;
        if (def.id === 'link_ton_wallet') met = wallet.connected;
        if (def.id === 'complete_first_cycle') met = Number(userRow.completed_cycles) >= 1;
        if (def.id === 'complete_first_checkin') met = totalCheckInsCount >= 1;
        if (def.id === 'activate_first_boost') met = hasEverBoosted;
        return {
          ...def,
          status: met ? 'claimable' : 'available',
          verifyWaitRemainingSeconds: 0,
          claimedAt: null,
        };
      }

      if (rec && rec.status === 'started') {
        const elapsed = now - Number(rec.started_at);
        const waitRemSec = Math.max(0, Math.ceil((TASK_VERIFY_WAIT_MS - elapsed) / 1000));
        return {
          ...def,
          status: waitRemSec === 0 ? 'claimable' : 'pending_verify',
          verifyWaitRemainingSeconds: waitRemSec,
          claimedAt: null,
        };
      }

      return {
        ...def,
        status: 'available',
        verifyWaitRemainingSeconds: 0,
        claimedAt: null,
      };
    });

    const completedTasksCount = taskItems.filter((t) => t.status === 'claimed').length;
    const totalEarnedTaskCents = taskItems
      .filter((t) => t.status === 'claimed')
      .reduce((acc, t) => acc + t.rewardCents, 0);
    const totalAvailableTaskCents = TASK_CATALOG.reduce((acc, t) => acc + t.rewardCents, 0);

    const criteria = {
      identityVerified: tgUser.verified,
      activeMiner: Number(userRow.completed_cycles) >= 1 || Boolean(activeSession),
      dailyCheckInCompleted: totalCheckInsCount >= 1,
      walletConnected: wallet.connected,
    };
    const completedCriteriaCount = Object.values(criteria).filter(Boolean).length;

    const allocRes = await client.query(
      `SELECT * FROM allocation_history WHERE user_id = $1 ORDER BY recorded_at DESC`,
      [tgUser.telegramId]
    );

    const ledgerRes = await client.query(
      `SELECT * FROM point_ledger WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT 30`,
      [tgUser.telegramId]
    );

    return {
      auth: {
        mode: tgUser.verified ? 'telegram_verified' : 'browser_sandbox',
        botConfigured: Boolean(BOT_TOKEN),
        botUsername: BOT_USERNAME || null,
        serverTime: now,
        isAdmin: isVerifiedTelegramAdmin(tgUser),
      },
      user: {
        telegramId: userRow.telegram_id,
        username: userRow.username,
        firstName: userRow.first_name || 'Miner',
        lastName: userRow.last_name,
        photoUrl: userRow.photo_url,
        isPremium: Boolean(userRow.is_premium),
        referralCode,
        referredBy: userRow.referred_by,
        pointsCents: effectivePointsCents,
        totalMinedCents: Number(userRow.total_mined_cents || 0),
        completedCycles: Number(userRow.completed_cycles || 0),
        createdAt: Number(userRow.created_at_ms || now),
      },
      mining: {
        activeSession,
        rules: {
          baseRateCentsPerHour: BASE_RATE_CENTS_PER_HOUR,
          referralBoostPerFriendCents: REFERRAL_BOOST_PER_FRIEND_CENTS,
          maxBoostFriends: MAX_REFERRAL_BOOST_FRIENDS,
          activeBoostBonusCentsPerHour: activeBoost ? activeBoost.bonusRateCentsPerHour : 0,
          effectiveRateCentsPerHour,
          cycleDurationMs: CYCLE_DURATION_MS,
          minHarvestSeconds: MIN_HARVEST_SECONDS,
        },
      },
      boosts: {
        activeBoost,
        catalog: BOOST_CATALOG,
      },
      tasks: {
        items: taskItems,
        completedCount: completedTasksCount,
        totalCount: TASK_CATALOG.length,
        totalEarnedCents: totalEarnedTaskCents,
        totalAvailableCents: totalAvailableTaskCents,
      },
      checkIn: {
        streakDay: currentStreak,
        nextStreakDay,
        lastCheckInAt,
        nextEligibleAt,
        canCheckIn,
        cooldownRemainingMs,
        rewardsScheduleCents: DAILY_REWARDS_CENTS,
        totalCheckInsCount,
        totalCheckInPointsCents: Number(checkInTotalsRes.rows[0]?.total || 0),
      },
      referrals: {
        referralCode,
        telegramDeepLink,
        webInviteLink,
        referredByCode,
        canApplyCode: !userRow.referred_by && Number(userRow.completed_cycles) === 0,
        invitedCount: Number(referralSumRes.rows[0]?.cnt || 0),
        totalReferralPointsCents: Number(referralSumRes.rows[0]?.total || 0),
        inviterBonusCents: INVITER_JOIN_BONUS_CENTS,
        friendWelcomeBonusCents: FRIEND_WELCOME_BONUS_CENTS,
        miningCommissionPercent: 10,
        rateBoostPercentPerFriend: 10,
        friends: friendsRes.rows.map((f) => ({
          telegramId: f.referred_id,
          firstName: f.first_name || 'Miner',
          username: f.username,
          joinedAt: Number(f.created_at),
          bonusCents: Number(f.bonus_cents),
          commissionEarnedCents: Number(f.commission_earned_cents),
          completedCycles: Number(f.completed_cycles || 0),
        })),
      },
      wallet,
      allocation: {
        tokenDeployed: false,
        tokenSymbol: 'HERT',
        targetNetwork: 'TON (The Open Network)',
        recordedPointsCents: effectivePointsCents,
        criteria,
        completedCriteriaCount,
        totalCriteriaCount: 4,
        distributionModel: [
          { label: 'Community Mining & Check-In Pool', sharePercent: 55, description: 'Reserved for verified Telegram miners, daily check-in streaks, and referral contributors.' },
          { label: 'Ecosystem & Strategic Grants', sharePercent: 20, description: 'Dedicated to TON ecosystem integrations, mini-app utilities, and community builders.' },
          { label: 'Liquidity & Launch Stability', sharePercent: 15, description: 'Provisioned for decentralized exchange liquidity upon future token generation event.' },
          { label: 'Core Protocol Engineering', sharePercent: 10, description: 'Subject to multi-year linear vesting post-deployment.' },
        ],
        history: allocRes.rows.map((a) => ({
          id: Number(a.id),
          milestoneKey: a.milestone_key,
          milestoneLabel: a.milestone_label,
          readinessCompleted: Number(a.readiness_completed),
          readinessTotal: Number(a.readiness_total),
          pointsSnapshotCents: Number(a.points_snapshot_cents),
          recordedAt: Number(a.recorded_at),
        })),
      },
      ledger: ledgerRes.rows.map((l) => ({
        id: Number(l.id),
        entryType: l.entry_type,
        amountCents: Number(l.amount_cents),
        description: l.description,
        createdAt: Number(l.created_at),
      })),
    };
  });
}

async function getAdminDashboardPayload(caller, options = {}) {
  if (!pool) {
    throw new Error('PostgreSQL DATABASE_URL is not configured on Render.');
  }
  const now = Date.now();
  const activeWindowFloorMs = now - 24 * 60 * 60 * 1000;
  const rawSearch = String(options.search || '').trim().replace(/^#/, '');
  const cleanSearch = rawSearch.replace(/[^0-9a-zA-Z_-]/g, '').slice(0, 32);
  const limit = Math.min(100, Math.max(1, Math.floor(Number(options.limit) || 50)));
  const offset = Math.max(0, Math.floor(Number(options.offset) || 0));

  const baseCteSql = `
    WITH session_agg AS (
      SELECT
        user_id,
        MAX(started_at) AS latest_session_started_at,
        MAX(CASE WHEN claimed_at IS NULL THEN ends_at ELSE NULL END) AS active_ends_at
      FROM mining_sessions
      GROUP BY user_id
    ),
    ref_agg AS (
      SELECT
        referrer_id,
        COUNT(*) AS invited_count
      FROM referrals
      GROUP BY referrer_id
    ),
    ranked_users AS (
      SELECT
        u.telegram_id::TEXT AS telegram_id,
        u.username,
        u.first_name,
        u.last_name,
        GREATEST(COALESCE(u.points_cents, 0), COALESCE(u.points, 0) * 100)::BIGINT AS effective_points_cents,
        COALESCE(u.total_mined_cents, 0)::BIGINT AS total_mined_cents,
        COALESCE(u.completed_cycles, 0)::INT AS completed_cycles,
        COALESCE(r.invited_count, 0)::INT AS invited_count,
        COALESCE(u.created_at_ms, (EXTRACT(EPOCH FROM COALESCE(u.created_at, NOW())) * 1000)::BIGINT) AS registered_at_ms,
        GREATEST(
          COALESCE(u.last_mine_at, CASE WHEN u.last_mine IS NOT NULL THEN (EXTRACT(EPOCH FROM u.last_mine) * 1000)::BIGINT ELSE NULL END),
          s.latest_session_started_at
        ) AS resolved_last_mine_ms,
        s.active_ends_at,
        ROW_NUMBER() OVER (
          ORDER BY
            GREATEST(COALESCE(u.points_cents, 0), COALESCE(u.points, 0) * 100) DESC,
            COALESCE(u.total_mined_cents, 0) DESC,
            COALESCE(u.created_at_ms, (EXTRACT(EPOCH FROM COALESCE(u.created_at, NOW())) * 1000)::BIGINT) ASC,
            u.telegram_id::TEXT ASC
        ) AS global_rank
      FROM users u
      LEFT JOIN session_agg s ON s.user_id = u.telegram_id::TEXT
      LEFT JOIN ref_agg r ON r.referrer_id = u.telegram_id::TEXT
    )
  `;

  const statsRes = await pool.query(
    `${baseCteSql}
     SELECT
       COUNT(*)::INT AS total_users,
       COALESCE(SUM(effective_points_cents), 0)::BIGINT AS total_points_cents,
       COALESCE(SUM(CASE WHEN active_ends_at IS NOT NULL AND active_ends_at > $1 THEN 1 ELSE 0 END), 0)::INT AS live_mining_sessions,
       COALESCE(SUM(CASE WHEN active_ends_at IS NOT NULL OR (resolved_last_mine_ms IS NOT NULL AND resolved_last_mine_ms >= $2) THEN 1 ELSE 0 END), 0)::INT AS active_miners,
       COALESCE(SUM(CASE WHEN completed_cycles > 0 OR total_mined_cents > 0 OR resolved_last_mine_ms IS NOT NULL OR active_ends_at IS NOT NULL THEN 1 ELSE 0 END), 0)::INT AS ever_mined_users
     FROM ranked_users`,
    [now, activeWindowFloorMs]
  );
  const statsRow = statsRes.rows[0] || {};

  let totalMatched = Number(statsRow.total_users || 0);
  if (cleanSearch) {
    const matchRes = await pool.query(
      `${baseCteSql} SELECT COUNT(*)::INT AS cnt FROM ranked_users WHERE telegram_id LIKE $1`,
      [`%${cleanSearch}%`]
    );
    totalMatched = Number(matchRes.rows[0]?.cnt || 0);
  }

  const usersRes = cleanSearch
    ? await pool.query(
        `${baseCteSql}
         SELECT * FROM ranked_users
         WHERE telegram_id LIKE $1
         ORDER BY
           CASE WHEN telegram_id = $2 THEN 0 WHEN telegram_id LIKE $3 THEN 1 ELSE 2 END ASC,
           global_rank ASC
         LIMIT $4 OFFSET $5`,
        [`%${cleanSearch}%`, cleanSearch, `${cleanSearch}%`, limit, offset]
      )
    : await pool.query(
        `${baseCteSql} SELECT * FROM ranked_users ORDER BY global_rank ASC LIMIT $1 OFFSET $2`,
        [limit, offset]
      );

  const users = usersRes.rows.map((row) => {
    const activeSessionEndsAt = row.active_ends_at !== null && row.active_ends_at !== undefined ? Number(row.active_ends_at) : null;
    const lastMineAt = row.resolved_last_mine_ms !== null && row.resolved_last_mine_ms !== undefined ? Number(row.resolved_last_mine_ms) : null;
    const completedCycles = Number(row.completed_cycles || 0);
    const totalMinedCents = Number(row.total_mined_cents || 0);

    let miningStatus = 'never_mined';
    if (activeSessionEndsAt !== null) {
      miningStatus = activeSessionEndsAt > now ? 'mining_now' : 'session_ready';
    } else if (lastMineAt !== null && lastMineAt >= activeWindowFloorMs) {
      miningStatus = 'active_24h';
    } else if (lastMineAt !== null || completedCycles > 0 || totalMinedCents > 0) {
      miningStatus = 'idle';
    }

    return {
      rank: Number(row.global_rank),
      telegramId: String(row.telegram_id),
      username: row.username || null,
      firstName: row.first_name || row.username || 'Miner',
      lastName: row.last_name || null,
      pointsCents: Number(row.effective_points_cents || 0),
      totalMinedCents,
      completedCycles,
      invitedCount: Number(row.invited_count || 0),
      registeredAt: row.registered_at_ms ? Number(row.registered_at_ms) : now,
      lastMineAt,
      activeSessionEndsAt,
      miningStatus,
    };
  });

  return {
    stats: {
      totalUsers: Number(statsRow.total_users || 0),
      activeMiners: Number(statsRow.active_miners || 0),
      liveMiningSessions: Number(statsRow.live_mining_sessions || 0),
      everMinedUsers: Number(statsRow.ever_mined_users || 0),
      totalPointsCents: Number(statsRow.total_points_cents || 0),
      serverTime: now,
    },
    users,
    pagination: {
      search: cleanSearch,
      totalMatched,
      limit,
      offset,
    },
    auth: {
      method: caller.method,
      adminTelegramId: caller.adminTelegramId,
    },
  };
}

function resolveAppOrigin(req) {
  const proto = (req.header('x-forwarded-proto') || req.protocol || 'https').split(',')[0].trim();
  const host = (req.header('x-forwarded-host') || req.header('host') || '').split(',')[0].trim();
  if (host) return `${proto}://${host}`;
  return RENDER_EXTERNAL_URL || PUBLIC_WEBAPP_URL;
}

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, X-Admin-Token, X-Telegram-Init-Data, X-Start-Param, X-Sandbox-Client-Id, X-Dev-Sandbox'
  );
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
});

app.use(express.json({ limit: '32kb' }));

app.get('/', (_req, res) => {
  res.status(200).send('HERT Mining backend is running.');
});

const handleHealth = async (_req, res) => {
  if (!pool) {
    res.status(503).json({ ok: false, status: 'error', database: 'unconfigured', timestamp: Date.now() });
    return;
  }
  try {
    await pool.query('SELECT 1');
    res.status(200).json({ ok: true, status: 'ok', database: 'connected', timestamp: Date.now() });
  } catch {
    res.status(503).json({ ok: false, status: 'error', database: 'disconnected', timestamp: Date.now() });
  }
};

app.get('/health', handleHealth);
app.get('/api/health', handleHealth);
app.get('/healthz', handleHealth);

app.get('/tonconnect-manifest.json', (req, res) => {
  const origin = PUBLIC_WEBAPP_URL || resolveAppOrigin(req);
  res.json({
    url: origin,
    name: 'HERT Mining',
    iconUrl: `${origin}/hert-icon-180.png`,
  });
});

app.get('/api/state', async (req, res) => {
  try {
    const tgUser = resolveRequestUser(req);
    const payload = await buildDashboardPayload(tgUser, resolveAppOrigin(req));
    res.json(payload);
  } catch (err) {
    res.status(401).json({ error: err.message || 'Authentication failed.' });
  }
});

app.post('/api/mining/start', async (req, res) => {
  try {
    const tgUser = resolveRequestUser(req);
    const now = Date.now();
    const { activationBonusCents } = await withTransaction(async (client) => {
      await ensureUserInTx(client, tgUser, now);

      const existing = await client.query(
        `SELECT * FROM mining_sessions WHERE user_id = $1 AND claimed_at IS NULL LIMIT 1`,
        [tgUser.telegramId]
      );
      if (existing.rows.length > 0) {
        throw new Error('A mining session is already active or waiting to be claimed.');
      }

      const userMeta = await client.query(
        `SELECT last_mine_at,
                CASE WHEN last_mine IS NOT NULL THEN (EXTRACT(EPOCH FROM last_mine) * 1000)::BIGINT ELSE NULL END AS pg_last_mine_ms
         FROM users WHERE telegram_id::TEXT = $1`,
        [tgUser.telegramId]
      );
      const lastMineMs = Number(userMeta.rows[0]?.last_mine_at || userMeta.rows[0]?.pg_last_mine_ms || 0);
      const canGrantActivationBonus = !lastMineMs || now - lastMineMs >= START_MINING_BONUS_COOLDOWN_MS;
      const bonus = canGrantActivationBonus ? START_MINING_ACTIVATION_BONUS_CENTS : 0;

      const rate = await computeEffectiveRateCents(client, tgUser.telegramId, now);
      await client.query(
        `INSERT INTO mining_sessions (user_id, started_at, ends_at, rate_cents_per_hour, banked_cents, rate_anchor_at, earned_cents, status)
         VALUES ($1, $2, $3, $4, 0, $5, 0, 'active')`,
        [tgUser.telegramId, now, now + CYCLE_DURATION_MS, rate, now]
      );

      if (bonus > 0) {
        await client.query(
          `UPDATE users
           SET points_cents = COALESCE(points_cents, 0) + $1,
               points = FLOOR((COALESCE(points_cents, 0) + $1) / 100.0)::BIGINT,
               total_mined_cents = COALESCE(total_mined_cents, 0) + $1,
               last_mine_at = $2,
               last_mine = NOW()
           WHERE telegram_id::TEXT = $3`,
          [bonus, now, tgUser.telegramId]
        );
        await client.query(
          `INSERT INTO point_ledger (user_id, entry_type, amount_cents, description, created_at)
           VALUES ($1, 'mining_claim', $2, 'Mining session started (+1.00 HERT)', $3)`,
          [tgUser.telegramId, bonus, now]
        );
      } else {
        await client.query(
          `UPDATE users SET last_mine_at = $1, last_mine = NOW() WHERE telegram_id::TEXT = $2`,
          [now, tgUser.telegramId]
        );
      }

      return { activationBonusCents: bonus };
    });

    const payload = await buildDashboardPayload(tgUser, resolveAppOrigin(req));
    res.json({ activationBonusCents, payload });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Unable to start mining.' });
  }
});

app.post('/api/mining/claim', async (req, res) => {
  try {
    const tgUser = resolveRequestUser(req);
    const now = Date.now();
    const { claimedCents } = await withTransaction(async (client) => {
      await ensureUserInTx(client, tgUser, now);

      const sessionRes = await client.query(
        `SELECT * FROM mining_sessions WHERE user_id = $1 AND claimed_at IS NULL ORDER BY id DESC LIMIT 1`,
        [tgUser.telegramId]
      );
      const sessionRow = sessionRes.rows[0];
      if (!sessionRow) throw new Error('No active mining session found to claim.');

      const computed = computeSessionState(sessionRow, now);
      if (!computed.canClaim || computed.accruedCents <= 0) {
        const waitSec = Math.max(1, Math.ceil((MIN_HARVEST_SECONDS * 1000 - computed.elapsedMs) / 1000));
        throw new Error(`Mining warm-up in progress. Claim unlocks in ${waitSec}s.`);
      }

      await client.query(
        `UPDATE mining_sessions SET status = 'claimed', claimed_at = $1, earned_cents = $2 WHERE id = $3`,
        [now, computed.accruedCents, sessionRow.id]
      );
      await client.query(
        `UPDATE users
         SET points_cents = COALESCE(points_cents, 0) + $1,
             points = FLOOR((COALESCE(points_cents, 0) + $1) / 100.0)::BIGINT,
             total_mined_cents = COALESCE(total_mined_cents, 0) + $1,
             completed_cycles = COALESCE(completed_cycles, 0) + 1
         WHERE telegram_id::TEXT = $2`,
        [computed.accruedCents, tgUser.telegramId]
      );
      await client.query(
        `INSERT INTO point_ledger (user_id, entry_type, amount_cents, description, created_at)
         VALUES ($1, 'mining_claim', $2, $3, $4)`,
        [
          tgUser.telegramId,
          computed.accruedCents,
          computed.isComplete ? 'Completed 4h mining cycle claimed' : 'Active mining cycle harvested',
          now,
        ]
      );

      const userRefRes = await client.query(
        `SELECT referred_by::TEXT AS referred_by, first_name FROM users WHERE telegram_id::TEXT = $1`,
        [tgUser.telegramId]
      );
      const referredBy = userRefRes.rows[0]?.referred_by;
      if (referredBy) {
        const commission = Math.floor(computed.accruedCents * REFERRAL_COMMISSION_RATE);
        if (commission > 0) {
          await client.query(
            `UPDATE users
             SET points_cents = COALESCE(points_cents, 0) + $1,
                 points = FLOOR((COALESCE(points_cents, 0) + $1) / 100.0)::BIGINT
             WHERE telegram_id::TEXT = $2`,
            [commission, referredBy]
          );
          await client.query(
            `UPDATE referrals SET commission_earned_cents = commission_earned_cents + $1 WHERE referred_id = $2`,
            [commission, tgUser.telegramId]
          );
          await client.query(
            `INSERT INTO point_ledger (user_id, entry_type, amount_cents, description, created_at)
             VALUES ($1, 'referral_commission', $2, $3, $4)`,
            [referredBy, commission, `10% mining commission from ${userRefRes.rows[0]?.first_name || 'Miner'}`, now]
          );
        }
      }

      return { claimedCents: computed.accruedCents };
    });

    const payload = await buildDashboardPayload(tgUser, resolveAppOrigin(req));
    res.json({ claimedCents, payload });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Unable to claim mining points.' });
  }
});

app.post('/api/checkin/claim', async (req, res) => {
  try {
    const tgUser = resolveRequestUser(req);
    const now = Date.now();
    const { rewardCents, streakDay } = await withTransaction(async (client) => {
      await ensureUserInTx(client, tgUser, now);

      const userRes = await client.query(
        `SELECT checkin_streak, last_checkin_at, last_checkin FROM users WHERE telegram_id::TEXT = $1 FOR UPDATE`,
        [tgUser.telegramId]
      );
      const userRow = userRes.rows[0];
      const todayKey = getUtcDateKey(now);
      const yesterdayKey = getUtcDateKey(now - 86400000);
      const lastCheckInAt = userRow.last_checkin_at ? Number(userRow.last_checkin_at) : null;

      const existingToday = await client.query(
        `SELECT id FROM daily_checkins WHERE user_id = $1 AND checkin_date = $2 LIMIT 1`,
        [tgUser.telegramId, todayKey]
      );
      if (existingToday.rows.length > 0 || (lastCheckInAt && getUtcDateKey(lastCheckInAt) === todayKey)) {
        throw new Error('Daily check-in already claimed today. Come back tomorrow after 00:00 UTC.');
      }

      let newStreak = 1;
      if (lastCheckInAt && getUtcDateKey(lastCheckInAt) === yesterdayKey) {
        const prev = Number(userRow.checkin_streak || 0);
        newStreak = prev >= 7 ? 1 : prev + 1;
      }

      await client.query(
        `INSERT INTO daily_checkins (user_id, streak_day, reward_cents, checkin_date, checked_in_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [tgUser.telegramId, newStreak, DAILY_CHECKIN_REWARD_CENTS, todayKey, now]
      );

      await client.query(
        `UPDATE users
         SET points_cents = COALESCE(points_cents, 0) + $1,
             points = FLOOR((COALESCE(points_cents, 0) + $1) / 100.0)::BIGINT,
             checkin_streak = $2,
             last_checkin_at = $3,
             last_checkin = CURRENT_DATE
         WHERE telegram_id::TEXT = $4`,
        [DAILY_CHECKIN_REWARD_CENTS, newStreak, now, tgUser.telegramId]
      );

      await client.query(
        `INSERT INTO point_ledger (user_id, entry_type, amount_cents, description, created_at)
         VALUES ($1, 'daily_checkin', $2, $3, $4)`,
        [tgUser.telegramId, DAILY_CHECKIN_REWARD_CENTS, `Daily check-in reward (Day ${newStreak})`, now]
      );

      return { rewardCents: DAILY_CHECKIN_REWARD_CENTS, streakDay: newStreak };
    });

    const payload = await buildDashboardPayload(tgUser, resolveAppOrigin(req));
    res.json({ rewardCents, streakDay, payload });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Daily check-in unavailable.' });
  }
});

app.post('/api/referrals/apply', async (req, res) => {
  try {
    const tgUser = resolveRequestUser(req);
    const code = typeof req.body?.code === 'string' ? req.body.code : '';
    const now = Date.now();
    await withTransaction(async (client) => {
      await ensureUserInTx(client, tgUser, now);
      const outcome = await applyReferralInTx(client, tgUser.telegramId, code, now);
      if (!outcome.applied) {
        throw new Error(outcome.reason || 'Unable to apply referral code.');
      }
    });
    const payload = await buildDashboardPayload(tgUser, resolveAppOrigin(req));
    res.json({ payload });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Unable to apply referral code.' });
  }
});

app.post('/api/boosts/buy', async (req, res) => {
  try {
    const tgUser = resolveRequestUser(req);
    const tierId = typeof req.body?.tierId === 'string' ? req.body.tierId : '';
    const tier = BOOST_CATALOG.find((item) => item.id === tierId);
    if (!tier) throw new Error('Selected boost tier does not exist.');

    const now = Date.now();
    await withTransaction(async (client) => {
      await ensureUserInTx(client, tgUser, now);

      const userRes = await client.query(
        `SELECT points, points_cents FROM users WHERE telegram_id::TEXT = $1 FOR UPDATE`,
        [tgUser.telegramId]
      );
      const balanceCents = Math.max(
        Number(userRes.rows[0]?.points_cents || 0),
        Number(userRes.rows[0]?.points || 0) * 100
      );
      if (balanceCents < tier.costCents) {
        throw new Error(`Insufficient balance. You need ${(tier.costCents / 100).toFixed(2)} HERT Points.`);
      }

      const activeBoost = await getActiveBoostRow(client, tgUser.telegramId, now);
      if (activeBoost) {
        const currentBonus = Number(activeBoost.bonus_rate_cents_per_hour);
        if (currentBonus >= tier.bonusRateCentsPerHour) {
          throw new Error(
            currentBonus === tier.bonusRateCentsPerHour
              ? `${activeBoost.boost_name} is already active.`
              : `A higher boost (${activeBoost.boost_name}) is already active.`
          );
        }
        await client.query(`UPDATE mining_boosts SET expires_at = $1 WHERE id = $2`, [now, activeBoost.id]);
      }

      const newBalanceCents = balanceCents - tier.costCents;
      await client.query(
        `UPDATE users
         SET points_cents = $1,
             points = FLOOR($1 / 100.0)::BIGINT
         WHERE telegram_id::TEXT = $2`,
        [newBalanceCents, tgUser.telegramId]
      );

      await client.query(
        `INSERT INTO mining_boosts (user_id, boost_tier, boost_name, cost_cents, bonus_rate_cents_per_hour, activated_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [tgUser.telegramId, tier.id, tier.name, tier.costCents, tier.bonusRateCentsPerHour, now, now + tier.durationMs]
      );

      await client.query(
        `INSERT INTO point_ledger (user_id, entry_type, amount_cents, description, created_at)
         VALUES ($1, 'boost_purchase', $2, $3, $4)`,
        [tgUser.telegramId, -tier.costCents, `Activated 24h ${tier.name}`, now]
      );

      const newEffectiveRate = await computeEffectiveRateCents(client, tgUser.telegramId, now);
      const activeSessionRes = await client.query(
        `SELECT * FROM mining_sessions WHERE user_id = $1 AND claimed_at IS NULL ORDER BY id DESC LIMIT 1`,
        [tgUser.telegramId]
      );
      const session = activeSessionRes.rows[0];
      if (session && now < Number(session.ends_at)) {
        const snap = computeSessionState(session, now);
        await client.query(
          `UPDATE mining_sessions SET banked_cents = $1, rate_anchor_at = $2, rate_cents_per_hour = $3 WHERE id = $4`,
          [snap.accruedCents, now, newEffectiveRate, session.id]
        );
      }
    });

    const payload = await buildDashboardPayload(tgUser, resolveAppOrigin(req));
    res.json({ boost: tier, payload });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Unable to activate mining boost.' });
  }
});

app.post('/api/tasks/start', async (req, res) => {
  try {
    const tgUser = resolveRequestUser(req);
    const taskId = typeof req.body?.taskId === 'string' ? req.body.taskId : '';
    const task = TASK_CATALOG.find((t) => t.id === taskId);
    if (!task) throw new Error('Task not found.');

    const now = Date.now();
    await withTransaction(async (client) => {
      await ensureUserInTx(client, tgUser, now);
      const existing = await client.query(
        `SELECT * FROM task_claims WHERE user_id = $1 AND task_id = $2`,
        [tgUser.telegramId, task.id]
      );
      if (existing.rows[0]?.status === 'claimed') {
        throw new Error('This task reward has already been claimed.');
      }
      if (existing.rows.length === 0) {
        await client.query(
          `INSERT INTO task_claims (user_id, task_id, status, started_at, reward_cents)
           VALUES ($1, $2, 'started', $3, $4)`,
          [tgUser.telegramId, task.id, now, task.rewardCents]
        );
      }
    });

    const payload = await buildDashboardPayload(tgUser, resolveAppOrigin(req));
    res.json({ payload });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Unable to start task.' });
  }
});

app.post('/api/tasks/claim', async (req, res) => {
  try {
    const tgUser = resolveRequestUser(req);
    const taskId = typeof req.body?.taskId === 'string' ? req.body.taskId : '';
    const task = TASK_CATALOG.find((t) => t.id === taskId);
    if (!task) throw new Error('Task not found.');

    if (task.id === 'join_tg_channel' && tgUser.verified) {
      const isMember = await checkTelegramChannelMembership(tgUser.telegramId, CHANNEL_ID);
      if (isMember === false) {
        throw new Error(`Not joined yet â€” tap "${task.actionLabel}" to subscribe first, then return and claim.`);
      }
    }

    const now = Date.now();
    await withTransaction(async (client) => {
      await ensureUserInTx(client, tgUser, now);

      const existing = await client.query(
        `SELECT * FROM task_claims WHERE user_id = $1 AND task_id = $2 FOR UPDATE`,
        [tgUser.telegramId, task.id]
      );
      if (existing.rows[0]?.status === 'claimed') {
        throw new Error('Task bonus already claimed.');
      }

      if (task.category === 'social') {
        if (existing.rows.length === 0) {
          throw new Error(`Open "${task.actionLabel}" first before claiming this task bonus.`);
        }
        const elapsed = now - Number(existing.rows[0].started_at);
        if (elapsed < TASK_VERIFY_WAIT_MS) {
          const rem = Math.max(1, Math.ceil((TASK_VERIFY_WAIT_MS - elapsed) / 1000));
          throw new Error(`Verification in progress. Please try claiming again in ${rem}s.`);
        }
        await client.query(
          `UPDATE task_claims SET status = 'claimed', claimed_at = $1, reward_cents = $2 WHERE id = $3`,
          [now, task.rewardCents, existing.rows[0].id]
        );
      } else {
        const uRes = await client.query(
          `SELECT completed_cycles, checkin_streak FROM users WHERE telegram_id::TEXT = $1`,
          [tgUser.telegramId]
        );
        const wRes = await client.query(
          `SELECT user_id FROM wallet_connections WHERE user_id = $1`,
          [tgUser.telegramId]
        );
        const cRes = await client.query(
          `SELECT COUNT(*)::INT AS cnt FROM daily_checkins WHERE user_id = $1`,
          [tgUser.telegramId]
        );
        const bRes = await client.query(
          `SELECT COUNT(*)::INT AS cnt FROM mining_boosts WHERE user_id = $1`,
          [tgUser.telegramId]
        );

        let met = false;
        if (task.id === 'link_ton_wallet') met = wRes.rows.length > 0;
        if (task.id === 'complete_first_cycle') met = Number(uRes.rows[0]?.completed_cycles || 0) >= 1;
        if (task.id === 'complete_first_checkin') met = Number(cRes.rows[0]?.cnt || 0) >= 1;
        if (task.id === 'activate_first_boost') met = Number(bRes.rows[0]?.cnt || 0) > 0;
        if (!met) throw new Error('Complete the milestone requirement first before claiming.');

        await client.query(
          `INSERT INTO task_claims (user_id, task_id, status, started_at, claimed_at, reward_cents)
           VALUES ($1, $2, 'claimed', $3, $3, $4)
           ON CONFLICT (user_id, task_id)
           DO UPDATE SET status = 'claimed', claimed_at = EXCLUDED.claimed_at, reward_cents = EXCLUDED.reward_cents`,
          [tgUser.telegramId, task.id, now, task.rewardCents]
        );
      }

      await client.query(
        `UPDATE users
         SET points_cents = COALESCE(points_cents, 0) + $1,
             points = FLOOR((COALESCE(points_cents, 0) + $1) / 100.0)::BIGINT
         WHERE telegram_id::TEXT = $2`,
        [task.rewardCents, tgUser.telegramId]
      );

      await client.query(
        `INSERT INTO point_ledger (user_id, entry_type, amount_cents, description, created_at)
         VALUES ($1, 'task_reward', $2, $3, $4)`,
        [tgUser.telegramId, task.rewardCents, `Task completed: ${task.title}`, now]
      );
    });

    const payload = await buildDashboardPayload(tgUser, resolveAppOrigin(req));
    res.json({ rewardCents: task.rewardCents, title: task.title, payload });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Unable to claim task bonus.' });
  }
});

app.post('/api/wallet/nonce', async (req, res) => {
  try {
    const tgUser = resolveRequestUser(req);
    const now = Date.now();
    const nonce = crypto.randomBytes(24).toString('hex');
    await withTransaction(async (client) => {
      await ensureUserInTx(client, tgUser, now);
      await client.query(`DELETE FROM wallet_proof_nonces WHERE expires_at < $1`, [now]);
      await client.query(
        `INSERT INTO wallet_proof_nonces (nonce, user_id, expires_at) VALUES ($1, $2, $3)`,
        [nonce, tgUser.telegramId, now + 15 * 60 * 1000]
      );
    });
    res.json({ nonce });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Failed to generate wallet nonce.' });
  }
});

app.post('/api/wallet/connect', async (req, res) => {
  try {
    const tgUser = resolveRequestUser(req);
    const cleanAddr = String(req.body?.tonAddress || '').trim();
    if (cleanAddr.length < 24 || cleanAddr.length > 100) {
      throw new Error('Invalid public TON wallet address.');
    }
    const now = Date.now();
    await withTransaction(async (client) => {
      await ensureUserInTx(client, tgUser, now);
      let proofVerified = 0;
      if (req.body?.proofPayload) {
        const nonceRow = await client.query(
          `SELECT * FROM wallet_proof_nonces WHERE nonce = $1 AND user_id = $2 AND expires_at >= $3`,
          [req.body.proofPayload, tgUser.telegramId, now]
        );
        if (nonceRow.rows.length > 0) {
          proofVerified = 1;
          await client.query(`DELETE FROM wallet_proof_nonces WHERE nonce = $1`, [req.body.proofPayload]);
        }
      }
      await client.query(
        `INSERT INTO wallet_connections (user_id, ton_address, raw_address, wallet_app_name, public_key, proof_verified, connected_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (user_id) DO UPDATE SET
           ton_address = EXCLUDED.ton_address,
           raw_address = EXCLUDED.raw_address,
           wallet_app_name = EXCLUDED.wallet_app_name,
           public_key = EXCLUDED.public_key,
           proof_verified = EXCLUDED.proof_verified,
           connected_at = EXCLUDED.connected_at`,
        [
          tgUser.telegramId,
          cleanAddr,
          req.body?.rawAddress || null,
          String(req.body?.walletAppName || 'TON Wallet').slice(0, 60),
          req.body?.publicKey || null,
          proofVerified,
          now,
        ]
      );
    });
    const payload = await buildDashboardPayload(tgUser, resolveAppOrigin(req));
    res.json({ payload });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Failed to save TON wallet connection.' });
  }
});

app.post('/api/wallet/disconnect', async (req, res) => {
  try {
    const tgUser = resolveRequestUser(req);
    await withTransaction(async (client) => {
      await client.query(`DELETE FROM wallet_connections WHERE user_id = $1`, [tgUser.telegramId]);
    });
    const payload = await buildDashboardPayload(tgUser, resolveAppOrigin(req));
    res.json({ payload });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Failed to disconnect wallet.' });
  }
});

// Secure Admin Dashboard Routes
app.post('/api/admin/login', (req, res) => {
  const ip = (req.header('x-forwarded-for') || req.ip || 'unknown').split(',')[0].trim();
  const now = Date.now();
  const bucket = failedAdminAttempts.get(ip);
  if (bucket && now < bucket.resetAt && bucket.count >= MAX_FAILED_ADMIN_ATTEMPTS) {
    const waitMin = Math.max(1, Math.ceil((bucket.resetAt - now) / 60000));
    res.status(429).json({
      error: `Too many failed admin login attempts. Please wait ${waitMin} minute(s) before trying again.`,
    });
    return;
  }

  const adminSecret = getConfiguredAdminSecret();
  if (!adminSecret) {
    res.status(503).json({
      error: 'Token login is not enabled on the server. Configure ADMIN_DASHBOARD_TOKEN in Render Environment Variables.',
    });
    return;
  }

  const candidate = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
  if (!candidate) {
    res.status(400).json({ error: 'Enter your admin access token.' });
    return;
  }

  if (!safeEqualSecret(candidate, adminSecret)) {
    const existing = failedAdminAttempts.get(ip);
    if (!existing || now >= existing.resetAt) {
      failedAdminAttempts.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    } else {
      existing.count += 1;
    }
    res.status(401).json({ error: 'Invalid admin access token.' });
    return;
  }

  failedAdminAttempts.delete(ip);
  const { sessionToken, expiresAt } = issueAdminSessionToken(adminSecret);
  res.json({
    authenticated: true,
    sessionToken,
    expiresAt,
    method: 'admin_token',
  });
});

app.get('/api/admin/session', (req, res) => {
  const configured =
    Boolean(getConfiguredAdminSecret()) ||
    (Boolean(BOT_TOKEN) && getConfiguredAdminTelegramIds().size > 0);
  try {
    const caller = verifyAdminRequest(req);
    res.json({
      authenticated: true,
      configured,
      method: caller.method,
      adminTelegramId: caller.adminTelegramId,
    });
  } catch {
    res.json({
      authenticated: false,
      configured,
      method: null,
      adminTelegramId: null,
    });
  }
});

app.get('/api/admin/dashboard', async (req, res) => {
  try {
    const caller = verifyAdminRequest(req);
    const search = typeof req.query.search === 'string' ? req.query.search : '';
    const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : 50;
    const offset = typeof req.query.offset === 'string' ? Number(req.query.offset) : 0;
    const payload = await getAdminDashboardPayload(caller, { search, limit, offset });
    res.json(payload);
  } catch (err) {
    res.status(err.status || 500).json({
      error: err.message || 'Unable to load admin dashboard data.',
    });
  }
});

// Telegram Bot Webhook Handler
async function sendTelegramMessage(chatId, text, replyMarkup) {
  if (!BOT_TOKEN) return;
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      reply_markup: replyMarkup,
    }),
  }).catch(() => {});
}

async function handleWebhook(req, res) {
  if (WEBHOOK_SECRET) {
    const incoming = req.header('x-telegram-bot-api-secret-token') || '';
    if (incoming !== WEBHOOK_SECRET) {
      res.status(403).json({ ok: false });
      return;
    }
  }

  res.status(200).json({ ok: true });

  const msg = req.body?.message;
  if (!msg || !msg.from || msg.from.is_bot || !msg.text || !pool) return;

  const text = String(msg.text).trim();
  const lower = text.toLowerCase();
  const tgUser = {
    telegramId: String(msg.from.id),
    username: msg.from.username || null,
    firstName: msg.from.first_name || 'Miner',
    lastName: msg.from.last_name || null,
    photoUrl: null,
    isPremium: Boolean(msg.from.is_premium),
    startParam: text.startsWith('/start ') ? text.slice(7).trim() || null : null,
    verified: true,
  };

  const replyKeyboard = {
    keyboard: [
      [{ text: 'Start Mining' }, { text: 'Daily Check-in' }],
      [{ text: 'My Balance' }, { text: 'Invite Friends' }],
    ],
    resize_keyboard: true,
  };

  try {
    if (lower.startsWith('/start')) {
      const state = await buildDashboardPayload(tgUser, PUBLIC_WEBAPP_URL);
      const inlineMarkup = {
        inline_keyboard: [
          [{ text: 'Launch HERT Mining App', web_app: { url: PUBLIC_WEBAPP_URL } }],
        ],
      };
      await sendTelegramMessage(
        msg.chat.id,
        `<b>Welcome to HERT Mining, ${tgUser.firstName}!</b>\n\nBalance: <b>${(state.user.pointsCents / 100).toFixed(2)} HERT</b>\nInvite Code: <code>${state.referrals.referralCode}</code>\n\nTap below to open the HERT Mining Mini App:`,
        inlineMarkup
      );
      return;
    }

    if (lower === 'start mining' || lower.includes('start mining') || lower === '/mine') {
      const now = Date.now();
      let msgText = '';
      await withTransaction(async (client) => {
        await ensureUserInTx(client, tgUser, now);
        const active = await client.query(
          `SELECT * FROM mining_sessions WHERE user_id = $1 AND claimed_at IS NULL LIMIT 1`,
          [tgUser.telegramId]
        );
        if (active.rows.length === 0) {
          const rate = await computeEffectiveRateCents(client, tgUser.telegramId, now);
          await client.query(
            `INSERT INTO mining_sessions (user_id, started_at, ends_at, rate_cents_per_hour, banked_cents, rate_anchor_at, earned_cents, status)
             VALUES ($1, $2, $3, $4, 0, $2, 0, 'active')`,
            [tgUser.telegramId, now, now + CYCLE_DURATION_MS, rate]
          );
          await client.query(
            `UPDATE users
             SET points_cents = COALESCE(points_cents, 0) + 100,
                 points = FLOOR((COALESCE(points_cents, 0) + 100) / 100.0)::BIGINT,
                 total_mined_cents = COALESCE(total_mined_cents, 0) + 100,
                 last_mine_at = $1,
                 last_mine = NOW()
             WHERE telegram_id::TEXT = $2`,
            [now, tgUser.telegramId]
          );
          msgText = `<b>Mining session started!</b>\n+1.00 HERT activation point recorded and your 4-hour cycle is now active.`;
        } else {
          msgText = `Your 4-hour mining session is already active! Open the Mini App to track and harvest your HERT Points.`;
        }
      });
      await sendTelegramMessage(msg.chat.id, msgText, replyKeyboard);
      return;
    }

    if (lower === 'daily check-in' || lower.includes('check-in') || lower === '/checkin' || lower === '/daily') {
      const now = Date.now();
      let msgText = '';
      await withTransaction(async (client) => {
        await ensureUserInTx(client, tgUser, now);
        const todayKey = getUtcDateKey(now);
        const existingToday = await client.query(
          `SELECT id FROM daily_checkins WHERE user_id = $1 AND checkin_date = $2 LIMIT 1`,
          [tgUser.telegramId, todayKey]
        );
        if (existingToday.rows.length > 0) {
          msgText = `You already claimed your +10.00 HERT daily check-in today. Come back tomorrow after 00:00 UTC!`;
          return;
        }
        await client.query(
          `INSERT INTO daily_checkins (user_id, streak_day, reward_cents, checkin_date, checked_in_at)
           VALUES ($1, 1, $2, $3, $4)`,
          [tgUser.telegramId, DAILY_CHECKIN_REWARD_CENTS, todayKey, now]
        );
        await client.query(
          `UPDATE users
           SET points_cents = COALESCE(points_cents, 0) + $1,
               points = FLOOR((COALESCE(points_cents, 0) + $1) / 100.0)::BIGINT,
               checkin_streak = COALESCE(checkin_streak, 0) + 1,
               last_checkin_at = $2,
               last_checkin = CURRENT_DATE
           WHERE telegram_id::TEXT = $3`,
          [DAILY_CHECKIN_REWARD_CENTS, now, tgUser.telegramId]
        );
        await client.query(
          `INSERT INTO point_ledger (user_id, entry_type, amount_cents, description, created_at)
           VALUES ($1, 'daily_checkin', $2, 'Daily check-in reward', $3)`,
          [tgUser.telegramId, DAILY_CHECKIN_REWARD_CENTS, now]
        );
        msgText = `<b>Daily check-in complete!</b>\n+10.00 HERT Points added to your balance.`;
      });
      await sendTelegramMessage(msg.chat.id, msgText, replyKeyboard);
      return;
    }

    if (lower === 'my balance' || lower.includes('balance') || lower === '/balance') {
      const state = await buildDashboardPayload(tgUser, PUBLIC_WEBAPP_URL);
      await sendTelegramMessage(
        msg.chat.id,
        `<b>My HERT Balance</b>\n\nVerified Balance: <b>${(state.user.pointsCents / 100).toFixed(2)} HERT</b>\nInvited Friends: <b>${state.referrals.invitedCount}</b>\nCompleted Cycles: <b>${state.user.completedCycles}</b>`,
        replyKeyboard
      );
      return;
    }

    if (lower === 'invite friends' || lower.includes('invite') || lower === '/invite') {
      const state = await buildDashboardPayload(tgUser, PUBLIC_WEBAPP_URL);
      const link = state.referrals.telegramDeepLink || state.referrals.webInviteLink;
      await sendTelegramMessage(
        msg.chat.id,
        `<b>Invite Friends & Earn HERT</b>\n\nYour Invite Link:\n${link}\n\nYour Code: <code>${state.referrals.referralCode}</code>\nInvited Friends: <b>${state.referrals.invitedCount}</b>`,
        replyKeyboard
      );
    }
  } catch (err) {
    console.error('[HERT Webhook Error]:', err);
  }
}

app.post('/telegram/webhook', handleWebhook);
app.post('/api/telegram/webhook', handleWebhook);

app.all('/api/*', (_req, res) => {
  res.status(404).json({ error: 'API endpoint not found.' });
});

initDatabase()
  .then(() => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`HERT Mining server listening on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error('[HERT Backend] Database initialization failed:', err);
    process.exit(1);
  });
