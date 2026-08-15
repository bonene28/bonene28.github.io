/*
 * Alberto Marketplace Token (AMT)
 * Pi Testnet Development
 *
 * TESTNET ONLY
 *
 * IMPORTANT:
 * - No private keys or secret credentials belong in this file.
 * - This file is only the frontend configuration/status layer.
 * - Actual AMT token creation must be performed through
 *   Pi's supported Testnet token infrastructure.
 */

"use strict";

const AMT = {
  name: "Alberto Marketplace Token",
  symbol: "AMT",

  // Planned testnet supply
  totalSupply: 25000000,

  network: "Pi Testnet",

  environment: "TESTNET",

  // Our Alberto token application
  appName: "Alberto Marketplace Token",

  // Website
  appUrl: "https://bonene28.github.io",

  // Current status
  status: "DEVELOPMENT",

  // This becomes useful after the actual Testnet token
  // has been created and we have its blockchain identifier.
  tokenId: null
};


/* --------------------------------
   AMT STATUS
-------------------------------- */

function getAMTStatus() {
  return {
    name: AMT.name,
    symbol: AMT.symbol,
    supply: AMT.totalSupply,
    network: AMT.network,
    environment: AMT.environment,
    status: AMT.status,
    tokenId: AMT.tokenId
  };
}


/* --------------------------------
   TESTNET CHECK
-------------------------------- */

function isTestnet() {
  return AMT.network === "Pi Testnet" &&
         AMT.environment === "TESTNET";
}


/* --------------------------------
   DISPLAY STATUS
-------------------------------- */

function showAMTStatus() {

  const statusElement = document.querySelector(".status");

  if (!statusElement) {
    return;
  }

  const title = statusElement.querySelector("h2");
  const paragraph = statusElement.querySelector("p");

  if (title) {
    title.textContent = "AMT Testnet Status";
  }

  if (paragraph) {

    if (isTestnet()) {

      paragraph.textContent =
        "AMT is currently configured for Pi Testnet development. " +
        "Actual token creation and blockchain integration are pending.";

    } else {

      paragraph.textContent =
        "Network configuration error.";
    }
  }
}


/* --------------------------------
   CONSOLE INFORMATION
-------------------------------- */

console.log("=================================");
console.log(" Alberto Marketplace Token (AMT)");
console.log("=================================");
console.log("Name:", AMT.name);
console.log("Symbol:", AMT.symbol);
console.log("Supply:", AMT.totalSupply);
console.log("Network:", AMT.network);
console.log("Environment:", AMT.environment);
console.log("Status:", AMT.status);

if (AMT.tokenId === null) {
  console.log(
    "Token ID: Not created yet — Testnet token creation pending."
  );
}


/* --------------------------------
   START
-------------------------------- */

document.addEventListener("DOMContentLoaded", () => {

  showAMTStatus();

  console.log("AMT frontend configuration loaded.");

});