"use strict";

/*
============================================================
ALBERTO MARKETPLACE TOKEN (AMT)
PI TESTNET BACKEND
server.js

IMPORTANT:
AMT mining/ledger is TESTNET application accounting.

Pi authentication is verified server-side.

This server uses the user's Pi access token
against the Pi Platform /v2/me endpoint.

This server does NOT invent a blockchain wallet address.

This server does NOT falsely mark users as KYC VERIFIED.
============================================================
*/

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { Pool } = require("pg");

/*
============================================================
APP
============================================================
*/

const app = express();

const PORT = Number(
  process.env.PORT || 10000
);

/*
============================================================
CONFIGURATION
============================================================
*/

const PI_API_BASE = (
  process.env.PI_API_BASE ||
  "https://api.minepi.com"
)
  .trim()
  .replace(/\/+$/, "");

const PI_API_KEY = (
  process.env.PI_API_KEY || ""
).trim();

const AMT_MINING_RATE = Number(
  process.env.AMT_MINING_RATE || "0.01"
);

const MINING_DURATION_SECONDS =
  24 * 60 * 60;

const MAXIMUM_BASE_REWARD = Number(
  (AMT_MINING_RATE * 24).toFixed(8)
);

/*
============================================================
VALIDATE CONFIGURATION
============================================================
*/

if (!Number.isFinite(AMT_MINING_RATE)) {
  console.error(
    "AMT_MINING_RATE must be a valid number."
  );

  process.exit(1);
}

if (AMT_MINING_RATE < 0) {
  console.error(
    "AMT_MINING_RATE cannot be negative."
  );

  process.exit(1);
}

if (!process.env.DATABASE_URL) {
  console.error(
    "DATABASE_URL is missing."
  );

  process.exit(1);
}

/*
============================================================
DATABASE
============================================================
*/

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL,

  ssl: {
    rejectUnauthorized: false
  }
});

/*
============================================================
EXPRESS
============================================================
*/

app.use(
  cors({
    origin: "*"
  })
);

app.use(
  express.json({
    limit: "1mb"
  })
);

/*
============================================================
HELPERS
============================================================
*/

async function readJsonResponse(response) {
  const text =
    await response.text();

  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    return {
      raw: text
    };
  }
}

function sendError(
  res,
  status,
  error,
  code = null
) {
  const response = {
    success: false,
    error
  };

  if (code) {
    response.code = code;
  }

  return res
    .status(status)
    .json(response);
}

/*
============================================================
DATABASE INITIALIZATION
============================================================
*/

async function initializeDatabase() {

  await pool.query(`
    CREATE TABLE IF NOT EXISTS members (
      id SERIAL PRIMARY KEY,

      pi_uid TEXT UNIQUE NOT NULL,

      username TEXT,

      kyc_status TEXT NOT NULL
        DEFAULT 'UNVERIFIED'

        CHECK (
          kyc_status IN (
            'UNVERIFIED',
            'PENDING',
            'VERIFIED',
            'REJECTED'
          )
        ),

      created_at TIMESTAMPTZ NOT NULL
        DEFAULT NOW(),

      updated_at TIMESTAMPTZ NOT NULL
        DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS amt_wallets (
      id SERIAL PRIMARY KEY,

      member_id INTEGER UNIQUE NOT NULL
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
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS mining_sessions (
      id SERIAL PRIMARY KEY,

      member_id INTEGER NOT NULL
        REFERENCES members(id)
        ON DELETE CASCADE,

      started_at TIMESTAMPTZ NOT NULL,

      ends_at TIMESTAMPTZ NOT NULL,

      status TEXT NOT NULL
        DEFAULT 'ACTIVE'

        CHECK (
          status IN (
            'ACTIVE',
            'COMPLETED',
            'CANCELLED'
          )
        ),

      rate NUMERIC(30,8) NOT NULL,

      claimed_amount NUMERIC(30,8)
        NOT NULL DEFAULT 0,

      created_at TIMESTAMPTZ NOT NULL
        DEFAULT NOW()
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

      created_at TIMESTAMPTZ NOT NULL
        DEFAULT NOW()
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

      status TEXT NOT NULL
        DEFAULT 'ACTIVE'

        CHECK (
          status IN (
            'ACTIVE',
            'INACTIVE'
          )
        ),

      created_at TIMESTAMPTZ NOT NULL
        DEFAULT NOW()
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

      status TEXT NOT NULL
        DEFAULT 'ACTIVE'

        CHECK (
          status IN (
            'ACTIVE',
            'INACTIVE'
          )
        ),

      created_at TIMESTAMPTZ NOT NULL
        DEFAULT NOW(),

      UNIQUE (
        owner_member_id,
        member_id
      )
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS
    idx_mining_member_status
    ON mining_sessions(
      member_id,
      status
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS
    idx_ledger_member
    ON amt_ledger(
      member_id
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS
    idx_referral_referrer
    ON referrals(
      referrer_member_id
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS
    idx_security_owner
    ON security_circle(
      owner_member_id
    );
  `);

  console.log(
    "AMT PostgreSQL database initialized."
  );
}

/*
============================================================
PI ACCESS TOKEN VERIFICATION
============================================================
*/

async function verifyPiAccessToken(
  accessToken
) {

  if (
    !accessToken ||
    typeof accessToken !== "string"
  ) {
    const error = new Error(
      "Missing Pi access token."
    );

    error.statusCode = 400;

    throw error;
  }

  const endpoint =
    `${PI_API_BASE}/v2/me`;

  let response;

  try {

    response = await fetch(
      endpoint,
      {
        method: "GET",

        headers: {
          Authorization:
            `Bearer ${accessToken}`,

          Accept:
            "application/json"
        }
      }
    );

  } catch (error) {

    console.error(
      "Pi API connection error:",
      error.message
    );

    const apiError = new Error(
      "Unable to contact Pi Platform API."
    );

    apiError.statusCode = 502;

    throw apiError;
  }

  const data =
    await readJsonResponse(response);

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

    error.statusCode =
      response.status === 401
        ? 401
        : 502;

    error.piStatus =
      response.status;

    error.piResponse =
      data;

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

    credentials:
      data.credentials || null
  };
}

/*
============================================================
AUTHENTICATED MEMBER
============================================================
*/

async function getAuthenticatedMember(
  accessToken
) {

  const piUser =
    await verifyPiAccessToken(
      accessToken
    );

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
          EXCLUDED.username,

        updated_at =
          NOW()

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

  const member =
    result.rows[0];

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
    [
      member.id
    ]
  );

  return member;
}

/*
============================================================
HEALTH
============================================================
*/

app.get(
  "/api/health",
  async (req, res) => {

    try {

      await pool.query(
        "SELECT 1"
      );

      return res.json({

        success: true,

        service:
          "AMT Backend",

        network:
          "Pi Testnet",

        database:
          "connected",

        piApiBase:
          PI_API_BASE,

        status:
          "healthy"

      });

    } catch (error) {

      console.error(
        "Database health error:",
        error.message
      );

      return res
        .status(500)
        .json({

          success: false,

          service:
            "AMT Backend",

          network:
            "Pi Testnet",

          database:
            "error",

          status:
            "unhealthy"

        });
    }
  }
);

/*
============================================================
ROOT
============================================================
*/

app.get(
  "/",
  (req, res) => {

    return res.json({

      app:
        "Alberto Marketplace Token",

      symbol:
        "AMT",

      network:
        "Pi Testnet",

      environment:
        "TESTNET",

      piApiBase:
        PI_API_BASE,

      miningRate:
        `${AMT_MINING_RATE} AMT/hour`,

      miningDuration:
        "24 hours",

      maximumBaseReward:
        MAXIMUM_BASE_REWARD,

      status:
        "ONLINE"

    });
  }
);

/*
============================================================
PI AUTH VERIFY
============================================================
*/

app.post(
  "/api/auth/verify",
  async (req, res) => {

    try {

      const {
        accessToken
      } = req.body || {};

      const member =
        await getAuthenticatedMember(
          accessToken
        );

      return res.json({

        success: true,

        user: {

          uid:
            member.pi_uid,

          username:
            member.username

        },

        kyc: {

          status:
            member.kyc_status

        }

      });

    } catch (error) {

      console.error(
        "Pi authentication error:",
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
  }
);

/*
============================================================
PROFILE
============================================================
*/

app.post(
  "/api/profile",
  async (req, res) => {

    try {

      const {
        accessToken
      } = req.body || {};

      const member =
        await getAuthenticatedMember(
          accessToken
        );

      const referralCount =
        await pool.query(
          `
          SELECT
            COUNT(*)::int AS count

          FROM referrals

          WHERE referrer_member_id = $1

          AND status = 'ACTIVE'
          `,
          [
            member.id
          ]
        );

      const count =
        Number(
          referralCount.rows[0].count
        );

      let referralTier =
        "PIONEER";

      if (count >= 10) {

        referralTier =
          "LEGEND";

      } else if (count >= 5) {

        referralTier =
          "ELITE";

      } else if (count >= 1) {

        referralTier =
          "BUILDER";
      }

      const reputationScore =
        count * 10;

      const walletResult =
        await pool.query(
          `
          SELECT
            wallet_status,
            wallet_address

          FROM amt_wallets

          WHERE member_id = $1
          `,
          [
            member.id
          ]
        );

      const wallet =
        walletResult.rows[0] || null;

      return res.json({

        success: true,

        profile: {

          uid:
            member.pi_uid,

          username:
            member.username,

          kycStatus:
            member.kyc_status,

          walletStatus:
            wallet?.wallet_status ||
            "NOT_CONNECTED",

          walletAddress:
            wallet?.wallet_address ||
            null,

          reputationScore,

          referralTier

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
  }
);

/*
============================================================
KYC STATUS
============================================================
*/

app.post(
  "/api/kyc/status",
  async (req, res) => {

    try {

      const {
        accessToken
      } = req.body || {};

      const member =
        await getAuthenticatedMember(
          accessToken
        );

      return res.json({

        success: true,

        kyc: {

          status:
            member.kyc_status,

          miningAllowed:
            true,

          mainnetTransactionEligible:
            member.kyc_status ===
            "VERIFIED"

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
  }
);

/*
============================================================
WALLET
============================================================
*/

app.post(
  "/api/wallet",
  async (req, res) => {

    try {

      const {
        accessToken
      } = req.body || {};

      const member =
        await getAuthenticatedMember(
          accessToken
        );

      const balanceResult =
        await pool.query(
          `
          SELECT
            COALESCE(
              SUM(amount),
              0
            ) AS balance

          FROM amt_ledger

          WHERE member_id = $1
          `,
          [
            member.id
          ]
        );

      const walletResult =
        await pool.query(
          `
          SELECT
            wallet_status,
            wallet_address

          FROM amt_wallets

          WHERE member_id = $1
          `,
          [
            member.id
          ]
        );

      const balance =
        Number(
          balanceResult.rows[0].balance
        );

      const wallet =
        walletResult.rows[0] || null;

      return res.json({

        success: true,

        network:
          "Pi Testnet",

        wallet: {

          amt:
            Number(
              balance.toFixed(8)
            ),

          walletStatus:
            wallet?.wallet_status ||
            "NOT_CONNECTED",

          walletAddress:
            wallet?.wallet_address ||
            null

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
  }
);

/*
============================================================
START MINING
============================================================
*/

app.post(
  "/api/mining/start",
  async (req, res) => {

    let client = null;
    let transactionStarted = false;

    try {

      const {
        accessToken
      } = req.body || {};

      const member =
        await getAuthenticatedMember(
          accessToken
        );

      client =
        await pool.connect();

      await client.query(
        "BEGIN"
      );

      transactionStarted = true;

      const active =
        await client.query(
          `
          SELECT *

          FROM mining_sessions

          WHERE member_id = $1

          AND status = 'ACTIVE'

          ORDER BY id DESC

          LIMIT 1

          FOR UPDATE
          `,
          [
            member.id
          ]
        );

      if (
        active.rows.length > 0
      ) {

        await client.query(
          "COMMIT"
        );

        transactionStarted = false;

        const currentSession =
          active.rows[0];

        return res.json({

          success: true,

          status:
            "ALREADY_MINING",

          session: {

            id:
              currentSession.id,

            startedAt:
              currentSession.started_at,

            endsAt:
              currentSession.ends_at,

            rate:
              Number(
                currentSession.rate
              )

          }

        });
      }

      const startedAt =
        new Date();

      const endsAt =
        new Date(
          startedAt.getTime() +
          MINING_DURATION_SECONDS * 1000
        );

      const sessionResult =
        await client.query(
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

      await client.query(
        "COMMIT"
      );

      transactionStarted = false;

      const session =
        sessionResult.rows[0];

      return res.json({

        success: true,

        status:
          "MINING_STARTED",

        kycStatus:
          member.kyc_status,

        session: {

          id:
            session.id,

          startedAt:
            session.started_at,

          endsAt:
            session.ends_at,

          rate:
            Number(
              session.rate
            ),

          maximumBaseReward:
            MAXIMUM_BASE_REWARD

        }

      });

    } catch (error) {

      if (
        client &&
        transactionStarted
      ) {

        try {

          await client.query(
            "ROLLBACK"
          );

        } catch (rollbackError) {

          console.error(
            "Rollback error:",
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

      if (client) {
        client.release();
      }
    }
  }
);

/*
============================================================
MINING STATUS
============================================================
*/

app.post(
  "/api/mining/status",
  async (req, res) => {

    try {

      const {
        accessToken
      } = req.body || {};

      const member =
        await getAuthenticatedMember(
          accessToken
        );

      const result =
        await pool.query(
          `
          SELECT *

          FROM mining_sessions

          WHERE member_id = $1

          AND status = 'ACTIVE'

          ORDER BY id DESC

          LIMIT 1
          `,
          [
            member.id
          ]
        );

      if (
        result.rows.length === 0
      ) {

        return res.json({

          success: true,

          mining: false,

          message:
            "No active mining session."

        });
      }

      const session =
        result.rows[0];

      const now =
        Date.now();

      const start =
        new Date(
          session.started_at
        ).getTime();

      const end =
        new Date(
          session.ends_at
        ).getTime();

      const current =
        Math.min(
          Math.max(
            now,
            start
          ),
          end
        );

      const elapsedSeconds =
        (
          current - start
        ) / 1000;

      const rate =
        Number(
          session.rate
        );

      const earned =
        Math.min(
          rate *
          (
            elapsedSeconds / 3600
          ),
          rate * 24
        );

      const completed =
        now >= end;

      return res.json({

        success: true,

        mining: true,

        completed,

        session: {

          id:
            session.id,

          startedAt:
            session.started_at,

          endsAt:
            session.ends_at,

          rate,

          earned:
            Number(
              earned.toFixed(8)
            ),

          maximumBaseReward:
            Number(
              (
                rate * 24
              ).toFixed(8)
            ),

          claimAvailable:
            completed

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
  }
);

/*
============================================================
CLAIM MINING REWARD
============================================================
*/

app.post(
  "/api/mining/claim",
  async (req, res) => {

    let client = null;
    let transactionStarted = false;

    try {

      const {
        accessToken
      } = req.body || {};

      const member =
        await getAuthenticatedMember(
          accessToken
        );

      client =
        await pool.connect();

      await client.query(
        "BEGIN"
      );

      transactionStarted = true;

      const result =
        await client.query(
          `
          SELECT *

          FROM mining_sessions

          WHERE member_id = $1

          AND status = 'ACTIVE'

          ORDER BY id DESC

          LIMIT 1

          FOR UPDATE
          `,
          [
            member.id
          ]
        );

      if (
        result.rows.length === 0
      ) {

        await client.query(
          "ROLLBACK"
        );

        transactionStarted = false;

        return sendError(
          res,
          404,
          "No active mining session.",
          "NO_ACTIVE_SESSION"
        );
      }

      const session =
        result.rows[0];

      const now =
        Date.now();

      const end =
        new Date(
          session.ends_at
        ).getTime();

      if (now < end) {

        await client.query(
          "ROLLBACK"
        );

        transactionStarted = false;

        const remainingSeconds =
          Math.ceil(
            (end - now) / 1000
          );

        return res
          .status(403)
          .json({

            success: false,

            code:
              "MINING_NOT_COMPLETE",

            message:
              "The 24-hour mining session must finish before the reward can be claimed.",

            remainingSeconds

          });
      }

      const rate =
        Number(
          session.rate
        );

      const grossEarned =
        Math.min(
          rate * 24,
          MAXIMUM_BASE_REWARD
        );

      const claimable =
        Number(
          (
            grossEarned -
            Number(
              session.claimed_amount
            )
          ).toFixed(8)
        );

      if (claimable <= 0) {

        await client.query(
          "ROLLBACK"
        );

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

      const newClaimed =
        Number(
          (
            Number(
              session.claimed_amount
            ) +
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

      await client.query(
        "COMMIT"
      );

      transactionStarted = false;

      return res.json({

        success: true,

        claimed:
          claimable,

        sessionStatus:
          "COMPLETED",

        message:
          "AMT Testnet mining reward recorded in the ledger."

      });

    } catch (error) {

      if (
        client &&
        transactionStarted
      ) {

        try {

          await client.query(
            "ROLLBACK"
          );

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

      if (client) {
        client.release();
      }
    }
  }
);

/*
============================================================
REFERRAL LINK
============================================================
*/

app.post(
  "/api/referral/link",
  async (req, res) => {

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
        await getAuthenticatedMember(
          accessToken
        );

      const referrer =
        await pool.query(
          `
          SELECT
            id,
            pi_uid,
            username

          FROM members

          WHERE id = $1

          LIMIT 1
          `,
          [
            referralMemberId
          ]
        );

      if (
        referrer.rows.length === 0
      ) {

        return sendError(
          res,
          404,
          "Referral member not found."
        );
      }

      if (
        referrer.rows[0].id ===
        member.id
      ) {

        return sendError(
          res,
          400,
          "A member cannot refer themselves."
        );
      }

      const existing =
        await pool.query(
          `
          SELECT id

          FROM referrals

          WHERE referred_member_id = $1

          LIMIT 1
          `,
          [
            member.id
          ]
        );

      if (
        existing.rows.length > 0
      ) {

        return sendError(
          res,
          409,
          "This account already has a referral relationship."
        );
      }

      await pool.query(
        `
        INSERT INTO referrals
        (
          referrer_member_id,
          referred_member_id
        )

        VALUES
        (
          $1,
          $2
        )
        `,
        [
          referrer.rows[0].id,
          member.id
        ]
      );

      return res.json({

        success: true,

        status:
          "REFERRAL_LINKED",

        message:
          "Referral relationship recorded for Testnet."

      });

    } catch (error) {

      console.error(
        "Referral link error:",
        error.message
      );

      return sendError(
        res,
        error.statusCode || 500,
        "Could not create referral relationship."
      );
    }
  }
);

/*
============================================================
SERVER START
============================================================
*/

async function startServer() {

  try {

    await initializeDatabase();

    app.listen(
      PORT,
      "0.0.0.0",
      () => {

        console.log(
          `AMT Backend listening on port ${PORT}`
        );

        console.log(
          `Pi API Base: ${PI_API_BASE}`
        );

        console.log(
          "AMT Backend status: ONLINE"
        );
      }
    );

  } catch (error) {

    console.error(
      "AMT Backend startup failed:",
      error
    );

    process.exit(1);
  }
}

startServer();