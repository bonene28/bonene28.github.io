"use strict";

const StellarSDK = require("@stellar/stellar-sdk");

const SERVER_URL = "https://api.testnet.minepi.com";
const NETWORK_PASSPHRASE = "Pi Testnet";

const TOKEN_CODE = "AMT";

const ISSUER_PUBLIC =
  process.env.AMT_ISSUER_PUBLIC;

const DISTRIBUTOR_PUBLIC =
  process.env.AMT_DISTRIBUTOR_PUBLIC;

if (!ISSUER_PUBLIC || !DISTRIBUTOR_PUBLIC) {
  throw new Error(
    "Missing AMT_ISSUER_PUBLIC or AMT_DISTRIBUTOR_PUBLIC"
  );
}

const server = new StellarSDK.Horizon.Server(SERVER_URL);

async function main() {
  console.log("=================================");
  console.log("AMT Pi Testnet Trustline Setup");
  console.log("=================================");

  console.log("Token:", TOKEN_CODE);
  console.log("Issuer:", ISSUER_PUBLIC);
  console.log("Distributor:", DISTRIBUTOR_PUBLIC);

  const issuer = new StellarSDK.Asset(
    TOKEN_CODE,
    ISSUER_PUBLIC
  );

  const distributorAccount =
    await server.loadAccount(DISTRIBUTOR_PUBLIC);

  console.log(
    "Distributor account found."
  );

  console.log(
    "Ready to establish AMT trustline."
  );

  console.log(
    "NO TRANSACTION WAS SUBMITTED."
  );
}

main().catch((error) => {
  console.error(
    "AMT trustline check failed:",
    error.message
  );
  process.exit(1);
});