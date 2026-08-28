"use strict";

/*
 * ============================================================
 * ALBERTO MARKETPLACE TOKEN (AMT)
 * PI TESTNET MINING + ADMIN PET MARKETPLACE BACKEND
 *
 * IMPORTANT
 * ------------------------------------------------------------
 * Existing systems preserved:
 * - Pi authentication
 * - AMT mining
 * - AMT testnet ledger
 * - Wallet
 * - Referral
 * - Security Circle
 *
 * Added:
 * - Admin-only Pet Marketplace
 * - Admin-only Buy flow
 * - Pi payment approval
 * - Pi payment completion
 * - Pet purchase records
 *
 * ADMIN:
 * @utoy0913
 *
 * PET/PAYMENT FEATURE:
 * TESTNET ONLY
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
 * PI CONFIGURATION
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
 * Server API Key
 *
 * Used ONLY for Pi payment server-side APIs.
 *
 * Never expose this key in frontend code.
 */

const PI_API_KEY =
  (
    process.env.PI_API_KEY ||
    ""
  ).trim();


/*
 * ============================================================
 * AMT CONFIGURATION
 * ============================================================
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
 * ============================================================
 * REFERRAL / SECURITY CIRCLE
 * ============================================================
 */

const MAX_DIRECT_REFERRALS = 5;

const MAX_SECURITY_CIRCLE_MEMBERS = 5;


/*
 * ============================================================
 * ADMIN CONFIGURATION
 * ============================================================
 *
 * Backend checks the username returned by Pi.
 *
 * Default admin:
 *
 * @utoy0913
 *
 * You can override with:
 *
 * AMT_ADMIN_PI_USERNAME
 *
 * in Render environment variables.
 * ============================================================
 */

const ADMIN_PI_USERNAME =
  (
    process.env.AMT_ADMIN_PI_USERNAME ||
    "@utoy0913"
  )
    .trim()
    .toLowerCase();


/*
 * ============================================================
 * ADMIN PET
 * ============================================================
 */

const ADMIN_PET_ID =
  "AMT-GENESIS-PET-001";

const ADMIN_PET_NAME =
  "AMT Genesis Pet";

const ADMIN_PET_PRICE_PI =
  Number(
    process.env.ADMIN_PET_PRICE_PI || "0.01"
  );

const ADMIN_PET_IMAGE =
  process.env.ADMIN_PET_IMAGE ||
  "images/amt-genesis-pet.png";


/*
 * ============================================================
 * VALIDATION
 * ============================================================
 */

if (
  !Number.isFinite(
    AMT_MINING_RATE
  )
) {

  console.error(
    "AMT_MINING_RATE must be a valid number."
  );

  process.exit(1);

}


if (
  AMT_MINING_RATE < 0
) {

  console.error(
    "AMT_MINING_RATE cannot be negative."
  );

  process.exit(1);

}


if (
  !Number.isFinite(
    ADMIN_PET_PRICE_PI
  ) ||
  ADMIN_PET_PRICE_PI <= 0
) {

  console.error(
    "ADMIN_PET_PRICE_PI must be greater than zero."
  );

  process.exit(1);

}


if (
  !process.env.DATABASE_URL
) {

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
 * EXPRESS
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

async function readJsonResponse(
  response
) {

  const text =
    await response.text();

  if (!text) {
    return null;
  }

  try {

    return JSON.parse(text);

  } catch (
    error
  ) {

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

    response.code =
      code;

  }

  return res
    .status(status)
    .json(response);

}


function normalizeUsername(
  username
) {

  if (
    typeof username !== "string"
  ) {

    return "";

  }

  return username
    .trim()
    .toLowerCase();

}


function isAdmin(
  member
) {

  return (
    normalizeUsername(
      member?.username
    ) ===
    ADMIN_PI_USERNAME
  );

}


/*
 * ============================================================
 * PI ACCESS TOKEN
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

  } catch (
    error
  ) {

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


  if (
    !response.ok
  ) {

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
 * AUTHENTICATED MEMBER
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
 * REQUIRE ADMIN
 * ============================================================
 */

async function requireAdmin(
  accessToken
) {

  const member =
    await getAuthenticatedMember(
      accessToken
    );


  if (
    !isAdmin(member)
  ) {

    const error =
      new Error(
        "Admin-only feature."
      );

    error.statusCode = 403;

    error.code =
      "ADMIN_ONLY";

    throw error;

  }


  return member;

}


/*
 * ============================================================
 * DATABASE INITIALIZATION
 * ============================================================
 */

async function initializeDatabase() {

  /*
   * MEMBERS
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
   * AMT WALLETS
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
   * MINING
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
   * LEDGER
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
   * REFERRALS
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
   * SECURITY CIRCLE
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
   * ==========================================================
   * PET ITEMS
   * ==========================================================
   */

  await pool.query(`
    CREATE TABLE IF NOT EXISTS pet_items (
      id TEXT PRIMARY KEY,

      name TEXT NOT NULL,

      description TEXT,

      image_url TEXT,

      price_pi NUMERIC(30,8) NOT NULL,

      currency TEXT NOT NULL
        DEFAULT 'PI',

      active BOOLEAN NOT NULL
        DEFAULT TRUE,

      admin_only BOOLEAN NOT NULL
        DEFAULT TRUE,

      created_at TIMESTAMPTZ NOT NULL
        DEFAULT NOW(),

      updated_at TIMESTAMPTZ NOT NULL
        DEFAULT NOW()
    );
  `);


  /*
   * ==========================================================
   * PET ORDERS
   * ==========================================================
   */

  await pool.query(`
    CREATE TABLE IF NOT EXISTS pet_orders (
      id SERIAL PRIMARY KEY,

      order_id TEXT UNIQUE NOT NULL,

      member_id INTEGER NOT NULL
        REFERENCES members(id)
        ON DELETE CASCADE,

      pet_id TEXT NOT NULL
        REFERENCES pet_items(id)
        ON DELETE RESTRICT,

      payment_id TEXT UNIQUE,

      transaction_id TEXT,

      amount_pi NUMERIC(30,8) NOT NULL,

      status TEXT NOT NULL
        DEFAULT 'CREATED'

        CHECK (
          status IN (
            'CREATED',
            'APPROVED',
            'COMPLETED',
            'CANCELLED',
            'FAILED'
          )
        ),

      payment_response JSONB,

      created_at TIMESTAMPTZ NOT NULL
        DEFAULT NOW(),

      updated_at TIMESTAMPTZ NOT NULL
        DEFAULT NOW()
    );
  `);


  /*
   * INDEXES
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


  await pool.query(`
    CREATE INDEX IF NOT EXISTS
    idx_pet_orders_member
    ON pet_orders(member_id);
  `);


  await pool.query(`
    CREATE INDEX IF NOT EXISTS
    idx_pet_orders_status
    ON pet_orders(status);
  `);


  /*
   * ==========================================================
   * DEFAULT ADMIN PET
   * ==========================================================
   */

  await pool.query(
    `
    INSERT INTO pet_items
    (
      id,
      name,
      description,
      image_url,
      price_pi,
      currency,
      active,
      admin_only
    )

    VALUES
    (
      $1,
      $2,
      $3,
      $4,
      $5,
      'PI',
      TRUE,
      TRUE
    )

    ON CONFLICT (id)

    DO UPDATE SET

      name =
        EXCLUDED.name,

      description =
        EXCLUDED.description,

      image_url =
        EXCLUDED.image_url,

      price_pi =
        EXCLUDED.price_pi,

      active =
        EXCLUDED.active,

      admin_only =
        EXCLUDED.admin_only,

      updated_at =
        NOW()
    `,
    [
      ADMIN_PET_ID,
      ADMIN_PET_NAME,
      "AMT Genesis Pet - Pi Testnet checklist payment test.",
      ADMIN_PET_IMAGE,
      ADMIN_PET_PRICE_PI
    ]
  );


  console.log(
    "AMT PostgreSQL database initialized."
  );

  console.log(
    "Admin:",
    ADMIN_PI_USERNAME
  );

  console.log(
    "Admin pet:",
    ADMIN_PET_NAME
  );

  console.log(
    "Admin pet price:",
    ADMIN_PET_PRICE_PI,
    "PI"
  );

}


/*
 * ============================================================
 * HEALTH
 * ============================================================
 */

app.get(
  "/api/health",
  async (
    req,
    res
  ) => {

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

        status:
          "healthy"

      });

    } catch (
      error
    ) {

      console.error(
        "Health error:",
        error.message
      );

      return res
        .status(500)
        .json({

          success: false,

          service:
            "AMT Backend",

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
  (
    req,
    res
  ) => {

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

      adminPet:
        true,

      status:
        "ONLINE"

    });

  }
);


/*
 * ============================================================
 * PI AUTH
 * ============================================================
 */

app.post(
  "/api/auth/verify",
  async (
    req,
    res
  ) => {

    try {

      const {
        accessToken
      } =
        req.body || {};


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

        admin:
          isAdmin(member),

        kyc: {

          status:
            member.kyc_status

        }

      });

    } catch (
      error
    ) {

      console.error(
        "Auth error:",
        error.message
      );


      return sendError(
        res,
        error.statusCode || 401,
        "Pi account verification failed."
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
  async (
    req,
    res
  ) => {

    try {

      const {
        accessToken
      } =
        req.body || {};


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
        walletResult.rows[0] ||
        null;


      return res.json({

        success: true,

        profile: {

          uid:
            member.pi_uid,

          username:
            member.username,

          kycStatus:
            member.kyc_status,

          isAdmin:
            isAdmin(member),

          walletStatus:
            wallet?.wallet_status ||
            "NOT_CONNECTED",

          walletAddress:
            wallet?.wallet_address ||
            null

        }

      });

    } catch (
      error
    ) {

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
 * KYC
 * ============================================================
 */

app.post(
  "/api/kyc/status",
  async (
    req,
    res
  ) => {

    try {

      const {
        accessToken
      } =
        req.body || {};


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

    } catch (
      error
    ) {

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
  async (
    req,
    res
  ) => {

    try {

      const {
        accessToken
      } =
        req.body || {};


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
        walletResult.rows[0] ||
        null;


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

    } catch (
      error
    ) {

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
  async (
    req,
    res
  ) => {

    let client = null;
    let transactionStarted = false;

    try {

      const {
        accessToken
      } =
        req.body || {};


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


        const session =
          active.rows[0];


        return res.json({

          success: true,

          status:
            "ALREADY_MINING",

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


      const result =
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
        result.rows[0];


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

    } catch (
      error
    ) {

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
        ) {}

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
  async (
    req,
    res
  ) => {

    try {

      const {
        accessToken
      } =
        req.body || {};


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

    } catch (
      error
    ) {

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
 * CLAIM MINING
 * ============================================================
 */

app.post(
  "/api/mining/claim",
  async (
    req,
    res
  ) => {

    let client = null;
    let transactionStarted = false;

    try {

      const {
        accessToken
      } =
        req.body || {};


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


      if (
        now < end
      ) {

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


      if (
        claimable <= 0
      ) {

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


      await client.query(
        `
        UPDATE mining_sessions

        SET

          claimed_amount = $1,

          status = 'COMPLETED'

        WHERE id = $2
        `,
        [
          grossEarned,
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

    } catch (
      error
    ) {

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
        ) {}

      }


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
 * REFERRAL LINK
 * ============================================================
 */

app.post(
  "/api/referral/link",
  async (
    req,
    res
  ) => {

    let client = null;
    let transactionStarted = false;

    try {

      const {
        accessToken,
        referralMemberId
      } =
        req.body || {};


      if (
        !referralMemberId
      ) {

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


      if (
        Number(
          referralMemberId
        ) ===
        Number(
          member.id
        )
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


      await client.query(
        `
        SELECT id

        FROM members

        WHERE id = $1

        FOR UPDATE
        `,
        [
          referralMemberId
        ]
      );


      const existing =
        await client.query(
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
            referralMemberId
          ]
        );


      const count =
        Number(
          countResult.rows[0].count
        );


      if (
        count >=
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

          referralCount:
            count,

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
          referralMemberId,
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
          count + 1,

        maximumDirectReferrals:
          MAX_DIRECT_REFERRALS

      });

    } catch (
      error
    ) {

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
        ) {}

      }


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
 * AUTOMATIC REFERRAL
 * ============================================================
 */

app.post(
  "/api/referral/auto-link",
  async (
    req,
    res
  ) => {

    let client = null;
    let transactionStarted = false;

    try {

      const {
        accessToken,
        referralUsername
      } =
        req.body || {};


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


      const member =
        await getAuthenticatedMember(
          accessToken
        );


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

        return res.json({

          success: true,

          linked: false,

          status:
            "ALREADY_LINKED"

        });

      }


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
            "REFERRER_NOT_FOUND"

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

          status:
            "SELF_REFERRAL"

        });

      }


      client =
        await pool.connect();


      await client.query(
        "BEGIN"
      );

      transactionStarted = true;


      await client.query(
        `
        SELECT id

        FROM members

        WHERE id = $1

        FOR UPDATE
        `,
        [
          referrer.id
        ]
      );


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


      const count =
        Number(
          countResult.rows[0].count
        );


      if (
        count >=
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

          referralCount:
            count,

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

          username:
            referrer.username

        },

        referralCount:
          count + 1,

        maximumDirectReferrals:
          MAX_DIRECT_REFERRALS

      });

    } catch (
      error
    ) {

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
        ) {}

      }


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
 * SECURITY CIRCLE ADD
 * ============================================================
 */

app.post(
  "/api/security-circle/add",
  async (
    req,
    res
  ) => {

    let client = null;
    let transactionStarted = false;

    try {

      const {
        accessToken,
        memberId
      } =
        req.body || {};


      if (
        !memberId
      ) {

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
          "A member cannot add themselves."
        );

      }


      client =
        await pool.connect();


      await client.query(
        "BEGIN"
      );

      transactionStarted = true;


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


      const target =
        await client.query(
          `
          SELECT id, username

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


        const count =
          await pool.query(
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
              count.rows[0].count
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
          [
            owner.id
          ]
        );


      const count =
        Number(
          countResult.rows[0].count
        );


      if (
        count >=
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

          count,

          limit:
            MAX_SECURITY_CIRCLE_MEMBERS

        });

      }


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

        count:
          count + 1,

        limit:
          MAX_SECURITY_CIRCLE_MEMBERS

      });

    } catch (
      error
    ) {

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
        ) {}

      }


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
  async (
    req,
    res
  ) => {

    try {

      const {
        accessToken
      } =
        req.body || {};


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

    } catch (
      error
    ) {

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
 * ADMIN PET MARKETPLACE
 * ============================================================
 *
 * IMPORTANT:
 *
 * Other Pioneers receive:
 *
 * pets: []
 * admin: false
 *
 * Only @utoy0913 receives the pet.
 * ============================================================
 */

app.post(
  "/api/pets",
  async (
    req,
    res
  ) => {

    try {

      const {
        accessToken
      } =
        req.body || {};


      const member =
        await getAuthenticatedMember(
          accessToken
        );


      if (
        !isAdmin(member)
      ) {

        return res.json({

          success: true,

          admin: false,

          pets: []

        });

      }


      const result =
        await pool.query(
          `
          SELECT
            id,
            name,
            description,
            image_url,
            price_pi,
            currency,
            active,
            admin_only

          FROM pet_items

          WHERE active = TRUE

          AND admin_only = TRUE

          ORDER BY created_at ASC
          `
        );


      return res.json({

        success: true,

        admin: true,

        username:
          member.username,

        pets:
          result.rows.map(
            pet => ({

              id:
                pet.id,

              name:
                pet.name,

              description:
                pet.description,

              image:
                pet.image_url,

              pricePi:
                Number(
                  pet.price_pi
                ),

              currency:
                pet.currency,

              buyEnabled:
                true

            })
          )

      });

    } catch (
      error
    ) {

      console.error(
        "Pet marketplace error:",
        error.message
      );


      return sendError(
        res,
        error.statusCode || 500,
        "Could not load pet marketplace."
      );

    }

  }
);


/*
 * ============================================================
 * ADMIN PET ORDER
 * ============================================================
 *
 * Creates the internal order BEFORE Pi.createPayment().
 *
 * Frontend then uses:
 *
 * Pi.createPayment({
 *   amount,
 *   memo,
 *   metadata
 * })
 *
 * ============================================================
 */

app.post(
  "/api/pets/order",
  async (
    req,
    res
  ) => {

    try {

      const {
        accessToken,
        petId
      } =
        req.body || {};


      const member =
        await requireAdmin(
          accessToken
        );


      if (
        !petId
      ) {

        return sendError(
          res,
          400,
          "petId is required."
        );

      }


      const petResult =
        await pool.query(
          `
          SELECT *

          FROM pet_items

          WHERE id = $1

          AND active = TRUE

          AND admin_only = TRUE

          LIMIT 1
          `,
          [
            petId
          ]
        );


      if (
        petResult.rows.length === 0
      ) {

        return sendError(
          res,
          404,
          "Pet not found."
        );

      }


      const pet =
        petResult.rows[0];


      const orderId =
        `AMT-PET-${Date.now()}-${crypto
          .randomBytes(6)
          .toString("hex")}`;


      await pool.query(
        `
        INSERT INTO pet_orders
        (
          order_id,
          member_id,
          pet_id,
          amount_pi,
          status
        )

        VALUES
        (
          $1,
          $2,
          $3,
          $4,
          'CREATED'
        )
        `,
        [
          orderId,
          member.id,
          pet.id,
          pet.price_pi
        ]
      );


      return res.json({

        success: true,

        order: {

          orderId,

          petId:
            pet.id,

          name:
            pet.name,

          amount:
            Number(
              pet.price_pi
            ),

          currency:
            "PI",

          memo:
            `AMT Testnet Pet: ${pet.name}`,

          metadata: {

            orderId,

            petId:
              pet.id,

            adminTest:
              true

          }

        }

      });

    } catch (
      error
    ) {

      console.error(
        "Create pet order error:",
        error.message
      );


      return sendError(
        res,
        error.statusCode || 500,
        error.message ===
          "Admin-only feature."
          ? "This pet purchase is admin-only."
          : "Could not create pet order.",
        error.code || null
      );

    }

  }
);


/*
 * ============================================================
 * PI PAYMENT APPROVAL
 * ============================================================
 *
 * Frontend calls this from:
 *
 * onReadyForServerApproval(paymentId)
 *
 * Server:
 *
 * 1. Authenticates @utoy0913
 * 2. Finds order
 * 3. Verifies payment with Pi
 * 4. Verifies amount
 * 5. Verifies metadata/order
 * 6. Approves payment
 * ============================================================
 */

app.post(
  "/api/payments/approve",
  async (
    req,
    res
  ) => {

    try {

      if (
        !PI_API_KEY
      ) {

        return sendError(
          res,
          500,
          "PI_API_KEY is not configured on the server.",
          "PI_API_KEY_MISSING"
        );

      }


      const {
        accessToken,
        paymentId,
        orderId
      } =
        req.body || {};


      const member =
        await requireAdmin(
          accessToken
        );


      if (
        !paymentId ||
        !orderId
      ) {

        return sendError(
          res,
          400,
          "paymentId and orderId are required."
        );

      }


      const orderResult =
        await pool.query(
          `
          SELECT
            po.*,
            p.name AS pet_name,
            p.price_pi AS pet_price

          FROM pet_orders po

          JOIN pet_items p
            ON p.id = po.pet_id

          WHERE po.order_id = $1

          AND po.member_id = $2

          LIMIT 1
          `,
          [
            orderId,
            member.id
          ]
        );


      if (
        orderResult.rows.length === 0
      ) {

        return sendError(
          res,
          404,
          "Pet order not found."
        );

      }


      const order =
        orderResult.rows[0];


      /*
       * Ask Pi for payment details.
       */

      const paymentResponse =
        await fetch(
          `${PI_API_BASE}/v2/payments/${encodeURIComponent(paymentId)}`,
          {

            method:
              "GET",

            headers: {

              "Authorization":
                `key ${PI_API_KEY}`,

              "Accept":
                "application/json"

            }

          }
        );


      const payment =
        await readJsonResponse(
          paymentResponse
        );


      if (
        !paymentResponse.ok
      ) {

        console.error(
          "Pi payment lookup failed:",
          payment
        );


        return sendError(
          res,
          502,
          "Unable to verify Pi payment.",
          "PI_PAYMENT_LOOKUP_FAILED"
        );

      }


      /*
       * SECURITY CHECK:
       *
       * Payment must belong to this app user.
       */

      if (
        payment.user_uid &&
        String(
          payment.user_uid
        ) !==
        String(
          member.pi_uid
        )
      ) {

        return sendError(
          res,
          403,
          "Pi payment user does not match the authenticated Pioneer.",
          "PAYMENT_USER_MISMATCH"
        );

      }


      /*
       * SECURITY CHECK:
       *
       * Amount must match the pet price.
       */

      const paymentAmount =
        Number(
          payment.amount
        );


      const expectedAmount =
        Number(
          order.amount_pi
        );


      if (
        !Number.isFinite(
          paymentAmount
        ) ||
        paymentAmount !==
        expectedAmount
      ) {

        return sendError(
          res,
          400,
          "Pi payment amount does not match the pet price.",
          "PAYMENT_AMOUNT_MISMATCH"
        );

      }


      /*
       * SECURITY CHECK:
       *
       * Metadata must contain our order ID
       * when available.
       */

      const metadata =
        payment.metadata || {};


      if (
        metadata.orderId &&
        String(
          metadata.orderId
        ) !==
        String(
          order.order_id
        )
      ) {

        return sendError(
          res,
          400,
          "Pi payment metadata does not match this order.",
          "PAYMENT_METADATA_MISMATCH"
        );

      }


      /*
       * Approve payment.
       */

      const approveResponse =
        await fetch(
          `${PI_API_BASE}/v2/payments/${encodeURIComponent(paymentId)}/approve`,
          {

            method:
              "POST",

            headers: {

              "Authorization":
                `key ${PI_API_KEY}`,

              "Accept":
                "application/json"

            }

          }
        );


      const approvedPayment =
        await readJsonResponse(
          approveResponse
        );


      if (
        !approveResponse.ok
      ) {

        console.error(
          "Pi payment approval failed:",
          approvedPayment
        );


        return sendError(
          res,
          502,
          "Pi payment approval failed.",
          "PI_PAYMENT_APPROVAL_FAILED"
        );

      }


      await pool.query(
        `
        UPDATE pet_orders

        SET

          payment_id = $1,

          status = 'APPROVED',

          payment_response = $2,

          updated_at = NOW()

        WHERE order_id = $3
        `,
        [
          paymentId,
          JSON.stringify(
            approvedPayment
          ),
          orderId
        ]
      );


      return res.json({

        success: true,

        approved: true,

        orderId,

        paymentId,

        status:
          "APPROVED"

      });

    } catch (
      error
    ) {

      console.error(
        "Payment approval error:",
        error.message
      );


      return sendError(
        res,
        error.statusCode || 500,
        error.message ===
          "Admin-only feature."
          ? "This payment is admin-only."
          : "Could not approve Pi payment.",
        error.code || null
      );

    }

  }
);


/*
 * ============================================================
 * PI PAYMENT COMPLETION
 * ============================================================
 *
 * Frontend calls this from:
 *
 * onReadyForServerCompletion(paymentId, txid)
 *
 * The server:
 *
 * 1. Verifies payment with Pi
 * 2. Verifies transaction
 * 3. Completes payment
 * 4. Marks pet order COMPLETED
 *
 * ============================================================
 */

app.post(
  "/api/payments/complete",
  async (
    req,
    res
  ) => {

    try {

      if (
        !PI_API_KEY
      ) {

        return sendError(
          res,
          500,
          "PI_API_KEY is not configured on the server.",
          "PI_API_KEY_MISSING"
        );

      }


      const {
        accessToken,
        paymentId,
        txid,
        orderId
      } =
        req.body || {};


      const member =
        await requireAdmin(
          accessToken
        );


      if (
        !paymentId ||
        !txid ||
        !orderId
      ) {

        return sendError(
          res,
          400,
          "paymentId, txid and orderId are required."
        );

      }


      const orderResult =
        await pool.query(
          `
          SELECT
            po.*,
            p.name AS pet_name

          FROM pet_orders po

          JOIN pet_items p
            ON p.id = po.pet_id

          WHERE po.order_id = $1

          AND po.member_id = $2

          LIMIT 1
          `,
          [
            orderId,
            member.id
          ]
        );


      if (
        orderResult.rows.length === 0
      ) {

        return sendError(
          res,
          404,
          "Pet order not found."
        );

      }


      const order =
        orderResult.rows[0];


      /*
       * Verify current payment from Pi.
       */

      const lookupResponse =
        await fetch(
          `${PI_API_BASE}/v2/payments/${encodeURIComponent(paymentId)}`,
          {

            method:
              "GET",

            headers: {

              "Authorization":
                `key ${PI_API_KEY}`,

              "Accept":
                "application/json"

            }

          }
        );


      const payment =
        await readJsonResponse(
          lookupResponse
        );


      if (
        !lookupResponse.ok
      ) {

        return sendError(
          res,
          502,
          "Unable to verify Pi payment before completion.",
          "PI_PAYMENT_VERIFY_FAILED"
        );

      }


      if (
        payment.user_uid &&
        String(
          payment.user_uid
        ) !==
        String(
          member.pi_uid
        )
      ) {

        return sendError(
          res,
          403,
          "Payment user mismatch.",
          "PAYMENT_USER_MISMATCH"
        );

      }


      if (
        payment.amount !== undefined &&
        Number(
          payment.amount
        ) !==
        Number(
          order.amount_pi
        )
      ) {

        return sendError(
          res,
          400,
          "Payment amount mismatch.",
          "PAYMENT_AMOUNT_MISMATCH"
        );

      }


      /*
       * Complete payment through Pi.
       */

      const completeResponse =
        await fetch(
          `${PI_API_BASE}/v2/payments/${encodeURIComponent(paymentId)}/complete`,
          {

            method:
              "POST",

            headers: {

              "Authorization":
                `key ${PI_API_KEY}`,

              "Content-Type":
                "application/json",

              "Accept":
                "application/json"

            },

            body:
              JSON.stringify({
                txid
              })

          }
        );


      const completedPayment =
        await readJsonResponse(
          completeResponse
        );


      if (
        !completeResponse.ok
      ) {

        console.error(
          "Pi completion failed:",
          completedPayment
        );


        return sendError(
          res,
          502,
          "Pi payment completion failed.",
          "PI_PAYMENT_COMPLETION_FAILED"
        );

      }


      /*
       * Only after successful Pi completion:
       * mark the order as completed.
       */

      await pool.query(
        `
        UPDATE pet_orders

        SET

          transaction_id = $1,

          status = 'COMPLETED',

          payment_response = $2,

          updated_at = NOW()

        WHERE order_id = $3
        `,
        [
          txid,
          JSON.stringify(
            completedPayment
          ),
          orderId
        ]
      );


      return res.json({

        success: true,

        completed: true,

        orderId,

        paymentId,

        txid,

        pet: {

          id:
            order.pet_id,

          name:
            order.pet_name

        },

        status:
          "COMPLETED"

      });

    } catch (
      error
    ) {

      console.error(
        "Payment completion error:",
        error.message
      );


      return sendError(
        res,
        error.statusCode || 500,
        error.message ===
          "Admin-only feature."
          ? "This payment is admin-only."
          : "Could not complete Pi payment.",
        error.code || null
      );

    }

  }
);


/*
 * ============================================================
 * PAYMENT CANCEL
 * ============================================================
 */

app.post(
  "/api/payments/cancel",
  async (
    req,
    res
  ) => {

    try {

      const {
        accessToken,
        orderId
      } =
        req.body || {};


      const member =
        await requireAdmin(
          accessToken
        );


      if (
        !orderId
      ) {

        return sendError(
          res,
          400,
          "orderId is required."
        );

      }


      const result =
        await pool.query(
          `
          UPDATE pet_orders

          SET

            status = 'CANCELLED',

            updated_at = NOW()

          WHERE order_id = $1

          AND member_id = $2

          AND status NOT IN (
            'COMPLETED'
          )

          RETURNING
            order_id,
            status
          `,
          [
            orderId,
            member.id
          ]
        );


      return res.json({

        success: true,

        cancelled:
          result.rows.length > 0,

        order:
          result.rows[0] || null

      });

    } catch (
      error
    ) {

      return sendError(
        res,
        error.statusCode || 500,
        "Could not cancel pet order."
      );

    }

  }
);


/*
 * ============================================================
 * INCOMPLETE PAYMENT HANDLER
 * ============================================================
 *
 * Called by frontend when Pi.authenticate()
 * reports an incomplete payment.
 * ============================================================
 */

app.post(
  "/api/payments/incomplete",
  async (
    req,
    res
  ) => {

    try {

      const {
        accessToken,
        paymentId,
        txid
      } =
        req.body || {};


      const member =
        await requireAdmin(
          accessToken
        );


      if (
        !paymentId ||
        !txid
      ) {

        return sendError(
          res,
          400,
          "paymentId and txid are required."
        );

      }


      const orderResult =
        await pool.query(
          `
          SELECT *

          FROM pet_orders

          WHERE payment_id = $1

          AND member_id = $2

          LIMIT 1
          `,
          [
            paymentId,
            member.id
          ]
        );


      if (
        orderResult.rows.length === 0
      ) {

        return sendError(
          res,
          404,
          "Incomplete payment order not found."
        );

      }


      const order =
        orderResult.rows[0];


      if (
        order.status ===
        "COMPLETED"
      ) {

        return res.json({

          success: true,

          alreadyCompleted:
            true,

          orderId:
            order.order_id

        });

      }


      /*
       * Ask Pi to complete the payment.
       */

      if (
        !PI_API_KEY
      ) {

        return sendError(
          res,
          500,
          "PI_API_KEY is not configured.",
          "PI_API_KEY_MISSING"
        );

      }


      const completeResponse =
        await fetch(
          `${PI_API_BASE}/v2/payments/${encodeURIComponent(paymentId)}/complete`,
          {

            method:
              "POST",

            headers: {

              "Authorization":
                `key ${PI_API_KEY}`,

              "Content-Type":
                "application/json",

              "Accept":
                "application/json"

            },

            body:
              JSON.stringify({
                txid
              })

          }
        );


      const completedPayment =
        await readJsonResponse(
          completeResponse
        );


      if (
        !completeResponse.ok
      ) {

        return sendError(
          res,
          502,
          "Could not complete incomplete Pi payment.",
          "PI_PAYMENT_COMPLETION_FAILED"
        );

      }


      await pool.query(
        `
        UPDATE pet_orders

        SET

          transaction_id = $1,

          status = 'COMPLETED',

          payment_response = $2,

          updated_at = NOW()

        WHERE order_id = $3
        `,
        [
          txid,
          JSON.stringify(
            completedPayment
          ),
          order.order_id
        ]
      );


      return res.json({

        success: true,

        completed: true,

        orderId:
          order.order_id,

        paymentId,

        txid,

        status:
          "COMPLETED"

      });

    } catch (
      error
    ) {

      return sendError(
        res,
        error.statusCode || 500,
        "Could not process incomplete payment."
      );

    }

  }
);


/*
 * ============================================================
 * ADMIN PET PURCHASE HISTORY
 * ============================================================
 */

app.post(
  "/api/pets/orders",
  async (
    req,
    res
  ) => {

    try {

      const {
        accessToken
      } =
        req.body || {};


      const member =
        await requireAdmin(
          accessToken
        );


      const result =
        await pool.query(
          `
          SELECT

            po.order_id,

            po.payment_id,

            po.transaction_id,

            po.amount_pi,

            po.status,

            po.created_at,

            po.updated_at,

            p.id AS pet_id,

            p.name AS pet_name

          FROM pet_orders po

          JOIN pet_items p
            ON p.id = po.pet_id

          WHERE po.member_id = $1

          ORDER BY
            po.id DESC

          LIMIT 50
          `,
          [
            member.id
          ]
        );


      return res.json({

        success: true,

        admin:
          true,

        orders:
          result.rows.map(
            row => ({

              orderId:
                row.order_id,

              paymentId:
                row.payment_id,

              transactionId:
                row.transaction_id,

              petId:
                row.pet_id,

              petName:
                row.pet_name,

              amountPi:
                Number(
                  row.amount_pi
                ),

              status:
                row.status,

              createdAt:
                row.created_at,

              updatedAt:
                row.updated_at

            })
          )

      });

    } catch (
      error
    ) {

      return sendError(
        res,
        error.statusCode || 500,
        "Could not load pet orders."
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
          "Pi /me:",
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
          "Admin:",
          ADMIN_PI_USERNAME
        );

        console.log(
          "Admin pet:",
          ADMIN_PET_NAME
        );

        console.log(
          "Admin pet price:",
          ADMIN_PET_PRICE_PI,
          "PI"
        );

        console.log(
          "Pet marketplace:",
          "ADMIN ONLY"
        );

        console.log(
          "=========================================="
        );

      }
    );

  } catch (
    error
  ) {

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