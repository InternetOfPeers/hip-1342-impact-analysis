# Impact Analysis — HIP-1342: Ignore Trailing Calldata for System Contract

> Prepared following the process defined in
> [breaking-change-impact-analysis.md](breaking-change-impact-analysis.md).
> HIP under analysis: [HIP-1342](https://hips.hedera.com/#hip-1342) (status: `Last Call`, last-call-date 2026-05-20).
> Data extracted from the Hedera **mainnet** mirror node on 2026-06-10. Enrichment via the
> mainnet mirror node REST API on 2026-06-11.

## Executive Summary

HIP-1342 is a **consensus rule change**: Ethereum calls to system contracts that today revert
because they carry extra ("trailing") bytes after the ABI-encoded parameters will **succeed**
after activation. The change is permissive — it makes previously-failing transactions work — so
the impact direction is almost entirely **positive**.

A full sweep of mainnet history (2023-06 → 2026-06) yields **11 genuine trailing-calldata
transactions**, originating from **2 end-user accounts**, hitting **1 system contract** (HTS, via
`redirectForToken` → ERC-20 `transfer`), and touching **2 tokens** (USD Coin and SeagullCash).
All transferred amounts are negligible test values; **no funds are at risk**. The single
production-pattern case (a USDC transfer carrying a 32-byte order ID, 2025-11-10) is exactly the
cross-chain attribution workflow that **Squid, Axelar, and the Hedera Foundation** requested this
HIP for. The remaining 10 are developer experiments validating the memo-in-calldata pattern ahead
of activation.

**Overall severity: Low.** Recommended path: proceed, with release-notes communication and a
short staged (testnet → mainnet) activation. Details below.

---

## Change Classification

| Field | Value |
|-------|-------|
| **Type** | Consensus rule change (ABI calldata decoding for system contracts) |
| **Affected Surface** | All system contracts — HTS (`0x167`/`0.0.359`), HAS (`0x16a`), HSS (`0x16b`) — including ERC-20/721 paths reached via `redirectForToken` (HIP-218): `transfer`, `transferFrom`, `approve`, etc. |
| **Behavioral Delta** | **Old:** a system-contract call whose calldata contains extra bytes after the ABI-defined parameters fails to decode and reverts (`CONTRACT_REVERT_EXECUTED` / `INVALID_OPERATION`). **New:** the decoder parses the expected parameters, ignores any trailing bytes, and the call proceeds normally. Trailing bytes remain visible in the Ethereum transaction input for off-chain consumption. |
| **Manifestation condition** | Only when calldata length **exceeds** the canonical ABI-encoded length for the matched selector. Calls with exact-length (or under-length / malformed) calldata are unaffected and continue to behave as today. |

The change is additive in effect: it cannot make a currently-succeeding transaction fail. The only
theoretical regression is a caller that *relied on* the revert as a signal — see
[Impact Severity](#impact-severity).

---

## Network Data Summary

### Headline metrics

| Metric | Mainnet |
| -------------------------- | --------- |
| Total genuine trailing-calldata txns | **11** |
| Unique end-user accounts (signers) | **2** (`0.0.10091969`, `0.0.10427019`) |
| Unique payer / relay accounts | **2** (`0.0.995584`, `0.0.6319439`) |
| Unique target system contracts | **1** — HTS (`0.0.359`) |
| Unique tokens involved | **2** — USDC, SeagullCash |
| Distinct function path | `redirectForToken` → `transfer(address,uint256)` |
| Time span | 2025-11-10 → 2026-06-06 |
| Trend | Sparse; 1 isolated case (Nov 2025) + a cluster of 10 dev experiments (May–Jun 2026) |
| Average daily occurrence | ≈ 0.05/day (11 over ~209 days) |
| Financial value at risk | **None** — all test amounts (≤ 0.0001 USDC; ≤ 99.5 SGLCSH) |

### Candidate funnel (mainnet)

The raw candidate set is large, but the genuine impact set is tiny. Transparency on the
narrowing:

| Stage | Result | Source |
| ------- | -------- | -------- |
| 1. Raw reverts on system contracts (mirror DB) | 550 direct EOA calls + 10,078 nested contract actions = **10,628 rows** (2023-06 → 2026-06) | [ethereum-direct-calls.csv](https://github.com/internetofpeers/hip-1342-impact-analysis/blob/main/network-data/ethereum-direct-calls.csv), [ethereum-nested-calls.csv](https://github.com/internetofpeers/hip-1342-impact-analysis/blob/main/network-data/ethereum-nested-calls.csv) |
| 2. Confirmed `CONTRACT_REVERT_EXECUTED` + `INVALID_OPERATION` (the strict-decode failure signature) | **689 transactions** (all nested-call paths) | [contract-execution-exceptions.csv](https://github.com/internetofpeers/hip-1342-impact-analysis/blob/main/network-data/contract-execution-exceptions.csv) |
| 3. Calldata fetched, decoded, re-encoded; **trailing bytes measured > 0** | **11 transactions** | [analysis-results.csv](https://github.com/internetofpeers/hip-1342-impact-analysis/blob/main/network-data/analysis-results.csv) |

Note on stage 2→3: `INVALID_OPERATION` is a generic HTS revert. Only 11 of the 689 reverts were
caused by genuine trailing calldata; the other 678 reverted for unrelated reasons (e.g.
insufficient balance, missing association, allowance issues) and decode cleanly with **no** trailing
bytes. The run processed the full file — confirmed exceptions exist as far back as 2024-05, yet no
trailing-calldata case predates 2025-11-10 — so 11 is the complete count, not a truncated sample.

### Queries Used

Run against the mainnet mirror node PostgreSQL instance — full SQL in
[network-data/sql-queries.sql](https://github.com/internetofpeers/hip-1342-impact-analysis/blob/main/network-data/sql-queries.sql). System-contract entity IDs:
`359` (HTS), `362` (HAS), `363` (HSS), `364` (HTSv2).

```sql
-- Direct EOA → system-contract reverts (ethereum-direct-calls.csv)
SELECT cr_eth.consensus_timestamp, cr_eth.contract_id AS receiver,
       cr_eth.payer_account_id AS payer_account, cr_eth.sender_id AS sender,
       cr_eth.error_message
FROM ethereum_transaction et
JOIN contract_result cr_eth ON cr_eth.consensus_timestamp = et.consensus_timestamp
 AND cr_eth.contract_id IN (359, 362, 363, 364)
WHERE cr_eth.transaction_result = 34;   -- CONTRACT_REVERT_EXECUTED

-- Nested contract → system-contract reverts (ethereum-nested-calls.csv)
SELECT ca.consensus_timestamp, ca.caller AS sender,
       ca.recipient_contract AS receiver, encode(ca.result_data,'hex') AS result_data
FROM ethereum_transaction et
JOIN contract_action ca ON ca.consensus_timestamp = et.consensus_timestamp
WHERE ca.call_depth > 0
  AND ca.recipient_contract IN (359, 362, 363, 364)
  AND ca.result_data_type IN (12, 13)
ORDER BY ca.consensus_timestamp DESC;
```

Resolution + trailing-byte detection (REST API, with RPC fallback) is implemented in
[scripts/check-contract-execution-exceptions.sh](https://github.com/internetofpeers/hip-1342-impact-analysis/blob/main/scripts/check-contract-execution-exceptions.sh)
and [scripts/check-trailing-calldata.js](https://github.com/internetofpeers/hip-1342-impact-analysis/blob/main/scripts/check-trailing-calldata.js). Per-transaction
enrichment in this report used the mainnet mirror node REST endpoints
`/api/v1/contracts/results/{hash}`, `/api/v1/accounts/{id|evm}`, and `/api/v1/tokens/{id}`.

### Transactions (all 11)

`sender` in the source data is the **token contract** whose ERC-20 facade redirects into HTS; the
real signer is the top-level Ethereum `from`.

| Date (UTC) | Token | Amount | Trailing memo (bytes) | Signer EOA | Relay/payer | Tx |
| ------------ | ------- | -------- | ----------------------- | ------------ | ------------- | ---- |
| 2025-11-10 14:05 | USDC (`0.0.456858`) | 0.0001 | `0x3372…7fb7` (32 bytes) | `0.0.10091969` | `0.0.6319439` | [`1762783522.983266000`](https://hashscan.io/mainnet/transaction/1762783522.983266000) |
| 2026-05-14 23:16 | SeagullCash (`0.0.3115556`) | 0.4975 | `Hello World` (11 bytes) | `0.0.10427019` | `0.0.995584` | [`1778800593.641767764`](https://hashscan.io/mainnet/transaction/1778800593.641767764) |
| 2026-05-15 03:22 | SeagullCash | 0.0995 | `Found` (5 bytes) | `0.0.10427019` | `0.0.995584` | [`1778815321.984112072`](https://hashscan.io/mainnet/transaction/1778815321.984112072) |
| 2026-05-15 03:27 | SeagullCash | 0.0995 | `Found` (5 bytes) | `0.0.10427019` | `0.0.995584` | [`1778815624.653599000`](https://hashscan.io/mainnet/transaction/1778815624.653599000) |
| 2026-05-16 14:06 | SeagullCash | 99.5 | `Test 1` (6 bytes) | `0.0.10427019` | `0.0.995584` | [`1778940418.123274000`](https://hashscan.io/mainnet/transaction/1778940418.123274000) |
| 2026-05-16 14:11 | SeagullCash | 99.5 | `Test` (4 bytes) | `0.0.10427019` | `0.0.995584` | [`1778940661.893411000`](https://hashscan.io/mainnet/transaction/1778940661.893411000) |
| 2026-05-16 14:13 | SeagullCash | 99.5 | `Test` (4 bytes) | `0.0.10427019` | `0.0.995584` | [`1778940823.790181000`](https://hashscan.io/mainnet/transaction/1778940823.790181000) |
| 2026-05-16 14:14 | SeagullCash | 99.5 | `Test` (4 bytes) | `0.0.10427019` | `0.0.995584` | [`1778940854.047903000`](https://hashscan.io/mainnet/transaction/1778940854.047903000) |
| 2026-06-06 17:41 | SeagullCash | 0.995 | `Yoyo` (4 bytes) | `0.0.10427019` | `0.0.995584` | [`1780767709.529393133`](https://hashscan.io/mainnet/transaction/1780767709.529393133) |
| 2026-06-06 17:42 | SeagullCash | 0.995 | `Yoyo` (4 bytes) | `0.0.10427019` | `0.0.995584` | [`1780767753.115754000`](https://hashscan.io/mainnet/transaction/1780767753.115754000) |
| 2026-06-06 17:42 | SeagullCash | 0.995 | `Yoyo` (4 bytes) | `0.0.10427019` | `0.0.995584` | [`1780767777.678234000`](https://hashscan.io/mainnet/transaction/1780767777.678234000) |

**Reading the canonical case (#1).** Decoded calldata, exactly as in the HIP's reference example:

```text
0xa9059cbb                                                         transfer selector
  000000000000000000000000136c1cb3257dcf2615e25c914fd1767dcf084577 to  = 0.0.10080933
  0000000000000000000000000000000000000000000000000000000000000064 amount = 100 (0.0001 USDC)
  3372348f476a87cf942167a35e78e40f00c91c99072b0c515ba8118cbd927fb7 ← 32 trailing bytes (order ID), ignored under HIP-1342
```

Under current rules this reverts with `INVALID_OPERATION`; under HIP-1342 it performs an ordinary
0.0001 USDC transfer and the 32-byte order ID stays readable via `eth_getTransactionByHash`.

---

## Stakeholder Map

| Entity | Account(s) | Contact Status | Impact Direction |
| -------- | ----------- | ---------------- | ------------------ |
| **Squid / Axelar / Hedera Foundation** — cross-chain routing; requested the HIP | signer `0.0.10091969`; USDC token `0.0.456858`; dest `0.0.10080933`; relay `0.0.6319439` | **Known & contactable** (named in HIP `requested-by`; working group already engaged) | **Positive** — the change directly unblocks their order-ID-in-calldata workflow |
| **SeagullCash** ("ISO20022 Liquidity Bridge", token `0.0.3115556`, treasury `0.0.2928384`) | signer `0.0.10427019` (nonce 96, active); dest `0.0.10478149` | **Known but no direct contact** (token issuer identifiable on-chain) | **Positive** — actively testing the memo pattern; clearly wants it to work |
| **End-user signers** | `0.0.10091969`, `0.0.10427019` | **Unknown individuals, contactable on-chain** (zero-value memo transfer) | **Positive** |
| **Hashio, Quicknode** — JSON-RPC relay operators | `0.0.995584`, `0.0.6319439` | **Known & contactable** (infrastructure) | **Neutral** — relays simply forward; no behavior change for them |
| **Circle** - USDC issuer | token `0.0.456858` (canonical mainnet USDC) | Known & contactable | **Neutral/Positive** — token semantics unchanged; the failing call type now succeeds |

No stakeholder was found to depend on the *revert* behavior. Every identified actor seems appending
trailing bytes **on purpose** and would probably benefit from the change.

---

## Impact Severity

- **Rating: Low.**
- **Rationale:**
  1. **Tiny, well-bounded exposure.** 11 transactions over 7 months, 2 signers, 2 tokens, 1 system
     contract. Average ≈ 0.05 occurrences/day. No value at risk — every amount is a test value
     (≤ 0.0001 USDC; the largest SeagullCash transfer is 99.5 SGLCSH, a low-liquidity bridge token).
  2. **Direction is positive.** The change converts deliberate failures into successes. The one
     production-pattern case is the exact Squid/Axelar use case the HIP was authored for.
  3. **No observed reliance on the revert.** A silent-behavior-difference regression (someone using
     the failure as a signal) is theoretically possible but unsupported by any evidence in the data,
     and the HIP preserves provenance (trailing bytes stay in the tx input).
  4. **Low reversibility cost.** Rollback would need a network release, but since the behavior is
     permissive and uptake is currently ~zero, the blast radius of either activating or reverting is
     minimal.
- **Edge cases to keep in mind:** the trailing-bytes cap (HIP Open Issue) should be fixed before
  activation to bound input-size abuse; and the mirror node explorer should be verified to surface
  trailing bytes distinctly when the ABI is known (per the HIP's "Impact on the Mirror Node
  Explorer" section), so the now-ignored bytes don't silently disappear from tooling.

---

## Communication and Mitigation Plan

| Action | Owner | Deadline | Status |
| -------- | ------- | ---------- | -------- |
| Direct outreach to Squid / Axelar / Hedera Foundation (confirm timeline meets their needs) | @neurone | 2026-06-30 | Planned |
| On-chain notice to signer `0.0.10427019` (SeagullCash tester) and `0.0.10091969` — zero-value transfer w/ memo pointing to release notes | DevRel | 2026-07-07 | Planned |
| Release-notes / changelog entry (consensus node) describing the decoding change | DevRel / Eng | At release cut | Planned |
| Confirm mirror node explorer renders trailing bytes distinctly (known-ABI case) | Mirror node explorer team | Before mainnet activation | Planned |
| Developer blog post: "Memo via calldata on Hiero system contracts" + Ethers.js example | DevRel | At/after testnet activation | Planned |
| Testnet activation | Release eng | TBD | Planned |
| Mainnet activation (after ≥ 2 weeks testnet soak) | Release eng | TBD | Planned |
| Post-activation monitoring: watch system-contract calls with trailing calldata for unexpected reverts | Eng / QA | Activation + 4 weeks | Planned |

**Recommended activation timing:** staged. Given Low severity, activate on testnet first, soak for
~2 weeks while the comms above land, then mainnet. No emergency or extended-notice path is
warranted.

---

### Appendix — Supporting Repository and Files

To reproduce and verify the results of this impact analysis, please refer to the following repository: <https://github.com/internetofpeers/hip-1342-impact-analysis>

| File | Contents |
| ------ | ---------- |
| [network-data/sql-queries.sql](https://github.com/internetofpeers/hip-1342-impact-analysis/blob/main/network-data/sql-queries.sql) | Mirror node PostgreSQL queries (stage 1/3) |
| [network-data/ethereum-direct-calls.csv](https://github.com/internetofpeers/hip-1342-impact-analysis/blob/main/network-data/ethereum-direct-calls.csv) | 550 raw direct-call reverts (stage 1/3) |
| [network-data/ethereum-nested-calls.csv](https://github.com/internetofpeers/hip-1342-impact-analysis/blob/main/network-data/ethereum-nested-calls.csv) | 10,078 raw nested-call reverts (stage 1/3) |
| [network-data/contract-execution-exceptions.csv](https://github.com/internetofpeers/hip-1342-impact-analysis/blob/main/network-data/contract-execution-exceptions.csv) | 689 confirmed `INVALID_OPERATION` exceptions (stage 2/3) |
| [network-data/analysis-results.csv](https://github.com/internetofpeers/hip-1342-impact-analysis/blob/main/network-data/analysis-results.csv) | **11 confirmed trailing-calldata transactions** (stage 3/3) |
| [network-data/test-hip-1342-results.csv](https://github.com/internetofpeers/hip-1342-impact-analysis/blob/main/network-data/test-hip-1342-results.csv) | Testnet controlled-reproduction results |
| [scripts/check-contract-execution-exceptions.sh](https://github.com/internetofpeers/hip-1342-impact-analysis/blob/main/scripts/check-contract-execution-exceptions.sh) | Resolves raw timestamps → confirmed exceptions |
| [scripts/check-trailing-calldata.js](https://github.com/internetofpeers/hip-1342-impact-analysis/blob/main/scripts/check-trailing-calldata.js) | Decodes calldata, measures trailing bytes |
| [scripts/test-hip-1342.js](https://github.com/internetofpeers/hip-1342-impact-analysis/blob/main/scripts/test-hip-1342.js) | Live testnet verification harness |
