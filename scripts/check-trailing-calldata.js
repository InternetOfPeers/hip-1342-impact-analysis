#!/usr/bin/env node
// check-trailing-calldata.js
//
// Reads a CSV file produced by check_contract-execution-exceptions.sh and, for
// each row, fetches the calldata from the Hedera mirror node and checks whether
// it contains trailing bytes beyond what the matched ABI function expects.
//
// Algorithm:
//   1. Look up the transaction via /api/v1/contracts/results/{transaction_id}
//   2. Decode function_parameters using the matching system-contract ABI
//      (ethers v6 loose mode tolerates trailing bytes during decode)
//   3. Re-encode the decoded arguments → canonical calldata
//   4. trailing_bytes = len(actual) – len(canonical)
//
// Usage:
//   node check-trailing-calldata.js <csv-file> [--mirror-node <url>] [--output <file>]
//
// Options:
//   --mirror-node <url>   Mirror node base URL
//                    (default: https://mainnet.mirrornode.hedera.com)
//   --output <file>  Write CSV results to <file> instead of stdout

"use strict";

const { ethers } = require("ethers");
const fs   = require("fs");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env"), quiet: true });

// ── CLI args ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
let csvFile    = null;
let mirrorBase = process.env.MIRROR_BASE || "https://mainnet.mirrornode.hedera.com";
let outputFile = null;

for (let i = 0; i < args.length; i++) {
  if      (args[i] === "--mirror-node" && args[i + 1]) mirrorBase = args[++i];
  else if (args[i] === "--output" && args[i + 1]) outputFile = args[++i];
  else if (!args[i].startsWith("--"))             csvFile    = args[i];
}

if (!csvFile) {
  process.stderr.write(
    "Usage: node check-trailing-calldata.js <csv-file> [--mirror-node <url>] [--output <file>]\n",
  );
  process.exit(1);
}

// ── ABI shorthand helpers ─────────────────────────────────────────────────────

// Reusable inline tuple strings (ABI canonical form)
const AccountAmount    = "(address accountID, int64 amount, bool isApproval)";
const NftTransfer      = "(address senderAccountID, address receiverAccountID, int64 serialNumber, bool isApproval)";
const TokenTransferList = `(address token, ${AccountAmount}[] transfers, ${NftTransfer}[] nftTransfers)`;
const TransferList     = `(${AccountAmount}[] transfers)`;
const KeyValue         = "(bool inheritAccountKey, address contractId, bytes ed25519, bytes ECDSA_secp256k1, address delegatableContractId)";
const TokenKey         = `(uint256 keyType, ${KeyValue} key)`;
const Expiry           = "(int64 second, address autoRenewAccount, int64 autoRenewPeriod)";
const HederaToken      = `(string name, string symbol, address treasury, string memo, bool tokenSupplyType, int64 maxSupply, bool freezeDefault, ${TokenKey}[] tokenKeys, ${Expiry} expiry)`;
const FixedFee         = "(int64 amount, address tokenId, bool useHbarsForPayment, bool useCurrentTokenForPayment, address feeCollector)";
const FractionalFee    = "(int64 numerator, int64 denominator, int64 minimumAmount, int64 maximumAmount, bool netOfTransfers, address feeCollector)";
const RoyaltyFee       = "(int64 numerator, int64 denominator, int64 amount, address tokenId, bool useHbarsForPayment, address feeCollector)";
const PendingAirdrop   = "(address sender, address receiver, address token, int64 serial)";
const NftID            = "(address nft, int64 serial)";

// ── System-contract ABIs ──────────────────────────────────────────────────────
// Source: https://github.com/hiero-ledger/hiero-contracts

// HTS — Hedera Token Service  (0x167)
const HTS_ABI = [
  // ── Crypto transfer ────────────────────────────────────────────────────────
  `function cryptoTransfer(${TransferList} transferList, ${TokenTransferList}[] tokenTransfers) returns (int64 responseCode)`,
  // ── Fungible token transfers ───────────────────────────────────────────────
  `function transferToken(address token, address sender, address receiver, int64 amount) returns (int64 responseCode)`,
  `function transferTokens(address token, address[] accountId, int64[] amounts) returns (int64 responseCode)`,
  `function transferFrom(address token, address from, address to, uint256 amount) returns (int64 responseCode)`,
  // ── NFT transfers ──────────────────────────────────────────────────────────
  `function transferNFT(address token, address sender, address receiver, int64 serialNumber) returns (int64 responseCode)`,
  `function transferNFTs(address token, address[] sender, address[] receiver, int64[] serialNumbers) returns (int64 responseCode)`,
  `function transferFromNFT(address token, address from, address to, uint256 serialNumber) returns (int64 responseCode)`,
  // ── Airdrop ────────────────────────────────────────────────────────────────
  `function airdropTokens(${TokenTransferList}[] tokenTransfers) returns (int64 responseCode)`,
  `function cancelAirdrops(${PendingAirdrop}[] pendingAirdrops) returns (int64 responseCode)`,
  `function claimAirdrops(${PendingAirdrop}[] pendingAirdrops) returns (int64 responseCode)`,
  `function rejectTokens(address rejector, address[] ftTokens, ${NftID}[] nftIDs) returns (int64 responseCode)`,
  // ── Associate / dissociate ─────────────────────────────────────────────────
  `function associateTokens(address account, address[] tokens) returns (int64 responseCode)`,
  `function associateToken(address account, address token) returns (int64 responseCode)`,
  `function dissociateTokens(address account, address[] tokens) returns (int64 responseCode)`,
  `function dissociateToken(address account, address token) returns (int64 responseCode)`,
  // ── Mint / burn / wipe ─────────────────────────────────────────────────────
  `function mintToken(address token, int64 amount, bytes[] metadata) returns (int64 responseCode, int64 newTotalSupply, int64[] serialNumbers)`,
  `function burnToken(address token, int64 amount, int64[] serialNumbers) returns (int64 responseCode, int64 newTotalSupply)`,
  `function wipeTokenAccount(address token, address account, int64 amount) returns (int64 responseCode)`,
  `function wipeTokenAccountNFT(address token, address account, int64[] serialNumbers) returns (int64 responseCode)`,
  // ── Freeze / pause / KYC ──────────────────────────────────────────────────
  `function freezeToken(address token, address account) returns (int64 responseCode)`,
  `function unfreezeToken(address token, address account) returns (int64 responseCode)`,
  `function pauseToken(address token) returns (int64 responseCode)`,
  `function unpauseToken(address token) returns (int64 responseCode)`,
  `function grantTokenKyc(address token, address account) returns (int64 responseCode)`,
  `function revokeTokenKyc(address token, address account) returns (int64 responseCode)`,
  // ── Approvals ──────────────────────────────────────────────────────────────
  `function approve(address token, address spender, uint256 amount) returns (int64 responseCode)`,
  `function approveNFT(address token, address approved, uint256 serialNumber) returns (int64 responseCode)`,
  `function setApprovalForAll(address token, address operator, bool approved) returns (int64 responseCode)`,
  `function isApprovedForAll(address token, address owner, address operator) returns (int64 responseCode, bool approved)`,
  `function getApproved(address token, uint256 serialNumber) returns (int64 responseCode, address approved)`,
  `function allowance(address token, address owner, address spender) returns (int64 responseCode, uint256 allowance)`,
  // ── Token lifecycle ────────────────────────────────────────────────────────
  `function deleteToken(address token) returns (int64 responseCode)`,
  `function redirectForToken(address token, bytes encodedFunctionSelector) returns (int64 responseCode, bytes response)`,
  // ── Create token ──────────────────────────────────────────────────────────
  `function createFungibleToken(${HederaToken} token, int64 initialTotalSupply, int32 decimals) payable returns (int64 responseCode, address tokenAddress)`,
  `function createFungibleTokenWithCustomFees(${HederaToken} token, int64 initialTotalSupply, int32 decimals, ${FixedFee}[] fixedFees, ${FractionalFee}[] fractionalFees) payable returns (int64 responseCode, address tokenAddress)`,
  `function createNonFungibleToken(${HederaToken} token) payable returns (int64 responseCode, address tokenAddress)`,
  `function createNonFungibleTokenWithCustomFees(${HederaToken} token, ${FixedFee}[] fixedFees, ${RoyaltyFee}[] royaltyFees) payable returns (int64 responseCode, address tokenAddress)`,
  // ── Update token ──────────────────────────────────────────────────────────
  `function updateTokenInfo(address token, ${HederaToken} tokenInfo) returns (int64 responseCode)`,
  `function updateTokenExpiryInfo(address token, ${Expiry} expiryInfo) returns (int64 responseCode)`,
  `function updateTokenKeys(address token, ${TokenKey}[] keys) returns (int64 responseCode)`,
  `function updateFungibleTokenCustomFees(address token, ${FixedFee}[] fixedFees, ${FractionalFee}[] fractionalFees) returns (int64 responseCode)`,
  `function updateNonFungibleTokenCustomFees(address token, ${FixedFee}[] fixedFees, ${RoyaltyFee}[] royaltyFees) returns (int64 responseCode)`,
  // ── Queries ────────────────────────────────────────────────────────────────
  `function isToken(address token) returns (int64 responseCode, bool isToken)`,
  `function getTokenType(address token) returns (int64 responseCode, int32 tokenType)`,
  `function getTokenDefaultFreezeStatus(address token) returns (int64 responseCode, bool defaultFreezeStatus)`,
  `function getTokenDefaultKycStatus(address token) returns (int64 responseCode, bool defaultKycStatus)`,
  `function isFrozen(address token, address account) returns (int64 responseCode, bool frozen)`,
  `function isKyc(address token, address account) returns (int64 responseCode, bool kycGranted)`,
];

// HAS — Hedera Account Service  (0x16a)
// Two variants of hbarApprove are included: the 3-param version from the current
// interface and a legacy 2-param version that matches the selector seen on mainnet.
const HAS_ABI = [
  `function hbarAllowance(address owner, address spender) returns (int64 responseCode, int256 allowance)`,
  `function hbarApprove(address owner, address spender, int256 amount) returns (int64 responseCode)`,
  // Legacy 2-param form deployed on mainnet (different selector, kept for coverage)
  `function hbarApprove(address spender, int256 amount) returns (int64 responseCode)`,
  `function isAuthorizedRaw(address account, bytes messageHash, bytes signature) returns (bool isAuthorized)`,
  `function isAuthorized(address account, bytes message, bytes signature) returns (bool isAuthorized)`,
  `function getEvmAddressAlias(address accountNumAlias) returns (int64 responseCode, address evmAddressAlias)`,
  `function getHederaAccountNumAlias(address evmAddressAlias) returns (int64 responseCode, address accountNumAlias)`,
  `function isValidAlias(address addr) returns (bool)`,
];

// Exchange Rate  (0x168)
const EXCHANGE_RATE_ABI = [
  `function tinycentsToTinybars(uint256 tinycents) returns (uint256 tinybars)`,
  `function tinybarsToTinycents(uint256 tinybars) returns (uint256 tinycents)`,
];

// PRNG  (0x169)
const PRNG_ABI = [
  `function getPseudorandomSeed() returns (bytes32 pseudoRandomSeed)`,
];

// Additional compound types used only by HSS getter return values
const TokenInfo            = `(${HederaToken} token, int64 totalSupply, bool deleted, bool defaultKycStatus, bool pauseStatus, ${FixedFee}[] fixedFees, ${FractionalFee}[] fractionalFees, ${RoyaltyFee}[] royaltyFees, string ledgerId)`;
const FungibleTokenInfo    = `(${TokenInfo} tokenInfo, int32 decimals)`;
const NonFungibleTokenInfo = `(${TokenInfo} tokenInfo, int64 serialNumber, address ownerId, int64 creationTime, bytes metadata, address spenderId)`;

// HSS — Hedera Scheduling Service  (0x16b)
// Source: https://github.com/hiero-ledger/hiero-contracts
const HSS_ABI = [
  // HIP-755
  `function authorizeSchedule(address schedule) returns (int64 responseCode)`,
  `function signSchedule(address schedule, bytes signatureMap) returns (int64 responseCode)`,
  // HIP-756
  `function scheduleNative(address systemContractAddress, bytes callData, address payer) returns (int64 responseCode, address scheduleAddress)`,
  `function getScheduledCreateFungibleTokenInfo(address scheduleAddress) returns (int64 responseCode, ${FungibleTokenInfo} fungibleTokenInfo)`,
  `function getScheduledCreateNonFungibleTokenInfo(address scheduleAddress) returns (int64 responseCode, ${NonFungibleTokenInfo} nonFungibleTokenInfo)`,
  // HIP-1215
  `function scheduleCall(address to, uint256 expirySecond, uint256 gasLimit, uint64 value, bytes callData) returns (int64 responseCode, address scheduleAddress)`,
  `function scheduleCallWithPayer(address to, address payer, uint256 expirySecond, uint256 gasLimit, uint64 value, bytes callData) returns (int64 responseCode, address scheduleAddress)`,
  `function executeCallOnPayerSignature(address to, address payer, uint256 expirySecond, uint256 gasLimit, uint64 value, bytes callData) returns (int64 responseCode, address scheduleAddress)`,
  `function deleteSchedule(address scheduleAddress) returns (int64 responseCode)`,
  `function hasScheduleCapacity(uint256 expirySecond, uint256 gasLimit) view returns (bool hasCapacity)`,
];

const CONTRACT_META = {
  "0x0000000000000000000000000000000000000167": { name: "HTS",          abi: HTS_ABI },
  "0x0000000000000000000000000000000000000168": { name: "ExchangeRate", abi: EXCHANGE_RATE_ABI },
  "0x0000000000000000000000000000000000000169": { name: "PRNG",         abi: PRNG_ABI },
  "0x000000000000000000000000000000000000016a": { name: "HAS",          abi: HAS_ABI },
  "0x000000000000000000000000000000000000016b": { name: "HSS",          abi: HSS_ABI },
};

// ── Build selector → function lookup ─────────────────────────────────────────

// selector (0x…8hex) → { contractName, functionName, fragment, iface }
const SELECTOR_MAP = new Map();
for (const [, { name: contractName, abi }] of Object.entries(CONTRACT_META)) {
  const iface = new ethers.Interface(abi);
  for (const fragment of iface.fragments) {
    if (fragment.type !== "function") continue;
    if (!SELECTOR_MAP.has(fragment.selector)) {
      SELECTOR_MAP.set(fragment.selector, {
        contractName,
        functionName: fragment.name,
        fragment,
        iface,
      });
    }
  }
}

// ── Token-proxy (ERC-20 / ERC-721) ABI used to decode the inner call inside
//    redirectForToken, which uses a non-standard encoding:
//    selector(4) | token_address(32) | inner_selector(4) | inner_args(N)
const TOKEN_PROXY_ABI = [
  // ERC-20
  `function approve(address spender, uint256 amount) returns (bool)`,
  `function transfer(address to, uint256 amount) returns (bool)`,
  `function transferFrom(address from, address to, uint256 amount) returns (bool)`,
  `function allowance(address owner, address spender) returns (uint256)`,
  `function balanceOf(address account) returns (uint256)`,
  `function totalSupply() returns (uint256)`,
  `function name() returns (string)`,
  `function symbol() returns (string)`,
  `function decimals() returns (uint8)`,
  // WHBAR (Wrapped HBAR) — deposit/withdraw mirror WETH interface
  `function deposit()`,
  `function withdraw(uint256 amount)`,
  // HTS extensions exposed through the token ERC-20/ERC-721 facade (HIP-218 / HIP-376)
  `function associateToken(address account, address token)`,
  `function associateTokens(address account, address[] tokens)`,
  `function burn(address token, uint256 amount)`,
  `function release(address beneficiary)`,
  // ERC-721
  `function ownerOf(uint256 tokenId) returns (address)`,
  `function tokenURI(uint256 tokenId) returns (string)`,
  `function safeTransferFrom(address from, address to, uint256 tokenId)`,
  `function safeTransferFrom(address from, address to, uint256 tokenId, bytes data)`,
  `function setApprovalForAll(address operator, bool approved)`,
  `function getApproved(uint256 tokenId) returns (address)`,
  `function isApprovedForAll(address owner, address operator) returns (bool)`,
];
const TOKEN_PROXY_IFACE = new ethers.Interface(TOKEN_PROXY_ABI);
const TOKEN_PROXY_SELECTOR_MAP = new Map();
for (const fragment of TOKEN_PROXY_IFACE.fragments) {
  if (fragment.type !== "function") continue;
  if (!TOKEN_PROXY_SELECTOR_MAP.has(fragment.selector)) {
    TOKEN_PROXY_SELECTOR_MAP.set(fragment.selector, { functionName: fragment.name, fragment });
  }
}

// ── Analysis ──────────────────────────────────────────────────────────────────

// Extract trailing bytes from a hex string given how many canonical bytes precede them.
// Returns { trailingHex, trailingAscii } (empty strings when trailingBytes === 0).
function extractTrailing(hex, canonicalBytes) {
  const rawHex = hex.slice(2 + canonicalBytes * 2); // without 0x prefix
  if (!rawHex) return { trailingHex: "", trailingAscii: "" };
  const buf = Buffer.from(rawHex, "hex");
  const ascii = [...buf].map((b) => (b >= 0x20 && b < 0x7f) ? String.fromCharCode(b) : ".").join("");
  return { trailingHex: "0x" + rawHex, trailingAscii: ascii };
}

function normalizeAddress(hex) {
  const h = hex.startsWith("0x") ? hex.toLowerCase() : "0x" + hex.toLowerCase();
  // Left-pad to 42 chars (0x + 40 hex)
  return "0x" + h.slice(2).padStart(40, "0");
}

// Returns an analysis object describing trailing bytes (or lack thereof).
function analyzeCalldata(calldata) {
  if (!calldata || calldata === "0x" || calldata === "") {
    return { status: "empty_calldata", actualBytes: 0 };
  }

  const hex = calldata.startsWith("0x") ? calldata : "0x" + calldata;
  const actualBytes = (hex.length - 2) / 2;

  if (actualBytes < 4) {
    return { status: "too_short", actualBytes };
  }

  const selector = hex.slice(0, 10); // "0x" + 8 hex chars
  const entry    = SELECTOR_MAP.get(selector);

  if (!entry) {
    return { status: "unknown_selector", selector, actualBytes };
  }

  const { contractName, functionName, fragment, iface } = entry;

  // ── Special case: redirectForToken ────────────────────────────────────────
  // Hedera's HTS token proxies delegate-call redirectForToken using a
  // non-standard layout instead of ABI-encoding the bytes parameter:
  //   outer_selector(4) | token_address(32) | inner_selector(4) | inner_args(N)
  // We extract the inner call, decode/re-encode it, and measure trailing bytes
  // against the canonical total (4 + 32 + canonical_inner).
  if (functionName === "redirectForToken") {
    if (actualBytes < 28) {
      return { status: "unknown_selector", contractName, selector,
               functionName: "redirectForToken", innerSelector: "void calldata", actualBytes,
               error: "redirectForToken with no inner calldata" };
    }
    const innerHex      = "0x" + hex.slice(2 + 8 + 40); // skip outer selector(4B) + raw address(20B)
    const innerSelector = innerHex.slice(0, 10);
    const innerEntry    = TOKEN_PROXY_SELECTOR_MAP.get(innerSelector);

    if (!innerEntry) {
      return { status: "unknown_selector", contractName, selector,
               functionName: "redirectForToken", innerSelector, actualBytes,
               error: `unknown inner selector ${innerSelector}` };
    }

    const { functionName: innerFnName, fragment: innerFragment } = innerEntry;
    let innerDecoded;
    try {
      innerDecoded = ethers.AbiCoder.defaultAbiCoder().decode(
        innerFragment.inputs,
        "0x" + innerHex.slice(10),
        true,
      );
    } catch (e) {
      return { status: "decode_failed", contractName, selector,
               functionName: `redirectForToken(${innerFnName})`, actualBytes,
               error: e.message.slice(0, 120) };
    }

    let innerReEncoded;
    try {
      innerReEncoded = TOKEN_PROXY_IFACE.encodeFunctionData(innerFragment, innerDecoded);
    } catch (e) {
      return { status: "reencode_failed", contractName, selector,
               functionName: `redirectForToken(${innerFnName})`, actualBytes,
               error: e.message.slice(0, 120) };
    }

    const canonicalBytes = 4 + 20 + (innerReEncoded.length - 2) / 2; // selector(4) + raw address(20) + inner
    const trailingBytes  = actualBytes - canonicalBytes;
    const trailing       = trailingBytes > 0 ? extractTrailing(hex, canonicalBytes) : { trailingHex: "", trailingAscii: "" };
    return {
      status:        trailingBytes > 0 ? "trailing_data" : "no_trailing_data",
      contractName,
      selector,
      functionName:  `redirectForToken(${innerFnName})`,
      actualBytes,
      canonicalBytes,
      trailingBytes,
      ...trailing,
    };
  }

  // Decode with loose=true so trailing bytes don't cause an error.
  let decoded;
  try {
    const dataWithoutSelector = "0x" + hex.slice(10);
    decoded = ethers.AbiCoder.defaultAbiCoder().decode(
      fragment.inputs,
      dataWithoutSelector,
      true, // loose — ignore trailing bytes
    );
  } catch (e) {
    return {
      status: "decode_failed",
      contractName,
      selector,
      functionName,
      actualBytes,
      error: e.message.slice(0, 120),
    };
  }

  // Re-encode to find canonical length.
  // Use the stored FunctionFragment directly to avoid ambiguity when a contract
  // has overloaded functions with the same name (e.g. hbarApprove 2-param vs 3-param).
  let reEncoded;
  try {
    reEncoded = iface.encodeFunctionData(fragment, decoded);
  } catch (e) {
    return {
      status: "reencode_failed",
      contractName,
      selector,
      functionName,
      actualBytes,
      error: e.message.slice(0, 120),
    };
  }

  const canonicalBytes = (reEncoded.length - 2) / 2;
  const trailingBytes  = actualBytes - canonicalBytes;
  const trailing       = trailingBytes > 0 ? extractTrailing(hex, canonicalBytes) : { trailingHex: "", trailingAscii: "" };

  return {
    status:         trailingBytes > 0 ? "trailing_data" : "no_trailing_data",
    contractName,
    selector,
    functionName,
    actualBytes,
    canonicalBytes,
    trailingBytes,
    ...trailing,
  };
}

// ── Mirror node fetch ─────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function mirrorGet(url) {
  let backoff = 2000;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const res = await fetch(url);
      if (res.ok) return res.json();
      if (res.status === 429) {
        process.stderr.write(`  rate-limited, sleeping ${backoff / 1000}s…\n`);
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 10000);
        continue;
      }
      if (res.status === 404) {
        // Mirror node returns 404 while a transaction is still being indexed;
        // keep retrying until the record appears or attempts are exhausted.
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 10000);
        continue;
      }
      return null;
    } catch (_) {
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 10000);
    }
  }
  return null;
}

async function fetchContractResult(transactionId) {
  const url = `${mirrorBase}/api/v1/contracts/results/${encodeURIComponent(transactionId)}`;
  return mirrorGet(url);
}

// Convert a nanosecond timestamp string to the "seconds.nanos" format the
// mirror node accepts, e.g. "1781091141764878821" → "1781091141.764878821".
function nsToMirrorTs(ns) {
  const s = String(ns).replace(/\D/g, "");
  const sec  = s.slice(0, -9) || "0";
  const nano = s.slice(-9).padStart(9, "0");
  return `${sec}.${nano}`;
}

async function fetchContractResultByTimestamp(tsNs) {
  const ts  = nsToMirrorTs(tsNs);
  // Timestamp-based lookup uses a query parameter; the path-based endpoint only
  // accepts transaction IDs or Ethereum hashes.
  const url = `${mirrorBase}/api/v1/contracts/results?timestamp=${encodeURIComponent(ts)}`;
  const body = await mirrorGet(url);
  return body?.results?.[0] ?? null;
}

// Returns all transaction records for a given Hedera transaction ID
// (parent at nonce=0 plus any child records at nonce>0).
async function fetchTransactionRecords(txId) {
  const url = `${mirrorBase}/api/v1/transactions/${encodeURIComponent(txId)}`;
  const body = await mirrorGet(url);
  return body?.transactions ?? [];
}

// Returns the EVM call-tree actions for a contract result.
async function fetchContractActions(contractsLookupId) {
  const url = `${mirrorBase}/api/v1/contracts/results/${encodeURIComponent(contractsLookupId)}/actions`;
  const body = await mirrorGet(url);
  return body?.actions ?? [];
}

// ── CSV helpers ───────────────────────────────────────────────────────────────

function parseCSVLine(line) {
  const fields   = [];
  let field      = "";
  let inQuotes   = false;
  for (const ch of line) {
    if (ch === '"')              { inQuotes = !inQuotes; }
    else if (ch === "," && !inQuotes) { fields.push(field); field = ""; }
    else                         { field += ch; }
  }
  fields.push(field);
  return fields;
}

function csvEscape(value) {
  const s = String(value ?? "");
  return s.includes(",") || s.includes('"') || s.includes("\n")
    ? `"${s.replace(/"/g, '""')}"`
    : s;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const rawCSV = fs.readFileSync(csvFile, "utf8");
  const lines  = rawCSV.split("\n").map((l) => l.replace(/\r$/, "")).filter(Boolean);

  if (lines.length < 2) {
    process.stderr.write("CSV file has no data rows.\n");
    process.exit(1);
  }

  const header      = parseCSVLine(lines[0]);
  const COL_TS         = header.indexOf("consensus_timestamp");
  const COL_TO         = header.indexOf("to_address_hex");
  const COL_TX_ID      = header.indexOf("transaction_id");
  // lookup_source holds the actual Hedera transaction ID (0.0.ACCOUNT-SEC-NANOS)
  // when the transaction_id column is repurposed for the exception type string.
  const COL_LOOKUP_SRC = header.indexOf("lookup_source");
  // csv_error is the original error reported in the source data (e.g. INVALID_OPERATION).
  const COL_CSV_ERROR  = header.indexOf("csv_error");

  // At least one of these columns must be present for mirror node lookup.
  if (COL_LOOKUP_SRC === -1 && COL_TX_ID === -1 && COL_TS === -1) {
    process.stderr.write("CSV must have a 'lookup_source', 'transaction_id', or 'consensus_timestamp' column.\n");
    process.exit(1);
  }

  // Hedera transaction IDs look like "0.0.ACCOUNT-SECONDS-NANOS".
  const HEDERA_TX_ID_RE = /^\d+\.\d+\.\d+-\d+-\d+$/;
  // Ethereum transaction hashes (64 hex chars).
  const ETH_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

  const ANALYSIS_COLS = [
    "eth_hash",
    "contract_name",
    "selector",
    "function_name",
    "calldata_bytes",
    "canonical_bytes",
    "trailing_bytes",
    "trailing_hex",
    "trailing_ascii",
    "status",
    "hedera_result",
    "child_errors",
  ];
  const outHeader = [...header, ...ANALYSIS_COLS].join(",");

  const outputLines = [outHeader];
  const dataRows    = lines.slice(1);

  process.stderr.write(`Processing ${dataRows.length} rows from ${csvFile}\n`);
  process.stderr.write(`Mirror: ${mirrorBase}\n\n`);

  for (let i = 0; i < dataRows.length; i++) {
    const fields    = parseCSVLine(dataRows[i]);
    const timestamp  = COL_TS         >= 0 ? (fields[COL_TS]         ?? "") : "";
    const toHex      = COL_TO         >= 0 ? (fields[COL_TO]         ?? "") : "";
    const txIdRaw    = COL_TX_ID      >= 0 ? (fields[COL_TX_ID]      ?? "") : "";
    const lookupSrc  = COL_LOOKUP_SRC >= 0 ? (fields[COL_LOOKUP_SRC] ?? "") : "";
    const csvError   = COL_CSV_ERROR  >= 0 ? (fields[COL_CSV_ERROR]  ?? "") : "";

    // Use lookup_source when available and looks like a real Hedera transaction ID.
    // The transaction_id column is sometimes repurposed to store the exception type.
    const txId = HEDERA_TX_ID_RE.test(lookupSrc) ? lookupSrc
               : HEDERA_TX_ID_RE.test(txIdRaw)   ? txIdRaw
               : "";
    // Ethereum tx hashes are accepted by the contracts/results endpoint but NOT by
    // the transactions endpoint, so we track them separately from the Hedera txId.
    const ethHashFromCsv = !txId && ETH_HASH_RE.test(txIdRaw) ? txIdRaw
                         : !txId && ETH_HASH_RE.test(lookupSrc) ? lookupSrc
                         : "";
    // What we pass to /contracts/results (Hedera ID or ETH hash both work).
    const contractsLookupId = txId || ethHashFromCsv;

    const blankRow = (status) =>
      [...fields, "", "", "", "", "", "", "", "", "", status, "", ""].map(csvEscape).join(",");

    // Prefer transaction_id / eth hash for lookup; fall back to consensus_timestamp.
    const lookupKey = contractsLookupId || timestamp;
    process.stderr.write(`  [${i + 1}/${dataRows.length}] ${lookupKey} … `);

    if (!lookupKey) {
      process.stderr.write("skipped (no lookup key)\n");
      outputLines.push(blankRow("no_lookup_key"));
      continue;
    }

    const mirrorResult = contractsLookupId
      ? await fetchContractResult(contractsLookupId)
      : await fetchContractResultByTimestamp(timestamp);
    if (!mirrorResult) {
      process.stderr.write("not_found\n");
      outputLines.push(blankRow("not_found"));
      await sleep(200);
      continue;
    }

    const ethHash = mirrorResult.hash ?? "";
    // to_address_hex in the CSV is a decimal entity number, not hex.
    // Prefer the EVM address from the mirror node response.
    let contractAddr = normalizeAddress(mirrorResult.to || toHex || "");
    let contractMeta = CONTRACT_META[contractAddr];
    let functionParams = mirrorResult.function_parameters ?? "0x";

    // Error returned by the inner system-contract sub-call when the outer
    // transaction succeeded but HTS (or another system contract) rejected the call.
    let innerActionError = "";
    if (!contractMeta) {
      // The outer call target is not a system contract. Check the EVM call-tree
      // for internal calls (e.g. delegate calls) that reach a system contract.
      const actions = await fetchContractActions(contractsLookupId);
      // Use `to` (EVM address) not `recipient` (Hedera entity ID like "0.0.359").
      const sysAction = actions.find((a) => !!CONTRACT_META[normalizeAddress(a.to ?? "")]);
      if (sysAction) {
        contractAddr   = normalizeAddress(sysAction.to ?? "");
        contractMeta   = CONTRACT_META[contractAddr];
        functionParams = sysAction.input ?? "0x";
        // Hedera system contracts return a plain ASCII error string (e.g. "INVALID_OPERATION")
        // as the result_data when a sub-call fails, rather than an ABI-encoded revert reason.
        if (sysAction.result_data_type && sysAction.result_data_type !== "OUTPUT"
            && sysAction.result_data && sysAction.result_data !== "0x") {
          try {
            const ascii = Buffer.from(sysAction.result_data.slice(2), "hex").toString("utf8");
            if (/^[\x20-\x7e]+$/.test(ascii)) innerActionError = ascii.trim();
          } catch {}
        }
      }
    }

    if (!contractMeta) {
      process.stderr.write("skipped (not a system contract)\n");
      outputLines.push(blankRow("not_system_contract"));
      await sleep(300);
      continue;
    }
    const analysis = analyzeCalldata(functionParams);

    const hederaResult = mirrorResult.result ?? "";
    // Prefer the transaction_id from the mirror response for the children lookup.
    // Fall back only to a Hedera-format ID from the CSV — ETH hashes are not
    // accepted by the /api/v1/transactions endpoint.
    const mirrorTxId = mirrorResult.transaction_id ?? txId;

    // Fetch child Hedera records so we can surface errors that caused the
    // parent result (e.g. INSUFFICIENT_GAS hiding behind CONTRACT_REVERT_EXECUTED).
    let childErrors = "";
    if (mirrorTxId) {
      const records = await fetchTransactionRecords(mirrorTxId);
      const childErrSet = new Set(
        records
          .filter((r) => (r.nonce ?? 0) > 0 && r.result && r.result !== hederaResult && r.result !== "SUCCESS")
          .map((r) => r.result),
      );
      childErrors = [...childErrSet].join("|");
    }

    const trailingStr = analysis.trailingBytes != null
      ? `${analysis.trailingBytes} trailing bytes`
      : analysis.innerSelector
        ? `${analysis.status} (${analysis.innerSelector})`
        : analysis.status;
    const trailingDetail = analysis.trailingBytes > 0 && analysis.trailingHex
      ? ` (${analysis.trailingHex} = "${analysis.trailingAscii}")`
      : "";
    const allErrors = [childErrors, innerActionError].filter(Boolean).join("|");
    const errTag = allErrors
      ? ` [${hederaResult} → ${allErrors}]`
      : hederaResult ? ` [${hederaResult}]` : "";
    const csvErrTag = csvError ? ` (csv: ${csvError})` : "";
    process.stderr.write(`${analysis.functionName ?? analysis.selector ?? ""} → ${trailingStr}${trailingDetail}${errTag}${csvErrTag}\n`);

    if (analysis.status === "trailing_data") {
      outputLines.push(
        [
          ...fields,
          ethHash,
          analysis.contractName   ?? contractMeta.name,
          analysis.selector       ?? "",
          analysis.functionName   ?? "",
          analysis.actualBytes    ?? "",
          analysis.canonicalBytes ?? "",
          analysis.trailingBytes  ?? "",
          analysis.trailingHex    ?? "",
          analysis.trailingAscii  ?? "",
          analysis.status,
          hederaResult,
          childErrors,
        ]
          .map(csvEscape)
          .join(","),
      );
    }

    await sleep(200); // polite delay between mirror node requests
  }

  const output = outputLines.join("\n") + "\n";

  if (outputFile) {
    fs.writeFileSync(outputFile, output, "utf8");
    process.stderr.write(`\nResults written to ${outputFile}\n`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
