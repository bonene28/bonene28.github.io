"use strict";

/*
 * ============================================================
 * ALBERTO MARKETPLACE TOKEN (AMT)
 * PI TESTNET MINING BACKEND
 *
 * server.js
 *
 * IMPORTANT:
 * - AMT mining/ledger work here is TESTNET application testing.
 * - Pi user authentication is verified server-side.
 * - Pi /v2/me uses the USER ACCESS TOKEN.
 * - No fake blockchain AMT balance or wallet address is created.
 *
 * REFERRAL UPDATE:
 * - Direct referrals are UNLIMITED.
 * - The first 5 successful direct referrals are automatically
 *   added to the owner's Security Circle when possible.
 * - Security Circle remains limited to 5 members.
 * - Referral records are never blocked because the Security
 *   Circle is full.
 * ============================================================
 */

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();

const PORT = Number(process.env.PORT || 10000);

const PI_API_BASE = (
  process.env.PI_API_BASE ||
  "https://api.minepi.com"
).trim().replace(/\/+$/, "");

const PI_API_KEY = (
  process.env.PI_API_KEY || ""
).trim();

const AMT_MINING_RATE = Number(
  process.env.AMT_MINING_RATE || "0.01"
);

const MINING_DURATION_SECONDS = 24 * 60 * 60;

const MAXIMUM_BASE_REWARD = Number(
  (AMT_MINING_RATE * 24).toFixed(8)
);

/*
 * PRIVATE TEST MARKETPLACE
 * PI TESTNET ONLY - never falls back to Mainnet payments.
 */
const PI_PAYMENT_API_BASE = (
  process.env.PI_PAYMENT_API_BASE ||
  "https://api.testnet.minepi.com"
).trim().replace(/\/+$/, "");

const MARKET_TEST_OWNER_PI_UID = (
  process.env.MARKET_TEST_OWNER_PI_UID || ""
).trim();

const MARKET_TEST_OWNER_USERNAME = (
  process.env.MARKET_TEST_OWNER_USERNAME || ""
).trim().toLowerCase();

const MARKET_TEST_PRICE_PI = Number(
  process.env.MARKET_TEST_PRICE_PI || "0.10"
);

const MARKET_TEST_PRODUCT_ID = "amt-test-pet-001";

if (
  !Number.isFinite(MARKET_TEST_PRICE_PI) ||
  MARKET_TEST_PRICE_PI <= 0
) {
  console.error("MARKET_TEST_PRICE_PI must be a positive number.");
  process.exit(1);
}

/*
 * Direct referrals are intentionally unlimited.
 */
const MAX_DIRECT_REFERRALS = null;

/*
 * Security Circle remains 5 members.
 */
const MAX_SECURITY_CIRCLE_MEMBERS = 5;

if (!Number.isFinite(AMT_MINING_RATE)) {
  console.error("AMT_MINING_RATE must be a valid number.");
  process.exit(1);
}

if (AMT_MINING_RATE < 0) {
  console.error("AMT_MINING_RATE cannot be negative.");
  process.exit(1);
}

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is missing.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "1mb" }));

async function readJsonResponse(response) {
  const text = await response.text();

  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch (error) {
    return { raw: text };
  }
}

function sendError(res, status, error, code = null) {
  const response = {
    success: false,
    error
  };

  if (code) response.code = code;

  return res.status(status).json(response);
}

/*
 * ============================================================
 * DATABASE INITIALIZATION
 * ============================================================
 */

async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS members (
      id SERIAL PRIMARY KEY,
      pi_uid TEXT UNIQUE NOT NULL,
      username TEXT,
      kyc_status TEXT NOT NULL DEFAULT 'UNVERIFIED'
        CHECK (
          kyc_status IN (
            'UNVERIFIED',
            'PENDING',
            'VERIFIED',
            'REJECTED'
          )
        ),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS amt_wallets (
      id SERIAL PRIMARY KEY,
      member_id INTEGER UNIQUE NOT NULL
        REFERENCES members(id)
        ON DELETE CASCADE,
      wallet_status TEXT NOT NULL DEFAULT 'NOT_CONNECTED',
      wallet_address TEXT UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS mining_sessions (
      id SERIAL PRIMARY KEY,
      member_id INTEGER NOT NULL
        REFERENCES members(id)
        ON DELETE CASCADE,
      started_at TIMESTAMPTZ NOT NULL,
      ends_at TIMESTAMPTZ NOT NULL,
      status TEXT NOT NULL DEFAULT 'ACTIVE'
        CHECK (
          status IN (
            'ACTIVE',
            'COMPLETED',
            'CANCELLED'
          )
        ),
      rate NUMERIC(30,8) NOT NULL,
      claimed_amount NUMERIC(30,8) NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS amt_ledger (
      id SERIAL PRIMARY KEY,
      member_id INTEGER NOT NULL
        REFERENCES members(id)
        ON DELETE CASCADE,
      amount NUMERIC(30,8) NOT NULL,
      type TEXT NOT NULL,
      reference TEXT UNIQUE NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS referrals (
      id SERIAL PRIMARY KEY,
      referrer_member_id INTEGER NOT NULL
        REFERENCES members(id)
        ON DELETE CASCADE,
      referred_member_id INTEGER UNIQUE NOT NULL
        REFERENCES members(id)
        ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'ACTIVE'
        CHECK (
          status IN (
            'ACTIVE',
            'INACTIVE'
          )
        ),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS security_circle (
      id SERIAL PRIMARY KEY,
      owner_member_id INTEGER NOT NULL
        REFERENCES members(id)
        ON DELETE CASCADE,
      member_id INTEGER NOT NULL
        REFERENCES members(id)
        ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'ACTIVE'
        CHECK (
          status IN (
            'ACTIVE',
            'INACTIVE'
          )
        ),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (owner_member_id, member_id)
    );
  `);

  /* Marketplace payment records are separate from the AMT mining ledger. */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS marketplace_payments (
      id SERIAL PRIMARY KEY,
      member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      product_id TEXT NOT NULL,
      payment_id TEXT UNIQUE NOT NULL,
      amount NUMERIC(30,8) NOT NULL,
      status TEXT NOT NULL DEFAULT 'CREATED',
      transaction_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS marketplace_purchases (
      id SERIAL PRIMARY KEY,
      member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      product_id TEXT NOT NULL,
      payment_id TEXT UNIQUE NOT NULL,
      transaction_id TEXT UNIQUE,
      amount NUMERIC(30,8) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_marketplace_payment_member
    ON marketplace_payments(member_id);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_marketplace_purchase_member
    ON marketplace_purchases(member_id);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_mining_member_status
    ON mining_sessions(member_id, status);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_ledger_member
    ON amt_ledger(member_id);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_referral_referrer
    ON referrals(referrer_member_id);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_security_owner
    ON security_circle(owner_member_id);
  `);

  console.log("AMT PostgreSQL database initialized.");
}

/*
 * ============================================================
 * PI ACCESS TOKEN VERIFICATION
 * ============================================================
 */

async function verifyPiAccessToken(accessToken) {
  if (!accessToken || typeof accessToken !== "string") {
    const error = new Error("Missing Pi access token.");
    error.statusCode = 400;
    throw error;
  }

  const endpoint = `${PI_API_BASE}/v2/me`;

  let response;

  try {
    response = await fetch(endpoint, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json"
      }
    });
  } catch (error) {
    console.error("Pi API connection error:", error.message);

    const apiError = new Error(
      "Unable to contact Pi Platform API."
    );
    apiError.statusCode = 502;
    throw apiError;
  }

  const data = await readJsonResponse(response);

  console.log(
    "Pi API verification endpoint:",
    endpoint
  );

  console.log(
    "Pi API verification HTTP status:",
    response.status
  );

  if (!response.ok) {
    const error = new Error(
      `Pi access token verification failed: HTTP ${response.status}`
    );

    error.statusCode = response.status === 401 ? 401 : 502;
    error.piStatus = response.status;
    error.piResponse = data;

    throw error;
  }

  if (
    !data ||
    typeof data.uid !== "string" ||
    !data.uid
  ) {
    const error = new Error(
      "Pi API response did not contain a valid UID."
    );
    error.statusCode = 502;
    throw error;
  }

  return {
    uid: data.uid,
    username:
      typeof data.username === "string"
        ? data.username
        : null,
    credentials: data.credentials || null
  };
}

/*
 * ============================================================
 * MEMBER AUTHENTICATION
 * ============================================================
 */

async function getAuthenticatedMember(accessToken) {
  const piUser = await verifyPiAccessToken(accessToken);

  const result = await pool.query(
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
      username = EXCLUDED.username,
      updated_at = NOW()
    RETURNING
      id,
      pi_uid,
      username,
      kyc_status
    `,
    [
      piUser.uid,
      piUser.username
    ]
  );

  const member = result.rows[0];

  await pool.query(
    `
    INSERT INTO amt_wallets
    (
      member_id,
      wallet_status
    )
    VALUES
    (
      $1,
      'NOT_CONNECTED'
    )
    ON CONFLICT (member_id)
    DO NOTHING
    `,
    [member.id]
  );

  return member;
}

/*
 * ============================================================
 * SECURITY CIRCLE AUTO-LINK HELPER
 * ============================================================
 *
 * Adds the referred member to the owner's Security Circle only
 * if the owner currently has fewer than 5 active members.
 *
 * This helper NEVER blocks the referral itself.
 */

async function addReferralToSecurityCircle(
  client,
  ownerMemberId,
  referredMemberId
) {
  if (
    Number(ownerMemberId) ===
    Number(referredMemberId)
  ) {
    return {
      added: false,
      reason: "SELF"
    };
  }

  const countResult = await client.query(
    `
    SELECT COUNT(*) AS count
    FROM security_circle
    WHERE owner_member_id = $1
      AND status = 'ACTIVE'
    `,
    [ownerMemberId]
  );

  const count = Number(countResult.rows[0].count);

  if (count >= MAX_SECURITY_CIRCLE_MEMBERS) {
    return {
      added: false,
      reason: "SECURITY_CIRCLE_FULL",
      count
    };
  }

  const existing = await client.query(
    `
    SELECT id, status
    FROM security_circle
    WHERE owner_member_id = $1
      AND member_id = $2
    LIMIT 1
    `,
    [
      ownerMemberId,
      referredMemberId
    ]
  );

  if (
    existing.rows.length > 0 &&
    existing.rows[0].status === "ACTIVE"
  ) {
    return {
      added: false,
      reason: "ALREADY_IN_SECURITY_CIRCLE",
      count
    };
  }

  if (existing.rows.length > 0) {
    await client.query(
      `
      UPDATE security_circle
      SET status = 'ACTIVE'
      WHERE id = $1
      `,
      [existing.rows[0].id]
    );
  } else {
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
  }

  return {
    added: true,
    count: count + 1
  };
}

/*
 * ============================================================
 * HEALTH CHECK
 * ============================================================
 */

app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");

    return res.json({
      success: true,
      service: "AMT Backend",
      network: "Pi Testnet",
      database: "connected",
      piApiBase: PI_API_BASE,
      status: "healthy"
    });
  } catch (error) {
    console.error(
      "Database health error:",
      error.message
    );

    return res.status(500).json({
      success: false,
      service: "AMT Backend",
      network: "Pi Testnet",
      database: "error",
      status: "unhealthy"
    });
  }
});

/*
 * ============================================================
 * ROOT
 * ============================================================
 */

app.get("/", (req, res) => {
  return res.json({
    app: "Alberto Marketplace Token",
    symbol: "AMT",
    network: "Pi Testnet",
    environment: "TESTNET",
    piApiBase: PI_API_BASE,
    miningRate: `${AMT_MINING_RATE} AMT/hour`,
    miningDuration: "24 hours",
    maximumBaseReward: MAXIMUM_BASE_REWARD,
    maximumDirectReferrals: "UNLIMITED",
    maximumSecurityCircleMembers:
      MAX_SECURITY_CIRCLE_MEMBERS,
    status: "ONLINE"
  });
});

/*
 * ============================================================
 * PI AUTHENTICATION
 * ============================================================
 */

app.post("/api/auth/verify", async (req, res) => {
  try {
    const { accessToken } = req.body || {};

    const member =
      await getAuthenticatedMember(accessToken);

    return res.json({
      success: true,
      user: {
        uid: member.pi_uid,
        username: member.username
      },
      kyc: {
        status: member.kyc_status
      }
    });
  } catch (error) {
    console.error(
      "Pi authentication verification error:",
      error.message
    );

    return sendError(
      res,
      error.statusCode || 401,
      "Pi account verification failed.",
      error.piStatus
        ? `PI_HTTP_${error.piStatus}`
        : null
    );
  }
});

/*
 * ============================================================
 * PROFILE
 * ============================================================
 */

app.post("/api/profile", async (req, res) => {
  try {
    const { accessToken } = req.body || {};

    const member =
      await getAuthenticatedMember(accessToken);

    const walletResult = await pool.query(
      `
      SELECT
        wallet_status,
        wallet_address
      FROM amt_wallets
      WHERE member_id = $1
      `,
      [member.id]
    );

    const wallet =
      walletResult.rows[0] || null;

    return res.json({
      success: true,
      profile: {
        uid: member.pi_uid,
        username: member.username,
        kycStatus: member.kyc_status,
        walletStatus:
          wallet?.wallet_status ||
          "NOT_CONNECTED",
        walletAddress:
          wallet?.wallet_address || null
      }
    });
  } catch (error) {
    console.error(
      "Profile error:",
      error.message
    );

    return sendError(
      res,
      error.statusCode || 401,
      "Profile authentication failed."
    );
  }
});

/*
 * ============================================================
 * KYC STATUS
 * ============================================================
 */

app.post("/api/kyc/status", async (req, res) => {
  try {
    const { accessToken } = req.body || {};

    const member =
      await getAuthenticatedMember(accessToken);

    return res.json({
      success: true,
      kyc: {
        status: member.kyc_status,
        miningAllowed: true,
        migrationEligible:
          member.kyc_status === "VERIFIED",
        protectedTransactionsEligible:
          member.kyc_status === "VERIFIED"
      }
    });
  } catch (error) {
    console.error(
      "KYC status error:",
      error.message
    );

    return sendError(
      res,
      error.statusCode || 401,
      "Unable to read KYC status."
    );
  }
});

/*
 * ============================================================
 * WALLET
 * ============================================================
 */

app.post("/api/wallet", async (req, res) => {
  try {
    const { accessToken } = req.body || {};

    const member =
      await getAuthenticatedMember(accessToken);

    const balanceResult = await pool.query(
      `
      SELECT
        COALESCE(SUM(amount), 0) AS balance
      FROM amt_ledger
      WHERE member_id = $1
      `,
      [member.id]
    );

    const walletResult = await pool.query(
      `
      SELECT
        wallet_status,
        wallet_address
      FROM amt_wallets
      WHERE member_id = $1
      `,
      [member.id]
    );

    const balance =
      Number(balanceResult.rows[0].balance);

    const wallet =
      walletResult.rows[0] || null;

    return res.json({
      success: true,
      network: "Pi Testnet",
      wallet: {
        amt: Number(balance.toFixed(8)),
        walletStatus:
          wallet?.wallet_status ||
          "NOT_CONNECTED",
        walletAddress:
          wallet?.wallet_address || null
      }
    });
  } catch (error) {
    console.error(
      "Wallet error:",
      error.message
    );

    return sendError(
      res,
      error.statusCode || 500,
      "Could not load AMT wallet."
    );
  }
});

/*
 * ============================================================
 * START MINING
 * ============================================================
 */

app.post("/api/mining/start", async (req, res) => {
  let client = null;
  let transactionStarted = false;

  try {
    const { accessToken } = req.body || {};

    const member =
      await getAuthenticatedMember(accessToken);

    client = await pool.connect();

    await client.query("BEGIN");
    transactionStarted = true;

    const active = await client.query(
      `
      SELECT *
      FROM mining_sessions
      WHERE member_id = $1
        AND status = 'ACTIVE'
      ORDER BY id DESC
      LIMIT 1
      FOR UPDATE
      `,
      [member.id]
    );

    if (active.rows.length > 0) {
      await client.query("COMMIT");
      transactionStarted = false;

      const currentSession = active.rows[0];

      return res.json({
        success: true,
        status: "ALREADY_MINING",
        session: {
          id: currentSession.id,
          startedAt: currentSession.started_at,
          endsAt: currentSession.ends_at,
          rate: Number(currentSession.rate)
        }
      });
    }

    const startedAt = new Date();

    const endsAt = new Date(
      startedAt.getTime() +
      MINING_DURATION_SECONDS * 1000
    );

    const sessionResult = await client.query(
      `
      INSERT INTO mining_sessions
      (
        member_id,
        started_at,
        ends_at,
        status,
        rate
      )
      VALUES
      (
        $1,
        $2,
        $3,
        'ACTIVE',
        $4
      )
      RETURNING
        id,
        started_at,
        ends_at,
        rate
      `,
      [
        member.id,
        startedAt,
        endsAt,
        AMT_MINING_RATE
      ]
    );

    await client.query("COMMIT");
    transactionStarted = false;

    const session = sessionResult.rows[0];

    return res.json({
      success: true,
      status: "MINING_STARTED",
      kycStatus: member.kyc_status,
      session: {
        id: session.id,
        startedAt: session.started_at,
        endsAt: session.ends_at,
        rate: Number(session.rate),
        maximumBaseReward:
          MAXIMUM_BASE_REWARD
      }
    });
  } catch (error) {
    if (client && transactionStarted) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error(
          "Mining rollback error:",
          rollbackError.message
        );
      }
    }

    console.error(
      "Start mining error:",
      error.message
    );

    return sendError(
      res,
      error.statusCode || 500,
      "Could not start mining."
    );
  } finally {
    if (client) client.release();
  }
});

/*
 * ============================================================
 * MINING STATUS
 * ============================================================
 */

app.post("/api/mining/status", async (req, res) => {
  try {
    const { accessToken } = req.body || {};

    const member =
      await getAuthenticatedMember(accessToken);

    const result = await pool.query(
      `
      SELECT *
      FROM mining_sessions
      WHERE member_id = $1
        AND status = 'ACTIVE'
      ORDER BY id DESC
      LIMIT 1
      `,
      [member.id]
    );

    if (result.rows.length === 0) {
      return res.json({
        success: true,
        mining: false,
        message: "No active mining session."
      });
    }

    const session = result.rows[0];

    const now = Date.now();

    const start =
      new Date(session.started_at).getTime();

    const end =
      new Date(session.ends_at).getTime();

    const current = Math.min(
      Math.max(now, start),
      end
    );

    const elapsedSeconds =
      (current - start) / 1000;

    const rate = Number(session.rate);

    const earned = Math.min(
      rate * (elapsedSeconds / 3600),
      rate * 24
    );

    const completed = now >= end;

    return res.json({
      success: true,
      mining: true,
      completed,
      session: {
        id: session.id,
        startedAt: session.started_at,
        endsAt: session.ends_at,
        rate,
        earned: Number(earned.toFixed(8)),
        maximumBaseReward:
          Number((rate * 24).toFixed(8)),
        claimAvailable: completed
      }
    });
  } catch (error) {
    console.error(
      "Mining status error:",
      error.message
    );

    return sendError(
      res,
      error.statusCode || 500,
      "Could not read mining status."
    );
  }
});

/*
 * ============================================================
 * CLAIM MINING REWARD
 * ============================================================
 */

app.post("/api/mining/claim", async (req, res) => {
  let client = null;
  let transactionStarted = false;

  try {
    const { accessToken } = req.body || {};

    const member =
      await getAuthenticatedMember(accessToken);

    client = await pool.connect();

    await client.query("BEGIN");
    transactionStarted = true;

    const result = await client.query(
      `
      SELECT *
      FROM mining_sessions
      WHERE member_id = $1
        AND status = 'ACTIVE'
      ORDER BY id DESC
      LIMIT 1
      FOR UPDATE
      `,
      [member.id]
    );

    if (result.rows.length === 0) {
      await client.query("ROLLBACK");
      transactionStarted = false;

      return sendError(
        res,
        404,
        "No active mining session.",
        "NO_ACTIVE_SESSION"
      );
    }

    const session = result.rows[0];

    const now = Date.now();

    const start =
      new Date(session.started_at).getTime();

    const end =
      new Date(session.ends_at).getTime();

    if (now < end) {
      await client.query("ROLLBACK");
      transactionStarted = false;

      const remainingSeconds =
        Math.ceil((end - now) / 1000);

      return res.status(403).json({
        success: false,
        code: "MINING_NOT_COMPLETE",
        message:
          "The 24-hour mining session must finish before the reward can be claimed.",
        remainingSeconds
      });
    }

    const rate = Number(session.rate);

    const grossEarned = Math.min(
      rate * 24,
      MAXIMUM_BASE_REWARD
    );

    const claimable = Number(
      (
        grossEarned -
        Number(session.claimed_amount)
      ).toFixed(8)
    );

    if (claimable <= 0) {
      await client.query("ROLLBACK");
      transactionStarted = false;

      return res.json({
        success: true,
        claimed: 0,
        message:
          "No new AMT reward is available."
      });
    }

    const reference =
      `MINING-${session.id}-${crypto
        .randomBytes(8)
        .toString("hex")}`;

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
        member.id,
        claimable,
        reference
      ]
    );

    const newClaimed = Number(
      (
        Number(session.claimed_amount) +
        claimable
      ).toFixed(8)
    );

    await client.query(
      `
      UPDATE mining_sessions
      SET
        claimed_amount = $1,
        status = 'COMPLETED'
      WHERE id = $2
      `,
      [
        newClaimed,
        session.id
      ]
    );

    await client.query("COMMIT");
    transactionStarted = false;

    return res.json({
      success: true,
      claimed: claimable,
      sessionStatus: "COMPLETED",
      message:
        "AMT Testnet mining reward recorded in the ledger."
    });
  } catch (error) {
    if (client && transactionStarted) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error(
          "Claim rollback error:",
          rollbackError.message
        );
      }
    }

    console.error(
      "Claim reward error:",
      error.message
    );

    return sendError(
      res,
      error.statusCode || 500,
      "Could not record AMT mining reward."
    );
  } finally {
    if (client) client.release();
  }
});

/*
 * ============================================================
 * REFERRAL - MANUAL LINK
 * ============================================================
 *
 * Direct referrals are UNLIMITED.
 *
 * After linking, the referred member is automatically placed
 * into the owner's Security Circle if one of the 5 slots is
 * still available.
 * ============================================================
 */

app.post("/api/referral/link", async (req, res) => {
  let client = null;
  let transactionStarted = false;

  try {
    const {
      accessToken,
      referralMemberId
    } = req.body || {};

    if (!referralMemberId) {
      return sendError(
        res,
        400,
        "referralMemberId is required."
      );
    }

    const member =
      await getAuthenticatedMember(accessToken);

    const referrer = await pool.query(
      `
      SELECT
        id,
        pi_uid,
        username
      FROM members
      WHERE id = $1
      LIMIT 1
      `,
      [referralMemberId]
    );

    if (referrer.rows.length === 0) {
      return sendError(
        res,
        404,
        "Referral member not found."
      );
    }

    if (
      referrer.rows[0].id === member.id
    ) {
      return sendError(
        res,
        400,
        "A member cannot refer themselves."
      );
    }

    client = await pool.connect();

    await client.query("BEGIN");
    transactionStarted = true;

    await client.query(
      `
      SELECT id
      FROM members
      WHERE id = $1
      FOR UPDATE
      `,
      [referrer.rows[0].id]
    );

    const existing = await client.query(
      `
      SELECT id
      FROM referrals
      WHERE referred_member_id = $1
      LIMIT 1
      `,
      [member.id]
    );

    if (existing.rows.length > 0) {
      await client.query("ROLLBACK");
      transactionStarted = false;

      return sendError(
        res,
        409,
        "This account already has a referral relationship."
      );
    }

    /*
     * NO DIRECT-REFERRAL LIMIT.
     */
    const insertResult = await client.query(
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
      RETURNING id
      `,
      [
        referrer.rows[0].id,
        member.id
      ]
    );

    /*
     * Automatically use one of the 5 Security Circle slots.
     * This can never reject the referral.
     */
    const circleResult =
      await addReferralToSecurityCircle(
        client,
        referrer.rows[0].id,
        member.id
      );

    const countResult = await client.query(
      `
      SELECT COUNT(*) AS count
      FROM referrals
      WHERE referrer_member_id = $1
        AND status = 'ACTIVE'
      `,
      [referrer.rows[0].id]
    );

    const referralCount =
      Number(countResult.rows[0].count);

    await client.query("COMMIT");
    transactionStarted = false;

    return res.json({
      success: true,
      linked: true,
      status: "REFERRAL_LINKED",
      referralId: insertResult.rows[0].id,
      referralCount,
      maximumDirectReferrals: "UNLIMITED",
      securityCircle: {
        added: circleResult.added,
        count:
          circleResult.count ??
          null,
        limit:
          MAX_SECURITY_CIRCLE_MEMBERS
      },
      message:
        "Referral relationship recorded for Testnet."
    });
  } catch (error) {
    if (client && transactionStarted) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error(
          "Referral rollback error:",
          rollbackError.message
        );
      }
    }

    console.error(
      "Referral error:",
      error.message
    );

    return sendError(
      res,
      error.statusCode || 500,
      "Could not create referral relationship."
    );
  } finally {
    if (client) client.release();
  }
});

/*
 * ============================================================
 * AUTOMATIC REFERRAL LINK
 * ============================================================
 *
 * Frontend sends:
 *
 * {
 *   accessToken,
 *   referralUsername
 * }
 *
 * referralUsername comes from:
 *
 * ?ref=PiUsername
 *
 * Direct referrals are UNLIMITED.
 * Security Circle is automatically filled up to 5.
 * ============================================================
 */

app.post(
  "/api/referral/auto-link",
  async (req, res) => {
    let client = null;
    let transactionStarted = false;

    try {
      const {
        accessToken,
        referralUsername
      } = req.body || {};

      if (
        !referralUsername ||
        typeof referralUsername !== "string"
      ) {
        return sendError(
          res,
          400,
          "referralUsername is required."
        );
      }

      const cleanUsername =
        referralUsername
          .trim()
          .slice(0, 100);

      if (!cleanUsername) {
        return sendError(
          res,
          400,
          "Invalid referral username."
        );
      }

      const member =
        await getAuthenticatedMember(accessToken);

      const existing = await pool.query(
        `
        SELECT
          id,
          referrer_member_id,
          status
        FROM referrals
        WHERE referred_member_id = $1
        LIMIT 1
        `,
        [member.id]
      );

      if (existing.rows.length > 0) {
        return res.json({
          success: true,
          linked: false,
          status: "ALREADY_LINKED",
          message:
            "This Pioneer already has a referral relationship."
        });
      }

      const referrerResult = await pool.query(
        `
        SELECT
          id,
          pi_uid,
          username
        FROM members
        WHERE LOWER(username) = LOWER($1)
        LIMIT 1
        `,
        [cleanUsername]
      );

      if (referrerResult.rows.length === 0) {
        return res.json({
          success: false,
          linked: false,
          status: "REFERRER_NOT_FOUND",
          message:
            "Referral Pioneer has not joined AMT yet."
        });
      }

      const referrer =
        referrerResult.rows[0];

      if (
        Number(referrer.id) ===
        Number(member.id)
      ) {
        return res.json({
          success: false,
          linked: false,
          status: "SELF_REFERRAL",
          message:
            "A Pioneer cannot refer themselves."
        });
      }

      client = await pool.connect();

      await client.query("BEGIN");
      transactionStarted = true;

      const lockedReferrer =
        await client.query(
          `
          SELECT
            id,
            pi_uid,
            username
          FROM members
          WHERE id = $1
          FOR UPDATE
          `,
          [referrer.id]
        );

      if (
        lockedReferrer.rows.length === 0
      ) {
        await client.query("ROLLBACK");
        transactionStarted = false;

        return res.json({
          success: false,
          linked: false,
          status: "REFERRER_NOT_FOUND"
        });
      }

      /*
       * NO 5-REFERRAL LIMIT HERE.
       */
      const insertResult =
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
          RETURNING id
          `,
          [
            referrer.id,
            member.id
          ]
        );

      /*
       * Automatically add to Security Circle if one
       * of the five slots remains.
       */
      const circleResult =
        await addReferralToSecurityCircle(
          client,
          referrer.id,
          member.id
        );

      const countResult =
        await client.query(
          `
          SELECT COUNT(*) AS count
          FROM referrals
          WHERE referrer_member_id = $1
            AND status = 'ACTIVE'
          `,
          [referrer.id]
        );

      const referralCount =
        Number(countResult.rows[0].count);

      await client.query("COMMIT");
      transactionStarted = false;

      return res.json({
        success: true,
        linked: true,
        status: "REFERRAL_LINKED",
        referralId: insertResult.rows[0].id,
        referrer: {
          id: referrer.id,
          username: referrer.username
        },
        referralCount,
        maximumDirectReferrals: "UNLIMITED",
        securityCircle: {
          added: circleResult.added,
          count:
            circleResult.count ??
            null,
          limit:
            MAX_SECURITY_CIRCLE_MEMBERS
        }
      });
    } catch (error) {
      if (client && transactionStarted) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackError) {
          console.error(
            "Referral rollback error:",
            rollbackError.message
          );
        }
      }

      console.error(
        "Automatic referral error:",
        error.message
      );

      return sendError(
        res,
        error.statusCode || 500,
        "Could not create automatic referral relationship."
      );
    } finally {
      if (client) client.release();
    }
  }
);

/*
 * ============================================================
 * REFERRAL STATUS
 * ============================================================
 */

app.post(
  "/api/referral/status",
  async (req, res) => {
    try {
      const { accessToken } = req.body || {};

      const member =
        await getAuthenticatedMember(accessToken);

      const username =
        member.username || null;

      const result = await pool.query(
        `
        SELECT
          r.id,
          r.status,
          m.id AS member_id,
          m.username,

          EXISTS (
            SELECT 1
            FROM mining_sessions ms
            WHERE ms.member_id = m.id
              AND ms.status = 'ACTIVE'
              AND NOW() < ms.ends_at
          ) AS mining

        FROM referrals r

        JOIN members m
          ON m.id = r.referred_member_id

        WHERE r.referrer_member_id = $1
          AND r.status = 'ACTIVE'

        ORDER BY r.id ASC
        `,
        [member.id]
      );

      const referrals =
        result.rows.map(row => ({
          id: row.member_id,
          username: row.username,
          mining: Boolean(row.mining),
          status: row.status
        }));

      const activeMiners =
        referrals.filter(
          item => item.mining
        ).length;

      return res.json({
        success: true,
        referral: {
          username,
          count: referrals.length,
          activeMiners,
          maxDirectReferrals: "UNLIMITED",
          referrals
        }
      });
    } catch (error) {
      console.error(
        "Referral status error:",
        error.message
      );

      return sendError(
        res,
        error.statusCode || 401,
        "Could not load referral status."
      );
    }
  }
);

/*
 * ============================================================
 * SECURITY CIRCLE ADD
 * ============================================================
 *
 * Manual Security Circle addition remains limited to 5.
 * ============================================================
 */

app.post(
  "/api/security-circle/add",
  async (req, res) => {
    let client = null;
    let transactionStarted = false;

    try {
      const {
        accessToken,
        memberId
      } = req.body || {};

      if (!memberId) {
        return sendError(
          res,
          400,
          "memberId is required."
        );
      }

      const owner =
        await getAuthenticatedMember(accessToken);

      if (
        Number(memberId) ===
        Number(owner.id)
      ) {
        return sendError(
          res,
          400,
          "A member cannot add themselves to their Security Circle."
        );
      }

      client = await pool.connect();

      await client.query("BEGIN");
      transactionStarted = true;

      await client.query(
        `
        SELECT id
        FROM members
        WHERE id = $1
        FOR UPDATE
        `,
        [owner.id]
      );

      const target = await client.query(
        `
        SELECT
          id,
          username
        FROM members
        WHERE id = $1
        LIMIT 1
        `,
        [memberId]
      );

      if (target.rows.length === 0) {
        await client.query("ROLLBACK");
        transactionStarted = false;

        return sendError(
          res,
          404,
          "Security Circle member not found."
        );
      }

      const existing = await client.query(
        `
        SELECT
          id,
          status
        FROM security_circle
        WHERE owner_member_id = $1
          AND member_id = $2
        LIMIT 1
        `,
        [
          owner.id,
          memberId
        ]
      );

      if (
        existing.rows.length > 0 &&
        existing.rows[0].status === "ACTIVE"
      ) {
        const currentCount =
          await client.query(
            `
            SELECT COUNT(*) AS count
            FROM security_circle
            WHERE owner_member_id = $1
              AND status = 'ACTIVE'
            `,
            [owner.id]
          );

        await client.query("COMMIT");
        transactionStarted = false;

        return res.json({
          success: true,
          status:
            "ALREADY_IN_SECURITY_CIRCLE",
          count:
            Number(
              currentCount.rows[0].count
            ),
          limit:
            MAX_SECURITY_CIRCLE_MEMBERS
        });
      }

      const countResult =
        await client.query(
          `
          SELECT COUNT(*) AS count
          FROM security_circle
          WHERE owner_member_id = $1
            AND status = 'ACTIVE'
          `,
          [owner.id]
        );

      const memberCount =
        Number(countResult.rows[0].count);

      if (
        memberCount >=
        MAX_SECURITY_CIRCLE_MEMBERS
      ) {
        await client.query("ROLLBACK");
        transactionStarted = false;

        return res.json({
          success: false,
          status:
            "SECURITY_CIRCLE_LIMIT_REACHED",
          message:
            "Security Circle is full. Maximum 5 members are allowed.",
          count: memberCount,
          limit:
            MAX_SECURITY_CIRCLE_MEMBERS
        });
      }

      if (existing.rows.length > 0) {
        await client.query(
          `
          UPDATE security_circle
          SET status = 'ACTIVE'
          WHERE id = $1
          `,
          [existing.rows[0].id]
        );
      } else {
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
            owner.id,
            memberId
          ]
        );
      }

      await client.query("COMMIT");
      transactionStarted = false;

      return res.json({
        success: true,
        status:
          "SECURITY_CIRCLE_ADDED",
        message:
          "Security Circle member recorded.",
        count: memberCount + 1,
        limit:
          MAX_SECURITY_CIRCLE_MEMBERS
      });
    } catch (error) {
      if (client && transactionStarted) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackError) {
          console.error(
            "Security Circle rollback error:",
            rollbackError.message
          );
        }
      }

      console.error(
        "Security Circle add error:",
        error.message
      );

      return sendError(
        res,
        error.statusCode || 500,
        "Could not update Security Circle."
      );
    } finally {
      if (client) client.release();
    }
  }
);

/*
 * ============================================================
 * SECURITY CIRCLE STATUS
 * ============================================================
 */

app.post(
  "/api/security-circle/status",
  async (req, res) => {
    try {
      const { accessToken } = req.body || {};

      const owner =
        await getAuthenticatedMember(accessToken);

      const result = await pool.query(
        `
        SELECT
          sc.member_id,
          m.username,
          m.kyc_status
        FROM security_circle sc
        JOIN members m
          ON m.id = sc.member_id
        WHERE sc.owner_member_id = $1
          AND sc.status = 'ACTIVE'
        ORDER BY sc.id ASC
        `,
        [owner.id]
      );

      return res.json({
        success: true,
        securityCircle: {
          enabled:
            result.rows.length > 0,
          count:
            result.rows.length,
          limit:
            MAX_SECURITY_CIRCLE_MEMBERS,
          members:
            result.rows
        }
      });
    } catch (error) {
      console.error(
        "Security Circle status error:",
        error.message
      );

      return sendError(
        res,
        error.statusCode || 500,
        "Could not load Security Circle."
      );
    }
  }
);

/*
 * ============================================================
 * PRIVATE TEST MARKETPLACE + PI TESTNET PAYMENT FLOW
 * ============================================================
 * Exactly one private test product: Alberto Test Pet.
 * Only the configured owner can access it.
 * Payments use the Pi TESTNET API only.
 * No marketplace purchase changes the AMT mining ledger.
 */

function isMarketTestOwner(member) {
  if (MARKET_TEST_OWNER_PI_UID) {
    return member.pi_uid === MARKET_TEST_OWNER_PI_UID;
  }

  if (MARKET_TEST_OWNER_USERNAME) {
    return String(member.username || "").toLowerCase() ===
      MARKET_TEST_OWNER_USERNAME;
  }

  return false;
}

function requirePiServerKey() {
  if (!PI_API_KEY) {
    const error = new Error(
      "PI_API_KEY is not configured on the AMT backend."
    );
    error.statusCode = 503;
    throw error;
  }
}

async function piPaymentRequest(path, method = "GET", body = undefined) {
  requirePiServerKey();

  const options = {
    method,
    headers: {
      Authorization: `Key ${PI_API_KEY}`,
      Accept: "application/json"
    }
  };

  if (body !== undefined) {
    options.headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }

  let response;

  try {
    response = await fetch(
      `${PI_PAYMENT_API_BASE}${path}`,
      options
    );
  } catch (error) {
    console.error(
      "Pi Testnet Payments API connection error:",
      error.message
    );

    const apiError = new Error(
      "Unable to contact Pi Testnet Payments API."
    );
    apiError.statusCode = 502;
    throw apiError;
  }

  const data = await readJsonResponse(response);

  if (!response.ok) {
    const error = new Error(
      `Pi Testnet Payments API failed: HTTP ${response.status}`
    );
    error.statusCode = response.status === 401 ? 502 : response.status;
    error.piResponse = data;
    throw error;
  }

  return data;
}

app.post("/api/market/test-product", async (req, res) => {
  try {
    const { accessToken } = req.body || {};
    const member = await getAuthenticatedMember(accessToken);

    if (!isMarketTestOwner(member)) {
      return res.status(403).json({
        success: false,
        code: "PRIVATE_TEST_MARKET",
        message: "This private Test Buy item is not available for this account."
      });
    }

    const purchases = await pool.query(
      `
      SELECT payment_id, transaction_id, amount, created_at
      FROM marketplace_purchases
      WHERE member_id = $1
      AND product_id = $2
      ORDER BY id DESC
      LIMIT 10
      `,
      [member.id, MARKET_TEST_PRODUCT_ID]
    );

    return res.json({
      success: true,
      network: "Pi Testnet",
      testOnly: true,
      ownerOnly: true,
      product: {
        id: MARKET_TEST_PRODUCT_ID,
        name: "Alberto Test Pet",
        description: "Private marketplace payment test item.",
        amountPi: MARKET_TEST_PRICE_PI,
        currency: "Pi",
        testOnly: true
      },
      purchases: purchases.rows
    });
  } catch (error) {
    console.error("Test marketplace product error:", error.message);
    return sendError(
      res,
      error.statusCode || 500,
      "Could not load the private Testnet marketplace item."
    );
  }
});

app.post("/api/market/payment/approve", async (req, res) => {
  try {
    const { accessToken, paymentId } = req.body || {};

    if (!paymentId || typeof paymentId !== "string") {
      return sendError(res, 400, "paymentId is required.", "PAYMENT_ID_REQUIRED");
    }

    const member = await getAuthenticatedMember(accessToken);

    if (!isMarketTestOwner(member)) {
      return sendError(
        res,
        403,
        "Private Test Buy is not available for this account.",
        "PRIVATE_TEST_MARKET"
      );
    }

    const payment = await piPaymentRequest(
      `/v2/payments/${encodeURIComponent(paymentId)}`
    );

    const amount = Number(payment?.amount);
    const metadata = payment?.metadata || {};

    if (
      !Number.isFinite(amount) ||
      Math.abs(amount - MARKET_TEST_PRICE_PI) > 0.00000001
    ) {
      return sendError(
        res,
        400,
        "Test payment amount does not match the configured Testnet price.",
        "PAYMENT_AMOUNT_MISMATCH"
      );
    }

    if (
      metadata.productId !== MARKET_TEST_PRODUCT_ID ||
      metadata.testOnly !== true
    ) {
      return sendError(
        res,
        400,
        "Payment metadata is not valid for the AMT Test Pet.",
        "PAYMENT_METADATA_INVALID"
      );
    }

    const existing = await pool.query(
      `SELECT member_id FROM marketplace_payments WHERE payment_id = $1 LIMIT 1`,
      [paymentId]
    );

    if (existing.rows.length > 0 &&
        Number(existing.rows[0].member_id) !== Number(member.id)) {
      return sendError(
        res,
        403,
        "This payment belongs to another account.",
        "PAYMENT_OWNER_MISMATCH"
      );
    }

    await pool.query(
      `
      INSERT INTO marketplace_payments
      (member_id, product_id, payment_id, amount, status)
      VALUES ($1, $2, $3, $4, 'APPROVAL_PENDING')
      ON CONFLICT (payment_id) DO NOTHING
      `,
      [member.id, MARKET_TEST_PRODUCT_ID, paymentId, MARKET_TEST_PRICE_PI]
    );

    const approved = await piPaymentRequest(
      `/v2/payments/${encodeURIComponent(paymentId)}/approve`,
      "POST"
    );

    await pool.query(
      `
      UPDATE marketplace_payments
      SET status = 'APPROVED', updated_at = NOW()
      WHERE payment_id = $1
      `,
      [paymentId]
    );

    return res.json({
      success: true,
      network: "Pi Testnet",
      testOnly: true,
      payment: approved
    });
  } catch (error) {
    console.error("Test marketplace payment approval error:", error.message);
    return sendError(
      res,
      error.statusCode || 500,
      "Could not approve the Pi Testnet payment."
    );
  }
});

app.post("/api/market/payment/complete", async (req, res) => {
  try {
    const { accessToken, paymentId, txid } = req.body || {};

    if (!paymentId || typeof paymentId !== "string") {
      return sendError(res, 400, "paymentId is required.", "PAYMENT_ID_REQUIRED");
    }

    if (!txid || typeof txid !== "string") {
      return sendError(res, 400, "txid is required.", "TXID_REQUIRED");
    }

    const member = await getAuthenticatedMember(accessToken);

    if (!isMarketTestOwner(member)) {
      return sendError(
        res,
        403,
        "Private Test Buy is not available for this account.",
        "PRIVATE_TEST_MARKET"
      );
    }

    const stored = await pool.query(
      `
      SELECT *
      FROM marketplace_payments
      WHERE payment_id = $1
      AND member_id = $2
      AND product_id = $3
      LIMIT 1
      `,
      [paymentId, member.id, MARKET_TEST_PRODUCT_ID]
    );

    if (stored.rows.length === 0) {
      return sendError(
        res,
        404,
        "Test payment approval record was not found.",
        "PAYMENT_NOT_FOUND"
      );
    }

    const payment = await piPaymentRequest(
      `/v2/payments/${encodeURIComponent(paymentId)}`
    );

    const amount = Number(payment?.amount);
    const metadata = payment?.metadata || {};

    if (
      !Number.isFinite(amount) ||
      Math.abs(amount - MARKET_TEST_PRICE_PI) > 0.00000001
    ) {
      return sendError(
        res,
        400,
        "Test payment amount does not match the configured Testnet price.",
        "PAYMENT_AMOUNT_MISMATCH"
      );
    }

    if (
      metadata.productId !== MARKET_TEST_PRODUCT_ID ||
      metadata.testOnly !== true
    ) {
      return sendError(
        res,
        400,
        "Payment metadata is not valid for the AMT Test Pet.",
        "PAYMENT_METADATA_INVALID"
      );
    }

    const completed = await piPaymentRequest(
      `/v2/payments/${encodeURIComponent(paymentId)}/complete`,
      "POST",
      { txid }
    );

    await pool.query(
      `
      UPDATE marketplace_payments
      SET status = 'COMPLETED', transaction_id = $1, updated_at = NOW()
      WHERE payment_id = $2
      `,
      [txid, paymentId]
    );

    await pool.query(
      `
      INSERT INTO marketplace_purchases
      (member_id, product_id, payment_id, transaction_id, amount)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (payment_id) DO NOTHING
      `,
      [member.id, MARKET_TEST_PRODUCT_ID, paymentId, txid, MARKET_TEST_PRICE_PI]
    );

    return res.json({
      success: true,
      network: "Pi Testnet",
      testOnly: true,
      product: {
        id: MARKET_TEST_PRODUCT_ID,
        name: "Alberto Test Pet",
        amountPi: MARKET_TEST_PRICE_PI
      },
      payment: completed,
      message:
        "Test Pet purchase completed on Pi Testnet. No AMT mining balance was changed."
    });
  } catch (error) {
    console.error("Test marketplace payment completion error:", error.message);
    return sendError(
      res,
      error.statusCode || 500,
      "Could not complete the Pi Testnet payment."
    );
  }
});

/*
 * ============================================================
 * SERVER START
 * ============================================================
 */

async function startServer() {
  try {
    await initializeDatabase();

    app.listen(
      PORT,
      () => {
        console.log(
          "=========================================="
        );

        console.log(
          "Alberto Marketplace Token (AMT)"
        );

        console.log(
          "Pi Testnet Mining Backend"
        );

        console.log(
          "Server running on port:",
          PORT
        );

        console.log(
          "Pi API:",
          PI_API_BASE
        );

        console.log(
          "Pi /me endpoint:",
          `${PI_API_BASE}/v2/me`
        );

        console.log(
          "PI_API_KEY configured:",
          PI_API_KEY ? "YES" : "NO"
        );

        console.log(
          "AMT mining rate:",
          AMT_MINING_RATE,
          "AMT/hour"
        );

        console.log(
          "Mining duration:",
          "24 hours"
        );

        console.log(
          "Maximum base reward:",
          MAXIMUM_BASE_REWARD,
          "AMT/session"
        );

        console.log(
          "Maximum direct referrals:",
          "UNLIMITED"
        );

        console.log(
          "Maximum Security Circle members:",
          MAX_SECURITY_CIRCLE_MEMBERS
        );

        console.log(
          "KYC required for mining:",
          "NO"
        );

        console.log(
          "=========================================="
        );
      }
    );
  } catch (error) {
    console.error(
      "Server startup failed:",
      error.message
    );

    process.exit(1);
  }
}

startServer();
