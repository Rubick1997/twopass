# Minimum detectable drop (banking77, 8 noise runs, 20 rows per label)

Promise check: accepted precision moved 0.20 points between unchanged runs (95.59%–95.79%), so the floor is 94.80%.
Confident-wrong: moved 3 rows between unchanged runs (63–66).
Accuracy: 93.83%–94.09%; answer flips between two unchanged runs: up to 17; rows identical in every run: 97.2%.

Per label (G3 check 2): limit = max(2, largest net loss between two unchanged runs)

- 76 label(s) with limit 2: smallest visible drop 3 rows = 15 accuracy points
- 1 label(s) with limit 3: smallest visible drop 4 rows = 20 accuracy points

| label | rows | max net loss in noise | limit | smallest visible drop |
|---|---:|---:|---:|---:|
| transfer_fee_charged | 20 | 3 | 3 | 4 rows (20 pts) |
| activate_my_card | 20 | 0 | 2 | 3 rows (15 pts) |
| age_limit | 20 | 0 | 2 | 3 rows (15 pts) |
| apple_pay_or_google_pay | 20 | 0 | 2 | 3 rows (15 pts) |
| atm_support | 20 | 0 | 2 | 3 rows (15 pts) |
| automatic_top_up | 20 | 0 | 2 | 3 rows (15 pts) |
| balance_not_updated_after_bank_transfer | 20 | 1 | 2 | 3 rows (15 pts) |
| balance_not_updated_after_cheque_or_cash_deposit | 20 | 0 | 2 | 3 rows (15 pts) |
| beneficiary_not_allowed | 20 | 1 | 2 | 3 rows (15 pts) |
| cancel_transfer | 20 | 0 | 2 | 3 rows (15 pts) |
| card_about_to_expire | 20 | 0 | 2 | 3 rows (15 pts) |
| card_acceptance | 20 | 0 | 2 | 3 rows (15 pts) |
| card_arrival | 20 | 1 | 2 | 3 rows (15 pts) |
| card_delivery_estimate | 20 | 1 | 2 | 3 rows (15 pts) |
| card_linking | 20 | 0 | 2 | 3 rows (15 pts) |
| card_not_working | 20 | 1 | 2 | 3 rows (15 pts) |
| card_payment_fee_charged | 20 | 0 | 2 | 3 rows (15 pts) |
| card_payment_not_recognised | 20 | 1 | 2 | 3 rows (15 pts) |
| card_payment_wrong_exchange_rate | 20 | 2 | 2 | 3 rows (15 pts) |
| card_swallowed | 20 | 0 | 2 | 3 rows (15 pts) |
| cash_withdrawal_charge | 20 | 0 | 2 | 3 rows (15 pts) |
| cash_withdrawal_not_recognised | 20 | 0 | 2 | 3 rows (15 pts) |
| change_pin | 20 | 1 | 2 | 3 rows (15 pts) |
| compromised_card | 20 | 0 | 2 | 3 rows (15 pts) |
| contactless_not_working | 20 | 0 | 2 | 3 rows (15 pts) |
| country_support | 20 | 0 | 2 | 3 rows (15 pts) |
| declined_card_payment | 20 | 1 | 2 | 3 rows (15 pts) |
| declined_cash_withdrawal | 20 | 0 | 2 | 3 rows (15 pts) |
| declined_transfer | 20 | 0 | 2 | 3 rows (15 pts) |
| direct_debit_payment_not_recognised | 20 | 0 | 2 | 3 rows (15 pts) |
| disposable_card_limits | 20 | 0 | 2 | 3 rows (15 pts) |
| edit_personal_details | 20 | 0 | 2 | 3 rows (15 pts) |
| exchange_charge | 20 | 0 | 2 | 3 rows (15 pts) |
| exchange_rate | 20 | 1 | 2 | 3 rows (15 pts) |
| exchange_via_app | 20 | 0 | 2 | 3 rows (15 pts) |
| extra_charge_on_statement | 20 | 1 | 2 | 3 rows (15 pts) |
| failed_transfer | 20 | 0 | 2 | 3 rows (15 pts) |
| fiat_currency_support | 20 | 1 | 2 | 3 rows (15 pts) |
| get_disposable_virtual_card | 20 | 1 | 2 | 3 rows (15 pts) |
| get_physical_card | 20 | 0 | 2 | 3 rows (15 pts) |
| getting_spare_card | 20 | 0 | 2 | 3 rows (15 pts) |
| getting_virtual_card | 20 | 0 | 2 | 3 rows (15 pts) |
| lost_or_stolen_card | 20 | 0 | 2 | 3 rows (15 pts) |
| lost_or_stolen_phone | 20 | 0 | 2 | 3 rows (15 pts) |
| order_physical_card | 20 | 0 | 2 | 3 rows (15 pts) |
| passcode_forgotten | 20 | 0 | 2 | 3 rows (15 pts) |
| pending_card_payment | 20 | 0 | 2 | 3 rows (15 pts) |
| pending_cash_withdrawal | 20 | 0 | 2 | 3 rows (15 pts) |
| pending_top_up | 20 | 0 | 2 | 3 rows (15 pts) |
| pending_transfer | 20 | 0 | 2 | 3 rows (15 pts) |
| pin_blocked | 20 | 0 | 2 | 3 rows (15 pts) |
| receiving_money | 20 | 1 | 2 | 3 rows (15 pts) |
| Refund_not_showing_up | 20 | 0 | 2 | 3 rows (15 pts) |
| request_refund | 20 | 0 | 2 | 3 rows (15 pts) |
| reverted_card_payment? | 20 | 0 | 2 | 3 rows (15 pts) |
| supported_cards_and_currencies | 20 | 1 | 2 | 3 rows (15 pts) |
| terminate_account | 20 | 0 | 2 | 3 rows (15 pts) |
| top_up_by_bank_transfer_charge | 20 | 0 | 2 | 3 rows (15 pts) |
| top_up_by_card_charge | 20 | 0 | 2 | 3 rows (15 pts) |
| top_up_by_cash_or_cheque | 20 | 0 | 2 | 3 rows (15 pts) |
| top_up_failed | 20 | 0 | 2 | 3 rows (15 pts) |
| top_up_limits | 20 | 0 | 2 | 3 rows (15 pts) |
| top_up_reverted | 20 | 0 | 2 | 3 rows (15 pts) |
| topping_up_by_card | 20 | 0 | 2 | 3 rows (15 pts) |
| transaction_charged_twice | 20 | 1 | 2 | 3 rows (15 pts) |
| transfer_into_account | 20 | 0 | 2 | 3 rows (15 pts) |
| transfer_not_received_by_recipient | 20 | 0 | 2 | 3 rows (15 pts) |
| transfer_timing | 20 | 0 | 2 | 3 rows (15 pts) |
| unable_to_verify_identity | 20 | 0 | 2 | 3 rows (15 pts) |
| verify_my_identity | 20 | 0 | 2 | 3 rows (15 pts) |
| verify_source_of_funds | 20 | 0 | 2 | 3 rows (15 pts) |
| verify_top_up | 20 | 0 | 2 | 3 rows (15 pts) |
| virtual_card_not_working | 20 | 0 | 2 | 3 rows (15 pts) |
| visa_or_mastercard | 20 | 0 | 2 | 3 rows (15 pts) |
| why_verify_identity | 20 | 0 | 2 | 3 rows (15 pts) |
| wrong_amount_of_cash_received | 20 | 1 | 2 | 3 rows (15 pts) |
| wrong_exchange_rate_for_cash_withdrawal | 20 | 0 | 2 | 3 rows (15 pts) |
