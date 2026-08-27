"use strict";

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

const MINING_DURATION_SECONDS = 24 * 60 * 60;
const MAX_DIRECT_REFERRALS = 5;

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is missing.");
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

async function readJsonResponse(response) {
  const text = await response.text();

  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS members (
      id SERIAL PRIMARY KEY,
      pi_uid TEXT UNIQUE NOT NULL,
      username TEXT,
      reputation_score INTEGER NOT NULL DEFAULT 0,
      kyc_status TEXT NOT NULL DEFAULT 'UNVERIFIED',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    ALTER TABLE members
    ADD COLUMN IF NOT EXISTS reputation_score INTEGER NOT NULL DEFAULT 0;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS amt_wallets (
      id SERIAL PRIMARY KEY,
      member_id INTEGER UNIQUE NOT NULL
        REFERENCES members(id) ON DELETE CASCADE,
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
        REFERENCES members(id) ON DELETE CASCADE,
      started_at TIMESTAMPTZ NOT NULL,
      ends_at TIMESTAMPTZ NOT NULL,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      rate NUMERIC(30,8) NOT NULL,
      claimed_amount NUMERIC(30,8) NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS amt_ledger (
      id SERIAL PRIMARY KEY,
      member_id INTEGER NOT NULL
        REFERENCES members(id) ON DELETE CASCADE,
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
        REFERENCES members(id) ON DELETE CASCADE,
      referred_member_id INTEGER UNIQUE NOT NULL
        REFERENCES members(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS security_circle (
      id SERIAL PRIMARY KEY,
      owner_member_id INTEGER NOT NULL
        REFERENCES members(id) ON DELETE CASCADE,
      member_id INTEGER NOT NULL
        REFERENCES members(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
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

  console.log("AMT PostgreSQL database initialized.");
}

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
      `Pi access token verification failed: HTTP ${response.status}`
    );

    error.statusCode = response.status;
    throw error;
  }

  if (!data || !data.uid) {
    const error = new Error("Pi API did not return a valid UID.");
    error.statusCode = 502;
    throw error;
  }

  return {
    uid: data.uid,
    username: data.username || null
  };
}

async function getAuthenticatedMember(accessToken) {
  const piUser = await verifyPiAccessToken(accessToken);

  const result = await pool.query(
    `
      INSERT INTO members (pi_uid, username)
      VALUES ($1, $2)
      ON CONFLICT (pi_uid)
      DO UPDATE SET
        username = EXCLUDED.username,
        updated_at = NOW()
      RETURNING
        id,
        pi_uid,
        username,
        reputation_score,
        kyc_status
    `,
    [piUser.uid, piUser.username]
  );

  const member = result.rows[0];

  await pool.query(
    `
      INSERT INTO amt_wallets (member_id)
      VALUES ($1)
      ON CONFLICT (member_id) DO NOTHING
    `,
    [member.id]
  );

  return member;
}

/* =========================
   HEALTH
========================= */

app.get("/", (req, res) => {
  res.json({
    success: true,
    app: "Alberto Marketplace Token",
    symbol: "AMT",
    network: "Pi Testnet",
    environment: "TESTNET",
    status: "ONLINE"
  });
});

app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");

    res.json({
      success: true,
      service: "AMT Pi Testnet Backend",
      database: "connected",
      piApiBase: PI_API_BASE,
      status: "healthy"
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      database: "error",
      status: "unhealthy"
    });
  }
});

/* =========================
   PI AUTH
========================= */

app.post("/api/auth/verify", async (req, res) => {
  try {
    const { accessToken } = req.body || {};
    const member = await getAuthenticatedMember(accessToken);

    res.json({
      success: true,
      user: {
        uid: member.pi_uid,
        username: member.username
      },
      reputationScore: member.reputation_score,
      kyc: {
        status: member.kyc_status
      }
    });
  } catch (error) {
    console.error("Pi auth error:", error.message);

    sendError(
      res,
      error.statusCode || 401,
      "Pi account verification failed."
    );
  }
});

/* =========================
   PROFILE / WALLET
========================= */

app.post("/api/profile", async (req, res) => {
  try {
    const { accessToken } = req.body || {};
    const member = await getAuthenticatedMember(accessToken);

    const walletResult = await pool.query(
      `
        SELECT wallet_status, wallet_address
        FROM amt_wallets
        WHERE member_id = $1
      `,
      [member.id]
    );

    const wallet = walletResult.rows[0];

    res.json({
      success: true,
      profile: {
        uid: member.pi_uid,
        username: member.username,
        reputationScore: member.reputation_score,
        kycStatus: member.kyc_status,
        walletStatus: wallet?.wallet_status || "NOT_CONNECTED",
        walletAddress: wallet?.wallet_address || null
      }
    });
  } catch (error) {
    console.error("Profile error:", error.message);

    sendError(
      res,
      error.statusCode || 500,
      "Could not load profile."
    );
  }
});

app.post("/api/wallet/connect", async (req, res) => {
  try {
    const { accessToken, walletAddress } = req.body || {};

    if (!walletAddress || typeof walletAddress !== "string") {
      return sendError(
        res,
        400,
        "walletAddress is required."
      );
    }

    const member = await getAuthenticatedMember(accessToken);

    await pool.query(
      `
        UPDATE amt_wallets
        SET
          wallet_address = $1,
          wallet_status = 'CONNECTED',
          updated_at = NOW()
        WHERE member_id = $2
      `,
      [walletAddress.trim(), member.id]
    );

    res.json({
      success: true,
      wallet: {
        status: "CONNECTED",
        address: walletAddress.trim()
      }
    });
  } catch (error) {
    console.error("Wallet connect error:", error.message);

    sendError(
      res,
      error.statusCode || 500,
      "Could not connect wallet."
    );
  }
});

app.post("/api/wallet", async (req, res) => {
  try {
    const { accessToken } = req.body || {};
    const member = await getAuthenticatedMember(accessToken);

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
        SELECT wallet_status, wallet_address
        FROM amt_wallets
        WHERE member_id = $1
      `,
      [member.id]
    );

    const wallet = walletResult.rows[0];

    res.json({
      success: true,
      network: "Pi Testnet",
      wallet: {
        amt: Number(balanceResult.rows[0].balance),
        walletStatus: wallet?.wallet_status || "NOT_CONNECTED",
        walletAddress: wallet?.wallet_address || null
      }
    });
  } catch (error) {
    console.error("Wallet error:", error.message);

    sendError(
      res,
      error.statusCode || 500,
      "Could not load wallet."
    );
  }
});

/* =========================
   REPUTATION
========================= */

app.post("/api/reputation", async (req, res) => {
  try {
    const { accessToken } = req.body || {};
    const member = await getAuthenticatedMember(accessToken);

    const activeMining = await pool.query(
      `
        SELECT COUNT(*)::INTEGER AS count
        FROM mining_sessions
        WHERE member_id = $1
        AND status = 'ACTIVE'
        AND ends_at > NOW()
      `,
      [member.id]
    );

    res.json({
      success: true,
      reputation: {
        score: member.reputation_score,
        miningActive:
          Number(activeMining.rows[0].count) > 0
      }
    });
  } catch (error) {
    sendError(
      res,
      error.statusCode || 500,
      "Could not load reputation."
    );
  }
});

/* =========================
   MINING
========================= */

app.post("/api/mining/start", async (req, res) => {
  try {
    const { accessToken } = req.body || {};
    const member = await getAuthenticatedMember(accessToken);

    const active = await pool.query(
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

    if (active.rows.length > 0) {
      return res.json({
        success: true,
        status: "ALREADY_MINING",
        session: active.rows[0]
      });
    }

    const startedAt = new Date();
    const endsAt = new Date(
      startedAt.getTime() +
      MINING_DURATION_SECONDS * 1000
    );

    const result = await pool.query(
      `
        INSERT INTO mining_sessions
        (member_id, started_at, ends_at, rate)
        VALUES ($1, $2, $3, $4)
        RETURNING *
      `,
      [
        member.id,
        startedAt,
        endsAt,
        AMT_MINING_RATE
      ]
    );

    res.json({
      success: true,
      status: "MINING_STARTED",
      session: result.rows[0]
    });
  } catch (error) {
    console.error("Mining start error:", error.message);

    sendError(
      res,
      error.statusCode || 500,
      "Could not start mining."
    );
  }
});

app.post("/api/mining/status", async (req, res) => {
  try {
    const { accessToken } = req.body || {};
    const member = await getAuthenticatedMember(accessToken);

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
    const start = new Date(session.started_at).getTime();
    const end = new Date(session.ends_at).getTime();

    const elapsed = Math.max(
      0,
      Math.min(now, end) - start
    );

    const earned =
      Number(session.rate) *
      (elapsed / 3600000);

    res.json({
      success: true,
      mining: true,
      completed: now >= end,
      session: {
        id: session.id,
        startedAt: session.started_at,
        endsAt: session.ends_at,
        rate: Number(session.rate),
        earned: Number(earned.toFixed(8)),
        claimAvailable: now >= end
      }
    });
  } catch (error) {
    console.error("Mining status error:", error.message);

    sendError(
      res,
      error.statusCode || 500,
      "Could not read mining status."
    );
  }
});

app.post("/api/mining/claim", async (req, res) => {
  const client = await pool.connect();

  try {
    const { accessToken } = req.body || {};
    const member = await getAuthenticatedMember(accessToken);

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

    if (Date.now() < new Date(session.ends_at).getTime()) {
      await client.query("ROLLBACK");

      return sendError(
        res,
        403,
        "Mining session is not complete."
      );
    }

    const reward = Number(
      (Number(session.rate) * 24).toFixed(8)
    );

    const reference =
      "MINING-" +
      session.id +
      "-" +
      crypto.randomBytes(8).toString("hex");

    await client.query(
      `
        INSERT INTO amt_ledger
        (member_id, amount, type, reference)
        VALUES ($1, $2, $3, $4)
      `,
      [
        member.id,
        reward,
        "MINING_REWARD",
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
      [reward, session.id]
    );

    await client.query(
      `
        UPDATE members
        SET
          reputation_score = reputation_score + 1,
          updated_at = NOW()
        WHERE id = $1
      `,
      [member.id]
    );

    await client.query("COMMIT");

    res.json({
      success: true,
      claimed: reward,
      reputationAdded: 1,
      message:
        "AMT Testnet mining reward recorded."
    });
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {}

    console.error("Mining claim error:", error.message);

    sendError(
      res,
      error.statusCode || 500,
      "Could not claim mining reward."
    );
  } finally {
    client.release();
  }
});

/* =========================
   REFERRALS
========================= */

app.post("/api/referral/status", async (req, res) => {
  try {
    const { accessToken } = req.body || {};
    const owner = await getAuthenticatedMember(accessToken);

    const result = await pool.query(
      `
        SELECT
          m.username,
          r.status,
          r.created_at
        FROM referrals r
        JOIN members m
          ON m.id = r.referred_member_id
        WHERE r.referrer_member_id = $1
        ORDER BY r.created_at ASC
      `,
      [owner.id]
    );

    res.json({
      success: true,
      referral: {
        username: owner.username,
        count: result.rows.length,
        limit: MAX_DIRECT_REFERRALS,
        referrals: result.rows
      }
    });
  } catch (error) {
    sendError(
      res,
      error.statusCode || 500,
      "Could not load referrals."
    );
  }
});

/* =========================
   SERVER
========================= */

async function startServer() {
  try {
    await initializeDatabase();

    app.listen(PORT, "0.0.0.0", () => {
      console.log("========================================");
      console.log("Alberto Marketplace Token (AMT)");
      console.log("Pi Testnet Ecosystem Backend");
      console.log("Server running on port:", PORT);
      console.log("Pi API:", PI_API_BASE);
      console.log("Mining rate:", AMT_MINING_RATE, "AMT/hour");
      console.log("Status: ONLINE");
      console.log("========================================");
    });
  } catch (error) {
    console.error("Server startup failed:", error.message);
    process.exit(1);
  }
}

startServer();