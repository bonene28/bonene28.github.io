"use strict";

/*
============================================================
ALBERTO MARKETPLACE TOKEN (AMT)
PI TESTNET BACKEND
FULL SERVER
============================================================

IMPORTANT:
- TESTNET ONLY
- AMT application ledger wallet only
- The generated AMT-... address is NOT a Pi/Stellar
  blockchain wallet address.
- Pi authentication is verified server-side.
- Mining rewards are application-ledger accounting.
- Marketplace payments use Pi Testnet Payments API.
============================================================
*/

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();

const PORT = Number(process.env.PORT || 10000);

const PI_API_BASE =
  process.env.PI_API_BASE || "https://api.minepi.com";

const PI_API_KEY =
  process.env.PI_API_KEY || "";

const DATABASE_URL =
  process.env.DATABASE_URL || "";

const AMT_MINING_RATE =
  Number(process.env.AMT_MINING_RATE || "0.01");

const MINING_DURATION_SECONDS =
  24 * 60 * 60;

const MAXIMUM_BASE_REWARD =
  Number((AMT_MINING_RATE * 24).toFixed(8));

const AIRDROP_AMOUNT_AMT =
  Number(process.env.AIRDROP_AMOUNT_AMT || "1");

const MAX_DIRECT_REFERRALS = null;

const MAX_SECURITY_CIRCLE = 5;

const PI_PAYMENT_API_BASE =
  process.env.PI_PAYMENT_API_BASE ||
  "https://api.testnet.minepi.com";

const MARKET_TEST_OWNER_PI_UID =
  process.env.MARKET_TEST_OWNER_PI_UID || "";

const MARKET_TEST_OWNER_USERNAME =
  process.env.MARKET_TEST_OWNER_USERNAME || "";

const MARKET_TEST_PRICE_PI =
  Number(process.env.MARKET_TEST_PRICE_PI || "0.10");

const MARKET_TEST_PRODUCT_ID =
  process.env.MARKET_TEST_PRODUCT_ID ||
  "amt-test-pet-001";

if (!DATABASE_URL) {
  console.error("DATABASE_URL is missing.");
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL
    ? { rejectUnauthorized: false }
    : undefined
});

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"]
  })
);

app.use(express.json({ limit: "1mb" }));

/* =========================================================
   HELPERS
========================================================= */

function nowIso() {
  return new Date().toISOString();
}

function authToken(req) {
  const header = req.headers.authorization || "";

  if (!header.startsWith("Bearer ")) {
    return "";
  }

  return header.slice(7).trim();
}

function cleanUsername(value) {
  return String(value || "").trim();
}

function validAmount(value) {
  const n = Number(value);

  if (!Number.isFinite(n) || n <= 0) {
    return null;
  }

  const text = String(value);

  if (text.includes(".")) {
    const decimals = text.split(".")[1].length;

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
    Date.now().toString(36).toUpperCase() +
    "-" +
    crypto.randomBytes(6).toString("hex").toUpperCase()
  );
}

async function piApiRequest(path, options = {}) {
  if (!PI_API_KEY) {
    throw new Error("PI_API_KEY is not configured.");
  }

  const response = await fetch(
    `${PI_API_BASE}${path}`,
    {
      ...options,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Key ${PI_API_KEY}`,
        ...(options.headers || {})
      }
    }
  );

  const text = await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    const error = new Error(
      data?.error ||
      data?.message ||
      `Pi API error ${response.status}`
    );

    error.status = response.status;
    error.data = data;

    throw error;
  }

  return data;
}

/* =========================================================
   PI AUTHENTICATION
========================================================= */

async function verifyPiAccessToken(accessToken) {
  if (!accessToken) {
    const error = new Error("Pi access token is required.");
    error.status = 401;
    throw error;
  }

  const response = await fetch(
    `${PI_API_BASE}/v2/me`,
    {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`
      }
    }
  );

  const text = await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    data = {};
  }

  if (!response.ok || !data?.uid) {
    const error = new Error(
      data?.error ||
      data?.message ||
      "Pi authentication failed."
    );

    error.status = 401;
    throw error;
  }

  return {
    uid: String(data.uid),
    username: cleanUsername(data.username),
    walletAddress: data.wallet_address || null
  };
}

/* =========================================================
   WALLET CREATION
========================================================= */

async function ensureAmtWallet(memberId, db = pool) {
  let result = await db.query(
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
    const wallet = result.rows[0];

    if (wallet.wallet_address) {
      return wallet;
    }
  }

  for (let attempt = 0; attempt < 5; attempt++) {
    const address = generateLedgerAddress();

    try {
      result = await db.query(
        `
        INSERT INTO amt_wallets
          (
            member_id,
            wallet_status,
            wallet_address
          )
        VALUES
          ($1, 'LEDGER_ACTIVE', $2)
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
        [memberId, address]
      );

      return result.rows[0];
    } catch (error) {
      if (error.code === "23505") {
        continue;
      }

      throw error;
    }
  }

  throw new Error("Unable to create AMT ledger wallet.");
}

/* =========================================================
   AUTHENTICATED MEMBER
========================================================= */

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
      ($1, $2)
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

  const member = result.rows[0];

  const wallet =
    await ensureAmtWallet(member.id);

  return {
    member,
    wallet,
    piUser
  };
}

async function requireAuth(req, res, next) {
  try {
    const token = authToken(req);

    if (!token) {
      return res.status(401).json({
        ok: false,
        error: "Pi login required."
      });
    }

    const auth =
      await getAuthenticatedMember(token);

    req.accessToken = token;
    req.member = auth.member;
    req.wallet = auth.wallet;
    req.piUser = auth.piUser;

    next();
  } catch (error) {
    console.error("AUTH ERROR:", error);

    return res.status(
      error.status || 401
    ).json({
      ok: false,
      error:
        error.message ||
        "Authentication failed."
    });
  }
}

/* =========================================================
   DATABASE
========================================================= */

async function initializeDatabase() {
  if (!DATABASE_URL) {
    throw new Error("DATABASE_URL is required.");
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS members (
      id BIGSERIAL PRIMARY KEY,
      pi_uid TEXT UNIQUE NOT NULL,
      username TEXT NOT NULL DEFAULT '',
      kyc_status TEXT NOT NULL DEFAULT 'UNVERIFIED',
      profile_image TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE members
    ADD COLUMN IF NOT EXISTS profile_image TEXT;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS amt_wallets (
      id BIGSERIAL PRIMARY KEY,
      member_id BIGINT UNIQUE NOT NULL
        REFERENCES members(id) ON DELETE CASCADE,
      wallet_status TEXT NOT NULL DEFAULT 'NOT_CONNECTED',
      wallet_address TEXT UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS mining_sessions (
      id BIGSERIAL PRIMARY KEY,
      member_id BIGINT NOT NULL
        REFERENCES members(id) ON DELETE CASCADE,
      started_at TIMESTAMPTZ NOT NULL,
      ends_at TIMESTAMPTZ NOT NULL,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      rate NUMERIC(30,8) NOT NULL,
      claimed_amount NUMERIC(30,8)
        NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS amt_ledger (
      id BIGSERIAL PRIMARY KEY,
      member_id BIGINT NOT NULL
        REFERENCES members(id) ON DELETE CASCADE,
      amount NUMERIC(30,8) NOT NULL,
      type TEXT NOT NULL,
      reference TEXT UNIQUE NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS referrals (
      id BIGSERIAL PRIMARY KEY,
      referrer_member_id BIGINT NOT NULL
        REFERENCES members(id) ON DELETE CASCADE,
      referred_member_id BIGINT UNIQUE NOT NULL
        REFERENCES members(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS security_circle (
      id BIGSERIAL PRIMARY KEY,
      owner_member_id BIGINT NOT NULL
        REFERENCES members(id) ON DELETE CASCADE,
      member_id BIGINT NOT NULL
        REFERENCES members(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(owner_member_id, member_id)
    );

    CREATE TABLE IF NOT EXISTS marketplace_payments (
      id BIGSERIAL PRIMARY KEY,
      pi_payment_id TEXT UNIQUE NOT NULL,
      member_id BIGINT NOT NULL
        REFERENCES members(id) ON DELETE CASCADE,
      product_id TEXT NOT NULL,
      amount NUMERIC(30,8) NOT NULL,
      status TEXT NOT NULL DEFAULT 'APPROVED',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS marketplace_purchases (
      id BIGSERIAL PRIMARY KEY,
      payment_id BIGINT NOT NULL
        REFERENCES marketplace_payments(id)
        ON DELETE CASCADE,
      member_id BIGINT NOT NULL
        REFERENCES members(id) ON DELETE CASCADE,
      product_id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS amt_transfers (
      id BIGSERIAL PRIMARY KEY,
      tx_id TEXT UNIQUE NOT NULL,
      sender_member_id BIGINT NOT NULL
        REFERENCES members(id) ON DELETE CASCADE,
      recipient_member_id BIGINT NOT NULL
        REFERENCES members(id) ON DELETE CASCADE,
      amount NUMERIC(30,8) NOT NULL,
      memo TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'COMPLETED',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS amt_airdrops (
      id BIGSERIAL PRIMARY KEY,
      member_id BIGINT UNIQUE NOT NULL
        REFERENCES members(id) ON DELETE CASCADE,
      amount NUMERIC(30,8) NOT NULL,
      reference TEXT UNIQUE NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_mining_member
      ON mining_sessions(member_id);

    CREATE INDEX IF NOT EXISTS idx_ledger_member
      ON amt_ledger(member_id);

    CREATE INDEX IF NOT EXISTS idx_referrals_referrer
      ON referrals(referrer_member_id);

    CREATE INDEX IF NOT EXISTS idx_security_owner
      ON security_circle(owner_member_id);

    CREATE INDEX IF NOT EXISTS idx_transfers_sender
      ON amt_transfers(sender_member_id);

    CREATE INDEX IF NOT EXISTS idx_transfers_recipient
      ON amt_transfers(recipient_member_id);

    CREATE INDEX IF NOT EXISTS idx_airdrop_member
      ON amt_airdrops(member_id);
  `);

  console.log("Database initialized.");
}

/* =========================================================
   ROOT / HEALTH
========================================================= */

app.get("/", async (req, res) => {
  res.json({
    ok: true,
    service: "Alberto Marketplace Token",
    symbol: "AMT",
    network: "Pi Testnet",
    environment: "TESTNET",
    version: "2.0.0",
    timestamp: nowIso()
  });
});

async function healthHandler(req, res) {
  let db = "OK";

  try {
    await pool.query("SELECT 1");
  } catch {
    db = "ERROR";
  }

  res.status(
    db === "OK" ? 200 : 503
  ).json({
    ok: db === "OK",
    service: "AMT Testnet Backend",
    database: db,
    piApiKeyConfigured: Boolean(PI_API_KEY),
    network: "Pi Testnet",
    environment: "TESTNET",
    timestamp: nowIso()
  });
}

app.get("/health", healthHandler);
app.get("/api/health", healthHandler);

/* =========================================================
   AUTH
========================================================= */

app.post(
  "/api/auth/verify",
  requireAuth,
  async (req, res) => {
    res.json({
      ok: true,
      user: {
        uid: req.piUser.uid,
        username: req.piUser.username,
        kycStatus: req.member.kyc_status,
        profileImage: req.member.profile_image || null
      },
      wallet: {
        walletStatus:
          req.wallet.wallet_status,
        walletAddress:
          req.wallet.wallet_address,
        isBlockchainWallet: false
      }
    });
  }
);

/* =========================================================
   PROFILE
========================================================= */

app.get(
  "/api/profile",
  requireAuth,
  async (req, res) => {
    res.json({
      ok: true,
      uid: req.piUser.uid,
      username: req.piUser.username,
      kycStatus: req.member.kyc_status,
      profileImage:
        req.member.profile_image || null,
      walletStatus:
        req.wallet.wallet_status,
      walletAddress:
        req.wallet.wallet_address,
      network: "Pi Testnet"
    });
  }
);

app.post(
  "/api/profile/photo",
  requireAuth,
  async (req, res) => {
    try {
      const image =
        String(req.body?.image || "").trim();

      if (!image) {
        return res.status(400).json({
          ok: false,
          error: "Profile image is required."
        });
      }

      if (
        !image.startsWith("data:image/")
      ) {
        return res.status(400).json({
          ok: false,
          error: "Invalid image format."
        });
      }

      if (image.length > 500000) {
        return res.status(413).json({
          ok: false,
          error:
            "Profile image is too large. Please use a smaller image."
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
        profileImage: image
      });
    } catch (error) {
      console.error("PHOTO ERROR:", error);

      res.status(500).json({
        ok: false,
        error: "Unable to save profile image."
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
      profileImage: null
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
      String(req.member.kyc_status)
        .toUpperCase() === "VERIFIED";

    res.json({
      ok: true,
      status: req.member.kyc_status,
      miningAllowed: true,
      migrationEligible: verified,
      protectedTransactionsEligible: verified
    });
  }
);

/* =========================================================
   WALLET
========================================================= */

async function getBalance(memberId, db = pool) {
  const result = await db.query(
    `
    SELECT
      COALESCE(
        SUM(amount),
        0
      )::NUMERIC(30,8) AS balance
    FROM amt_ledger
    WHERE member_id = $1
    `,
    [memberId]
  );

  return Number(
    result.rows[0]?.balance || 0
  );
}

app.get(
  "/api/wallet",
  requireAuth,
  async (req, res) => {
    const balance =
      await getBalance(req.member.id);

    res.json({
      ok: true,
      symbol: "AMT",
      balance,
      network: "Pi Testnet",
      walletStatus:
        req.wallet.wallet_status,
      walletAddress:
        req.wallet.wallet_address,

      /*
       * VERY IMPORTANT:
       * This is an internal application ledger address.
       * It is NOT a Stellar/Pi blockchain address.
       */
      isBlockchainWallet: false,
      walletType: "AMT_TESTNET_LEDGER"
    });
  }
);

/*
Receive:
There is no separate blockchain receive transaction here.
A Pioneer receives AMT when another AMT ledger user sends
to this user's AMT ledger address.
*/

app.post(
  "/api/wallet/send",
  requireAuth,
  async (req, res) => {
    const recipientAddress =
      String(
        req.body?.recipientAddress || ""
      ).trim().toUpperCase();

    const amount =
      validAmount(req.body?.amount);

    const memo =
      String(req.body?.memo || "")
        .trim()
        .slice(0, 160);

    if (!recipientAddress) {
      return res.status(400).json({
        ok: false,
        error: "Recipient AMT address is required."
      });
    }

    if (amount === null) {
      return res.status(400).json({
        ok: false,
        error:
          "Invalid amount. Maximum 8 decimal places."
      });
    }

    const client =
      await pool.connect();

    try {
      await client.query("BEGIN");

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
          [req.member.id]
        );

      if (!senderWallet.rows.length) {
        throw new Error(
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
          WHERE UPPER(wallet_address) = $1
          LIMIT 1
          FOR UPDATE
          `,
          [recipientAddress]
        );

      if (!recipientWallet.rows.length) {
        return res.status(404).json({
          ok: false,
          error:
            "Recipient AMT ledger address was not found."
        });
      }

      const recipient =
        recipientWallet.rows[0];

      if (
        Number(recipient.member_id) ===
        Number(req.member.id)
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "You cannot send AMT to yourself."
        });
      }

      const balanceResult =
        await client.query(
          `
          SELECT
            COALESCE(
              SUM(amount),
              0
            )::NUMERIC(30,8) AS balance
          FROM amt_ledger
          WHERE member_id = $1
          FOR UPDATE
          `,
          [req.member.id]
        );

      const balance =
        Number(
          balanceResult.rows[0]?.balance || 0
        );

      if (balance < amount) {
        return res.status(400).json({
          ok: false,
          error: "Insufficient AMT balance.",
          balance,
          requested: amount
        });
      }

      const txId =
        makeReference("AMT-TX");

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
          ($1, $2, $3, $4, $5, 'COMPLETED')
        `,
        [
          txId,
          req.member.id,
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
          ($1, $2, 'SEND',
           $3 || ':SEND')
        `,
        [
          req.member.id,
          -amount,
          txId
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
          ($1, $2, 'RECEIVE',
           $3 || ':RECEIVE')
        `,
        [
          recipient.member_id,
          amount,
          txId
        ]
      );

      await client.query("COMMIT");

      const newBalance =
        await getBalance(
          req.member.id
        );

      res.json({
        ok: true,
        txId,
        amount,
        recipientAddress,
        memo,
        balance: newBalance,
        status: "COMPLETED",
        network: "Pi Testnet",
        walletType:
          "AMT_TESTNET_LEDGER"
      });
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {}

      console.error(
        "SEND AMT ERROR:",
        error
      );

      res.status(500).json({
        ok: false,
        error:
          error.message ||
          "AMT transfer failed."
      });
    } finally {
      client.release();
    }
  }
);

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
          sw.wallet_address AS sender_address,
          rw.wallet_address AS recipient_address
        FROM amt_transfers t
        JOIN amt_wallets sw
          ON sw.member_id =
             t.sender_member_id
        JOIN amt_wallets rw
          ON rw.member_id =
             t.recipient_member_id
        WHERE
          t.sender_member_id = $1
          OR t.recipient_member_id = $1
        ORDER BY
          t.created_at DESC
        LIMIT 50
        `,
        [req.member.id]
      );

    const transactions =
      result.rows.map(row => ({
        txId: row.tx_id,
        amount: Number(row.amount),
        memo: row.memo,
        status: row.status,
        createdAt: row.created_at,
        direction:
          Number(
            row.amount
          ) >= 0 &&
          row.recipient_address ===
            req.wallet.wallet_address
            ? "RECEIVE"
            : row.sender_address ===
              req.wallet.wallet_address
              ? "SEND"
              : "UNKNOWN",
        senderAddress:
          row.sender_address,
        recipientAddress:
          row.recipient_address
      }));

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
    const result =
      await pool.query(
        `
        SELECT
          amount,
          reference,
          created_at
        FROM amt_airdrops
        WHERE member_id = $1
        LIMIT 1
        `,
        [req.member.id]
      );

    const claimed =
      result.rows.length > 0;

    res.json({
      ok: true,
      claimed,
      amount: AIRDROP_AMOUNT_AMT,
      network: "Pi Testnet",
      type: "ONE_TIME_TESTNET_AIRDROP",
      claimedAt:
        claimed
          ? result.rows[0].created_at
          : null
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
      await client.query("BEGIN");

      const existing =
        await client.query(
          `
          SELECT id
          FROM amt_airdrops
          WHERE member_id = $1
          FOR UPDATE
          `,
          [req.member.id]
        );

      if (existing.rows.length) {
        await client.query("ROLLBACK");

        return res.status(409).json({
          ok: false,
          error:
            "Airdrop has already been claimed."
        });
      }

      const reference =
        makeReference("AMT-AIRDROP");

      await client.query(
        `
        INSERT INTO amt_airdrops
          (
            member_id,
            amount,
            reference
          )
        VALUES
          ($1, $2, $3)
        `,
        [
          req.member.id,
          AIRDROP_AMOUNT_AMT,
          reference
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

      await client.query("COMMIT");

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
        network: "Pi Testnet"
      });
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {}

      console.error(
        "AIRDROP ERROR:",
        error
      );

      res.status(500).json({
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
        ORDER BY started_at DESC
        LIMIT 1
        `,
        [req.member.id]
      );

    if (active.rows.length) {
      return res.status(409).json({
        ok: false,
        error:
          "Mining session is already active.",
        session: active.rows[0]
      });
    }

    const start =
      new Date();

    const end =
      new Date(
        start.getTime() +
        MINING_DURATION_SECONDS * 1000
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
      session: result.rows[0],
      rate: AMT_MINING_RATE,
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
        ORDER BY started_at DESC
        LIMIT 1
        `,
        [req.member.id]
      );

    const balance =
      await getBalance(
        req.member.id
      );

    if (!result.rows.length) {
      return res.json({
        ok: true,
        active: false,
        completed: false,
        earned: 0,
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
          (current - started) / 1000
        )
      );

    const earned =
      Math.min(
        MAXIMUM_BASE_REWARD,
        Number(
          (
            elapsedSeconds / 3600 *
            Number(session.rate)
          ).toFixed(8)
        )
      );

    const completed =
      current >= ends;

    res.json({
      ok: true,
      active: true,
      completed,
      session,
      earned,
      balance,
      rate: Number(session.rate),
      remainingSeconds:
        Math.max(
          0,
          Math.ceil(
            (ends - current) / 1000
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
      await client.query("BEGIN");

      const sessionResult =
        await client.query(
          `
          SELECT *
          FROM mining_sessions
          WHERE
            member_id = $1
            AND status = 'ACTIVE'
          ORDER BY started_at DESC
          LIMIT 1
          FOR UPDATE
          `,
          [req.member.id]
        );

      if (!sessionResult.rows.length) {
        await client.query("ROLLBACK");

        return res.status(404).json({
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

      if (Date.now() < ends) {
        await client.query("ROLLBACK");

        return res.status(400).json({
          ok: false,
          error:
            "Mining session is not yet complete.",
          remainingSeconds:
            Math.ceil(
              (ends - Date.now()) / 1000
            )
        });
      }

      const reward =
        Number(
          (
            Number(session.rate) *
            24
          ).toFixed(8)
        );

      const reference =
        makeReference("AMT-MINING");

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

      await client.query("COMMIT");

      const balance =
        await getBalance(
          req.member.id
        );

      res.json({
        ok: true,
        reward,
        reference,
        balance,
        status: "COMPLETED"
      });
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {}

      console.error(
        "MINING CLAIM ERROR:",
        error
      );

      res.status(500).json({
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
   REFERRALS
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
      SELECT COUNT(*)::INT AS count
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

  if (existing.rows.length) {
    await client.query(
      `
      UPDATE security_circle
      SET status = 'ACTIVE'
      WHERE id = $1
      `,
      [existing.rows[0].id]
    );

    return true;
  }

  if (count >= MAX_SECURITY_CIRCLE) {
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
      ($1, $2, 'ACTIVE')
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
      return res.status(400).json({
        ok: false,
        error:
          "Valid referralMemberId is required."
      });
    }

    if (
      referredMemberId ===
      Number(req.member.id)
    ) {
      return res.status(400).json({
        ok: false,
        error:
          "You cannot refer yourself."
      });
    }

    const client =
      await pool.connect();

    try {
      await client.query("BEGIN");

      const existing =
        await client.query(
          `
          SELECT id
          FROM referrals
          WHERE referred_member_id = $1
          LIMIT 1
          `,
          [referredMemberId]
        );

      if (existing.rows.length) {
        await client.query("ROLLBACK");

        return res.status(409).json({
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
          ($1, $2, 'ACTIVE')
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

      await client.query("COMMIT");

      res.json({
        ok: true,
        linked: true,
        addedToSecurityCircle:
          addedToCircle
      });
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {}

      if (error.code === "23505") {
        return res.status(409).json({
          ok: false,
          error:
            "Referral is already linked."
        });
      }

      console.error(
        "REFERRAL ERROR:",
        error
      );

      res.status(500).json({
        ok: false,
        error:
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
        return res.status(401).json({
          ok: false,
          error:
            "Pi access token is required."
        });
      }

      if (!referralUsername) {
        return res.status(400).json({
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
        await client.query("BEGIN");

        const referrer =
          await client.query(
            `
            SELECT *
            FROM members
            WHERE LOWER(username) = LOWER($1)
            LIMIT 1
            `,
            [referralUsername]
          );

        if (!referrer.rows.length) {
          await client.query("ROLLBACK");

          return res.status(404).json({
            ok: false,
            error:
              "Referral username not found."
          });
        }

        const referrerMember =
          referrer.rows[0];

        if (
          Number(referrerMember.id) ===
          Number(auth.member.id)
        ) {
          await client.query("ROLLBACK");

          return res.status(400).json({
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
            WHERE referred_member_id = $1
            LIMIT 1
            `,
            [auth.member.id]
          );

        if (existing.rows.length) {
          await client.query("ROLLBACK");

          return res.json({
            ok: true,
            linked: false,
            alreadyLinked: true
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
            ($1, $2, 'ACTIVE')
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

        await client.query("COMMIT");

        return res.json({
          ok: true,
          linked: true,
          referrerUsername:
            referrerMember.username,
          addedToSecurityCircle:
            addedToCircle
        });
      } catch (error) {
        try {
          await client.query("ROLLBACK");
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

      res.status(
        error.status || 500
      ).json({
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
        SELECT COUNT(*)::INT AS count
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
        SELECT COUNT(*)::INT AS count
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

    res.json({
      ok: true,
      username: req.member.username,
      referralCount:
        Number(
          countResult.rows[0]?.count || 0
        ),
      maxDirectReferrals:
        "UNLIMITED",
      activeMiners:
        Number(
          activeMiners.rows[0]?.count || 0
        ),
      referrals:
        referrals.rows
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

    if (!Number.isInteger(memberId)) {
      return res.status(400).json({
        ok: false,
        error:
          "Valid memberId is required."
      });
    }

    if (
      memberId ===
      Number(req.member.id)
    ) {
      return res.status(400).json({
        ok: false,
        error:
          "You cannot add yourself."
      });
    }

    const client =
      await pool.connect();

    try {
      await client.query("BEGIN");

      const added =
        await addReferralToSecurityCircle(
          client,
          req.member.id,
          memberId
        );

      if (!added) {
        await client.query("ROLLBACK");

        return res.status(409).json({
          ok: false,
          error:
            "Security Circle is full. Maximum 5 members."
        });
      }

      await client.query("COMMIT");

      res.json({
        ok: true,
        added: true
      });
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {}

      console.error(
        "SECURITY ADD ERROR:",
        error
      );

      res.status(500).json({
        ok: false,
        error:
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
          ON m.id = sc.member_id

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
   PRIVATE PI TESTNET MARKETPLACE
========================================================= */

app.get(
  "/api/market/test-product",
  async (req, res) => {
    res.json({
      ok: true,
      product: {
        id: MARKET_TEST_PRODUCT_ID,
        name: "AMT Test Pet",
        description:
          "Private AMT Pi Testnet marketplace test item.",
        pricePi: MARKET_TEST_PRICE_PI,
        currency: "Pi",
        network: "Pi Testnet",
        environment: "TESTNET"
      }
    });
  }
);

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
        Number(req.body?.amount);

      if (!paymentId) {
        return res.status(400).json({
          ok: false,
          error:
            "Payment ID is required."
        });
      }

      if (
        productId !==
        MARKET_TEST_PRODUCT_ID
      ) {
        return res.status(400).json({
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
        return res.status(400).json({
          ok: false,
          error:
            "Invalid test price."
        });
      }

      const payment =
        await piPaymentRequest(
          `/v2/payments/${encodeURIComponent(paymentId)}`,
          "GET"
        );

      if (
        Number(payment.amount) !==
        MARKET_TEST_PRICE_PI
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "Payment amount does not match test product."
        });
      }

      await piPaymentRequest(
        `/v2/payments/${encodeURIComponent(paymentId)}/approve`,
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
            ($1, $2, $3, $4, 'APPROVED')
          ON CONFLICT (pi_payment_id)
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
        approved: true,
        payment:
          saved.rows[0]
      });
    } catch (error) {
      console.error(
        "MARKET APPROVE ERROR:",
        error
      );

      res.status(
        error.status || 500
      ).json({
        ok: false,
        error:
          error.message ||
          "Unable to approve payment."
      });
    }
  }
);

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
        return res.status(400).json({
          ok: false,
          error:
            "Payment ID is required."
        });
      }

      await client.query("BEGIN");

      const paymentResult =
        await client.query(
          `
          SELECT *
          FROM marketplace_payments
          WHERE pi_payment_id = $1
          LIMIT 1
          FOR UPDATE
          `,
          [paymentId]
        );

      if (!paymentResult.rows.length) {
        await client.query("ROLLBACK");

        return res.status(404).json({
          ok: false,
          error:
            "Marketplace payment not found."
        });
      }

      const payment =
        paymentResult.rows[0];

      if (
        Number(payment.member_id) !==
        Number(req.member.id)
      ) {
        await client.query("ROLLBACK");

        return res.status(403).json({
          ok: false,
          error:
            "Payment does not belong to this Pioneer."
        });
      }

      if (
        payment.product_id !==
        MARKET_TEST_PRODUCT_ID
      ) {
        await client.query("ROLLBACK");

        return res.status(400).json({
          ok: false,
          error:
            "Invalid marketplace product."
        });
      }

      await piPaymentRequest(
        `/v2/payments/${encodeURIComponent(paymentId)}/complete`,
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
          ($1, $2, $3)
        ON CONFLICT DO NOTHING
        `,
        [
          payment.id,
          req.member.id,
          payment.product_id
        ]
      );

      await client.query("COMMIT");

      res.json({
        ok: true,
        completed: true,
        paymentId,
        productId:
          payment.product_id,
        network:
          "Pi Testnet"
      });
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {}

      console.error(
        "MARKET COMPLETE ERROR:",
        error
      );

      res.status(
        error.status || 500
      ).json({
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
          ON p.id = mp.payment_id
        WHERE mp.member_id = $1
        ORDER BY mp.created_at DESC
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
   ERROR HANDLER
========================================================= */

app.use(
  (err, req, res, next) => {
    console.error(
      "UNHANDLED ERROR:",
      err
    );

    if (res.headersSent) {
      return next(err);
    }

    res.status(500).json({
      ok: false,
      error:
        "Internal server error."
    });
  }
);

/* =========================================================
   START
========================================================= */

async function startServer() {
  try {
    await initializeDatabase();

    app.listen(
      PORT,
      "0.0.0.0",
      () => {
        console.log(
          `AMT Testnet backend running on port ${PORT}`
        );

        console.log(
          `Environment: TESTNET`
        );

        console.log(
          `Mining rate: ${AMT_MINING_RATE} AMT/hour`
        );

        console.log(
          `Airdrop: ${AIRDROP_AMOUNT_AMT} AMT`
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