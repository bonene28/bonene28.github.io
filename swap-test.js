cat > swap-test.js <<'EOF'
"use strict";

require("dotenv").config();

const StellarSDK = require("@stellar/stellar-sdk");

const SERVER_URL = "https://api.testnet.minepi.com";
const NETWORK_PASSPHRASE = "Pi Testnet";

const TOKEN_CODE = "AMT";

const ISSUER_PUBLIC_KEY =
  "GCDV5VKFE4EPQFRPDDZN64RXZMH2T4EHP47PMZ7KJMILR5DQICONMFP5";

const DISTRIBUTOR_PUBLIC_KEY =
  "GAVFYNEHSTW4P65DM75P4TYAC6PNO5A6LGSYSGEFNN3O7A23XHWABSBP";

const SWAP_PI = "0.1";

// Conservative minimum AMT output.
// If the pool gives less than this, the transaction fails safely.
const MIN_AMT_RECEIVE = "900";

const DISTRIBUTOR_SECRET = process.env.DISTRIBUTOR_SECRET;

if (!DISTRIBUTOR_SECRET) {
  throw new Error("Missing DISTRIBUTOR_SECRET in .env");
}

const server = new StellarSDK.Horizon.Server(SERVER_URL);

const distributorKeypair =
  StellarSDK.Keypair.fromSecret(DISTRIBUTOR_SECRET);

if (distributorKeypair.publicKey() !== DISTRIBUTOR_PUBLIC_KEY) {
  throw new Error(
    "DISTRIBUTOR_SECRET does not match Distributor public address."
  );
}

const piAsset = StellarSDK.Asset.native();

const amtAsset = new StellarSDK.Asset(
  TOKEN_CODE,
  ISSUER_PUBLIC_KEY
);

async function getBaseFee() {
  const response = await server
    .ledgers()
    .order("desc")
    .limit(1)
    .call();

  if (!response.records.length) {
    throw new Error("Unable to get latest Testnet ledger.");
  }

  return response.records[0].base_fee_in_stroops;
}

async function getBalances() {
  const account = await server.loadAccount(
    DISTRIBUTOR_PUBLIC_KEY
  );

  const pi = account.balances.find(
    (b) => b.asset_type === "native"
  );

  const amt = account.balances.find(
    (b) =>
      b.asset_type !== "native" &&
      b.asset_code === TOKEN_CODE &&
      b.asset_issuer === ISSUER_PUBLIC_KEY
  );

  return {
    pi: pi ? pi.balance : "0",
    amt: amt ? amt.balance : "0"
  };
}

async function swapPiToAMT() {
  console.log("==========================================");
  console.log(" AMT / TEST-PI SWAP TEST");
  console.log(" Pi Testnet");
  console.log("==========================================");

  console.log("Distributor:", DISTRIBUTOR_PUBLIC_KEY);
  console.log("Send:", SWAP_PI, "Test-Pi");
  console.log("Minimum receive:", MIN_AMT_RECEIVE, "AMT");

  const before = await getBalances();

  console.log("\nBEFORE SWAP");
  console.log("Test-Pi:", before.pi);
  console.log("AMT:", before.amt);

  if (Number(before.pi) < Number(SWAP_PI) + 1) {
    throw new Error(
      `Not enough Test-Pi. Current balance: ${before.pi}`
    );
  }

  const account = await server.loadAccount(
    DISTRIBUTOR_PUBLIC_KEY
  );

  const baseFee = await getBaseFee();

  /*
   * Empty path means the network can use the direct
   * exchange route, including the AMM liquidity pool.
   */
  const transaction = new StellarSDK.TransactionBuilder(
    account,
    {
      fee: baseFee,
      networkPassphrase: NETWORK_PASSPHRASE,
      timebounds: await server.fetchTimebounds(90)
    }
  )
    .addOperation(
      StellarSDK.Operation.pathPaymentStrictSend({
        sendAsset: piAsset,
        sendAmount: SWAP_PI,
        destination: DISTRIBUTOR_PUBLIC_KEY,
        destAsset: amtAsset,
        destMin: MIN_AMT_RECEIVE,
        path: []
      })
    )
    .build();

  transaction.sign(distributorKeypair);

  console.log("\nSubmitting swap...");

  const result = await server.submitTransaction(transaction);

  console.log("\n==========================================");
  console.log(" SWAP SUCCESSFUL");
  console.log("==========================================");

  console.log("Transaction:", result.hash);

  const after = await getBalances();

  console.log("\nAFTER SWAP");
  console.log("Test-Pi:", after.pi);
  console.log("AMT:", after.amt);

  console.log("\nCHANGE");

  console.log(
    "Test-Pi spent:",
    (Number(before.pi) - Number(after.pi)).toFixed(7)
  );

  console.log(
    "AMT received:",
    (Number(after.amt) - Number(before.amt)).toFixed(7)
  );

  console.log("\nDONE.");
}

swapPiToAMT().catch((error) => {
  console.error("\nSWAP FAILED.");

  if (error.response && error.response.data) {
    console.error(
      JSON.stringify(error.response.data, null, 2)
    );
  } else {
    console.error(error.message || error);
  }

  process.exit(1);
});
EOF

node --check swap-test.js