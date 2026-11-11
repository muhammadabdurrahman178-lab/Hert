import express from 'express';

const app = express();
app.use(express.json());

// Enable CORS for all API calls & Telegram WebApp
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Web-Session, X-Telegram-Init-Data');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const PORT = Number(process.env.PORT || 3000);

// --- In-Memory Database & Seed State ---
const userDatabase = new Map();

// Seed guest user with 150.00 HERT Welcome Bonus (15,000 cents)
const guestUser = {
  id: 'sandbox_guest',
  telegramId: 'sandbox_guest',
  username: 'GuestMiner',
  firstName: 'Guest Miner',
  referralCode: 'HERT-GUEST',
  referredBy: null,
  pointsCents: 15000, // 150.00 HERT Welcome Bonus
  completedCycles: 0,
  streakDay: 1,
  lastCheckIn: 0,
  completedTasks: [],
  referralFriends: [],
  totalReferralPointsCents: 0,
  activeSession: null,
  wallet: { connected: false, address: null, walletAppName: null },
  claimedAllocation: false,
};
userDatabase.set(guestUser.id, guestUser);

// Seed admin user
const adminUser = {
  id: 'user_abdurrahman2yr',
  telegramId: '984712034',
  username: 'abdurrahman2yr',
  firstName: 'Abdurrahman',
  password: 'admin_password_123',
  referralCode: 'HERT-ABDOOL',
  referredBy: null,
  pointsCents: 25000, // 250.00 HERT
  completedCycles: 5,
  streakDay: 4,
  lastCheckIn: Date.now() - 3600000,
  completedTasks: ['join_tg_channel', 'follow_x_twitter'],
  referralFriends: [
    {
      telegramId: '548912345',
      username: 'CryptoHamza',
      firstName: 'Hamza',
      pointsContributedCents: 5000,
      joinedAt: Date.now() - 86400000,
    },
  ],
  totalReferralPointsCents: 5000,
  activeSession: null,
  wallet: {
    connected: true,
    address: 'UQDF78aZ...k892',
    walletAppName: 'Tonkeeper',
  },
  claimedAllocation: false,
};
userDatabase.set(adminUser.id, adminUser);

// Snapshot storage
const adminSnapshots = [];

// Helper: Extract user
function getUserFromReq(req) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.replace('Bearer ', '').trim();
    if (userDatabase.has(token)) {
      return userDatabase.get(token);
    }
  }
  return guestUser;
}

// Format points cents to HERT
function formatPoints(cents) {
  return (cents / 100).toFixed(2);
}

// Health check endpoint (for Render / Cloud Run)
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, status: 'ok', time: Date.now() });
});

// Dynamic TON Connect Manifest with CORS
app.get('/tonconnect-manifest.json', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host = req.get('host') || 'hert-mining-backend.onrender.com';
  const origin = `${protocol}://${host}`;
  return res.json({
    url: origin,
    name: 'HERT Mining',
    iconUrl: `${origin}/hert-icon-180.png`,
    termsOfUseUrl: origin,
    privacyPolicyUrl: origin,
  });
});

// Build User Dashboard Payload
function buildDashboard(user) {
  const now = Date.now();
  let accruedCents = 0;
  let remainingMs = 0;
  let progressPercent = 0;
  let canClaim = false;

  if (user.activeSession) {
    const elapsedMs = Math.max(0, now - user.activeSession.startTime);
    const durationMs = user.activeSession.durationMs;
    const cappedElapsed = Math.min(elapsedMs, durationMs);
    remainingMs = Math.max(0, durationMs - elapsedMs);
    progressPercent = Math.min(100, Math.round((cappedElapsed / durationMs) * 100));
    accruedCents = Math.round((cappedElapsed / 3600000) * user.activeSession.rateCentsPerHour);
    canClaim = elapsedMs >= 60000;
  }

  const taskDefinitions = [
    {
      id: 'join_tg_channel',
      title: 'Follow Official HERT Community',
      description: 'Join the official HERT telegram news and announcements channel.',
      category: 'social',
      rewardCents: 3500, // 35.00 HERT
      actionUrl: 'https://t.me/hertchannels',
      actionLabel: 'Join Channel',
    },
    {
      id: 'follow_x_twitter',
      title: 'Follow on X (Twitter)',
      description: 'Follow our official X handle for updates and partnership news.',
      category: 'social',
      rewardCents: 3500, // 35.00 HERT
      actionUrl: 'https://x.com/HERTcoin',
      actionLabel: 'Follow on X',
    },
    {
      id: 'join_interlink_labs',
      title: 'Join Interlink Labs',
      description: 'Join Interlink Labs via the official invite link, then claim +25.00 HERT.',
      category: 'partner',
      rewardCents: 2500, // 25.00 HERT
      actionUrl: 'https://interlinklabs.ai/08067934296',
      actionLabel: 'Join Interlink',
    },
    {
      id: 'join_verychat',
      title: 'Join Verychat',
      description: 'Join Verychat via the official invite link, then claim +25.00 HERT.',
      category: 'partner',
      rewardCents: 2500, // 25.00 HERT
      actionUrl: 'https://invite.verychat.io/0808abdool',
      actionLabel: 'Join Verychat',
    },
    {
      id: 'link_ton_wallet',
      title: 'Connect TON Wallet',
      description: 'Link your non-custodial TON wallet directly for airdrop distribution.',
      category: 'milestone',
      rewardCents: 2000, // 20.00 HERT
      actionUrl: null,
      actionLabel: 'Connect Wallet',
    },
    {
      id: 'complete_first_cycle',
      title: 'Complete First Mining Cycle',
      description: 'Start mining and complete at least one 4-hour cycle to earn bonus HERT.',
      category: 'milestone',
      rewardCents: 1500, // 15.00 HERT
      actionUrl: null,
      actionLabel: 'Mine 1 Cycle',
    },
    {
      id: 'complete_first_checkin',
      title: 'First Daily Check-In',
      description: 'Complete at least 1 daily check-in to build streak bonuses.',
      category: 'milestone',
      rewardCents: 1500, // 15.00 HERT
      actionUrl: null,
      actionLabel: 'Daily Check-In',
    },
  ];

  const tasks = taskDefinitions.map((t) => ({
    ...t,
    status: user.completedTasks.includes(t.id) ? 'claimed' : 'available',
  }));

  return {
    user: {
      id: user.id,
      telegramId: user.telegramId,
      username: user.username,
      firstName: user.firstName,
      pointsCents: user.pointsCents,
      streakDay: user.streakDay,
      referralCode: user.referralCode,
    },
    mining: {
      isMining: Boolean(user.activeSession),
      remainingMs,
      progressPercent,
      liveAccruedCents: accruedCents,
      canClaim,
      rateCentsPerHour: 500, // 5.00 HERT/h
      cycleDurationHours: 4,
    },
    checkIn: {
      streakDay: user.streakDay,
      canCheckIn: now - user.lastCheckIn >= 12 * 3600000,
      rewardCents: 150 * user.streakDay,
    },
    referrals: {
      referralCode: user.referralCode,
      invitedCount: user.referralFriends.length,
      rewardPerFriendCents: 5000, // 50.00 HERT
      totalEarnedCents: user.totalReferralPointsCents,
      friends: user.referralFriends,
    },
    wallet: user.wallet,
    tasks,
    auth: {
      authenticated: user.id !== 'sandbox_guest',
      isAdmin: user.username && user.username.toLowerCase() === 'abdurrahman2yr',
    },
  };
}

// API: Dashboard
app.get('/api/dashboard', (req, res) => {
  const user = getUserFromReq(req);
  res.json(buildDashboard(user));
});

// API: Start Mining
app.post('/api/mining/start', (req, res) => {
  const user = getUserFromReq(req);
  if (!user.activeSession) {
    user.activeSession = {
      startTime: Date.now(),
      durationMs: 4 * 3600000,
      rateCentsPerHour: 500, // 5.00 HERT/h
    };
  }
  res.json({ ok: true, payload: buildDashboard(user) });
});

// API: Harvest Mining
app.post('/api/mining/harvest', (req, res) => {
  const user = getUserFromReq(req);
  if (user.activeSession) {
    const elapsed = Date.now() - user.activeSession.startTime;
    const capped = Math.min(elapsed, user.activeSession.durationMs);
    const earned = Math.round((capped / 3600000) * user.activeSession.rateCentsPerHour);
    user.pointsCents += earned;
    user.completedCycles += 1;
    user.activeSession = null;
  }
  res.json({ ok: true, payload: buildDashboard(user) });
});

// API: Daily Check-In
app.post('/api/checkin/claim', (req, res) => {
  const user = getUserFromReq(req);
  const reward = 150 * user.streakDay;
  user.pointsCents += reward;
  user.streakDay = user.streakDay >= 7 ? 1 : user.streakDay + 1;
  user.lastCheckIn = Date.now();
  res.json({ ok: true, payload: buildDashboard(user) });
});

// API: Lucky Wheel Spin
app.post('/api/wheel/spin', (req, res) => {
  const user = getUserFromReq(req);
  const prizes = [100, 250, 500, 1000, 2500]; // 1.00 to 25.00 HERT
  const wonCents = prizes[Math.floor(Math.random() * prizes.length)];
  user.pointsCents += wonCents;
  res.json({
    ok: true,
    prize: {
      cents: wonCents,
      label: `+${formatPoints(wonCents)} HERT`,
    },
    payload: buildDashboard(user),
  });
});

// API: Claim Task
app.post('/api/tasks/:id/claim', (req, res) => {
  const user = getUserFromReq(req);
  const taskId = req.params.id;
  const rewardMap = {
    join_tg_channel: 3500,
    follow_x_twitter: 3500,
    join_interlink_labs: 2500,
    join_verychat: 2500,
    link_ton_wallet: 2000,
    complete_first_cycle: 1500,
    complete_first_checkin: 1500,
  };
  if (!user.completedTasks.includes(taskId)) {
    user.completedTasks.push(taskId);
    user.pointsCents += rewardMap[taskId] || 1500;
  }
  res.json({ ok: true, payload: buildDashboard(user) });
});

// API: Wallet Connect
app.post('/api/wallet/connect', (req, res) => {
  const user = getUserFromReq(req);
  const { address, walletAppName } = req.body || {};
  user.wallet = {
    connected: true,
    address: address || 'UQDF78aZ...k892',
    walletAppName: walletAppName || 'TON Wallet',
  };
  if (!user.completedTasks.includes('link_ton_wallet')) {
    user.completedTasks.push('link_ton_wallet');
    user.pointsCents += 2000; // 20.00 HERT
  }
  res.json({ ok: true, payload: buildDashboard(user) });
});

// API: Apply Referral Code
app.post('/api/referrals/apply', (req, res) => {
  const user = getUserFromReq(req);
  const { code } = req.body || {};
  if (!user.referredBy) {
    user.referredBy = code || 'HERT-FRIEND';
    user.pointsCents += 5000; // +50.00 HERT
  }
  res.json({ ok: true, payload: buildDashboard(user) });
});

// API: Telegram Password Create / Login
app.post('/api/auth/telegram-create-password', (req, res) => {
  const { telegramUsername, password, firstName } = req.body || {};
  const clean = String(telegramUsername || '').trim().replace(/^@/, '');
  const id = `user_${clean}`;
  let user = userDatabase.get(id);
  if (!user) {
    user = {
      id,
      telegramId: clean,
      username: clean,
      firstName: firstName || clean,
      password: String(password || ''),
      referralCode: `HERT-${clean.toUpperCase()}`,
      referredBy: null,
      pointsCents: 15000, // 150.00 HERT Welcome Bonus
      completedCycles: 0,
      streakDay: 1,
      lastCheckIn: 0,
      completedTasks: [],
      referralFriends: [],
      totalReferralPointsCents: 0,
      activeSession: null,
      wallet: { connected: false, address: null, walletAppName: null },
      claimedAllocation: false,
    };
    userDatabase.set(id, user);
  } else {
    user.password = String(password || '');
  }
  res.json({ ok: true, token: user.id, payload: buildDashboard(user) });
});

// API: Web Login
app.post('/api/auth/web-login', (req, res) => {
  const { identifier, password } = req.body || {};
  const clean = String(identifier || '').trim().replace(/^@/, '');
  const id = `user_${clean}`;
  let user = userDatabase.get(id);
  if (!user) {
    user = {
      id,
      telegramId: clean,
      username: clean,
      firstName: clean,
      password: String(password || ''),
      referralCode: `HERT-${clean.toUpperCase()}`,
      referredBy: null,
      pointsCents: 15000,
      completedCycles: 0,
      streakDay: 1,
      lastCheckIn: 0,
      completedTasks: [],
      referralFriends: [],
      totalReferralPointsCents: 0,
      activeSession: null,
      wallet: { connected: false, address: null, walletAppName: null },
      claimedAllocation: false,
    };
    userDatabase.set(id, user);
  }
  res.json({ ok: true, token: user.id, payload: buildDashboard(user) });
});

// API: Admin Snapshots
app.post('/api/admin/snapshot', (req, res) => {
  const { title } = req.body || {};
  const allUsers = Array.from(userDatabase.values());
  const entries = allUsers.map((u) => {
    const eligible = Boolean(u.wallet.connected && u.pointsCents >= 5000);
    return {
      telegramId: u.telegramId,
      username: u.username,
      firstName: u.firstName,
      walletAddress: u.wallet.address,
      pointsCents: u.pointsCents,
      pointsDisplay: `${formatPoints(u.pointsCents)} HERT`,
      eligible,
      allocatedTokens: eligible ? Math.floor(u.pointsCents / 100) : 0,
    };
  });
  const eligibleUsers = entries.filter((e) => e.eligible).length;
  const snap = {
    id: `snap_${Date.now()}`,
    title: title || `Snapshot #${adminSnapshots.length + 1}`,
    timestamp: Date.now(),
    totalUsers: allUsers.length,
    eligibleUsers,
    totalPointsCents: allUsers.reduce((sum, u) => sum + u.pointsCents, 0),
    totalEstimatedTokens: entries.reduce((sum, e) => sum + e.allocatedTokens, 0),
    entries,
  };
  adminSnapshots.unshift(snap);
  res.json({
    ok: true,
    snapshot: snap,
    message: `Snapshot "${snap.title}" generated successfully with ${eligibleUsers} eligible addresses!`,
  });
});

app.get('/api/admin/snapshots', (_req, res) => {
  res.json({ ok: true, snapshots: adminSnapshots });
});

app.get('/api/admin/dashboard', (_req, res) => {
  const allUsers = Array.from(userDatabase.values());
  res.json({
    ok: true,
    stats: {
      totalUsersCount: allUsers.length,
      activeMiners24hCount: allUsers.filter((u) => Boolean(u.activeSession)).length,
      totalPointsMinedCents: allUsers.reduce((s, u) => s + u.pointsCents, 0),
      totalTonWalletsConnectedCount: allUsers.filter((u) => u.wallet.connected).length,
      claimedAllocationsCount: allUsers.filter((u) => u.claimedAllocation).length,
      totalGasFeeNanoton: '0',
    },
    snapshots: adminSnapshots,
    pendingTaskClaims: [],
    recentUsers: allUsers.slice(0, 10).map((u) => ({
      telegramId: u.telegramId,
      username: u.username,
      firstName: u.firstName,
      pointsCents: u.pointsCents,
      streakDay: u.streakDay,
      walletAddress: u.wallet.address,
      joinedAt: Date.now() - 3600000,
      lastActiveAt: Date.now(),
    })),
  });
});

// --- High-Performance Single-Page WebApp Server ---
app.get('*', (_req, res) => {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
  <title>HERT Mining</title>
  <script src="https://telegram.org/js/telegram-web-app.js"></script>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@500;700&family=Outfit:wght@600;700;800&family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
    body {
      margin: 0; padding: 0; background-color: #000000; color: #F3F5F4;
      font-family: 'Plus Jakarta Sans', system-ui, sans-serif;
      overflow-x: hidden; min-height: 100vh;
    }
    .font-mono { font-family: 'JetBrains Mono', monospace; }
    .font-display { font-family: 'Outfit', sans-serif; }
    .gold-gradient { background: linear-gradient(135deg, #E5C158 0%, #D4AF37 50%, #A88420 100%); }
    .gold-border { border: 1px solid rgba(212, 175, 55, 0.35); }
    .btn-gold {
      background: #D4AF37; color: #050807; font-weight: 700; border: none;
      border-radius: 14px; padding: 12px 18px; cursor: pointer; transition: 0.15s;
    }
    .btn-gold:active { transform: scale(0.97); }
    .card { background: #0A0E0C; border: 1px solid rgba(255,255,255,0.08); border-radius: 20px; padding: 16px; margin-bottom: 12px; }
    .nav-bar {
      position: fixed; bottom: 0; left: 0; right: 0; background: rgba(7, 10, 9, 0.95);
      backdrop-filter: blur(12px); border-top: 1px solid rgba(255,255,255,0.08);
      display: flex; justify-content: space-around; padding: 8px 4px 16px; z-index: 40;
    }
    .nav-item {
      display: flex; flex-direction: column; align-items: center; gap: 4px;
      font-size: 10px; font-weight: 600; color: #8E9D96; cursor: pointer; border: none; background: none;
    }
    .nav-item.active { color: #E5C158; }
    .spin-btn {
      width: 44px; height: 44px; border-radius: 50%; background: #D4AF37;
      display: flex; align-items: center; justify-content: center; color: #050807;
      box-shadow: 0 4px 14px rgba(212,175,55,0.4); border: none; margin-top: -12px; cursor: pointer;
    }
    .modal {
      position: fixed; inset: 0; background: rgba(0,0,0,0.85); backdrop-filter: blur(8px);
      display: none; align-items: center; justify-content: center; z-index: 50; padding: 16px;
    }
    .modal.open { display: flex; }
    .modal-content {
      background: #0A0E0C; border: 1px solid rgba(212,175,55,0.4); border-radius: 24px;
      padding: 24px; width: 100%; max-width: 400px; max-height: 90vh; overflow-y: auto;
    }
    .toast {
      position: fixed; top: 16px; left: 50%; transform: translateX(-50%);
      background: #16140D; border: 1px solid rgba(212,175,55,0.5); color: #F6E2A8;
      padding: 10px 18px; border-radius: 16px; font-size: 12px; font-weight: 600;
      box-shadow: 0 8px 24px rgba(0,0,0,0.6); z-index: 60; display: none;
    }
  </style>
</head>
<body>
  <div id="toast" class="toast"></div>

  <!-- Header -->
  <header style="padding: 14px 16px; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid rgba(255,255,255,0.06);">
    <div style="display: flex; align-items: center; gap: 10px;">
      <div style="width: 34px; height: 34px; border-radius: 10px; background: #16140D; border: 1px solid rgba(212,175,55,0.5); display: flex; align-items: center; justify-content: center; font-weight: 800; color: #E5C158; font-family: monospace;">H</div>
      <div>
        <div style="display: flex; align-items: center; gap: 6px;">
          <span style="font-weight: 800; font-size: 14px; letter-spacing: -0.02em;">HERT</span>
          <span style="font-size: 10px; background: rgba(212,175,55,0.15); color: #E5C158; border: 1px solid rgba(212,175,55,0.3); padding: 1px 6px; border-radius: 6px; font-weight: 700;">v2.0</span>
        </div>
        <div id="userHandle" style="font-size: 11px; color: #8E9D96;">Guest Miner</div>
      </div>
    </div>
    <button onclick="openModal('loginModal')" style="display: flex; align-items: center; gap: 6px; border-radius: 20px; border: 1px solid rgba(212,175,55,0.4); background: #16140D; color: #E5C158; padding: 6px 12px; font-size: 11px; font-weight: 700; cursor: pointer;">
      <span>🌐 Web Login</span>
    </button>
  </header>

  <!-- Main Container -->
  <main id="appContent" style="padding: 16px 16px 90px; max-width: 480px; margin: 0 auto;">
    <!-- TAB 1: MINE (HOME) -->
    <div id="tab-mine">
      <!-- Balance Card -->
      <div class="card" style="border: 1px solid rgba(212,175,55,0.35); background: linear-gradient(180deg, #101713 0%, #080C0A 100%);">
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <span style="font-size: 11px; font-weight: 700; color: #8E9D96; text-transform: uppercase;">Total Balance</span>
          <span style="font-size: 11px; font-weight: 700; color: #CD7F32; background: #261A10; border: 1px solid rgba(205,127,50,0.5); padding: 3px 8px; border-radius: 12px;">🛡️ Bronze Miner</span>
        </div>
        <div style="margin-top: 10px; display: flex; align-items: baseline; gap: 8px;">
          <h1 id="balanceText" class="font-mono" style="font-size: 38px; font-weight: 800; margin: 0; color: #F3F5F4;">150.00</h1>
          <span style="font-size: 13px; font-weight: 800; color: #D4AF37;">HERT</span>
        </div>
        <div style="margin-top: 14px; background: rgba(7,10,9,0.8); border: 1px solid rgba(255,255,255,0.06); border-radius: 16px; padding: 12px;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <div>
              <div id="miningStatusTitle" style="font-size: 12px; font-weight: 700;">Miner is Idle</div>
              <div id="miningRateText" style="font-size: 11px; color: #8E9D96;">Rate: 5.00 HERT/hr (4h cycle)</div>
            </div>
            <button id="miningBtn" onclick="toggleMining()" class="btn-gold" style="padding: 8px 16px; font-size: 12px;">
              ⛏️ Start Mining
            </button>
          </div>
          <div id="miningProgressBox" style="margin-top: 10px; display: none;">
            <div style="height: 6px; background: rgba(255,255,255,0.08); border-radius: 10px; overflow: hidden;">
              <div id="miningBar" style="height: 100%; width: 0%; background: linear-gradient(90deg, #10B981, #D4AF37);"></div>
            </div>
            <div style="display: flex; justify-content: space-between; font-size: 10px; color: #8E9D96; margin-top: 6px;">
              <span id="miningTimer">4h 00m</span>
              <span id="liveAccruedText" style="color: #E5C158; font-weight: 700;">+0.00 HERT</span>
            </div>
          </div>
        </div>
      </div>

      <!-- Quick Action Cards (Wheel & CheckIn) -->
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 12px;">
        <div class="card" onclick="openModal('wheelModal')" style="cursor: pointer; margin-bottom: 0;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span style="font-size: 18px;">✨</span>
            <span style="font-size: 10px; font-weight: 700; color: #E5C158; background: #221B0A; padding: 2px 6px; border-radius: 8px;">Free Spin</span>
          </div>
          <div style="font-size: 13px; font-weight: 700; margin-top: 8px;">Daily Lucky Wheel</div>
          <div style="font-size: 10px; color: #8E9D96; margin-top: 2px;">Win up to 25.00 HERT</div>
        </div>
        <div class="card" onclick="claimCheckIn()" style="cursor: pointer; margin-bottom: 0;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span style="font-size: 18px;">📅</span>
            <span id="streakBadge" style="font-size: 10px; font-weight: 700; color: #34D399; background: #0E241B; padding: 2px 6px; border-radius: 8px;">🔥 Day 1</span>
          </div>
          <div style="font-size: 13px; font-weight: 700; margin-top: 8px;">Daily Check-In</div>
          <div id="checkInSub" style="font-size: 10px; color: #8E9D96; margin-top: 2px;">Claim Bonus Now!</div>
        </div>
      </div>

      <!-- Featured Quests Header -->
      <div style="display: flex; justify-content: space-between; align-items: center; margin: 16px 0 10px;">
        <span style="font-size: 13px; font-weight: 700; color: #F3F5F4;">Featured Quests & Missions</span>
        <button onclick="switchTab('tasks')" style="background: none; border: none; color: #E5C158; font-size: 11px; font-weight: 700; cursor: pointer;">All Tasks →</button>
      </div>

      <!-- Tasks List Preview -->
      <div id="tasksListPreview"></div>
    </div>

    <!-- TAB 2: TASKS -->
    <div id="tab-tasks" style="display: none;">
      <h2 style="font-size: 18px; font-weight: 800; margin: 0 0 4px;">Earn HERT Rewards</h2>
      <p style="font-size: 11px; color: #8E9D96; margin: 0 0 16px;">Complete verified community missions and boost your airdrop allocation.</p>
      <div id="allTasksList"></div>
    </div>

    <!-- TAB 3: FRIENDS -->
    <div id="tab-friends" style="display: none;">
      <div class="card" style="border: 1px solid rgba(212,175,55,0.4); background: linear-gradient(180deg, #16140D 0%, #0A0E0C 100%); text-align: center; padding: 22px 16px;">
        <div style="font-size: 32px;">👥</div>
        <h2 style="font-size: 18px; font-weight: 800; margin: 8px 0 4px;">Invite Friends & Earn</h2>
        <p style="font-size: 12px; color: #D6DFDA; margin: 0 0 16px;">Get <strong style="color: #E5C158;">+50.00 HERT</strong> for each friend invited + 10% commission on their mining!</p>
        <button onclick="shareTelegramInvite()" class="btn-gold" style="width: 100%; font-size: 13px; padding: 12px;">
          🚀 Share on Telegram (+50.00 HERT)
        </button>
      </div>
      <div class="card">
        <span style="font-size: 11px; font-weight: 700; color: #8E9D96;">Your Referral Code</span>
        <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 6px;">
          <span id="refCodeText" class="font-mono" style="font-size: 16px; font-weight: 800; color: #F3F5F4;">HERT-GUEST</span>
          <button onclick="copyRefCode()" style="background: rgba(255,255,255,0.08); border: none; border-radius: 8px; color: #E5C158; padding: 6px 12px; font-size: 11px; font-weight: 700; cursor: pointer;">Copy Code</button>
        </div>
      </div>
      <div class="card">
        <span style="font-size: 12px; font-weight: 700;">Invited Friends (<span id="invitedCount">0</span>)</span>
        <div id="friendsList" style="margin-top: 10px; font-size: 11px; color: #8E9D96;">No friends joined yet. Share your link to start earning!</div>
      </div>
    </div>

    <!-- TAB 4: WALLET / AIRDROP -->
    <div id="tab-wallet" style="display: none;">
      <div class="card" style="border: 1px solid rgba(212,175,55,0.4); padding: 20px 16px;">
        <span style="font-size: 11px; font-weight: 700; color: #8E9D96; text-transform: uppercase;">TON Wallet Connection</span>
        <p style="font-size: 11px; color: #8E9D96; margin: 6px 0 14px;">Connect your non-custodial TON wallet directly to receive your airdrop allocation on Token Generation Event (TGE).</p>
        <div id="walletStatusBox" style="background: rgba(7,10,9,0.8); border: 1px solid rgba(255,255,255,0.08); border-radius: 14px; padding: 12px; margin-bottom: 14px;">
          <div id="walletAddrText" style="font-size: 12px; font-family: monospace; color: #8E9D96;">Not Connected</div>
        </div>
        <button id="connectWalletBtn" onclick="connectTonWallet()" class="btn-gold" style="width: 100%; font-size: 13px;">
          💎 Connect TON Wallet
        </button>
      </div>
    </div>

    <!-- ADMIN DASHBOARD (Hidden unless opened via /#admin) -->
    <div id="tab-admin" style="display: none;">
      <div class="card" style="border: 1px solid rgba(212,175,55,0.6); background: #0E1410;">
        <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid rgba(255,255,255,0.08); padding-bottom: 10px;">
          <span style="font-weight: 800; font-size: 15px; color: #E5C158;">🛡️ Administrator Hub</span>
          <button onclick="switchTab('mine')" style="background: rgba(255,255,255,0.08); border: none; color: #8E9D96; border-radius: 8px; padding: 4px 10px; font-size: 11px; cursor: pointer;">Close</button>
        </div>
        <p style="font-size: 11px; color: #8E9D96; margin: 10px 0;">Take on-chain airdrop snapshots of user balances and export allocation datasets.</p>
        <button onclick="takeSnapshot()" class="btn-gold" style="width: 100%; font-size: 12px; padding: 10px; margin-bottom: 12px;">
          📸 Take Live Airdrop Snapshot
        </button>
        <div id="snapshotResultBox" style="font-size: 11px; color: #34D399;"></div>
      </div>
    </div>
  </main>

  <!-- Telegram Bottom Nav Bar -->
  <nav class="nav-bar">
    <button class="nav-item active" onclick="switchTab('mine')">
      <span style="font-size: 18px;">⛏️</span><span>Mine</span>
    </button>
    <button class="nav-item" onclick="switchTab('tasks')">
      <span style="font-size: 18px;">📋</span><span>Tasks</span>
    </button>
    <button class="spin-btn" onclick="openModal('wheelModal')">
      <span style="font-size: 20px;">✨</span>
    </button>
    <button class="nav-item" onclick="switchTab('friends')">
      <span style="font-size: 18px;">👥</span><span>Friends</span>
    </button>
    <button class="nav-item" onclick="switchTab('wallet')">
      <span style="font-size: 18px;">💎</span><span>Airdrop</span>
    </button>
  </nav>

  <!-- MODAL: Lucky Wheel -->
  <div id="wheelModal" class="modal">
    <div class="modal-content" style="text-align: center;">
      <h3 style="font-size: 18px; font-weight: 800; margin: 0 0 6px;">Daily Lucky Wheel</h3>
      <p style="font-size: 11px; color: #8E9D96; margin: 0 0 16px;">Spin the wheel to win up to 25.00 HERT bonus coins!</p>
      <div id="wheelWheel" style="width: 160px; height: 160px; margin: 0 auto 18px; border-radius: 50%; border: 4px solid #D4AF37; display: flex; align-items: center; justify-content: center; font-size: 28px; background: #16140D; transition: transform 2.5s cubic-bezier(0.15, 0.9, 0.2, 1);">
        🎁
      </div>
      <button id="spinActionBtn" onclick="executeSpin()" class="btn-gold" style="width: 100%; font-size: 13px;">
        Spin Wheel Now
      </button>
      <button onclick="closeModal('wheelModal')" style="width: 100%; margin-top: 8px; background: none; border: none; color: #8E9D96; font-size: 11px; cursor: pointer;">Close</button>
    </div>
  </div>

  <!-- MODAL: Web Login -->
  <div id="loginModal" class="modal">
    <div class="modal-content">
      <h3 style="font-size: 16px; font-weight: 800; margin: 0 0 6px;">Sign In or Create Password</h3>
      <p style="font-size: 11px; color: #8E9D96; margin: 0 0 14px;">Connect Telegram username and password to sync coins across devices.</p>
      <input id="loginUser" placeholder="Telegram Username (e.g. @Abdurrahman2yr)" style="width: 100%; background: #070A09; border: 1px solid rgba(255,255,255,0.12); color: #F3F5F4; border-radius: 12px; padding: 10px; font-size: 12px; margin-bottom: 8px;">
      <input id="loginPass" type="password" placeholder="Password (min. 6 characters)" style="width: 100%; background: #070A09; border: 1px solid rgba(255,255,255,0.12); color: #F3F5F4; border-radius: 12px; padding: 10px; font-size: 12px; margin-bottom: 14px;">
      <button onclick="submitTelegramLogin()" class="btn-gold" style="width: 100%; font-size: 12px;">Sign In & Connect</button>
      <button onclick="closeModal('loginModal')" style="width: 100%; margin-top: 8px; background: none; border: none; color: #8E9D96; font-size: 11px; cursor: pointer;">Cancel</button>
    </div>
  </div>

  <script>
    let currentData = null;

    // Toast helper
    function showToast(msg) {
      const el = document.getElementById('toast');
      el.textContent = msg;
      el.style.display = 'block';
      setTimeout(() => { el.style.display = 'none'; }, 3500);
    }

    // Modal helpers
    function openModal(id) { document.getElementById(id).classList.add('open'); }
    function closeModal(id) { document.getElementById(id).classList.remove('open'); }

    // Tab Navigation
    function switchTab(tab) {
      ['mine', 'tasks', 'friends', 'wallet', 'admin'].forEach(t => {
        const el = document.getElementById('tab-' + t);
        if (el) el.style.display = (t === tab) ? 'block' : 'none';
      });
      document.querySelectorAll('.nav-item').forEach((btn, idx) => {
        const tabs = ['mine', 'tasks', '', 'friends', 'wallet'];
        if (tabs[idx] === tab) btn.classList.add('active');
        else btn.classList.remove('active');
      });
      if (tab === 'admin') window.location.hash = 'admin';
      else if (window.location.hash === '#admin') window.location.hash = '';
    }

    // Telegram Init
    if (window.Telegram && window.Telegram.WebApp) {
      try {
        window.Telegram.WebApp.ready();
        window.Telegram.WebApp.expand();
      } catch(e) {}
    }

    // Fetch live dashboard
    async function fetchDashboard() {
      try {
        const token = localStorage.getItem('hert_token') || '';
        const res = await fetch('/api/dashboard', {
          headers: token ? { 'Authorization': 'Bearer ' + token } : {}
        });
        const data = await res.json();
        currentData = data;
        renderDashboard(data);
      } catch(e) {
        console.error('Fetch error:', e);
      }
    }

    // Render Dashboard UI
    function renderDashboard(data) {
      document.getElementById('balanceText').textContent = (data.user.pointsCents / 100).toFixed(2);
      document.getElementById('userHandle').textContent = data.user.username ? '@' + data.user.username : data.user.firstName;
      document.getElementById('refCodeText').textContent = data.referrals.referralCode;
      document.getElementById('invitedCount').textContent = data.referrals.invitedCount;
      document.getElementById('streakBadge').textContent = '🔥 Day ' + data.checkIn.streakDay;

      // Wallet status
      if (data.wallet.connected) {
        document.getElementById('walletAddrText').textContent = '✅ ' + data.wallet.address;
        document.getElementById('connectWalletBtn').textContent = 'Connected (' + (data.wallet.walletAppName || 'TON') + ')';
      }

      // Render tasks
      const tasksPreview = document.getElementById('tasksListPreview');
      const allTasks = document.getElementById('allTasksList');
      let tasksHtml = '';
      data.tasks.forEach(t => {
        const isClaimed = t.status === 'claimed';
        tasksHtml += `
          <div class="card" style="display: flex; justify-content: space-between; align-items: center;">
            <div style="flex: 1; min-width: 0; padding-right: 10px;">
              <div style="font-size: 13px; font-weight: 700;">\${t.title}</div>
              <div style="font-size: 11px; color: #8E9D96; margin-top: 2px;">\${t.description}</div>
            </div>
            <div style="display: flex; flex-direction: column; align-items: flex-end; gap: 4px;">
              <span style="font-size: 11px; font-weight: 700; color: #E5C158;">+\${(t.rewardCents/100).toFixed(2)} HERT</span>
              <button onclick="claimTask('\${t.id}', '\${t.actionUrl || ''}')" \${isClaimed ? 'disabled' : ''} style="border: none; border-radius: 10px; padding: 6px 12px; font-size: 11px; font-weight: 700; cursor: pointer; background: \${isClaimed ? 'rgba(255,255,255,0.08)' : '#D4AF37'}; color: \${isClaimed ? '#8E9D96' : '#050807'};">
                \${isClaimed ? 'Claimed' : (t.actionLabel || 'Claim')}
              </button>
            </div>
          </div>
        `;
      });
      tasksPreview.innerHTML = tasksHtml;
      allTasks.innerHTML = tasksHtml;

      // Mining state
      updateMiningDisplay(data.mining);
    }

    function updateMiningDisplay(mining) {
      const btn = document.getElementById('miningBtn');
      const box = document.getElementById('miningProgressBox');
      const title = document.getElementById('miningStatusTitle');
      const timer = document.getElementById('miningTimer');
      const liveAccrued = document.getElementById('liveAccruedText');
      const bar = document.getElementById('miningBar');

      if (mining.isMining) {
        title.textContent = 'Mining Active';
        title.style.color = '#34D399';
        box.style.display = 'block';
        bar.style.width = mining.progressPercent + '%';
        liveAccrued.textContent = '+' + (mining.liveAccruedCents / 100).toFixed(2) + ' HERT';
        
        const mins = Math.floor(mining.remainingMs / 60000);
        const hrs = Math.floor(mins / 60);
        timer.textContent = `${hrs}h ${mins % 60}m`;

        if (mining.canClaim) {
          btn.textContent = 'Harvest Coins';
          btn.onclick = harvestMining;
        } else {
          btn.textContent = 'Mining...';
          btn.onclick = null;
        }
      } else {
        title.textContent = 'Miner is Idle';
        title.style.color = '#F3F5F4';
        box.style.display = 'none';
        btn.textContent = '⛏️ Start Mining';
        btn.onclick = startMining;
      }
    }

    // Actions
    async function startMining() {
      const token = localStorage.getItem('hert_token') || '';
      const res = await fetch('/api/mining/start', {
        method: 'POST',
        headers: token ? { 'Authorization': 'Bearer ' + token } : {}
      });
      const data = await res.json();
      renderDashboard(data.payload);
      showToast('Mining session started (5.00 HERT/h)!');
    }

    async function harvestMining() {
      const token = localStorage.getItem('hert_token') || '';
      const res = await fetch('/api/mining/harvest', {
        method: 'POST',
        headers: token ? { 'Authorization': 'Bearer ' + token } : {}
      });
      const data = await res.json();
      renderDashboard(data.payload);
      showToast('HERT coins successfully harvested into your balance!');
    }

    async function claimCheckIn() {
      const token = localStorage.getItem('hert_token') || '';
      const res = await fetch('/api/checkin/claim', {
        method: 'POST',
        headers: token ? { 'Authorization': 'Bearer ' + token } : {}
      });
      const data = await res.json();
      renderDashboard(data.payload);
      showToast('Daily check-in claimed!');
    }

    async function executeSpin() {
      const btn = document.getElementById('spinActionBtn');
      const wheel = document.getElementById('wheelWheel');
      btn.disabled = true;
      wheel.style.transform = 'rotate(' + (1440 + Math.floor(Math.random() * 360)) + 'deg)';
      setTimeout(async () => {
        const token = localStorage.getItem('hert_token') || '';
        const res = await fetch('/api/wheel/spin', {
          method: 'POST',
          headers: token ? { 'Authorization': 'Bearer ' + token } : {}
        });
        const data = await res.json();
        renderDashboard(data.payload);
        showToast('Won ' + data.prize.label + '! Balance updated.');
        btn.disabled = false;
        closeModal('wheelModal');
      }, 2600);
    }

    async function claimTask(taskId, actionUrl) {
      if (actionUrl) {
        if (window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.openLink) {
          window.Telegram.WebApp.openLink(actionUrl);
        } else {
          window.open(actionUrl, '_blank');
        }
      }
      setTimeout(async () => {
        const token = localStorage.getItem('hert_token') || '';
        const res = await fetch('/api/tasks/' + taskId + '/claim', {
          method: 'POST',
          headers: token ? { 'Authorization': 'Bearer ' + token } : {}
        });
        const data = await res.json();
        renderDashboard(data.payload);
        showToast('Task reward claimed!');
      }, 1000);
    }

    async function connectTonWallet() {
      const addr = 'UQ' + Math.random().toString(36).substring(2, 10).toUpperCase() + '...' + Math.random().toString(36).substring(2, 6).toUpperCase();
      const token = localStorage.getItem('hert_token') || '';
      const res = await fetch('/api/wallet/connect', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { 'Authorization': 'Bearer ' + token } : {})
        },
        body: JSON.stringify({ address: addr, walletAppName: 'Tonkeeper' })
      });
      const data = await res.json();
      renderDashboard(data.payload);
      showToast('TON Wallet connected: ' + addr);
    }

    async function submitTelegramLogin() {
      const user = document.getElementById('loginUser').value.trim();
      const pass = document.getElementById('loginPass').value.trim();
      if (!user || pass.length < 6) {
        showToast('Enter valid username and password (min. 6 chars)');
        return;
      }
      const res = await fetch('/api/auth/telegram-create-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ telegramUsername: user, password: pass })
      });
      const data = await res.json();
      if (data.token) {
        localStorage.setItem('hert_token', data.token);
        renderDashboard(data.payload);
        showToast('Logged in as ' + user + ' (+150 HERT welcome bonus)!');
        closeModal('loginModal');
      }
    }

    function shareTelegramInvite() {
      const code = currentData?.referrals?.referralCode || 'HERT-GUEST';
      const url = 'https://t.me/share/url?url=' + encodeURIComponent('https://t.me/HERTCoinBot?start=' + code) + '&text=' + encodeURIComponent('Mine HERT points with me on Telegram! Use my invite code: ' + code + ' to get +50.00 HERT bonus.');
      if (window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.openTelegramLink) {
        window.Telegram.WebApp.openTelegramLink(url);
      } else {
        window.open(url, '_blank');
      }
    }

    function copyRefCode() {
      const code = currentData?.referrals?.referralCode || 'HERT-GUEST';
      navigator.clipboard.writeText(code);
      showToast('Referral code copied: ' + code);
    }

    async function takeSnapshot() {
      const res = await fetch('/api/admin/snapshot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Manual Snapshot ' + new Date().toLocaleTimeString() })
      });
      const data = await res.json();
      document.getElementById('snapshotResultBox').textContent = data.message;
      showToast('Airdrop snapshot created!');
    }

    // Check hash for #admin
    if (window.location.hash === '#admin') {
      switchTab('admin');
    }

    // Initial load
    fetchDashboard();
    setInterval(fetchDashboard, 15000);
  </script>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

// Start Server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`HERT Mining Server running on http://0.0.0.0:${PORT}`);
});
