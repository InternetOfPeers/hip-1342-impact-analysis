-- ethereum-direct-calls.csv

SELECT
    cr_eth.consensus_timestamp AS consensus_timestamp,
	  cr_eth.contract_id AS receiver,
    cr_eth.payer_account_id AS payer_account,
   	cr_eth.sender_id AS sender,
    cr_eth.error_message AS error_message
FROM ethereum_transaction et
JOIN contract_result cr_eth
    ON  cr_eth.consensus_timestamp = et.consensus_timestamp
    AND cr_eth.contract_id IN (359, 362, 363, 364)
WHERE
	cr_eth.transaction_result  = 34

-- ethereum-nested-calls.csv

SELECT ca.consensus_timestamp AS consensus_timestamp,
       ca.caller              AS sender,
       ca.recipient_contract  AS receiver,
	     encode(ca.result_data, 'hex')  AS result_data
FROM ethereum_transaction et
JOIN contract_action ca
  ON ca.consensus_timestamp = et.consensus_timestamp
WHERE ca.call_depth > 0
  AND ca.recipient_contract IN (359, 362, 363, 364)
  AND ca.result_data_type IN (12, 13)
ORDER BY ca.consensus_timestamp DESC