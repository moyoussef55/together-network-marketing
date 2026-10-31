-- Pin SECURITY DEFINER routines to the application schema.
-- PostgreSQL implicitly searches pg_catalog before an explicitly configured path;
-- excluding public and temporary schemas prevents object-shadowing via attacker-controlled objects.
ALTER FUNCTION app_a8bd59e089a78f6d.admin_adjust_marketer_wallet(text, numeric, text, text, text) SET search_path = app_a8bd59e089a78f6d;
ALTER FUNCTION app_a8bd59e089a78f6d.admin_set_marketer_wallet_balance(text, numeric) SET search_path = app_a8bd59e089a78f6d;
ALTER FUNCTION app_a8bd59e089a78f6d.admin_set_network_withdrawal_status(uuid, text, text, text, text) SET search_path = app_a8bd59e089a78f6d;
ALTER FUNCTION app_a8bd59e089a78f6d.checkout_store_order(text, jsonb, text, text, text, text) SET search_path = app_a8bd59e089a78f6d;
ALTER FUNCTION app_a8bd59e089a78f6d.credit_direct_commission_for_order(uuid) SET search_path = app_a8bd59e089a78f6d;
ALTER FUNCTION app_a8bd59e089a78f6d.get_admin_marketer_wallet_balance(text) SET search_path = app_a8bd59e089a78f6d;
ALTER FUNCTION app_a8bd59e089a78f6d.get_marketer_wallet_state(text) SET search_path = app_a8bd59e089a78f6d;
ALTER FUNCTION app_a8bd59e089a78f6d.get_network_withdrawal_requests(text) SET search_path = app_a8bd59e089a78f6d;
ALTER FUNCTION app_a8bd59e089a78f6d.list_network_withdrawals_admin() SET search_path = app_a8bd59e089a78f6d;
ALTER FUNCTION app_a8bd59e089a78f6d.reconcile_legacy_marketer_wallet(text) SET search_path = app_a8bd59e089a78f6d;
ALTER FUNCTION app_a8bd59e089a78f6d.release_due_direct_commissions(timestamp with time zone) SET search_path = app_a8bd59e089a78f6d;