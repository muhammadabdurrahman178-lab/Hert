import crypto from 'node:crypto';
import express from 'express';
import pg from 'pg';

const PORT = Number(process.env.PORT || 3000);
const BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
const BOT_USERNAME = (process.env.TELEGRAM_BOT_USERNAME || 'HERTCoinBot').replace(/^@/, '').trim();
const PUBLIC_WEBAPP_URL = (
  process.env.PUBLIC_WEBAPP_URL ||
  process.env.RENDER_EXTERNAL_URL ||
  'https://hert-mining-backend.onrender.com'
).replace(/\/+$/, '');
const ADMIN_TOKEN = (process.env.ADMIN_DASHBOARD_TOKEN || '').trim();

const CYCLE_MS = 4 * 60 * 60 * 1000;
const BASE_RATE_CENTS_HR = 500; // 5.00 HERT/h
const REF_BOOST_CENTS_HR = 50;  // +0.50 HERT/h per friend (up to 10)
const WELCOME_BONUS_CENTS = 15000; // 150.00 HERT
const REFERRAL_BONUS_CENTS = 5000; // 50.00 HERT
const CHECKIN_REWARDS = [100, 150, 200, 250, 300, 400, 500];

const TASKS_CATALOG = [
  {
    id: 'join_tg_channel',
    title: 'Follow Official HERT Community',
    description: 'Visit and follow the official HERT community channel for ecosystem updates.',
    category: 'social',
    mode: 'external',
    rewardCents: 3500,
    actionUrl: 'https://t.me/hertchannels',
    actionLabel: 'Join Channel',
  },
  {
    id: 'follow_x_twitter',
    title: 'Follow on X (Twitter)',
    description: 'Follow on X for official updates and exclusive community drops.',
    category: 'social',
    mode: 'external',
    rewardCents: 3500,
    actionUrl: 'https://x.com/Abdurrahman2yr',
    actionLabel: 'Follow X',
  },
  {
    id: 'join_interlink_labs',
    title: 'Join Interlink Labs',
    description: 'Join Interlink Labs via the official invite link, then claim +25.00 HERT.',
    category: 'partner',
    mode: 'external',
    rewardCents: 2500,
    actionUrl: 'https://interlinklabs.ai/08067934296',
    actionLabel: 'Join Partner',
  },
  {
    id: 'join_verychat',
    title: 'Join Verychat',
    description: 'Join Verychat via the official invite link, then claim +25.00 HERT.',
    category: 'partner',
    mode: 'external',
    rewardCents: 2500,
    actionUrl: 'https://invite.verychat.io/0808abdool',
    actionLabel: 'Join Partner',
  },
  {
    id: 'link_ton_wallet',
    title: 'Connect TON Wallet',
    description: 'Link your non-custodial TON wallet on the Airdrop tab for TGE eligibility.',
    category: 'milestone',
    mode: 'milestone',
    rewardCents: 2000,
    targetTab: 'airdrop',
    actionLabel: 'Connect Wallet',
  },
  {
    id: 'complete_first_cycle',
    title: 'Complete First Mining Cycle',
    description: 'Start mining and harvest at least one mining cycle to unlock bonus HERT.',
    category: 'milestone',
    mode: 'milestone',
    rewardCents: 1500,
    targetTab: 'home',
    actionLabel: 'Go to Mine',
  },
  {
    id: 'complete_first_checkin',
    title: 'First Daily Check-In',
    description: 'Complete at least 1 daily check-in to start your 7-day reward streak.',
    category: 'milestone',
    mode: 'milestone',
    rewardCents: 1500,
    targetTab: 'checkin',
    actionLabel: 'Check In',
  },
];

const app = express();
app.use(express.json());

// In-memory cache synced with PostgreSQL
const usersMap = new Map();
const sessionsMap = new Map();

// Guest fallback for browser testing without Telegram initData
const guestUser = {
  id: 'sandbox_guest',
  telegramId: 'sandbox_guest',
  username: null,
  firstName: 'Guest Miner',
  passwordHash: null,
  referralCode: 'HERT-GUEST',
  referredBy: null,
  pointsCents: WELCOME_BONUS_CENTS,
  completedCycles: 0,
  streakDay: 1,
  lastCheckIn: 0,
  lastSpinAt: 0,
  completedTasks: [],
  initiatedTasks: {},
  friends: [],
  totalReferralPointsCents: 0,
  wallet: { connected: false, address: null, appName: null },
  miningSession: null,
  createdAt: Date.now(),
};
usersMap.set('sandbox_guest', guestUser);

// PostgreSQL setup
let pgPool = null;
function getPgPool() {
  const dbUrl = (process.env.DATABASE_URL || '').trim();
  if (!dbUrl || (!dbUrl.startsWith('postgres://') && !dbUrl.startsWith('postgresql://'))) {
    return null;
  }
  if (!pgPool) {
    pgPool = new pg.Pool({
      connectionString: dbUrl,
      ssl: { rejectUnauthorized: false },
      max: 12,
      connectionTimeoutMillis: 5000,
    });
    pgPool.on('error', (err) => console.warn('[HERT PG] Pool error:', err.message));
  }
  return pgPool;
}

function hashPassword(pwd) {
  return crypto.createHash('sha256').update(String(pwd)).digest('hex');
}

function indexUser(user) {
  usersMap.set(user.id, user);
  usersMap.set(String(user.telegramId), user);
  if (user.username) {
    usersMap.set('uname:' + String(user.username).toLowerCase(), user);
  }
  if (user.referralCode) {
    usersMap.set('ref:' + String(user.referralCode).toUpperCase(), user);
  }
}

let dbLoadPromise = null;
async function initAndLoadDb() {
  const pool = getPgPool();
  if (!pool) {
    console.log('[HERT] No PostgreSQL DATABASE_URL found — running in-memory.');
    return;
  }
  try {
    // Non-destructive table & column alignment — preserves all existing users & coins
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
      ALTER TABLE users ADD COLUMN IF NOT EXISTS first_name TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS points BIGINT NOT NULL DEFAULT 0;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS points_cents BIGINT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS total_mined_cents BIGINT DEFAULT 0;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS completed_cycles INTEGER DEFAULT 0;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS checkin_streak INTEGER DEFAULT 1;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS last_checkin_at BIGINT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS last_spin_at BIGINT DEFAULT 0;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at_ms BIGINT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at BIGINT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;

      CREATE TABLE IF NOT EXISTS task_claims (
        id BIGSERIAL PRIMARY KEY,
        user_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at BIGINT NOT NULL,
        claimed_at BIGINT,
        reward_cents BIGINT NOT NULL DEFAULT 0,
        UNIQUE(user_id, task_id)
      );

      CREATE TABLE IF NOT EXISTS wallet_connections (
        user_id TEXT PRIMARY KEY,
        ton_address TEXT NOT NULL,
        wallet_app_name TEXT NOT NULL DEFAULT 'Tonkeeper',
        connected_at BIGINT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS mining_sessions (
        id BIGSERIAL PRIMARY KEY,
        user_id TEXT NOT NULL,
        started_at BIGINT NOT NULL,
        ends_at BIGINT NOT NULL,
        claimed_at BIGINT,
        rate_cents_per_hour INTEGER NOT NULL,
        earned_cents BIGINT NOT NULL DEFAULT 0,
        status TEXT NOT NULL
      );
    `).catch((e) => console.warn('[HERT PG] Migration notice:', e.message));

    const uRes = await pool.query('SELECT * FROM users');
    console.log(`[HERT PG] Restored ${uRes.rows.length} existing miners from PostgreSQL.`);

    for (const row of uRes.rows) {
      const tid = String(row.telegram_id);
      const pc = row.points_cents != null ? Number(row.points_cents) : 0;
      const pCents = row.points != null ? Number(row.points) * 100 : 0;
      const bestCents = Math.max(Number.isFinite(pc) ? pc : 0, Number.isFinite(pCents) ? pCents : 0);
      const pointsCents = bestCents > 0 ? bestCents : (row.points_cents == null && row.points == null ? WELCOME_BONUS_CENTS : 0);

      const lastCheckIn = row.last_checkin_at
        ? Number(row.last_checkin_at)
        : row.last_checkin
          ? new Date(row.last_checkin).getTime()
          : 0;
      const createdAt = row.created_at_ms
        ? Number(row.created_at_ms)
        : row.created_at
          ? new Date(row.created_at).getTime()
          : Date.now();

      const u = {
        id: 'user_' + tid,
        telegramId: tid,
        username: row.username || null,
        firstName: row.first_name || row.username || 'Miner',
        passwordHash: row.password_hash || null,
        referralCode: row.referral_code || ('HERT-' + tid.slice(-4)),
        referredBy: row.referred_by ? String(row.referred_by) : null,
        pointsCents,
        completedCycles: Number(row.completed_cycles || 0),
        streakDay: Math.max(1, Number(row.checkin_streak || 1)),
        lastCheckIn: Number.isFinite(lastCheckIn) ? lastCheckIn : 0,
        lastSpinAt: Number(row.last_spin_at || 0),
        completedTasks: [],
        initiatedTasks: {},
        friends: [],
        totalReferralPointsCents: 0,
        wallet: { connected: false, address: null, appName: null },
        miningSession: null,
        createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
      };
      indexUser(u);
    }

    // Reconstruct invited friends from referred_by
    const seenUsers = new Set(usersMap.values());
    for (const u of seenUsers) {
      if (u.id === 'sandbox_guest' || !u.referredBy) continue;
      const inviter =
        usersMap.get(u.referredBy) ||
        usersMap.get('user_' + u.referredBy) ||
        usersMap.get('ref:' + String(u.referredBy).toUpperCase());
      if (inviter && inviter.id !== u.id && !inviter.friends.some((f) => f.telegramId === u.telegramId)) {
        inviter.friends.push({
          telegramId: u.telegramId,
          username: u.username,
          firstName: u.firstName,
          joinedAt: u.createdAt,
        });
        inviter.totalReferralPointsCents += REFERRAL_BONUS_CENTS;
      }
    }

    // Restore wallets
    try {
      const wRes = await pool.query('SELECT * FROM wallet_connections');
      for (const w of wRes.rows) {
        const u = usersMap.get(String(w.user_id)) || usersMap.get('user_' + String(w.user_id));
        if (u && w.ton_address) {
          u.wallet = { connected: true, address: w.ton_address, appName: w.wallet_app_name || 'Tonkeeper' };
        }
      }
    } catch {}

    // Restore claimed/started tasks
    try {
      const tRes = await pool.query('SELECT * FROM task_claims');
      for (const t of tRes.rows) {
        const u = usersMap.get(String(t.user_id)) || usersMap.get('user_' + String(t.user_id));
        if (!u || !t.task_id) continue;
        if (t.status === 'claimed' && !u.completedTasks.includes(t.task_id)) {
          u.completedTasks.push(t.task_id);
        } else if (t.status === 'started' && t.started_at) {
          u.initiatedTasks[t.task_id] = Number(t.started_at);
        }
      }
    } catch {}

    // Restore active mining sessions
    try {
      const mRes = await pool.query("SELECT * FROM mining_sessions WHERE status = 'active'");
      for (const m of mRes.rows) {
        const u = usersMap.get(String(m.user_id)) || usersMap.get('user_' + String(m.user_id));
        if (u) {
          u.miningSession = {
            id: m.id,
            startedAt: Number(m.started_at),
            endsAt: Number(m.ends_at),
            rateCentsPerHour: Number(m.rate_cents_per_hour || BASE_RATE_CENTS_HR),
          };
        }
      }
    } catch {}
  } catch (err) {
    console.warn('[HERT PG] Load warning:', err.message);
  }
}

async function saveUserToDb(user) {
  const pool = getPgPool();
  if (!pool || user.id === 'sandbox_guest') return;
  try {
    await pool.query(
      `UPDATE users
       SET points_cents = $1,
           points = $2,
           total_mined_cents = $1,
           completed_cycles = $3,
           checkin_streak = $4,
           last_checkin_at = $5,
           last_spin_at = $6,
           username = COALESCE($7, username),
           first_name = COALESCE($8, first_name),
           referral_code = COALESCE(referral_code, $9),
           password_hash = COALESCE($10, password_hash),
           updated_at = $11
       WHERE CAST(telegram_id AS TEXT) = $12`,
      [
        user.pointsCents,
        Math.floor(user.pointsCents / 100),
        user.completedCycles,
        user.streakDay,
        user.lastCheckIn || null,
        user.lastSpinAt || 0,
        user.username,
        user.firstName,
        user.referralCode,
        user.passwordHash || null,
        Date.now(),
        user.telegramId,
      ]
    );
  } catch (err) {
    try {
      await pool.query(
        'UPDATE users SET points = $1 WHERE CAST(telegram_id AS TEXT) = $2',
        [Math.floor(user.pointsCents / 100), user.telegramId]
      );
    } catch {}
  }
}

async function insertNewUserToDb(user) {
  const pool = getPgPool();
  if (!pool || user.id === 'sandbox_guest') return;
  try {
    await pool.query(
      `INSERT INTO users (telegram_id, username, first_name, referral_code, referred_by, points, points_cents, total_mined_cents, completed_cycles, checkin_streak, created_at_ms, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7, 0, 1, $8, $8)
       ON CONFLICT (telegram_id) DO NOTHING`,
      [
        user.telegramId,
        user.username,
        user.firstName,
        user.referralCode,
        user.referredBy && /^\d+$/.test(user.referredBy) ? user.referredBy : null,
        Math.floor(user.pointsCents / 100),
        user.pointsCents,
        user.createdAt,
      ]
    );
  } catch (err) {
    try {
      await pool.query(
        'INSERT INTO users (telegram_id, username, points) VALUES ($1, $2, $3) ON CONFLICT (telegram_id) DO NOTHING',
        [user.telegramId, user.username, Math.floor(user.pointsCents / 100)]
      );
    } catch {}
  }
}

function parseTelegramUser(initData) {
  if (!initData || typeof initData !== 'string') return null;
  try {
    const params = new URLSearchParams(initData);
    const userJson = params.get('user');
    if (!userJson) return null;
    const tgUser = JSON.parse(userJson);
    if (!tgUser || !tgUser.id) return null;

    if (BOT_TOKEN && params.get('hash')) {
      const checkArr = [];
      for (const [k, v] of params.entries()) {
        if (k !== 'hash') checkArr.push(`${k}=${v}`);
      }
      checkArr.sort();
      const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
      const computedHash = crypto.createHmac('sha256', secretKey).update(checkArr.join('\n')).digest('hex');
      if (computedHash !== params.get('hash')) {
        console.warn('[HERT Auth] InitData signature did not match current BOT_TOKEN.');
      }
    }

    return {
      telegramId: String(tgUser.id),
      username: tgUser.username || null,
      firstName: tgUser.first_name || tgUser.username || 'Miner',
      startParam: params.get('start_param') || null,
    };
  } catch {
    return null;
  }
}

async function resolveUserFromReq(req) {
  if (dbLoadPromise) await dbLoadPromise.catch(() => {});

  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) {
    const tok = auth.slice(7).trim();
    const uid = sessionsMap.get(tok);
    if (uid && usersMap.has(uid)) return usersMap.get(uid);
  }

  const initData = req.headers['x-telegram-init-data'] || req.headers['x-telegram-webapp-data'] || '';
  const tg = parseTelegramUser(initData);
  if (tg) {
    let user = usersMap.get(tg.telegramId) || usersMap.get('user_' + tg.telegramId);
    if (user) {
      let changed = false;
      if (tg.username && user.username !== tg.username) { user.username = tg.username; changed = true; }
      if (tg.firstName && user.firstName === 'Miner') { user.firstName = tg.firstName; changed = true; }
      if (changed) { indexUser(user); void saveUserToDb(user); }
      return user;
    }

    user = {
      id: 'user_' + tg.telegramId,
      telegramId: tg.telegramId,
      username: tg.username,
      firstName: tg.firstName,
      passwordHash: null,
      referralCode: 'HERT-' + tg.telegramId.slice(-4),
      referredBy: null,
      pointsCents: WELCOME_BONUS_CENTS,
      completedCycles: 0,
      streakDay: 1,
      lastCheckIn: 0,
      lastSpinAt: 0,
      completedTasks: [],
      initiatedTasks: {},
      friends: [],
      totalReferralPointsCents: 0,
      wallet: { connected: false, address: null, appName: null },
      miningSession: null,
      createdAt: Date.now(),
    };

    if (tg.startParam) {
      const code = tg.startParam.trim().toUpperCase();
      const inviter = usersMap.get('ref:' + code) || usersMap.get(code);
      if (inviter && inviter.telegramId !== user.telegramId) {
        user.referredBy = inviter.telegramId;
        user.pointsCents += REFERRAL_BONUS_CENTS;
        inviter.pointsCents += REFERRAL_BONUS_CENTS;
        inviter.totalReferralPointsCents += REFERRAL_BONUS_CENTS;
        inviter.friends.unshift({
          telegramId: user.telegramId,
          username: user.username,
          firstName: user.firstName,
          joinedAt: Date.now(),
        });
        void saveUserToDb(inviter);
      }
    }

    indexUser(user);
    await insertNewUserToDb(user);
    return user;
  }

  return guestUser;
}

function buildPayload(user) {
  const now = Date.now();
  const effectiveRate = BASE_RATE_CENTS_HR + Math.min(10, user.friends.length) * REF_BOOST_CENTS_HR;

  let activeSession = null;
  if (user.miningSession) {
    const elapsed = Math.max(0, now - user.miningSession.startedAt);
    const total = Math.max(60000, user.miningSession.endsAt - user.miningSession.startedAt);
    const remainingMs = Math.max(0, user.miningSession.endsAt - now);
    const ratio = Math.min(1, elapsed / total);
    const rate = user.miningSession.rateCentsPerHour || effectiveRate;
    const accruedCents = Math.floor((rate * (total / 3600000)) * ratio);
    activeSession = {
      startedAt: user.miningSession.startedAt,
      endsAt: user.miningSession.endsAt,
      rateCentsPerHour: rate,
      remainingMs,
      progressPercent: Math.min(100, (elapsed / total) * 100),
      accruedCents,
      canClaim: elapsed >= 60000,
      unlockRemainingSec: Math.max(0, Math.ceil((60000 - elapsed) / 1000)),
    };
  }

  const canCheckIn = user.lastCheckIn === 0 || (now - user.lastCheckIn >= 24 * 3600000);
  const canSpin = user.lastSpinAt === 0 || (now - user.lastSpinAt >= 24 * 3600000);

  const tasks = TASKS_CATALOG.map((t) => {
    const claimed = user.completedTasks.includes(t.id);
    let status = claimed ? 'claimed' : 'available';
    let waitSec = 0;

    if (!claimed) {
      if (t.id === 'link_ton_wallet') {
        status = user.wallet.connected ? 'ready_to_claim' : 'available';
      } else if (t.id === 'complete_first_cycle') {
        status = user.completedCycles >= 1 ? 'ready_to_claim' : 'available';
      } else if (t.id === 'complete_first_checkin') {
        status = user.lastCheckIn > 0 ? 'ready_to_claim' : 'available';
      } else if (user.initiatedTasks[t.id]) {
        const diff = now - user.initiatedTasks[t.id];
        if (diff >= 8000) status = 'ready_to_claim';
        else {
          status = 'verifying';
          waitSec = Math.ceil((8000 - diff) / 1000);
        }
      }
    }
    return { ...t, status, waitSec };
  });

  const checklist = [
    { key: 'wallet', label: 'Connect Non-Custodial TON Wallet', done: user.wallet.connected },
    { key: 'mining', label: 'Complete at least 1 Mining Cycle', done: user.completedCycles >= 1 },
    { key: 'checkin', label: 'Activate Daily Check-In Streak', done: user.lastCheckIn > 0 },
    { key: 'task', label: 'Complete at least 1 Community Task', done: user.completedTasks.length >= 1 },
  ];
  const eligibleCount = checklist.filter((c) => c.done).length;

  return {
    serverTime: now,
    isGuest: user.id === 'sandbox_guest',
    user: {
      telegramId: user.telegramId,
      username: user.username,
      firstName: user.firstName,
      referralCode: user.referralCode,
      referredBy: user.referredBy,
      pointsCents: user.pointsCents,
      completedCycles: user.completedCycles,
      hasPassword: Boolean(user.passwordHash),
    },
    mining: {
      activeSession,
      baseRateCentsPerHour: BASE_RATE_CENTS_HR,
      effectiveRateCentsPerHour: effectiveRate,
      cycleDurationMs: CYCLE_MS,
    },
    checkIn: {
      streakDay: user.streakDay,
      canCheckIn,
      cooldownRemainingMs: user.lastCheckIn ? Math.max(0, user.lastCheckIn + 24 * 3600000 - now) : 0,
      rewards: CHECKIN_REWARDS,
    },
    luckyWheel: {
      canSpin,
      cooldownRemainingMs: user.lastSpinAt ? Math.max(0, user.lastSpinAt + 24 * 3600000 - now) : 0,
    },
    tasks,
    referrals: {
      referralCode: user.referralCode,
      telegramDeepLink: `https://t.me/${BOT_USERNAME}?start=${user.referralCode}`,
      webInviteLink: `${PUBLIC_WEBAPP_URL}/?ref=${user.referralCode}`,
      invitedCount: user.friends.length,
      totalReferralPointsCents: user.totalReferralPointsCents,
      friends: user.friends,
    },
    wallet: user.wallet,
    airdrop: {
      checklist,
      eligibleCount,
      totalChecks: checklist.length,
      estimatedTokens: Number((user.pointsCents / 1000).toFixed(2)),
    },
  };
}

// --- API ROUTES ---

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, status: 'ok', time: Date.now() });
});

app.get('/tonconnect-manifest.json', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host = req.get('host') || 'hert-mining-backend.onrender.com';
  const origin = `${proto}://${host}`;
  res.json({
    url: origin,
    name: 'HERT Mining',
    iconUrl: `${origin}/hert-icon.png`,
    termsOfUseUrl: origin,
    privacyPolicyUrl: origin,
  });
});

app.get('/api/dashboard', async (req, res) => {
  const user = await resolveUserFromReq(req);
  res.json(buildPayload(user));
});

// Mining Start
app.post('/api/mining/start', async (req, res) => {
  const user = await resolveUserFromReq(req);
  if (user.miningSession && user.miningSession.endsAt > Date.now()) {
    return res.json(buildPayload(user));
  }
  const now = Date.now();
  const rate = BASE_RATE_CENTS_HR + Math.min(10, user.friends.length) * REF_BOOST_CENTS_HR;
  user.miningSession = { startedAt: now, endsAt: now + CYCLE_MS, rateCentsPerHour: rate };

  const pool = getPgPool();
  if (pool && user.id !== 'sandbox_guest') {
    await pool.query(
      "INSERT INTO mining_sessions (user_id, started_at, ends_at, rate_cents_per_hour, status) VALUES ($1, $2, $3, $4, 'active')",
      [user.telegramId, now, now + CYCLE_MS, rate]
    ).catch(() => {});
  }
  res.json(buildPayload(user));
});

// Mining Harvest
app.post('/api/mining/claim', async (req, res) => {
  const user = await resolveUserFromReq(req);
  if (!user.miningSession) {
    return res.status(400).json({ error: 'No active mining session found.' });
  }
  const now = Date.now();
  const elapsed = Math.max(0, now - user.miningSession.startedAt);
  if (elapsed < 60000) {
    return res.status(400).json({ error: 'Mine for at least 60 seconds before harvesting.' });
  }
  const total = Math.max(60000, user.miningSession.endsAt - user.miningSession.startedAt);
  const ratio = Math.min(1, elapsed / total);
  const earnedCents = Math.max(10, Math.floor((user.miningSession.rateCentsPerHour * (total / 3600000)) * ratio));

  user.pointsCents += earnedCents;
  user.completedCycles += 1;
  user.miningSession = null;

  const pool = getPgPool();
  if (pool && user.id !== 'sandbox_guest') {
    await pool.query(
      "UPDATE mining_sessions SET status = 'claimed', claimed_at = $1, earned_cents = $2 WHERE user_id = $3 AND status = 'active'",
      [now, earnedCents, user.telegramId]
    ).catch(() => {});
  }
  await saveUserToDb(user);
  res.json({ ...buildPayload(user), earnedCents });
});

// Daily Check-In
app.post('/api/checkin/claim', async (req, res) => {
  const user = await resolveUserFromReq(req);
  const now = Date.now();
  if (user.lastCheckIn > 0 && now - user.lastCheckIn < 24 * 3600000) {
    return res.status(400).json({ error: 'Daily check-in already claimed today. Come back after 24 hours.' });
  }
  const reward = CHECKIN_REWARDS[(user.streakDay - 1) % CHECKIN_REWARDS.length] || 100;
  user.pointsCents += reward;
  user.lastCheckIn = now;
  user.streakDay = user.streakDay < 7 ? user.streakDay + 1 : 1;
  await saveUserToDb(user);
  res.json({ ...buildPayload(user), rewardCents: reward });
});

// Daily Lucky Wheel
app.post('/api/lucky-spin', async (req, res) => {
  const user = await resolveUserFromReq(req);
  const now = Date.now();
  if (user.lastSpinAt > 0 && now - user.lastSpinAt < 24 * 3600000) {
    return res.status(400).json({ error: 'Daily wheel already spun today. Return tomorrow!' });
  }
  const prizes = [
    { cents: 100, label: '+1.00 HERT' },
    { cents: 200, label: '+2.00 HERT' },
    { cents: 300, label: '+3.00 HERT' },
    { cents: 500, label: '+5.00 HERT' },
    { cents: 1000, label: '+10.00 HERT' },
    { cents: 2500, label: 'Jackpot +25.00 HERT!' },
  ];
  const won = prizes[Math.floor(Math.random() * prizes.length)];
  user.pointsCents += won.cents;
  user.lastSpinAt = now;
  await saveUserToDb(user);
  res.json({ ...buildPayload(user), wonCents: won.cents, label: won.label });
});

// Tasks: Start External Visit Verification
app.post('/api/tasks/:id/start', async (req, res) => {
  const user = await resolveUserFromReq(req);
  const taskId = req.params.id;
  const now = Date.now();
  if (!user.initiatedTasks[taskId]) {
    user.initiatedTasks[taskId] = now;
    const pool = getPgPool();
    if (pool && user.id !== 'sandbox_guest') {
      await pool.query(
        "INSERT INTO task_claims (user_id, task_id, status, started_at) VALUES ($1, $2, 'started', $3) ON CONFLICT (user_id, task_id) DO NOTHING",
        [user.telegramId, taskId, now]
      ).catch(() => {});
    }
  }
  res.json(buildPayload(user));
});

// Tasks: Claim Reward (strict verification)
app.post('/api/tasks/:id/claim', async (req, res) => {
  const user = await resolveUserFromReq(req);
  const taskId = req.params.id;
  const task = TASKS_CATALOG.find((t) => t.id === taskId);
  if (!task) return res.status(404).json({ error: 'Task not found.' });
  if (user.completedTasks.includes(taskId)) {
    return res.status(400).json({ error: 'Task reward already claimed.' });
  }

  if (taskId === 'link_ton_wallet' && !user.wallet.connected) {
    return res.status(400).json({ error: 'Connect your TON Wallet on the Airdrop tab first.' });
  }
  if (taskId === 'complete_first_cycle' && user.completedCycles < 1) {
    return res.status(400).json({ error: 'Complete at least one mining cycle first.' });
  }
  if (taskId === 'complete_first_checkin' && user.lastCheckIn <= 0) {
    return res.status(400).json({ error: 'Complete your Daily Check-In first.' });
  }
  if (task.mode === 'external') {
    const startedAt = user.initiatedTasks[taskId];
    if (!startedAt) {
      return res.status(400).json({ error: 'Open the quest link first before claiming.' });
    }
    const elapsed = Date.now() - startedAt;
    if (elapsed < 8000) {
      return res.status(400).json({
        error: `Verifying completion... wait ${Math.ceil((8000 - elapsed) / 1000)}s.`,
      });
    }
  }

  const now = Date.now();
  user.completedTasks.push(taskId);
  user.pointsCents += task.rewardCents;

  const pool = getPgPool();
  if (pool && user.id !== 'sandbox_guest') {
    await pool.query(
      `INSERT INTO task_claims (user_id, task_id, status, started_at, claimed_at, reward_cents)
       VALUES ($1, $2, 'claimed', $3, $3, $4)
       ON CONFLICT (user_id, task_id) DO UPDATE SET status = 'claimed', claimed_at = $3, reward_cents = $4`,
      [user.telegramId, taskId, now, task.rewardCents]
    ).catch(() => {});
  }
  await saveUserToDb(user);
  res.json(buildPayload(user));
});

// Referrals: Apply Invite Code (+50.00 HERT)
app.post('/api/referrals/apply', async (req, res) => {
  const user = await resolveUserFromReq(req);
  const code = String(req.body?.referralCode || '').trim().toUpperCase();
  if (!code) return res.status(400).json({ error: 'Please enter a valid invite code.' });
  if (user.referredBy) return res.status(400).json({ error: 'Invite code already applied.' });
  if (code === user.referralCode.toUpperCase()) {
    return res.status(400).json({ error: 'You cannot use your own referral code.' });
  }

  const inviter = usersMap.get('ref:' + code) || usersMap.get(code);
  if (!inviter) {
    return res.status(404).json({ error: 'Referral code not found.' });
  }

  user.referredBy = inviter.telegramId;
  user.pointsCents += REFERRAL_BONUS_CENTS;
  inviter.pointsCents += REFERRAL_BONUS_CENTS;
  inviter.totalReferralPointsCents += REFERRAL_BONUS_CENTS;
  inviter.friends.unshift({
    telegramId: user.telegramId,
    username: user.username,
    firstName: user.firstName,
    joinedAt: Date.now(),
  });

  await saveUserToDb(user);
  await saveUserToDb(inviter);
  res.json({ ...buildPayload(user), message: '+50.00 HERT referral bonus credited!' });
});

// Wallet Connect / Disconnect
app.post('/api/wallet/connect', async (req, res) => {
  const user = await resolveUserFromReq(req);
  const address = String(req.body?.address || '').trim();
  const appName = String(req.body?.walletAppName || 'Tonkeeper').trim();
  if (address.length < 10) {
    return res.status(400).json({ error: 'Please enter a valid TON wallet address.' });
  }
  user.wallet = { connected: true, address, appName };
  const pool = getPgPool();
  if (pool && user.id !== 'sandbox_guest') {
    await pool.query(
      `INSERT INTO wallet_connections (user_id, ton_address, wallet_app_name, connected_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id) DO UPDATE SET ton_address = $2, wallet_app_name = $3, connected_at = $4`,
      [user.telegramId, address, appName, Date.now()]
    ).catch(() => {});
  }
  res.json(buildPayload(user));
});

app.post('/api/wallet/disconnect', async (req, res) => {
  const user = await resolveUserFromReq(req);
  user.wallet = { connected: false, address: null, appName: null };
  const pool = getPgPool();
  if (pool && user.id !== 'sandbox_guest') {
    await pool.query('DELETE FROM wallet_connections WHERE user_id = $1', [user.telegramId]).catch(() => {});
  }
  res.json(buildPayload(user));
});

// Web Login & Create Password (Recover real Telegram account + old coins from PostgreSQL)
app.post('/api/auth/create-password', async (req, res) => {
  if (dbLoadPromise) await dbLoadPromise.catch(() => {});
  const identifier = String(req.body?.identifier || '').trim().toLowerCase().replace(/^@/, '');
  const password = String(req.body?.password || '');
  if (!identifier) return res.status(400).json({ error: 'Enter your Telegram username or numeric ID.' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });

  let user = usersMap.get('uname:' + identifier) || usersMap.get(identifier) || usersMap.get('user_' + identifier);
  if (!user) {
    const tid = /^\d+$/.test(identifier) ? identifier : String(Math.floor(1000000000 + Math.random() * 8999999999));
    user = {
      id: 'user_' + tid,
      telegramId: tid,
      username: /^\d+$/.test(identifier) ? null : identifier,
      firstName: identifier.charAt(0).toUpperCase() + identifier.slice(1),
      passwordHash: hashPassword(password),
      referralCode: 'HERT-' + tid.slice(-4),
      referredBy: null,
      pointsCents: WELCOME_BONUS_CENTS,
      completedCycles: 0,
      streakDay: 1,
      lastCheckIn: 0,
      lastSpinAt: 0,
      completedTasks: [],
      initiatedTasks: {},
      friends: [],
      totalReferralPointsCents: 0,
      wallet: { connected: false, address: null, appName: null },
      miningSession: null,
      createdAt: Date.now(),
    };
    indexUser(user);
    await insertNewUserToDb(user);
  } else {
    user.passwordHash = hashPassword(password);
    await saveUserToDb(user);
  }

  const token = 'hert_' + crypto.randomBytes(16).toString('hex');
  sessionsMap.set(token, user.id);
  res.json({ ok: true, token, payload: buildPayload(user) });
});

app.post('/api/auth/login', async (req, res) => {
  if (dbLoadPromise) await dbLoadPromise.catch(() => {});
  const identifier = String(req.body?.identifier || '').trim().toLowerCase().replace(/^@/, '');
  const password = String(req.body?.password || '');
  if (!identifier || !password) {
    return res.status(400).json({ error: 'Please enter your Telegram username/ID and password.' });
  }
  const user = usersMap.get('uname:' + identifier) || usersMap.get(identifier) || usersMap.get('user_' + identifier);
  if (!user) {
    return res.status(404).json({ error: 'Account not found. Open inside Telegram or use Create Password.' });
  }
  if (!user.passwordHash) {
    return res.status(400).json({ error: 'No password set for this account yet. Click Create Password first.' });
  }
  if (user.passwordHash !== hashPassword(password)) {
    return res.status(401).json({ error: 'Incorrect password.' });
  }
  const token = 'hert_' + crypto.randomBytes(16).toString('hex');
  sessionsMap.set(token, user.id);
  res.json({ ok: true, token, payload: buildPayload(user) });
});

// Admin Overview
app.get('/api/admin/overview', async (req, res) => {
  if (dbLoadPromise) await dbLoadPromise.catch(() => {});
  const token = String(req.headers['x-admin-token'] || req.query.token || '').trim();
  if (ADMIN_TOKEN && token !== ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const uniqueUsers = Array.from(new Set(usersMap.values())).filter((u) => u.id !== 'sandbox_guest');
  const totalPointsCents = uniqueUsers.reduce((acc, u) => acc + u.pointsCents, 0);
  res.json({
    totalUsers: uniqueUsers.length,
    totalHertCoins: (totalPointsCents / 100).toFixed(2),
    connectedWallets: uniqueUsers.filter((u) => u.wallet.connected).length,
    topMiners: uniqueUsers
      .sort((a, b) => b.pointsCents - a.pointsCents)
      .slice(0, 50)
      .map((u) => ({
        telegramId: u.telegramId,
        username: u.username,
        firstName: u.firstName,
        hert: (u.pointsCents / 100).toFixed(2),
        wallet: u.wallet.address,
      })),
  });
});

// Telegram Bot Webhook
app.post('/api/telegram-webhook', (_req, res) => {
  res.status(200).json({ ok: true });
});

// --- FULL BUILT-IN HERT MINING MINI APP FRONTEND ---
const APP_HTML = `<!doctype html>
<html lang="en" class="dark">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
  <title>HERT Mining — Telegram Mini App</title>
  <script src="https://telegram.org/js/telegram-web-app.js"></script>
  <style>
    :root { --bg: #050807; --card: #0C120F; --card2: #111915; --gold: #D4AF37; --gold2: #E5C158; --green: #10B981; --green2: #34D399; --text: #F3F5F4; --muted: #8E9D96; --border: rgba(255,255,255,0.08); }
    * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: var(--bg); color: var(--text); padding-bottom: 84px; }
    .wrap { max-width: 460px; margin: 0 auto; padding: 14px; }
    .topbar { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; }
    .brand { display: flex; align-items: center; gap: 10px; }
    .logo { width: 38px; height: 38px; border-radius: 12px; background: linear-gradient(135deg, #1E2418, #0D120E); border: 1px solid rgba(212,175,55,0.45); display: flex; align-items: center; justify-content: center; font-weight: 900; color: var(--gold2); font-size: 18px; }
    .badge { background: rgba(212,175,55,0.16); color: var(--gold2); font-size: 10px; font-weight: 800; padding: 2px 7px; border-radius: 99px; border: 1px solid rgba(212,175,55,0.3); }
    .btn-ghost { background: rgba(255,255,255,0.05); border: 1px solid rgba(212,175,55,0.35); color: var(--gold2); font-size: 12px; font-weight: 700; padding: 7px 12px; border-radius: 99px; cursor: pointer; }
    .card { background: var(--card); border: 1px solid var(--border); border-radius: 20px; padding: 16px; margin-bottom: 12px; }
    .hero { background: linear-gradient(180deg, #141A16 0%, #090D0B 100%); border: 1px solid rgba(212,175,55,0.28); }
    .row { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
    .balance-val { font-family: ui-monospace, monospace; font-size: 34px; font-weight: 900; letter-spacing: -0.5px; margin: 6px 0 12px; }
    .balance-unit { font-size: 13px; color: var(--gold); font-weight: 800; margin-left: 6px; }
    .mine-box { background: rgba(5,8,7,0.8); border: 1px solid var(--border); border-radius: 16px; padding: 14px; }
    .btn-gold { background: linear-gradient(135deg, #D4AF37, #E5C158); color: #050807; border: none; border-radius: 12px; padding: 11px 16px; font-weight: 800; font-size: 13px; cursor: pointer; }
    .btn-green { background: var(--green); color: #050807; border: none; border-radius: 12px; padding: 10px 14px; font-weight: 800; font-size: 12px; cursor: pointer; }
    .btn-dark { background: rgba(255,255,255,0.07); color: var(--text); border: 1px solid var(--border); border-radius: 12px; padding: 10px 14px; font-weight: 700; font-size: 12px; cursor: pointer; }
    .btn-full { width: 100%; display: block; text-align: center; }
    .btn-disabled { opacity: 0.55; cursor: not-allowed; }
    .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 12px; }
    .tile { background: var(--card2); border: 1px solid var(--border); border-radius: 16px; padding: 13px; text-align: left; cursor: pointer; color: var(--text); }
    .muted { color: var(--muted); font-size: 12px; margin: 0; }
    .label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.7px; color: var(--muted); font-weight: 700; }
    .progress-track { height: 7px; border-radius: 99px; background: rgba(255,255,255,0.08); overflow: hidden; margin: 8px 0; }
    .progress-fill { height: 100%; background: linear-gradient(90deg, var(--green), var(--gold)); transition: width 0.5s; }
    .nav { position: fixed; bottom: 0; left: 0; right: 0; background: rgba(9,13,11,0.96); backdrop-filter: blur(12px); border-top: 1px solid var(--border); display: flex; justify-content: space-around; align-items: center; padding: 8px 6px 12px; z-index: 50; }
    .nav-btn { background: none; border: none; color: var(--muted); font-size: 11px; font-weight: 700; display: flex; flex-direction: column; align-items: center; gap: 3px; cursor: pointer; min-width: 56px; }
    .nav-btn.active { color: var(--gold2); }
    .spin-fab { width: 46px; height: 46px; border-radius: 50%; background: linear-gradient(135deg, #D4AF37, #E5C158); color: #050807; border: none; font-size: 20px; display: flex; align-items: center; justify-content: center; margin-top: -18px; box-shadow: 0 4px 18px rgba(212,175,55,0.4); cursor: pointer; }
    .pills { display: flex; gap: 6px; margin-bottom: 12px; overflow-x: auto; }
    .pill { background: var(--card); border: 1px solid var(--border); color: var(--muted); padding: 7px 12px; border-radius: 10px; font-size: 12px; font-weight: 700; cursor: pointer; white-space: nowrap; }
    .pill.active { background: rgba(212,175,55,0.18); border-color: var(--gold); color: var(--gold2); }
    .task-card { background: var(--card); border: 1px solid var(--border); border-radius: 16px; padding: 13px; margin-bottom: 10px; display: flex; align-items: center; justify-content: space-between; gap: 10px; }
    .day-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin: 12px 0; }
    .day-box { background: var(--card2); border: 1px solid var(--border); border-radius: 12px; padding: 10px 6px; text-align: center; font-size: 11px; }
    .day-box.active { border-color: var(--green); background: rgba(16,185,129,0.14); }
    .input { width: 100%; background: #070A09; border: 1px solid var(--border); color: var(--text); border-radius: 12px; padding: 11px 12px; font-size: 13px; margin-bottom: 10px; }
    .modal-bg { position: fixed; inset: 0; background: rgba(0,0,0,0.78); display: none; align-items: center; justify-content: center; padding: 18px; z-index: 100; }
    .modal-bg.open { display: flex; }
    .modal { width: 100%; max-width: 380px; background: #0E1411; border: 1px solid rgba(212,175,55,0.35); border-radius: 22px; padding: 20px; }
    .toast { position: fixed; top: 14px; left: 50%; transform: translateX(-50%); background: #13221C; border: 1px solid var(--green); color: #fff; padding: 10px 16px; border-radius: 12px; font-size: 12px; font-weight: 700; z-index: 200; display: none; max-width: 90%; text-align: center; }
    .wheel-circle { width: 130px; height: 130px; margin: 16px auto; border-radius: 50%; border: 4px solid var(--gold); background: conic-gradient(#14241C 0 60deg, #1E2414 60deg 120deg, #102A20 120deg 180deg, #272110 180deg 240deg, #12231B 240deg 300deg, #292211 300deg 360deg); display: flex; align-items: center; justify-content: center; font-size: 32px; transition: transform 1.2s cubic-bezier(0.2, 0.8, 0.2, 1); }
    .check-row { display: flex; align-items: center; justify-content: space-between; padding: 9px 0; border-bottom: 1px solid var(--border); font-size: 12px; }
    .check-row:last-child { border-bottom: none; }
  </style>
</head>
<body>
  <div id="toast" class="toast"></div>

  <div class="wrap">
    <div class="topbar">
      <div class="brand">
        <div class="logo">H</div>
        <div>
          <div style="display:flex;align-items:center;gap:6px;">
            <strong style="font-size:15px;">HERT</strong>
            <span class="badge">v2.0</span>
          </div>
          <p id="hdr-user" class="muted" style="font-size:11px;">Loading miner...</p>
        </div>
      </div>
      <button id="btn-auth-modal" class="btn-ghost" onclick="openAuthModal()">Web Login</button>
    </div>

    <div id="view-root"></div>
  </div>

  <nav class="nav">
    <button class="nav-btn active" data-tab="home" onclick="switchTab('home')"><span>⛏️</span><span>Mine</span></button>
    <button class="nav-btn" data-tab="tasks" onclick="switchTab('tasks')"><span>📋</span><span>Tasks</span></button>
    <button class="spin-fab" onclick="openWheelModal()" title="Daily Lucky Wheel">✨</button>
    <button class="nav-btn" data-tab="friends" onclick="switchTab('friends')"><span>👥</span><span>Friends</span></button>
    <button class="nav-btn" data-tab="airdrop" onclick="switchTab('airdrop')"><span>💎</span><span>Airdrop</span></button>
  </nav>

  <div id="wheel-modal" class="modal-bg">
    <div class="modal" style="text-align:center;">
      <h3 style="margin:0 0 4px;">Daily Lucky Wheel</h3>
      <p class="muted">Spin once every 24h to win up to 25.00 HERT!</p>
      <div id="wheel-disc" class="wheel-circle">🎁</div>
      <p id="wheel-result" style="font-weight:800;color:var(--gold2);min-height:20px;margin:8px 0;"></p>
      <button id="btn-spin-now" class="btn-gold btn-full" onclick="spinWheel()">Spin Wheel Now</button>
      <button class="btn-dark btn-full" style="margin-top:8px;" onclick="closeModal('wheel-modal')">Close</button>
    </div>
  </div>

  <div id="auth-modal" class="modal-bg">
    <div class="modal">
      <div class="row" style="margin-bottom:12px;">
        <h3 style="margin:0;">Account & Recovery</h3>
        <button class="btn-dark" style="padding:5px 10px;" onclick="closeModal('auth-modal')">✕</button>
      </div>
      <div class="pills">
        <button id="tab-login" class="pill active" onclick="setAuthMode('login')">Login</button>
        <button id="tab-create" class="pill" onclick="setAuthMode('create')">Create Password</button>
      </div>
      <p id="auth-desc" class="muted" style="margin-bottom:10px;">Sign in with your Telegram username or numeric ID to restore your coins.</p>
      <input id="auth-id" class="input" placeholder="Telegram username (e.g. @username) or ID" />
      <input id="auth-pwd" class="input" type="password" placeholder="Password (min. 6 characters)" />
      <button class="btn-gold btn-full" onclick="submitAuth()">Continue</button>
    </div>
  </div>

  <div id="wallet-modal" class="modal-bg">
    <div class="modal">
      <div class="row" style="margin-bottom:10px;">
        <h3 style="margin:0;">Connect TON Wallet</h3>
        <button class="btn-dark" style="padding:5px 10px;" onclick="closeModal('wallet-modal')">✕</button>
      </div>
      <p class="muted" style="margin-bottom:10px;">Choose a TON wallet or paste your non-custodial TON address (UQ... / EQ...):</p>
      <input id="wallet-addr-input" class="input" placeholder="UQ... or EQ... TON address" />
      <div class="grid2">
        <button class="btn-gold" onclick="quickWallet('Tonkeeper')">Tonkeeper</button>
        <button class="btn-green" onclick="quickWallet('Telegram Wallet')">TG @wallet</button>
      </div>
      <button class="btn-dark btn-full" style="margin-top:8px;" onclick="connectManualWallet()">Save Entered Address</button>
    </div>
  </div>

  <script>
    var state = { tab: 'home', taskFilter: 'all', authMode: 'login', data: null, wheelDeg: 0 };
    var tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
    if (tg) { try { tg.ready(); tg.expand(); } catch (e) {} }

    function showToast(msg) {
      var el = document.getElementById('toast');
      el.textContent = msg;
      el.style.display = 'block';
      setTimeout(function() { el.style.display = 'none'; }, 3200);
    }

    function fmt(cents) {
      return ((cents || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    function fmtTime(ms) {
      var s = Math.max(0, Math.floor(ms / 1000));
      var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
      return h + 'h ' + String(m).padStart(2, '0') + 'm ' + String(sec).padStart(2, '0') + 's';
    }

    function leagueFor(cents) {
      var hert = (cents || 0) / 100;
      if (hert >= 5000) return '💎 Diamond Miner';
      if (hert >= 1500) return '🏆 Platinum Miner';
      if (hert >= 500) return '🥇 Gold Miner';
      if (hert >= 250) return '🥈 Silver Miner';
      return '🛡️ Bronze Miner';
    }

    function getTgInitData() {
      if (tg && tg.initData) return tg.initData;
      try {
        var hash = window.location.hash || '';
        if (hash.indexOf('tgWebAppData=') !== -1) {
          var hp = new URLSearchParams(hash.replace(/^#/, ''));
          var raw = hp.get('tgWebAppData');
          if (raw) return raw;
        }
      } catch (e) {}
      if (tg && tg.initDataUnsafe && tg.initDataUnsafe.user) {
        return 'user=' + encodeURIComponent(JSON.stringify(tg.initDataUnsafe.user));
      }
      return '';
    }

    function api(path, method, body) {
      var headers = { 'Content-Type': 'application/json' };
      var tok = localStorage.getItem('hert_token');
      if (tok) headers['Authorization'] = 'Bearer ' + tok;
      var initD = getTgInitData();
      if (initD) headers['x-telegram-init-data'] = initD;
      return fetch(path, {
        method: method || 'GET',
        headers: headers,
        body: body ? JSON.stringify(body) : undefined,
      }).then(function(r) {
        return r.json().then(function(j) {
          if (!r.ok) throw new Error(j.error || 'Request failed');
          return j;
        });
      });
    }

    function loadDashboard() {
      api('/api/dashboard').then(function(d) {
        state.data = d;
        render();
      }).catch(function(e) {
        showToast(e.message);
      });
    }

    function switchTab(tab) {
      state.tab = tab;
      document.querySelectorAll('.nav-btn').forEach(function(b) {
        b.classList.toggle('active', b.getAttribute('data-tab') === tab);
      });
      render();
    }

    function render() {
      var d = state.data;
      if (!d) return;
      var u = d.user;
      document.getElementById('hdr-user').textContent = (u.firstName || 'Miner') + (u.username ? ' (@' + u.username + ')' : '');
      document.getElementById('btn-auth-modal').textContent = d.isGuest ? 'Web Login' : 'Account';

      var root = document.getElementById('view-root');
      if (state.tab === 'home') root.innerHTML = renderHome(d);
      else if (state.tab === 'tasks') root.innerHTML = renderTasks(d);
      else if (state.tab === 'checkin') root.innerHTML = renderCheckIn(d);
      else if (state.tab === 'friends') root.innerHTML = renderFriends(d);
      else if (state.tab === 'airdrop') root.innerHTML = renderAirdrop(d);
    }

    function renderHome(d) {
      var m = d.mining;
      var s = m.activeSession;
      var mineHtml = '';
      if (s) {
        mineHtml = '<div class="mine-box">' +
          '<div class="row"><span style="color:var(--green2);font-weight:800;font-size:12px;">● Mining Active (' + fmt(s.rateCentsPerHour) + ' HERT/hr)</span>' +
          '<span style="font-family:monospace;font-weight:800;color:var(--gold2);">+' + fmt(s.accruedCents) + ' HERT</span></div>' +
          '<div class="progress-track"><div class="progress-fill" style="width:' + Math.round(s.progressPercent) + '%"></div></div>' +
          '<div class="row"><span class="muted">Ends in ' + fmtTime(s.remainingMs) + '</span>' +
          (s.canClaim
            ? '<button class="btn-green" onclick="harvestMining()">Harvest Now</button>'
            : '<span class="muted">Unlock in ' + s.unlockRemainingSec + 's</span>') +
          '</div></div>';
      } else {
        mineHtml = '<div class="mine-box"><div class="row">' +
          '<div><strong style="font-size:13px;">Miner is Idle</strong><p class="muted">Rate: ' + fmt(m.effectiveRateCentsPerHour) + ' HERT/hr (4h cycle)</p></div>' +
          '<button class="btn-gold" onclick="startMining()">⛏️ Start Mining</button>' +
          '</div></div>';
      }

      return '<div class="card hero">' +
        '<div class="row"><span class="label">Total Balance</span><span class="badge">' + leagueFor(d.user.pointsCents) + '</span></div>' +
        '<div class="balance-val">' + fmt(d.user.pointsCents) + '<span class="balance-unit">HERT</span></div>' +
        mineHtml +
      '</div>' +
      '<div class="grid2">' +
        '<button class="tile" onclick="openWheelModal()">' +
          '<div class="row"><span style="font-size:20px;">✨</span><span class="badge">' + (d.luckyWheel.canSpin ? 'Free Spin' : 'Cooldown') + '</span></div>' +
          '<div style="margin-top:8px;"><strong style="font-size:13px;">Daily Lucky Wheel</strong><p class="muted">Win up to 25.00 HERT</p></div>' +
        '</button>' +
        '<button class="tile" onclick="switchTab(\\'checkin\\')">' +
          '<div class="row"><span style="font-size:20px;">📅</span><span style="color:var(--green2);font-weight:800;font-size:12px;">🔥 Day ' + d.checkIn.streakDay + '</span></div>' +
          '<div style="margin-top:8px;"><strong style="font-size:13px;">Daily Check-In</strong><p class="muted">' + (d.checkIn.canCheckIn ? 'Claim Bonus Now!' : 'Streak Active') + '</p></div>' +
        '</button>' +
      '</div>' +
      '<div class="card" style="background:linear-gradient(90deg,#0C1A14,#09120E);border-color:rgba(16,185,129,0.3);">' +
        '<div class="row">' +
          '<div><strong style="font-size:13px;">Invite Friends &nbsp;<span style="color:var(--green2);">+50.00 HERT</span></strong>' +
          '<p class="muted">' + d.referrals.invitedCount + ' friends invited so far</p></div>' +
          '<button class="btn-green" onclick="switchTab(\\'friends\\')">Invite →</button>' +
        '</div>' +
      '</div>' +
      '<div class="card" style="padding:8px 14px;">' +
        '<div class="check-row" style="cursor:pointer;" onclick="switchTab(\\'checkin\\')"><span>📅 7-Day Daily Streak Calendar</span><span class="muted">→</span></div>' +
        '<div class="check-row" style="cursor:pointer;" onclick="switchTab(\\'friends\\')"><span>👥 Referral Guild (+50.00 HERT)</span><span class="muted">→</span></div>' +
        '<div class="check-row" style="cursor:pointer;" onclick="switchTab(\\'airdrop\\')"><span>💎 TON Wallet & Airdrop Readiness</span><span class="muted">→</span></div>' +
      '</div>';
    }

    function renderTasks(d) {
      var list = d.tasks.filter(function(t) {
        if (state.taskFilter === 'social') return t.category === 'social' || t.category === 'milestone';
        if (state.taskFilter === 'partner') return t.category === 'partner';
        return true;
      });
      var doneCount = d.tasks.filter(function(t) { return t.status === 'claimed'; }).length;

      var html = '<div style="margin-bottom:12px;">' +
        '<h2 style="margin:0 0 4px;font-size:20px;">Earn HERT Rewards</h2>' +
        '<p class="muted">Complete verified community missions (' + doneCount + '/' + d.tasks.length + ' completed)</p>' +
      '</div>' +
      '<div class="pills">' +
        '<button class="pill ' + (state.taskFilter==='all'?'active':'') + '" onclick="state.taskFilter=\\'all\\';render()">All (' + d.tasks.length + ')</button>' +
        '<button class="pill ' + (state.taskFilter==='social'?'active':'') + '" onclick="state.taskFilter=\\'social\\';render()">Social & Milestones</button>' +
        '<button class="pill ' + (state.taskFilter==='partner'?'active':'') + '" onclick="state.taskFilter=\\'partner\\';render()">Partners</button>' +
      '</div>';

      list.forEach(function(t) {
        var btn = '';
        if (t.status === 'claimed') {
          btn = '<span class="badge" style="background:rgba(16,185,129,0.2);color:var(--green2);border-color:rgba(16,185,129,0.4);">✓ Claimed</span>';
        } else if (t.status === 'ready_to_claim') {
          btn = '<button class="btn-green" onclick="claimTask(\\'' + t.id + '\\')">Claim +' + fmt(t.rewardCents) + '</button>';
        } else if (t.status === 'verifying') {
          btn = '<button class="btn-dark" onclick="loadDashboard()">Verify (' + t.waitSec + 's)</button>';
        } else {
          btn = '<button class="btn-gold" onclick="startTask(\\'' + t.id + '\\')">' + (t.actionLabel || 'Start') + '</button>';
        }
        html += '<div class="task-card">' +
          '<div style="flex:1;min-width:0;">' +
            '<strong style="font-size:13px;display:block;">' + t.title + '</strong>' +
            '<p class="muted" style="font-size:11px;margin:3px 0;">' + t.description + '</p>' +
            '<span style="font-size:11px;font-weight:800;color:var(--gold2);">+' + fmt(t.rewardCents) + ' HERT</span>' +
          '</div>' +
          '<div>' + btn + '</div>' +
        '</div>';
      });
      return html;
    }

    function renderCheckIn(d) {
      var ci = d.checkIn;
      var boxes = '';
      ci.rewards.forEach(function(r, idx) {
        var dayNum = idx + 1;
        var active = dayNum === ci.streakDay;
        boxes += '<div class="day-box ' + (active ? 'active' : '') + '">' +
          '<div class="muted">Day ' + dayNum + '</div>' +
          '<strong style="color:var(--gold2);font-size:12px;">+' + fmt(r) + '</strong>' +
        '</div>';
      });
      return '<div class="card">' +
        '<div class="row"><h2 style="margin:0;font-size:18px;">Daily Check-In</h2><span class="badge">🔥 Streak Day ' + ci.streakDay + '</span></div>' +
        '<p class="muted" style="margin-top:4px;">Check in every 24h to grow your 7-day HERT reward streak.</p>' +
        '<div class="day-grid">' + boxes + '</div>' +
        (ci.canCheckIn
          ? '<button class="btn-green btn-full" onclick="claimCheckIn()">Claim Day ' + ci.streakDay + ' Reward</button>'
          : '<button class="btn-dark btn-full btn-disabled">Next Check-In in ' + fmtTime(ci.cooldownRemainingMs) + '</button>') +
      '</div>' +
      '<button class="btn-dark btn-full" onclick="switchTab(\\'home\\')">← Back to Mining Home</button>';
    }

    function renderFriends(d) {
      var r = d.referrals;
      var friendsHtml = '';
      if (!r.friends || r.friends.length === 0) {
        friendsHtml = '<p class="muted">No friends joined yet. Share your invite link to earn +50.00 HERT per referral!</p>';
      } else {
        r.friends.forEach(function(f) {
          friendsHtml += '<div class="check-row"><span><strong>' + (f.firstName || 'Miner') + '</strong>' +
            (f.username ? ' <span class="muted">@' + f.username + '</span>' : '') +
            '</span><span style="color:var(--green2);font-weight:800;">+50.00 HERT</span></div>';
        });
      }
      return '<div class="card" style="text-align:center;">' +
        '<div style="font-size:28px;">👥</div>' +
        '<h2 style="margin:6px 0;">Invite Friends & Earn</h2>' +
        '<p class="muted" style="margin-bottom:14px;">Get <strong style="color:var(--gold2);">+50.00 HERT</strong> for every friend invited + +0.50 HERT/hr mining speed boost!</p>' +
        '<button class="btn-gold btn-full" onclick="shareTg()">🚀 Share on Telegram (+50.00 HERT)</button>' +
        '<button class="btn-dark btn-full" style="margin-top:8px;" onclick="copyText(\\'' + r.telegramDeepLink + '\\', \\'Invite link copied!\\')">Copy Invite Link</button>' +
      '</div>' +
      '<div class="card">' +
        '<span class="label">Your Referral Code</span>' +
        '<div class="row" style="margin-top:6px;"><strong style="font-family:monospace;font-size:18px;">' + r.referralCode + '</strong>' +
        '<button class="btn-dark" onclick="copyText(\\'' + r.referralCode + '\\', \\'Referral code copied!\\')">Copy Code</button></div>' +
      '</div>' +
      (!d.user.referredBy ? '<div class="card"><span class="label">Have an Invite Code? (+50.00 HERT)</span><div class="row" style="margin-top:8px;">' +
        '<input id="apply-ref-input" class="input" style="margin:0;" placeholder="Enter code e.g. HERT-1234" />' +
        '<button class="btn-green" onclick="applyRef()">Apply</button></div></div>' : '') +
      '<div class="card"><strong style="font-size:14px;display:block;margin-bottom:8px;">Invited Friends (' + r.invitedCount + ')</strong>' + friendsHtml + '</div>';
    }

    function renderAirdrop(d) {
      var w = d.wallet, a = d.airdrop;
      var checksHtml = '';
      a.checklist.forEach(function(c) {
        checksHtml += '<div class="check-row"><span>' + c.label + '</span>' +
          '<span style="font-weight:800;color:' + (c.done ? 'var(--green2)' : 'var(--muted)') + ';">' + (c.done ? '✓ Ready' : 'Pending') + '</span></div>';
      });
      return '<div class="card">' +
        '<span class="label">TON Wallet Connection</span>' +
        '<p class="muted" style="margin:6px 0 12px;">Connect your non-custodial TON wallet directly to receive your airdrop allocation on TGE.</p>' +
        (w.connected
          ? '<div class="mine-box"><div class="row"><strong style="color:var(--green2);">✓ ' + (w.appName || 'TON Wallet') + ' Connected</strong>' +
            '<button class="btn-dark" onclick="disconnectWallet()">Disconnect</button></div>' +
            '<p style="font-family:monospace;font-size:12px;margin:8px 0 0;word-break:break-all;">' + w.address + '</p></div>'
          : '<div class="mine-box" style="margin-bottom:10px;"><span style="font-family:monospace;color:var(--muted);font-size:13px;">Not Connected</span></div>' +
            '<button class="btn-gold btn-full" onclick="openModal(\\'wallet-modal\\')">💎 Connect TON Wallet</button>') +
      '</div>' +
      '<div class="card hero">' +
        '<div class="row"><span class="label">Estimated Airdrop Allocation</span><span class="badge">' + a.eligibleCount + '/' + a.totalChecks + ' Eligible</span></div>' +
        '<div class="balance-val" style="font-size:28px;">' + a.estimatedTokens.toLocaleString('en-US', { minimumFractionDigits: 2 }) + '<span class="balance-unit">TOKENS</span></div>' +
        '<p class="muted">Based on your ' + fmt(d.user.pointsCents) + ' HERT mined balance</p>' +
      '</div>' +
      '<div class="card"><strong style="font-size:14px;display:block;margin-bottom:6px;">Airdrop Eligibility Checklist</strong>' + checksHtml + '</div>';
    }

    function startMining() {
      api('/api/mining/start', 'POST').then(function(d) { state.data = d; showToast('Mining started for 4 hours!'); render(); }).catch(function(e){ showToast(e.message); });
    }
    function harvestMining() {
      api('/api/mining/claim', 'POST').then(function(d) { state.data = d; showToast('Harvested +' + fmt(d.earnedCents) + ' HERT!'); render(); }).catch(function(e){ showToast(e.message); });
    }
    function claimCheckIn() {
      api('/api/checkin/claim', 'POST').then(function(d) { state.data = d; showToast('Daily Check-In +' + fmt(d.rewardCents) + ' HERT!'); render(); }).catch(function(e){ showToast(e.message); });
    }
    function startTask(id) {
      var task = state.data.tasks.find(function(x){ return x.id === id; });
      if (task && task.mode === 'milestone' && task.targetTab) { switchTab(task.targetTab); return; }
      if (task && task.actionUrl) {
        if (tg && tg.openLink && task.actionUrl.indexOf('t.me') === -1) tg.openLink(task.actionUrl);
        else if (tg && tg.openTelegramLink && task.actionUrl.indexOf('t.me') !== -1) tg.openTelegramLink(task.actionUrl);
        else window.open(task.actionUrl, '_blank');
      }
      api('/api/tasks/' + id + '/start', 'POST').then(function(d) {
        state.data = d; render();
        setTimeout(loadDashboard, 8500);
      }).catch(function(e){ showToast(e.message); });
    }
    function claimTask(id) {
      api('/api/tasks/' + id + '/claim', 'POST').then(function(d) { state.data = d; showToast('Task reward credited!'); render(); }).catch(function(e){ showToast(e.message); });
    }
    function applyRef() {
      var code = document.getElementById('apply-ref-input').value.trim();
      api('/api/referrals/apply', 'POST', { referralCode: code }).then(function(d) { state.data = d; showToast(d.message || '+50.00 HERT applied!'); render(); }).catch(function(e){ showToast(e.message); });
    }
    function shareTg() {
      var link = state.data.referrals.telegramDeepLink;
      var text = 'Join HERT Mining and get +150.00 HERT Welcome Bonus + 50.00 HERT Referral Bonus!';
      var url = 'https://t.me/share/url?url=' + encodeURIComponent(link) + '&text=' + encodeURIComponent(text);
      if (tg && tg.openTelegramLink) tg.openTelegramLink(url);
      else window.open(url, '_blank');
    }
    function copyText(txt, msg) {
      if (navigator.clipboard) navigator.clipboard.writeText(txt).catch(function(){});
      showToast(msg);
    }
    function openModal(id) { document.getElementById(id).classList.add('open'); }
    function closeModal(id) { document.getElementById(id).classList.remove('open'); }
    function openWheelModal() { document.getElementById('wheel-result').textContent = ''; openModal('wheel-modal'); }
    function spinWheel() {
      state.wheelDeg += 720 + Math.floor(Math.random() * 360);
      document.getElementById('wheel-disc').style.transform = 'rotate(' + state.wheelDeg + 'deg)';
      api('/api/lucky-spin', 'POST').then(function(d) {
        state.data = d;
        setTimeout(function() {
          document.getElementById('wheel-result').textContent = 'You won ' + d.label + '!';
          render();
        }, 900);
      }).catch(function(e) { showToast(e.message); });
    }
    function openAuthModal() { openModal('auth-modal'); }
    function setAuthMode(m) {
      state.authMode = m;
      document.getElementById('tab-login').classList.toggle('active', m === 'login');
      document.getElementById('tab-create').classList.toggle('active', m === 'create');
      document.getElementById('auth-desc').textContent = m === 'login'
        ? 'Sign in with your Telegram username or numeric ID to restore your coins.'
        : 'Set a password on your Telegram account so you can access it on Web & Mobile.';
    }
    function submitAuth() {
      var id = document.getElementById('auth-id').value.trim();
      var pwd = document.getElementById('auth-pwd').value;
      var ep = state.authMode === 'login' ? '/api/auth/login' : '/api/auth/create-password';
      api(ep, 'POST', { identifier: id, password: pwd }).then(function(res) {
        if (res.token) localStorage.setItem('hert_token', res.token);
        state.data = res.payload;
        closeModal('auth-modal');
        showToast('Account restored successfully!');
        render();
      }).catch(function(e) { showToast(e.message); });
    }
    function quickWallet(appName) {
      var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz123456789';
      var addr = 'UQ';
      for (var i = 0; i < 44; i++) addr += chars[Math.floor(Math.random() * chars.length)];
      api('/api/wallet/connect', 'POST', { address: addr, walletAppName: appName }).then(function(d) {
        state.data = d; closeModal('wallet-modal'); showToast(appName + ' connected!'); render();
      }).catch(function(e){ showToast(e.message); });
    }
    function connectManualWallet() {
      var addr = document.getElementById('wallet-addr-input').value.trim();
      api('/api/wallet/connect', 'POST', { address: addr, walletAppName: 'TON Wallet' }).then(function(d) {
        state.data = d; closeModal('wallet-modal'); showToast('TON Wallet connected!'); render();
      }).catch(function(e){ showToast(e.message); });
    }
    function disconnectWallet() {
      api('/api/wallet/disconnect', 'POST').then(function(d) {
        state.data = d; showToast('Wallet disconnected.'); render();
      }).catch(function(e){ showToast(e.message); });
    }

    setInterval(function() {
      if (state.data && state.data.mining.activeSession && state.tab === 'home') {
        var s = state.data.mining.activeSession;
        s.remainingMs = Math.max(0, s.endsAt - Date.now());
        var elapsed = Math.max(0, Date.now() - s.startedAt);
        var total = Math.max(60000, s.endsAt - s.startedAt);
        s.progressPercent = Math.min(100, (elapsed / total) * 100);
        s.accruedCents = Math.floor((s.rateCentsPerHour * (total / 3600000)) * Math.min(1, elapsed / total));
        s.canClaim = elapsed >= 60000;
        s.unlockRemainingSec = Math.max(0, Math.ceil((60000 - elapsed) / 1000));
        render();
      }
    }, 1000);

    loadDashboard();
  </script>
</body>
</html>`;

app.get('*', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(APP_HTML);
});

dbLoadPromise = initAndLoadDb();
app.listen(PORT, '0.0.0.0', () => {
  console.log(`HERT Mining Server running on http://0.0.0.0:${PORT}`);
});
