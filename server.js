"use strict";

const express = require("express");
const cors = require("cors");

const app = express();

const PORT = process.env.PORT || 10000;

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
 * PAYMENT APPROVAL
 * --------------------------------
 *
 * Placeholder for Pi Testnet payment
 * approval.
 *
 * IMPORTANT:
 * Actual Pi API approval will be added
 * after the Pi API credentials are placed
 * securely in Render Environment Variables.
 */

app.post("/api/payments/approve", async (req, res) => {

  try {

    const { paymentId } = req.body;

    if (!paymentId) {
      return res.status(400).json({
        success: false,
        error: "paymentId is required"
      });
    }

    console.log(
      "Pi payment approval requested:",
      paymentId
    );

    /*
     * Pi API approval logic will be added here.
     */

    return res.json({
      success: false,
      status: "NOT_CONFIGURED",
      message:
        "Pi Testnet payment approval backend is not configured yet."
    });

  } catch (error) {

    console.error(
      "Payment approval error:",
      error
    );

    return res.status(500).json({
      success: false,
      error: "Internal server error"
    });
  }
});


/*
 * --------------------------------
 * PAYMENT COMPLETION
 * --------------------------------
 */

app.post("/api/payments/complete", async (req, res) => {

  try {

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
      "Pi payment completion requested:",
      {
        paymentId,
        txid
      }
    );

    /*
     * Pi API completion logic will be added here.
     */

    return res.json({
      success: false,
      status: "NOT_CONFIGURED",
      message:
        "Pi Testnet payment completion backend is not configured yet."
    });

  } catch (error) {

    console.error(
      "Payment completion error:",
      error
    );

    return res.status(500).json({
      success: false,
      error: "Internal server error"
    });
  }
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
    "================================="
  );

});