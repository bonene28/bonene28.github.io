AMT Pi Testnet Backend — server.js

"use strict";

/*
 * ============================================================
 * ALBERTO MARKETPLACE TOKEN (AMT)
 * PI TESTNET ECOSYSTEM BACKEND
 * ============================================================
 *
 * FEATURES
 * - Pi account authentication
 * - Separate AMT referral code
 * - Pi Testnet public wallet address
 * - AMT Reputation Score
 * - 24-hour server-side mining
 * - AMT ledger and balance
 * - Referral relationships
 * - Security Circle
 *
 * TESTNET ONLY
 * Never send wallet passphrases or private keys to this server.
 * ============================================================
 */

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();

const PORT = Number(process.env.PORT || 10000);

const PI_API_BASE = (
  process.env.PI_API_BASE || "https://api.testnet.minepi.com"
).trim().replace(/\/+$/, "");

const AMT_MINING_RATE = Number(
  process.env.AMT_MINING_RATE || "0.01"
);

const MINING_DURATION_MS = 24 * 60 * 60 * 1000;
const MAX_SECURITY_CIRCLE = 3;

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is missing.");
  process.exit(1);
}

if (!Number.isFinite(AMT_MINING_RATE) || AMT_MINING_RATE < 0) {
  console.error("AMT_MINING_RATE must be a valid number.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "1mb" }));

function sendError(res, status, error, code = null) {
  const response = {
    success: false,
    error
  };

  if (code) response.code = code;

  return res.status(status).json(response);
}

function normalizeUsername(value) {
  if (!value || typeof value !== "string") return null;

  const clean = value.trim();

  if (!clean) return null;

  return clean.startsWith("@") ? clean : "@" + clean;
}

function normalizeWalletAddress(value) {
  if (!value || typeof value !== "string") return null;

  const clean = value.trim().toUpperCase();

  /*
   * Public Stellar/Pi-style wallet address validation.
   * A public address normally starts with G.
   */
  if (!/^G[A-Z2-7]{55}$/.test(clean)) {
    return null;
  }

  return clean;
}

function generateReferralCode() {
  return (
    "AMT-" +
    crypto.randomBytes(4).toString("hex").toUpperCase()
  );
}

function generateReference(prefix) {
  return (
    prefix +
    "-" +
    Date.now() +
    "-" +
    crypto.randomBytes(6).toString("hex").toUpperCase()
  );
}

async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS members (
      id SERIAL PRIMARY KEY,

      pi_uid TEXT UNIQUE,
      username TEXT UNIQUE,

      referral_code TEXT UNIQUE NOT NULL,
      reputation_score INTEGER NOT NULL DEFAULT 100,

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

  /*
   * Compatibility upgrades for an existing database.
   */
  await pool.query(`
    ALTER TABLE members
    ADD COLUMN IF NOT EXISTS referral_code TEXT;
  `);

  await pool.query(`
    ALTER TABLE members
    ADD COLUMN IF NOT EXISTS reputation_score INTEGER NOT NULL DEFAULT 100;
  `);

  /*
   * Generate missing referral codes for old accounts.
   */
  const missingCodes = await pool.query(`
    SELECT id
    FROM members
    WHERE referral_code IS NULL
  `);

  for (const row of missingCodes.rows) {
    let code;
    let exists = true;

    while (exists) {
      code = generateReferralCode();

      const check = await pool.query(
        `
        SELECT id
        FROM members
        WHERE referral_code = $1
        `,
        [code]
      );

      exists = check.rows.length > 0;
    }

    await pool.query(
      `
      UPDATE members
      SET referral_code = $1,
          updated_at = NOW()
      WHERE id = $2
      `,
      [code, row.id]
    );
  }

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS
    idx_members_referral_code_unique
    ON members(referral_code);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS amt_wallets (
      id SERIAL PRIMARY KEY,

      member_id INTEGER UNIQUE NOT NULL
        REFERENCES members(id)
        ON DELETE CASCADE,

      wallet_address TEXT UNIQUE,

      wallet_status TEXT NOT NULL DEFAULT 'NOT_CONNECTED'
        CHECK (
          wallet_status IN (
            'NOT_CONNECTED',
            'CONNECTED'
          )
        ),

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

      UNIQUE(owner_member_id, member_id)
    );
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
    CREATE INDEX IF NOT EXISTS idx_referrals_referrer
    ON referrals(referrer_member_id);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_circle_owner
    ON security_circle(owner_member_id);
  `);

  console.log("AMT database initialized.");
}

async function readJsonResponse(response) {
  const text = await response.text();

  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

/*
 * ============================================================
 * PI AUTHENTICATION
 * ============================================================
 */

async function verifyPiAccessToken(accessToken) {
  if (!accessToken || typeof accessToken !== "string") {
    const error = new Error("Missing Pi access token.");
    error.statusCode = 400;
    throw error;
  }

  const response = await fetch(`${PI_API_BASE}/v2/me`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json"
    }
  });

  const data = await readJsonResponse(response);

  if (!response.ok) {
    const error = new Error(
      `Pi authentication failed: HTTP ${response.status}`
    );

    error.statusCode =
      response.status === 401 ? 401 : 502;

    error.piStatus = response.status;
    error.piResponse = data;

    throw error;
  }

  if (!data || !data.uid) {
    const error = new Error(
      "Pi response does not contain a valid UID."
    );

    error.statusCode = 502;
    throw error;
  }

  return {
    uid: String(data.uid),
    username: normalizeUsername(data.username)
  };
}

async function getAuthenticatedMember(accessToken) {
  const piUser = await verifyPiAccessToken(accessToken);

  let memberResult = await pool.query(
    `
    SELECT *
    FROM members
    WHERE pi_uid = $1
    LIMIT 1
    `,
    [piUser.uid]
  );

  if (memberResult.rows.length === 0) {
    let referralCode;
    let exists = true;

    while (exists) {
      referralCode = generateReferralCode();

      const check = await pool.query(
        `
        SELECT id
        FROM members
        WHERE referral_code = $1
        `,
        [referralCode]
      );

      exists = check.rows.length > 0;
    }

    memberResult = await pool.query(
      `
      INSERT INTO members
      (
        pi_uid,
        username,
        referral_code,
        reputation_score
      )
      VALUES ($1, $2, $3, 100)
      RETURNING *
      `,
      [
        piUser.uid,
        piUser.username,
        referralCode
      ]
    );
  } else {
    memberResult = await pool.query(
      `
      UPDATE members
      SET username = $1,
          updated_at = NOW()
      WHERE id = $2
      RETURNING *
      `,
      [
        piUser.username,
        memberResult.rows[0].id
      ]
    );
  }

  const member = memberResult.rows[0];

  await pool.query(
    `
    INSERT INTO amt_wallets
    (
      member_id,
      wallet_status
    )
    VALUES ($1, 'NOT_CONNECTED')
    ON CONFLICT(member_id)
    DO NOTHING
    `,
    [member.id]
  );

  return member;
}

/*
 * ============================================================
 * HEALTH
 * ============================================================
 */

app.get("/", (req, res) => {
  return res.json({
    success: true,
    app: "Alberto Marketplace Token",
    symbol: "AMT",
    network: "Pi Testnet",
    status: "ONLINE",
    features: [
      "PI_AUTH",
      "AMT_REFERRAL_CODE",
      "REPUTATION_SCORE",
      "PUBLIC_WALLET_ADDRESS",
      "SERVER_SIDE_MINING",
      "AMT_LEDGER",
      "SECURITY_CIRCLE"
    ]
  });
});

app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");

    return res.json({
      success: true,
      service: "AMT Pi Testnet Backend",
      database: "connected",
      status: "healthy"
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      database: "error",
      status: "unhealthy"
    });
  }
});

/*
 * ============================================================
 * AUTH / PROFILE
 * ============================================================
 */

app.post("/api/auth/verify", async (req, res) => {
  try {
    const member = await getAuthenticatedMember(
      req.body?.accessToken
    );

    return res.json({
      success: true,

      user: {
        id: member.id,
        uid: member.pi_uid,
        username: member.username,
        referralCode: member.referral_code,
        reputationScore: member.reputation_score,
        kycStatus: member.kyc_status
      }
    });
  } catch (error) {
    console.error("Auth error:", error.message);

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

app.post("/api/profile", async (req, res) => {
  try {
    const member = await getAuthenticatedMember(
      req.body?.accessToken
    );

    const walletResult = await pool.query(
      `
      SELECT
        wallet_address,
        wallet_status
      FROM amt_wallets
      WHERE member_id = $1
      `,
      [member.id]
    );

    const wallet = walletResult.rows[0] || {};

    return res.json({
      success: true,

      profile: {
        id: member.id,
        piUsername: member.username,
        referralCode: member.referral_code,
        reputationScore: member.reputation_score,
        kycStatus: member.kyc_status,

        walletAddress:
          wallet.wallet_address || null,

        walletStatus:
          wallet.wallet_status ||
          "NOT_CONNECTED"
      }
    });
  } catch (error) {
    console.error("Profile error:", error.message);

    return sendError(
      res,
      error.statusCode || 500,
      "Could not load profile."
    );
  }
});

/*
 * ============================================================
 * WALLET
 *
 * PUBLIC ADDRESS ONLY
 * NEVER SEND PRIVATE KEY OR PASSPHRASE.
 * ============================================================
 */

app.post("/api/wallet/connect", async (req, res) => {
  try {
    const member = await getAuthenticatedMember(
      req.body?.accessToken
    );

    const walletAddress = normalizeWalletAddress(
      req.body?.walletAddress
    );

    if (!walletAddress) {
      return sendError(
        res,
        400,
        "Invalid public wallet address.",
        "INVALID_WALLET"
      );
    }

    const existing = await pool.query(
      `
      SELECT member_id
      FROM amt_wallets
      WHERE wallet_address = $1
      LIMIT 1
      `,
      [walletAddress]
    );

    if (
      existing.rows.length > 0 &&
      Number(existing.rows[0].member_id) !==
      Number(member.id)
    ) {
      return sendError(
        res,
        409,
        "This wallet address is already connected to another AMT account.",
        "WALLET_ALREADY_USED"
      );
    }

    const walletResult = await pool.query(
      `
      UPDATE amt_wallets
      SET
        wallet_address = $1,
        wallet_status = 'CONNECTED',
        updated_at = NOW()
      WHERE member_id = $2
      RETURNING
        wallet_address,
        wallet_status
      `,
      [
        walletAddress,
        member.id
      ]
    );

    /*
     * Reputation bonus for connecting
     * a valid public wallet address.
     */
    const scoreResult = await pool.query(
      `
      UPDATE members
      SET
        reputation_score =
          LEAST(reputation_score + 5, 1000),
        updated_at = NOW()
      WHERE id = $1
      RETURNING reputation_score
      `,
      [member.id]
    );

    return res.json({
      success: true,
      message:
        "Public Pi Testnet wallet connected.",

      wallet: walletResult.rows[0],

      reputationScore:
        scoreResult.rows[0].reputation_score
    });
  } catch (error) {
    console.error("Wallet connect error:", error.message);

    return sendError(
      res,
      error.statusCode || 500,
      "Could not connect wallet."
    );
  }
});

app.post("/api/wallet", async (req, res) => {
  try {
    const member = await getAuthenticatedMember(
      req.body?.accessToken
    );

    const balanceResult = await pool.query(
      `
      SELECT COALESCE(SUM(amount), 0) AS balance
      FROM amt_ledger
      WHERE member_id = $1
      `,
      [member.id]
    );

    const walletResult = await pool.query(
      `
      SELECT
        wallet_address,
        wallet_status
      FROM amt_wallets
      WHERE member_id = $1
      `,
      [member.id]
    );

    return res.json({
      success: true,
      network: "Pi Testnet",

      wallet: {
        address:
          walletResult.rows[0]?.wallet_address ||
          null,

        status:
          walletResult.rows[0]?.wallet_status ||
          "NOT_CONNECTED",

        amtBalance: Number(
          Number(
            balanceResult.rows[0].balance
          ).toFixed(8)
        )
      }
    });
  } catch (error) {
    console.error("Wallet error:", error.message);

    return sendError(
      res,
      error.statusCode || 500,
      "Could not load wallet."
    );
  }
});

/*
 * ============================================================
 * REPUTATION SCORE
 * ============================================================
 */

app.post("/api/reputation", async (req, res) => {
  try {
    const member = await getAuthenticatedMember(
      req.body?.accessToken
    );

    const referralResult = await pool.query(
      `
      SELECT COUNT(*)::INTEGER AS count
      FROM referrals
      WHERE referrer_member_id = $1
      AND status = 'ACTIVE'
      `,
      [member.id]
    );

    const miningResult = await pool.query(
      `
      SELECT COUNT(*)::INTEGER AS count
      FROM mining_sessions
      WHERE member_id = $1
      AND status = 'COMPLETED'
      `,
      [member.id]
    );

    return res.json({
      success: true,

      reputation: {
        score: member.reputation_score,
        level:
          member.reputation_score >= 500
            ? "ELITE"
            : member.reputation_score >= 250
              ? "TRUSTED"
              : member.reputation_score >= 100
                ? "PIONEER"
                : "NEW",

        completedMiningSessions:
          Number(miningResult.rows[0].count),

        activeReferrals:
          Number(referralResult.rows[0].count)
      }
    });
  } catch (error) {
    console.error("Reputation error:", error.message);

    return sendError(
      res,
      error.statusCode || 500,
      "Could not load reputation score."
    );
  }
});

/*
 * ============================================================
 * MINING
 * ============================================================
 */

app.post("/api/mining/start", async (req, res) => {
  let client;

  try {
    const member = await getAuthenticatedMember(
      req.body?.accessToken
    );

    client = await pool.connect();

    await client.query("BEGIN");

    const activeResult = await client.query(
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

    if (activeResult.rows.length > 0) {
      await client.query("COMMIT");

      return res.json({
        success: true,
        status: "ALREADY_MINING",
        session: activeResult.rows[0]
      });
    }

    const startedAt = new Date();
    const endsAt = new Date(
      startedAt.getTime() + MINING_DURATION_MS
    );

    const result = await client.query(
      `
      INSERT INTO mining_sessions
      (
        member_id,
        started_at,
        ends_at,
        status,
        rate
      )
      VALUES (
        $1,
        $2,
        $3,
        'ACTIVE',
        $4
      )
      RETURNING *
      `,
      [
        member.id,
        startedAt,
        endsAt,
        AMT_MINING_RATE
      ]
    );

    await client.query(
      `
      UPDATE members
      SET
        reputation_score =
          LEAST(reputation_score + 1, 1000),
        updated_at = NOW()
      WHERE id = $1
      `,
      [member.id]
    );

    await client.query("COMMIT");

    return res.json({
      success: true,
      status: "MINING_STARTED",

      session: {
        id: result.rows[0].id,
        startedAt:
          result.rows[0].started_at,
        endsAt:
          result.rows[0].ends_at,
        rate:
          Number(result.rows[0].rate),

        maximumReward:
          Number(
            (
              AMT_MINING_RATE * 24
            ).toFixed(8)
          )
      }
    });
  } catch (error) {
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch {}
    }

    console.error(
      "Mining start error:",
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

app.post("/api/mining/status", async (req, res) => {
  try {
    const member = await getAuthenticatedMember(
      req.body?.accessToken
    );

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
        mining: false
      });
    }

    const session = result.rows[0];

    const now = Date.now();
    const start =
      new Date(session.started_at).getTime();

    const end =
      new Date(session.ends_at).getTime();

    const elapsed =
      Math.min(Math.max(now, start), end) - start;

    const progress =
      Math.min(
        elapsed / MINING_DURATION_MS,
        1
      );

    const maximum =
      Number(session.rate) * 24;

    const earned =
      maximum * progress;

    return res.json({
      success: true,
      mining: true,

      completed: now >= end,

      session: {
        id: session.id,
        startedAt: session.started_at,
        endsAt: session.ends_at,
        progress: Number(
          (progress * 100).toFixed(4)
        ),
        earned: Number(
          earned.toFixed(8)
        ),
        claimAvailable: now >= end
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
      "Could not load mining status."
    );
  }
});

app.post("/api/mining/claim", async (req, res) => {
  let client;

  try {
    const member = await getAuthenticatedMember(
      req.body?.accessToken
    );

    client = await pool.connect();

    await client.query("BEGIN");

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

      return sendError(
        res,
        404,
        "No active mining session."
      );
    }

    const session = result.rows[0];

    const end =
      new Date(session.ends_at).getTime();

    if (Date.now() < end) {
      await client.query("ROLLBACK");

      return sendError(
        res,
        403,
        "Mining session is not complete yet.",
        "MINING_NOT_COMPLETE"
      );
    }

    const reward = Number(
      (
        Number(session.rate) * 24
      ).toFixed(8)
    );

    const reference =
      generateReference("MINING");

    await client.query(
      `
      INSERT INTO amt_ledger
      (
        member_id,
        amount,
        type,
        reference
      )
      VALUES (
        $1,
        $2,
        'MINING_REWARD',
        $3
      )
      `,
      [
        member.id,
        reward,
        reference
      ]
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
        reward,
        session.id
      ]
    );

    const scoreResult = await client.query(
      `
      UPDATE members
      SET
        reputation_score =
          LEAST(reputation_score + 10, 1000),
        updated_at = NOW()
      WHERE id = $1
      RETURNING reputation_score
      `,
      [member.id]
    );

    await client.query("COMMIT");

    return res.json({
      success: true,
      claimed: reward,

      reputationScore:
        scoreResult.rows[0].reputation_score,

      message:
        "AMT Testnet reward recorded in the AMT ledger."
    });
  } catch (error) {
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch {}
    }

    console.error(
      "Mining claim error:",
      error.message
    );

    return sendError(
      res,
      error.statusCode || 500,
      "Could not claim mining reward."
    );
  } finally {
    if (client) client.release();
  }
});

/*
 * ============================================================
 * REFERRAL
 *
 * Each AMT account has its own AMT-XXXXXXXX code.
 * This is separate from the Pi username.
 * ============================================================
 */

app.post("/api/referral/link", async (req, res) => {
  let client;

  try {
    const member = await getAuthenticatedMember(
      req.body?.accessToken
    );

    const referralCode =
      typeof req.body?.referralCode === "string"
        ? req.body.referralCode
            .trim()
            .toUpperCase()
        : "";

    if (!referralCode) {
      return sendError(
        res,
        400,
        "Referral code is required."
      );
    }

    client = await pool.connect();

    await client.query("BEGIN");

    const existingResult = await client.query(
      `
      SELECT id
      FROM referrals
      WHERE referred_member_id = $1
      LIMIT 1
      `,
      [member.id]
    );

    if (existingResult.rows.length > 0) {
      await client.query("ROLLBACK");

      return sendError(
        res,
        409,
        "This account already has a referral."
      );
    }

    const referrerResult = await client.query(
      `
      SELECT *
      FROM members
      WHERE UPPER(referral_code) = $1
      LIMIT 1
      `,
      [referralCode]
    );

    if (referrerResult.rows.length === 0) {
      await client.query("ROLLBACK");

      return sendError(
        res,
        404,
        "Referral code not found."
      );
    }

    const referrer =
      referrerResult.rows[0];

    if (
      Number(referrer.id) ===
      Number(member.id)
    ) {
      await client.query("ROLLBACK");

      return sendError(
        res,
        400,
        "You cannot use your own referral code."
      );
    }

    await client.query(
      `
      INSERT INTO referrals
      (
        referrer_member_id,
        referred_member_id,
        status
      )
      VALUES (
        $1,
        $2,
        'ACTIVE'
      )
      `,
      [
        referrer.id,
        member.id
      ]
    );

    /*
     * Reputation is updated.
     * No AMT referral reward is issued here.
     * This remains Testnet-only.
     */
    await client.query(
      `
      UPDATE members
      SET
        reputation_score =
          LEAST(reputation_score + 5, 1000),
        updated_at = NOW()
      WHERE id = $1
      `,
      [referrer.id]
    );

    await client.query("COMMIT");

    return res.json({
      success: true,
      status: "REFERRAL_LINKED",

      referrer: {
        username: referrer.username,
        referralCode:
          referrer.referral_code
      },

      rewardStatus:
        "TESTNET_NO_TOKEN_REWARD"
    });
  } catch (error) {
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch {}
    }

    console.error(
      "Referral error:",
      error.message
    );

    return sendError(
      res,
      error.statusCode || 500,
      "Could not link referral."
    );
  } finally {
    if (client) client.release();
  }
});

app.post("/api/referral/status", async (req, res) => {
  try {
    const member = await getAuthenticatedMember(
      req.body?.accessToken
    );

    const result = await pool.query(
      `
      SELECT
        m.username,
        m.referral_code,
        r.created_at
      FROM referrals r
      JOIN members m
        ON m.id = r.referred_member_id
      WHERE r.referrer_member_id = $1
      AND r.status = 'ACTIVE'
      ORDER BY r.created_at DESC
      `,
      [member.id]
    );

    return res.json({
      success: true,

      referral: {
        code: member.referral_code,

        count:
          result.rows.length,

        referrals:
          result.rows.map(row => ({
            username: row.username,
            referralCode:
              row.referral_code,
            joinedAt:
              row.created_at
          }))
      }
    });
  } catch (error) {
    console.error(
      "Referral status error:",
      error.message
    );

    return sendError(
      res,
      error.statusCode || 500,
      "Could not load referrals."
    );
  }
});

/*
 * ============================================================
 * SECURITY CIRCLE
 * ============================================================
 */

app.post("/api/security-circle/add", async (req, res) => {
  try {
    const owner = await getAuthenticatedMember(
      req.body?.accessToken
    );

    const referralCode =
      typeof req.body?.referralCode === "string"
        ? req.body.referralCode
            .trim()
            .toUpperCase()
        : "";

    if (!referralCode) {
      return sendError(
        res,
        400,
        "Member AMT referral code is required."
      );
    }

    const targetResult = await pool.query(
      `
      SELECT id, username
      FROM members
      WHERE UPPER(referral_code) = $1
      LIMIT 1
      `,
      [referralCode]
    );

    if (targetResult.rows.length === 0) {
      return sendError(
        res,
        404,
        "AMT member not found."
      );
    }

    const target =
      targetResult.rows[0];

    if (
      Number(target.id) ===
      Number(owner.id)
    ) {
      return sendError(
        res,
        400,
        "You cannot add yourself."
      );
    }

    const countResult = await pool.query(
      `
      SELECT COUNT(*)::INTEGER AS count
      FROM security_circle
      WHERE owner_member_id = $1
      AND status = 'ACTIVE'
      `,
      [owner.id]
    );

    if (
      Number(countResult.rows[0].count) >=
      MAX_SECURITY_CIRCLE
    ) {
      return sendError(
        res,
        409,
        `Security Circle limit is ${MAX_SECURITY_CIRCLE}.`
      );
    }

    await pool.query(
      `
      INSERT INTO security_circle
      (
        owner_member_id,
        member_id,
        status
      )
      VALUES (
        $1,
        $2,
        'ACTIVE'
      )
      ON CONFLICT(
        owner_member_id,
        member_id
      )
      DO UPDATE
      SET status = 'ACTIVE'
      `,
      [
        owner.id,
        target.id
      ]
    );

    await pool.query(
      `
      UPDATE members
      SET
        reputation_score =
          LEAST(reputation_score + 2, 1000),
        updated_at = NOW()
      WHERE id = $1
      `,
      [owner.id]
    );

    return res.json({
      success: true,
      message:
        `${target.username || "Pioneer"} added to Security Circle.`
    });
  } catch (error) {
    console.error(
      "Security Circle add error:",
      error.message
    );

    return sendError(
      res,
      error.statusCode || 500,
      "Could not update Security Circle."
    );
  }
});

app.post("/api/security-circle/status", async (req, res) => {
  try {
    const owner = await getAuthenticatedMember(
      req.body?.accessToken
    );

    const result = await pool.query(
      `
      SELECT
        m.username,
        m.referral_code,
        m.reputation_score,
        sc.created_at
      FROM security_circle sc
      JOIN members m
        ON m.id = sc.member_id
      WHERE sc.owner_member_id = $1
      AND sc.status = 'ACTIVE'
      ORDER BY sc.created_at ASC
      `,
      [owner.id]
    );

    return res.json({
      success: true,

      securityCircle: {
        count:
          result.rows.length,

        limit:
          MAX_SECURITY_CIRCLE,

        members:
          result.rows.map(row => ({
            username:
              row.username,

            referralCode:
              row.referral_code,

            reputationScore:
              row.reputation_score,

            addedAt:
              row.created_at
          }))
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
});

/*
 * ============================================================
 * SERVER START
 * ============================================================
 */

async function startServer() {
  try {
    await initializeDatabase();

    app.listen(PORT, () => {
      console.log("======================================");
      console.log("ALBERTO MARKETPLACE TOKEN (AMT)");
      console.log("PI TESTNET ECOSYSTEM BACKEND");
      console.log("--------------------------------------");
      console.log("Port:", PORT);
      console.log("Pi API:", PI_API_BASE);
      console.log(
        "Mining Rate:",
        AMT_MINING_RATE,
        "AMT/hour"
      );
      console.log(
        "Mining Duration:",
        "24 hours"
      );
      console.log(
        "Security Circle Limit:",
        MAX_SECURITY_CIRCLE
      );
      console.log("Status: ONLINE");
      console.log("======================================");
    });
  } catch (error) {
    console.error(
      "Server startup failed:",
      error.message
    );

    process.exit(1);
  }
}

startServer();