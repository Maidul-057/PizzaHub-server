import { Router } from "express";
import Stripe from "stripe";
import { col } from "../config/db.js";
import { requireRole, verifyJWT } from "../middleware/auth.js";
import { HttpError, addDays, asyncHandler, isPremium, userFilter, withId } from "../utils/helpers.js";

const router = Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_missing");
const tx = () => col("transactions");
const users = () => col("users");

const clientUrl = () => (process.env.CLIENT_URL || "http://localhost:3000").replace(/\/$/, "");

// ---------- 1. Create a Stripe Checkout Session (vendor only, for THEMSELVES only) ----------
router.post(
  "/payments/checkout",
  verifyJWT,
  requireRole("vendor"),
  asyncHandler(async (req, res) => {
    const vendor = req.user.doc;
    if (isPremium(vendor)) throw new HttpError(409, "You already have an active Premium plan");

    const amountCents = Number(process.env.PREMIUM_PRICE_CENTS || 999);
    const currency = (process.env.PREMIUM_CURRENCY || "usd").toLowerCase();
    // vendorId always comes from the verified JWT user, never from the request body
    const metadata = { vendorId: req.user.id, plan: "premium" };

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer_email: vendor.email,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency,
            unit_amount: amountCents,
            recurring: { interval: "month" },
            product_data: {
              name: "PizzaHub Premium (monthly)",
              description: "Unlimited menu items, Premium badge and featured placement",
            },
          },
        },
      ],
      metadata,
      subscription_data: { metadata },
      success_url: `${clientUrl()}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${clientUrl()}/payment/cancel`,
    });

    await tx().insertOne({
      vendorId: req.user.id,
      plan: "premium",
      amount: amountCents / 100,
      currency,
      stripeSessionId: session.id,
      stripeSubscriptionId: null,
      status: "pending",
      createdAt: new Date(),
    });

    res.json({ url: session.url });
  })
);

// ---------- 2. Read endpoints for the vendor ----------
// Success page polls this. It only READS the result of the webhook, it never activates anything.
router.get(
  "/payments/session/:sessionId",
  verifyJWT,
  requireRole("vendor"),
  asyncHandler(async (req, res) => {
    const t = await tx().findOne({ stripeSessionId: req.params.sessionId, vendorId: req.user.id });
    if (!t) throw new HttpError(404, "Payment not found");
    res.json({ status: t.status, amount: t.amount, currency: t.currency, plan: t.plan });
  })
);

router.get(
  "/payments/subscription",
  verifyJWT,
  requireRole("vendor"),
  asyncHandler(async (req, res) => {
    const u = req.user.doc;
    const list = await tx().find({ vendorId: req.user.id }).sort({ createdAt: -1 }).limit(20).toArray();
    res.json({
      plan: isPremium(u) ? "premium" : "free",
      expiresAt: isPremium(u) ? u.subscriptionExpiresAt : null,
      cancelAtPeriodEnd: Boolean(u.subscriptionCancelAtPeriodEnd),
      transactions: list.map(withId),
    });
  })
);

// Cancel at period end (downgrade happens when Stripe sends customer.subscription.deleted)
router.post(
  "/payments/cancel-subscription",
  verifyJWT,
  requireRole("vendor"),
  asyncHandler(async (req, res) => {
    if (!isPremium(req.user.doc)) throw new HttpError(400, "You do not have an active Premium plan");
    const last = await tx()
      .find({ vendorId: req.user.id, status: "paid", stripeSubscriptionId: { $ne: null } })
      .sort({ createdAt: -1 })
      .limit(1)
      .next();
    if (!last) throw new HttpError(404, "No Stripe subscription found");
    await stripe.subscriptions.update(last.stripeSubscriptionId, { cancel_at_period_end: true });
    await users().updateOne({ _id: req.user.doc._id }, { $set: { subscriptionCancelAtPeriodEnd: true } });
    res.json({ message: "Subscription will end at the end of the current billing period" });
  })
);

// ---------- 3. Stripe webhook (mounted with express.raw in index.js) ----------
async function activatePremium(vendorId, days = 30) {
  const filter = userFilter([vendorId]);
  const vendor = await users().findOne(filter);
  if (!vendor) return;
  const base = isPremium(vendor) ? new Date(vendor.subscriptionExpiresAt) : new Date();
  await users().updateOne(filter, {
    $set: { subscriptionPlan: "premium", subscriptionExpiresAt: addDays(base, days), subscriptionCancelAtPeriodEnd: false },
  });
}

async function vendorIdFromSubscription(subscriptionId) {
  if (!subscriptionId) return null;
  const t = await tx().findOne({ stripeSubscriptionId: subscriptionId });
  return t?.vendorId || null;
}

async function handleEvent(event) {
  const obj = event.data.object;
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded": {
      if (obj.mode !== "subscription" || obj.payment_status !== "paid") return;
      const vendorId = obj.metadata?.vendorId;
      if (!vendorId) return;
      const existing = await tx().findOne({ stripeSessionId: obj.id });
      if (existing?.status === "paid") return; // idempotent
      await tx().updateOne(
        { stripeSessionId: obj.id },
        {
          $set: {
            status: "paid",
            stripeSubscriptionId: typeof obj.subscription === "string" ? obj.subscription : obj.subscription?.id || null,
            amount: (obj.amount_total || 0) / 100,
            currency: obj.currency,
            paidAt: new Date(),
          },
          $setOnInsert: { vendorId, plan: "premium", createdAt: new Date() },
        },
        { upsert: true }
      );
      await activatePremium(vendorId);
      return;
    }
    case "checkout.session.expired":
    case "checkout.session.async_payment_failed": {
      await tx().updateOne(
        { stripeSessionId: obj.id, status: "pending" },
        { $set: { status: event.type === "checkout.session.expired" ? "expired" : "failed" } }
      );
      return;
    }
    case "invoice.paid": {
      // Renewals only: the first invoice is handled by checkout.session.completed
      if (obj.billing_reason !== "subscription_cycle") return;
      const subId = obj.subscription || obj.parent?.subscription_details?.subscription;
      const vendorId = await vendorIdFromSubscription(subId);
      if (!vendorId) return;
      const key = `invoice:${obj.id}`;
      if (await tx().findOne({ stripeSessionId: key })) return;
      await tx().insertOne({
        vendorId,
        plan: "premium",
        amount: (obj.amount_paid || 0) / 100,
        currency: obj.currency,
        stripeSessionId: key,
        stripeSubscriptionId: subId,
        status: "paid",
        createdAt: new Date(),
      });
      await activatePremium(vendorId);
      return;
    }
    case "customer.subscription.updated": {
      const vendorId = obj.metadata?.vendorId || (await vendorIdFromSubscription(obj.id));
      if (vendorId) await users().updateOne(userFilter([vendorId]), { $set: { subscriptionCancelAtPeriodEnd: Boolean(obj.cancel_at_period_end) } });
      return;
    }
    case "customer.subscription.deleted": {
      const vendorId = obj.metadata?.vendorId || (await vendorIdFromSubscription(obj.id));
      if (vendorId) {
        await users().updateOne(userFilter([vendorId]), {
          $set: { subscriptionPlan: "free", subscriptionExpiresAt: new Date(), subscriptionCancelAtPeriodEnd: false },
        });
      }
      return;
    }
    default:
      return;
  }
}

export async function stripeWebhook(req, res) {
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("Webhook signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  try {
    await handleEvent(event);
    res.json({ received: true });
  } catch (err) {
    console.error("Webhook handler failed:", err);
    res.status(500).send("Webhook handler failed");
  }
}

export default router;
