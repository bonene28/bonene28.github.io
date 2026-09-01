"use strict";

const StellarSDK = require("@stellar/stellar-sdk");

const SERVER_URL = "https://api.testnet.minepi.com";
const NETWORK_PASSPHRASE = "Pi Testnet";
const TOKEN_CODE = "AMT";

const ISSUER_PUBLIC =
  process.env.AMT_ISSUER_PUBLIC;

const DISTRIBUTOR_PUBLIC =
  process.env.AMT_DISTRIBUTOR_PUBLIC;

const DISTRIBUTOR_SECRET =
  process.env.AMT_DISTRIBUTOR_SECRET;

if (
  !ISSUER_PUBLIC ||
  !DISTRIBUTOR_PUBLIC ||
  !DISTRIBUTOR_SECRET
) {
  throw new Error(
    "Missing AMT_ISSUER_PUBLIC, AMT_DISTRIBUTOR_PUBLIC, or AMT_DISTRIBUTOR_SECRET"
  );
}

async function main() {
  console.log("=================================");
  console.log("AMT Pi Testnet Trustline Setup");
  console.log("=================================");

  console.log("Token:", TOKEN_CODE);
  console.log("Issuer:", ISSUER_PUBLIC);
  console.log("Distributor:", DISTRIBUTOR_PUBLIC);
  console.log("Network: Pi Testnet");
  console.log("Horizon:", SERVER_URL);

  /*
   * Verify that the Distributor Secret
   * actually belongs to the Distributor.
   */
  const distributorKeypair =
    StellarSDK.Keypair.fromSecret(
      DISTRIBUTOR_SECRET
    );

  if (
    distributorKeypair.publicKey() !==
    DISTRIBUTOR_PUBLIC
  ) {
    throw new Error(
      "AMT_DISTRIBUTOR_SECRET does not match AMT_DISTRIBUTOR_PUBLIC"
    );
  }

  /*
   * AMT asset issued by the AMT issuer.
   */
  const asset = new StellarSDK.Asset(
    TOKEN_CODE,
    ISSUER_PUBLIC
  );

  const server =
    new StellarSDK.Horizon.Server(
      SERVER_URL
    );

  /*
   * Load Distributor account.
   */
  const distributorAccount =
    await server.loadAccount(
      DISTRIBUTOR_PUBLIC
    );

  console.log(
    "Distributor account found."
  );

  console.log(
    "Current sequence:",
    distributorAccount.sequence
  );

  /*
   * Use the Testnet base fee.
   */
  const latestLedger =
    await server
      .ledgers()
      .order("desc")
      .limit(1)
      .call();

  const baseFee =
    latestLedger.records[0]
      .base_fee_in_stroops;

  console.log(
    "Current base fee:",
    baseFee
  );

  /*
   * Build AMT trustline transaction.
   */
  const transaction =
    new StellarSDK.TransactionBuilder(
      distributorAccount,
      {
        fee: String(baseFee),
        networkPassphrase:
          NETWORK_PASSPHRASE,
        timebounds:
          await server.fetchTimebounds(90)
      }
    )
      .addOperation(
        StellarSDK.Operation.changeTrust({
          asset: asset
        })
      )
      .build();

  /*
   * Sign using Distributor secret.
   */
  transaction.sign(
    distributorKeypair
  );

  console.log(
    "Submitting AMT trustline transaction..."
  );

  /*
   * Submit to Pi Testnet.
   */
  const result =
    await server.submitTransaction(
      transaction
    );

  console.log("=================================");
  console.log("AMT TRUSTLINE SUCCESSFUL");
  console.log("Transaction hash:");
  console.log(result.hash);
  console.log("=================================");
}

main().catch((error) => {
  console.error("=================================");
  console.error("AMT TRUSTLINE FAILED");
  console.error("=================================");

  if (error.response?.data) {
    console.error(error.response.data);
  } else {
    console.error(error.message);
  }

  process.exit(1);
});