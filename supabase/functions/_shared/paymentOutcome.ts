// Is this attempt over, or still in flight?
//
// Split out of gateways.ts for the same reason bankNames.ts was: this file
// touches no Deno global and no network, so src/test/paymentOutcome.test.ts can
// import it directly under vitest. Keep it that way — anything reading a secret
// or calling a provider belongs in gateways.ts.
//
// Getting this wrong is expensive in one direction only. Writing off an attempt
// that is still in flight marks a live payment failed: create-payment stops
// counting it as settled and asks the student to pay a second time for money
// already collected. Leaving a genuinely dead attempt pending costs nothing but
// a stale row. So everything here is an ALLOW-LIST of states known to be over,
// and anything unrecognised is treated as still running.

/**
 * Statuses that mean the attempt is over and no money is coming.
 *
 * Everything else — pending, processing, ongoing, queued — is still in flight
 * and must NOT be written off. A bank transfer routinely has not confirmed by
 * the time the payer is redirected back from checkout, and marking that failed
 * both misreports it to the school and, if the webhook is later missed, asks
 * the student to pay a second time for money already collected.
 */
export const TERMINAL_FAILURES = [
  "failed",
  "abandoned",
  "reversed",
  "cancelled",
  "canceled",
  "declined",
  "expired",
  "rejected",
];

export const isTerminalFailure = (status: string): boolean =>
  TERMINAL_FAILURES.includes(String(status ?? "").toLowerCase());

/**
 * Is this Paystack telling us an inbound bank transfer is over?
 *
 * Paystack rejects and auto-refunds a transfer for the wrong amount
 * (support.paystack.com/en/articles/2128642), and we want to tell the payer
 * that rather than leave the attempt pending forever.
 *
 * Deliberately an allow-list of terminal words, NOT "any bank.transfer event
 * that is not success". The exact event names are not documented publicly —
 * Paystack's developer docs refuse automated fetches — so this is matching on
 * names we have not yet observed. A deny-list would mean any intermediate event
 * Paystack sends (an init, a pending, an acknowledgement) writes off a live
 * payment. An allow-list that misses the real name simply leaves the row
 * pending, which is what happens today.
 */
export const isTransferRejection = (event: string): boolean => {
  const e = String(event ?? "").toLowerCase();
  const prefix = "bank.transfer.";
  if (!e.startsWith(prefix)) return false;
  return TERMINAL_FAILURES.includes(e.slice(prefix.length));
};
