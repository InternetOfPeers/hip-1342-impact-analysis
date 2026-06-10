#!/usr/bin/env bash
# Check Hedera mainnet transactions for CONTRACT_EXECUTION_EXCEPTION errors.
# Primary:  Hedera mirror node  (/api/v1/transactions?timestamp=...)
# Fallback: HashIO JSON-RPC relay (eth_getTransactionReceipt)
# Output:   data/contract-execution-exceptions.csv

set -euo pipefail

MIRROR="https://mainnet.mirrornode.hedera.com/api/v1"
HASHIO="https://mainnet.hashio.io/api"
TARGET="CONTRACT_EXECUTION_EXCEPTION"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DATA_DIR="$PROJECT_DIR/network-data"

OUTPUT="${DATA_DIR}/contract-execution-exceptions.csv"

# ---------------------------------------------------------------------------
# ns_to_ts: convert raw nanosecond string -> "seconds.nanos" mirror-node format
# ---------------------------------------------------------------------------
ns_to_ts() {
    local ns="$1"
    printf "%d.%09d" $(( ns / 1000000000 )) $(( ns % 1000000000 ))
}

# ---------------------------------------------------------------------------
# mirror_get: GET from mirror node, retry on 429; stdout = JSON body or empty
# ---------------------------------------------------------------------------
mirror_get() {
    local url="$1"
    local attempt backoff body status
    backoff=2
    for attempt in 1 2 3 4; do
        body=$(curl -sf --max-time 15 "$url" 2>/dev/null) && { printf '%s' "$body"; return 0; }
        status=$(curl -so /dev/null -w "%{http_code}" --max-time 15 "$url" 2>/dev/null || echo "0")
        if [[ "$status" == "429" ]]; then
            echo "    rate-limited, sleeping ${backoff}s …" >&2
            sleep "$backoff"
            backoff=$(( backoff * 2 ))
        elif [[ "$status" == "404" ]]; then
            return 0
        fi
    done
    return 0
}

# ---------------------------------------------------------------------------
# check_via_mirror: returns "RESULT|tx_id" or empty string
# ---------------------------------------------------------------------------
check_via_mirror() {
    local ts_ns="$1"
    local ts body result tx_id
    ts=$(ns_to_ts "$ts_ns")
    body=$(mirror_get "${MIRROR}/transactions?timestamp=${ts}")
    if [[ -z "$body" ]]; then return 0; fi
    result=$(printf '%s' "$body" | jq -r '.transactions[0].result // empty' 2>/dev/null)
    tx_id=$(printf '%s' "$body" | jq -r '.transactions[0].transaction_id // empty' 2>/dev/null)
    if [[ -n "$result" ]]; then
        printf '%s|%s' "$result" "$tx_id"
    fi
}

# ---------------------------------------------------------------------------
# get_eth_hash: get Ethereum tx hash from contracts/results endpoint
# ---------------------------------------------------------------------------
get_eth_hash() {
    local ts_ns="$1"
    local ts body hash
    ts=$(ns_to_ts "$ts_ns")
    body=$(mirror_get "${MIRROR}/contracts/results/${ts}")
    hash=$(printf '%s' "$body" | jq -r '.hash // empty' 2>/dev/null)
    if [[ -z "$hash" ]]; then
        body=$(mirror_get "${MIRROR}/contracts/results?timestamp=${ts}")
        hash=$(printf '%s' "$body" | jq -r '.results[0].hash // empty' 2>/dev/null)
    fi
    printf '%s' "$hash"
}

# ---------------------------------------------------------------------------
# check_via_rpc: returns CONTRACT_EXECUTION_EXCEPTION / SUCCESS / empty
# ---------------------------------------------------------------------------
check_via_rpc() {
    local eth_hash="$1"
    local body status
    body=$(curl -sf --max-time 15 -X POST "$HASHIO" \
        -H "Content-Type: application/json" \
        -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_getTransactionReceipt\",\"params\":[\"${eth_hash}\"]}" \
        2>/dev/null)
    if [[ -z "$body" ]]; then return 0; fi
    status=$(printf '%s' "$body" | jq -r '.result.status // empty' 2>/dev/null)
    case "$status" in
        "0x0") printf '%s' "$TARGET" ;;
        "0x1") printf 'SUCCESS' ;;
    esac
}

# ---------------------------------------------------------------------------
# find_child_error: given a transaction_id and the parent result, return the
# first child record result (nonce > 0) that differs from the parent, or empty.
# This surfaces errors like INSUFFICIENT_GAS that hide behind CONTRACT_REVERT_EXECUTED.
# ---------------------------------------------------------------------------
find_child_error() {
    local tx_id="$1" parent_result="$2"
    local body hit
    body=$(mirror_get "${MIRROR}/transactions/${tx_id}")
    if [[ -z "$body" ]]; then return 0; fi
    hit=$(printf '%s' "$body" | jq -r --arg parent "$parent_result" '
        .transactions[]? | select(.nonce > 0) | select(.result != $parent) | .result
    ' 2>/dev/null | head -1)
    printf '%s' "$hit"
}

# ---------------------------------------------------------------------------
# resolve: returns "RESULT|id|source|child_error" for a given timestamp.
# child_error is non-empty when a child record has a different result than
# the parent (e.g. INSUFFICIENT_GAS hiding behind CONTRACT_REVERT_EXECUTED).
# ---------------------------------------------------------------------------
resolve() {
    local ts_ns="$1"
    local info result tx_id child_error eth_hash rpc_result
    info=$(check_via_mirror "$ts_ns")
    if [[ -n "$info" ]]; then
        result="${info%%|*}"
        tx_id="${info##*|}"
        child_error=""
        # Only check children when the parent result is not already the target error.
        # For CONTRACT_EXECUTION_EXCEPTION parents, children almost always share the
        # same result, so the extra API call is rarely useful and doubles runtime.
        if [[ -n "$tx_id" && "$result" != "$TARGET" ]]; then
            child_error=$(find_child_error "$tx_id" "$result")
        fi
        printf '%s|%s|mirror|%s' "$result" "$tx_id" "$child_error"
        return
    fi
    # mirror gave nothing — try JSON-RPC relay
    eth_hash=$(get_eth_hash "$ts_ns")
    if [[ -n "$eth_hash" ]]; then
        rpc_result=$(check_via_rpc "$eth_hash")
        if [[ -n "$rpc_result" ]]; then
            printf '%s|%s|rpc|' "$rpc_result" "$eth_hash"
            return
        fi
    fi
    printf 'NOT_FOUND||unknown|'
}

# ---------------------------------------------------------------------------
# collect unique timestamps with their full CSV row context
# Format in tmp file: ts_ns|source_file|extra_fields…
# ---------------------------------------------------------------------------
TMP_ROWS=$(mktemp)
trap 'rm -f "$TMP_ROWS"' EXIT

# direct calls: consensus_timestamp,receiver,payer_account,sender,error_message
tail -n +2 "${DATA_DIR}/ethereum-direct-calls.csv" | tr -d '\r' | while IFS=, read -r ts receiver payer sender err; do
    ts=${ts//\"/}; receiver=${receiver//\"/}; payer=${payer//\"/}; sender=${sender//\"/}; err=${err//\"/}
    printf '%s|direct_calls|%s|%s|%s|%s\n' "$ts" "$receiver" "$payer" "$sender" "$err"
done >> "$TMP_ROWS"

# nested calls: consensus_timestamp,sender,receiver,result_data
tail -n +2 "${DATA_DIR}/ethereum-nested-calls.csv" | tr -d '\r' | while IFS=, read -r ts sender receiver result_data; do
    ts=${ts//\"/}; sender=${sender//\"/}; receiver=${receiver//\"/}; result_data=${result_data//\"/}
    printf '%s|nested_calls|%s|%s|%s\n' "$ts" "$sender" "$receiver" "$result_data"
done >> "$TMP_ROWS"

# Deduplicate timestamps (preserve first occurrence order)
UNIQUE_TS=()
while IFS= read -r line; do UNIQUE_TS+=("$line"); done \
    < <(awk -F'|' '!seen[$1]++ {print $1}' "$TMP_ROWS")
TOTAL=${#UNIQUE_TS[@]}
echo "Checking ${TOTAL} unique transactions …"

# ---------------------------------------------------------------------------
# Write output CSV header
# ---------------------------------------------------------------------------
printf 'source_file,consensus_timestamp,to_address_hex,payer_account,csv_error,sender,receiver,result_data,result,transaction_id,lookup_source,child_error\n' > "$OUTPUT"

IDX=0

for ts_ns in "${UNIQUE_TS[@]}"; do
    IDX=$(( IDX + 1 ))
    ts_fmt=$(ns_to_ts "$ts_ns")
    printf '  [%d/%d] %s … ' "$IDX" "$TOTAL" "$ts_fmt" >&2

    info=$(resolve "$ts_ns")
    IFS='|' read -r result tx_id source child_error <<< "$info"

    # Pull the original error field from TMP_ROWS.
    # direct_calls format: ts|direct_calls|receiver|payer|sender|err  → field 6 = err
    # nested_calls format: ts|nested_calls|sender|receiver|result_data → field 5 = result_data
    _first_row=$(grep "^${ts_ns}|" "$TMP_ROWS" | head -1)
    _row_src=$(printf '%s' "$_first_row" | cut -d'|' -f2)
    if [[ "$_row_src" == "direct_calls" ]]; then
        csv_err=$(printf '%s' "$_first_row" | cut -d'|' -f6)
    else
        csv_err=$(printf '%s' "$_first_row" | cut -d'|' -f5)
    fi
    csv_err_tag=""
    [[ -n "$csv_err" ]] && csv_err_tag=" (csv: $csv_err)"

    if [[ -n "$child_error" ]]; then
        printf '%s → %s (via %s-child)%s\n' "$result" "$child_error" "$source" "$csv_err_tag" >&2
    else
        printf '%s (via %s)%s\n' "$result" "$source" "$csv_err_tag" >&2
    fi

    # Write to CSV when:
    #  • parent or child is CONTRACT_EXECUTION_EXCEPTION, OR
    #  • parent is CONTRACT_REVERT_EXECUTED and the original csv_error is INVALID_OPERATION
    #    (either as the string or its hex-encoded ASCII form)
    effective_result="$result"
    [[ "$result" != "$TARGET" && "$child_error" == "$TARGET" ]] && effective_result="$TARGET"
    if [[ "$result" == "CONTRACT_REVERT_EXECUTED" ]] && \
       [[ "$csv_err" == "INVALID_OPERATION" || "$csv_err" == "494e56414c49445f4f5045524154494f4e" ]]; then
        effective_result="$TARGET"
    fi

    if [[ "$effective_result" == "$TARGET" ]]; then
        # Write all rows for this timestamp with source-specific columns
        grep "^${ts_ns}|" "$TMP_ROWS" | while IFS='|' read -r _ src f1 f2 f3 f4; do
            if [[ "$src" == "direct_calls" ]]; then
                # f1=to_address_hex(receiver), f2=payer_account, f3=sender, f4=csv_error
                printf '%s,%s,%s,%s,%s,%s,,,"%s","%s",%s,%s\n' \
                    "$src" "$ts_ns" "$f1" "$f2" "$f4" "$f3" "$result" "$tx_id" "$source" "$child_error"
            else
                # f1=sender, f2=receiver, f3=result_data; direct cols empty
                printf '%s,%s,,,,"%s","%s","%s","%s","%s",%s,%s\n' \
                    "$src" "$ts_ns" "$f1" "$f2" "$f3" "$result" "$tx_id" "$source" "$child_error"
            fi
        done >> "$OUTPUT"
    fi

    sleep 0.2
done

echo ""
FOUND=$(( $(wc -l < "$OUTPUT") - 1 ))
if [[ "$FOUND" -gt 0 ]]; then
    echo "${FOUND} row(s) with ${TARGET} written to ${OUTPUT}"
else
    echo "No transactions found with ${TARGET}."
    rm -f "$OUTPUT"
fi
