"use strict";

const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 10000;

const PI_API_BASE =
  process.env.PI_API_BASE ||
  "https://api.testnet.minepi.com";

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


    /*
     * Never print the access token.
     */

    console.log(
      "Pi authentication verification started."
    );


    const response = await fetch(
      `${PI_API_BASE}/v2/me`,
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


    const data = await response.json();


    console.log(
      "Pi API verification HTTP status:",
      response.status
    );


    /*
     * Do NOT log the complete API response.
     * It may contain user information.
     */

    if (!response.ok) {

      console.error(
        "Pi API verification failed."
      );

      return res.status(401).json({
        success: false,
        error: "Pi access token verification failed",
        piHttpStatus: response.status
      });

    }


    /*
     * Verify that Pi returned the expected
     * user identity fields.
     */

    if (!data || !data.uid) {

      console.error(
        "Pi API returned no valid user UID."
      );

      return res.status(401).json({
        success: false,
        error:
          "Pi API response did not contain a valid user identity"
      });

    }


    /*
     * Successful verification.
     */

    console.log(
      "Pi authentication verified successfully."
    );


    return res.json({
      success: true,

      user: {
        uid: data.uid,
        username:
          data.username || null
      }
    });

  } catch (error) {

    console.error(
      "Pi authentication server error:",
      error.message
    );

    return res.status(500).json({
      success: false,
      error:
        "AMT backend could not verify the Pi account"
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


  console.log(
    "Payment approval requested:",
    paymentId
  );


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


  console.log(
    "Payment completion requested:",
    paymentId
  );


  return res.json({
    success: false,
    status: "NOT_CONFIGURED",
    message:
      "Pi Testnet payment completion is not configured yet."
  });

});


/*
 * --------------------------------
 * SERVER START
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