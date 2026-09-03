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

const MINT_AMOUNT = process.env.MINT_AMOUNT || "100000";

const ISSUER_SECRET = process.env.ISSUER_SECRET;
const DISTRIBUTOR_SECRET = process.env.DISTRIBUTOR_SECRET;

if (!ISSUER_SECRET || !DISTRIBUTOR_SECRET) {
  console.error("ERROR: Missing ISSUER_SECRET or DISTRIBUTOR_SECRET.");
  console.error("Put them only in your local .env file.");
  process.exit(1);
}

const server = new StellarSDK.Horizon.Server(SERVER_URL);

const issuerKeypair = StellarSDK.Keypair.fromSecret(ISSUER_SECRET);
const distributorKeypair =
  StellarSDK.Keypair.fromSecret(DISTRIBUTOR_SECRET);

if (issuerKeypair.publicKey() !== ISSUER_PUBLIC_KEY) {
  throw new Error(
    "ISSUER_SECRET does not match the configured Issuer public address."
  );
}

if (distributorKeypair.publicKey() !== DISTRIBUTOR_PUBLIC_KEY) {
  throw new Error(
    "DISTRIBUTOR_SECRET does not match the configured Distributor public address."
  );
}

const customToken = new StellarSDK.Asset(
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
    throw new Error("Unable to obtain the latest Testnet ledger.");
  }

  return response.records[0].base_fee_in_stroops;
}

async function createTrustline() {
  console.log("\n[1/3] Checking Distributor account...");

  const distributorAccount = await server.loadAccount(
    DISTRIBUTOR_PUBLIC_KEY
  );

  const existingTrustline = distributorAccount.balances.find(
    (balance) =>
      balance.asset_type !== "native" &&
      balance.asset_code === TOKEN_CODE &&
      balance.asset_issuer === ISSUER_PUBLIC_KEY
  );

  if (existingTrustline) {
    console.log("AMT trustline already exists.");
    return;
  }

  console.log("Creating AMT trustline...");

  const baseFee = await getBaseFee();

  const transaction = new StellarSDK.TransactionBuilder(
    distributorAccount,
    {
      fee: baseFee,
      networkPassphrase: NETWORK_PASSPHRASE,
      timebounds: await server.fetchTimebounds(90)
    }
  )
    .addOperation(
      StellarSDK.Operation.changeTrust({
        asset: customToken,
        limit: undefined
      })
    )
    .build();

  transaction.sign(distributorKeypair);

  const result = await server.submitTransaction(transaction);

  console.log("Trustline created successfully.");
  console.log("Trustline TX:", result.hash);
}

async function mintToken() {
  console.log("\n[2/3] Minting AMT...");

  const issuerAccount = await server.loadAccount(
    ISSUER_PUBLIC_KEY
  );

  const baseFee = await getBaseFee();

  const transaction = new StellarSDK.TransactionBuilder(
    issuerAccount,
    {
      fee: baseFee,
      networkPassphrase: NETWORK_PASSPHRASE,
      timebounds: await server.fetchTimebounds(90)
    }
  )
    .addOperation(
      StellarSDK.Operation.payment({
        destination: DISTRIBUTOR_PUBLIC_KEY,
        asset: customToken,
        amount: MINT_AMOUNT
      })
    )
    .build();

  transaction.sign(issuerKeypair);

  const result = await server.submitTransaction(transaction);

  console.log("AMT minted successfully.");
  console.log("Amount:", MINT_AMOUNT, "AMT");
  console.log("Mint TX:", result.hash);
}

async function checkBalance() {
  console.log("\n[3/3] Checking Distributor AMT balance...");

  const account = await server.loadAccount(
    DISTRIBUTOR_PUBLIC_KEY
  );

  const nativeBalance = account.balances.find(
    (balance) => balance.asset_type === "native"
  );

  const amtBalance = account.balances.find(
    (balance) =>
      balance.asset_type !== "native" &&
      balance.asset_code === TOKEN_CODE &&
      balance.asset_issuer === ISSUER_PUBLIC_KEY
  );

  console.log(
    "Test-Pi:",
    nativeBalance ? nativeBalance.balance : "0"
  );

  console.log(
    "AMT:",
    amtBalance ? amtBalance.balance : "0"
  );
}

async function main() {
  console.log("==========================================");
  console.log(" ALBERTO MARKETPLACE TOKEN (AMT)");
  console.log(" Pi Testnet Mint Tool");
  console.log("==========================================");

  console.log("Issuer:      ", ISSUER_PUBLIC_KEY);
  console.log("Distributor: ", DISTRIBUTOR_PUBLIC_KEY);
  console.log("Token:        ", TOKEN_CODE);
  console.log("Mint amount:  ", MINT_AMOUNT);
  console.log("Network:      Pi Testnet");

  await createTrustline();
  await mintToken();
  await checkBalance();

  console.log("\nDONE.");
}

main().catch((error) => {
  console.error("\nMint failed.");

  if (error.response && error.response.data) {
    console.error(
      JSON.stringify(error.response.data, null, 2)
    );
  } else {
    console.error(error.message || error);
  }

  process.exit(1);
});