/**
 * Low-stock notifications (Group B — code now, keys later).
 *
 * This is intentionally dormant until you add credentials to the environment:
 *   Email (Resend):   RESEND_API_KEY, NOTIFY_EMAIL_FROM, NOTIFY_EMAIL_TO
 *   WhatsApp (Twilio): TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN,
 *                      TWILIO_WHATSAPP_FROM, NOTIFY_WHATSAPP_TO
 *
 * With no keys present it just logs and returns — so it never breaks a stock
 * movement, and there's no dead UI. Add the keys and alerts start flowing.
 */

type LowStockPayload = {
  productName: string;
  sku: string;
  // Strings since P1-2 — quantities are Decimal, and the caller formats them
  // once rather than every message template re-deciding how to round.
  onHand: string;
  threshold: string;
  location: string;
};

function buildMessage(p: LowStockPayload): string {
  return `Low stock: ${p.productName} (${p.sku}) is at ${p.onHand} at ${p.location} — threshold is ${p.threshold}. Consider reordering.`;
}

async function sendEmail(subject: string, text: string): Promise<boolean> {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.NOTIFY_EMAIL_FROM;
  const to = process.env.NOTIFY_EMAIL_TO;
  if (!key || !from || !to) return false;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from, to, subject, text }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function sendWhatsApp(text: string): Promise<boolean> {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_WHATSAPP_FROM;
  const to = process.env.NOTIFY_WHATSAPP_TO;
  if (!sid || !token || !from || !to) return false;
  try {
    const body = new URLSearchParams({
      From: `whatsapp:${from}`,
      To: `whatsapp:${to}`,
      Body: text,
    });
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization:
            "Basic " + Buffer.from(`${sid}:${token}`).toString("base64"),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body,
      }
    );
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Fire a low-stock alert through whatever channels are configured. Never
 * throws — a failed notification must not fail the stock operation.
 */
export async function notifyLowStock(p: LowStockPayload): Promise<void> {
  const msg = buildMessage(p);
  try {
    const sent = await Promise.all([
      sendEmail(`Low stock: ${p.productName}`, msg),
      sendWhatsApp(msg),
    ]);
    if (!sent.some(Boolean)) {
      // No channel configured (or all failed) — log so it's visible in dev.
      console.info(`[notify] (no channel configured) ${msg}`);
    }
  } catch {
    /* never let notifications break the caller */
  }
}
