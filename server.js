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
const MINI_APP_SHORT_NAME = cleanEnv(process.env.TELEGRAM_MINI_APP_SHORT_NAME).replace(
  /^\/+|\/+$/g,
  ''
);
const WEBHOOK_SECRET = cleanEnv(process.env.TELEGRAM_WEBHOOK_SECRET);
const RENDER_EXTERNAL_URL = cleanEnv(process.env.RENDER_EXTERNAL_URL).replace(/\/+$/, '');
const RAW_PUBLIC_WEBAPP_URL = cleanEnv(
  process.env.PUBLIC_WEBAPP_URL ||
    process.env.WEBAPP_URL ||
    RENDER_EXTERNAL_URL ||
    'https://hert-mining-backend.onrender.com'
).replace(/\/+$/, '');
const PUBLIC_WEBAPP_URL =
  RAW_PUBLIC_WEBAPP_URL.startsWith('https://') &&
  !/^https:\/\/ais-(dev|pre)-/i.test(RAW_PUBLIC_WEBAPP_URL) &&
  !/\.(run\.app|ai\.studio)$/i.test(RAW_PUBLIC_WEBAPP_URL)
    ? RAW_PUBLIC_WEBAPP_URL
    : RENDER_EXTERNAL_URL || 'https://hert-mining-backend.onrender.com';
const CHANNEL_ID = cleanEnv(process.env.HERT_TELEGRAM_CHANNEL_ID || '@hertchannels');
const CHANNEL_URL = cleanEnv(process.env.HERT_TELEGRAM_CHANNEL_URL || 'https://t.me/hertchannels');
const BOOST_URL = cleanEnv(
  process.env.HERT_TELEGRAM_BOOST_URL || 'https://t.me/hertchannels?boost'
).replace(/^https:\/\/t\.me\/boost\/([A-Za-z0-9_]+)\/?$/i, 'https://t.me/$1?boost');

const BASE_RATE_CENTS_PER_HOUR = 3000;
const REFERRAL_BOOST_PER_FRIEND_CENTS = 300;
const MAX_REFERRAL_BOOST_FRIENDS = 10;
const CYCLE_DURATION_MS = 4 * 60 * 60 * 1000;
const MIN_HARVEST_SECONDS = 60;
const BOOST_DURATION_MS = 24 * 60 * 60 * 1000;

const INVITER_JOIN_BONUS_CENTS = 2500; // Exact +25.00 HERT awarded to inviter per genuinely new user
const FRIEND_WELCOME_BONUS_CENTS = 2500; // +25.00 HERT
const MANUAL_REFERRAL_NEW_USER_WINDOW_MS = 30 * 60 * 1000; // 30-min fresh registration window
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

const DEFAULT_GAS_RECEIVER_TON_ADDRESS = 'UQBtJdIH5HsQ5_2tqhP9PmAGQEdjTiBtmi7OJbCFtE_BH_P1';

const BOOST_CATALOG = [];

const TASK_CATALOG = [
  {
    id: 'join_interlink_labs',
    title: 'Join Interlink Labs',
    description:
      'Join Interlink Labs via the official invite link, then return here and tap Claim Reward to earn +35 HERT.',
    category: 'social',
    platform: 'partner',
    verificationMode: 'auto_milestone',
    rewardCents: 3500,
    actionUrl: 'https://interlinklabs.ai/08067934296',
    targetTab: null,
    actionLabel: 'Join Now',
  },
  {
    id: 'join_verychat',
    title: 'Join Verychat',
    description:
      'Join Verychat via the official invite link, then return here and tap Claim Reward to earn +35 HERT.',
    category: 'social',
    platform: 'partner',
    verificationMode: 'auto_milestone',
    rewardCents: 3500,
    actionUrl: 'https://invite.verychat.io/0808abdool',
    targetTab: null,
    actionLabel: 'Join Now',
  },
  {
    id: 'join_gram_network',
    title: 'Join Gram Network',
    description:
      'Launch Gram Network on Telegram via the official link, then return here and tap Claim Reward to earn +35 HERT.',
    category: 'social',
    platform: 'partner',
    verificationMode: 'auto_milestone',
    rewardCents: 3500,
    actionUrl: 'https://telegram.me/Gramnetwork_bot?startapp=6701186910',
    targetTab: null,
    actionLabel: 'Join Now',
  },
  {
    id: 'join_tg_channel',
    title: 'Follow Official HERT Community',
    description:
      'Visit and follow the official HERT community channel for ecosystem & token updates, then return here to claim +30 HERT.',
    category: 'social',
    platform: 'partner',
    verificationMode: 'auto_milestone',
    rewardCents: 3000,
    actionUrl: CHANNEL_URL,
    targetTab: null,
    actionLabel: 'Join Now',
  },
  {
    id: 'link_ton_wallet',
    title: 'Connect Non-Custodial TON Wallet',
    description: 'Link Tonkeeper, Telegram Wallet, or MyTonWallet via TON Connect 2.0.',
    category: 'milestone',
    platform: 'ton',
    verificationMode: 'auto_milestone',
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
    verificationMode: 'auto_milestone',
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
    verificationMode: 'auto_milestone',
    rewardCents: 2000,
    actionUrl: null,
    targetTab: 'checkin',
    actionLabel: 'Daily Check-In',
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
        u.searchParams.get('start') ||
        u.searchParams.get('startapp') ||
        u.searchParams.get('ref') ||
        u.searchParams.get('tgWebAppStartParam') ||
        '';
      if (param) cleaned = param.trim();
    }
  } catch {
    // ignore URL parse errors
  }

  cleaned = cleaned.replace(/^ref[-_]/i, '').trim();
  if (!cleaned) return null;

  const upper = cleaned.toUpperCase();

  // Explicit HERT-XXXXXX code (including 6-digit hex digests like HERT-193847)
  if (upper.startsWith('HERT-') && /^HERT-[A-Z0-9]{4,12}$/.test(upper)) {
    return { referralCode: upper, numericTelegramId: null };
  }

  // 7–20 digit positive Telegram user ID
  if (/^\d{7,20}$/.test(upper)) {
    return { referralCode: null, numericTelegramId: upper };
  }

  // 4–12 character alphanumeric code without HERT- prefix (check referral_code first, then numeric ID if digits)
  if (/^[A-Z0-9]{4,12}$/.test(upper)) {
    return {
      referralCode: `HERT-${upper}`,
      numericTelegramId: /^\d{5,12}$/.test(upper) ? upper : null,
    };
  }

  return null;
}

function normalizeReferralParam(raw) {
  const target = extractReferralTarget(raw);
  if (!target) return null;
  if (target.referralCode) return target.referralCode;
  if (target.numericTelegramId) return `ref_${target.numericTelegramId}`;
  return null;
}

function verifyTelegramInitData(initDataRaw, botToken) {
  const params = new URLSearchParams(initDataRaw);
  const receivedHash = params.get('hash');
  if (!receivedHash || !/^[0-9a-f]{64}$/i.test(receivedHash)) {
    throw new Error('Missing or malformed hash in Telegram initData.');
  }

  const authDate = Number(params.get('auth_date') || '0');
  if (!Number.isFinite(authDate) || authDate <= 0) {
    throw new Error('Missing or invalid auth_date in Telegram initData.');
  }
  const nowSec = Math.floor(Date.now() / 1000);
  if (nowSec - authDate > 86400) {
    throw new Error('Telegram session expired. Please reopen HERT Mining from Telegram.');
  }
  if (authDate > nowSec + 300) {
    throw new Error('Invalid future auth_date in Telegram initData.');
  }

  const pairs = [];
  params.forEach((value, key) => {
    if (key !== 'hash') pairs.push(`${key}=${value}`);
  });
  pairs.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const calculatedHash = crypto.createHmac('sha256', secretKey).update(pairs.join('\n')).digest('hex');

  const a = Buffer.from(calculatedHash.toLowerCase(), 'hex');
  const b = Buffer.from(receivedHash.toLowerCase(), 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new Error('Invalid Telegram initData cryptographic signature.');
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

const WEB_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function deriveWebSigningKey() {
  const seed = [
    cleanEnv(process.env.WEB_AUTH_SECRET),
    getConfiguredAdminSecret(),
    BOT_TOKEN,
    DATABASE_URL,
    'hert-web-fallback-seed',
  ]
    .filter(Boolean)
    .join(':');
  return crypto.createHmac('sha256', 'hert-web-session-signing-key-v1').update(seed).digest();
}

function normalizeWebIdentifier(raw) {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/^@+/, '');
}

function derivePublicUsername(identifier) {
  const clean = normalizeWebIdentifier(identifier);
  const base = clean.includes('@') ? clean.split('@')[0] : clean;
  const sanitized = base.replace(/[^a-z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
  return (sanitized || 'miner').slice(0, 32);
}

function deriveWebAccountId(normalizedIdentifier) {
  const digest = crypto
    .createHash('sha256')
    .update(`hert-web-account-v1:${normalizedIdentifier}`)
    .digest();
  const raw48 = digest.readUIntBE(0, 6);
  const suffix14 = raw48 % 100000000000000;
  return `8${String(suffix14).padStart(14, '0')}`;
}

function hashWebPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${derived}`;
}

function verifyWebPassword(password, storedHash) {
  if (!password || !storedHash) return false;
  const parts = String(storedHash).split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, expectedHex] = parts;
  if (!salt || !/^[0-9a-f]{128}$/i.test(expectedHex)) return false;
  try {
    const computed = crypto.scryptSync(password, salt, 64);
    const expected = Buffer.from(expectedHex, 'hex');
    if (computed.length !== expected.length) return false;
    return crypto.timingSafeEqual(computed, expected);
  } catch {
    return false;
  }
}

function issueWebSessionToken(claims) {
  const now = Date.now();
  const expiresAt = now + WEB_SESSION_TTL_MS;
  const fullClaims = {
    accountId: String(claims.accountId),
    identifier: normalizeWebIdentifier(claims.identifier),
    firstName: String(claims.firstName || 'Miner').slice(0, 64),
    lastName: claims.lastName ? String(claims.lastName).slice(0, 64) : null,
    username: claims.username ? String(claims.username).slice(0, 32) : null,
    issuedAt: now,
    expiresAt,
  };
  const encodedPayload = Buffer.from(JSON.stringify(fullClaims), 'utf8').toString('base64url');
  const sig = crypto
    .createHmac('sha256', deriveWebSigningKey())
    .update(encodedPayload)
    .digest('base64url');
  return { token: `hert_web.${encodedPayload}.${sig}`, expiresAt };
}

function verifyWebSessionToken(rawToken) {
  if (!rawToken) return null;
  let token = String(rawToken).trim();
  if (token.toLowerCase().startsWith('bearer ')) token = token.slice(7).trim();
  if (!token.startsWith('hert_web.')) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [, encodedPayload, receivedSig] = parts;
  if (!encodedPayload || !receivedSig) return null;

  const expectedSig = crypto
    .createHmac('sha256', deriveWebSigningKey())
    .update(encodedPayload)
    .digest('base64url');

  const a = Buffer.from(receivedSig, 'utf8');
  const b = Buffer.from(expectedSig, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  try {
    const parsed = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
    if (
      !parsed ||
      typeof parsed.accountId !== 'string' ||
      !/^\d+$/.test(parsed.accountId) ||
      typeof parsed.expiresAt !== 'number' ||
      parsed.expiresAt <= Date.now()
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

const MIGRATION_TOKEN_TTL_MS = 30 * 60 * 1000;

function deriveMigrationSigningKey() {
  if (BOT_TOKEN && BOT_TOKEN.length >= 20) {
    return crypto.createHmac('sha256', 'hert-telegram-migration-v1').update(BOT_TOKEN).digest();
  }
  return deriveWebSigningKey();
}

function issueTelegramMigrationToken(user) {
  const now = Date.now();
  const expiresAt = now + MIGRATION_TOKEN_TTL_MS;
  const payloadObj = {
    telegramId: String(user.telegramId).trim(),
    firstName: String(user.firstName || 'Miner').slice(0, 64),
    lastName: user.lastName ? String(user.lastName).slice(0, 64) : null,
    username: user.username ? String(user.username).slice(0, 32) : null,
    issuedAt: now,
    expiresAt,
  };
  const encodedPayload = Buffer.from(JSON.stringify(payloadObj), 'utf8').toString('base64url');
  const sig = crypto
    .createHmac('sha256', deriveMigrationSigningKey())
    .update(encodedPayload)
    .digest('base64url');
  return { token: `hert_mig.${encodedPayload}.${sig}`, expiresAt };
}

function verifyTelegramMigrationToken(rawInput) {
  if (!rawInput) return null;
  let token = String(rawInput).trim();
  if (/^https?:\/\//i.test(token) || token.includes('migrate=')) {
    try {
      const normalized = token.startsWith('http')
        ? token
        : `https://hert.local/?${token.replace(/^\?/, '')}`;
      const u = new URL(normalized);
      const extracted = u.searchParams.get('migrate');
      if (extracted) token = extracted.trim();
    } catch {
      // keep raw string
    }
  }
  if (!token.startsWith('hert_mig.')) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [, encodedPayload, receivedSig] = parts;
  if (!encodedPayload || !receivedSig) return null;

  const expectedSig = crypto
    .createHmac('sha256', deriveMigrationSigningKey())
    .update(encodedPayload)
    .digest('base64url');
  const a = Buffer.from(receivedSig, 'utf8');
  const b = Buffer.from(expectedSig, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  try {
    const parsed = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
    if (
      !parsed ||
      typeof parsed.telegramId !== 'string' ||
      !/^-?\d+$/.test(parsed.telegramId) ||
      typeof parsed.expiresAt !== 'number' ||
      parsed.expiresAt <= Date.now()
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function resolveRequestUser(req) {
  const authHeader = cleanEnv(req.header('authorization'));
  const tmaInitData = authHeader.toLowerCase().startsWith('tma ')
    ? authHeader.slice(4).trim()
    : '';
  const initDataRaw = (req.header('x-telegram-init-data') || tmaInitData).trim();
  const queryRef =
    typeof req.query?.ref === 'string'
      ? req.query.ref.trim()
      : typeof req.query?.startapp === 'string'
        ? req.query.startapp.trim()
        : '';
  const bodyRef = typeof req.body?.startParam === 'string' ? req.body.startParam.trim() : '';
  const fallbackStartParam =
    (req.header('x-start-param') || '').trim() || queryRef || bodyRef || null;

  const webBearer = authHeader.toLowerCase().startsWith('bearer ')
    ? authHeader.slice(7).trim()
    : cleanEnv(req.header('x-web-session'));
  if (webBearer) {
    const webClaims = verifyWebSessionToken(webBearer);
    if (!webClaims) {
      throw new Error('Your web session has expired. Please sign in again.');
    }
    return {
      telegramId: String(webClaims.accountId),
      username: webClaims.username || null,
      firstName: webClaims.firstName || 'Miner',
      lastName: webClaims.lastName || null,
      photoUrl: null,
      isPremium: false,
      startParam: fallbackStartParam,
      verified: true,
      authMode: 'web_authenticated',
    };
  }

  if (initDataRaw && BOT_TOKEN) {
    const user = verifyTelegramInitData(initDataRaw, BOT_TOKEN);
    if (!user.startParam && fallbackStartParam) user.startParam = fallbackStartParam;
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
          startParam: params.get('start_param') || fallbackStartParam,
          verified: false,
        };
      }
    }
  }

  throw new Error('Authentication required. Please sign in or create your HERT Mining web account.');
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
    ALTER TABLE mining_sessions ADD COLUMN IF NOT EXISTS banked_cents BIGINT NOT NULL DEFAULT 0;
    ALTER TABLE mining_sessions ADD COLUMN IF NOT EXISTS rate_anchor_at BIGINT;

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
    ALTER TABLE mining_boosts ADD COLUMN IF NOT EXISTS boost_tier TEXT NOT NULL DEFAULT 'overclock_50';
    ALTER TABLE mining_boosts ADD COLUMN IF NOT EXISTS boost_name TEXT NOT NULL DEFAULT 'Overclock Core';
    ALTER TABLE mining_boosts ADD COLUMN IF NOT EXISTS cost_cents BIGINT NOT NULL DEFAULT 1500;
    ALTER TABLE mining_boosts ADD COLUMN IF NOT EXISTS bonus_rate_cents_per_hour INTEGER NOT NULL DEFAULT 1500;
    ALTER TABLE mining_boosts ADD COLUMN IF NOT EXISTS activated_at BIGINT NOT NULL DEFAULT 0;
    ALTER TABLE mining_boosts ADD COLUMN IF NOT EXISTS expires_at BIGINT NOT NULL DEFAULT 0;
    CREATE INDEX IF NOT EXISTS idx_boosts_user_expires ON mining_boosts(user_id, expires_at DESC);

    CREATE TABLE IF NOT EXISTS task_claims (
      id BIGSERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'started',
      approval_status TEXT,
      proof_text TEXT,
      submitted_at BIGINT,
      reviewed_at BIGINT,
      reject_reason TEXT,
      started_at BIGINT NOT NULL,
      claimed_at BIGINT,
      reward_cents BIGINT NOT NULL DEFAULT 0,
      UNIQUE(user_id, task_id)
    );
    ALTER TABLE task_claims ADD COLUMN IF NOT EXISTS approval_status TEXT;
    ALTER TABLE task_claims ADD COLUMN IF NOT EXISTS proof_text TEXT;
    ALTER TABLE task_claims ADD COLUMN IF NOT EXISTS submitted_at BIGINT;
    ALTER TABLE task_claims ADD COLUMN IF NOT EXISTS reviewed_at BIGINT;
    ALTER TABLE task_claims ADD COLUMN IF NOT EXISTS reject_reason TEXT;
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

    CREATE TABLE IF NOT EXISTS allocation_config (
      id INTEGER PRIMARY KEY,
      allocation_enabled INTEGER NOT NULL DEFAULT 0,
      points_per_coin_cents BIGINT NOT NULL DEFAULT 500,
      tokens_per_point_milli BIGINT NOT NULL DEFAULT 200,
      min_points_cents BIGINT NOT NULL DEFAULT 0,
      require_full_checklist INTEGER NOT NULL DEFAULT 0,
      gas_fee_enabled INTEGER NOT NULL DEFAULT 1,
      gas_fee_nanoton BIGINT NOT NULL DEFAULT 100000000,
      receiver_ton_address TEXT,
      updated_at BIGINT NOT NULL
    );
    ALTER TABLE allocation_config ADD COLUMN IF NOT EXISTS points_per_coin_cents BIGINT NOT NULL DEFAULT 500;

    CREATE TABLE IF NOT EXISTS allocation_claims (
      user_id TEXT PRIMARY KEY,
      ton_address TEXT NOT NULL,
      points_snapshot_cents BIGINT NOT NULL,
      allocated_tokens_cents BIGINT NOT NULL,
      gas_fee_nanoton BIGINT NOT NULL DEFAULT 0,
      receiver_ton_address TEXT,
      tx_boc TEXT,
      tx_hash TEXT UNIQUE,
      status TEXT NOT NULL DEFAULT 'claimed',
      claimed_at BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pending_referrals (
      telegram_id TEXT PRIMARY KEY,
      referral_code TEXT NOT NULL,
      created_at BIGINT NOT NULL,
      expires_at BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS web_accounts (
      account_id TEXT PRIMARY KEY,
      identifier TEXT NOT NULL UNIQUE,
      email TEXT,
      username TEXT,
      first_name TEXT NOT NULL,
      last_name TEXT,
      password_hash TEXT NOT NULL,
      created_at BIGINT NOT NULL,
      last_login_at BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS web_migration_codes (
      code TEXT PRIMARY KEY,
      telegram_id TEXT NOT NULL,
      first_name TEXT NOT NULL,
      last_name TEXT,
      username TEXT,
      created_at BIGINT NOT NULL,
      expires_at BIGINT NOT NULL
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
    SELECT referrer::TEXT, invited_user::TEXT, 2500, 0,
           (EXTRACT(EPOCH FROM COALESCE(rewarded_at, NOW())) * 1000)::BIGINT
    FROM referral_rewards
    ON CONFLICT (referred_id) DO NOTHING
  `);

  const seedReceiverWallet =
    cleanEnv(process.env.HERT_GAS_RECEIVER_TON_ADDRESS) || DEFAULT_GAS_RECEIVER_TON_ADDRESS;
  await pool.query(
    `INSERT INTO allocation_config (
       id, allocation_enabled, points_per_coin_cents, tokens_per_point_milli,
       min_points_cents, require_full_checklist, gas_fee_enabled, gas_fee_nanoton,
       receiver_ton_address, updated_at
     ) VALUES (1, 0, 500, 200, 0, 0, 1, 100000000, $1, $2::BIGINT)
     ON CONFLICT (id) DO UPDATE SET
       receiver_ton_address = COALESCE(NULLIF(TRIM(allocation_config.receiver_ton_address), ''), EXCLUDED.receiver_ton_address)`,
    [seedReceiverWallet, Date.now()]
  );

  console.log('[HERT Backend] PostgreSQL tables verified and synchronized.');
}

async function getActiveBoostRow() {
  return null;
}

async function computeEffectiveRateCents(client, userId) {
  const refRes = await client.query(
    `SELECT COUNT(*)::INT AS cnt FROM referrals WHERE referrer_id = $1`,
    [userId]
  );
  const invitedCount = Number(refRes.rows[0]?.cnt || 0);
  const boostFriends = Math.min(invitedCount, MAX_REFERRAL_BOOST_FRIENDS);
  return BASE_RATE_CENTS_PER_HOUR + boostFriends * REFERRAL_BOOST_PER_FRIEND_CENTS;
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

async function applyReferralInTx(client, inviteeId, rawInput, now, options = {}) {
  const isNewlyRegistered = Boolean(options.isNewlyRegistered);
  const manualEntry = Boolean(options.manualEntry);
  const isVerifiedSession = options.verified !== false;

  if (BOT_TOKEN && !isVerifiedSession) {
    return {
      applied: false,
      reason: 'Verified Telegram Mini App session required to claim referral rewards.',
    };
  }

  const target = extractReferralTarget(rawInput);
  if (!target) return { applied: false, reason: 'Invalid referral code format.' };

  const inviteeRes = await client.query(
    `SELECT telegram_id::TEXT AS tid,
            referred_by::TEXT AS referred_by,
            completed_cycles,
            total_mined_cents,
            last_checkin_at,
            COALESCE(created_at_ms, (EXTRACT(EPOCH FROM COALESCE(created_at, NOW())) * 1000)::BIGINT) AS created_ms
     FROM users
     WHERE telegram_id::TEXT = $1
     FOR UPDATE`,
    [String(inviteeId)]
  );
  const invitee = inviteeRes.rows[0];
  if (!invitee) return { applied: false, reason: 'User account not found.' };
  if (invitee.referred_by) {
    return { applied: false, reason: 'An inviter is already linked to your account.' };
  }

  const createdMs = Number(invitee.created_ms || now);
  const maxFreshAgeMs = manualEntry ? MANUAL_REFERRAL_NEW_USER_WINDOW_MS : 60 * 1000;
  const isZeroActivityFresh =
    now - createdMs <= maxFreshAgeMs &&
    Number(invitee.completed_cycles || 0) === 0 &&
    Number(invitee.total_mined_cents || 0) === 0 &&
    !invitee.last_checkin_at;

  if (!isNewlyRegistered && !isZeroActivityFresh) {
    return {
      applied: false,
      reason: manualEntry
        ? 'Referral codes can only be applied by newly registered users within 30 minutes of joining.'
        : 'Existing user cannot trigger a new referral reward.',
    };
  }

  let inviter = null;
  if (target.referralCode) {
    const byCodeRes = await client.query(
      `SELECT telegram_id::TEXT AS tid, first_name, referred_by::TEXT AS referred_by, referral_code
       FROM users WHERE UPPER(referral_code) = UPPER($1) LIMIT 1`,
      [target.referralCode]
    );
    inviter = byCodeRes.rows[0] || null;
  }
  if (!inviter && target.numericTelegramId) {
    const byTidRes = await client.query(
      `SELECT telegram_id::TEXT AS tid, first_name, referred_by::TEXT AS referred_by, referral_code
       FROM users WHERE telegram_id::TEXT = $1 LIMIT 1`,
      [target.numericTelegramId]
    );
    inviter = byTidRes.rows[0] || null;
  }

  if (!inviter) return { applied: false, reason: 'Referral code not found.' };
  if (String(inviter.tid) === String(inviteeId)) {
    return { applied: false, reason: 'Self-referrals are not allowed.' };
  }
  if (inviter.referred_by && String(inviter.referred_by) === String(inviteeId)) {
    return { applied: false, reason: 'Circular referrals between accounts are not allowed.' };
  }

  // Atomic insert with ON CONFLICT (referred_id) DO NOTHING RETURNING id prevents any duplicate reward
  const insertedRef = await client.query(
    `INSERT INTO referrals (referrer_id, referred_id, bonus_cents, commission_earned_cents, created_at)
     VALUES ($1, $2, $3, 0, $4)
     ON CONFLICT (referred_id) DO NOTHING
     RETURNING id`,
    [String(inviter.tid), String(inviteeId), INVITER_JOIN_BONUS_CENTS, now]
  );
  if (insertedRef.rows.length === 0) {
    return { applied: false, reason: 'Referral bonus already claimed for this account.' };
  }

  if (/^-?\d+$/.test(String(inviteeId)) && /^-?\d+$/.test(String(inviter.tid))) {
    const rw = await client.query(
      `INSERT INTO referral_rewards (invited_user, referrer, rewarded_at)
       VALUES ($1::BIGINT, $2::BIGINT, NOW())
       ON CONFLICT (invited_user) DO NOTHING
       RETURNING invited_user`,
      [String(inviteeId), String(inviter.tid)]
    );
    if (rw.rows.length === 0) {
      await client.query(`DELETE FROM referrals WHERE referred_id = $1`, [String(inviteeId)]);
      return { applied: false, reason: 'Referral reward already recorded.' };
    }
  }

  if (/^-?\d+$/.test(String(inviter.tid))) {
    await client.query(
      `UPDATE users
       SET referred_by = $1::BIGINT,
           points_cents = COALESCE(points_cents, 0) + $2,
           points = FLOOR((COALESCE(points_cents, 0) + $2) / 100.0)::BIGINT,
           updated_at = $3
       WHERE telegram_id::TEXT = $4`,
      [inviter.tid, FRIEND_WELCOME_BONUS_CENTS, now, String(inviteeId)]
    );
  } else {
    await client.query(
      `UPDATE users
       SET points_cents = COALESCE(points_cents, 0) + $1,
           points = FLOOR((COALESCE(points_cents, 0) + $1) / 100.0)::BIGINT,
           updated_at = $2
       WHERE telegram_id::TEXT = $3`,
      [FRIEND_WELCOME_BONUS_CENTS, now, String(inviteeId)]
    );
  }

  await client.query(
    `UPDATE users
     SET points_cents = COALESCE(points_cents, 0) + $1,
         points = FLOOR((COALESCE(points_cents, 0) + $1) / 100.0)::BIGINT,
         updated_at = $2
     WHERE telegram_id::TEXT = $3`,
    [INVITER_JOIN_BONUS_CENTS, now, String(inviter.tid)]
  );

  await client.query(
    `INSERT INTO point_ledger (user_id, entry_type, amount_cents, description, created_at)
     VALUES ($1, 'welcome_bonus', $2, $3, $4)`,
    [
      String(inviteeId),
      FRIEND_WELCOME_BONUS_CENTS,
      `Welcome bonus via ${inviter.first_name || 'Miner'} (+25 HERT)`,
      now,
    ]
  );

  await client.query(
    `INSERT INTO point_ledger (user_id, entry_type, amount_cents, description, created_at)
     VALUES ($1, 'referral_bonus', $2, 'Invited new HERT miner (+25 HERT)', $3)`,
    [String(inviter.tid), INVITER_JOIN_BONUS_CENTS, now]
  );

  return { applied: true };
}

async function ensureUserInTx(client, tgUser, now) {
  const existingRes = await client.query(
    `SELECT telegram_id::TEXT AS tid, referral_code, first_name FROM users WHERE telegram_id::TEXT = $1`,
    [tgUser.telegramId]
  );

  let isNewlyRegistered = false;
  let referralCode = existingRes.rows[0]?.referral_code || generateReferralCode(tgUser.telegramId);

  if (existingRes.rows.length === 0) {
    const codeCheck = await client.query(
      `SELECT 1 FROM users WHERE UPPER(referral_code) = UPPER($1) LIMIT 1`,
      [referralCode]
    );
    if (codeCheck.rows.length > 0) {
      referralCode = `HERT-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    }

    const inserted = await client.query(
      `INSERT INTO users (
        telegram_id, username, first_name, last_name, photo_url, is_premium,
        referral_code, points, points_cents, total_mined_cents, completed_cycles,
        checkin_streak, created_at, created_at_ms, updated_at
      ) VALUES ($1::BIGINT, $2, $3, $4, $5, $6, $7, 0, 0, 0, 0, 0, NOW(), $8, $8)
      ON CONFLICT (telegram_id) DO NOTHING
      RETURNING telegram_id::TEXT AS tid`,
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
    isNewlyRegistered = inserted.rows.length > 0;
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

  // Resolve incoming startParam or staged /start pending_referrals record
  let effectiveStartParam = tgUser.startParam || null;
  const pendingRes = await client.query(
    `SELECT referral_code, expires_at FROM pending_referrals WHERE telegram_id = $1 LIMIT 1`,
    [String(tgUser.telegramId)]
  );
  if (pendingRes.rows.length > 0) {
    if (!effectiveStartParam && Number(pendingRes.rows[0].expires_at) >= now) {
      effectiveStartParam = pendingRes.rows[0].referral_code;
    }
    await client.query(`DELETE FROM pending_referrals WHERE telegram_id = $1`, [
      String(tgUser.telegramId),
    ]);
  }

  if (effectiveStartParam) {
    await applyReferralInTx(client, tgUser.telegramId, effectiveStartParam, now, {
      isNewlyRegistered,
      manualEntry: false,
      verified: tgUser.verified,
    });
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
  if (!BOT_TOKEN || !/^\d+$/.test(String(telegramId))) return null;
  try {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/getChatMember?chat_id=${encodeURIComponent(chatId)}&user_id=${encodeURIComponent(String(telegramId))}`;
    const resp = await fetch(url);
    const data = await resp.json();
    if (!data.ok || !data.result?.status) return null;
    return ['creator', 'administrator', 'member', 'restricted'].includes(data.result.status);
  } catch {
    return null;
  }
}

async function checkTelegramChannelBoost(telegramId, chatId) {
  if (!BOT_TOKEN || !/^\d+$/.test(String(telegramId))) return null;
  try {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/getUserChatBoosts?chat_id=${encodeURIComponent(chatId)}&user_id=${encodeURIComponent(String(telegramId))}`;
    const resp = await fetch(url);
    const data = await resp.json();
    if (!data.ok || !Array.isArray(data.result?.boosts)) return null;
    const nowSec = Math.floor(Date.now() / 1000);
    return data.result.boosts.some(
      (b) => !b.expiration_date || Number(b.expiration_date) > nowSec
    );
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
    const telegramDeepLink = null;
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
          proofSubmitted: rec.proof_text || null,
          rejectReason: null,
          claimedAt: rec.claimed_at ? Number(rec.claimed_at) : now,
        };
      }

      if (def.platform === 'partner') {
        const hasStartedRow = Boolean(rec && rec.status === 'started');
        const startedAtMs = rec?.started_at ? Number(rec.started_at) : 0;
        const waitRemainingSec =
          hasStartedRow && startedAtMs > 0
            ? Math.max(0, Math.ceil((5000 - (now - startedAtMs)) / 1000))
            : 0;
        return {
          ...def,
          status: hasStartedRow ? 'claimable' : 'available',
          verifyWaitRemainingSeconds: waitRemainingSec,
          proofSubmitted: null,
          rejectReason: null,
          claimedAt: null,
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
          proofSubmitted: null,
          rejectReason: null,
          claimedAt: null,
        };
      }

      if (rec && rec.status === 'started') {
        return {
          ...def,
          status: 'pending_verify',
          verifyWaitRemainingSeconds: 0,
          proofSubmitted: null,
          rejectReason: null,
          claimedAt: null,
        };
      }

      return {
        ...def,
        status: 'available',
        verifyWaitRemainingSeconds: 0,
        proofSubmitted: null,
        rejectReason: null,
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
        mode:
          tgUser.authMode === 'web_authenticated'
            ? 'web_authenticated'
            : tgUser.verified
              ? 'telegram_verified'
              : 'browser_sandbox',
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
        canApplyCode:
          !userRow.referred_by &&
          Number(userRow.completed_cycles || 0) === 0 &&
          Number(userRow.total_mined_cents || 0) === 0 &&
          !lastCheckInAt &&
          now - Number(userRow.created_at_ms || now) <= MANUAL_REFERRAL_NEW_USER_WINDOW_MS,
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
      allocation: await (async () => {
        const allocConfig = await getAllocationConfigFromExecutor(client);
        const claimRes = await client.query(
          `SELECT * FROM allocation_claims WHERE user_id = $1`,
          [tgUser.telegramId]
        );
        const claimRow = claimRes.rows[0];
        const userClaim = claimRow
          ? {
              tonAddress: claimRow.ton_address,
              pointsSnapshotCents: Number(claimRow.points_snapshot_cents || 0),
              allocatedTokensCents: Number(claimRow.allocated_tokens_cents || 0),
              gasFeeNanoton: String(claimRow.gas_fee_nanoton || '0'),
              txHash: claimRow.tx_hash || null,
              status: claimRow.status === 'verified' ? 'verified' : 'claimed',
              claimedAt: Number(claimRow.claimed_at || now),
            }
          : null;

        const allocationRevealed = Boolean(userClaim);
        const estimatedTokensCents = userClaim ? userClaim.allocatedTokensCents : null;

        let eligibleToClaim = true;
        let ineligibleReason = null;
        if (!wallet.connected || !wallet.tonAddress) {
          eligibleToClaim = false;
          ineligibleReason = 'Connect your TON wallet first to register a receiving address.';
        } else if (effectivePointsCents <= 0) {
          eligibleToClaim = false;
          ineligibleReason = 'Mine or claim HERT Points first before checking token allocation.';
        } else if (effectivePointsCents < allocConfig.minPointsCents) {
          eligibleToClaim = false;
          ineligibleReason = `Minimum ${(allocConfig.minPointsCents / 100).toFixed(2)} HERT Points required for allocation.`;
        } else if (allocConfig.requireFullChecklist && completedCriteriaCount < 4) {
          eligibleToClaim = false;
          ineligibleReason =
            'Complete all 4 Readiness steps (Mining, Check-In, and TON Wallet) first.';
        }

        return {
          tokenDeployed: allocConfig.allocationEnabled,
          allocationRevealed,
          tokenSymbol: 'HERT',
          targetNetwork: 'TON (The Open Network)',
          recordedPointsCents: effectivePointsCents,
          estimatedTokensCents,
          eligibleToClaim,
          ineligibleReason,
          config: {
            allocationEnabled: allocConfig.allocationEnabled,
            pointsPerCoin: allocationRevealed ? allocConfig.pointsPerCoin : null,
            tokensPerPointMilli: allocationRevealed ? allocConfig.tokensPerPointMilli : null,
            minPointsCents: allocConfig.allocationEnabled ? allocConfig.minPointsCents : 0,
            requireFullChecklist: allocConfig.requireFullChecklist,
            gasFeeEnabled: allocConfig.gasFeeEnabled,
            gasFeeNanoton: allocConfig.gasFeeNanoton,
            receiverTonAddress: allocConfig.allocationEnabled ? allocConfig.receiverTonAddress : null,
            updatedAt: allocConfig.updatedAt,
          },
          userClaim,
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
        };
      })(),
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

function isValidTonAddress(addr) {
  const trimmed = String(addr || '').trim();
  if (!trimmed || /\s/.test(trimmed)) return false;
  if (
    /^(EQ|UQ|kQ|0Q)[A-Za-z0-9_-]{46}$/.test(trimmed) ||
    /^(EQ|UQ|kQ|0Q)[A-Za-z0-9+/]{46}$/.test(trimmed)
  ) {
    return true;
  }
  if (/^(-1|0):[0-9a-fA-F]{64}$/.test(trimmed)) {
    return true;
  }
  return false;
}

function computeAllocatedTokensCents(pointsCents, pointsPerCoin) {
  if (pointsCents <= 0 || pointsPerCoin <= 0) return 0;
  const pts = BigInt(Math.max(0, Math.round(pointsCents)));
  const ppcCents = BigInt(Math.max(1, Math.round(pointsPerCoin * 100)));
  const computed = (pts * 100n) / ppcCents;
  const maxSafe = BigInt(Number.MAX_SAFE_INTEGER);
  return Number(computed > maxSafe ? maxSafe : computed);
}

async function getAllocationConfigFromExecutor(executor) {
  const envDefaultReceiver =
    cleanEnv(process.env.HERT_GAS_RECEIVER_TON_ADDRESS) || DEFAULT_GAS_RECEIVER_TON_ADDRESS;
  if (!executor) {
    return {
      allocationEnabled: false,
      pointsPerCoin: 5,
      tokensPerPointMilli: 200,
      minPointsCents: 0,
      requireFullChecklist: false,
      gasFeeEnabled: true,
      gasFeeNanoton: '100000000',
      receiverTonAddress: envDefaultReceiver,
      updatedAt: 0,
    };
  }
  const res = await executor.query(`SELECT * FROM allocation_config WHERE id = 1 LIMIT 1`);
  if (res.rows.length === 0) {
    return {
      allocationEnabled: false,
      pointsPerCoin: 5,
      tokensPerPointMilli: 200,
      minPointsCents: 0,
      requireFullChecklist: false,
      gasFeeEnabled: true,
      gasFeeNanoton: '100000000',
      receiverTonAddress: envDefaultReceiver,
      updatedAt: 0,
    };
  }
  const r = res.rows[0];
  const rawPpcCents = Number(r.points_per_coin_cents || 0);
  const pointsPerCoin =
    rawPpcCents > 0
      ? rawPpcCents / 100
      : Number(r.tokens_per_point_milli) > 0
        ? Number((1000 / Number(r.tokens_per_point_milli)).toFixed(4))
        : 5;
  const tokensPerPointMilli = Math.max(1, Math.round((1 / pointsPerCoin) * 1000));

  return {
    allocationEnabled: Boolean(Number(r.allocation_enabled)),
    pointsPerCoin,
    tokensPerPointMilli,
    minPointsCents: Math.max(0, Number(r.min_points_cents || 0)),
    requireFullChecklist: Boolean(Number(r.require_full_checklist)),
    gasFeeEnabled: Boolean(Number(r.gas_fee_enabled)),
    gasFeeNanoton: String(r.gas_fee_nanoton || '100000000'),
    receiverTonAddress: (r.receiver_ton_address && r.receiver_ton_address.trim()) || envDefaultReceiver,
    updatedAt: Number(r.updated_at || 0),
  };
}

function validateAndHashTonBoc(rawBoc) {
  const cleanBoc = String(rawBoc || '').trim();
  if (!cleanBoc || cleanBoc.length < 32 || cleanBoc.length > 65536) {
    throw new Error('Missing or invalid signed TON transaction proof (BOC).');
  }
  const normalizedBase64 = cleanBoc.replace(/-/g, '+').replace(/_/g, '/');
  const buf = Buffer.from(normalizedBase64, 'base64');
  if (buf.length < 24) {
    throw new Error('Malformed TON transaction BOC payload.');
  }
  const magic = buf.readUInt32BE(0);
  const validMagics = new Set([0xb5ee9c72, 0x68ff65f3, 0xacc3a728]);
  if (!validMagics.has(magic)) {
    throw new Error('Invalid TON Bag-of-Cells (BOC) signature header.');
  }
  const txHash = crypto.createHash('sha256').update(buf).digest('hex');
  return { cleanBoc, txHash };
}

function escapeCsvCell(val) {
  const str = val === null || val === undefined ? '' : String(val);
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

async function getAdminDashboardPayload(caller, options = {}) {
  if (!pool) {
    throw new Error('PostgreSQL DATABASE_URL is not configured on Render.');
  }
  const now = Date.now();
  const activeWindowFloorMs = now - 24 * 60 * 60 * 1000;
  const allocationConfig = await getAllocationConfigFromExecutor(pool);
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
        COALESCE(ac.ton_address, wc.ton_address) AS ton_address,
        ac.status AS alloc_claim_status,
        ac.allocated_tokens_cents AS alloc_tokens_cents,
        ac.gas_fee_nanoton AS alloc_gas_nanoton,
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
      LEFT JOIN wallet_connections wc ON wc.user_id = u.telegram_id::TEXT
      LEFT JOIN allocation_claims ac ON ac.user_id = u.telegram_id::TEXT
    )
  `;

  const statsRes = await pool.query(
    `${baseCteSql}
     SELECT
       COUNT(*)::INT AS total_users,
       COALESCE(SUM(effective_points_cents), 0)::BIGINT AS total_points_cents,
       COALESCE(SUM(CASE WHEN active_ends_at IS NOT NULL AND active_ends_at > $1 THEN 1 ELSE 0 END), 0)::INT AS live_mining_sessions,
       COALESCE(SUM(CASE WHEN active_ends_at IS NOT NULL OR (resolved_last_mine_ms IS NOT NULL AND resolved_last_mine_ms >= $2) THEN 1 ELSE 0 END), 0)::INT AS active_miners,
       COALESCE(SUM(CASE WHEN completed_cycles > 0 OR total_mined_cents > 0 OR resolved_last_mine_ms IS NOT NULL OR active_ends_at IS NOT NULL THEN 1 ELSE 0 END), 0)::INT AS ever_mined_users,
       COALESCE(SUM(CASE WHEN ton_address IS NOT NULL THEN 1 ELSE 0 END), 0)::INT AS wallet_linked_users,
       COALESCE(SUM(CASE WHEN alloc_claim_status IS NOT NULL THEN 1 ELSE 0 END), 0)::INT AS claimed_allocations_count,
       COALESCE(SUM(COALESCE(alloc_gas_nanoton, 0)), 0)::BIGINT AS total_gas_fee_nanoton
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

    const gasPaidNum = row.alloc_gas_nanoton ? Number(row.alloc_gas_nanoton) : 0;
    const claimStatus = row.alloc_claim_status
      ? gasPaidNum > 0
        ? 'gas_paid'
        : 'claimed'
      : null;

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
      tonAddress: row.ton_address || null,
      claimStatus,
      claimedTokensCents:
        row.alloc_tokens_cents !== null && row.alloc_tokens_cents !== undefined
          ? Number(row.alloc_tokens_cents)
          : null,
      gasFeePaidNanoton: row.alloc_gas_nanoton ? String(row.alloc_gas_nanoton) : null,
    };
  });

  const pendingTasksRes = await pool.query(
    `SELECT tc.user_id, tc.task_id, tc.proof_text, tc.submitted_at, tc.started_at,
            u.first_name, u.username
     FROM task_claims tc
     LEFT JOIN users u ON u.telegram_id::TEXT = tc.user_id
     WHERE tc.status = 'started' AND tc.approval_status = 'pending_approval'
     ORDER BY COALESCE(tc.submitted_at, tc.started_at) ASC
     LIMIT 100`
  );
  const catalogById = new Map(TASK_CATALOG.map((t) => [t.id, t]));
  const pendingTaskClaims = pendingTasksRes.rows.map((row) => {
    const def = catalogById.get(row.task_id);
    return {
      userId: String(row.user_id),
      firstName: row.first_name || row.username || `Miner #${String(row.user_id).slice(-4)}`,
      username: row.username || null,
      taskId: row.task_id,
      taskTitle: def?.title || row.task_id,
      rewardCents: def?.rewardCents || 3500,
      proofText: row.proof_text || '',
      submittedAt: Number(row.submitted_at || row.started_at || now),
      status: 'pending_approval',
    };
  });

  return {
    stats: {
      totalUsers: Number(statsRow.total_users || 0),
      activeMiners: Number(statsRow.active_miners || 0),
      liveMiningSessions: Number(statsRow.live_mining_sessions || 0),
      everMinedUsers: Number(statsRow.ever_mined_users || 0),
      totalPointsCents: Number(statsRow.total_points_cents || 0),
      walletLinkedUsers: Number(statsRow.wallet_linked_users || 0),
      claimedAllocationsCount: Number(statsRow.claimed_allocations_count || 0),
      totalGasFeeNanoton: String(statsRow.total_gas_fee_nanoton || '0'),
      serverTime: now,
    },
    allocationConfig,
    pendingTaskClaims,
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
    'Content-Type, Authorization, X-Web-Session, X-Admin-Token, X-Telegram-Init-Data, X-Start-Param, X-Sandbox-Client-Id, X-Dev-Sandbox'
  );
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
});

app.use(express.json({ limit: '32kb' }));

app.get('/', (req, res) => {
  const configuredWeb = cleanEnv(process.env.PUBLIC_WEBAPP_URL || process.env.WEBAPP_URL).replace(
    /\/+$/,
    ''
  );
  const host = (req.header('x-forwarded-host') || req.header('host') || '').split(',')[0].trim();
  const selfOrigin = host ? `https://${host}` : PUBLIC_WEBAPP_URL;
  const targetBase =
    configuredWeb &&
    configuredWeb.startsWith('https://') &&
    !/\.(run\.app|ai\.studio)$/i.test(configuredWeb) &&
    configuredWeb !== selfOrigin
      ? configuredWeb
      : selfOrigin;

  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(req.query || {})) {
    if (k === 'openChrome') continue;
    if (typeof v === 'string' && v.trim()) qs.set(k, v.trim());
  }
  const suffix = qs.toString() ? `/?${qs.toString()}` : '/';
  const finalHttpsUrl = `${targetBase}${suffix}`;
  const hostAndPath = finalHttpsUrl.replace(/^https?:\/\//i, '');
  const androidIntent = `intent://${hostAndPath}#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=${encodeURIComponent(finalHttpsUrl)};end`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.status(200).send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>HERT Network — Open in Google Chrome</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; background: #070A09; color: #F3F5F4; font-family: system-ui, -apple-system, sans-serif; padding: 20px; }
    .card { width: 100%; max-width: 460px; background: #0D1210; border: 1px solid rgba(255,255,255,0.09); border-radius: 20px; padding: 28px 24px; text-align: center; }
    h1 { margin: 0 0 10px; font-size: 22px; color: #F3F5F4; }
    p { margin: 0 0 22px; font-size: 14px; line-height: 1.55; color: #9AA8A1; }
    a.primary { display: flex; align-items: center; justify-content: center; width: 100%; min-height: 52px; border-radius: 14px; background: #D4AF37; color: #050706; font-weight: 700; font-size: 15px; text-decoration: none; margin-bottom: 12px; }
    button.copy { width: 100%; min-height: 46px; border-radius: 14px; background: #141C19; color: #D6DFDA; border: 1px solid rgba(255,255,255,0.1); font-weight: 600; font-size: 13px; cursor: pointer; }
    .url { margin-top: 16px; padding: 10px 12px; border-radius: 10px; background: #070A09; font-family: ui-monospace, monospace; font-size: 12px; color: #8E9D96; word-break: break-all; }
  </style>
</head>
<body>
  <div class="card">
    <h1>HERT Network Web</h1>
    <p>Tap the button below to open HERT Mining directly in <strong>Google Chrome</strong>.</p>
    <a id="chromeBtn" class="primary" href="${androidIntent}">Open in Google Chrome</a>
    <button class="copy" type="button" onclick="navigator.clipboard && navigator.clipboard.writeText('${finalHttpsUrl.replace(/'/g, "\\'")}').then(()=>{this.textContent='Website Link Copied!'})">Copy Website Link</button>
    <div class="url">${finalHttpsUrl.replace(/</g, '&lt;')}</div>
  </div>
  <script>
    (function(){
      var ua = navigator.userAgent || '';
      var btn = document.getElementById('chromeBtn');
      var target = ${JSON.stringify(finalHttpsUrl)};
      var hostPath = target.replace(/^https?:\\/\\//i, '');
      if (/iPhone|iPad|iPod/i.test(ua)) {
        btn.href = 'googlechrome://' + hostPath;
      } else if (!/Android/i.test(ua)) {
        btn.href = target;
      }
    })();
  </script>
</body>
</html>`);
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

app.post('/api/auth/register', async (req, res) => {
  try {
    if (!pool) {
      res.status(503).json({ error: 'Database is not configured.' });
      return;
    }
    const cleanName = String(req.body?.firstName || '').trim().slice(0, 64);
    if (cleanName.length < 2) {
      res.status(400).json({ error: 'Please enter your display name (at least 2 characters).' });
      return;
    }
    const normalizedId = normalizeWebIdentifier(req.body?.identifier);
    if (normalizedId.length < 3 || normalizedId.length > 120 || /\s/.test(normalizedId)) {
      res.status(400).json({ error: 'Enter a valid username or email address (at least 3 characters).' });
      return;
    }
    const isEmail = normalizedId.includes('@');
    if (isEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedId)) {
      res.status(400).json({ error: 'Please enter a valid email address.' });
      return;
    }
    if (!isEmail && !/^[a-z0-9_.-]{3,32}$/.test(normalizedId)) {
      res.status(400).json({ error: 'Username may contain letters, numbers, underscores, dots, or hyphens.' });
      return;
    }
    const rawPassword = String(req.body?.password || '');
    if (rawPassword.length < 6) {
      res.status(400).json({ error: 'Password must be at least 6 characters long.' });
      return;
    }

    const now = Date.now();
    const accountId = deriveWebAccountId(normalizedId);
    const publicUsername = derivePublicUsername(normalizedId);
    const passwordHash = hashWebPassword(rawPassword);

    await withTransaction(async (client) => {
      const existing = await client.query(
        `SELECT account_id FROM web_accounts WHERE identifier = $1 OR account_id = $2 LIMIT 1`,
        [normalizedId, accountId]
      );
      if (existing.rows.length > 0) {
        throw new Error('An account with this username or email already exists. Please Sign In.');
      }
      await client.query(
        `INSERT INTO web_accounts (account_id, identifier, email, username, first_name, last_name, password_hash, created_at, last_login_at)
         VALUES ($1, $2, $3, $4, $5, NULL, $6, $7::BIGINT, $8::BIGINT)`,
        [accountId, normalizedId, isEmail ? normalizedId : null, publicUsername, cleanName, passwordHash, now, now]
      );
    });

    const referralCode =
      typeof req.body?.referralCode === 'string' && req.body.referralCode.trim()
        ? req.body.referralCode.trim().slice(0, 64)
        : null;

    const tgUser = {
      telegramId: accountId,
      username: publicUsername,
      firstName: cleanName,
      lastName: null,
      photoUrl: null,
      isPremium: false,
      startParam: referralCode,
      verified: true,
      authMode: 'web_authenticated',
    };

    const session = issueWebSessionToken({
      accountId,
      identifier: normalizedId,
      firstName: cleanName,
      lastName: null,
      username: publicUsername,
    });
    const payload = await buildDashboardPayload(tgUser, resolveAppOrigin(req));
    res.json({ token: session.token, expiresAt: session.expiresAt, payload });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Unable to register account.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    if (!pool) {
      res.status(503).json({ error: 'Database is not configured.' });
      return;
    }
    const normalizedId = normalizeWebIdentifier(req.body?.identifier);
    const rawPassword = String(req.body?.password || '');
    if (!normalizedId || !rawPassword) {
      res.status(400).json({ error: 'Please enter both your username/email and password.' });
      return;
    }

    const resAcc = await pool.query(
      `SELECT account_id, identifier, first_name, last_name, username, password_hash
       FROM web_accounts WHERE identifier = $1 LIMIT 1`,
      [normalizedId]
    );
    if (resAcc.rows.length === 0 || !verifyWebPassword(rawPassword, resAcc.rows[0].password_hash)) {
      res.status(401).json({ error: 'Invalid username/email or password.' });
      return;
    }

    const acc = resAcc.rows[0];
    await pool.query(`UPDATE web_accounts SET last_login_at = $1::BIGINT WHERE account_id = $2`, [
      Date.now(),
      acc.account_id,
    ]);

    const tgUser = {
      telegramId: String(acc.account_id),
      username: acc.username || null,
      firstName: acc.first_name || 'Miner',
      lastName: acc.last_name || null,
      photoUrl: null,
      isPremium: false,
      startParam: null,
      verified: true,
      authMode: 'web_authenticated',
    };

    const session = issueWebSessionToken({
      accountId: String(acc.account_id),
      identifier: acc.identifier,
      firstName: acc.first_name || 'Miner',
      lastName: acc.last_name || null,
      username: acc.username || null,
    });
    const payload = await buildDashboardPayload(tgUser, resolveAppOrigin(req));
    res.json({ token: session.token, expiresAt: session.expiresAt, payload });
  } catch (err) {
    res.status(401).json({ error: err.message || 'Invalid credentials.' });
  }
});

app.post('/api/auth/logout', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/auth/migration-preview', (req, res) => {
  const rawToken = typeof req.query?.token === 'string' ? req.query.token.trim() : '';
  const rawInitData =
    typeof req.query?.initData === 'string'
      ? req.query.initData.trim()
      : (req.header('x-telegram-init-data') || '').trim();

  if (rawToken) {
    const verified = verifyTelegramMigrationToken(rawToken);
    if (verified) {
      res.json({
        verified: true,
        telegramId: verified.telegramId,
        firstName: verified.firstName,
        username: verified.username,
        botUsername: BOT_USERNAME,
      });
      return;
    }
  }

  if (rawInitData && BOT_TOKEN) {
    try {
      const tg = verifyTelegramInitData(rawInitData, BOT_TOKEN);
      res.json({
        verified: true,
        telegramId: tg.telegramId,
        firstName: tg.firstName,
        username: tg.username,
        botUsername: BOT_USERNAME,
      });
      return;
    } catch {
      // ignore invalid initData
    }
  }

  res.json({
    verified: false,
    telegramId: null,
    firstName: null,
    username: null,
    botUsername: BOT_USERNAME,
  });
});

app.post('/api/auth/stage-migration-code', async (req, res) => {
  try {
    if (!pool) {
      res.status(503).json({ error: 'Database is not configured.' });
      return;
    }
    const tgUser = resolveRequestUser(req);
    if (BOT_TOKEN && !tgUser.verified) {
      res.status(401).json({ error: 'Verified Telegram session required.' });
      return;
    }
    const now = Date.now();
    const expiresAt = now + MIGRATION_TOKEN_TTL_MS;
    const explicitCode = typeof req.body?.code === 'string' ? req.body.code.trim() : '';
    const code = /^\d{6}$/.test(explicitCode)
      ? explicitCode
      : String(crypto.randomInt(100000, 999999));

    await pool.query(
      `DELETE FROM web_migration_codes WHERE expires_at < $1::BIGINT OR telegram_id = $2`,
      [now, String(tgUser.telegramId)]
    );
    await pool.query(
      `INSERT INTO web_migration_codes (code, telegram_id, first_name, last_name, username, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6::BIGINT, $7::BIGINT)
       ON CONFLICT (code) DO UPDATE SET
         telegram_id = EXCLUDED.telegram_id,
         first_name = EXCLUDED.first_name,
         last_name = EXCLUDED.last_name,
         username = EXCLUDED.username,
         created_at = EXCLUDED.created_at,
         expires_at = EXCLUDED.expires_at`,
      [
        code,
        String(tgUser.telegramId),
        tgUser.firstName || 'Miner',
        tgUser.lastName || null,
        tgUser.username || null,
        now,
        expiresAt,
      ]
    );
    res.json({ ok: true, code, expiresAt });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Unable to stage migration code.' });
  }
});

const directMigrationIpBucket = new Map();
const directMigrationMinerCooldown = new Map();

async function fetchRenderTelegramChatUsername(telegramId) {
  if (!BOT_TOKEN || !/^\d{5,16}$/.test(String(telegramId))) return null;
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/getChat?chat_id=${encodeURIComponent(String(telegramId))}`
    );
    const data = await res.json().catch(() => null);
    if (data && data.ok && data.result && typeof data.result.username === 'string' && data.result.username.trim()) {
      return data.result.username.trim();
    }
  } catch {
    // ignore transient lookup failures
  }
  return null;
}

app.post('/api/auth/request-telegram-code', async (req, res) => {
  try {
    if (!pool) {
      res.status(503).json({ error: 'Database is not configured.' });
      return;
    }
    if (!BOT_TOKEN) {
      res.status(503).json({ error: 'Telegram Bot is not configured on this server.' });
      return;
    }

    const clientIp =
      String(req.header('x-forwarded-for') || '')
        .split(',')[0]
        .trim() ||
      req.ip ||
      'unknown';
    const now = Date.now();
    const recentIp = (directMigrationIpBucket.get(clientIp) || []).filter((ts) => now - ts < 10 * 60 * 1000);
    if (recentIp.length >= 12) {
      res.status(429).json({
        error: 'Too many code requests. Please wait a few minutes and try again.',
      });
      return;
    }
    recentIp.push(now);
    directMigrationIpBucket.set(clientIp, recentIp);

    const rawLookup = typeof req.body?.lookup === 'string' ? req.body.lookup.trim() : '';
    if (rawLookup.length < 2 || rawLookup.length > 128) {
      res.status(400).json({
        error: 'Enter your Telegram @username, Telegram Name, Invite Code (HERT-XXXXXX), TON Wallet, or Telegram ID.',
      });
      return;
    }

    const cleanedHandle = rawLookup.replace(/^@+/, '').trim().toLowerCase();
    const upperLookup = rawLookup.toUpperCase();
    const refMatch = upperLookup.match(/^(?:REF_)?(HERT-[A-Z0-9]{4,12})$/i);
    const explicitIdMatch = rawLookup.match(/^(?:ref_)?(\d{5,16})$/i);

    let matches = [];
    const baseSelect = `
      SELECT u.telegram_id::TEXT AS telegram_id,
             u.first_name,
             u.last_name,
             u.username,
             u.referral_code,
             GREATEST(COALESCE(u.points_cents, 0), COALESCE(u.points, 0) * 100)::BIGINT AS points_cents,
             wc.ton_address
      FROM users u
      LEFT JOIN wallet_connections wc
        ON wc.user_id = u.telegram_id::TEXT AND wc.disconnected_at IS NULL
      WHERE u.telegram_id::TEXT !~ '^8[0-9]{14}$'
    `;

    if (explicitIdMatch) {
      const q = await pool.query(`${baseSelect} AND u.telegram_id::TEXT = $1 LIMIT 5`, [explicitIdMatch[1]]);
      matches = q.rows;
    }
    if (matches.length === 0 && rawLookup.length >= 30) {
      const q = await pool.query(
        `${baseSelect} AND LOWER(COALESCE(wc.ton_address, '')) = LOWER($1) LIMIT 5`,
        [rawLookup]
      );
      matches = q.rows;
    }
    if (matches.length === 0 && refMatch) {
      const q = await pool.query(
        `${baseSelect} AND UPPER(COALESCE(u.referral_code, '')) = UPPER($1) LIMIT 5`,
        [refMatch[1]]
      );
      matches = q.rows;
    }
    if (matches.length === 0 && cleanedHandle.length >= 2) {
      const qUser = await pool.query(
        `${baseSelect} AND LOWER(COALESCE(u.username, '')) = $1 LIMIT 5`,
        [cleanedHandle]
      );
      matches = qUser.rows;

      if (matches.length === 0 && !rawLookup.startsWith('@')) {
        const qName = await pool.query(
          `${baseSelect}
           AND (
             LOWER(TRIM(COALESCE(u.first_name, ''))) = $1
             OR LOWER(TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, ''))) = $1
           )
           ORDER BY GREATEST(COALESCE(u.points_cents, 0), COALESCE(u.points, 0) * 100) DESC
           LIMIT 5`,
          [cleanedHandle]
        );
        matches = qName.rows;
      }

      if (matches.length === 0) {
        const nullUserRows = await pool.query(
          `${baseSelect} AND (u.username IS NULL OR TRIM(u.username) = '') LIMIT 40`
        );
        for (const row of nullUserRows.rows) {
          const liveUsername = await fetchRenderTelegramChatUsername(row.telegram_id);
          if (liveUsername) {
            await pool
              .query(`UPDATE users SET username = $1 WHERE telegram_id::TEXT = $2`, [
                liveUsername,
                String(row.telegram_id),
              ])
              .catch(() => {});
            if (liveUsername.toLowerCase() === cleanedHandle) {
              row.username = liveUsername;
              matches.push(row);
              break;
            }
          }
        }
      }
    }

    if (matches.length === 0) {
      res.status(404).json({
        error:
          'No existing HERT Telegram miner matched that lookup. Try your Telegram @username, exact Telegram First Name, Invite Code (HERT-XXXXXX), linked TON wallet, or numeric Telegram ID.',
      });
      return;
    }

    if (matches.length > 1) {
      res.status(409).json({
        error:
          'Multiple miners share that first name. Please enter your @username, Invite Code (HERT-XXXXXX), linked TON wallet, or numeric Telegram ID so we send the code to the exact account.',
      });
      return;
    }

    const target = matches[0];
    const uidStr = String(target.telegram_id);
    const lastSent = directMigrationMinerCooldown.get(uidStr) || 0;
    if (now - lastSent < 25 * 1000) {
      const waitSec = Math.max(1, Math.ceil((25 * 1000 - (now - lastSent)) / 1000));
      res.status(429).json({
        error: `Code was just sent to your Telegram chat! Check your messages from @${BOT_USERNAME} (or wait ${waitSec}s to resend).`,
      });
      return;
    }

    const expiresAt = now + MIGRATION_TOKEN_TTL_MS;
    const code = String(crypto.randomInt(100000, 999999));

    await pool.query(
      `DELETE FROM web_migration_codes WHERE expires_at < $1::BIGINT OR telegram_id = $2`,
      [now, uidStr]
    );
    await pool.query(
      `INSERT INTO web_migration_codes (code, telegram_id, first_name, last_name, username, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6::BIGINT, $7::BIGINT)
       ON CONFLICT (code) DO UPDATE SET
         telegram_id = EXCLUDED.telegram_id,
         first_name = EXCLUDED.first_name,
         last_name = EXCLUDED.last_name,
         username = EXCLUDED.username,
         created_at = EXCLUDED.created_at,
         expires_at = EXCLUDED.expires_at`,
      [
        code,
        uidStr,
        target.first_name || 'Miner',
        target.last_name || null,
        target.username || null,
        now,
        expiresAt,
      ]
    );

    const { token: migToken } = issueTelegramMigrationToken({
      telegramId: uidStr,
      firstName: target.first_name || 'Miner',
      lastName: target.last_name || null,
      username: target.username || null,
    });
    const browserUrl = `${PUBLIC_WEBAPP_URL}/?migrate=${encodeURIComponent(migToken)}`;
    const safeName = escapeTelegramHtml(target.first_name || 'Miner');
    const ptsCents = Number(target.points_cents || 0);

    const dmLines = [
      `🔑 <b>HERT Web Code:</b> <code>${code}</code>`,
      ``,
      `Miner: <b>${safeName}</b>`,
      `Verified Balance: <b>${(ptsCents / 100).toFixed(2)} HERT</b>`,
      ``,
      `Enter <code>${code}</code> on the HERT Mining Web page (valid 30 mins), or tap the button below to finish setting your Web password:`,
    ];

    const tgResp = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: uidStr,
        text: dmLines.join('\n'),
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[{ text: '🌐 Open Web & Set Password', url: browserUrl }]],
        },
      }),
    });
    const tgJson = await tgResp.json().catch(() => null);
    if (!tgResp.ok || !tgJson?.ok) {
      res.status(400).json({
        error: `Telegram could not deliver a direct message to your chat (${tgJson?.description || 'chat not started'}). Open @${BOT_USERNAME} in Telegram and send /web once.`,
      });
      return;
    }

    directMigrationMinerCooldown.set(uidStr, now);
    const rawName = String(target.first_name || 'Miner').trim();
    const maskedHint =
      rawName.length <= 2 ? `${rawName[0] || 'M'}*` : `${rawName.slice(0, 2)}${'*'.repeat(Math.min(4, rawName.length - 2))}`;

    res.json({
      ok: true,
      sent: true,
      botUsername: BOT_USERNAME,
      maskedAccountHint: maskedHint,
      message: `6-digit code sent directly to your Telegram messages from @${BOT_USERNAME}! Check your Telegram chat or phone notification and enter the 6-digit code below.`,
    });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Unable to send Telegram verification code.' });
  }
});

app.post('/api/auth/migrate-telegram', async (req, res) => {
  try {
    if (!pool) {
      res.status(503).json({ error: 'Database is not configured.' });
      return;
    }
    const normalizedId = normalizeWebIdentifier(req.body?.identifier);
    if (normalizedId.length < 3 || normalizedId.length > 120 || /\s/.test(normalizedId)) {
      res.status(400).json({ error: 'Enter a valid username or email address (at least 3 characters).' });
      return;
    }
    const isEmail = normalizedId.includes('@');
    if (isEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedId)) {
      res.status(400).json({ error: 'Please enter a valid email address.' });
      return;
    }
    if (!isEmail && !/^[a-z0-9_.-]{3,32}$/.test(normalizedId)) {
      res.status(400).json({ error: 'Username may contain letters, numbers, underscores, dots, or hyphens.' });
      return;
    }
    const rawPassword = String(req.body?.password || '');
    if (rawPassword.length < 6) {
      res.status(400).json({ error: 'Password must be at least 6 characters long.' });
      return;
    }

    const migrationToken =
      typeof req.body?.migrationToken === 'string' ? req.body.migrationToken.trim() : '';
    const migrationCode =
      typeof req.body?.migrationCode === 'string' ? req.body.migrationCode.trim() : '';
    const telegramInitData =
      typeof req.body?.telegramInitData === 'string' && req.body.telegramInitData.trim()
        ? req.body.telegramInitData.trim()
        : (req.header('x-telegram-init-data') || '').trim();

    let verifiedIdentity = null;

    const tokenCandidate = migrationToken || migrationCode;
    if (tokenCandidate) {
      const parsed = verifyTelegramMigrationToken(tokenCandidate);
      if (parsed) {
        verifiedIdentity = {
          telegramId: String(parsed.telegramId),
          firstName: parsed.firstName || 'Miner',
          lastName: parsed.lastName || null,
          username: parsed.username || null,
        };
      }
    }

    if (!verifiedIdentity && telegramInitData && BOT_TOKEN) {
      try {
        const tg = verifyTelegramInitData(telegramInitData, BOT_TOKEN);
        verifiedIdentity = {
          telegramId: String(tg.telegramId),
          firstName: tg.firstName || 'Miner',
          lastName: tg.lastName || null,
          username: tg.username || null,
        };
      } catch {
        // continue
      }
    }

    if (!verifiedIdentity && migrationCode) {
      const cleanCode = migrationCode.replace(/[\s-]+/g, '');
      if (/^\d{6}$/.test(cleanCode)) {
        const nowCheck = Date.now();
        const codeRes = await pool.query(
          `DELETE FROM web_migration_codes WHERE code = $1 RETURNING *`,
          [cleanCode]
        );
        if (codeRes.rows.length > 0 && Number(codeRes.rows[0].expires_at) >= nowCheck) {
          const row = codeRes.rows[0];
          verifiedIdentity = {
            telegramId: String(row.telegram_id),
            firstName: row.first_name || 'Miner',
            lastName: row.last_name || null,
            username: row.username || null,
          };
        }
      }
    }

    if (!verifiedIdentity) {
      res.status(400).json({
        error:
          'Invalid or expired Telegram verification code. Open @HERTCoinBot on Telegram and tap "Move Account to Web" (or send /web) to get a fresh 6-digit code.',
      });
      return;
    }

    const now = Date.now();
    const cleanTid = String(verifiedIdentity.telegramId);
    const passwordHash = hashWebPassword(rawPassword);
    let resolvedFirstName = String(verifiedIdentity.firstName || 'Miner').slice(0, 64);
    let resolvedLastName = verifiedIdentity.lastName
      ? String(verifiedIdentity.lastName).slice(0, 64)
      : null;
    let resolvedUsername =
      (verifiedIdentity.username ? String(verifiedIdentity.username).slice(0, 32) : null) ||
      derivePublicUsername(normalizedId);

    await withTransaction(async (client) => {
      const existingTg = await client.query(
        `SELECT first_name, last_name, username FROM users WHERE telegram_id::TEXT = $1 LIMIT 1`,
        [cleanTid]
      );
      if (existingTg.rows.length > 0) {
        if (existingTg.rows[0].first_name) resolvedFirstName = existingTg.rows[0].first_name;
        if (existingTg.rows[0].last_name) resolvedLastName = existingTg.rows[0].last_name;
        if (existingTg.rows[0].username) resolvedUsername = existingTg.rows[0].username;
      }

      const conflictRes = await client.query(
        `SELECT account_id, password_hash FROM web_accounts WHERE identifier = $1 LIMIT 1`,
        [normalizedId]
      );
      if (conflictRes.rows.length > 0 && String(conflictRes.rows[0].account_id) !== cleanTid) {
        const otherId = String(conflictRes.rows[0].account_id);
        const isSynthetic = /^8\d{14}$/.test(otherId);
        const samePass = verifyWebPassword(rawPassword, conflictRes.rows[0].password_hash);
        if (isSynthetic && samePass) {
          await client.query(`DELETE FROM web_accounts WHERE account_id = $1`, [otherId]);
        } else {
          throw new Error(
            'This username or email is already used by another account. Choose a different username/email.'
          );
        }
      }

      await client.query(
        `INSERT INTO web_accounts (account_id, identifier, email, username, first_name, last_name, password_hash, created_at, last_login_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::BIGINT, $8::BIGINT)
         ON CONFLICT (account_id) DO UPDATE SET
           identifier = EXCLUDED.identifier,
           email = EXCLUDED.email,
           username = EXCLUDED.username,
           first_name = EXCLUDED.first_name,
           last_name = EXCLUDED.last_name,
           password_hash = EXCLUDED.password_hash,
           last_login_at = EXCLUDED.last_login_at`,
        [
          cleanTid,
          normalizedId,
          isEmail ? normalizedId : null,
          resolvedUsername,
          resolvedFirstName,
          resolvedLastName,
          passwordHash,
          now,
        ]
      );
    });

    const tgUser = {
      telegramId: cleanTid,
      username: resolvedUsername,
      firstName: resolvedFirstName,
      lastName: resolvedLastName,
      photoUrl: null,
      isPremium: false,
      startParam: null,
      verified: true,
      authMode: 'web_authenticated',
    };

    const session = issueWebSessionToken({
      accountId: cleanTid,
      identifier: normalizedId,
      firstName: resolvedFirstName,
      lastName: resolvedLastName,
      username: resolvedUsername,
    });
    const payload = await buildDashboardPayload(tgUser, resolveAppOrigin(req));
    res.json({ token: session.token, expiresAt: session.expiresAt, payload });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Unable to migrate Telegram account to Web.' });
  }
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

app.post('/api/referrals/stage', async (req, res) => {
  try {
    const tgUser = resolveRequestUser(req);
    if (BOT_TOKEN && !tgUser.verified) {
      res.status(401).json({ error: 'Verified Telegram session required.' });
      return;
    }
    const rawCode =
      typeof req.body?.code === 'string' && req.body.code.trim()
        ? req.body.code.trim()
        : tgUser.startParam || '';
    const cleanParam = normalizeReferralParam(rawCode);
    if (!cleanParam || !pool) {
      res.json({ ok: true, stagedCode: null });
      return;
    }

    const uidStr = String(tgUser.telegramId);
    const ownCode = generateReferralCode(uidStr);
    if (cleanParam.toUpperCase() === ownCode || cleanParam === `ref_${uidStr}`) {
      res.json({ ok: true, stagedCode: null });
      return;
    }

    const existingUser = await pool.query(
      `SELECT 1 FROM users WHERE telegram_id::TEXT = $1 LIMIT 1`,
      [uidStr]
    );
    if (existingUser.rows.length > 0) {
      res.json({ ok: true, stagedCode: null });
      return;
    }

    const now = Date.now();
    const expiresAt = now + 7 * 24 * 60 * 60 * 1000;
    await pool.query(
      `INSERT INTO pending_referrals (telegram_id, referral_code, created_at, expires_at)
       VALUES ($1, $2, $3::BIGINT, $4::BIGINT)
       ON CONFLICT (telegram_id) DO UPDATE SET
         referral_code = EXCLUDED.referral_code,
         created_at = EXCLUDED.created_at,
         expires_at = EXCLUDED.expires_at`,
      [uidStr, cleanParam, now, expiresAt]
    );

    res.json({ ok: true, stagedCode: cleanParam });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Unable to stage referral code.' });
  }
});

app.post('/api/referrals/apply', async (req, res) => {
  try {
    const tgUser = resolveRequestUser(req);
    if (BOT_TOKEN && !tgUser.verified) {
      res.status(401).json({ error: 'Verified Telegram Mini App session required.' });
      return;
    }
    const code = typeof req.body?.code === 'string' ? req.body.code : '';
    const now = Date.now();
    await withTransaction(async (client) => {
      await ensureUserInTx(client, tgUser, now);
      const outcome = await applyReferralInTx(client, tgUser.telegramId, code, now, {
        isNewlyRegistered: false,
        manualEntry: true,
        verified: tgUser.verified,
      });
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

app.get('/api/referrals/friends', async (req, res) => {
  try {
    const tgUser = resolveRequestUser(req);
    const limit = Math.min(50, Math.max(1, Math.floor(Number(req.query.limit) || 20)));
    const offset = Math.max(0, Math.floor(Number(req.query.offset) || 0));
    const countRes = await pool.query(
      `SELECT COUNT(*)::INT AS cnt FROM referrals WHERE referrer_id = $1`,
      [String(tgUser.telegramId)]
    );
    const totalCount = Number(countRes.rows[0]?.cnt || 0);
    const rowsRes = await pool.query(
      `SELECT r.referred_id, r.bonus_cents, r.commission_earned_cents, r.created_at,
              u.first_name, u.username, u.completed_cycles
       FROM referrals r
       LEFT JOIN users u ON u.telegram_id::TEXT = r.referred_id
       WHERE r.referrer_id = $1
       ORDER BY r.created_at DESC
       LIMIT $2 OFFSET $3`,
      [String(tgUser.telegramId), limit, offset]
    );
    const items = rowsRes.rows.map((f) => ({
      telegramId: String(f.referred_id),
      firstName: f.first_name || f.username || `Miner #${String(f.referred_id).slice(-4)}`,
      username: f.username || null,
      joinedAt: Number(f.created_at),
      bonusCents: Number(f.bonus_cents),
      commissionEarnedCents: Number(f.commission_earned_cents),
      completedCycles: Number(f.completed_cycles || 0),
    }));
    res.json({ items, totalCount, hasMore: offset + items.length < totalCount });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Unable to load referred friends.' });
  }
});

app.get('/api/ledger', async (req, res) => {
  try {
    const tgUser = resolveRequestUser(req);
    const limit = Math.min(50, Math.max(1, Math.floor(Number(req.query.limit) || 20)));
    const offset = Math.max(0, Math.floor(Number(req.query.offset) || 0));
    const countRes = await pool.query(
      `SELECT COUNT(*)::INT AS cnt FROM point_ledger WHERE user_id = $1`,
      [String(tgUser.telegramId)]
    );
    const totalCount = Number(countRes.rows[0]?.cnt || 0);
    const rowsRes = await pool.query(
      `SELECT id, entry_type, amount_cents, description, created_at
       FROM point_ledger
       WHERE user_id = $1
       ORDER BY created_at DESC, id DESC
       LIMIT $2 OFFSET $3`,
      [String(tgUser.telegramId), limit, offset]
    );
    const items = rowsRes.rows.map((l) => ({
      id: Number(l.id),
      entryType: l.entry_type,
      amountCents: Number(l.amount_cents),
      description: l.description,
      createdAt: Number(l.created_at),
    }));
    res.json({ items, totalCount, hasMore: offset + items.length < totalCount });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Unable to load ledger entries.' });
  }
});

app.post('/api/boosts/buy', async (req, res) => {
  try {
    const tgUser = resolveRequestUser(req);
    const tierId = typeof req.body?.tierId === 'string' ? req.body.tierId : '';
    const tier = BOOST_CATALOG.find((item) => item.id === tierId);
    if (!tier) throw new Error('Selected boost tier does not exist.');

    const now = Date.now();
    const userIdStr = String(tgUser.telegramId);
    await withTransaction(async (client) => {
      await ensureUserInTx(client, tgUser, now);

      const userRes = await client.query(
        `SELECT points, points_cents FROM users WHERE telegram_id::TEXT = $1 FOR UPDATE`,
        [userIdStr]
      );
      const balanceCents = Math.max(
        Number(userRes.rows[0]?.points_cents || 0),
        Number(userRes.rows[0]?.points || 0) * 100
      );
      if (balanceCents < tier.costCents) {
        throw new Error(`Insufficient balance. You need ${(tier.costCents / 100).toFixed(2)} HERT Points.`);
      }

      const activeBoost = await getActiveBoostRow(client, userIdStr, now);
      if (activeBoost) {
        const currentBonus = Number(activeBoost.bonus_rate_cents_per_hour);
        if (currentBonus >= tier.bonusRateCentsPerHour) {
          throw new Error(
            currentBonus === tier.bonusRateCentsPerHour
              ? `${activeBoost.boost_name} is already active.`
              : `A higher boost (${activeBoost.boost_name}) is already active.`
          );
        }
        await client.query(`UPDATE mining_boosts SET expires_at = $1::BIGINT WHERE id = $2`, [
          now,
          activeBoost.id,
        ]);
      }

      const newBalanceCents = balanceCents - tier.costCents;
      const newWholePoints = Math.floor(newBalanceCents / 100);
      await client.query(
        `UPDATE users
         SET points_cents = $1::BIGINT,
             points = $2::BIGINT,
             updated_at = $3::BIGINT
         WHERE telegram_id::TEXT = $4`,
        [newBalanceCents, newWholePoints, now, userIdStr]
      );

      await client.query(
        `INSERT INTO mining_boosts (user_id, boost_tier, boost_name, cost_cents, bonus_rate_cents_per_hour, activated_at, expires_at)
         VALUES ($1, $2, $3, $4::BIGINT, $5::INTEGER, $6::BIGINT, $7::BIGINT)`,
        [
          userIdStr,
          tier.id,
          tier.name,
          tier.costCents,
          tier.bonusRateCentsPerHour,
          now,
          now + tier.durationMs,
        ]
      );

      await client.query(
        `INSERT INTO point_ledger (user_id, entry_type, amount_cents, description, created_at)
         VALUES ($1, 'boost_purchase', $2::BIGINT, $3, $4::BIGINT)`,
        [userIdStr, -tier.costCents, `Activated 24h ${tier.name}`, now]
      );

      const newEffectiveRate = await computeEffectiveRateCents(client, userIdStr, now);
      const activeSessionRes = await client.query(
        `SELECT * FROM mining_sessions WHERE user_id = $1 AND claimed_at IS NULL ORDER BY id DESC LIMIT 1`,
        [userIdStr]
      );
      const session = activeSessionRes.rows[0];
      if (session && now < Number(session.ends_at)) {
        const snap = computeSessionState(session, now);
        await client.query(
          `UPDATE mining_sessions SET banked_cents = $1::BIGINT, rate_anchor_at = $2::BIGINT, rate_cents_per_hour = $3::INTEGER WHERE id = $4`,
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
    const userIdStr = String(tgUser.telegramId);
    await withTransaction(async (client) => {
      await ensureUserInTx(client, tgUser, now);
      const existing = await client.query(
        `SELECT * FROM task_claims WHERE user_id = $1 AND task_id = $2`,
        [userIdStr, task.id]
      );
      if (existing.rows[0]?.status === 'claimed') {
        throw new Error('This task reward has already been claimed.');
      }
      if (existing.rows.length === 0) {
        await client.query(
          `INSERT INTO task_claims (user_id, task_id, status, started_at, reward_cents)
           VALUES ($1, $2, 'started', $3, 0)`,
          [userIdStr, task.id, now]
        );
      }
    });

    const payload = await buildDashboardPayload(tgUser, resolveAppOrigin(req));
    res.json({ payload });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Unable to start task.' });
  }
});

async function claimPartnerTaskDirectInTx(tgUser, task, rawClientStartedAt) {
  const now = Date.now();
  const userIdStr = String(tgUser.telegramId);
  const PARTNER_WAIT_MS = 5000;
  const parsedClientStart = Number(rawClientStartedAt);
  const validClientStart =
    Number.isFinite(parsedClientStart) &&
    parsedClientStart > 0 &&
    parsedClientStart <= now &&
    now - parsedClientStart <= 7 * 24 * 60 * 60 * 1000
      ? Math.floor(parsedClientStart)
      : null;

  let waitSeconds = 0;

  await withTransaction(async (client) => {
    await ensureUserInTx(client, tgUser, now);

    const existing = await client.query(
      `SELECT status, started_at FROM task_claims WHERE user_id = $1 AND task_id = $2 FOR UPDATE`,
      [userIdStr, task.id]
    );
    if (existing.rows[0]?.status === 'claimed') {
      throw new Error('This one-time task reward has already been claimed.');
    }

    if (existing.rows.length === 0) {
      if (validClientStart && now - validClientStart >= PARTNER_WAIT_MS) {
        await client.query(
          `INSERT INTO task_claims (
             user_id, task_id, status, started_at, claimed_at, reward_cents, approval_status
           ) VALUES ($1, $2, 'claimed', $3::BIGINT, $4::BIGINT, $5::BIGINT, 'approved')`,
          [userIdStr, task.id, validClientStart, now, task.rewardCents]
        );
      } else {
        const recordedStart = validClientStart || now;
        await client.query(
          `INSERT INTO task_claims (user_id, task_id, status, started_at, reward_cents)
           VALUES ($1, $2, 'started', $3::BIGINT, 0)`,
          [userIdStr, task.id, recordedStart]
        );
        waitSeconds = Math.max(1, Math.ceil((PARTNER_WAIT_MS - (now - recordedStart)) / 1000));
        return;
      }
    } else {
      const effectiveStart = Math.min(
        Number(existing.rows[0].started_at || now),
        validClientStart ?? now
      );
      const elapsed = now - effectiveStart;
      if (elapsed < PARTNER_WAIT_MS) {
        waitSeconds = Math.max(1, Math.ceil((PARTNER_WAIT_MS - elapsed) / 1000));
        return;
      }
      await client.query(
        `UPDATE task_claims
         SET status = 'claimed',
             approval_status = 'approved',
             claimed_at = $1::BIGINT,
             reward_cents = $2::BIGINT,
             reject_reason = NULL
         WHERE user_id = $3 AND task_id = $4`,
        [now, task.rewardCents, userIdStr, task.id]
      );
    }

    await client.query(
      `UPDATE users
       SET points_cents = COALESCE(points_cents, 0) + $1::BIGINT,
           points = FLOOR((COALESCE(points_cents, 0) + $1::BIGINT) / 100.0)::BIGINT,
           updated_at = $2::BIGINT
       WHERE telegram_id::TEXT = $3`,
      [task.rewardCents, now, userIdStr]
    );

    await client.query(
      `INSERT INTO point_ledger (user_id, entry_type, amount_cents, description, created_at)
       VALUES ($1, 'task_reward', $2::BIGINT, $3, $4::BIGINT)`,
      [userIdStr, task.rewardCents, `Task completed: ${task.title}`, now]
    );
  });

  if (waitSeconds > 0) {
    throw new Error(
      `Complete joining ${task.title} via "${task.actionLabel}" first, then tap Claim Reward in ${waitSeconds}s.`
    );
  }
}

app.post('/api/tasks/submit-proof', async (req, res) => {
  try {
    const tgUser = resolveRequestUser(req);
    const taskId = typeof req.body?.taskId === 'string' ? req.body.taskId : '';
    const task = TASK_CATALOG.find((t) => t.id === taskId);
    if (!task || task.platform !== 'partner') {
      throw new Error('Invalid partner task selected.');
    }

    await claimPartnerTaskDirectInTx(tgUser, task, Date.now() - 10000);
    const payload = await buildDashboardPayload(tgUser, resolveAppOrigin(req));
    res.json({ status: 'claimed', rewardCents: task.rewardCents, title: task.title, payload });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Unable to claim task bonus.' });
  }
});

app.post('/api/tasks/claim', async (req, res) => {
  try {
    const tgUser = resolveRequestUser(req);
    const taskId = typeof req.body?.taskId === 'string' ? req.body.taskId : '';
    const clientStartedAt = req.body?.clientStartedAt;
    const task = TASK_CATALOG.find((t) => t.id === taskId);
    if (!task) throw new Error('Task not found.');

    if (task.platform === 'partner') {
      await claimPartnerTaskDirectInTx(tgUser, task, clientStartedAt);
      const payload = await buildDashboardPayload(tgUser, resolveAppOrigin(req));
      res.json({
        rewardCents: task.rewardCents,
        title: task.title,
        pendingApproval: false,
        payload,
      });
      return;
    }

    let liveTelegramVerified = false;
    if (task.id === 'join_tg_channel') {
      if (!tgUser.verified) {
        throw new Error(
          'Open HERT Mining inside Telegram (@HERTCoinBot) to verify your channel subscription.'
        );
      }
      const isMember = await checkTelegramChannelMembership(tgUser.telegramId, CHANNEL_ID);
      if (isMember === false) {
        throw new Error(`Not joined yet — tap "${task.actionLabel}" to subscribe first, then return and claim.`);
      }
      if (isMember === null) {
        throw new Error(
          `Channel verification pending admin setup: add @${BOT_USERNAME} as an Administrator in ${CHANNEL_ID} so Telegram allows subscriber verification.`
        );
      }
      liveTelegramVerified = true;
    }

    const now = Date.now();
    const userIdStr = String(tgUser.telegramId);

    await withTransaction(async (client) => {
      await ensureUserInTx(client, tgUser, now);

      const existing = await client.query(
        `SELECT * FROM task_claims WHERE user_id = $1 AND task_id = $2 FOR UPDATE`,
        [userIdStr, task.id]
      );
      if (existing.rows[0]?.status === 'claimed') {
        throw new Error('Task bonus already claimed.');
      }

      if (task.category === 'social') {
        if (!liveTelegramVerified) {
          throw new Error(`Verify subscription to ${CHANNEL_ID} first before claiming.`);
        }

        await client.query(
          `INSERT INTO task_claims (user_id, task_id, status, started_at, claimed_at, reward_cents)
           VALUES ($1, $2, 'claimed', $3::BIGINT, $3::BIGINT, $4::BIGINT)
           ON CONFLICT (user_id, task_id)
           DO UPDATE SET status = 'claimed', claimed_at = EXCLUDED.claimed_at, reward_cents = EXCLUDED.reward_cents`,
          [userIdStr, task.id, now, task.rewardCents]
        );
      } else {
        const uRes = await client.query(
          `SELECT completed_cycles, checkin_streak FROM users WHERE telegram_id::TEXT = $1`,
          [userIdStr]
        );
        const wRes = await client.query(
          `SELECT user_id FROM wallet_connections WHERE user_id = $1`,
          [userIdStr]
        );
        const cRes = await client.query(
          `SELECT COUNT(*)::INT AS cnt FROM daily_checkins WHERE user_id = $1`,
          [userIdStr]
        );

        let met = false;
        if (task.id === 'link_ton_wallet') met = wRes.rows.length > 0;
        if (task.id === 'complete_first_cycle') met = Number(uRes.rows[0]?.completed_cycles || 0) >= 1;
        if (task.id === 'complete_first_checkin') met = Number(cRes.rows[0]?.cnt || 0) >= 1;
        if (!met) throw new Error('Complete the milestone requirement first before claiming.');

        await client.query(
          `INSERT INTO task_claims (user_id, task_id, status, started_at, claimed_at, reward_cents)
           VALUES ($1, $2, 'claimed', $3::BIGINT, $3::BIGINT, $4::BIGINT)
           ON CONFLICT (user_id, task_id)
           DO UPDATE SET status = 'claimed', claimed_at = EXCLUDED.claimed_at, reward_cents = EXCLUDED.reward_cents`,
          [userIdStr, task.id, now, task.rewardCents]
        );
      }

      await client.query(
        `UPDATE users
         SET points_cents = COALESCE(points_cents, 0) + $1::BIGINT,
             points = FLOOR((COALESCE(points_cents, 0) + $1::BIGINT) / 100.0)::BIGINT,
             updated_at = $2::BIGINT
         WHERE telegram_id::TEXT = $3`,
        [task.rewardCents, now, userIdStr]
      );

      await client.query(
        `INSERT INTO point_ledger (user_id, entry_type, amount_cents, description, created_at)
         VALUES ($1, 'task_reward', $2::BIGINT, $3, $4::BIGINT)`,
        [userIdStr, task.rewardCents, `Task completed: ${task.title}`, now]
      );
    });

    const payload = await buildDashboardPayload(tgUser, resolveAppOrigin(req));
    res.json({ rewardCents: task.rewardCents, title: task.title, pendingApproval: false, payload });
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

app.post('/api/allocation/claim', async (req, res) => {
  try {
    const tgUser = resolveRequestUser(req);
    const now = Date.now();
    const claim = await withTransaction(async (client) => {
      await ensureUserInTx(client, tgUser, now);

      const config = await getAllocationConfigFromExecutor(client);
      if (!config.allocationEnabled) {
        throw new Error('Token allocation claiming is not open yet. Please wait for the official announcement.');
      }

      const existing = await client.query(
        `SELECT * FROM allocation_claims WHERE user_id = $1 FOR UPDATE`,
        [tgUser.telegramId]
      );
      if (existing.rows.length > 0) {
        throw new Error('Your HERT token allocation claim has already been registered.');
      }

      const wRes = await client.query(
        `SELECT ton_address FROM wallet_connections WHERE user_id = $1`,
        [tgUser.telegramId]
      );
      const registeredAddress = wRes.rows[0]?.ton_address || String(req.body?.tonAddress || '').trim();
      if (!registeredAddress || !isValidTonAddress(registeredAddress)) {
        throw new Error('Connect a valid non-custodial TON wallet first before claiming your allocation.');
      }

      const uRes = await client.query(
        `SELECT GREATEST(COALESCE(points_cents, 0), COALESCE(points, 0) * 100)::BIGINT AS pts,
                COALESCE(completed_cycles, 0)::INT AS completed_cycles
         FROM users WHERE telegram_id::TEXT = $1`,
        [tgUser.telegramId]
      );
      const pointsCents = Number(uRes.rows[0]?.pts || 0);
      const completedCycles = Number(uRes.rows[0]?.completed_cycles || 0);

      if (pointsCents <= 0) {
        throw new Error('You need verified HERT Points before claiming an allocation.');
      }
      if (pointsCents < config.minPointsCents) {
        throw new Error(
          `You need at least ${(config.minPointsCents / 100).toFixed(2)} HERT Points to qualify for allocation.`
        );
      }

      if (config.requireFullChecklist) {
        const cRes = await client.query(
          `SELECT COUNT(*)::INT AS cnt FROM daily_checkins WHERE user_id = $1`,
          [tgUser.telegramId]
        );
        const hasCheckIn = Number(cRes.rows[0]?.cnt || 0) >= 1;
        if (completedCycles < 1 || !hasCheckIn) {
          throw new Error(
            'Complete at least 1 mining session and 1 daily check-in to unlock allocation claiming.'
          );
        }
      }

      const allocatedTokensCents = computeAllocatedTokensCents(
        pointsCents,
        config.pointsPerCoin
      );
      if (allocatedTokensCents <= 0) {
        throw new Error('Calculated HERT token allocation must be greater than zero.');
      }

      let requiredFeeNanoton = '0';
      let receiverTonAddress = null;
      let cleanBoc = null;
      let txHash = null;
      let claimStatus = 'claimed';

      if (config.gasFeeEnabled) {
        if (!config.receiverTonAddress || !isValidTonAddress(config.receiverTonAddress)) {
          throw new Error(
            'Allocation gas fee treasury wallet is not configured on the server yet. Please contact the administrator.'
          );
        }
        const parsedBoc = validateAndHashTonBoc(req.body?.txBoc || '');
        const dupCheck = await client.query(
          `SELECT user_id FROM allocation_claims WHERE tx_hash = $1`,
          [parsedBoc.txHash]
        );
        if (dupCheck.rows.length > 0) {
          throw new Error('This TON gas fee transaction has already been used.');
        }

        requiredFeeNanoton = config.gasFeeNanoton;
        receiverTonAddress = config.receiverTonAddress;
        cleanBoc = parsedBoc.cleanBoc;
        txHash = parsedBoc.txHash;
        claimStatus = 'verified';
      }

      await client.query(
        `INSERT INTO allocation_claims (
          user_id, ton_address, points_snapshot_cents, allocated_tokens_cents,
          gas_fee_nanoton, receiver_ton_address, tx_boc, tx_hash, status, claimed_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          tgUser.telegramId,
          registeredAddress,
          pointsCents,
          allocatedTokensCents,
          requiredFeeNanoton,
          receiverTonAddress,
          cleanBoc,
          txHash,
          claimStatus,
          now,
        ]
      );

      return {
        tonAddress: registeredAddress,
        pointsSnapshotCents: pointsCents,
        allocatedTokensCents,
        gasFeeNanoton: requiredFeeNanoton,
        txHash,
        status: claimStatus,
        claimedAt: now,
      };
    });

    const payload = await buildDashboardPayload(tgUser, resolveAppOrigin(req));
    res.json({ claim, payload });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Unable to register allocation claim.' });
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

app.post('/api/admin/allocation-config', async (req, res) => {
  try {
    verifyAdminRequest(req);
    if (!pool) {
      throw new Error('PostgreSQL DATABASE_URL is not configured on Render.');
    }

    const pointsPerCoin = Number(req.body?.pointsPerCoin ?? 5);
    if (!Number.isFinite(pointsPerCoin) || pointsPerCoin < 0.01 || pointsPerCoin > 1000000) {
      res.status(400).json({ error: 'Enter a valid ratio between 0.01 and 1,000,000 Points per 1 HERT Coin.' });
      return;
    }
    const pointsPerCoinCents = Math.max(1, Math.round(pointsPerCoin * 100));
    const tokensPerPointMilli = Math.max(1, Math.round((1 / pointsPerCoin) * 1000));

    const minPoints = Number(req.body?.minPoints ?? 0);
    if (!Number.isFinite(minPoints) || minPoints < 0 || minPoints > 1000000000) {
      res.status(400).json({ error: 'Minimum points requirement must be 0 or a positive number.' });
      return;
    }
    const minPointsCents = Math.round(minPoints * 100);

    const gasFeeEnabled = Boolean(req.body?.gasFeeEnabled);
    const gasFeeTon = Number(req.body?.gasFeeTon ?? 0.1);
    if (!Number.isFinite(gasFeeTon) || gasFeeTon < 0 || gasFeeTon > 100) {
      res.status(400).json({ error: 'TON gas fee must be between 0 and 100 TON.' });
      return;
    }
    if (gasFeeEnabled && gasFeeTon < 0.01) {
      res.status(400).json({ error: 'When TON gas fee is enabled, set at least 0.01 TON.' });
      return;
    }
    const gasFeeNanoton = String(Math.round(gasFeeTon * 1000000000));

    const trimmedReceiver = String(req.body?.receiverTonAddress || '').trim();
    if (gasFeeEnabled && (!trimmedReceiver || !isValidTonAddress(trimmedReceiver))) {
      res.status(400).json({
        error: 'Enter a valid receiving TON wallet address (starting with UQ or EQ) to collect gas fees.',
      });
      return;
    }
    if (trimmedReceiver && !isValidTonAddress(trimmedReceiver)) {
      res.status(400).json({
        error: 'Receiving TON wallet address format is invalid (must be a valid UQ/EQ TON address).',
      });
      return;
    }

    const allocationEnabled = Boolean(req.body?.allocationEnabled);
    const requireFullChecklist = Boolean(req.body?.requireFullChecklist);
    const now = Date.now();

    await pool.query(
      `INSERT INTO allocation_config (
        id, allocation_enabled, points_per_coin_cents, tokens_per_point_milli, min_points_cents,
        require_full_checklist, gas_fee_enabled, gas_fee_nanoton, receiver_ton_address, updated_at
      ) VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (id) DO UPDATE SET
        allocation_enabled = EXCLUDED.allocation_enabled,
        points_per_coin_cents = EXCLUDED.points_per_coin_cents,
        tokens_per_point_milli = EXCLUDED.tokens_per_point_milli,
        min_points_cents = EXCLUDED.min_points_cents,
        require_full_checklist = EXCLUDED.require_full_checklist,
        gas_fee_enabled = EXCLUDED.gas_fee_enabled,
        gas_fee_nanoton = EXCLUDED.gas_fee_nanoton,
        receiver_ton_address = EXCLUDED.receiver_ton_address,
        updated_at = EXCLUDED.updated_at`,
      [
        allocationEnabled ? 1 : 0,
        pointsPerCoinCents,
        tokensPerPointMilli,
        minPointsCents,
        requireFullChecklist ? 1 : 0,
        gasFeeEnabled ? 1 : 0,
        gasFeeNanoton,
        trimmedReceiver || null,
        now,
      ]
    );

    const allocationConfig = await getAllocationConfigFromExecutor(pool);
    res.json({ allocationConfig });
  } catch (err) {
    res.status(err.status || 400).json({
      error: err.message || 'Unable to save allocation configuration.',
    });
  }
});

app.get('/api/admin/allocation/export', async (req, res) => {
  try {
    verifyAdminRequest(req);
    if (!pool) {
      throw new Error('PostgreSQL DATABASE_URL is not configured on Render.');
    }
    const rawScope = typeof req.query.scope === 'string' ? req.query.scope : 'claimed';
    const scope = rawScope === 'wallets' ? 'wallets' : rawScope === 'all' ? 'all' : 'claimed';
    const config = await getAllocationConfigFromExecutor(pool);

    const whereClause =
      scope === 'claimed'
        ? 'WHERE ac.user_id IS NOT NULL'
        : scope === 'wallets'
          ? 'WHERE wc.ton_address IS NOT NULL OR ac.ton_address IS NOT NULL'
          : '';

    const rowsRes = await pool.query(
      `SELECT
         u.telegram_id::TEXT AS telegram_id,
         u.username,
         u.first_name,
         GREATEST(COALESCE(u.points_cents, 0), COALESCE(u.points, 0) * 100)::BIGINT AS effective_points_cents,
         wc.ton_address,
         ac.ton_address AS claim_ton_address,
         ac.allocated_tokens_cents,
         ac.gas_fee_nanoton,
         ac.status AS claim_status,
         ac.tx_hash,
         ac.claimed_at
       FROM users u
       LEFT JOIN wallet_connections wc ON wc.user_id = u.telegram_id::TEXT
       LEFT JOIN allocation_claims ac ON ac.user_id = u.telegram_id::TEXT
       ${whereClause}
       ORDER BY GREATEST(COALESCE(u.points_cents, 0), COALESCE(u.points, 0) * 100) DESC, u.telegram_id::TEXT ASC`
    );

    const header = [
      'telegram_id',
      'username',
      'ton_address',
      'points_balance',
      'allocated_hert_tokens',
      'gas_fee_ton',
      'claim_status',
      'tx_hash',
      'claimed_at_utc',
    ].join(',');

    const lines = rowsRes.rows.map((r) => {
      const ptsCents = Number(r.effective_points_cents || 0);
      const resolvedWallet = r.claim_ton_address || r.ton_address || '';
      const allocCents =
        r.allocated_tokens_cents !== null && r.allocated_tokens_cents !== undefined
          ? Number(r.allocated_tokens_cents)
          : computeAllocatedTokensCents(ptsCents, config.pointsPerCoin);
      const feeNano = r.gas_fee_nanoton ? Number(r.gas_fee_nanoton) : 0;
      const statusLabel = r.claim_status
        ? feeNano > 0
          ? 'gas_paid_claimed'
          : 'claimed'
        : resolvedWallet
          ? 'wallet_linked'
          : 'unlinked';
      const claimedIso = r.claimed_at ? new Date(Number(r.claimed_at)).toISOString() : '';

      return [
        escapeCsvCell(r.telegram_id),
        escapeCsvCell(r.username ? `@${r.username}` : r.first_name || ''),
        escapeCsvCell(resolvedWallet),
        (ptsCents / 100).toFixed(2),
        (allocCents / 100).toFixed(2),
        (feeNano / 1000000000).toFixed(4),
        escapeCsvCell(statusLabel),
        escapeCsvCell(r.tx_hash || ''),
        escapeCsvCell(claimedIso),
      ].join(',');
    });

    const dateTag = new Date().toISOString().slice(0, 10);
    res.json({
      filename: `hert-allocation-${scope}-${dateTag}.csv`,
      csv: [header, ...lines].join('\n'),
    });
  } catch (err) {
    res.status(err.status || 500).json({
      error: err.message || 'Unable to export allocation CSV.',
    });
  }
});

app.post('/api/admin/tasks/review', async (req, res) => {
  try {
    const caller = verifyAdminRequest(req);
    if (!pool) {
      throw new Error('PostgreSQL DATABASE_URL is not configured on Render.');
    }

    const cleanUserId = String(req.body?.userId || '').trim();
    const cleanTaskId = String(req.body?.taskId || '').trim();
    const action = req.body?.action === 'reject' ? 'reject' : 'approve';
    const rejectReason =
      typeof req.body?.rejectReason === 'string' ? req.body.rejectReason.trim() : '';

    const task = TASK_CATALOG.find((t) => t.id === cleanTaskId);
    if (!cleanUserId || !task) {
      res.status(400).json({ error: 'Invalid user ID or task ID.' });
      return;
    }

    const now = Date.now();
    await withTransaction(async (client) => {
      const existing = await client.query(
        `SELECT status, approval_status FROM task_claims WHERE user_id = $1 AND task_id = $2 FOR UPDATE`,
        [cleanUserId, task.id]
      );
      if (existing.rows.length === 0) {
        throw new Error('Task verification record not found for this user.');
      }
      if (existing.rows[0].status === 'claimed') {
        throw new Error('Duplicate prevented: this user already received the 35 HERT task reward.');
      }

      if (action === 'approve') {
        await client.query(
          `UPDATE task_claims
           SET status = 'claimed',
               approval_status = 'approved',
               claimed_at = $1::BIGINT,
               reviewed_at = $1::BIGINT,
               reward_cents = $2::BIGINT,
               reject_reason = NULL
           WHERE user_id = $3 AND task_id = $4 AND status != 'claimed'`,
          [now, task.rewardCents, cleanUserId, task.id]
        );

        await client.query(
          `UPDATE users
           SET points_cents = COALESCE(points_cents, 0) + $1::BIGINT,
               points = FLOOR((COALESCE(points_cents, 0) + $1::BIGINT) / 100.0)::BIGINT,
               updated_at = $2::BIGINT
           WHERE telegram_id::TEXT = $3`,
          [task.rewardCents, now, cleanUserId]
        );

        await client.query(
          `INSERT INTO point_ledger (user_id, entry_type, amount_cents, description, created_at)
           VALUES ($1, 'task_reward', $2::BIGINT, $3, $4::BIGINT)`,
          [
            cleanUserId,
            task.rewardCents,
            `Task verified: ${task.title} (+${(task.rewardCents / 100).toFixed(0)} HERT)`,
            now,
          ]
        );
      } else {
        const reason =
          rejectReason.slice(0, 160) ||
          'Verification not found. Complete registration using the link and resubmit your exact username/ID.';
        await client.query(
          `UPDATE task_claims
           SET approval_status = 'rejected',
               reviewed_at = $1::BIGINT,
               reject_reason = $2
           WHERE user_id = $3 AND task_id = $4 AND status != 'claimed'`,
          [now, reason, cleanUserId, task.id]
        );
      }
    });

    const dashboard = await getAdminDashboardPayload(caller, { limit: 50, offset: 0 });
    res.json({
      result: {
        userId: cleanUserId,
        taskId: task.id,
        action,
        rewardCents: action === 'approve' ? task.rewardCents : 0,
      },
      pendingTaskClaims: dashboard.pendingTaskClaims || [],
      stats: dashboard.stats,
    });
  } catch (err) {
    res.status(err.status || 400).json({
      error: err.message || 'Unable to review task submission.',
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

async function syncTelegramPlayMenuButton(chatId) {
  if (!BOT_TOKEN) return;
  const hasChatId = typeof chatId === 'number' || typeof chatId === 'string';
  const body = {
    menu_button: {
      type: 'default',
    },
  };
  if (hasChatId) {
    body.chat_id = chatId;
  }

  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setChatMenuButton`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(() => {});
}

function escapeTelegramHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function sendRenderWebMigrationReply(chatId, from, callbackQueryId) {
  if (!pool) return;
  if (callbackQueryId && BOT_TOKEN) {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        callback_query_id: callbackQueryId,
        text: 'Generating your Web Migration link & 6-digit code...',
      }),
    }).catch(() => {});
  }

  const uidStr = String(from.id);
  const now = Date.now();
  const expiresAt = now + MIGRATION_TOKEN_TTL_MS;
  const code = String(crypto.randomInt(100000, 999999));

  await pool.query(
    `DELETE FROM web_migration_codes WHERE expires_at < $1::BIGINT OR telegram_id = $2`,
    [now, uidStr]
  );
  await pool.query(
    `INSERT INTO web_migration_codes (code, telegram_id, first_name, last_name, username, created_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6::BIGINT, $7::BIGINT)
     ON CONFLICT (code) DO UPDATE SET
       telegram_id = EXCLUDED.telegram_id,
       first_name = EXCLUDED.first_name,
       last_name = EXCLUDED.last_name,
       username = EXCLUDED.username,
       created_at = EXCLUDED.created_at,
       expires_at = EXCLUDED.expires_at`,
    [code, uidStr, from.first_name || 'Miner', from.last_name || null, from.username || null, now, expiresAt]
  );

  const existingRes = await pool.query(
    `SELECT GREATEST(COALESCE(points_cents, 0), COALESCE(points, 0) * 100)::BIGINT AS pts
     FROM users WHERE telegram_id::TEXT = $1 LIMIT 1`,
    [uidStr]
  );
  const ptsCents = existingRes.rows.length > 0 ? Number(existingRes.rows[0].pts || 0) : null;

  const { token: migToken } = issueTelegramMigrationToken({
    telegramId: uidStr,
    firstName: from.first_name || 'Miner',
    lastName: from.last_name || null,
    username: from.username || null,
  });
  const browserUrl = `${PUBLIC_WEBAPP_URL}/?migrate=${encodeURIComponent(migToken)}&openChrome=1`;
  const safeName = escapeTelegramHtml(from.first_name || 'Miner');

  const lines = [
    `🔑 <b>HERT Web Code:</b> <code>${code}</code>`,
    ``,
    `🌐 <b>Move Your HERT Account to Web</b>`,
    `Miner: <b>${safeName}</b> (ID: <code>${escapeTelegramHtml(uidStr)}</code>)`,
    ...(ptsCents !== null ? [`Current Balance: <b>${(ptsCents / 100).toFixed(2)} HERT</b>`] : []),
    ``,
    `1️⃣ Tap <b>Open in Chrome &amp; Set Password</b> below to jump straight into Google Chrome with your Telegram account pre-verified.`,
    `2️⃣ Or open <b>${escapeTelegramHtml(PUBLIC_WEBAPP_URL)}</b> in Google Chrome → select <b>From Telegram</b> → enter code <code>${code}</code> and choose your Web username &amp; password.`,
  ];

  await sendTelegramMessage(chatId, lines.join('\n'), {
    inline_keyboard: [[{ text: '🌐 Open in Chrome & Set Password', url: browserUrl }]],
  });
}

function getExpectedWebhookSecrets() {
  const secrets = [];
  if (WEBHOOK_SECRET) secrets.push(WEBHOOK_SECRET);
  if (BOT_TOKEN) {
    secrets.push(
      crypto
        .createHmac('sha256', 'hert-telegram-webhook-secret-v1')
        .update(BOT_TOKEN)
        .digest('hex')
    );
  }
  return secrets;
}

async function processRenderWebhookUpdate(req) {
  const cq = req.body?.callback_query;
  if (cq && cq.from && cq.message?.chat?.id && pool) {
    const data = String(cq.data || '').trim().toLowerCase();
    if (data === 'migrate_web' || data === 'web') {
      await sendRenderWebMigrationReply(cq.message.chat.id, cq.from, cq.id).catch(() => {});
      return;
    }
  }

  const msg = req.body?.message;
  if (!msg || !msg.from || !pool || msg.from.is_bot || !msg.text) return;

  const text = String(msg.text).trim();
  const lower = text.toLowerCase();
  const startMatch = text.match(/^\/start(?:@\w+)?(?:\s+(.+))?$/i);
  const startPayload = startMatch && startMatch[1] ? startMatch[1].trim() : null;

  if (
    /^\/(web|migrate|move|code)(?:@\w+)?$/i.test(text) ||
    (startPayload && /^(migrate_web|migrate|web|move|claim_web)$/i.test(startPayload)) ||
    /^(move to web|web login|migrate|move account to web)$/i.test(text)
  ) {
    await sendRenderWebMigrationReply(msg.chat.id, msg.from).catch(() => {});
    return;
  }

  const tgUser = {
    telegramId: String(msg.from.id),
    username: msg.from.username || null,
    firstName: msg.from.first_name || 'Miner',
    lastName: msg.from.last_name || null,
    photoUrl: null,
    isPremium: Boolean(msg.from.is_premium),
    startParam: startPayload,
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
    if (startMatch) {
      const now = Date.now();
      const uidStr = tgUser.telegramId;

      // Read-only lookup: never prematurely create a user or award referral points on /start alone
      const existingRes = await pool.query(
        `SELECT u.telegram_id::TEXT AS tid,
                u.first_name,
                u.referral_code,
                GREATEST(COALESCE(u.points_cents, 0), COALESCE(u.points, 0) * 100)::BIGINT AS pts,
                (SELECT COUNT(*)::INT FROM referrals r WHERE r.referrer_id = u.telegram_id::TEXT) AS invited_cnt
         FROM users u
         WHERE u.telegram_id::TEXT = $1
         LIMIT 1`,
        [uidStr]
      );
      const existingRow = existingRes.rows[0] || null;

      let effectiveRefCode = null;
      if (!existingRow) {
        const cleanIncoming = normalizeReferralParam(startPayload);
        const ownCode = generateReferralCode(uidStr);
        if (
          cleanIncoming &&
          cleanIncoming.toUpperCase() !== ownCode &&
          cleanIncoming !== `ref_${uidStr}`
        ) {
          await pool.query(
            `INSERT INTO pending_referrals (telegram_id, referral_code, created_at, expires_at)
             VALUES ($1, $2, $3::BIGINT, $4::BIGINT)
             ON CONFLICT (telegram_id) DO UPDATE SET
               referral_code = EXCLUDED.referral_code,
               created_at = EXCLUDED.created_at,
               expires_at = EXCLUDED.expires_at`,
            [uidStr, cleanIncoming, now, now + 7 * 24 * 60 * 60 * 1000]
          );
          effectiveRefCode = cleanIncoming;
        } else {
          const pendingRes = await pool.query(
            `SELECT referral_code, expires_at FROM pending_referrals WHERE telegram_id = $1 LIMIT 1`,
            [uidStr]
          );
          if (pendingRes.rows.length > 0 && Number(pendingRes.rows[0].expires_at) >= now) {
            effectiveRefCode = pendingRes.rows[0].referral_code;
          }
        }
      }

      void syncTelegramPlayMenuButton();
      void syncTelegramPlayMenuButton(msg.chat.id);

      const launchUrl = effectiveRefCode
        ? `${PUBLIC_WEBAPP_URL}${PUBLIC_WEBAPP_URL.includes('?') ? '&' : '/?'}ref=${encodeURIComponent(effectiveRefCode)}&openChrome=1`
        : `${PUBLIC_WEBAPP_URL}/?openChrome=1`;

      const inlineMarkup = {
        inline_keyboard: [
          [{ text: '🌐 Open Website in Google Chrome', url: launchUrl }],
          [{ text: '🔑 Get 6-Digit Web Migration Code', callback_data: 'migrate_web' }],
          [{ text: 'Join Community', url: CHANNEL_URL }],
        ],
      };

      const safeName = escapeTelegramHtml(existingRow?.first_name || tgUser.firstName);
      const messageBody = existingRow
        ? `<b>Welcome back to HERT Network, ${safeName}!</b>\n\nBalance: <b>${(Number(existingRow.pts || 0) / 100).toFixed(2)} HERT</b>\nInvite Code: <code>${escapeTelegramHtml(existingRow.referral_code || generateReferralCode(uidStr))}</code>\nSuccessful Referrals: <b>${Number(existingRow.invited_cnt || 0)}</b>\n\nHERT Mining now runs on the Web! Tap <b>Open Website in Google Chrome</b> below, or tap <b>Get 6-Digit Web Migration Code</b> to move your Telegram balance:`
        : effectiveRefCode
          ? `<b>Welcome to HERT Network, ${safeName}!</b>\n\nInvite Code Linked: <code>${escapeTelegramHtml(effectiveRefCode)}</code>\n\nTap <b>Open Website in Google Chrome</b> below to create your Web account and unlock your welcome bonus:`
          : `<b>Welcome to HERT Network, ${safeName}!</b>\n\nTap <b>Open Website in Google Chrome</b> below to start earning HERT Points on the Web:`;

      await sendTelegramMessage(msg.chat.id, messageBody, inlineMarkup);
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

async function handleWebhook(req, res) {
  const allowedSecrets = getExpectedWebhookSecrets();
  if (WEBHOOK_SECRET) {
    const incoming = req.header('x-telegram-bot-api-secret-token') || '';
    if (!allowedSecrets.includes(incoming)) {
      res.status(403).json({ ok: false });
      return;
    }
  }

  try {
    await Promise.race([
      processRenderWebhookUpdate(req),
      new Promise((resolve) => setTimeout(resolve, 25000)),
    ]);
  } catch (err) {
    console.error('[HERT Webhook Wrapper Error]:', err);
  }

  if (!res.headersSent) {
    res.status(200).json({ ok: true });
  }
}

app.post('/telegram/webhook', handleWebhook);
app.post('/api/telegram/webhook', handleWebhook);

app.all('/api/*', (_req, res) => {
  res.status(404).json({ error: 'API endpoint not found.' });
});

initDatabase()
  .then(() => {
    void syncTelegramPlayMenuButton();
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`HERT Mining server listening on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error('[HERT Backend] Database initialization failed:', err);
    process.exit(1);
  });
