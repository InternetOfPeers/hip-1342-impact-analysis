# HIP-1342 Impact Analysis

[Impact analysis](docs/impact-analysis-hip-1342.md) for [HIP-1342 — Ignore Trailing Calldata for System Contract](https://hips.hedera.com/#hip-1342).

HIP-1342 proposes allowing Hedera system contracts (HTS, HAS, HSS) to accept and silently ignore trailing bytes in calldata beyond what the ABI-defined parameters require. This is a **consensus rule change**: transactions that currently revert due to strict calldata decoding will succeed after the HIP is activated.

This repository contains the [final report](docs/impact-analysis-hip-1342.md), data, queries, and scripts used to quantify mainnet exposure and support the backwards-compatibility section of the HIP.

## Quickstart

```bash
npm install
npm start
```

## Workflow

The analysis runs in three stages:

### 1. Query the mirror node database

Run the SQL in [network-data/sql-queries.sql](network-data/sql-queries.sql) against the Hedera mirror node PostgreSQL instance. Two result sets are produced:

- **ethereum-direct-calls.csv** — Ethereum transactions that called a system contract address directly and carried a `CONTRACT_REVERT_EXECUTED` result. Columns: `ethereum_tx_consensus_timestamp`, `to_address_hex`, `payer_account`, `error_message`.
- **ethereum-nested-calls.csv** — Nested contract actions (call depth > 0) that targeted a system contract and returned a revert result code. Columns: `consensus_timestamp`, `sender`, `receiver`, `result_data`.

System contract addresses queried:

| Contract | Address |
| --- | --- |
| HTS | `0x0000000000000000000000000000000000000167` |
| HAS | `0x000000000000000000000000000000000000016a` |
| HSS | `0x000000000000000000000000000000000000016b` |

### 2. Confirm CONTRACT_EXECUTION_EXCEPTION

```bash
bash scripts/check-contract-execution-exceptions.sh
```

Reads both CSV files, de-duplicates timestamps, resolves each one via the mirror node REST API (with an RPC fallback), and writes only the rows confirmed as `CONTRACT_EXECUTION_EXCEPTION` to `network-data/contract-execution-exceptions.csv`.

### 3. Detect trailing calldata

```bash
npm install
node scripts/check-trailing-calldata.js network-data/contract-execution-exceptions.csv \
  [--mirror-node <mirror-base-url>] \
  [--output results.csv]
```

For each confirmed exception, fetches the full `function_parameters` from the mirror node, decodes them against the known system-contract ABIs, re-encodes the decoded arguments to canonical form, and reports the difference as `trailing_bytes`.

Output columns: `consensus_timestamp`, `transaction_id`, `eth_hash`, `to_contract`, `contract_name`, `selector`, `function_name`, `calldata_bytes`, `canonical_bytes`, `trailing_bytes`, `status`.

## Testnet Verification

[scripts/test-hip-1342.js](scripts/test-hip-1342.js) sends eight transactions to Hedera testnet to document the current (pre-HIP) behavior:

- Steps 1–4: `createFungibleToken`, EOA-direct and via an intermediate contract, with and without 32 trailing bytes.
- Steps 5–8: `transferToken`, same EOA-direct / via-contract / with-trailing-bytes matrix.

After all steps complete, the script always writes `network-data/test-hip-1342-results.csv`. Pass `--csv <file>` to override the output path.

Before running, create a `.env` file:

```env
OPERATOR_KEY=<hex-encoded-ECDSA-private-key>
NETWORK_RPC_URL=https://testnet.hashio.io/api        # optional, this is the default
MIRROR_BASE=https://testnet.mirrornode.hedera.com    # optional, this is the default
```

Run the test and then feed the results through `check-trailing-calldata.js` to verify calldata lengths:

```bash
npm install
npm test
```

Expected output of the verification step:

```bash
  ...
  [1/8] 0xba522ec5454bbde9b7105c89b387633e52223d1e82b5326b9061b3d7eaadde8d … createFungibleToken → 0 trailing bytes [SUCCESS]
  [2/8] 0xc2cf744f20cd0fe65c6004a4d83633d035af4e5fbba0ae212935ab589b178e14 … createFungibleToken → 32 trailing bytes (0xdeadbeefcafebabedeadbeefcafebabedeadbeefcafebabedeadbeefcafebabe = "................................") [CONTRACT_EXECUTION_EXCEPTION]
  [3/8] 0xd572837d6eecdc2e4e699ab5773e005743e193b07a581f905fb27560fcb3603c … createFungibleToken → 0 trailing bytes [SUCCESS]
  [4/8] 0x9600ed68ad607aa85717357f27abefeadd71b403f00376e5f40cb97908d52574 … createFungibleToken → 32 trailing bytes (0xdeadbeefcafebabedeadbeefcafebabedeadbeefcafebabedeadbeefcafebabe = "................................") [SUCCESS → INVALID_OPERATION]
  [5/8] 0x94c5ab4be7e331c8a9f255186d8a1793eb5ac874fd8334dab4b10d94ff36250d … transferToken → 0 trailing bytes [SUCCESS]
  [6/8] 0x94adab9bf3ca08e4213fdbd5c48aae394eb680ba1c8add3b2dba9a07591eee0e … transferToken → 32 trailing bytes (0xdeadbeefcafebabedeadbeefcafebabedeadbeefcafebabedeadbeefcafebabe = "................................") [CONTRACT_EXECUTION_EXCEPTION]
  [7/8] 0xd291804c0cfc76570ac437095334478ebb9b672ba61cce6368ed1722e00238c1 … transferToken → 0 trailing bytes [SUCCESS]
  [8/8] 0x027efcbe69c6b4d94ad3bcec35314d184f2332e628998a016d89dd213b206525 … transferToken → 32 trailing bytes (0xdeadbeefcafebabedeadbeefcafebabedeadbeefcafebabedeadbeefcafebabe = "................................") [SUCCESS → INVALID_OPERATION]
```

> Note: For indirect calls (steps 3, 4, 7, 8) the outer transaction targets the `Hip1342Caller` contract, not HTS directly. The `Hip1342Caller` is calling the HTS system contract injecting the trailing data.

## Repository Layout

```txt
docs/
  breaking-change-impact-analisys.md   Process document: how to run a breaking-change impact analysis
  impact-analysis-hip-1342.md          Results of the impact analysis for HIP-1342

network-data/
  analysis-results.csv                 Final list of transactions impacted by HIP-1342
  contract-execution-exceptions.csv    Resolved transactions confirmed as CONTRACT_EXECUTION_EXCEPTION or CONTRACT_REVERT_EXECUTED + INVALID_OPERATION.
  ethereum-direct-calls.csv            EOA → system-contract calls that failed (CONTRACT_EXECUTION_EXCEPTION). Extracted June 10, 2026.
  ethereum-nested-calls.csv            Contract → system-contract nested calls that failed. Extracted June 10, 2026.
  sql-queries.sql                      Queries run against the mirror node PostgreSQL database
  test-hip-1342-results.csv            (not committed) Generated by test-hip-1342.js; input for check-trailing-calldata.js

scripts/
  check-contract-execution-exceptions.sh   Check transactions and move them when compatible exceptions emerge
  check-trailing-calldata.js               Detects trailing bytes in each transaction's calldata
  test-hip-1342.js                         Live testnet test: correct vs. trailing-byte calls to HTS
```

## Additional Links

- [HIP-1342 discussion](https://github.com/hiero-ledger/hiero-improvement-proposals/pull/1397)
