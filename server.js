"use strict";

const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");

const app = express();

const PORT = process.env.PORT || 10000;

const PI_API_BASE =
  process.env.PI_API_BASE ||
  "https://api.testnet.minepi.com";

const AMT_MINING_RATE = Number(
  process.env.AMT_MINING_RATE || "1"
);

const MINING_DURATION_SECONDS = 24 * 60 * 60;


/*
 * --------------------------------
 * DATABASE
 * --------------------------------
 */

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


/*
 * --------------------------------
 * EXPRESS
 * --------------------------------
 */

app.use(cors({
  origin: "*"
}));

app.use(express.json());


/*
 * --------------------------------
 * DATABASE INITIALIZATION
 * --------------------------------
 */

async function initializeDatabase() {

  await pool.query(`
    CREATE TABLE IF NOT EXISTS members (
      id SERIAL PRIMARY KEY,
      pi_uid TEXT UNIQUE NOT NULL,
      username TEXT,
      kyc_status TEXT NOT NULL DEFAULT 'UNVERIFIED',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);


  await pool.query(`
    CREATE TABLE IF NOT EXISTS mining_sessions (
      id SERIAL PRIMARY KEY,
      member_id INTEGER NOT NULL REFERENCES members(id),
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
      member_id INTEGER NOT NULL REFERENCES members(id),
      amount NUMERIC(30,8) NOT NULL,
      type TEXT NOT NULL,
      reference TEXT UNIQUE NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);


  await pool.query(`
    CREATE INDEX IF NOT EXISTS
    idx_mining_member
    ON mining_sessions(member_id);
  `);


  await pool.query(`
    CREATE INDEX IF NOT EXISTS
    idx_ledger_member
    ON amt_ledger(member_id);
  `);


  console.log(
    "AMT PostgreSQL database initialized."
  );
}


/*
 * --------------------------------
 * PI USER VERIFICATION
 * --------------------------------
 */

async function verifyPiAccessToken(accessToken) {

  if (!accessToken) {
    throw new Error("Missing Pi access token.");
  }


  const response = await fetch(
    `${PI_API_BASE}/v2/me`,
    {
      method: "GET",

      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Accept": "application/json"
      }
    }
  );


  const data = await response.json();


  console.log(
    "Pi API verification HTTP status:",
    response.status
  );


  if (!response.ok) {
    throw new Error(
      `Pi access token verification failed: HTTP ${response.status}`
    );
  }


  if (!data || !data.uid) {
    throw new Error(
      "Pi API response did not contain a valid UID."
    );
  }


  return {
    uid: data.uid,
    username: data.username || null
  };
}


/*
 * --------------------------------
 * GET /api/health
 * --------------------------------
 */

app.get("/api/health", async (req, res) => {

  try {

    await pool.query("SELECT 1");

    return res.json({
      success: true,
      service: "AMT Backend",
      network: "Pi Testnet",
      database: "connected",
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
 * --------------------------------
 * ROOT
 * --------------------------------
 */

app.get("/", (req, res) => {

  res.json({
    app: "Alberto Marketplace Token",
    symbol: "AMT",
    network: "Pi Testnet",
    environment: "TESTNET",
    status: "ONLINE"
  });

});


/*
 * --------------------------------
 * PI AUTH VERIFY
 * --------------------------------
 */

app.post("/api/auth/verify", async (req, res) => {

  try {

    const {
      accessToken
    } = req.body;


    const piUser =
      await verifyPiAccessToken(accessToken);


    const result = await pool.query(
      `
      INSERT INTO members
        (pi_uid, username)
      VALUES
        ($1, $2)

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


    return res.status(401).json({
      success: false,
      error:
        "Pi account verification failed."
    });

  }

});


/*
 * --------------------------------
 * AUTHENTICATED MEMBER HELPER
 * --------------------------------
 */

async function getAuthenticatedMember(
  accessToken
) {

  const piUser =
    await verifyPiAccessToken(accessToken);


  const result = await pool.query(
    `
    SELECT
      id,
      pi_uid,
      username,
      kyc_status
    FROM members
    WHERE pi_uid = $1
    `,
    [piUser.uid]
  );


  if (result.rows.length === 0) {

    const inserted = await pool.query(
      `
      INSERT INTO members
        (pi_uid, username)
      VALUES
        ($1, $2)
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


    return inserted.rows[0];
  }


  return result.rows[0];
}


/*
 * --------------------------------
 * PROFILE
 * --------------------------------
 */

app.post("/api/profile", async (req, res) => {

  try {

    const {
      accessToken
    } = req.body;


    const member =
      await getAuthenticatedMember(
        accessToken
      );


    return res.json({
      success: true,

      profile: {
        uid: member.pi_uid,
        username: member.username,
        kycStatus: member.kyc_status
      }
    });


  } catch (error) {

    console.error(
      "Profile error:",
      error.message
    );


    return res.status(401).json({
      success: false,
      error: "Profile authentication failed."
    });

  }

});


/*
 * --------------------------------
 * KYC STATUS
 * --------------------------------
 */

app.post("/api/kyc/status", async (req, res) => {

  try {

    const {
      accessToken
    } = req.body;


    const member =
      await getAuthenticatedMember(
        accessToken
      );


    return res.json({
      success: true,

      kyc: {
        status: member.kyc_status,

        miningAllowed:
          member.kyc_status === "VERIFIED"
      }
    });


  } catch (error) {

    console.error(
      "KYC status error:",
      error.message
    );


    return res.status(401).json({
      success: false,
      error: "Unable to read KYC status."
    });

  }

});


/*
 * --------------------------------
 * START MINING
 * --------------------------------
 */

app.post("/api/mining/start", async (req, res) => {

  const client =
    await pool.connect();


  try {

    const {
      accessToken
    } = req.body;


    const member =
      await getAuthenticatedMember(
        accessToken
      );


    /*
     * KYC gate
     */

    if (member.kyc_status !== "VERIFIED") {

      return res.status(403).json({
        success: false,
        code: "KYC_REQUIRED",
        message:
          "KYC verification is required before AMT mining can start."
      });

    }


    await client.query("BEGIN");


    /*
     * Lock existing active session
     */

    const active =
      await client.query(
        `
        SELECT *
        FROM mining_sessions
        WHERE member_id = $1
        AND status = 'ACTIVE'
        FOR UPDATE
        `,
        [member.id]
      );


    if (active.rows.length > 0) {

      await client.query("ROLLBACK");

      return res.json({
        success: true,
        status: "ALREADY_MINING",
        session: active.rows[0]
      });

    }


    const startedAt =
      new Date();


    const endsAt =
      new Date(
        startedAt.getTime() +
        MINING_DURATION_SECONDS * 1000
      );


    const session =
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
        ($1, $2, $3, 'ACTIVE', $4)

        RETURNING *
        `,
        [
          member.id,
          startedAt,
          endsAt,
          AMT_MINING_RATE
        ]
      );


    await client.query("COMMIT");


    return res.json({
      success: true,
      status: "MINING_STARTED",

      session: {
        id: session.rows[0].id,
        startedAt:
          session.rows[0].started_at,
        endsAt:
          session.rows[0].ends_at,
        rate:
          Number(session.rows[0].rate)
      }
    });


  } catch (error) {

    await client.query("ROLLBACK");

    console.error(
      "Start mining error:",
      error.message
    );


    return res.status(500).json({
      success: false,
      error: "Could not start mining."
    });


  } finally {

    client.release();

  }

});


/*
 * --------------------------------
 * MINING STATUS
 * --------------------------------
 */

app.post("/api/mining/status", async (req, res) => {

  try {

    const {
      accessToken
    } = req.body;


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
        [member.id]
      );


    if (result.rows.length === 0) {

      return res.json({
        success: true,
        mining: false
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
        Math.max(now, start),
        end
      );


    const elapsedSeconds =
      (current - start) / 1000;


    const earned =
      Math.min(
        AMT_MINING_RATE * (elapsedSeconds / 3600),
        AMT_MINING_RATE * 24
      );


    return res.json({
      success: true,

      mining: true,

      session: {
        id: session.id,
        startedAt:
          session.started_at,
        endsAt:
          session.ends_at,
        rate:
          Number(session.rate),
        earned:
          Number(earned.toFixed(8))
      }
    });


  } catch (error) {

    console.error(
      "Mining status error:",
      error.message
    );


    return res.status(500).json({
      success: false,
      error: "Could not read mining status."
    });

  }

});


/*
 * --------------------------------
 * CLAIM MINING REWARD
 * --------------------------------
 */

app.post("/api/mining/claim", async (req, res) => {

  const client =
    await pool.connect();


  try {

    const {
      accessToken
    } = req.body;


    const member =
      await getAuthenticatedMember(
        accessToken
      );


    await client.query("BEGIN");


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
        [member.id]
      );


    if (result.rows.length === 0) {

      await client.query("ROLLBACK");

      return res.status(404).json({
        success: false,
        error: "No active mining session."
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
        Math.max(now, start),
        end
      );


    const elapsedSeconds =
      (current - start) / 1000;


    const grossEarned =
      Math.min(
        Number(session.rate) *
        (elapsedSeconds / 3600),

        Number(session.rate) * 24
      );


    const claimable =
      Number(
        (
          grossEarned -
          Number(session.claimed_amount)
        ).toFixed(8)
      );


    if (claimable <= 0) {

      await client.query("ROLLBACK");

      return res.json({
        success: true,
        claimed: 0,
        message:
          "No new AMT reward is available yet."
      });

    }


    const reference =
      `MINING-${session.id}-${Date.now()}`;


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
      ($1, $2, 'MINING_REWARD', $3)
      `,
      [
        member.id,
        claimable,
        reference
      ]
    );


    const newClaimed =
      Number(
        session.claimed_amount
      ) + claimable;


    const sessionFinished =
      current >= end;


    await client.query(
      `
      UPDATE mining_sessions
      SET
        claimed_amount = $1,
        status = $2
      WHERE id = $3
      `,
      [
        newClaimed,
        sessionFinished
          ? "COMPLETED"
          : "ACTIVE",
        session.id
      ]
    );


    await client.query("COMMIT");


    return res.json({
      success: true,

      claimed:
        claimable,

      sessionStatus:
        sessionFinished
          ? "COMPLETED"
          : "ACTIVE",

      message:
        "AMT Testnet mining reward recorded in the ledger."
    });


  } catch (error) {

    await client.query("ROLLBACK");

    console.error(
      "Claim reward error:",
      error.message
    );


    return res.status(500).json({
      success: false,
      error:
        "Could not record AMT mining reward."
    });


  } finally {

    client.release();

  }

});


/*
 * --------------------------------
 * WALLET
 * --------------------------------
 */

app.post("/api/wallet", async (req, res) => {

  try {

    const {
      accessToken
    } = req.body;


    const member =
      await getAuthenticatedMember(
        accessToken
      );


    const result =
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
        [member.id]
      );


    const balance =
      Number(
        result.rows[0].balance
      );


    return res.json({
      success: true,

      network: "Pi Testnet",

      wallet: {
        amt: Number(
          balance.toFixed(8)
        )
      }
    });


  } catch (error) {

    console.error(
      "Wallet error:",
      error.message
    );


    return res.status(500).json({
      success: false,
      error: "Could not load AMT wallet."
    });

  }

});


/*
 * --------------------------------
 * START SERVER
 * --------------------------------
 */

async function startServer() {

  try {

    await initializeDatabase();


    app.listen(PORT, () => {

      console.log(
        "================================="
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
        "AMT mining rate:",
        AMT_MINING_RATE,
        "AMT/hour"
      );

      console.log(
        "================================="
      );

    });

  } catch (error) {

    console.error(
      "Database initialization failed:",
      error.message
    );

    process.exit(1);

  }

}


startServer();