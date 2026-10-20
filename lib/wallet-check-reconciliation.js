import { db } from "hatchable";

/**
 * Reconcile weekly checks already recorded by BV settlement into the member wallet.
 * The database helper uses unique weekly-check references and credits only missing
 * payments or positive increases, so repeated requests do not double-credit checks.
 */
export async function reconcileWeeklyCheckCredits(memberId) {
  const uid = String(memberId || "").trim();
  if (!uid) return { checked: 0, changed: 0 };

  const result = await db.query(
    "SELECT account_position, week_end, check_amount FROM network_bv_settlements WHERE member_id = $1 AND COALESCE(check_amount, 0) > 0 ORDER BY week_end, account_position",
    [uid]
  );

  let changed = 0;
  for (const row of result.rows || []) {
    const amount = Number(row.check_amount || 0);
    const position = Number(row.account_position || 1);
    if (!Number.isFinite(amount) || amount <= 0 || !Number.isInteger(position)) continue;
    const reference = "weekly-check:" + String(row.week_end) + ":" + uid + ":" + position;
    const credit = await db.query(
      "SELECT credit_weekly_check_to_wallet($1, $2, $3) AS credited",
      [uid, amount, reference]
    );
    if (credit.rows[0]?.credited === true) changed += 1;
  }

  return { checked: result.rows?.length || 0, changed };
}