"use strict";

/*
============================================================
ALBERTO MARKETPLACE TOKEN (AMT)
PI TESTNET BACKEND
FULL SERVER VERSION 2.3.3

IMPORTANT:
- TESTNET ONLY
- AMT application ledger wallet only
- Generated AMT- address is NOT a Pi/Stellar blockchain wallet
- Pi authentication is verified server-side
- Mining rewards are application-ledger accounting
- Airdrop is application-ledger accounting
- AMT transfers are application-ledger accounting
- Staking is application-ledger accounting
- Marketplace payments use Pi Testnet Payments API
- NO MAINNET VALUE IS CLAIMED

VERSION 2.3.3:
- Preserved all existing Pioneer records
- Preserved all existing AMT balances
- Preserved all existing mining sessions
- Preserved all existing ledger history
- Preserved reward/mining/staking logic
- Added verified Pi Testnet wallet address to auth response
- Added verified Pi Testnet wallet address to profile response
- Added verified Pi Testnet wallet address to wallet response
- AMT ledger address remains separate from Pi wallet address
- FIXED: Explicitly return referralCode (= username) for every Pioneer
  in /api/auth/verify, /api/profile, /api/wallet, and /api/referral/status
- CHANGED: Default airdrop amount from 1 AMT to 100 AMT
- CHANGED: Airdrop is ONE-TIME only
- CHANGED: Global 48-hour wait for EVERYONE (new and old users) before claim
- CHANGED: New airdrop campaign AMT100_V2 (old 1 AMT claims no longer block new claim)
- FIXED: Profile picture size limit increased to ~2MB
- ADDED: Tier system (Bronze → Silver → Gold → Platinum → Diamond → Legend)
- FIXED: Multiple referral field names for frontend compatibility (code, referralCode, inviteCode, referralLink, etc.)
- ADDED: Real Daily Spin API (/api/spin/status, /api/spin/claim) — 3 spins/day, weighted prizes, 1000 jackpot
- FIXED: Spin claim SQL — removed invalid FOR UPDATE on COUNT (was causing "Unable to claim spin reward")
- ADDED: Full Pets system — skills, hunger, food/water shop, one-click feed-all, outpost war, battle, train, breed
============================================================
*/

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();

/* =========================================================
CONFIGURATION
========================================================= */

const PORT = Number(process.env.PORT || 10000);

const PI_API_BASE =
  process.env.PI_API_BASE ||
  "https://api.minepi.com";

const PI_API_KEY =
  process.env.PI_API_KEY || "";

const DATABASE_URL =
  process.env.DATABASE_URL || "";

const AMT_MINING_RATE = Number(
  process.env.AMT_MINING_RATE || "0.01"
);

const MINING_DURATION_SECONDS =
  24 * 60 * 60;

const MAXIMUM_BASE_REWARD = Number(
  (AMT_MINING_RATE * 24).toFixed(8)
);

const AIRDROP_AMOUNT_AMT = Number(
  process.env.AIRDROP_AMOUNT_AMT || "100"
);

// New airdrop campaign ID (old 1 AMT claims will be ignored)
const AIRDROP_CAMPAIGN = process.env.AIRDROP_CAMPAIGN || "AMT100_V2";

/*
  Global airdrop unlock time.
  Everyone (new or old users) must wait until this time before they can claim.
  Default: 48 hours from when the server first starts with this version.
  You can override with env: AIRDROP_UNLOCK_AT=2026-09-19T15:14:00.000Z
*/
const AIRDROP_UNLOCK_AT = process.env.AIRDROP_UNLOCK_AT
  ? new Date(process.env.AIRDROP_UNLOCK_AT)
  : new Date(Date.now() + (48 * 60 * 60 * 1000));

const MAX_DIRECT_REFERRALS = null;

const MAX_SECURITY_CIRCLE = 5;

/* =========================================================
TIER SYSTEM (Bronze → Legend)
Based on number of direct referrals
========================================================= */

const TIER_LEVELS = [
  { id: "BRONZE",   name: "Bronze",   minReferrals: 0,   color: "#CD7F32" },
  { id: "SILVER",   name: "Silver",   minReferrals: 5,   color: "#C0C0C0" },
  { id: "GOLD",     name: "Gold",     minReferrals: 15,  color: "#FFD700" },
  { id: "PLATINUM", name: "Platinum", minReferrals: 30,  color: "#E5E4E2" },
  { id: "DIAMOND",  name: "Diamond",  minReferrals: 50,  color: "#B9F2FF" },
  { id: "LEGEND",   name: "Legend",   minReferrals: 100, color: "#FF4500" }
];

function getTierByReferrals(referralCount) {
  const count = Number(referralCount) || 0;
  let current = TIER_LEVELS[0];

  for (const tier of TIER_LEVELS) {
    if (count >= tier.minReferrals) {
      current = tier;
    }
  }

  // Find next tier
  const currentIndex = TIER_LEVELS.findIndex(t => t.id === current.id);
  const nextTier = currentIndex < TIER_LEVELS.length - 1
    ? TIER_LEVELS[currentIndex + 1]
    : null;

  return {
    current,
    next: nextTier,
    referralsToNext: nextTier
      ? nextTier.minReferrals - count
      : 0
  };
}

/* =========================================================
DAILY SPIN (3 spins / day · weighted prizes · 1000 jackpot)
========================================================= */

const SPIN_PRIZES = [5, 10, 25, 50, 100, 250, 500, 1000];
const SPIN_WEIGHTS = [28, 24, 18, 12, 8, 5, 3, 2]; // higher = more common
const SPIN_MAX_PER_DAY = Number(process.env.SPIN_MAX_PER_DAY || 3);

function pickWeightedSpinPrize() {
  const total = SPIN_WEIGHTS.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < SPIN_WEIGHTS.length; i++) {
    r -= SPIN_WEIGHTS[i];
    if (r <= 0) {
      return { index: i, amount: SPIN_PRIZES[i] };
    }
  }
  return { index: 0, amount: SPIN_PRIZES[0] };
}

function getUtcDayKey(date = new Date()) {
  return date.toISOString().slice(0, 10); // YYYY-MM-DD UTC
}

function secondsUntilNextUtcMidnight() {
  const now = new Date();
  const next = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    0, 0, 0, 0
  ));
  return Math.max(0, Math.ceil((next.getTime() - now.getTime()) / 1000));
}

const PI_PAYMENT_API_BASE =
  process.env.PI_PAYMENT_API_BASE ||
  "https://api.testnet.minepi.com";

const MARKET_TEST_OWNER_PI_UID =
  process.env.MARKET_TEST_OWNER_PI_UID || "";

const MARKET_TEST_OWNER_USERNAME =
  process.env.MARKET_TEST_OWNER_USERNAME || "";

const MARKET_TEST_PRICE_PI = Number(
  process.env.MARKET_TEST_PRICE_PI || "0.10"
);

const MARKET_TEST_PRODUCT_ID =
  process.env.MARKET_TEST_PRODUCT_ID ||
  "amt-test-pet-001";

/* =========================================================
STAKING CONFIGURATION
========================================================= */

const STAKING_MIN_AMOUNT_AMT = Number(
  process.env.STAKING_MIN_AMOUNT_AMT || "0.01"
);

const STAKING_POOLS = {
  "30D": {
    id: "30D",
    name: "Starter",
    lockDays: 30,
    rewardPercent: 5
  },

  "90D": {
    id: "90D",
    name: "Growth",
    lockDays: 90,
    rewardPercent: 10
  },

  "180D": {
    id: "180D",
    name: "Legend",
    lockDays: 180,
    rewardPercent: 15
  }
};

/* =========================================================
DATABASE
========================================================= */

if (!DATABASE_URL) {
  console.error("DATABASE_URL is missing.");
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL
    ? { rejectUnauthorized: false }
    : undefined
});

/* =========================================================
EXPRESS
========================================================= */

app.use(
  cors({
    origin: "*",
    methods: [
      "GET",
      "POST",
      "PUT",
      "DELETE",
      "OPTIONS"
    ],
    allowedHeaders: [
      "Content-Type",
      "Authorization"
    ]
  })
);

app.use(
  express.json({
    limit: "1mb"
  })
);

/* =========================================================
HELPERS
========================================================= */

function nowIso() {
  return new Date().toISOString();
}

function authToken(req) {
  const header =
    req.headers.authorization || "";

  if (!header.startsWith("Bearer ")) {
    return "";
  }

  return header.slice(7).trim();
}

function cleanUsername(value) {
  return String(value || "").trim();
}

function validAmount(value) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }

  const text = String(value).trim();
  const n = Number(text);

  if (!Number.isFinite(n) || n <= 0) {
    return null;
  }

  if (text.includes(".")) {
    const decimals =
      text.split(".")[1].length;

    if (decimals > 8) {
      return null;
    }
  }

  return Number(n.toFixed(8));
}

function generateLedgerAddress() {
  return (
    "AMT-" +
    crypto
      .randomBytes(20)
      .toString("hex")
      .toUpperCase()
  );
}

function makeReference(prefix) {
  return (
    prefix +
    "-" +
    Date.now()
      .toString(36)
      .toUpperCase() +
    "-" +
    crypto
      .randomBytes(6)
      .toString("hex")
      .toUpperCase()
  );
}

class HttpError extends Error {
  constructor(
    status,
    message,
    extra = {}
  ) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

/* =========================================================
PI API
========================================================= */

async function piApiRequest(
  path,
  options = {}
) {
  if (!PI_API_KEY) {
    throw new Error(
      "PI_API_KEY is not configured."
    );
  }

  const response = await fetch(
    `${PI_API_BASE}${path}`,
    {
      ...options,

      headers: {
        Accept: "application/json",
        "Content-Type":
          "application/json",
        Authorization:
          `Key ${PI_API_KEY}`,
        ...(options.headers || {})
      }
    }
  );

  const text =
    await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    data = {
      raw: text
    };
  }

  if (!response.ok) {
    const error = new Error(
      data?.error ||
      data?.message ||
      `Pi API error ${response.status}`
    );

    error.status =
      response.status;

    error.data = data;

    throw error;
  }

  return data;
}

/* =========================================================
PI AUTHENTICATION
========================================================= */

async function verifyPiAccessToken(
  accessToken
) {
  if (!accessToken) {
    throw new HttpError(
      401,
      "Pi access token is required."
    );
  }

  const response = await fetch(
    `${PI_API_BASE}/v2/me`,
    {
      method: "GET",

      headers: {
        Accept: "application/json",
        Authorization:
          `Bearer ${accessToken}`
      }
    }
  );

  const text =
    await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    data = {};
  }

  if (
    !response.ok ||
    !data?.uid
  ) {
    throw new HttpError(
      401,
      data?.error ||
        data?.message ||
        "Pi authentication failed."
    );
  }

  return {
    uid: String(data.uid),

    username: cleanUsername(
      data.username
    ),

    /*
     * This is the VERIFIED Pi wallet address
     * returned by the Pi API.
     *
     * It is NOT the AMT- ledger address.
     */
    walletAddress:
      data.wallet_address || null
  };
}

/* =========================================================
AMT LEDGER WALLET
========================================================= */

async function ensureAmtWallet(
  memberId,
  db = pool
) {
  let result =
    await db.query(
      `
      SELECT
        id,
        member_id,
        wallet_status,
        wallet_address
      FROM amt_wallets
      WHERE member_id = $1
      LIMIT 1
      `,
      [memberId]
    );

  if (result.rows.length) {
    const wallet =
      result.rows[0];

    if (wallet.wallet_address) {
      return wallet;
    }
  }

  for (
    let attempt = 0;
    attempt < 5;
    attempt++
  ) {
    const address =
      generateLedgerAddress();

    try {
      result =
        await db.query(
          `
          INSERT INTO amt_wallets
            (
              member_id,
              wallet_status,
              wallet_address
            )
          VALUES
            (
              $1,
              'LEDGER_ACTIVE',
              $2
            )
          ON CONFLICT (member_id)
          DO UPDATE SET
            wallet_status =
              CASE
                WHEN amt_wallets.wallet_address IS NULL
                THEN 'LEDGER_ACTIVE'
                ELSE amt_wallets.wallet_status
              END,

            wallet_address =
              COALESCE(
                amt_wallets.wallet_address,
                EXCLUDED.wallet_address
              ),

            updated_at = NOW()

          RETURNING
            id,
            member_id,
            wallet_status,
            wallet_address
          `,
          [
            memberId,
            address
          ]
        );

      return result.rows[0];

    } catch (error) {
      if (
        error.code === "23505"
      ) {
        continue;
      }

      throw error;
    }
  }

  throw new Error(
    "Unable to create AMT ledger wallet."
  );
}

/* =========================================================
AUTHENTICATED MEMBER
========================================================= */

async function getAuthenticatedMember(
  accessToken
) {
  const piUser =
    await verifyPiAccessToken(
      accessToken
    );

  /*
   IMPORTANT:
   Pi UID is the permanent account key.
   Existing members are UPDATED, NOT recreated.
  */

  const result =
    await pool.query(
      `
      INSERT INTO members
        (
          pi_uid,
          username
        )
      VALUES
        (
          $1,
          $2
        )

      ON CONFLICT (pi_uid)
      DO UPDATE SET

        username =
          CASE
            WHEN EXCLUDED.username <> ''
            THEN EXCLUDED.username
            ELSE members.username
          END,

        updated_at = NOW()

      RETURNING *
      `,
      [
        piUser.uid,
        piUser.username
      ]
    );

  const member =
    result.rows[0];

  const wallet =
    await ensureAmtWallet(
      member.id
    );

  return {
    member,
    wallet,
    piUser
  };
}

async function requireAuth(
  req,
  res,
  next
) {
  try {
    const token =
      authToken(req);

    if (!token) {
      return res
        .status(401)
        .json({
          ok: false,
          error:
            "Pi login required."
        });
    }

    const auth =
      await getAuthenticatedMember(
        token
      );

    req.accessToken =
      token;

    req.member =
      auth.member;

    req.wallet =
      auth.wallet;

    req.piUser =
      auth.piUser;

    next();

  } catch (error) {
    console.error(
      "AUTH ERROR:",
      error
    );

    return res
      .status(
        error.status || 401
      )
      .json({
        ok: false,
        error:
          error.message ||
          "Authentication failed."
      });
  }
}

/* =========================================================
DATABASE INITIALIZATION
========================================================= */

async function initializeDatabase() {
  if (!DATABASE_URL) {
    throw new Error(
      "DATABASE_URL is required."
    );
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS members (
      id BIGSERIAL PRIMARY KEY,

      pi_uid TEXT UNIQUE NOT NULL,

      username TEXT NOT NULL
        DEFAULT '',

      kyc_status TEXT NOT NULL
        DEFAULT 'UNVERIFIED',

      profile_image TEXT,

      created_at TIMESTAMPTZ NOT NULL
        DEFAULT NOW(),

      updated_at TIMESTAMPTZ NOT NULL
        DEFAULT NOW()
    );

    ALTER TABLE members
      ADD COLUMN IF NOT EXISTS
      profile_image TEXT;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS amt_wallets (
      id BIGSERIAL PRIMARY KEY,

      member_id BIGINT UNIQUE NOT NULL
        REFERENCES members(id)
        ON DELETE CASCADE,

      wallet_status TEXT NOT NULL
        DEFAULT 'NOT_CONNECTED',

      wallet_address TEXT UNIQUE,

      created_at TIMESTAMPTZ NOT NULL
        DEFAULT NOW(),

      updated_at TIMESTAMPTZ NOT NULL
        DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS mining_sessions (
      id BIGSERIAL PRIMARY KEY,

      member_id BIGINT NOT NULL
        REFERENCES members(id)
        ON DELETE CASCADE,

      started_at TIMESTAMPTZ NOT NULL,

      ends_at TIMESTAMPTZ NOT NULL,

      status TEXT NOT NULL
        DEFAULT 'ACTIVE',

      rate NUMERIC(30,8) NOT NULL,

      claimed_amount NUMERIC(30,8)
        NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS amt_ledger (
      id BIGSERIAL PRIMARY KEY,

      member_id BIGINT NOT NULL
        REFERENCES members(id)
        ON DELETE CASCADE,

      amount NUMERIC(30,8) NOT NULL,

      type TEXT NOT NULL,

      reference TEXT UNIQUE NOT NULL,

      created_at TIMESTAMPTZ NOT NULL
        DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS referrals (
      id BIGSERIAL PRIMARY KEY,

      referrer_member_id BIGINT NOT NULL
        REFERENCES members(id)
        ON DELETE CASCADE,

      referred_member_id BIGINT UNIQUE NOT NULL
        REFERENCES members(id)
        ON DELETE CASCADE,

      status TEXT NOT NULL
        DEFAULT 'ACTIVE',

      created_at TIMESTAMPTZ NOT NULL
        DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS security_circle (
      id BIGSERIAL PRIMARY KEY,

      owner_member_id BIGINT NOT NULL
        REFERENCES members(id)
        ON DELETE CASCADE,

      member_id BIGINT NOT NULL
        REFERENCES members(id)
        ON DELETE CASCADE,

      status TEXT NOT NULL
        DEFAULT 'ACTIVE',

      created_at TIMESTAMPTZ NOT NULL
        DEFAULT NOW(),

      UNIQUE(
        owner_member_id,
        member_id
      )
    );

    CREATE TABLE IF NOT EXISTS marketplace_payments (
      id BIGSERIAL PRIMARY KEY,

      pi_payment_id TEXT UNIQUE NOT NULL,

      member_id BIGINT NOT NULL
        REFERENCES members(id)
        ON DELETE CASCADE,

      product_id TEXT NOT NULL,

      amount NUMERIC(30,8) NOT NULL,

      status TEXT NOT NULL
        DEFAULT 'APPROVED',

      created_at TIMESTAMPTZ NOT NULL
        DEFAULT NOW(),

      completed_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS marketplace_purchases (
      id BIGSERIAL PRIMARY KEY,

      payment_id BIGINT NOT NULL
        REFERENCES marketplace_payments(id)
        ON DELETE CASCADE,

      member_id BIGINT NOT NULL
        REFERENCES members(id)
        ON DELETE CASCADE,

      product_id TEXT NOT NULL,

      created_at TIMESTAMPTZ NOT NULL
        DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS amt_transfers (
      id BIGSERIAL PRIMARY KEY,

      tx_id TEXT UNIQUE NOT NULL,

      sender_member_id BIGINT NOT NULL
        REFERENCES members(id)
        ON DELETE CASCADE,

      recipient_member_id BIGINT NOT NULL
        REFERENCES members(id)
        ON DELETE CASCADE,

      amount NUMERIC(30,8) NOT NULL,

      memo TEXT NOT NULL
        DEFAULT '',

      status TEXT NOT NULL
        DEFAULT 'COMPLETED',

      created_at TIMESTAMPTZ NOT NULL
        DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS amt_airdrops (
      id BIGSERIAL PRIMARY KEY,

      member_id BIGINT NOT NULL
        REFERENCES members(id)
        ON DELETE CASCADE,

      amount NUMERIC(30,8) NOT NULL,

      reference TEXT UNIQUE NOT NULL,

      campaign TEXT NOT NULL DEFAULT 'LEGACY',

      created_at TIMESTAMPTZ NOT NULL
        DEFAULT NOW()
    );

    -- Support multiple airdrop campaigns (old 1 AMT vs new 100 AMT)
    ALTER TABLE amt_airdrops
      ADD COLUMN IF NOT EXISTS campaign TEXT NOT NULL DEFAULT 'LEGACY';

    ALTER TABLE amt_airdrops
      DROP CONSTRAINT IF EXISTS amt_airdrops_member_id_key;

    CREATE UNIQUE INDEX IF NOT EXISTS idx_airdrop_member_campaign
      ON amt_airdrops (member_id, campaign);

    CREATE TABLE IF NOT EXISTS amt_stakes (
      id BIGSERIAL PRIMARY KEY,

      member_id BIGINT NOT NULL
        REFERENCES members(id)
        ON DELETE CASCADE,

      pool_id TEXT NOT NULL,

      principal NUMERIC(30,8) NOT NULL,

      reward_rate NUMERIC(12,8) NOT NULL,

      reward_amount NUMERIC(30,8) NOT NULL,

      started_at TIMESTAMPTZ NOT NULL,

      unlock_at TIMESTAMPTZ NOT NULL,

      status TEXT NOT NULL
        DEFAULT 'ACTIVE',

      unstaked_at TIMESTAMPTZ,

      created_at TIMESTAMPTZ NOT NULL
        DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS amt_spins (
      id BIGSERIAL PRIMARY KEY,

      member_id BIGINT NOT NULL
        REFERENCES members(id)
        ON DELETE CASCADE,

      day_key TEXT NOT NULL,

      amount NUMERIC(30,8) NOT NULL,

      prize_index INT NOT NULL DEFAULT 0,

      reference TEXT UNIQUE NOT NULL,

      created_at TIMESTAMPTZ NOT NULL
        DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_spins_member_day
      ON amt_spins (member_id, day_key);

    /* ---- PETS ---- */
    CREATE TABLE IF NOT EXISTS pet_catalog (
      id BIGSERIAL PRIMARY KEY,
      slug TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      element TEXT NOT NULL DEFAULT 'Earth',
      rarity TEXT NOT NULL DEFAULT 'Common',
      base_hp INT NOT NULL DEFAULT 100,
      base_atk INT NOT NULL DEFAULT 20,
      base_def INT NOT NULL DEFAULT 15,
      base_spd INT NOT NULL DEFAULT 15,
      price_amt NUMERIC(30,8) NOT NULL DEFAULT 1,
      image TEXT DEFAULT '',
      skill_name TEXT NOT NULL DEFAULT 'Basic Strike',
      skill_power INT NOT NULL DEFAULT 10,
      active BOOLEAN NOT NULL DEFAULT TRUE
    );

    CREATE TABLE IF NOT EXISTS owned_pets (
      id BIGSERIAL PRIMARY KEY,
      member_id BIGINT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      catalog_id BIGINT REFERENCES pet_catalog(id) ON DELETE SET NULL,
      name TEXT NOT NULL,
      element TEXT NOT NULL DEFAULT 'Earth',
      rarity TEXT NOT NULL DEFAULT 'Common',
      level INT NOT NULL DEFAULT 1,
      xp INT NOT NULL DEFAULT 0,
      hp INT NOT NULL DEFAULT 100,
      atk INT NOT NULL DEFAULT 20,
      def INT NOT NULL DEFAULT 15,
      spd INT NOT NULL DEFAULT 15,
      energy INT NOT NULL DEFAULT 100,
      happiness INT NOT NULL DEFAULT 100,
      hunger INT NOT NULL DEFAULT 100,
      skill_name TEXT NOT NULL DEFAULT 'Basic Strike',
      skill_power INT NOT NULL DEFAULT 10,
      skill_level INT NOT NULL DEFAULT 1,
      image TEXT DEFAULT '',
      is_listed BOOLEAN NOT NULL DEFAULT FALSE,
      last_fed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_care_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS pet_inventory (
      member_id BIGINT PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
      food INT NOT NULL DEFAULT 0,
      water INT NOT NULL DEFAULT 0,
      premium_meal INT NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS pet_eggs (
      id BIGSERIAL PRIMARY KEY,
      member_id BIGINT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      element TEXT NOT NULL DEFAULT 'Mystery',
      gen INT NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'INCUBATING',
      hatch_at TIMESTAMPTZ NOT NULL,
      is_listed BOOLEAN NOT NULL DEFAULT FALSE,
      parent1_id BIGINT,
      parent2_id BIGINT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS pet_listings (
      id BIGSERIAL PRIMARY KEY,
      seller_member_id BIGINT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      listing_type TEXT NOT NULL DEFAULT 'PET',
      owned_pet_id BIGINT REFERENCES owned_pets(id) ON DELETE CASCADE,
      egg_id BIGINT REFERENCES pet_eggs(id) ON DELETE CASCADE,
      price_amt NUMERIC(30,8) NOT NULL,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS outpost_state (
      member_id BIGINT PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
      outpost_level INT NOT NULL DEFAULT 1,
      wins INT NOT NULL DEFAULT 0,
      losses INT NOT NULL DEFAULT 0,
      last_war_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_owned_pets_member ON owned_pets(member_id);
    CREATE INDEX IF NOT EXISTS idx_pet_eggs_member ON pet_eggs(member_id);
    CREATE INDEX IF NOT EXISTS idx_pet_listings_status ON pet_listings(status);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS
      idx_mining_member
      ON mining_sessions(member_id);

    CREATE INDEX IF NOT EXISTS
      idx_ledger_member
      ON amt_ledger(member_id);

    CREATE INDEX IF NOT EXISTS
      idx_referrals_referrer
      ON referrals(referrer_member_id);

    CREATE INDEX IF NOT EXISTS
      idx_security_owner
      ON security_circle(owner_member_id);

    CREATE INDEX IF NOT EXISTS
      idx_transfers_sender
      ON amt_transfers(sender_member_id);

    CREATE INDEX IF NOT EXISTS
      idx_transfers_recipient
      ON amt_transfers(recipient_member_id);

    CREATE INDEX IF NOT EXISTS
      idx_airdrop_member
      ON amt_airdrops(member_id);

    CREATE INDEX IF NOT EXISTS
      idx_stakes_member
      ON amt_stakes(member_id);

    CREATE INDEX IF NOT EXISTS
      idx_stakes_active
      ON amt_stakes(
        member_id,
        status
      );

    CREATE INDEX IF NOT EXISTS
      idx_stakes_unlock
      ON amt_stakes(unlock_at);
  `);

  console.log(
    "Database initialized."
  );
}

/* =========================================================
ROOT
========================================================= */

app.get("/", async (req, res) => {
  res.json({
    ok: true,

    service:
      "Alberto Marketplace Token",

    symbol:
      "AMT",

    network:
      "Pi Testnet",

    environment:
      "TESTNET",

    version:
      "2.3.3",

    features: [
      "Pi Login",
      "AMT Mining",
      "AMT Wallet",
      "AMT Transfers",
      "Airdrop",
      "Daily Spin",
      "Referral",
      "Security Circle",
      "Profile",
      "Marketplace",
      "Staking",
      "Pets",
      "Outpost War"
    ],

    timestamp:
      nowIso()
  });
});

/* =========================================================
HEALTH
========================================================= */

async function healthHandler(
  req,
  res
) {
  let db = "OK";

  try {
    await pool.query(
      "SELECT 1"
    );
  } catch {
    db = "ERROR";
  }

  res
    .status(
      db === "OK"
        ? 200
        : 503
    )
    .json({
      ok:
        db === "OK",

      service:
        "AMT Testnet Backend",

      database:
        db,

      piApiKeyConfigured:
        Boolean(
          PI_API_KEY
        ),

      network:
        "Pi Testnet",

      environment:
        "TESTNET",

      staking:
        true,

      timestamp:
        nowIso()
    });
}

app.get(
  "/health",
  healthHandler
);

app.get(
  "/api/health",
  healthHandler
);

/* =========================================================
AUTH
========================================================= */

/*
 * FIX:
 * Frontend calls GET /api/auth/verify.
 *
 * Previous version accepted POST only,
 * which caused:
 *
 * GET /api/auth/verify -> 404
 *
 * app.all() safely accepts both GET and POST
 * without changing the authentication logic.
 */

app.all(
  "/api/auth/verify",
  requireAuth,
  async (req, res) => {
    try {
      res.json({
        ok: true,

        /*
         * Explicit verified Pi wallet address.
         * This is the address returned by Pi API.
         */
        piWalletAddress:
          req.piUser.walletAddress ||
          null,

        /*
         * Current frontend can read data.piUser.
         */
        piUser: {
          uid:
            req.piUser.uid,

          username:
            req.piUser.username,

          walletAddress:
            req.piUser.walletAddress ||
            null
        },

        /*
         * Existing user object preserved.
         */
        user: {
          uid:
            req.piUser.uid,

          username:
            req.piUser.username,

          kycStatus:
            req.member.kyc_status,

          profileImage:
            req.member
              .profile_image || null
        },

        /*
         * IMPORTANT:
         * wallet.walletAddress is still the AMT
         * application ledger address.
         */
        wallet: {
          walletStatus:
            req.wallet
              .wallet_status,

          walletAddress:
            req.wallet
              .wallet_address,

          isBlockchainWallet:
            false,

          walletType:
            "AMT_TESTNET_LEDGER"
        },

        network:
          "Pi Testnet",

        environment:
          "TESTNET",

        // Referral code of this Pioneer (same as username)
        referralCode:
          req.member.username ||
          req.piUser.username ||
          null
      });

    } catch (error) {
      console.error(
        "AUTH VERIFY RESPONSE ERROR:",
        error
      );

      res
        .status(500)
        .json({
          ok: false,
          error:
            error.message ||
            "Unable to verify authentication."
        });
    }
  }
);

/* =========================================================
PROFILE
========================================================= */

app.get(
  "/api/profile",
  requireAuth,
  async (req, res) => {
    // Get referral count for tier
    const countResult = await pool.query(
      `
      SELECT COUNT(*)::INT AS count
      FROM referrals
      WHERE referrer_member_id = $1
        AND status = 'ACTIVE'
      `,
      [req.member.id]
    );

    const referralCount = Number(countResult.rows[0]?.count || 0);
    const tierInfo = getTierByReferrals(referralCount);

    res.json({
      ok: true,

      uid:
        req.piUser.uid,

      username:
        req.piUser.username,

      kycStatus:
        req.member.kyc_status,

      profileImage:
        req.member
          .profile_image || null,

      /*
       * VERIFIED Pi wallet address.
       */
      piWalletAddress:
        req.piUser.walletAddress ||
        null,

      walletStatus:
        req.wallet
          .wallet_status,

      /*
       * AMT application ledger address.
       */
      walletAddress:
        req.wallet
          .wallet_address,

      walletType:
        "AMT_TESTNET_LEDGER",

      isBlockchainWallet:
        false,

      network:
        "Pi Testnet",

      environment:
        "TESTNET",

      // Multiple field names for frontend compatibility
      referralCode: req.member.username || req.piUser.username || null,
      code: req.member.username || req.piUser.username || null,
      inviteCode: req.member.username || req.piUser.username || null,
      referral_code: req.member.username || req.piUser.username || null,

      referralCount,

      // Tier system (Bronze → Legend)
      tier: {
        id: tierInfo.current.id,
        name: tierInfo.current.name,
        color: tierInfo.current.color,
        minReferrals: tierInfo.current.minReferrals,
        next: tierInfo.next
          ? {
              id: tierInfo.next.id,
              name: tierInfo.next.name,
              minReferrals: tierInfo.next.minReferrals
            }
          : null,
        referralsToNext: tierInfo.referralsToNext
      }
    });
  }
);

app.post(
  "/api/profile/photo",
  requireAuth,
  async (req, res) => {
    try {
      const image =
        String(
          req.body?.image || ""
        ).trim();

      if (!image) {
        return res
          .status(400)
          .json({
            ok: false,
            error:
              "Profile image is required."
          });
      }

      if (
        !image.startsWith(
          "data:image/"
        )
      ) {
        return res
          .status(400)
          .json({
            ok: false,
            error:
              "Invalid image format."
          });
      }

      // Allow up to ~2.5MB base64 image
      if (
        image.length > 2500000
      ) {
        return res
          .status(413)
          .json({
            ok: false,
            error:
              "Profile image is too large. Maximum allowed is about 2MB."
          });
      }

      await pool.query(
        `
        UPDATE members
        SET
          profile_image = $1,
          updated_at = NOW()
        WHERE id = $2
        `,
        [
          image,
          req.member.id
        ]
      );

      res.json({
        ok: true,

        profileImage:
          image
      });

    } catch (error) {
      console.error(
        "PHOTO ERROR:",
        error
      );

      res
        .status(500)
        .json({
          ok: false,
          error:
            "Unable to save profile image."
        });
    }
  }
);

app.delete(
  "/api/profile/photo",
  requireAuth,
  async (req, res) => {
    await pool.query(
      `
      UPDATE members
      SET
        profile_image = NULL,
        updated_at = NOW()
      WHERE id = $1
      `,
      [req.member.id]
    );

    res.json({
      ok: true,
      profileImage:
        null
    });
  }
);

/* =========================================================
KYC
========================================================= */

app.get(
  "/api/kyc/status",
  requireAuth,
  async (req, res) => {
    const verified =
      String(
        req.member.kyc_status
      ).toUpperCase() ===
      "VERIFIED";

    res.json({
      ok: true,

      status:
        req.member
          .kyc_status,

      miningAllowed:
        true,

      migrationEligible:
        verified,

      protectedTransactionsEligible:
        verified
    });
  }
);

/* =========================================================
BALANCE HELPERS
========================================================= */

async function getBalance(
  memberId,
  db = pool
) {
  const result =
    await db.query(
      `
      SELECT
        COALESCE(
          SUM(amount),
          0
        )::NUMERIC(30,8)
        AS balance

      FROM amt_ledger

      WHERE member_id = $1
      `,
      [memberId]
    );

  return Number(
    result.rows[0]?.balance || 0
  );
}

async function getStakingSummary(
  memberId,
  db = pool
) {
  const result =
    await db.query(
      `
      SELECT

        COALESCE(
          SUM(
            CASE
              WHEN status = 'ACTIVE'
              THEN principal
              ELSE 0
            END
          ),
          0
        )::NUMERIC(30,8)
        AS staked_principal,

        COALESCE(
          SUM(
            CASE
              WHEN status = 'ACTIVE'
              THEN reward_amount
              ELSE 0
            END
          ),
          0
        )::NUMERIC(30,8)
        AS pending_rewards

      FROM amt_stakes

      WHERE member_id = $1
      `,
      [memberId]
    );

  const row =
    result.rows[0];

  return {
    stakedPrincipal:
      Number(
        row?.staked_principal || 0
      ),

    pendingRewards:
      Number(
        row?.pending_rewards || 0
      )
  };
}

/* =========================================================
WALLET
========================================================= */

app.get(
  "/api/wallet",
  requireAuth,
  async (req, res) => {
    const balance =
      await getBalance(
        req.member.id
      );

    const staking =
      await getStakingSummary(
        req.member.id
      );

    const totalBalance =
      Number(
        (
          balance +
          staking.stakedPrincipal
        ).toFixed(8)
      );

    res.json({
      ok: true,

      symbol:
        "AMT",

      balance,

      availableBalance:
        balance,

      stakedBalance:
        staking.stakedPrincipal,

      pendingStakingRewards:
        staking.pendingRewards,

      totalBalance,

      network:
        "Pi Testnet",

      environment:
        "TESTNET",

      /*
       * VERIFIED Pi Testnet wallet.
       */
      piWalletAddress:
        req.piUser.walletAddress ||
        null,

      /*
       * AMT application ledger wallet.
       * Kept unchanged for compatibility.
       */
      walletStatus:
        req.wallet
          .wallet_status,

      walletAddress:
        req.wallet
          .wallet_address,

      /*
       * Explicit AMT ledger field.
       */
      ledgerWalletAddress:
        req.wallet
          .wallet_address,

      isBlockchainWallet:
        false,

      walletType:
        "AMT_TESTNET_LEDGER",

      // Referral code of this Pioneer (same as username)
      referralCode:
        req.member.username ||
        req.piUser.username ||
        null
    });
  }
);

/* =========================================================
WALLET SEND
========================================================= */

async function performAmtTransfer(
  member,
  recipientAddress,
  amount,
  memo
) {
  const client =
    await pool.connect();

  try {
    await client.query(
      "BEGIN"
    );

    await client.query(
      `
      SELECT id
      FROM members
      WHERE id = $1
      FOR UPDATE
      `,
      [member.id]
    );

    const senderWallet =
      await client.query(
        `
        SELECT
          id,
          member_id,
          wallet_address
        FROM amt_wallets
        WHERE member_id = $1
        FOR UPDATE
        `,
        [member.id]
      );

    if (
      !senderWallet.rows.length
    ) {
      throw new HttpError(
        404,
        "Sender wallet not found."
      );
    }

    const recipientWallet =
      await client.query(
        `
        SELECT
          id,
          member_id,
          wallet_address
        FROM amt_wallets
        WHERE
          UPPER(wallet_address) = $1
        LIMIT 1
        FOR UPDATE
        `,
        [recipientAddress]
      );

    if (
      !recipientWallet.rows.length
    ) {
      throw new HttpError(
        404,
        "Recipient AMT ledger address was not found."
      );
    }

    const recipient =
      recipientWallet.rows[0];

    if (
      Number(
        recipient.member_id
      ) ===
      Number(member.id)
    ) {
      throw new HttpError(
        400,
        "You cannot send AMT to yourself."
      );
    }

    const balance =
      await getBalance(
        member.id,
        client
      );

    if (
      balance < amount
    ) {
      throw new HttpError(
        400,
        "Insufficient AMT balance.",
        {
          balance,
          requested:
            amount
        }
      );
    }

    const txId =
      makeReference(
        "AMT-TX"
      );

    await client.query(
      `
      INSERT INTO amt_transfers
        (
          tx_id,
          sender_member_id,
          recipient_member_id,
          amount,
          memo,
          status
        )
      VALUES
        (
          $1,
          $2,
          $3,
          $4,
          $5,
          'COMPLETED'
        )
      `,
      [
        txId,
        member.id,
        recipient.member_id,
        amount,
        memo
      ]
    );

    await client.query(
      `
      INSERT INTO amt_ledger
        (
          member_id,
          amount,
          type,
          reference
        )
      VALUES
        (
          $1,
          $2,
          'SEND',
          $3
        )
      `,
      [
        member.id,
        -amount,
        txId + ":SEND"
      ]
    );

    await client.query(
      `
      INSERT INTO amt_ledger
        (
          member_id,
          amount,
          type,
          reference
        )
      VALUES
        (
          $1,
          $2,
          'RECEIVE',
          $3
        )
      `,
      [
        recipient.member_id,
        amount,
        txId + ":RECEIVE"
      ]
    );

    await client.query(
      "COMMIT"
    );

    const newBalance =
      await getBalance(
        member.id
      );

    return {
      txId,
      amount,
      recipientAddress,
      memo,
      balance:
        newBalance,
      status:
        "COMPLETED"
    };

  } catch (error) {
    try {
      await client.query(
        "ROLLBACK"
      );
    } catch {}

    throw error;

  } finally {
    client.release();
  }
}

app.post(
  "/api/wallet/send",
  requireAuth,
  async (req, res) => {
    const recipientAddress =
      String(
        req.body?.recipientAddress ||
        ""
      )
        .trim()
        .toUpperCase();

    const amount =
      validAmount(
        req.body?.amount
      );

    const memo =
      String(
        req.body?.memo || ""
      )
        .trim()
        .slice(0, 160);

    if (!recipientAddress) {
      return res
        .status(400)
        .json({
          ok: false,
          error:
            "Recipient AMT address is required."
        });
    }

    if (amount === null) {
      return res
        .status(400)
        .json({
          ok: false,
          error:
            "Invalid amount. Maximum 8 decimal places."
        });
    }

    try {
      const result =
        await performAmtTransfer(
          req.member,
          recipientAddress,
          amount,
          memo
        );

      res.json({
        ok: true,
        ...result,
        network:
          "Pi Testnet",
        walletType:
          "AMT_TESTNET_LEDGER"
      });

    } catch (error) {
      console.error(
        "SEND AMT ERROR:",
        error
      );

      res
        .status(
          error.status || 500
        )
        .json({
          ok: false,
          error:
            error.message ||
            "AMT transfer failed.",
          ...(error.extra || {})
        });
    }
  }
);

/* =========================================================
WALLET TRANSACTIONS
========================================================= */

app.get(
  "/api/wallet/transactions",
  requireAuth,
  async (req, res) => {
    const result =
      await pool.query(
        `
        SELECT

          t.tx_id,
          t.amount,
          t.memo,
          t.status,
          t.created_at,

          sw.wallet_address
            AS sender_address,

          rw.wallet_address
            AS recipient_address

        FROM amt_transfers t

        JOIN amt_wallets sw
          ON sw.member_id =
             t.sender_member_id

        JOIN amt_wallets rw
          ON rw.member_id =
             t.recipient_member_id

        WHERE
          t.sender_member_id = $1
          OR
          t.recipient_member_id = $1

        ORDER BY
          t.created_at DESC

        LIMIT 50
        `,
        [req.member.id]
      );

    const transactions =
      result.rows.map(
        row => ({
          txId:
            row.tx_id,

          amount:
            Number(row.amount),

          memo:
            row.memo,

          status:
            row.status,

          createdAt:
            row.created_at,

          direction:
            row.sender_address ===
            req.wallet.wallet_address
              ? "SEND"
              : "RECEIVE",

          senderAddress:
            row.sender_address,

          recipientAddress:
            row.recipient_address
        })
      );

    res.json({
      ok: true,
      transactions
    });
  }
);

/* =========================================================
AIRDROP
========================================================= */

app.get(
  "/api/airdrop/status",
  requireAuth,
  async (req, res) => {
    // Check if already claimed THIS campaign (old 1 AMT claims are ignored)
    const claimedResult =
      await pool.query(
        `
        SELECT
          amount,
          reference,
          created_at
        FROM amt_airdrops
        WHERE member_id = $1
          AND campaign = $2
        LIMIT 1
        `,
        [req.member.id, AIRDROP_CAMPAIGN]
      );

    const alreadyClaimed = claimedResult.rows.length > 0;
    const now = Date.now();
    const unlockTime = AIRDROP_UNLOCK_AT.getTime();

    let canClaim = false;
    let remainingSeconds = 0;
    let availableAt = null;

    if (alreadyClaimed) {
      canClaim = false;
    } else if (now < unlockTime) {
      // Global 48h waiting period (applies to both new and old users)
      canClaim = false;
      remainingSeconds = Math.ceil((unlockTime - now) / 1000);
      availableAt = AIRDROP_UNLOCK_AT.toISOString();
    } else {
      // Unlock time reached and not yet claimed
      canClaim = true;
    }

    res.json({
      ok: true,

      amount: AIRDROP_AMOUNT_AMT,

      canClaim,

      alreadyClaimed,

      remainingSeconds,

      availableAt,

      claimedAt: alreadyClaimed
        ? claimedResult.rows[0].created_at
        : null,

      unlockAt: AIRDROP_UNLOCK_AT.toISOString(),

      waitHours: 48,

      network: "Pi Testnet",

      type: "ONE_TIME_GLOBAL_48H_WAIT"
    });
  }
);

app.post(
  "/api/airdrop/claim",
  requireAuth,
  async (req, res) => {
    const client =
      await pool.connect();

    try {
      await client.query(
        "BEGIN"
      );

      await client.query(
        `
        SELECT id, created_at
        FROM members
        WHERE id = $1
        FOR UPDATE
        `,
        [req.member.id]
      );

      // 1. Check if already claimed THIS campaign (old 1 AMT is ignored)
      const existing =
        await client.query(
          `
          SELECT id
          FROM amt_airdrops
          WHERE member_id = $1
            AND campaign = $2
          FOR UPDATE
          `,
          [req.member.id, AIRDROP_CAMPAIGN]
        );

      if (existing.rows.length) {
        await client.query("ROLLBACK");

        return res.status(409).json({
          ok: false,
          error: "This airdrop has already been claimed. One-time only."
        });
      }

      // 2. Global 48-hour waiting period (applies to BOTH new and old users)
      const now = Date.now();
      const unlockTime = AIRDROP_UNLOCK_AT.getTime();

      if (now < unlockTime) {
        const remainingSeconds = Math.ceil((unlockTime - now) / 1000);

        await client.query("ROLLBACK");

        return res.status(429).json({
          ok: false,
          error: "Airdrop is not yet available. Everyone must wait 48 hours.",
          remainingSeconds,
          availableAt: AIRDROP_UNLOCK_AT.toISOString()
        });
      }

      const reference =
        makeReference(
          "AMT-AIRDROP"
        );

      await client.query(
        `
        INSERT INTO amt_airdrops
          (
            member_id,
            amount,
            reference,
            campaign
          )
        VALUES
          (
            $1,
            $2,
            $3,
            $4
          )
        `,
        [
          req.member.id,
          AIRDROP_AMOUNT_AMT,
          reference,
          AIRDROP_CAMPAIGN
        ]
      );

      await client.query(
        `
        INSERT INTO amt_ledger
          (
            member_id,
            amount,
            type,
            reference
          )
        VALUES
          (
            $1,
            $2,
            'AIRDROP_REWARD',
            $3
          )
        `,
        [
          req.member.id,
          AIRDROP_AMOUNT_AMT,
          reference
        ]
      );

      await client.query(
        "COMMIT"
      );

      const balance =
        await getBalance(
          req.member.id
        );

      res.json({
        ok: true,

        claimed: true,

        amount: AIRDROP_AMOUNT_AMT,

        reference,

        balance,

        network: "Pi Testnet",

        type: "ONE_TIME_GLOBAL_48H_WAIT"
      });

    } catch (error) {
      try {
        await client.query(
          "ROLLBACK"
        );
      } catch {}

      console.error(
        "AIRDROP ERROR:",
        error
      );

      res
        .status(500)
        .json({
          ok: false,
          error:
            "Unable to claim airdrop."
        });

    } finally {
      client.release();
    }
  }
);

/* =========================================================
DAILY SPIN
========================================================= */

app.get(
  "/api/spin/status",
  requireAuth,
  async (req, res) => {
    try {
      const dayKey = getUtcDayKey();

      const result = await pool.query(
        `
        SELECT COUNT(*)::INT AS used
        FROM amt_spins
        WHERE member_id = $1
          AND day_key = $2
        `,
        [req.member.id, dayKey]
      );

      const spinsUsed = Number(result.rows[0]?.used || 0);
      const spinsLeft = Math.max(0, SPIN_MAX_PER_DAY - spinsUsed);

      res.json({
        ok: true,
        spinsLeft,
        spinsUsed,
        maxSpins: SPIN_MAX_PER_DAY,
        secondsUntilReset: secondsUntilNextUtcMidnight(),
        prizes: SPIN_PRIZES,
        jackpot: 1000,
        network: "Pi Testnet",
        dayKey
      });
    } catch (error) {
      console.error("SPIN STATUS ERROR:", error);
      res.status(500).json({
        ok: false,
        error: "Unable to load spin status."
      });
    }
  }
);

// Alias used by some frontends
app.get(
  "/api/daily/status",
  requireAuth,
  async (req, res) => {
    try {
      const dayKey = getUtcDayKey();

      const result = await pool.query(
        `
        SELECT COUNT(*)::INT AS used
        FROM amt_spins
        WHERE member_id = $1
          AND day_key = $2
        `,
        [req.member.id, dayKey]
      );

      const spinsUsed = Number(result.rows[0]?.used || 0);
      const spinsLeft = Math.max(0, SPIN_MAX_PER_DAY - spinsUsed);

      res.json({
        ok: true,
        canClaim: spinsLeft > 0,
        spinsLeft,
        spinsUsed,
        maxSpins: SPIN_MAX_PER_DAY,
        secondsUntilReset: secondsUntilNextUtcMidnight(),
        prizes: SPIN_PRIZES
      });
    } catch (error) {
      console.error("DAILY STATUS ERROR:", error);
      res.status(500).json({
        ok: false,
        error: "Unable to load daily status."
      });
    }
  }
);

app.post(
  "/api/spin/claim",
  requireAuth,
  async (req, res) => {
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      await client.query(
        `
        SELECT id
        FROM members
        WHERE id = $1
        FOR UPDATE
        `,
        [req.member.id]
      );

      const dayKey = getUtcDayKey();

      // Member row already locked above — count without FOR UPDATE
      // (PostgreSQL does not allow FOR UPDATE with aggregate COUNT)
      const usedResult = await client.query(
        `
        SELECT COUNT(*)::INT AS used
        FROM amt_spins
        WHERE member_id = $1
          AND day_key = $2
        `,
        [req.member.id, dayKey]
      );

      const spinsUsed = Number(usedResult.rows[0]?.used || 0);

      if (spinsUsed >= SPIN_MAX_PER_DAY) {
        await client.query("ROLLBACK");
        return res.status(429).json({
          ok: false,
          error: "No spins left today. Resets at UTC midnight.",
          spinsLeft: 0,
          spinsUsed,
          maxSpins: SPIN_MAX_PER_DAY,
          secondsUntilReset: secondsUntilNextUtcMidnight()
        });
      }

      const prize = pickWeightedSpinPrize();
      const amount = prize.amount;
      const reference = makeReference("AMT-SPIN");

      await client.query(
        `
        INSERT INTO amt_spins
          (member_id, day_key, amount, prize_index, reference)
        VALUES
          ($1, $2, $3, $4, $5)
        `,
        [req.member.id, dayKey, amount, prize.index, reference]
      );

      await client.query(
        `
        INSERT INTO amt_ledger
          (member_id, amount, type, reference)
        VALUES
          ($1, $2, 'SPIN_REWARD', $3)
        `,
        [req.member.id, amount, reference]
      );

      await client.query("COMMIT");

      const balance = await getBalance(req.member.id);
      const spinsLeft = Math.max(0, SPIN_MAX_PER_DAY - (spinsUsed + 1));
      const jackpot = amount >= 1000;

      res.json({
        ok: true,
        amount,
        prize: amount,
        prizeIndex: prize.index,
        jackpot,
        reference,
        balance,
        spinsLeft,
        spinsUsed: spinsUsed + 1,
        maxSpins: SPIN_MAX_PER_DAY,
        secondsUntilReset: secondsUntilNextUtcMidnight(),
        message: jackpot
          ? `JACKPOT! +${amount} AMT`
          : `Spin +${amount} AMT`,
        network: "Pi Testnet"
      });
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {}

      console.error("SPIN CLAIM ERROR:", error);

      res.status(500).json({
        ok: false,
        error: error.message || "Unable to claim spin reward."
      });
    } finally {
      client.release();
    }
  }
);

/* =========================================================
MINING
========================================================= */

app.post(
  "/api/mining/start",
  requireAuth,
  async (req, res) => {
    const active =
      await pool.query(
        `
        SELECT *
        FROM mining_sessions
        WHERE
          member_id = $1
          AND status = 'ACTIVE'
        ORDER BY
          started_at DESC
        LIMIT 1
        `,
        [req.member.id]
      );

    if (
      active.rows.length
    ) {
      return res
        .status(409)
        .json({
          ok: false,
          error:
            "Mining session is already active.",
          session:
            active.rows[0]
        });
    }

    const start =
      new Date();

    const end =
      new Date(
        start.getTime() +
        MINING_DURATION_SECONDS *
          1000
      );

    const result =
      await pool.query(
        `
        INSERT INTO mining_sessions
          (
            member_id,
            started_at,
            ends_at,
            status,
            rate,
            claimed_amount
          )
        VALUES
          (
            $1,
            $2,
            $3,
            'ACTIVE',
            $4,
            0
          )

        RETURNING *
        `,
        [
          req.member.id,
          start,
          end,
          AMT_MINING_RATE
        ]
      );

    res.json({
      ok: true,

      session:
        result.rows[0],

      rate:
        AMT_MINING_RATE,

      durationSeconds:
        MINING_DURATION_SECONDS,

      maximumBaseReward:
        MAXIMUM_BASE_REWARD
    });
  }
);

app.get(
  "/api/mining/status",
  requireAuth,
  async (req, res) => {
    const result =
      await pool.query(
        `
        SELECT *
        FROM mining_sessions
        WHERE
          member_id = $1
          AND status = 'ACTIVE'
        ORDER BY
          started_at DESC
        LIMIT 1
        `,
        [req.member.id]
      );

    const balance =
      await getBalance(
        req.member.id
      );

    if (
      !result.rows.length
    ) {
      return res.json({
        ok: true,

        active:
          false,

        completed:
          false,

        earned:
          0,

        balance
      });
    }

    const session =
      result.rows[0];

    const started =
      new Date(
        session.started_at
      ).getTime();

    const ends =
      new Date(
        session.ends_at
      ).getTime();

    const current =
      Date.now();

    const elapsedSeconds =
      Math.max(
        0,
        Math.min(
          MINING_DURATION_SECONDS,
          (current - started) /
            1000
        )
      );

    const earned =
      Math.min(
        MAXIMUM_BASE_REWARD,
        Number(
          (
            elapsedSeconds /
              3600 *
            Number(
              session.rate
            )
          ).toFixed(8)
        )
      );

    const completed =
      current >= ends;

    res.json({
      ok: true,

      active:
        true,

      completed,

      session,

      earned,

      balance,

      rate:
        Number(
          session.rate
        ),

      remainingSeconds:
        Math.max(
          0,
          Math.ceil(
            (ends - current) /
              1000
          )
        )
    });
  }
);

app.post(
  "/api/mining/claim",
  requireAuth,
  async (req, res) => {
    const client =
      await pool.connect();

    try {
      await client.query(
        "BEGIN"
      );

      await client.query(
        `
        SELECT id
        FROM members
        WHERE id = $1
        FOR UPDATE
        `,
        [req.member.id]
      );

      const sessionResult =
        await client.query(
          `
          SELECT *
          FROM mining_sessions
          WHERE
            member_id = $1
            AND status = 'ACTIVE'
          ORDER BY
            started_at DESC
          LIMIT 1
          FOR UPDATE
          `,
          [req.member.id]
        );

      if (
        !sessionResult.rows.length
      ) {
        await client.query(
          "ROLLBACK"
        );

        return res
          .status(404)
          .json({
            ok: false,
            error:
              "No active mining session."
          });
      }

      const session =
        sessionResult.rows[0];

      const ends =
        new Date(
          session.ends_at
        ).getTime();

      if (
        Date.now() < ends
      ) {
        await client.query(
          "ROLLBACK"
        );

        return res
          .status(400)
          .json({
            ok: false,

            error:
              "Mining session is not yet complete.",

            remainingSeconds:
              Math.ceil(
                (ends -
                  Date.now()) /
                  1000
              )
          });
      }

      const reward =
        Number(
          (
            Number(
              session.rate
            ) * 24
          ).toFixed(8)
        );

      const reference =
        makeReference(
          "AMT-MINING"
        );

      await client.query(
        `
        INSERT INTO amt_ledger
          (
            member_id,
            amount,
            type,
            reference
          )
        VALUES
          (
            $1,
            $2,
            'MINING_REWARD',
            $3
          )
        `,
        [
          req.member.id,
          reward,
          reference
        ]
      );

      await client.query(
        `
        UPDATE mining_sessions
        SET
          status = 'COMPLETED',
          claimed_amount = $1
        WHERE id = $2
        `,
        [
          reward,
          session.id
        ]
      );

      await client.query(
        "COMMIT"
      );

      const balance =
        await getBalance(
          req.member.id
        );

      res.json({
        ok: true,

        reward,

        reference,

        balance,

        status:
          "COMPLETED"
      });

    } catch (error) {
      try {
        await client.query(
          "ROLLBACK"
        );
      } catch {}

      console.error(
        "MINING CLAIM ERROR:",
        error
      );

      res
        .status(500)
        .json({
          ok: false,
          error:
            "Unable to claim mining reward."
        });

    } finally {
      client.release();
    }
  }
);

/* =========================================================
REFERRAL
========================================================= */

async function addReferralToSecurityCircle(
  client,
  ownerMemberId,
  referredMemberId
) {
  if (
    Number(ownerMemberId) ===
    Number(referredMemberId)
  ) {
    return false;
  }

  const countResult =
    await client.query(
      `
      SELECT
        COUNT(*)::INT AS count
      FROM security_circle
      WHERE
        owner_member_id = $1
        AND status = 'ACTIVE'
      `,
      [ownerMemberId]
    );

  const count =
    Number(
      countResult.rows[0]?.count || 0
    );

  const existing =
    await client.query(
      `
      SELECT id
      FROM security_circle
      WHERE
        owner_member_id = $1
        AND member_id = $2
      LIMIT 1
      `,
      [
        ownerMemberId,
        referredMemberId
      ]
    );

  if (
    existing.rows.length
  ) {
    await client.query(
      `
      UPDATE security_circle
      SET status = 'ACTIVE'
      WHERE id = $1
      `,
      [
        existing.rows[0].id
      ]
    );

    return true;
  }

  if (
    count >=
    MAX_SECURITY_CIRCLE
  ) {
    return false;
  }

  await client.query(
    `
    INSERT INTO security_circle
      (
        owner_member_id,
        member_id,
        status
      )
    VALUES
      (
        $1,
        $2,
        'ACTIVE'
      )
    `,
    [
      ownerMemberId,
      referredMemberId
    ]
  );

  return true;
}

app.post(
  "/api/referral/link",
  requireAuth,
  async (req, res) => {
    const referredMemberId =
      Number(
        req.body?.referralMemberId
      );

    if (
      !Number.isInteger(
        referredMemberId
      )
    ) {
      return res
        .status(400)
        .json({
          ok: false,
          error:
            "Valid referralMemberId is required."
        });
    }

    if (
      referredMemberId ===
      Number(req.member.id)
    ) {
      return res
        .status(400)
        .json({
          ok: false,
          error:
            "You cannot refer yourself."
        });
    }

    const client =
      await pool.connect();

    try {
      await client.query(
        "BEGIN"
      );

      const memberCheck =
        await client.query(
          `
          SELECT id
          FROM members
          WHERE id = $1
          LIMIT 1
          `,
          [referredMemberId]
        );

      if (
        !memberCheck.rows.length
      ) {
        throw new HttpError(
          404,
          "Pioneer member was not found."
        );
      }

      const existing =
        await client.query(
          `
          SELECT id
          FROM referrals
          WHERE
            referred_member_id = $1
          LIMIT 1
          `,
          [referredMemberId]
        );

      if (
        existing.rows.length
      ) {
        await client.query(
          "ROLLBACK"
        );

        return res
          .status(409)
          .json({
            ok: false,
            error:
              "This Pioneer already has a referrer."
          });
      }

      await client.query(
        `
        INSERT INTO referrals
          (
            referrer_member_id,
            referred_member_id,
            status
          )
        VALUES
          (
            $1,
            $2,
            'ACTIVE'
          )
        `,
        [
          req.member.id,
          referredMemberId
        ]
      );

      const addedToCircle =
        await addReferralToSecurityCircle(
          client,
          req.member.id,
          referredMemberId
        );

      await client.query(
        "COMMIT"
      );

      res.json({
        ok: true,

        linked:
          true,

        addedToSecurityCircle:
          addedToCircle
      });

    } catch (error) {
      try {
        await client.query(
          "ROLLBACK"
        );
      } catch {}

      if (
        error.code ===
        "23505"
      ) {
        return res
          .status(409)
          .json({
            ok: false,
            error:
              "Referral is already linked."
          });
      }

      console.error(
        "REFERRAL ERROR:",
        error
      );

      res
        .status(
          error.status || 500
        )
        .json({
          ok: false,
          error:
            error.message ||
            "Unable to link referral."
        });

    } finally {
      client.release();
    }
  }
);

app.post(
  "/api/referral/auto-link",
  async (req, res) => {
    try {
      const token =
        String(
          req.body?.accessToken || ""
        ).trim();

      const referralUsername =
        cleanUsername(
          req.body?.referralUsername
        );

      if (!token) {
        return res
          .status(401)
          .json({
            ok: false,
            error:
              "Pi access token is required."
          });
      }

      if (!referralUsername) {
        return res
          .status(400)
          .json({
            ok: false,
            error:
              "Referral username is required."
          });
      }

      const auth =
        await getAuthenticatedMember(
          token
        );

      const client =
        await pool.connect();

      try {
        await client.query(
          "BEGIN"
        );

        const referrer =
          await client.query(
            `
            SELECT *
            FROM members
            WHERE
              LOWER(username) =
              LOWER($1)
            LIMIT 1
            `,
            [referralUsername]
          );

        if (
          !referrer.rows.length
        ) {
          await client.query(
            "ROLLBACK"
          );

          return res
            .status(404)
            .json({
              ok: false,
              error:
                "Referral username not found."
            });
        }

        const referrerMember =
          referrer.rows[0];

        if (
          Number(
            referrerMember.id
          ) ===
          Number(
            auth.member.id
          )
        ) {
          await client.query(
            "ROLLBACK"
          );

          return res
            .status(400)
            .json({
              ok: false,
              error:
                "You cannot use your own username."
            });
        }

        const existing =
          await client.query(
            `
            SELECT *
            FROM referrals
            WHERE
              referred_member_id = $1
            LIMIT 1
            `,
            [auth.member.id]
          );

        if (
          existing.rows.length
        ) {
          await client.query(
            "ROLLBACK"
          );

          return res.json({
            ok: true,
            linked: false,
            alreadyLinked:
              true
          });
        }

        await client.query(
          `
          INSERT INTO referrals
            (
              referrer_member_id,
              referred_member_id,
              status
            )
          VALUES
            (
              $1,
              $2,
              'ACTIVE'
            )
          `,
          [
            referrerMember.id,
            auth.member.id
          ]
        );

        const addedToCircle =
          await addReferralToSecurityCircle(
            client,
            referrerMember.id,
            auth.member.id
          );

        await client.query(
          "COMMIT"
        );

        return res.json({
          ok: true,

          linked:
            true,

          referrerUsername:
            referrerMember.username,

          addedToSecurityCircle:
            addedToCircle
        });

      } catch (error) {
        try {
          await client.query(
            "ROLLBACK"
          );
        } catch {}

        throw error;

      } finally {
        client.release();
      }

    } catch (error) {
      console.error(
        "AUTO REFERRAL ERROR:",
        error
      );

      res
        .status(
          error.status || 500
        )
        .json({
          ok: false,
          error:
            error.message ||
            "Unable to auto-link referral."
        });
    }
  }
);

app.get(
  "/api/referral/status",
  requireAuth,
  async (req, res) => {
    const countResult =
      await pool.query(
        `
        SELECT
          COUNT(*)::INT AS count
        FROM referrals
        WHERE
          referrer_member_id = $1
          AND status = 'ACTIVE'
        `,
        [req.member.id]
      );

    const activeMiners =
      await pool.query(
        `
        SELECT
          COUNT(*)::INT AS count
        FROM referrals r
        JOIN mining_sessions ms
          ON ms.member_id =
             r.referred_member_id
        WHERE
          r.referrer_member_id = $1
          AND r.status = 'ACTIVE'
          AND ms.status = 'ACTIVE'
          AND NOW() < ms.ends_at
        `,
        [req.member.id]
      );

    const referrals =
      await pool.query(
        `
        SELECT

          m.username,
          m.pi_uid,
          r.status,
          r.created_at,

          EXISTS (
            SELECT 1
            FROM mining_sessions ms
            WHERE
              ms.member_id = m.id
              AND ms.status = 'ACTIVE'
              AND NOW() < ms.ends_at
          ) AS mining

        FROM referrals r

        JOIN members m
          ON m.id =
             r.referred_member_id

        WHERE
          r.referrer_member_id = $1

        ORDER BY
          r.created_at DESC
        `,
        [req.member.id]
      );

    const referralCount = Number(
      countResult.rows[0]?.count || 0
    );

    const tierInfo = getTierByReferrals(referralCount);

    const code = req.member.username || "";

    res.json({
      ok: true,

      username: code,

      // Multiple field names for frontend compatibility
      referralCode: code,
      code: code,
      inviteCode: code,
      referral_code: code,
      invite_code: code,

      // Referral link (frontend can also build its own)
      referralLink: code ? `https://bonene28.github.io/?ref=${code}` : "",
      referral_link: code ? `https://bonene28.github.io/?ref=${code}` : "",
      link: code ? `https://bonene28.github.io/?ref=${code}` : "",

      referralCount,

      maxDirectReferrals: "UNLIMITED",

      activeMiners: Number(
        activeMiners.rows[0]?.count || 0
      ),

      // Tier system (Bronze → Legend)
      tier: {
        id: tierInfo.current.id,
        name: tierInfo.current.name,
        color: tierInfo.current.color,
        minReferrals: tierInfo.current.minReferrals,
        next: tierInfo.next
          ? {
              id: tierInfo.next.id,
              name: tierInfo.next.name,
              minReferrals: tierInfo.next.minReferrals
            }
          : null,
        referralsToNext: tierInfo.referralsToNext
      },

      tiers: TIER_LEVELS,

      referrals: referrals.rows
    });
  }
);

/* =========================================================
SECURITY CIRCLE
========================================================= */

app.post(
  "/api/security-circle/add",
  requireAuth,
  async (req, res) => {
    const memberId =
      Number(
        req.body?.memberId
      );

    if (
      !Number.isInteger(
        memberId
      )
    ) {
      return res
        .status(400)
        .json({
          ok: false,
          error:
            "Valid memberId is required."
        });
    }

    if (
      memberId ===
      Number(req.member.id)
    ) {
      return res
        .status(400)
        .json({
          ok: false,
          error:
            "You cannot add yourself."
        });
    }

    const client =
      await pool.connect();

    try {
      await client.query(
        "BEGIN"
      );

      const memberCheck =
        await client.query(
          `
          SELECT id
          FROM members
          WHERE id = $1
          LIMIT 1
          `,
          [memberId]
        );

      if (
        !memberCheck.rows.length
      ) {
        throw new HttpError(
          404,
          "Pioneer member was not found."
        );
      }

      const added =
        await addReferralToSecurityCircle(
          client,
          req.member.id,
          memberId
        );

      if (!added) {
        await client.query(
          "ROLLBACK"
        );

        return res
          .status(409)
          .json({
            ok: false,
            error:
              "Security Circle is full. Maximum 5 members."
          });
      }

      await client.query(
        "COMMIT"
      );

      res.json({
        ok: true,
        added: true
      });

    } catch (error) {
      try {
        await client.query(
          "ROLLBACK"
        );
      } catch {}

      console.error(
        "SECURITY ADD ERROR:",
        error
      );

      res
        .status(
          error.status || 500
        )
        .json({
          ok: false,
          error:
            error.message ||
            "Unable to add Security Circle member."
        });

    } finally {
      client.release();
    }
  }
);

app.get(
  "/api/security-circle/status",
  requireAuth,
  async (req, res) => {
    const result =
      await pool.query(
        `
        SELECT

          m.id,
          m.username,
          m.pi_uid,

          sc.status,
          sc.created_at,

          EXISTS (
            SELECT 1
            FROM mining_sessions ms
            WHERE
              ms.member_id = m.id
              AND ms.status = 'ACTIVE'
              AND NOW() < ms.ends_at
          ) AS mining

        FROM security_circle sc

        JOIN members m
          ON m.id =
             sc.member_id

        WHERE
          sc.owner_member_id = $1
          AND sc.status = 'ACTIVE'

        ORDER BY
          sc.created_at ASC
        `,
        [req.member.id]
      );

    res.json({
      ok: true,

      maxMembers:
        MAX_SECURITY_CIRCLE,

      count:
        result.rows.length,

      members:
        result.rows
    });
  }
);

/* =========================================================
STAKING POOLS
========================================================= */

app.get(
  "/api/staking/pools",
  async (req, res) => {
    res.json({
      ok: true,

      network:
        "Pi Testnet",

      environment:
        "TESTNET",

      minimumStake:
        STAKING_MIN_AMOUNT_AMT,

      compounding:
        false,

      pools:
        Object.values(
          STAKING_POOLS
        )
    });
  }
);

/* =========================================================
STAKING STATUS
========================================================= */

app.get(
  "/api/staking/status",
  requireAuth,
  async (req, res) => {
    try {
      const balance =
        await getBalance(
          req.member.id
        );

      const summary =
        await getStakingSummary(
          req.member.id
        );

      const result =
        await pool.query(
          `
          SELECT

            id,
            pool_id,
            principal,
            reward_rate,
            reward_amount,
            started_at,
            unlock_at,
            status,
            unstaked_at,
            created_at

          FROM amt_stakes

          WHERE member_id = $1

          ORDER BY
            created_at DESC

          LIMIT 100
          `,
          [req.member.id]
        );

      const stakes =
        result.rows.map(
          stake => {
            const poolInfo =
              STAKING_POOLS[
                stake.pool_id
              ];

            const unlockTime =
              new Date(
                stake.unlock_at
              ).getTime();

            const unlocked =
              Date.now() >=
              unlockTime;

            const remainingSeconds =
              Math.max(
                0,
                Math.ceil(
                  (
                    unlockTime -
                    Date.now()
                  ) / 1000
                )
              );

            return {
              id:
                stake.id,

              poolId:
                stake.pool_id,

              poolName:
                poolInfo?.name ||
                stake.pool_id,

              lockDays:
                poolInfo?.lockDays ||
                null,

              rewardPercent:
                Number(
                  stake.reward_rate
                ),

              principal:
                Number(
                  stake.principal
                ),

              reward:
                Number(
                  stake.reward_amount
                ),

              totalAtUnlock:
                Number(
                  (
                    Number(
                      stake.principal
                    ) +
                    Number(
                      stake.reward_amount
                    )
                  ).toFixed(8)
                ),

              startedAt:
                stake.started_at,

              unlockAt:
                stake.unlock_at,

              remainingSeconds,

              unlocked,

              status:
                stake.status,

              canUnstake:
                stake.status ===
                  "ACTIVE" &&
                unlocked,

              unstakedAt:
                stake.unstaked_at,

              createdAt:
                stake.created_at
            };
          }
        );

      const portfolioBalance =
        Number(
          (
            balance +
            summary.stakedPrincipal
          ).toFixed(8)
        );

      res.json({
        ok: true,

        network:
          "Pi Testnet",

        environment:
          "TESTNET",

        minimumStake:
          STAKING_MIN_AMOUNT_AMT,

        availableBalance:
          balance,

        stakedPrincipal:
          summary.stakedPrincipal,

        pendingRewards:
          summary.pendingRewards,

        portfolioBalance,

        activeStakeCount:
          stakes.filter(
            stake =>
              stake.status ===
              "ACTIVE"
          ).length,

        pools:
          Object.values(
            STAKING_POOLS
          ),

        stakes
      });

    } catch (error) {
      console.error(
        "STAKING STATUS ERROR:",
        error
      );

      res
        .status(500)
        .json({
          ok: false,
          error:
            "Unable to load staking status."
        });
    }
  }
);

/* =========================================================
CREATE STAKE
========================================================= */

app.post(
  "/api/staking/stake",
  requireAuth,
  async (req, res) => {
    const poolId =
      String(
        req.body?.poolId || ""
      )
        .trim()
        .toUpperCase();

    const amount =
      validAmount(
        req.body?.amount
      );

    const selectedPool =
      STAKING_POOLS[
        poolId
      ];

    if (!selectedPool) {
      return res
        .status(400)
        .json({
          ok: false,
          error:
            "Invalid staking pool."
        });
    }

    if (amount === null) {
      return res
        .status(400)
        .json({
          ok: false,
          error:
            "Invalid AMT amount."
        });
    }

    if (
      amount <
      STAKING_MIN_AMOUNT_AMT
    ) {
      return res
        .status(400)
        .json({
          ok: false,

          error:
            `Minimum stake is ${STAKING_MIN_AMOUNT_AMT} AMT.`
        });
    }

    const client =
      await pool.connect();

    try {
      await client.query(
        "BEGIN"
      );

      await client.query(
        `
        SELECT id
        FROM members
        WHERE id = $1
        FOR UPDATE
        `,
        [req.member.id]
      );

      const balance =
        await getBalance(
          req.member.id,
          client
        );

      if (
        balance < amount
      ) {
        throw new HttpError(
          400,
          "Insufficient AMT balance.",
          {
            balance,
            requested:
              amount
          }
        );
      }

      const rewardRate =
        selectedPool
          .rewardPercent / 100;

      const reward =
        Number(
          (
            amount *
            rewardRate
          ).toFixed(8)
        );

      const startedAt =
        new Date();

      const unlockAt =
        new Date(
          startedAt.getTime() +
          selectedPool.lockDays *
            24 *
            60 *
            60 *
            1000
        );

      const reference =
        makeReference(
          "AMT-STAKE"
        );

      const stakeResult =
        await client.query(
          `
          INSERT INTO amt_stakes
            (
              member_id,
              pool_id,
              principal,
              reward_rate,
              reward_amount,
              started_at,
              unlock_at,
              status
            )
          VALUES
            (
              $1,
              $2,
              $3,
              $4,
              $5,
              $6,
              $7,
              'ACTIVE'
            )

          RETURNING *
          `,
          [
            req.member.id,
            selectedPool.id,
            amount,
            rewardRate,
            reward,
            startedAt,
            unlockAt
          ]
        );

      await client.query(
        `
        INSERT INTO amt_ledger
          (
            member_id,
            amount,
            type,
            reference
          )
        VALUES
          (
            $1,
            $2,
            'STAKING_LOCK',
            $3
          )
        `,
        [
          req.member.id,
          -amount,
          reference
        ]
      );

      await client.query(
        "COMMIT"
      );

      const newBalance =
        await getBalance(
          req.member.id
        );

      res.json({
        ok: true,

        staked:
          true,

        stake: {
          id:
            stakeResult.rows[0].id,

          poolId:
            selectedPool.id,

          poolName:
            selectedPool.name,

          lockDays:
            selectedPool.lockDays,

          principal:
            amount,

          rewardPercent:
            selectedPool.rewardPercent,

          reward,

          totalAtUnlock:
            Number(
              (
                amount +
                reward
              ).toFixed(8)
            ),

          startedAt,

          unlockAt,

          status:
            "ACTIVE"
        },

        balance:
          newBalance,

        network:
          "Pi Testnet",

        environment:
          "TESTNET"
      });

    } catch (error) {
      try {
        await client.query(
          "ROLLBACK"
        );
      } catch {}

      console.error(
        "STAKE ERROR:",
        error
      );

      res
        .status(
          error.status || 500
        )
        .json({
          ok: false,

          error:
            error.message ||
            "Unable to create stake.",

          ...(error.extra || {})
        });

    } finally {
      client.release();
    }
  }
);

/* =========================================================
UNSTAKE
========================================================= */

app.post(
  "/api/staking/unstake",
  requireAuth,
  async (req, res) => {
    const stakeId =
      Number(
        req.body?.stakeId
      );

    if (
      !Number.isInteger(
        stakeId
      ) ||
      stakeId <= 0
    ) {
      return res
        .status(400)
        .json({
          ok: false,
          error:
            "Valid stakeId is required."
        });
    }

    const client =
      await pool.connect();

    try {
      await client.query(
        "BEGIN"
      );

      await client.query(
        `
        SELECT id
        FROM members
        WHERE id = $1
        FOR UPDATE
        `,
        [req.member.id]
      );

      const stakeResult =
        await client.query(
          `
          SELECT *
          FROM amt_stakes
          WHERE
            id = $1
            AND member_id = $2
          FOR UPDATE
          `,
          [
            stakeId,
            req.member.id
          ]
        );

      if (
        !stakeResult.rows.length
      ) {
        throw new HttpError(
          404,
          "Stake not found."
        );
      }

      const stake =
        stakeResult.rows[0];

      if (
        stake.status !==
        "ACTIVE"
      ) {
        throw new HttpError(
          409,
          "This stake has already been processed."
        );
      }

      const unlockTime =
        new Date(
          stake.unlock_at
        ).getTime();

      if (
        Date.now() <
        unlockTime
      ) {
        throw new HttpError(
          400,
          "Stake is still locked.",
          {
            unlockAt:
              stake.unlock_at,

            remainingSeconds:
              Math.ceil(
                (
                  unlockTime -
                  Date.now()
                ) / 1000
              )
          }
        );
      }

      const principal =
        Number(
          stake.principal
        );

      const reward =
        Number(
          stake.reward_amount
        );

      const total =
        Number(
          (
            principal +
            reward
          ).toFixed(8)
        );

      const reference =
        makeReference(
          "AMT-UNSTAKE"
        );

      await client.query(
        `
        INSERT INTO amt_ledger
          (
            member_id,
            amount,
            type,
            reference
          )
        VALUES
          (
            $1,
            $2,
            'STAKING_PAYOUT',
            $3
          )
        `,
        [
          req.member.id,
          total,
          reference
        ]
      );

      await client.query(
        `
        UPDATE amt_stakes
        SET
          status = 'COMPLETED',
          unstaked_at = NOW()
        WHERE id = $1
        `,
        [stakeId]
      );

      await client.query(
        "COMMIT"
      );

      const balance =
        await getBalance(
          req.member.id
        );

      res.json({
        ok: true,

        unstaked:
          true,

        stakeId,

        principal,

        reward,

        total,

        reference,

        balance,

        status:
          "COMPLETED",

        network:
          "Pi Testnet",

        environment:
          "TESTNET"
      });

    } catch (error) {
      try {
        await client.query(
          "ROLLBACK"
        );
      } catch {}

      console.error(
        "UNSTAKE ERROR:",
        error
      );

      res
        .status(
          error.status || 500
        )
        .json({
          ok: false,

          error:
            error.message ||
            "Unable to unstake.",

          ...(error.extra || {})
        });

    } finally {
      client.release();
    }
  }
);

/* =========================================================
STAKING HISTORY
========================================================= */

app.get(
  "/api/staking/history",
  requireAuth,
  async (req, res) => {
    try {
      const result =
        await pool.query(
          `
          SELECT

            id,
            pool_id,
            principal,
            reward_rate,
            reward_amount,
            started_at,
            unlock_at,
            status,
            unstaked_at,
            created_at

          FROM amt_stakes

          WHERE member_id = $1

          ORDER BY
            created_at DESC

          LIMIT 100
          `,
          [req.member.id]
        );

      const history =
        result.rows.map(
          stake => ({
            id:
              stake.id,

            poolId:
              stake.pool_id,

            pool:
              STAKING_POOLS[
                stake.pool_id
              ] || null,

            principal:
              Number(
                stake.principal
              ),

            rewardPercent:
              Number(
                stake.reward_rate
              ),

            reward:
              Number(
                stake.reward_amount
              ),

            total:
              Number(
                (
                  Number(
                    stake.principal
                  ) +
                  Number(
                    stake.reward_amount
                  )
                ).toFixed(8)
              ),

            startedAt:
              stake.started_at,

            unlockAt:
              stake.unlock_at,

            status:
              stake.status,

            unstakedAt:
              stake.unstaked_at,

            createdAt:
              stake.created_at
          })
        );

      res.json({
        ok: true,

        network:
          "Pi Testnet",

        history
      });

    } catch (error) {
      console.error(
        "STAKING HISTORY ERROR:",
        error
      );

      res
        .status(500)
        .json({
          ok: false,
          error:
            "Unable to load staking history."
        });
    }
  }
);

/* =========================================================
PRIVATE PI TESTNET MARKETPLACE
========================================================= */

app.get(
  "/api/market/test-product",
  async (req, res) => {
    res.json({
      ok: true,

      product: {
        id:
          MARKET_TEST_PRODUCT_ID,

        name:
          "AMT Test Pet",

        description:
          "Private AMT Pi Testnet marketplace test item.",

        pricePi:
          MARKET_TEST_PRICE_PI,

        currency:
          "Pi",

        network:
          "Pi Testnet",

        environment:
          "TESTNET"
      }
    });
  }
);

/* =========================================================
PI PAYMENT API
========================================================= */

async function piPaymentRequest(
  path,
  method = "GET",
  body = null
) {
  if (!PI_API_KEY) {
    throw new Error(
      "PI_API_KEY is not configured."
    );
  }

  const response =
    await fetch(
      `${PI_PAYMENT_API_BASE}${path}`,
      {
        method,

        headers: {
          Accept:
            "application/json",

          "Content-Type":
            "application/json",

          Authorization:
            `Key ${PI_API_KEY}`
        },

        body:
          body === null
            ? undefined
            : JSON.stringify(body)
      }
    );

  const text =
    await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    data = {
      raw: text
    };
  }

  if (!response.ok) {
    const error =
      new Error(
        data?.error ||
        data?.message ||
        `Pi Payment API error ${response.status}`
      );

    error.status =
      response.status;

    throw error;
  }

  return data;
}

/* =========================================================
MARKETPLACE PAYMENT APPROVE
========================================================= */

app.post(
  "/api/market/payment/approve",
  requireAuth,
  async (req, res) => {
    try {
      const paymentId =
        String(
          req.body?.paymentId || ""
        ).trim();

      const productId =
        String(
          req.body?.productId || ""
        ).trim();

      const amount =
        Number(
          req.body?.amount
        );

      if (!paymentId) {
        return res
          .status(400)
          .json({
            ok: false,
            error:
              "Payment ID is required."
          });
      }

      if (
        productId !==
        MARKET_TEST_PRODUCT_ID
      ) {
        return res
          .status(400)
          .json({
            ok: false,
            error:
              "Invalid test product."
          });
      }

      if (
        !Number.isFinite(amount) ||
        amount !==
          MARKET_TEST_PRICE_PI
      ) {
        return res
          .status(400)
          .json({
            ok: false,
            error:
              "Invalid test price."
          });
      }

      const payment =
        await piPaymentRequest(
          `/v2/payments/${encodeURIComponent(
            paymentId
          )}`,
          "GET"
        );

      if (
        Number(
          payment.amount
        ) !==
        MARKET_TEST_PRICE_PI
      ) {
        return res
          .status(400)
          .json({
            ok: false,
            error:
              "Payment amount does not match test product."
          });
      }

      await piPaymentRequest(
        `/v2/payments/${encodeURIComponent(
          paymentId
        )}/approve`,
        "POST"
      );

      const saved =
        await pool.query(
          `
          INSERT INTO marketplace_payments
            (
              pi_payment_id,
              member_id,
              product_id,
              amount,
              status
            )
          VALUES
            (
              $1,
              $2,
              $3,
              $4,
              'APPROVED'
            )

          ON CONFLICT (
            pi_payment_id
          )

          DO UPDATE SET
            status = 'APPROVED'

          RETURNING *
          `,
          [
            paymentId,
            req.member.id,
            productId,
            amount
          ]
        );

      res.json({
        ok: true,

        approved:
          true,

        payment:
          saved.rows[0]
      });

    } catch (error) {
      console.error(
        "MARKET APPROVE ERROR:",
        error
      );

      res
        .status(
          error.status || 500
        )
        .json({
          ok: false,
          error:
            error.message ||
            "Unable to approve payment."
        });
    }
  }
);

/* =========================================================
MARKETPLACE PAYMENT COMPLETE
========================================================= */

app.post(
  "/api/market/payment/complete",
  requireAuth,
  async (req, res) => {
    const client =
      await pool.connect();

    try {
      const paymentId =
        String(
          req.body?.paymentId || ""
        ).trim();

      if (!paymentId) {
        return res
          .status(400)
          .json({
            ok: false,
            error:
              "Payment ID is required."
          });
      }

      await client.query(
        "BEGIN"
      );

      const paymentResult =
        await client.query(
          `
          SELECT *
          FROM marketplace_payments
          WHERE
            pi_payment_id = $1
          LIMIT 1
          FOR UPDATE
          `,
          [paymentId]
        );

      if (
        !paymentResult.rows.length
      ) {
        await client.query(
          "ROLLBACK"
        );

        return res
          .status(404)
          .json({
            ok: false,
            error:
              "Marketplace payment not found."
          });
      }

      const payment =
        paymentResult.rows[0];

      if (
        Number(
          payment.member_id
        ) !==
        Number(
          req.member.id
        )
      ) {
        await client.query(
          "ROLLBACK"
        );

        return res
          .status(403)
          .json({
            ok: false,
            error:
              "Payment does not belong to this Pioneer."
          });
      }

      if (
        payment.product_id !==
        MARKET_TEST_PRODUCT_ID
      ) {
        await client.query(
          "ROLLBACK"
        );

        return res
          .status(400)
          .json({
            ok: false,
            error:
              "Invalid marketplace product."
          });
      }

      if (
        payment.status ===
        "COMPLETED"
      ) {
        await client.query(
          "COMMIT"
        );

        return res.json({
          ok: true,

          completed:
            true,

          alreadyCompleted:
            true,

          paymentId,

          productId:
            payment.product_id,

          network:
            "Pi Testnet"
        });
      }

      await piPaymentRequest(
        `/v2/payments/${encodeURIComponent(
          paymentId
        )}/complete`,
        "POST"
      );

      await client.query(
        `
        UPDATE marketplace_payments
        SET
          status = 'COMPLETED',
          completed_at = NOW()
        WHERE id = $1
        `,
        [payment.id]
      );

      await client.query(
        `
        INSERT INTO marketplace_purchases
          (
            payment_id,
            member_id,
            product_id
          )
        VALUES
          (
            $1,
            $2,
            $3
          )

        ON CONFLICT DO NOTHING
        `,
        [
          payment.id,
          req.member.id,
          payment.product_id
        ]
      );

      await client.query(
        "COMMIT"
      );

      res.json({
        ok: true,

        completed:
          true,

        paymentId,

        productId:
          payment.product_id,

        network:
          "Pi Testnet"
      });

    } catch (error) {
      try {
        await client.query(
          "ROLLBACK"
        );
      } catch {}

      console.error(
        "MARKET COMPLETE ERROR:",
        error
      );

      res
        .status(
          error.status || 500
        )
        .json({
          ok: false,
          error:
            error.message ||
            "Unable to complete payment."
        });

    } finally {
      client.release();
    }
  }
);

/* =========================================================
PURCHASES
========================================================= */

app.get(
  "/api/purchases",
  requireAuth,
  async (req, res) => {
    const result =
      await pool.query(
        `
        SELECT

          mp.id,
          mp.product_id,
          mp.created_at,

          p.pi_payment_id,
          p.amount,
          p.status

        FROM marketplace_purchases mp

        JOIN marketplace_payments p
          ON p.id =
             mp.payment_id

        WHERE
          mp.member_id = $1

        ORDER BY
          mp.created_at DESC
        `,
        [req.member.id]
      );

    res.json({
      ok: true,

      purchases:
        result.rows
    });
  }
);

/* =========================================================
LEGACY / FRONTEND COMPATIBILITY ROUTES
========================================================= */

/* ---------------------------------------------------------
POST /api/users
--------------------------------------------------------- */

app.post(
  "/api/users",
  requireAuth,
  async (req, res) => {
    try {
      const balance =
        await getBalance(
          req.member.id
        );

      const staking =
        await getStakingSummary(
          req.member.id
        );

      res.json({
        ok: true,

        user: {
          id:
            req.member.id,

          uid:
            req.piUser.uid,

          username:
            req.member.username,

          kycStatus:
            req.member.kyc_status,

          profileImage:
            req.member
              .profile_image || null
        },

        wallet: {
          walletStatus:
            req.wallet
              .wallet_status,

          walletAddress:
            req.wallet
              .wallet_address,

          isBlockchainWallet:
            false
        },

        /*
         * Added without changing the old wallet object.
         */
        piWalletAddress:
          req.piUser.walletAddress ||
          null,

        balance,

        availableBalance:
          balance,

        stakedBalance:
          staking.stakedPrincipal,

        pendingStakingRewards:
          staking.pendingRewards,

        network:
          "Pi Testnet",

        environment:
          "TESTNET",

        // Referral code of this Pioneer (same as username)
        referralCode:
          req.member.username ||
          req.piUser.username ||
          null
      });

    } catch (error) {
      console.error(
        "USERS COMPATIBILITY ERROR:",
        error
      );

      res
        .status(500)
        .json({
          ok: false,
          error:
            "Unable to load Pioneer account."
        });
    }
  }
);

/* ---------------------------------------------------------
GET /api/balance
--------------------------------------------------------- */

app.get(
  "/api/balance",
  requireAuth,
  async (req, res) => {
    try {
      const balance =
        await getBalance(
          req.member.id
        );

      const staking =
        await getStakingSummary(
          req.member.id
        );

      res.json({
        ok: true,

        balance,

        availableBalance:
          balance,

        stakedBalance:
          staking.stakedPrincipal,

        pendingStakingRewards:
          staking.pendingRewards,

        totalBalance:
          Number(
            (
              balance +
              staking.stakedPrincipal
            ).toFixed(8)
          ),

        symbol:
          "AMT",

        network:
          "Pi Testnet",

        walletAddress:
          req.wallet
            .wallet_address,

        piWalletAddress:
          req.piUser.walletAddress ||
          null
      });

    } catch (error) {
      console.error(
        "BALANCE COMPATIBILITY ERROR:",
        error
      );

      res
        .status(500)
        .json({
          ok: false,
          error:
            "Unable to load AMT balance."
        });
    }
  }
);

/* ---------------------------------------------------------
POST /api/ledger/send
--------------------------------------------------------- */

app.post(
  "/api/ledger/send",
  requireAuth,
  async (req, res) => {
    const recipientAddress =
      String(
        req.body?.recipientAddress ||
        req.body?.to ||
        req.body?.recipient ||
        ""
      )
        .trim()
        .toUpperCase();

    const amount =
      validAmount(
        req.body?.amount
      );

    const memo =
      String(
        req.body?.memo || ""
      )
        .trim()
        .slice(0, 160);

    if (!recipientAddress) {
      return res
        .status(400)
        .json({
          ok: false,
          error:
            "Recipient AMT address is required."
        });
    }

    if (amount === null) {
      return res
        .status(400)
        .json({
          ok: false,
          error:
            "Invalid amount. Maximum 8 decimal places."
        });
    }

    try {
      const result =
        await performAmtTransfer(
          req.member,
          recipientAddress,
          amount,
          memo
        );

      res.json({
        ok: true,

        ...result,

        network:
          "Pi Testnet",

        walletType:
          "AMT_TESTNET_LEDGER"
      });

    } catch (error) {
      console.error(
        "LEDGER SEND COMPATIBILITY ERROR:",
        error
      );

      res
        .status(
          error.status || 500
        )
        .json({
          ok: false,

          error:
            error.message ||
            "AMT transfer failed.",

          ...(error.extra || {})
        });
    }
  }
);

/* ---------------------------------------------------------
GET /api/referrals
--------------------------------------------------------- */

app.get(
  "/api/referrals",
  requireAuth,
  async (req, res) => {
    try {
      const result =
        await pool.query(
          `
          SELECT

            r.id,

            r.status,

            r.created_at,

            m.id AS member_id,

            m.username,

            m.pi_uid

          FROM referrals r

          JOIN members m
            ON m.id =
               r.referred_member_id

          WHERE
            r.referrer_member_id = $1

          ORDER BY
            r.created_at DESC
          `,
          [req.member.id]
        );

      res.json({
        ok: true,

        count:
          result.rows.length,

        referralCount:
          result.rows.length,

        referrals:
          result.rows
      });

    } catch (error) {
      console.error(
        "REFERRALS COMPATIBILITY ERROR:",
        error
      );

      res
        .status(500)
        .json({
          ok: false,
          error:
            "Unable to load referrals."
        });
    }
  }
);

/* ---------------------------------------------------------
POST /api/referrals/apply
--------------------------------------------------------- */

app.post(
  "/api/referrals/apply",
  requireAuth,
  async (req, res) => {
    const referralMemberId =
      Number(
        req.body?.referralMemberId ??
        req.body?.memberId
      );

    if (
      !Number.isInteger(
        referralMemberId
      )
    ) {
      return res
        .status(400)
        .json({
          ok: false,
          error:
            "Valid referralMemberId is required."
        });
    }

    if (
      referralMemberId ===
      Number(req.member.id)
    ) {
      return res
        .status(400)
        .json({
          ok: false,
          error:
            "You cannot refer yourself."
        });
    }

    const client =
      await pool.connect();

    try {
      await client.query(
        "BEGIN"
      );

      const referredMember =
        await client.query(
          `
          SELECT
            id,
            username,
            pi_uid
          FROM members
          WHERE id = $1
          LIMIT 1
          `,
          [referralMemberId]
        );

      if (
        !referredMember.rows.length
      ) {
        throw new HttpError(
          404,
          "Referral Pioneer was not found."
        );
      }

      const existing =
        await client.query(
          `
          SELECT
            id,
            referrer_member_id,
            referred_member_id,
            status
          FROM referrals
          WHERE
            referred_member_id = $1
          LIMIT 1
          FOR UPDATE
          `,
          [referralMemberId]
        );

      if (
        existing.rows.length
      ) {
        await client.query(
          "ROLLBACK"
        );

        return res
          .status(409)
          .json({
            ok: false,
            error:
              "This Pioneer already has a referrer."
          });
      }

      await client.query(
        `
        INSERT INTO referrals
          (
            referrer_member_id,
            referred_member_id,
            status
          )
        VALUES
          (
            $1,
            $2,
            'ACTIVE'
          )
        `,
        [
          req.member.id,
          referralMemberId
        ]
      );

      const addedToCircle =
        await addReferralToSecurityCircle(
          client,
          req.member.id,
          referralMemberId
        );

      await client.query(
        "COMMIT"
      );

      res.json({
        ok: true,

        applied:
          true,

        linked:
          true,

        referralMemberId,

        addedToSecurityCircle:
          addedToCircle
      });

    } catch (error) {
      try {
        await client.query(
          "ROLLBACK"
        );
      } catch {}

      console.error(
        "REFERRAL APPLY ERROR:",
        error
      );

      res
        .status(
          error.status || 500
        )
        .json({
          ok: false,

          error:
            error.message ||
            "Unable to apply referral."
        });

    } finally {
      client.release();
    }
  }
);

/* ---------------------------------------------------------
GET /api/security-circle
--------------------------------------------------------- */

app.get(
  "/api/security-circle",
  requireAuth,
  async (req, res) => {
    try {
      const result =
        await pool.query(
          `
          SELECT

            m.id,

            m.username,

            m.pi_uid,

            sc.status,

            sc.created_at,

            EXISTS (
              SELECT 1
              FROM mining_sessions ms
              WHERE
                ms.member_id = m.id
                AND ms.status = 'ACTIVE'
                AND NOW() < ms.ends_at
            ) AS mining

          FROM security_circle sc

          JOIN members m
            ON m.id =
               sc.member_id

          WHERE
            sc.owner_member_id = $1
            AND sc.status = 'ACTIVE'

          ORDER BY
            sc.created_at ASC
          `,
          [req.member.id]
        );

      res.json({
        ok: true,

        maxMembers:
          MAX_SECURITY_CIRCLE,

        count:
          result.rows.length,

        members:
          result.rows
      });

    } catch (error) {
      console.error(
        "SECURITY CIRCLE COMPATIBILITY ERROR:",
        error
      );

      res
        .status(500)
        .json({
          ok: false,
          error:
            "Unable to load Security Circle."
        });
    }
  }
);

/* ---------------------------------------------------------
POST /api/profile/image
--------------------------------------------------------- */

app.post(
  "/api/profile/image",
  requireAuth,
  async (req, res) => {
    try {
      const image =
        String(
          req.body?.image || ""
        ).trim();

      if (!image) {
        return res
          .status(400)
          .json({
            ok: false,
            error:
              "Profile image is required."
          });
      }

      if (
        !image.startsWith(
          "data:image/"
        )
      ) {
        return res
          .status(400)
          .json({
            ok: false,
            error:
              "Invalid image format."
          });
      }

      // Allow up to ~2.5MB base64 image
      if (
        image.length > 2500000
      ) {
        return res
          .status(413)
          .json({
            ok: false,
            error:
              "Profile image is too large. Maximum allowed is about 2MB."
          });
      }

      await pool.query(
        `
        UPDATE members
        SET
          profile_image = $1,
          updated_at = NOW()
        WHERE id = $2
        `,
        [
          image,
          req.member.id
        ]
      );

      res.json({
        ok: true,

        profileImage:
          image
      });

    } catch (error) {
      console.error(
        "PROFILE IMAGE ERROR:",
        error
      );

      res
        .status(500)
        .json({
          ok: false,
          error:
            "Unable to save profile image."
        });
    }
  }
);

/* ---------------------------------------------------------
DELETE /api/profile/image
--------------------------------------------------------- */

app.delete(
  "/api/profile/image",
  requireAuth,
  async (req, res) => {
    try {
      await pool.query(
        `
        UPDATE members
        SET
          profile_image = NULL,
          updated_at = NOW()
        WHERE id = $1
        `,
        [req.member.id]
      );

      res.json({
        ok: true,

        profileImage:
          null
      });

    } catch (error) {
      console.error(
        "DELETE PROFILE IMAGE ERROR:",
        error
      );

      res
        .status(500)
        .json({
          ok: false,
          error:
            "Unable to remove profile image."
        });
    }
  }
);

/* =========================================================
PETS — catalog, care, skills, food shop, feed-all, outpost war
========================================================= */

const PET_SKILLS = {
  Fire:    { name: "Blaze Strike", power: 18 },
  Water:   { name: "Tidal Wave", power: 16 },
  Earth:   { name: "Stone Guard", power: 14 },
  Nature:  { name: "Vine Bind", power: 15 },
  Ice:     { name: "Frost Bite", power: 17 },
  Wind:    { name: "Gale Slash", power: 15 },
  Thunder: { name: "Thunder Shock", power: 19 }
};

/* image = exact filename on GitHub (bonene28.github.io) */
const PET_SHOP_DEFAULTS = [
  { slug: "ember-pup", name: "Ember Pup", element: "Fire", rarity: "Common", price: 2, hp: 90, atk: 28, def: 12, spd: 18, image: "03_ember_fire_common_lv1.png" },
  { slug: "tide-cub", name: "Tide Cub", element: "Water", rarity: "Common", price: 2, hp: 100, atk: 22, def: 16, spd: 16, image: "05_tide_water_common_lv1.png" },
  { slug: "moss-kit", name: "Moss Kit", element: "Nature", rarity: "Common", price: 2, hp: 95, atk: 20, def: 18, spd: 14, image: "06_moss_nature_common_lv1.png" },
  { slug: "pebble-pup", name: "Pebble Pup", element: "Earth", rarity: "Common", price: 2, hp: 110, atk: 18, def: 22, spd: 12, image: "01_terra_earth_common_lv1.png" },
  { slug: "frost-kit", name: "Frost Kit", element: "Ice", rarity: "Rare", price: 5, hp: 100, atk: 26, def: 14, spd: 20, image: "01_frosty_ice_common_lv1.png" },
  { slug: "gale-fox", name: "Gale Fox", element: "Wind", rarity: "Rare", price: 5, hp: 85, atk: 24, def: 12, spd: 28, image: "04_gale_wind_common_lv1.png" },
  { slug: "spark-lynx", name: "Spark Lynx", element: "Thunder", rarity: "Rare", price: 5, hp: 90, atk: 30, def: 12, spd: 22, image: "01_bolt_thunder_common_lv1.png" },
  { slug: "inferno-wolf", name: "Inferno Wolf", element: "Fire", rarity: "Epic", price: 15, hp: 120, atk: 38, def: 18, spd: 24, image: "04_inferno_fire_common_lv1.png" }
];

const FOOD_SHOP = {
  food: { key: "food", name: "Pet Food", price: 0.15, hunger: 35, happiness: 5 },
  water: { key: "water", name: "Fresh Water", price: 0.10, hunger: 15, happiness: 8 },
  premium_meal: { key: "premium_meal", name: "Premium Meal", price: 0.50, hunger: 70, happiness: 20 }
};

function skillForElement(element) {
  return PET_SKILLS[element] || { name: "Basic Strike", power: 10 };
}

function applyHungerDecay(pet) {
  const last = new Date(pet.last_fed_at || pet.created_at || Date.now()).getTime();
  const hours = Math.max(0, (Date.now() - last) / (1000 * 60 * 60));
  const decay = Math.floor(hours * 3); // ~3 hunger per hour
  const hunger = Math.max(0, Math.min(100, Number(pet.hunger) - decay));
  return { ...pet, hunger };
}

function serializePet(row) {
  const p = applyHungerDecay(row);
  return {
    id: Number(p.id),
    name: p.name,
    element: p.element,
    rarity: p.rarity,
    level: Number(p.level),
    xp: Number(p.xp),
    hp: Number(p.hp),
    atk: Number(p.atk),
    def: Number(p.def),
    spd: Number(p.spd),
    energy: Number(p.energy),
    happiness: Number(p.happiness),
    hunger: Number(p.hunger),
    skill: {
      name: p.skill_name,
      power: Number(p.skill_power),
      level: Number(p.skill_level || 1)
    },
    skill_name: p.skill_name,
    skill_power: Number(p.skill_power),
    skill_level: Number(p.skill_level || 1),
    image: p.image || "",
    is_listed: !!p.is_listed,
    last_fed_at: p.last_fed_at,
    created_at: p.created_at
  };
}

async function ensurePetCatalog() {
  for (const p of PET_SHOP_DEFAULTS) {
    const sk = skillForElement(p.element);
    await pool.query(
      `
      INSERT INTO pet_catalog
        (slug, name, element, rarity, base_hp, base_atk, base_def, base_spd, price_amt, skill_name, skill_power, image)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      ON CONFLICT (slug) DO UPDATE SET
        name = EXCLUDED.name,
        element = EXCLUDED.element,
        rarity = EXCLUDED.rarity,
        base_hp = EXCLUDED.base_hp,
        base_atk = EXCLUDED.base_atk,
        base_def = EXCLUDED.base_def,
        base_spd = EXCLUDED.base_spd,
        price_amt = EXCLUDED.price_amt,
        skill_name = EXCLUDED.skill_name,
        skill_power = EXCLUDED.skill_power,
        image = EXCLUDED.image
      `,
      [p.slug, p.name, p.element, p.rarity, p.hp, p.atk, p.def, p.spd, p.price, sk.name, sk.power, p.image || ""]
    );
  }
}

async function ensurePetInventory(memberId, db = pool) {
  await db.query(
    `
    INSERT INTO pet_inventory (member_id, food, water, premium_meal)
    VALUES ($1, 0, 0, 0)
    ON CONFLICT (member_id) DO NOTHING
    `,
    [memberId]
  );
  const r = await db.query(`SELECT * FROM pet_inventory WHERE member_id = $1`, [memberId]);
  return r.rows[0];
}

async function loadOwnedPet(memberId, ownedPetId, db = pool) {
  const r = await db.query(
    `SELECT * FROM owned_pets WHERE id = $1 AND member_id = $2 LIMIT 1`,
    [ownedPetId, memberId]
  );
  return r.rows[0] || null;
}

function petPower(pet) {
  return Number(pet.hp) + Number(pet.atk) * 2 + Number(pet.def) + Number(pet.spd) + Number(pet.skill_power || 0) * Number(pet.skill_level || 1);
}

// Seed catalog on boot (called from startServer path via init)
async function seedPetsIfNeeded() {
  try {
    await ensurePetCatalog();
  } catch (e) {
    console.error("PET CATALOG SEED ERROR:", e.message);
  }
}

/* Shop catalog */
app.get("/api/pets", requireAuth, async (req, res) => {
  try {
    await ensurePetCatalog();
    const r = await pool.query(
      `SELECT * FROM pet_catalog WHERE active = TRUE ORDER BY price_amt ASC, id ASC`
    );
    res.json({
      ok: true,
      pets: r.rows.map((c) => ({
        id: Number(c.id),
        slug: c.slug,
        name: c.name,
        element: c.element,
        rarity: c.rarity,
        hp: c.base_hp,
        atk: c.base_atk,
        def: c.base_def,
        spd: c.base_spd,
        price: Number(c.price_amt),
        price_amt: Number(c.price_amt),
        priceAmt: Number(c.price_amt),
        pricePi: petPriceInTestPi(c.rarity),
        image: c.image || "",
        skill: { name: c.skill_name, power: c.skill_power }
      }))
    });
  } catch (e) {
    console.error("PETS SHOP ERROR:", e);
    res.status(500).json({ ok: false, error: e.message || "Unable to load pets." });
  }
});

/* Owned pets */
app.get("/api/pets/owned", requireAuth, async (req, res) => {
  try {
    // Auto-recover missing pets from completed Test-π payments
    try {
      const missing = await pool.query(
        `
        SELECT mp.*
        FROM marketplace_payments mp
        WHERE mp.member_id = $1
          AND mp.product_id LIKE 'pet-%'
          AND mp.status IN ('COMPLETED', 'APPROVED')
          AND NOT EXISTS (
            SELECT 1 FROM marketplace_purchases pr
            WHERE pr.payment_id = mp.id AND pr.member_id = $1
          )
        ORDER BY mp.id ASC
        LIMIT 10
        `,
        [req.member.id]
      );

      for (const payment of missing.rows) {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          if (payment.status !== "COMPLETED") {
            await client.query(
              `UPDATE marketplace_payments SET status = 'COMPLETED', completed_at = COALESCE(completed_at, NOW()) WHERE id = $1`,
              [payment.id]
            );
          }
          await deliverPetFromPayment(client, req.member.id, payment, null);
          await client.query("COMMIT");
        } catch (err) {
          try { await client.query("ROLLBACK"); } catch {}
          console.error("AUTO-RECOVER PET:", err.message || err);
        } finally {
          client.release();
        }
      }
    } catch (recErr) {
      console.error("AUTO-RECOVER SCAN:", recErr.message || recErr);
    }

    const r = await pool.query(
      `SELECT * FROM owned_pets WHERE member_id = $1 AND is_listed = FALSE ORDER BY id DESC`,
      [req.member.id]
    );
    // persist decayed hunger lightly
    const pets = [];
    for (const row of r.rows) {
      const s = serializePet(row);
      if (s.hunger !== Number(row.hunger)) {
        await pool.query(`UPDATE owned_pets SET hunger = $1 WHERE id = $2`, [s.hunger, row.id]);
      }
      pets.push(s);
    }
    res.json({ ok: true, pets });
  } catch (e) {
    console.error("OWNED PETS ERROR:", e);
    res.status(500).json({ ok: false, error: e.message || "Unable to load owned pets." });
  }
});

/* Buy from shop */
app.post("/api/pets/buy", requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    await ensurePetCatalog();
    const catalogId = Number(req.body?.catalogId ?? req.body?.petId ?? req.body?.id);
    if (!Number.isInteger(catalogId)) {
      return res.status(400).json({ ok: false, error: "Valid pet id is required." });
    }

    await client.query("BEGIN");
    const cat = await client.query(`SELECT * FROM pet_catalog WHERE id = $1 AND active = TRUE`, [catalogId]);
    if (!cat.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "Pet not found in shop." });
    }
    const c = cat.rows[0];
    const price = Number(c.price_amt);
    const bal = await getBalance(req.member.id, client);
    if (bal < price) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        ok: false,
        error: `Not enough AMT. Need ${price} AMT, you have ${bal} AMT.`,
        required: price,
        balance: bal
      });
    }

    const ref = makeReference("AMT-PET-BUY");
    await client.query(
      `INSERT INTO amt_ledger (member_id, amount, type, reference) VALUES ($1,$2,'PET_PURCHASE',$3)`,
      [req.member.id, -price, ref]
    );

    const sk = skillForElement(c.element);
    const ins = await client.query(
      `
      INSERT INTO owned_pets
        (member_id, catalog_id, name, element, rarity, hp, atk, def, spd, skill_name, skill_power, image, hunger, energy, happiness)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,100,100,100)
      RETURNING *
      `,
      [req.member.id, c.id, c.name, c.element, c.rarity, c.base_hp, c.base_atk, c.base_def, c.base_spd, c.skill_name || sk.name, c.skill_power || sk.power, c.image || ""]
    );

    await client.query("COMMIT");
    const newBal = await getBalance(req.member.id);
    res.json({
      ok: true,
      purchased: true,
      paid: price,
      pet: serializePet(ins.rows[0]),
      balance: newBal,
      message: `Purchased ${c.name} for ${price} AMT`
    });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    console.error("PET BUY ERROR:", e);
    res.status(500).json({ ok: false, error: e.message || "Buy failed." });
  } finally {
    client.release();
  }
});

/** Test-Pi price by rarity */
function petPriceInTestPi(rarity) {
  const r = String(rarity || "Common").toLowerCase();
  if (r.includes("epic") || r.includes("legend")) return 0.5;
  if (r.includes("rare")) return 0.25;
  return 0.1;
}

/* Buy pet with Test-Pi — approve */
app.post("/api/pets/payment/approve", requireAuth, async (req, res) => {
  try {
    const paymentId = String(req.body?.paymentId || "").trim();
    const catalogId = Number(req.body?.catalogId ?? req.body?.petId);
    const amount = Number(req.body?.amount);
    const productId = String(req.body?.productId || `pet-${catalogId}`).trim();

    if (!paymentId) {
      return res.status(400).json({ ok: false, error: "Payment ID is required." });
    }
    if (!Number.isInteger(catalogId)) {
      return res.status(400).json({ ok: false, error: "Valid catalogId is required." });
    }

    await ensurePetCatalog();
    const cat = await pool.query(
      `SELECT * FROM pet_catalog WHERE id = $1 AND active = TRUE`,
      [catalogId]
    );
    if (!cat.rows.length) {
      return res.status(404).json({ ok: false, error: "Pet not found in shop." });
    }

    const expected = petPriceInTestPi(cat.rows[0].rarity);
    if (!Number.isFinite(amount) || Math.abs(amount - expected) > 0.0001) {
      return res.status(400).json({
        ok: false,
        error: `Invalid Test-π price. Expected ${expected} π`
      });
    }

    const payment = await piPaymentRequest(
      `/v2/payments/${encodeURIComponent(paymentId)}`,
      "GET"
    );

    if (Math.abs(Number(payment.amount) - expected) > 0.0001) {
      return res.status(400).json({
        ok: false,
        error: "Payment amount does not match pet Test-π price."
      });
    }

    await piPaymentRequest(
      `/v2/payments/${encodeURIComponent(paymentId)}/approve`,
      "POST"
    );

    await pool.query(
      `
      INSERT INTO marketplace_payments
        (pi_payment_id, member_id, product_id, amount, status)
      VALUES ($1, $2, $3, $4, 'APPROVED')
      ON CONFLICT (pi_payment_id)
      DO UPDATE SET status = 'APPROVED'
      `,
      [paymentId, req.member.id, productId, expected]
    );

    res.json({ ok: true, approved: true, paymentId, catalogId, amount: expected });
  } catch (error) {
    console.error("PET PI APPROVE ERROR:", error);
    res.status(error.status || 500).json({
      ok: false,
      error: error.message || "Unable to approve pet payment."
    });
  }
});

/** Deliver owned pet from a marketplace payment row (idempotent via purchases table) */
async function deliverPetFromPayment(client, memberId, payment, catalogIdHint) {
  // Already delivered?
  const existing = await client.query(
    `
    SELECT id FROM marketplace_purchases
    WHERE payment_id = $1 AND member_id = $2
    LIMIT 1
    `,
    [payment.id, memberId]
  );

  let resolvedCatalogId = Number(catalogIdHint);
  if (!Number.isInteger(resolvedCatalogId) || resolvedCatalogId <= 0) {
    const m = String(payment.product_id || "").match(/^pet-(\d+)$/i);
    if (m) resolvedCatalogId = Number(m[1]);
  }

  if (!Number.isInteger(resolvedCatalogId) || resolvedCatalogId <= 0) {
    throw new HttpError(400, "Cannot resolve pet catalog id from payment.");
  }

  const cat = await client.query(
    `SELECT * FROM pet_catalog WHERE id = $1 AND active = TRUE`,
    [resolvedCatalogId]
  );
  if (!cat.rows.length) {
    throw new HttpError(404, "Pet not found in shop (catalog #" + resolvedCatalogId + ").");
  }

  const c = cat.rows[0];

  // If purchase already recorded, try to return an owned pet with same catalog
  if (existing.rows.length) {
    const owned = await client.query(
      `
      SELECT * FROM owned_pets
      WHERE member_id = $1 AND catalog_id = $2
      ORDER BY id DESC
      LIMIT 1
      `,
      [memberId, c.id]
    );
    if (owned.rows.length) {
      return { pet: owned.rows[0], alreadyDelivered: true, catalog: c };
    }
    // Purchase row exists but pet missing — fall through and create pet
  }

  const sk = skillForElement(c.element);
  const ins = await client.query(
    `
    INSERT INTO owned_pets
      (member_id, catalog_id, name, element, rarity, hp, atk, def, spd, skill_name, skill_power, image, hunger, energy, happiness)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,100,100,100)
    RETURNING *
    `,
    [
      memberId,
      c.id,
      c.name,
      c.element,
      c.rarity,
      c.base_hp,
      c.base_atk,
      c.base_def,
      c.base_spd,
      c.skill_name || sk.name,
      c.skill_power || sk.power,
      c.image || ""
    ]
  );

  await client.query(
    `
    INSERT INTO marketplace_purchases (payment_id, member_id, product_id)
    VALUES ($1, $2, $3)
    ON CONFLICT DO NOTHING
    `,
    [payment.id, memberId, payment.product_id]
  );

  return { pet: ins.rows[0], alreadyDelivered: false, catalog: c };
}

/* Buy pet with Test-Pi — complete + deliver pet */
app.post("/api/pets/payment/complete", requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const paymentId = String(req.body?.paymentId || "").trim();
    const catalogId = Number(req.body?.catalogId ?? req.body?.petId);

    if (!paymentId) {
      return res.status(400).json({ ok: false, error: "Payment ID is required." });
    }

    await client.query("BEGIN");

    const paymentResult = await client.query(
      `
      SELECT * FROM marketplace_payments
      WHERE pi_payment_id = $1
      LIMIT 1
      FOR UPDATE
      `,
      [paymentId]
    );

    if (!paymentResult.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "Pet payment not found. Approve first." });
    }

    const payment = paymentResult.rows[0];

    if (Number(payment.member_id) !== Number(req.member.id)) {
      await client.query("ROLLBACK");
      return res.status(403).json({ ok: false, error: "Payment does not belong to this Pioneer." });
    }

    // Mark completed with Pi (ignore if already completed on Pi side)
    if (payment.status !== "COMPLETED") {
      try {
        await piPaymentRequest(
          `/v2/payments/${encodeURIComponent(paymentId)}/complete`,
          "POST",
          req.body?.txid ? { txid: req.body.txid } : null
        );
      } catch (piErr) {
        console.error("PET PI complete API:", piErr.message || piErr);
        // continue — still deliver pet if payment is ours
      }

      await client.query(
        `
        UPDATE marketplace_payments
        SET status = 'COMPLETED', completed_at = NOW()
        WHERE id = $1
        `,
        [payment.id]
      );
    }

    // ALWAYS deliver pet (even if payment was already COMPLETED without pet)
    const delivered = await deliverPetFromPayment(
      client,
      req.member.id,
      payment,
      catalogId
    );

    await client.query("COMMIT");

    res.json({
      ok: true,
      completed: true,
      purchased: true,
      alreadyDelivered: !!delivered.alreadyDelivered,
      paymentId,
      pet: serializePet(delivered.pet),
      message: delivered.alreadyDelivered
        ? `${delivered.catalog.name} already in My Pets`
        : `Purchased ${delivered.catalog.name} with Test-π!`
    });
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    console.error("PET PI COMPLETE ERROR:", error);
    res.status(error.status || 500).json({
      ok: false,
      error: error.message || "Unable to complete pet payment."
    });
  } finally {
    client.release();
  }
});

/* Recover pets for completed Test-π payments that never delivered */
app.post("/api/pets/payment/recover", requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const payments = await client.query(
      `
      SELECT mp.*
      FROM marketplace_payments mp
      WHERE mp.member_id = $1
        AND mp.product_id LIKE 'pet-%'
        AND mp.status IN ('COMPLETED', 'APPROVED')
        AND NOT EXISTS (
          SELECT 1 FROM marketplace_purchases pr
          WHERE pr.payment_id = mp.id AND pr.member_id = $1
        )
      ORDER BY mp.id ASC
      `,
      [req.member.id]
    );

    const deliveredPets = [];

    for (const payment of payments.rows) {
      // If only APPROVED, try to complete on Pi first
      if (payment.status !== "COMPLETED") {
        try {
          await piPaymentRequest(
            `/v2/payments/${encodeURIComponent(payment.pi_payment_id)}/complete`,
            "POST"
          );
        } catch (e) {
          console.error("Recover Pi complete:", e.message || e);
        }
        await client.query(
          `UPDATE marketplace_payments SET status = 'COMPLETED', completed_at = COALESCE(completed_at, NOW()) WHERE id = $1`,
          [payment.id]
        );
        payment.status = "COMPLETED";
      }

      try {
        const d = await deliverPetFromPayment(client, req.member.id, payment, null);
        if (d && d.pet) deliveredPets.push(serializePet(d.pet));
      } catch (e) {
        console.error("Recover deliver:", e.message || e);
      }
    }

    await client.query("COMMIT");

    res.json({
      ok: true,
      recovered: deliveredPets.length,
      pets: deliveredPets,
      message:
        deliveredPets.length > 0
          ? `Recovered ${deliveredPets.length} pet(s) into My Pets`
          : "No missing pets to recover"
    });
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    console.error("PET RECOVER ERROR:", error);
    res.status(500).json({ ok: false, error: error.message || "Recover failed." });
  } finally {
    client.release();
  }
});

/* Care: feed / play (AMT cost) */
app.post("/api/pets/care", requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const ownedPetId = Number(req.body?.ownedPetId);
    const action = String(req.body?.action || "feed").toLowerCase();
    if (!Number.isInteger(ownedPetId)) {
      return res.status(400).json({ ok: false, error: "ownedPetId required." });
    }

    const cost = action === "play" ? 0.1 : 0.2;
    await client.query("BEGIN");
    const pet = await loadOwnedPet(req.member.id, ownedPetId, client);
    if (!pet) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "Pet not found." });
    }

    const bal = await getBalance(req.member.id, client);
    if (bal < cost) {
      await client.query("ROLLBACK");
      return res.status(400).json({ ok: false, error: "Not enough AMT." });
    }

    const ref = makeReference("AMT-PET-CARE");
    await client.query(
      `INSERT INTO amt_ledger (member_id, amount, type, reference) VALUES ($1,$2,'PET_CARE',$3)`,
      [req.member.id, -cost, ref]
    );

    let hunger = Number(applyHungerDecay(pet).hunger);
    let happiness = Number(pet.happiness);
    let energy = Number(pet.energy);

    if (action === "play") {
      happiness = Math.min(100, happiness + 15);
      energy = Math.min(100, energy + 10);
    } else {
      hunger = Math.min(100, hunger + 40);
      happiness = Math.min(100, happiness + 8);
    }

    const upd = await client.query(
      `
      UPDATE owned_pets SET
        hunger = $1,
        happiness = $2,
        energy = $3,
        last_fed_at = CASE WHEN $4 = 'feed' THEN NOW() ELSE last_fed_at END,
        last_care_at = NOW()
      WHERE id = $5
      RETURNING *
      `,
      [hunger, happiness, energy, action === "play" ? "play" : "feed", ownedPetId]
    );

    await client.query("COMMIT");
    res.json({ ok: true, pet: serializePet(upd.rows[0]), balance: await getBalance(req.member.id) });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    console.error("PET CARE ERROR:", e);
    res.status(500).json({ ok: false, error: e.message || "Care failed." });
  } finally {
    client.release();
  }
});

/* Train stat */
app.post("/api/pets/train", requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const ownedPetId = Number(req.body?.ownedPetId);
    const stat = String(req.body?.stat || "atk").toLowerCase();
    if (!Number.isInteger(ownedPetId)) {
      return res.status(400).json({ ok: false, error: "ownedPetId required." });
    }
    const cost = 0.5;
    await client.query("BEGIN");
    const pet = await loadOwnedPet(req.member.id, ownedPetId, client);
    if (!pet) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "Pet not found." });
    }
    if (Number(pet.energy) < 10) {
      await client.query("ROLLBACK");
      return res.status(400).json({ ok: false, error: "Pet too tired. Restore energy first." });
    }
    const bal = await getBalance(req.member.id, client);
    if (bal < cost) {
      await client.query("ROLLBACK");
      return res.status(400).json({ ok: false, error: "Not enough AMT." });
    }

    await client.query(
      `INSERT INTO amt_ledger (member_id, amount, type, reference) VALUES ($1,$2,'PET_TRAIN',$3)`,
      [req.member.id, -cost, makeReference("AMT-PET-TRAIN")]
    );

    const gain = 2 + Math.floor(Math.random() * 3);
    const col = ["hp", "atk", "def", "spd"].includes(stat) ? stat : "atk";
    let level = Number(pet.level);
    let xp = Number(pet.xp) + 15;
    const milestones = [];
    while (xp >= level * 50) {
      xp -= level * 50;
      level += 1;
      if ([10, 20, 50].includes(level)) {
        const bonus = level === 10 ? 2 : level === 20 ? 5 : 15;
        milestones.push({ level, amount: bonus });
        await client.query(
          `INSERT INTO amt_ledger (member_id, amount, type, reference) VALUES ($1,$2,'PET_MILESTONE',$3)`,
          [req.member.id, bonus, makeReference("AMT-PET-MS")]
        );
      }
    }

    // skill levels up every 5 pet levels
    const skillLevel = Math.max(1, Math.floor(level / 5) + 1);

    const upd = await client.query(
      `
      UPDATE owned_pets SET
        ${col} = ${col} + $1,
        level = $2,
        xp = $3,
        energy = GREATEST(0, energy - 10),
        skill_level = $4,
        skill_power = skill_power + CASE WHEN $4 > skill_level THEN 2 ELSE 0 END
      WHERE id = $5
      RETURNING *
      `,
      [gain, level, xp, skillLevel, ownedPetId]
    );

    await client.query("COMMIT");
    res.json({
      ok: true,
      pet: serializePet(upd.rows[0]),
      gain,
      milestones,
      balance: await getBalance(req.member.id)
    });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    console.error("PET TRAIN ERROR:", e);
    res.status(500).json({ ok: false, error: e.message || "Train failed." });
  } finally {
    client.release();
  }
});

/* Energy packs */
app.post("/api/pets/energy-pack", requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const ownedPetId = Number(req.body?.ownedPetId);
    const pack = String(req.body?.pack || "energy").toLowerCase();
    const cost = pack === "full" ? 3 : 1;
    await client.query("BEGIN");
    const pet = await loadOwnedPet(req.member.id, ownedPetId, client);
    if (!pet) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "Pet not found." });
    }
    const bal = await getBalance(req.member.id, client);
    if (bal < cost) {
      await client.query("ROLLBACK");
      return res.status(400).json({ ok: false, error: "Not enough AMT." });
    }
    await client.query(
      `INSERT INTO amt_ledger (member_id, amount, type, reference) VALUES ($1,$2,'PET_PACK',$3)`,
      [req.member.id, -cost, makeReference("AMT-PET-PACK")]
    );
    const energy = pack === "full" ? 100 : Math.min(100, Number(pet.energy) + 50);
    const happiness = pack === "full" ? 100 : Number(pet.happiness);
    const hunger = pack === "full" ? 100 : Number(pet.hunger);
    const upd = await client.query(
      `UPDATE owned_pets SET energy=$1, happiness=$2, hunger=$3, last_fed_at=CASE WHEN $4 THEN NOW() ELSE last_fed_at END WHERE id=$5 RETURNING *`,
      [energy, happiness, hunger, pack === "full", ownedPetId]
    );
    await client.query("COMMIT");
    res.json({ ok: true, message: pack === "full" ? "Full pack applied" : "Energy restored", pet: serializePet(upd.rows[0]) });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    res.status(500).json({ ok: false, error: e.message || "Pack failed." });
  } finally {
    client.release();
  }
});

/* Battle */
app.post("/api/pets/battle", requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const ownedPetId = Number(req.body?.ownedPetId);
    await client.query("BEGIN");
    const pet = await loadOwnedPet(req.member.id, ownedPetId, client);
    if (!pet) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "Pet not found." });
    }
    const p = applyHungerDecay(pet);
    if (p.hunger < 20) {
      await client.query("ROLLBACK");
      return res.status(400).json({ ok: false, error: "Pet is too hungry to battle. Feed first." });
    }
    if (Number(pet.energy) < 15) {
      await client.query("ROLLBACK");
      return res.status(400).json({ ok: false, error: "Not enough energy." });
    }

    const enemyPool = PET_SHOP_DEFAULTS;
    const enemy = enemyPool[Math.floor(Math.random() * enemyPool.length)];
    const enSkill = skillForElement(enemy.element);

    let myHp = Number(pet.hp);
    let enHp = enemy.hp;
    const myMax = myHp;
    const enMax = enHp;
    const rounds = [];
    const myPower = petPower(pet);
    const enPower = enemy.hp + enemy.atk * 2 + enemy.def + enemy.spd + enSkill.power;

    for (let i = 0; i < 6 && myHp > 0 && enHp > 0; i++) {
      const myDmg = Math.max(1, Math.floor(Number(pet.atk) + Number(pet.skill_power) * 0.3 - enemy.def * 0.2 + Math.random() * 8));
      const enDmg = Math.max(1, Math.floor(enemy.atk + enSkill.power * 0.25 - Number(pet.def) * 0.2 + Math.random() * 8));
      enHp = Math.max(0, enHp - myDmg);
      if (enHp > 0) myHp = Math.max(0, myHp - enDmg);
      rounds.push({ myHp, enHp, myDmg, enDmg });
    }

    const win = enHp <= 0 || (myHp > 0 && myPower >= enPower);
    if (!win && myHp <= 0) {
      // already lost
    }
    const finalWin = myHp > 0 && (enHp <= 0 || myPower > enPower * 0.9);
    const reward = finalWin ? Number((0.5 + Math.random() * 1.5).toFixed(2)) : Number((0.05 + Math.random() * 0.15).toFixed(2));

    await client.query(
      `INSERT INTO amt_ledger (member_id, amount, type, reference) VALUES ($1,$2,'PET_BATTLE',$3)`,
      [req.member.id, reward, makeReference("AMT-PET-BATTLE")]
    );

    let level = Number(pet.level);
    let xp = Number(pet.xp) + (finalWin ? 25 : 8);
    const milestones = [];
    while (xp >= level * 50) {
      xp -= level * 50;
      level += 1;
      if ([10, 20, 50].includes(level)) {
        const bonus = level === 10 ? 2 : level === 20 ? 5 : 15;
        milestones.push({ level, amount: bonus });
        await client.query(
          `INSERT INTO amt_ledger (member_id, amount, type, reference) VALUES ($1,$2,'PET_MILESTONE',$3)`,
          [req.member.id, bonus, makeReference("AMT-PET-MS")]
        );
      }
    }

    await client.query(
      `UPDATE owned_pets SET energy = GREATEST(0, energy - 15), hunger = GREATEST(0, hunger - 8), level=$1, xp=$2, skill_level=GREATEST(skill_level, $3) WHERE id=$4`,
      [level, xp, Math.max(1, Math.floor(level / 5) + 1), ownedPetId]
    );

    await client.query("COMMIT");

    res.json({
      ok: true,
      result: finalWin ? "WIN" : "LOSE",
      reward,
      opponent: "Wild " + enemy.name,
      opponentElement: enemy.element,
      opponentImage: "",
      petName: pet.name,
      petElement: pet.element,
      petImage: pet.image || "",
      myMaxHp: myMax,
      enMaxHp: enMax,
      rounds,
      milestones,
      skillUsed: pet.skill_name
    });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    console.error("PET BATTLE ERROR:", e);
    res.status(500).json({ ok: false, error: e.message || "Battle failed." });
  } finally {
    client.release();
  }
});

/* Starter pet */
app.get("/api/pets/starter-status", requireAuth, async (req, res) => {
  try {
    const r = await pool.query(`SELECT COUNT(*)::INT AS c FROM owned_pets WHERE member_id = $1`, [req.member.id]);
    res.json({ ok: true, claimed: Number(r.rows[0].c) > 0, canClaim: Number(r.rows[0].c) === 0 });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/api/pets/claim-starter", requireAuth, async (req, res) => {
  try {
    const r = await pool.query(`SELECT COUNT(*)::INT AS c FROM owned_pets WHERE member_id = $1`, [req.member.id]);
    if (Number(r.rows[0].c) > 0) {
      return res.status(409).json({ ok: false, error: "Starter already claimed." });
    }
    const sk = skillForElement("Earth");
    const ins = await pool.query(
      `
      INSERT INTO owned_pets
        (member_id, name, element, rarity, hp, atk, def, spd, skill_name, skill_power, hunger, energy, happiness)
      VALUES ($1,'Starter Pup','Earth','Common',100,20,15,15,$2,$3,100,100,100)
      RETURNING *
      `,
      [req.member.id, sk.name, sk.power]
    );
    res.json({ ok: true, message: "Starter pet claimed!", pet: serializePet(ins.rows[0]) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || "Claim failed." });
  }
});

/* Food shop — buy food/water */
app.get("/api/pets/food-shop", requireAuth, async (req, res) => {
  try {
    const inv = await ensurePetInventory(req.member.id);
    res.json({
      ok: true,
      inventory: {
        food: Number(inv.food),
        water: Number(inv.water),
        premium_meal: Number(inv.premium_meal)
      },
      items: Object.values(FOOD_SHOP).map((i) => ({
        id: i.key,
        name: i.name,
        price: i.price,
        hunger: i.hunger,
        happiness: i.happiness
      }))
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/api/pets/buy-food", requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const itemKey = String(req.body?.item || req.body?.id || "food").toLowerCase();
    const qty = Math.max(1, Math.min(50, Number(req.body?.qty || 1) || 1));
    const item = FOOD_SHOP[itemKey];
    if (!item) {
      return res.status(400).json({ ok: false, error: "Unknown food item." });
    }
    const cost = Number((item.price * qty).toFixed(8));
    await client.query("BEGIN");
    await ensurePetInventory(req.member.id, client);
    const bal = await getBalance(req.member.id, client);
    if (bal < cost) {
      await client.query("ROLLBACK");
      return res.status(400).json({ ok: false, error: "Not enough AMT." });
    }
    await client.query(
      `INSERT INTO amt_ledger (member_id, amount, type, reference) VALUES ($1,$2,'PET_FOOD',$3)`,
      [req.member.id, -cost, makeReference("AMT-PET-FOOD")]
    );
    await client.query(
      `
      UPDATE pet_inventory SET
        ${item.key} = ${item.key} + $1,
        updated_at = NOW()
      WHERE member_id = $2
      `,
      [qty, req.member.id]
    );
    await client.query("COMMIT");
    const inv = await ensurePetInventory(req.member.id);
    res.json({
      ok: true,
      message: `Bought ${qty}x ${item.name}`,
      inventory: { food: Number(inv.food), water: Number(inv.water), premium_meal: Number(inv.premium_meal) },
      balance: await getBalance(req.member.id)
    });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    res.status(500).json({ ok: false, error: e.message || "Buy food failed." });
  } finally {
    client.release();
  }
});

/* Feed one pet from inventory */
app.post("/api/pets/feed-item", requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const ownedPetId = Number(req.body?.ownedPetId);
    const itemKey = String(req.body?.item || "food").toLowerCase();
    const item = FOOD_SHOP[itemKey];
    if (!item || !Number.isInteger(ownedPetId)) {
      return res.status(400).json({ ok: false, error: "ownedPetId and item required." });
    }
    await client.query("BEGIN");
    const pet = await loadOwnedPet(req.member.id, ownedPetId, client);
    if (!pet) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "Pet not found." });
    }
    await ensurePetInventory(req.member.id, client);
    const inv = await client.query(`SELECT * FROM pet_inventory WHERE member_id = $1 FOR UPDATE`, [req.member.id]);
    const row = inv.rows[0];
    if (Number(row[item.key]) < 1) {
      await client.query("ROLLBACK");
      return res.status(400).json({ ok: false, error: `No ${item.name} left. Buy some first.` });
    }
    await client.query(`UPDATE pet_inventory SET ${item.key} = ${item.key} - 1, updated_at = NOW() WHERE member_id = $1`, [req.member.id]);
    const hunger = Math.min(100, Number(applyHungerDecay(pet).hunger) + item.hunger);
    const happiness = Math.min(100, Number(pet.happiness) + item.happiness);
    const upd = await client.query(
      `UPDATE owned_pets SET hunger=$1, happiness=$2, last_fed_at=NOW() WHERE id=$3 RETURNING *`,
      [hunger, happiness, ownedPetId]
    );
    await client.query("COMMIT");
    res.json({ ok: true, pet: serializePet(upd.rows[0]), message: `Fed ${item.name}` });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    res.status(500).json({ ok: false, error: e.message || "Feed failed." });
  } finally {
    client.release();
  }
});

/* ONE-CLICK feed all hungry pets */
app.post("/api/pets/feed-all", requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await ensurePetInventory(req.member.id, client);
    const petsR = await client.query(
      `SELECT * FROM owned_pets WHERE member_id = $1 AND is_listed = FALSE ORDER BY id ASC`,
      [req.member.id]
    );
    const invR = await client.query(`SELECT * FROM pet_inventory WHERE member_id = $1 FOR UPDATE`, [req.member.id]);
    let food = Number(invR.rows[0].food);
    let water = Number(invR.rows[0].water);
    let premium = Number(invR.rows[0].premium_meal);
    let fed = 0;
    const updated = [];

    for (const row of petsR.rows) {
      const p = applyHungerDecay(row);
      if (p.hunger >= 85) continue;

      let used = null;
      if (p.hunger < 40 && premium > 0) {
        premium--; used = FOOD_SHOP.premium_meal;
      } else if (food > 0) {
        food--; used = FOOD_SHOP.food;
      } else if (water > 0) {
        water--; used = FOOD_SHOP.water;
      } else {
        // pay AMT for basic food
        const cost = FOOD_SHOP.food.price;
        const bal = await getBalance(req.member.id, client);
        if (bal < cost) continue;
        await client.query(
          `INSERT INTO amt_ledger (member_id, amount, type, reference) VALUES ($1,$2,'PET_FOOD',$3)`,
          [req.member.id, -cost, makeReference("AMT-PET-FEEDALL")]
        );
        used = FOOD_SHOP.food;
      }

      if (!used) continue;
      const hunger = Math.min(100, p.hunger + used.hunger);
      const happiness = Math.min(100, Number(row.happiness) + used.happiness);
      const upd = await client.query(
        `UPDATE owned_pets SET hunger=$1, happiness=$2, last_fed_at=NOW() WHERE id=$3 RETURNING *`,
        [hunger, happiness, row.id]
      );
      updated.push(serializePet(upd.rows[0]));
      fed++;
    }

    await client.query(
      `UPDATE pet_inventory SET food=$1, water=$2, premium_meal=$3, updated_at=NOW() WHERE member_id=$4`,
      [food, water, premium, req.member.id]
    );
    await client.query("COMMIT");

    res.json({
      ok: true,
      fed,
      pets: updated,
      inventory: { food, water, premium_meal: premium },
      message: fed > 0 ? `Fed ${fed} pet(s)` : "No pets needed food (or not enough supplies/AMT)",
      balance: await getBalance(req.member.id)
    });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    console.error("FEED ALL ERROR:", e);
    res.status(500).json({ ok: false, error: e.message || "Feed all failed." });
  } finally {
    client.release();
  }
});

/* Outpost war */
app.get("/api/pets/outpost", requireAuth, async (req, res) => {
  try {
    await pool.query(
      `INSERT INTO outpost_state (member_id) VALUES ($1) ON CONFLICT (member_id) DO NOTHING`,
      [req.member.id]
    );
    const r = await pool.query(`SELECT * FROM outpost_state WHERE member_id = $1`, [req.member.id]);
    const pets = await pool.query(
      `SELECT id, name, level, element, skill_name, skill_level, energy, hunger FROM owned_pets WHERE member_id=$1 AND is_listed=FALSE`,
      [req.member.id]
    );
    res.json({
      ok: true,
      outpost: {
        level: r.rows[0].outpost_level,
        wins: r.rows[0].wins,
        losses: r.rows[0].losses,
        lastWarAt: r.rows[0].last_war_at
      },
      defenders: pets.rows
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/api/pets/outpost-war", requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const ownedPetId = Number(req.body?.ownedPetId);
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO outpost_state (member_id) VALUES ($1) ON CONFLICT (member_id) DO NOTHING`,
      [req.member.id]
    );

    const pet = await loadOwnedPet(req.member.id, ownedPetId, client);
    if (!pet) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "Select a pet for war." });
    }
    const p = applyHungerDecay(pet);
    if (p.hunger < 25) {
      await client.query("ROLLBACK");
      return res.status(400).json({ ok: false, error: "Pet too hungry for war." });
    }
    if (Number(pet.energy) < 20) {
      await client.query("ROLLBACK");
      return res.status(400).json({ ok: false, error: "Pet needs at least 20 energy." });
    }

    const power = petPower(pet);
    const enemyPower = 80 + Math.floor(Math.random() * 120) + Number(pet.level) * 5;
    const skillBonus = Number(pet.skill_power) * Number(pet.skill_level || 1);
    const win = power + skillBonus + Math.random() * 40 > enemyPower;

    const reward = win
      ? Number((1 + Math.random() * 3 + Number(pet.level) * 0.1).toFixed(2))
      : Number((0.1 + Math.random() * 0.3).toFixed(2));

    await client.query(
      `INSERT INTO amt_ledger (member_id, amount, type, reference) VALUES ($1,$2,'OUTPOST_WAR',$3)`,
      [req.member.id, reward, makeReference("AMT-OUTPOST")]
    );

    await client.query(
      `UPDATE owned_pets SET energy = GREATEST(0, energy - 20), hunger = GREATEST(0, hunger - 12) WHERE id = $1`,
      [ownedPetId]
    );

    await client.query(
      `
      UPDATE outpost_state SET
        wins = wins + $1,
        losses = losses + $2,
        outpost_level = GREATEST(outpost_level, 1 + FLOOR((wins + $1) / 5)),
        last_war_at = NOW(),
        updated_at = NOW()
      WHERE member_id = $3
      `,
      [win ? 1 : 0, win ? 0 : 1, req.member.id]
    );

    await client.query("COMMIT");
    const st = await pool.query(`SELECT * FROM outpost_state WHERE member_id = $1`, [req.member.id]);

    res.json({
      ok: true,
      result: win ? "WIN" : "LOSE",
      reward,
      skillUsed: pet.skill_name,
      skillLevel: pet.skill_level,
      enemyPower,
      yourPower: power + skillBonus,
      outpost: {
        level: st.rows[0].outpost_level,
        wins: st.rows[0].wins,
        losses: st.rows[0].losses
      },
      message: win
        ? `Outpost war won! +${reward} AMT (${pet.skill_name})`
        : `Outpost war lost. +${reward} AMT consolation`
    });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    console.error("OUTPOST WAR ERROR:", e);
    res.status(500).json({ ok: false, error: e.message || "Outpost war failed." });
  } finally {
    client.release();
  }
});

/* Minimal eggs/listings stubs so frontend does not hard-crash */
app.get("/api/pets/eggs", requireAuth, async (req, res) => {
  try {
    const r = await pool.query(`SELECT * FROM pet_eggs WHERE member_id=$1 ORDER BY id DESC`, [req.member.id]);
    res.json({ ok: true, eggs: r.rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/api/pets/breed", requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const p1 = Number(req.body?.pet1Id);
    const p2 = Number(req.body?.pet2Id);
    if (!p1 || !p2 || p1 === p2) {
      return res.status(400).json({ ok: false, error: "Select two different pets." });
    }
    const cost = 1;
    await client.query("BEGIN");
    const a = await loadOwnedPet(req.member.id, p1, client);
    const b = await loadOwnedPet(req.member.id, p2, client);
    if (!a || !b) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "Pet not found." });
    }
    const bal = await getBalance(req.member.id, client);
    if (bal < cost) {
      await client.query("ROLLBACK");
      return res.status(400).json({ ok: false, error: "Need 1 AMT to breed." });
    }
    await client.query(
      `INSERT INTO amt_ledger (member_id, amount, type, reference) VALUES ($1,$2,'PET_BREED',$3)`,
      [req.member.id, -cost, makeReference("AMT-BREED")]
    );
    const element = Math.random() < 0.5 ? a.element : b.element;
    const hatch = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const egg = await client.query(
      `
      INSERT INTO pet_eggs (member_id, element, gen, status, hatch_at, parent1_id, parent2_id)
      VALUES ($1,$2,$3,'INCUBATING',$4,$5,$6) RETURNING *
      `,
      [req.member.id, element, 1 + Math.max(0, 0), hatch.toISOString(), p1, p2]
    );
    await client.query("COMMIT");
    res.json({ ok: true, message: "Egg incubating — hatch in 24 hours", egg: egg.rows[0] });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    res.status(500).json({ ok: false, error: e.message || "Breed failed." });
  } finally {
    client.release();
  }
});

app.post("/api/pets/hatch", requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const eggId = Number(req.body?.eggId);
    await client.query("BEGIN");
    const er = await client.query(
      `SELECT * FROM pet_eggs WHERE id=$1 AND member_id=$2 FOR UPDATE`,
      [eggId, req.member.id]
    );
    if (!er.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "Egg not found." });
    }
    const egg = er.rows[0];
    if (egg.status === "HATCHED") {
      await client.query("ROLLBACK");
      return res.status(409).json({ ok: false, error: "Already hatched." });
    }
    if (new Date(egg.hatch_at).getTime() > Date.now()) {
      await client.query("ROLLBACK");
      return res.status(400).json({ ok: false, error: "Egg still incubating." });
    }
    const sk = skillForElement(egg.element);
    const name = egg.element + " Hatchling";
    const pet = await client.query(
      `
      INSERT INTO owned_pets
        (member_id, name, element, rarity, hp, atk, def, spd, skill_name, skill_power, hunger, energy, happiness)
      VALUES ($1,$2,$3,'Rare',100,24,16,18,$4,$5,100,100,100)
      RETURNING *
      `,
      [req.member.id, name, egg.element, sk.name, sk.power]
    );
    await client.query(`UPDATE pet_eggs SET status='HATCHED' WHERE id=$1`, [eggId]);
    await client.query("COMMIT");
    res.json({ ok: true, message: "Delivered " + name, pet: serializePet(pet.rows[0]) });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    res.status(500).json({ ok: false, error: e.message || "Hatch failed." });
  } finally {
    client.release();
  }
});

app.get("/api/pets/listings", requireAuth, async (req, res) => {
  try {
    res.json({ ok: true, listings: [] });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/api/pets/list", requireAuth, async (req, res) => {
  res.status(501).json({ ok: false, error: "Public pet listing coming next update." });
});
app.post("/api/pets/list-egg", requireAuth, async (req, res) => {
  res.status(501).json({ ok: false, error: "Egg listing coming next update." });
});
app.post("/api/pets/cancel-egg-listing", requireAuth, async (req, res) => {
  res.json({ ok: true });
});
app.post("/api/pets/buy-listing", requireAuth, async (req, res) => {
  res.status(501).json({ ok: false, error: "P2P buy coming next update." });
});
app.post("/api/pets/buy-egg-listing", requireAuth, async (req, res) => {
  res.status(501).json({ ok: false, error: "P2P egg buy coming next update." });
});

/* =========================================================
ERROR HANDLER
========================================================= */

app.use(
  (err, req, res, next) => {
    console.error(
      "UNHANDLED ERROR:",
      err
    );

    if (
      res.headersSent
    ) {
      return next(err);
    }

    res
      .status(
        err.status || 500
      )
      .json({
        ok: false,

        error:
          err.message ||
          "Internal server error."
      });
  }
);

/* =========================================================
START SERVER
========================================================= */

async function startServer() {
  try {
    await initializeDatabase();
    await seedPetsIfNeeded();

    app.listen(
      PORT,
      "0.0.0.0",
      () => {
        console.log(
          "=================================================="
        );

        console.log(
          "AMT TESTNET BACKEND ONLINE"
        );

        console.log(
          `Port: ${PORT}`
        );

        console.log(
          "Environment: TESTNET"
        );

        console.log(
          "Network: Pi Testnet"
        );

        console.log(
          "Version: 2.3.3"
        );

        console.log(
          `Mining rate: ${AMT_MINING_RATE} AMT/hour`
        );

        console.log(
          `Airdrop: ${AIRDROP_AMOUNT_AMT} AMT`
        );

        console.log(
          `Daily Spin: ${SPIN_MAX_PER_DAY}/day · prizes ${SPIN_PRIZES.join("/")}`
        );

        console.log(
          "Staking: ENABLED"
        );

        console.log(
          "30D: 5%"
        );

        console.log(
          "90D: 10%"
        );

        console.log(
          "180D: 15%"
        );

        console.log(
          "Legacy login compatibility: ENABLED"
        );

        console.log(
          "Pi wallet address response: ENABLED"
        );

        console.log(
          "=================================================="
        );
      }
    );

  } catch (error) {
    console.error(
      "SERVER START FAILED:",
      error
    );

    process.exit(1);
  }
}

startServer();