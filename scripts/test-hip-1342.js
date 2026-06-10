// Test HIP-1342: trailing calldata on Hedera system contracts.
//
// Pre-HIP-1342 (current behavior): a call to HTS at 0x...0167 reverts
// when calldata contains extra bytes beyond the ABI-defined parameters.
// Post-HIP-1342: extra trailing bytes are accepted and silently ignored.
//
// This script runs eight scenarios and reports the receipt + mirror node
// result for each:
//
// createFungibleToken:
//   1) EOA      -> HTS, correct calldata
//   2) EOA      -> HTS, correct calldata + 32 trailing bytes
//   3) EOA -> contract -> HTS, correct calldata
//   4) EOA -> contract -> HTS, correct calldata + 32 trailing bytes
//
// transferToken (uses tokens created in steps 1 and 3):
//   5) EOA      -> HTS, correct calldata
//   6) EOA      -> HTS, correct calldata + 32 trailing bytes
//   7) EOA -> contract -> HTS, correct calldata
//   8) EOA -> contract -> HTS, correct calldata + 32 trailing bytes

require("dotenv").config({ quiet: true});
const { ethers } = require("ethers");
const solc = require("solc");
const fs = require("fs");
const path = require("path");

const RPC_URL = process.env.NETWORK_RPC_URL || "https://testnet.hashio.io/api";
const MIRROR_BASE =
  process.env.MIRROR_BASE || "https://testnet.mirrornode.hedera.com";

// --csv <file>  Override the default output path for the results CSV.
// The CSV is always written; pass --csv to change where it lands.
const DEFAULT_CSV = path.join(__dirname, "..", "network-data", "test-hip-1342-results.csv");
const CSV_OUTPUT = (() => {
  const i = process.argv.indexOf("--csv");
  return i !== -1 ? process.argv[i + 1] : DEFAULT_CSV;
})();

const HTS = "0x0000000000000000000000000000000000000167";

const PRIVATE_KEY = process.env.OPERATOR_KEY;

// If set, attach to an already-deployed Hip1342Caller instead of redeploying.
const CALLER_ADDRESS = "0x1fd99bA8405BDC007FFBB723034e4d0c01fCab1d";

const HTS_ABI = [
  `function createFungibleToken(
     (
       string name,
       string symbol,
       address treasury,
       string memo,
       bool tokenSupplyType,
       int64 maxSupply,
       bool freezeDefault,
       (uint256 keyType,(bool inheritAccountKey,address contractId,bytes ed25519,bytes ECDSA_secp256k1,address delegatableContractId) key)[] tokenKeys,
       (int64 second,address autoRenewAccount,int64 autoRenewPeriod) expiry
     ) token,
     int64 initialTotalSupply,
     int32 decimals
   ) payable returns (int64 responseCode, address tokenAddress)`,
  `function transferToken(address token, address sender, address receiver, int64 amount) external returns (int64 responseCode)`,
];

// Forwards arbitrary calldata to HTS via low-level call so the EVM passes
// the exact bytes through without re-encoding through a typed ABI.
const HIP1342_CALLER_SOURCE = `
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract Hip1342Caller {
    address constant HTS = 0x0000000000000000000000000000000000000167;

    event HtsCallResult(bool success, bytes returnData);

    function callHts(bytes calldata data) external payable returns (bool ok, bytes memory ret) {
        (ok, ret) = HTS.call{value: msg.value}(data);
        emit HtsCallResult(ok, ret);
    }

    function callHtsWithExtra(bytes calldata data, bytes calldata extra) external payable returns (bool ok, bytes memory ret) {
        (ok, ret) = HTS.call{value: msg.value}(abi.encodePacked(data, extra));
        emit HtsCallResult(ok, ret);
    }
}
`;

function compileCaller() {
  const input = {
    language: "Solidity",
    sources: { "Hip1342Caller.sol": { content: HIP1342_CALLER_SOURCE } },
    settings: {
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
      optimizer: { enabled: true, runs: 200 },
    },
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  const fatal = (output.errors || []).filter((e) => e.severity === "error");
  if (fatal.length) {
    throw new Error("solc errors: " + JSON.stringify(fatal, null, 2));
  }
  const c = output.contracts["Hip1342Caller.sol"]["Hip1342Caller"];
  return { abi: c.abi, bytecode: "0x" + c.evm.bytecode.object };
}

async function getCaller(wallet) {
  const { abi, bytecode } = compileCaller();
  if (CALLER_ADDRESS) {
    console.log(`\n=== Reusing Hip1342Caller at ${CALLER_ADDRESS} ===`);
    return new ethers.Contract(CALLER_ADDRESS, abi, wallet);
  }
  console.log("\n=== Deploying Hip1342Caller ===");
  const factory = new ethers.ContractFactory(abi, bytecode, wallet);
  const contract = await factory.deploy({ gasLimit: 3_000_000 });
  console.log("deploy tx hash:", contract.deploymentTransaction().hash);
  await contract.waitForDeployment();
  console.log("Hip1342Caller deployed at:", await contract.getAddress());
  return contract;
}

function decodeRevertReason(hex) {
  if (!hex || hex === "0x") return null;
  const abi = ethers.AbiCoder.defaultAbiCoder();
  if (hex.startsWith("0x08c379a0")) {
    try {
      return `Error(string): ${abi.decode(["string"], "0x" + hex.slice(10))[0]}`;
    } catch (_) {}
  }
  if (hex.startsWith("0x4e487b71")) {
    try {
      const [code] = abi.decode(["uint256"], "0x" + hex.slice(10));
      return `Panic(0x${code.toString(16)})`;
    } catch (_) {}
  }
  // Hedera system contracts often return a plain ASCII status string
  // (e.g. "INVALID_OPERATION") instead of ABI-encoded Error(string).
  try {
    const ascii = Buffer.from(ethers.getBytes(hex)).toString("utf8");
    if (/^[\x20-\x7e]+$/.test(ascii)) return `ascii: ${ascii}`;
  } catch (_) {}
  return `raw: ${hex}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function poll(fn, attempts, delayMs) {
  for (let i = 0; i < attempts; i++) {
    const r = await fn();
    if (r) return r;
    await sleep(delayMs);
  }
  return null;
}

// Bypass ethers' strict receipt formatter: Hedera returns contractAddress="0x"
// on failed system-contract calls, which ethers refuses to parse.
const rawGetReceipt = (provider, hash) =>
  poll(() => provider.send("eth_getTransactionReceipt", [hash]), 20, 200);

const fetchMirrorRevert = (txHash) =>
  poll(
    async () => {
      try {
        const res = await fetch(
          `${MIRROR_BASE}/api/v1/contracts/results/${txHash}`,
        );
        if (res.ok) return res.json();
      } catch (_) {}
      return null;
    },
    8,
    1500,
  );

const fetchMirrorActions = async (txHash) => {
  try {
    const res = await fetch(
      `${MIRROR_BASE}/api/v1/contracts/results/${txHash}/actions`,
    );
    if (res.ok) return res.json();
  } catch (_) {}
  return null;
};

function printMirrorActions(actions) {
  if (!actions?.actions?.length) {
    console.log("mirror actions: none");
    return;
  }
  console.log(`mirror actions (${actions.actions.length}):`);
  for (const a of actions.actions) {
    const indent = "  ".repeat((a.call_depth ?? 0) + 1);
    const target = a.recipient || a.to || "?";
    console.log(
      `${indent}[depth=${a.call_depth}] ${a.call_operation_type} ${a.caller || a.from} -> ${target}` +
        ` | gas=${a.gas} used=${a.gas_used}` +
        ` | result=${a.result_data_type}`,
    );
    if (a.result_data && a.result_data !== "0x") {
      console.log(`${indent}  result_data: ${a.result_data}`);
      console.log(`${indent}  decoded:     ${decodeRevertReason(a.result_data)}`);
    }
  }
}

function reportHtsCallResultLog(contract, log) {
  try {
    const parsed = contract?.interface.parseLog(log);
    if (!parsed || parsed.name !== "HtsCallResult") return false;
    const ret = parsed.args.returnData;
    console.log("event HtsCallResult:");
    console.log("  success:", parsed.args.success);
    console.log(
      "  returnData length (bytes):",
      ret && ret !== "0x" ? (ret.length - 2) / 2 : 0,
    );
    console.log("  returnData:", ret);
    if (ret && ret !== "0x") {
      console.log("  decoded:", decodeRevertReason(ret));
    }
    return true;
  } catch (_) {
    return false;
  }
}

async function reportTxResult(provider, txHash, contract = null) {
  const receipt = await rawGetReceipt(provider, txHash);
  if (receipt) {
    console.log("status:", receipt.status, "gasUsed:", receipt.gasUsed);
    for (const log of receipt.logs || []) {
      if (!reportHtsCallResultLog(contract, log)) {
        console.log("unparsed log topic0:", log.topics?.[0]);
      }
    }
    if (receipt.revertReason) {
      console.log("revertReason (raw):", receipt.revertReason);
      console.log("decoded:", decodeRevertReason(receipt.revertReason));
    }
  } else {
    console.log("eth_getTransactionReceipt: no receipt within timeout");
  }

  const rawTx = await provider.send("eth_getTransactionByHash", [txHash]);
  if (rawTx?.input) {
    console.log("tx input length (bytes):", (rawTx.input.length - 2) / 2);
  }

  const mirror = await fetchMirrorRevert(txHash);
  if (!mirror) {
    console.log("mirror: result not available within timeout");
    return;
  }
  console.log("mirror result:", mirror.result);
  console.log("mirror status:", mirror.status);
  if (mirror.error_message) {
    console.log("mirror error_message:", mirror.error_message);
    console.log("decoded:", decodeRevertReason(mirror.error_message));
  }
  if (mirror.call_result && mirror.call_result !== "0x") {
    console.log("call_result:", mirror.call_result);
    console.log("decoded call_result:", decodeRevertReason(mirror.call_result));
  }

  printMirrorActions(await fetchMirrorActions(txHash));
  return mirror;
}

async function runStep(label, provider, sendFn, contract = null) {
  console.log(`\n=== ${label} ===`);
  let tx;
  try {
    tx = await sendFn();
  } catch (e) {
    console.log("send threw:", e.shortMessage || e.message);
    if (e.info) console.log("info:", JSON.stringify(e.info, null, 2));
    return null;
  }
  console.log("tx hash:", tx.hash);
  const mirror = await reportTxResult(provider, tx.hash, contract);
  return { label, hash: tx.hash, to: tx.to, mirror };
}

function makeTokenStruct(treasury, memo) {
  return [
    "Hip1342Test", // name
    "H1342", // symbol
    treasury,
    memo,
    false, // tokenSupplyType: INFINITE
    0n, // maxSupply (ignored when INFINITE)
    false, // freezeDefault
    [], // tokenKeys: none -> immutable token
    [0n, treasury, 7_890_000n], // expiry: (auto, autoRenewAccount, ~90d)
  ];
}

// Decode the (int64 responseCode, address tokenAddress) returned by HTS
// createFungibleToken directly (EOA -> HTS path).
function decodeCreateResult(hex) {
  if (!hex || hex === "0x") return null;
  try {
    const [, tokenAddress] = ethers.AbiCoder.defaultAbiCoder().decode(
      ["int64", "address"],
      hex,
    );
    return tokenAddress;
  } catch (_) {
    return null;
  }
}

// Decode the (bool ok, bytes ret) returned by Hip1342Caller.callHts, then
// unwrap the inner HTS response to get the token address.
function decodeContractCreateResult(hex) {
  if (!hex || hex === "0x") return null;
  try {
    const [ok, ret] = ethers.AbiCoder.defaultAbiCoder().decode(
      ["bool", "bytes"],
      hex,
    );
    if (!ok) return null;
    return decodeCreateResult(ethers.hexlify(ret));
  } catch (_) {
    return null;
  }
}

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  const treasury = wallet.address;

  const net = await provider.getNetwork();
  const balance = await provider.getBalance(treasury);
  console.log("RPC:", RPC_URL);
  console.log("chainId:", net.chainId.toString());
  console.log("from:", treasury);
  console.log("balance (HBAR):", ethers.formatEther(balance));

  const iface = new ethers.Interface(HTS_ABI);
  const encodeCreate = (treasuryAddr, memo) =>
    iface.encodeFunctionData("createFungibleToken", [
      makeTokenStruct(treasuryAddr, memo),
      1000n, // initialTotalSupply
      2, // decimals
    ]);

  const extra = "deadbeefcafebabe".repeat(4); // 64 hex chars = 32 bytes
  // Token creation rent on testnet is around 10-20 HBAR; send 30 to be safe.
  const value = ethers.parseEther("30");

  const sendRaw = (data, txValue = value) => {
    console.log("calldata length (bytes):", (data.length - 2) / 2);
    console.log("calldata:", data);
    return wallet.sendTransaction({
      to: HTS,
      data,
      value: txValue,
      gasLimit: 1_500_000,
    });
  };

  const encodeTransfer = (tokenAddr, from, to, amount) =>
    iface.encodeFunctionData("transferToken", [tokenAddr, from, to, amount]);

  // Collect every step result so we can emit a CSV for check-trailing-calldata.js.
  const stepResults = [];
  const tracked = async (...args) => {
    const r = await runStep(...args);
    if (r) stepResults.push(r);
    return r;
  };

  const correct = encodeCreate(treasury, "hip-1342 trailing test");
  const r1 = await tracked("1) correct createFungibleToken call", provider, () =>
    sendRaw(correct),
  );
  await tracked("2) same call + 32 trailing bytes", provider, () =>
    sendRaw(correct + extra),
  );

  // Tests 3 and 4: client -> contract -> HTS. The contract becomes msg.sender
  // for HTS, so rebuild calldata with the contract as treasury (and
  // autoRenewAccount) — otherwise HTS would fail with INVALID_SIGNATURE /
  // INVALID_TREASURY_ACCOUNT regardless of HIP-1342.
  const caller = await getCaller(wallet);
  const callerAddress = await caller.getAddress();
  const correctForContract = encodeCreate(
    callerAddress,
    "hip-1342 trailing test (via contract)",
  );

  const callContract = (fn, args, txValue = value) => {
    const outer = caller.interface.encodeFunctionData(fn, args);
    console.log("outer calldata length (bytes):", (outer.length - 2) / 2);
    console.log("outer calldata:", outer);
    return caller[fn](...args, { value: txValue, gasLimit: 2_000_000 });
  };

  const r3 = await tracked(
    "3) contract.callHts(correctCalldata)",
    provider,
    () => callContract("callHts", [correctForContract]),
    caller,
  );
  await tracked(
    "4) contract.callHtsWithExtra(correctCalldata + extra)",
    provider,
    () => callContract("callHtsWithExtra", [correctForContract, "0x" + extra]),
    caller,
  );

  // Tests 5-6: EOA -> HTS transferToken, using the token created in step 1.
  const tokenFromEoa = r1 ? decodeCreateResult(r1.mirror?.call_result) : null;
  if (tokenFromEoa) {
    console.log(`\nToken from step 1: ${tokenFromEoa}`);
    const correctTransfer = encodeTransfer(tokenFromEoa, treasury, treasury, 1n);
    await tracked("5) correct transferToken call (EOA -> HTS)", provider, () =>
      sendRaw(correctTransfer, 0n),
    );
    await tracked(
      "6) transferToken + 32 trailing bytes (EOA -> HTS)",
      provider,
      () => sendRaw(correctTransfer + extra, 0n),
    );
  } else {
    console.log("\nSkipping steps 5-6: could not decode token address from step 1");
  }

  // Tests 7-8: contract -> HTS transferToken, using the token created in step 3.
  // The contract is the treasury, so msg.sender (the contract) is authorised.
  const tokenFromContract = r3 ? decodeContractCreateResult(r3.mirror?.call_result) : null;
  if (tokenFromContract) {
    console.log(`\nToken from step 3: ${tokenFromContract}`);
    const correctTransferViaContract = encodeTransfer(
      tokenFromContract,
      callerAddress,
      callerAddress,
      1n,
    );
    await tracked(
      "7) contract.callHts(transferToken)",
      provider,
      () => callContract("callHts", [correctTransferViaContract], 0n),
      caller,
    );
    await tracked(
      "8) contract.callHtsWithExtra(transferToken + extra)",
      provider,
      () =>
        callContract(
          "callHtsWithExtra",
          [correctTransferViaContract, "0x" + extra],
          0n,
        ),
      caller,
    );
  } else {
    console.log("\nSkipping steps 7-8: could not decode token address from step 3");
  }

  const csvRow = (...fields) =>
    fields
      .map((f) => {
        const s = String(f ?? "");
        return s.includes(",") || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
      })
      .join(",");

  const lines = [csvRow("scenario", "transaction_id", "to_address_hex")];
  for (const { label, hash, to } of stepResults) {
    lines.push(csvRow(label, hash, to ?? ""));
  }
  fs.writeFileSync(CSV_OUTPUT, lines.join("\n") + "\n", "utf8");
  console.log(`\nCSV written to ${CSV_OUTPUT} (${stepResults.length} row(s))`);
  console.log(`Verify: node scripts/check-trailing-calldata.js ${CSV_OUTPUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
