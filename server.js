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
 * - Pi /v2/me uses the USER ACCESS TOKEN:
 *
 *   Authorization: Bearer <accessToken>
 *
 * - The Pi Server API Key is NOT required for /v2/me.
 * - No fake blockchain AMT balance or wallet address is created.
 * ============================================================
 */


/*
 * ============================================================
 * IMPORTS
 * ============================================================
 */

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { Pool } = require("pg");


/*
 * ============================================================
 * APP
 * ============================================================
 */

const app = express();

const PORT = Number(
  process.env.PORT || 10000
);


/*
 * ============================================================
 * CONFIGURATION
 * ============================================================
 */

const PI_API_BASE =
  (
    process.env.PI_API_BASE ||
    "https://api.minepi.com"
  )
    .trim()
    .replace(/\/+$/, "");


/*
 * Optional server API key.
 *
 * It is intentionally NOT used by verifyPiAccessToken().
 */

const PI_API_KEY =
  (
    process.env.PI_API_KEY ||
    ""
  ).trim();


/*
 * AMT Testnet mining configuration.
 *
 * Default:
 * 0.01 AMT per hour
 *
 * 24 hours = 0.24 AMT maximum base reward
 */

const AMT_MINING_RATE = Number(
  process.env.AMT_MINING_RATE || "0.01"
);

const MINING_DURATION_SECONDS =
  24 * 60 * 60;

const MAXIMUM_BASE_REWARD =
  Number(
    (
      AMT_MINING_RATE * 24
    ).toFixed(8)
  );


/*
 * Referral configuration.
 */

const MAX_DIRECT_REFERRALS = 5;


/*
 * Security Circle configuration.
 */

const MAX_SECURITY_CIRCLE_MEMBERS = 5;


/*
 * ============================================================
 * VALIDATE CONFIGURATION
 * ============================================================
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
 * ============================================================
 * DATABASE
 * ============================================================
 */

const pool = new Pool({

  connectionString:
    process.env.DATABASE_URL,

  ssl: {
    rejectUnauthorized: false
  }

});


/*
 * ============================================================
 * EXPRESS MIDDLEWARE
 * ============================================================
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
 * ============================================================
 * HELPERS
 * ============================================================
 */


/*
 * Safe JSON parser for fetch responses.
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


/*
 * Return a standard API error.
 */

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
 * ============================================================
 * DATABASE INITIALIZATION
 * ============================================================
 */

async function initializeDatabase() {

  /*
   * ----------------------------------------------------------
   * MEMBERS
   * ----------------------------------------------------------
   */

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


  /*
   * ----------------------------------------------------------
   * AMT WALLETS
   * ----------------------------------------------------------
   */

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


  /*
   * ----------------------------------------------------------
   * MINING SESSIONS
   * ----------------------------------------------------------
   */

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


  /*
   * ----------------------------------------------------------
   * AMT TESTNET LEDGER
   * ----------------------------------------------------------
   */

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


  /*
   * ----------------------------------------------------------
   * REFERRALS
   * ----------------------------------------------------------
   */

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


  /*
   * ----------------------------------------------------------
   * SECURITY CIRCLE
   * ----------------------------------------------------------
   */

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


  /*
   * ----------------------------------------------------------
   * INDEXES
   * ----------------------------------------------------------
   */

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
    ON amt_ledger(member_id);
  `);


  await pool.query(`
    CREATE INDEX IF NOT EXISTS
    idx_referral_referrer
    ON referrals(referrer_member_id);
  `);


  await pool.query(`
    CREATE INDEX IF NOT EXISTS
    idx_security_owner
    ON security_circle(owner_member_id);
  `);


  console.log(
    "AMT PostgreSQL database initialized."
  );

}


/*
 * ============================================================
 * PI ACCESS TOKEN VERIFICATION
 * ============================================================
 */

async function verifyPiAccessToken(
  accessToken
) {

  if (
    !accessToken ||
    typeof accessToken !== "string"
  ) {

    const error =
      new Error(
        "Missing Pi access token."
      );

    error.statusCode = 400;

    throw error;

  }


  const endpoint =
    `${PI_API_BASE}/v2/me`;


  let response;

  try {

    response =
      await fetch(
        endpoint,
        {
          method: "GET",

          headers: {
            "Authorization":
              `Bearer ${accessToken}`,

            "Accept":
              "application/json"
          }
        }
      );

  } catch (error) {

    console.error(
      "Pi API connection error:",
      error.message
    );

    const apiError =
      new Error(
        "Unable to contact Pi Platform API."
      );

    apiError.statusCode = 502;

    throw apiError;

  }


  const data =
    await readJsonResponse(
      response
    );


  console.log(
    "Pi API verification endpoint:",
    endpoint
  );

  console.log(
    "Pi API verification HTTP status:",
    response.status
  );


  if (!response.ok) {

    const error =
      new Error(
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

    const error =
      new Error(
        "Pi API response did not contain a valid UID."
      );

    error.statusCode = 502;

    throw error;

  }


  return {

    uid:
      data.uid,

    username:
      typeof data.username === "string"
        ? data.username
        : null,

    credentials:
      data.credentials || null

  };

}


/*
 * ============================================================
 * MEMBER AUTHENTICATION
 * ============================================================
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
 * ============================================================
 * HEALTH CHECK
 * ============================================================
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
 * ============================================================
 * ROOT
 * ============================================================
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

      maximumDirectReferrals:
        MAX_DIRECT_REFERRALS,

      maximumSecurityCircleMembers:
        MAX_SECURITY_CIRCLE_MEMBERS,

      status:
        "ONLINE"

    });

  }
);


/*
 * ============================================================
 * PI AUTHENTICATION
 * ============================================================
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

  }
);


/*
 * ============================================================
 * PROFILE
 * ============================================================
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
            null

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
 * ============================================================
 * KYC STATUS
 * ============================================================
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

          migrationEligible:
            member.kyc_status ===
            "VERIFIED",

          protectedTransactionsEligible:
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
 * ============================================================
 * WALLET
 * ============================================================
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
 * ============================================================
 * START MINING
 * ============================================================
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
          (
            MINING_DURATION_SECONDS *
            1000
          )
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

        } catch (
          rollbackError
        ) {

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

      if (client) {
        client.release();
      }

    }

  }
);


/*
 * ============================================================
 * MINING STATUS
 * ============================================================
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
 * ============================================================
 * CLAIM MINING REWARD
 * ============================================================
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


      const start =
        new Date(
          session.started_at
        ).getTime();


      const end =
        new Date(
          session.ends_at
        ).getTime();


      /*
       * HARD 24-HOUR LOCK
       */

      if (now < end) {

        await client.query(
          "ROLLBACK"
        );

        transactionStarted = false;


        const remainingSeconds =
          Math.ceil(
            (
              end - now
            ) / 1000
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

        } catch (
          rollbackError
        ) {

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
 * ============================================================
 * REFERRAL - MANUAL LINK
 * ============================================================
 */

app.post(
  "/api/referral/link",
  async (req, res) => {

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


      client =
        await pool.connect();


      await client.query(
        "BEGIN"
      );

      transactionStarted = true;


      /*
       * Lock referrer before counting direct referrals.
       */

      await client.query(
        `
        SELECT id

        FROM members

        WHERE id = $1

        FOR UPDATE
        `,
        [
          referrer.rows[0].id
        ]
      );


      const existing =
        await client.query(
          `
          SELECT
            id

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

        await client.query(
          "ROLLBACK"
        );

        transactionStarted = false;


        return sendError(
          res,
          409,
          "This account already has a referral relationship."
        );

      }


      const countResult =
        await client.query(
          `
          SELECT COUNT(*) AS count

          FROM referrals

          WHERE referrer_member_id = $1
          `,
          [
            referrer.rows[0].id
          ]
        );


      const referralCount =
        Number(
          countResult.rows[0].count
        );


      if (
        referralCount >=
        MAX_DIRECT_REFERRALS
      ) {

        await client.query(
          "ROLLBACK"
        );

        transactionStarted = false;


        return res.json({

          success: false,

          linked: false,

          status:
            "REFERRER_LIMIT_REACHED",

          message:
            "The referral Pioneer has reached the 5 direct-referral limit.",

          referralCount,

          maximumDirectReferrals:
            MAX_DIRECT_REFERRALS

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
          referrer.rows[0].id,
          member.id
        ]
      );


      await client.query(
        "COMMIT"
      );

      transactionStarted = false;


      return res.json({

        success: true,

        linked: true,

        status:
          "REFERRAL_LINKED",

        referralCount:
          referralCount + 1,

        maximumDirectReferrals:
          MAX_DIRECT_REFERRALS,

        message:
          "Referral relationship recorded for Testnet."

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

        } catch (
          rollbackError
        ) {

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

      if (client) {
        client.release();
      }

    }

  }
);


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
 * The referral username comes from:
 *
 * ?ref=PiUsername
 *
 * Maximum direct referrals = 5.
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


      /*
       * Authenticate the signed-in Pioneer.
       */

      const member =
        await getAuthenticatedMember(
          accessToken
        );


      /*
       * Check whether this Pioneer
       * already has a referral relationship.
       */

      const existing =
        await pool.query(
          `
          SELECT
            id,
            referrer_member_id,
            status

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

        return res.json({

          success: true,

          linked: false,

          status:
            "ALREADY_LINKED",

          message:
            "This Pioneer already has a referral relationship."

        });

      }


      /*
       * Find referrer by Pi username.
       */

      const referrerResult =
        await pool.query(
          `
          SELECT
            id,
            pi_uid,
            username

          FROM members

          WHERE LOWER(username) =
                LOWER($1)

          LIMIT 1
          `,
          [
            cleanUsername
          ]
        );


      if (
        referrerResult.rows.length === 0
      ) {

        return res.json({

          success: false,

          linked: false,

          status:
            "REFERRER_NOT_FOUND",

          message:
            "Referral Pioneer has not joined AMT yet."

        });

      }


      const referrer =
        referrerResult.rows[0];


      /*
       * Prevent self-referral.
       */

      if (
        Number(referrer.id) ===
        Number(member.id)
      ) {

        return res.json({

          success: false,

          linked: false,

          status:
            "SELF_REFERRAL",

          message:
            "A Pioneer cannot refer themselves."

        });

      }


      /*
       * Start transaction.
       */

      client =
        await pool.connect();


      await client.query(
        "BEGIN"
      );

      transactionStarted = true;


      /*
       * Lock the referrer row.
       *
       * This prevents simultaneous requests
       * from bypassing the 5-referral limit.
       */

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
          [
            referrer.id
          ]
        );


      if (
        lockedReferrer.rows.length === 0
      ) {

        await client.query(
          "ROLLBACK"
        );

        transactionStarted = false;


        return res.json({

          success: false,

          linked: false,

          status:
            "REFERRER_NOT_FOUND"

        });

      }


      /*
       * Count active direct referrals.
       */

      const countResult =
        await client.query(
          `
          SELECT COUNT(*) AS count

          FROM referrals

          WHERE referrer_member_id = $1

          AND status = 'ACTIVE'
          `,
          [
            referrer.id
          ]
        );


      const referralCount =
        Number(
          countResult.rows[0].count
        );


      /*
       * HARD LIMIT = 5
       */

      if (
        referralCount >=
        MAX_DIRECT_REFERRALS
      ) {

        await client.query(
          "ROLLBACK"
        );

        transactionStarted = false;


        return res.json({

          success: false,

          linked: false,

          status:
            "REFERRER_LIMIT_REACHED",

          message:
            "The referral Pioneer has reached the 5 direct-referral limit.",

          referralCount,

          maximumDirectReferrals:
            MAX_DIRECT_REFERRALS

        });

      }


      /*
       * Create relationship.
       */

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
          referrer.id,
          member.id
        ]
      );


      await client.query(
        "COMMIT"
      );

      transactionStarted = false;


      return res.json({

        success: true,

        linked: true,

        status:
          "REFERRAL_LINKED",

        referrer: {

          id:
            referrer.id,

          username:
            referrer.username

        },

        referralCount:
          referralCount + 1,

        maximumDirectReferrals:
          MAX_DIRECT_REFERRALS

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

        } catch (
          rollbackError
        ) {

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

      if (client) {
        client.release();
      }

    }

  }
);

/*
 * ============================================================
 * REFERRAL STATUS
 * ============================================================
 *
 * Uses the authenticated Pi username as the AMT
 * referral identifier.
 *
 * IMPORTANT:
 * - Does NOT modify AMT ledger.
 * - Does NOT modify mining sessions.
 * - Does NOT modify claimed rewards.
 * - Existing referral relationships remain unchanged.
 * ============================================================
 */

app.post(
  "/api/referral/status",
  async (req, res) => {

    try {

      const {
        accessToken
      } = req.body || {};

      const member =
        await getAuthenticatedMember(
          accessToken
        );

      /*
       * The authenticated Pi username is the
       * canonical AMT referral identifier.
       */
      const username =
        member.username || null;

      /*
       * Load existing direct referrals.
       */
      const result =
        await pool.query(
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
          [
            member.id
          ]
        );

      const referrals =
        result.rows.map(
          row => ({
            id:
              row.member_id,

            username:
              row.username,

            mining:
              Boolean(row.mining),

            status:
              row.status
          })
        );

      /*
       * Count active miners among direct referrals.
       */
      const activeMiners =
        referrals.filter(
          item => item.mining
        ).length;

      return res.json({

        success: true,

        referral: {

          /*
           * Pi username = AMT referral identifier
           */
          username,

          count:
            referrals.length,

          activeMiners,

          maxDirectReferrals:
            MAX_DIRECT_REFERRALS,

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
 * HARD LIMIT:
 * Maximum 5 Security Circle members per Pioneer.
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
        await getAuthenticatedMember(
          accessToken
        );


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


      client =
        await pool.connect();


      await client.query(
        "BEGIN"
      );

      transactionStarted = true;


      /*
       * Lock owner row.
       *
       * This makes the 5-member limit safe
       * against simultaneous requests.
       */

      await client.query(
        `
        SELECT id

        FROM members

        WHERE id = $1

        FOR UPDATE
        `,
        [
          owner.id
        ]
      );


      /*
       * Verify target member exists.
       */

      const target =
        await client.query(
          `
          SELECT
            id,
            username

          FROM members

          WHERE id = $1

          LIMIT 1
          `,
          [
            memberId
          ]
        );


      if (
        target.rows.length === 0
      ) {

        await client.query(
          "ROLLBACK"
        );

        transactionStarted = false;


        return sendError(
          res,
          404,
          "Security Circle member not found."
        );

      }


      /*
       * Check existing relationship.
       */

      const existing =
        await client.query(
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
        existing.rows[0].status ===
        "ACTIVE"
      ) {

        await client.query(
          "COMMIT"
        );

        transactionStarted = false;


        const currentCount =
          await client.query(
            `
            SELECT COUNT(*) AS count

            FROM security_circle

            WHERE owner_member_id = $1

            AND status = 'ACTIVE'
            `,
            [
              owner.id
            ]
          );


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


      /*
       * Count active Security Circle members.
       */

      const countResult =
        await client.query(
          `
          SELECT COUNT(*) AS count

          FROM security_circle

          WHERE owner_member_id = $1

          AND status = 'ACTIVE'
          `,
          [
            owner.id
          ]
        );


      const memberCount =
        Number(
          countResult.rows[0].count
        );


      /*
       * HARD LIMIT = 5
       *
       * If reactivating an inactive existing
       * relationship, it still needs a free slot.
       */

      if (
        memberCount >=
        MAX_SECURITY_CIRCLE_MEMBERS
      ) {

        await client.query(
          "ROLLBACK"
        );

        transactionStarted = false;


        return res.json({

          success: false,

          status:
            "SECURITY_CIRCLE_LIMIT_REACHED",

          message:
            "Security Circle is full. Maximum 5 members are allowed.",

          count:
            memberCount,

          limit:
            MAX_SECURITY_CIRCLE_MEMBERS

        });

      }


      /*
       * Insert new relationship or reactivate.
       */

      if (
        existing.rows.length > 0
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


      await client.query(
        "COMMIT"
      );

      transactionStarted = false;


      return res.json({

        success: true,

        status:
          "SECURITY_CIRCLE_ADDED",

        message:
          "Security Circle member recorded.",

        count:
          memberCount + 1,

        limit:
          MAX_SECURITY_CIRCLE_MEMBERS

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

        } catch (
          rollbackError
        ) {

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

      if (client) {
        client.release();
      }

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

      const {
        accessToken
      } = req.body || {};


      const owner =
        await getAuthenticatedMember(
          accessToken
        );


      const result =
        await pool.query(
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
          [
            owner.id
          ]
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
          PI_API_KEY
            ? "YES"
            : "NO"
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
          MAX_DIRECT_REFERRALS
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


/*
 * ============================================================
 * START
 * ============================================================
 */

startServer();