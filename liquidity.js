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

const ISSUER_SECRET = process.env.ISSUER_SECRET;
const DISTRIBUTOR_SECRET = process.env.DISTRIBUTOR_SECRET;

if (!ISSUER_SECRET || !DISTRIBUTOR_SECRET) {
  console.error("ERROR: Missing ISSUER_SECRET or DISTRIBUTOR_SECRET.");
  process.exit(1);
}

const server = new StellarSDK.Horizon.Server(SERVER_URL);

const distributorKeypair =
  StellarSDK.Keypair.fromSecret(DISTRIBUTOR_SECRET);

if (distributorKeypair.publicKey() !== DISTRIBUTOR_PUBLIC_KEY) {
  throw new Error(
    "DISTRIBUTOR_SECRET does not match DISTRIBUTOR_PUBLIC_KEY."
  );
}

const amtAsset = new StellarSDK.Asset(
  TOKEN_CODE,
  ISSUER_PUBLIC_KEY
);

const piAsset = StellarSDK.Asset.native();

/*
 * Pi DEX/AMM uses:
 *
 * Asset A = native Test-Pi
 * Asset B = AMT
 *
 * AMM fee = 30 = 0.30%
 */
const POOL_FEE = 30;

// TEST LIQUIDITY
const LIQUIDITY_PI = process.env.LIQUIDITY_PI || "100";
const LIQUIDITY_AMT = process.env.LIQUIDITY_AMT || "1000000";


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


async function loadDistributor() {
  return await server.loadAccount(DISTRIBUTOR_PUBLIC_KEY);
}


function hasAMTTrustline(account) {
  return account.balances.some(
    (balance) =>
      balance.asset_type !== "native" &&
      balance.asset_code === TOKEN_CODE &&
      balance.asset_issuer === ISSUER_PUBLIC_KEY
  );
}


async function createAMTTrustlineIfNeeded() {

  console.log("\n[1/4] Checking AMT trustline...");

  const account = await loadDistributor();

  if (hasAMTTrustline(account)) {
    console.log("AMT trustline already exists.");
    return;
  }

  console.log("Creating AMT trustline...");

  const baseFee = await getBaseFee();

  const tx = new StellarSDK.TransactionBuilder(account, {
    fee: baseFee,
    networkPassphrase: NETWORK_PASSPHRASE,
    timebounds: await server.fetchTimebounds(90)
  })
    .addOperation(
      StellarSDK.Operation.changeTrust({
        asset: amtAsset
      })
    )
    .build();

  tx.sign(distributorKeypair);

  const result = await server.submitTransaction(tx);

  console.log("AMT trustline created.");
  console.log("TX:", result.hash);
}


function getPoolAsset() {

  /*
   * LiquidityPoolAsset requires assetA < assetB.
   * Native Test-Pi is used as asset A.
   * AMT is asset B.
   */

  return new StellarSDK.LiquidityPoolAsset(
    piAsset,
    amtAsset,
    POOL_FEE
  );
}


function getPoolId() {

  const poolAsset = getPoolAsset();

  const poolParameters =
    poolAsset.getLiquidityPoolParameters();

  const poolId = StellarSDK.getLiquidityPoolId(
    "constant_product",
    poolParameters
  );

  return Buffer.from(poolId).toString("hex");
}


async function createPoolShareTrustline() {

  console.log("\n[2/4] Preparing AMT/Test-Pi liquidity pool...");

  const poolAsset = getPoolAsset();

  const poolId = getPoolId();

  console.log("Pool ID:", poolId);

  const account = await loadDistributor();

  const existingPoolTrustline =
    account.balances.find(
      (balance) =>
        balance.asset_type === "liquidity_pool_shares" &&
        balance.liquidity_pool_id === poolId
    );

  if (existingPoolTrustline) {
    console.log("Pool share trustline already exists.");
    return poolId;
  }

  console.log("Creating pool share trustline...");

  const baseFee = await getBaseFee();

  const tx = new StellarSDK.TransactionBuilder(account, {
    fee: baseFee,
    networkPassphrase: NETWORK_PASSPHRASE,
    timebounds: await server.fetchTimebounds(90)
  })
    .addOperation(
      StellarSDK.Operation.changeTrust({
        asset: poolAsset
      })
    )
    .build();

  tx.sign(distributorKeypair);

  const result = await server.submitTransaction(tx);

  console.log("Pool share trustline created.");
  console.log("TX:", result.hash);

  return poolId;
}


async function addLiquidity(poolId) {

  console.log("\n[3/4] Adding liquidity...");

  console.log(
    "Deposit:",
    LIQUIDITY_PI,
    "Test-Pi +",
    LIQUIDITY_AMT,
    "AMT"
  );

  const account = await loadDistributor();

  const baseFee = await getBaseFee();

  /*
   * Initial price:
   *
   * 100 Test-Pi / 1,000,000 AMT
   *
   * = 0.0001 Test-Pi per AMT
   *
   * For deposit:
   *
   * amountA = Test-Pi
   * amountB = AMT
   */

  const initialPrice = {
    n: 100,
    d: 1000000
  };

  const tx = new StellarSDK.TransactionBuilder(account, {
    fee: baseFee,
    networkPassphrase: NETWORK_PASSPHRASE,
    timebounds: await server.fetchTimebounds(90)
  })
    .addOperation(
      StellarSDK.Operation.liquidityPoolDeposit({
        liquidityPoolId: poolId,
        maxAmountA: LIQUIDITY_PI,
        maxAmountB: LIQUIDITY_AMT,

        minPrice: initialPrice,
        maxPrice: initialPrice
      })
    )
    .build();

  tx.sign(distributorKeypair);

  const result = await server.submitTransaction(tx);

  console.log("Liquidity successfully deposited.");
  console.log("Liquidity TX:", result.hash);
}


async function checkBalances() {

  console.log("\n[4/4] Checking balances...");

  const account =
    await server.loadAccount(DISTRIBUTOR_PUBLIC_KEY);

  const piBalance = account.balances.find(
    (balance) =>
      balance.asset_type === "native"
  );

  const amtBalance = account.balances.find(
    (balance) =>
      balance.asset_type !== "native" &&
      balance.asset_code === TOKEN_CODE &&
      balance.asset_issuer === ISSUER_PUBLIC_KEY
  );

  console.log(
    "Test-Pi:",
    piBalance ? piBalance.balance : "0"
  );

  console.log(
    "AMT:",
    amtBalance ? amtBalance.balance : "0"
  );

  console.log("\nPool ID:");
  console.log(getPoolId());
}


async function main() {

  console.log("==========================================");
  console.log(" ALBERTO MARKETPLACE TOKEN");
  console.log(" AMT / TEST-PI LIQUIDITY");
  console.log(" Pi Testnet");
  console.log("==========================================");

  console.log("\nIssuer:");
  console.log(ISSUER_PUBLIC_KEY);

  console.log("\nDistributor:");
  console.log(DISTRIBUTOR_PUBLIC_KEY);

  console.log("\nPair:");
  console.log("AMT / Test-Pi");

  console.log("\nLiquidity:");
  console.log(
    LIQUIDITY_PI,
    "Test-Pi +",
    LIQUIDITY_AMT,
    "AMT"
  );

  await createAMTTrustlineIfNeeded();

  const poolId =
    await createPoolShareTrustline();

  await addLiquidity(poolId);

  await checkBalances();

  console.log("\n==========================================");
  console.log(" LIQUIDITY SETUP COMPLETE");
  console.log("==========================================");
}


main().catch((error) => {

  console.error("\nLiquidity setup failed.");

  if (error.response && error.response.data) {

    console.error(
      JSON.stringify(
        error.response.data,
        null,
        2
      )
    );

  } else {

    console.error(
      error.message || error
    );
  }

  process.exit(1);
});