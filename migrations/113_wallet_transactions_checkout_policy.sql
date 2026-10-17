-- Allow the atomic checkout function to write only the active marketer's own wallet ledger row.
-- The function sets this transaction-local context and restores it before returning.
DROP POLICY IF EXISTS wallet_transactions_network_checkout_context ON wallet_transactions;
CREATE POLICY wallet_transactions_network_checkout_context ON wallet_transactions
  FOR INSERT
  WITH CHECK (user_id = current_setting('together.wallet_user_id', true));