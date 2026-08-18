"use strict";

const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 10000;

const PI_API_BASE =
  process.env.PI_API_BASE || "https://api.testnet.minepi.com";

app.use(cors());
app.use(express.json());

/*
 * --------------------------------
 * BASIC SERVER
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
 * HEALTH CHECK
 * --------------------------------
 */

app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    service: "AMT Backend",
    network: "Pi Testnet",
    status: "healthy"
  });
});


/*
 * --------------------------------
 * PI AUTHENTICATION VERIFICATION
 * --------------------------------
 *
 * Frontend sends the Pi access token.
 *
 * The backend verifies the token against
 * Pi's /me endpoint.
 */

app.post("/api/auth/verify", async (req, res) => {

  try {

    const { accessToken } = req.body;

    if (!accessToken) {
      return res.status(400).json({
        success: false,
        error: "accessToken is required"
      });
    }

    const response = await fetch(
      `${PI_API_BASE}/v2/me`,
      {
        method: "GET",
        headers: {
          "Authorization": `Bearer ${accessToken}`
        }
      }
    );

    const data = await response.json();

    if (!response.ok) {

      console.error(
        "Pi authentication verification failed:",
        data
      );

      return res.status(401).json({
        success: false,
        error: "Invalid Pi access token"
      });
    }

    /*
     * Only after successful verification
     * do we trust the returned Pi user identity.
     */

    return res.json({
      success: true,
      user: {
        uid: data.uid,
        username: data.username
      }
    });

  } catch (error) {

    console.error(
      "Pi authentication error:",
      error
    );

    return res.status(500).json({
      success: false,
      error: "Authentication verification failed"
    });
  }
});


/*
 * --------------------------------
 * PAYMENT APPROVAL
 * --------------------------------
 */

app.post("/api/payments/approve", async (req, res) => {

  const { paymentId } = req.body;

  if (!paymentId) {
    return res.status(400).json({
      success: false,
      error: "paymentId is required"
    });
  }

  return res.json({
    success: false,
    status: "NOT_CONFIGURED",
    message:
      "Pi Testnet payment approval is not configured yet."
  });
});


/*
 * --------------------------------
 * PAYMENT COMPLETION
 * --------------------------------
 */

app.post("/api/payments/complete", async (req, res) => {

  const {
    paymentId,
    txid
  } = req.body;

  if (!paymentId || !txid) {

    return res.status(400).json({
      success: false,
      error:
        "paymentId and txid are required"
    });
  }

  return res.json({
    success: false,
    status: "NOT_CONFIGURED",
    message:
      "Pi Testnet payment completion is not configured yet."
  });
});


/*
 * --------------------------------
 * START SERVER
 * --------------------------------
 */

app.listen(PORT, () => {

  console.log(
    "================================="
  );

  console.log(
    "Alberto Marketplace Token (AMT)"
  );

  console.log(
    "Pi Testnet Backend"
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
    "================================="
  );

});