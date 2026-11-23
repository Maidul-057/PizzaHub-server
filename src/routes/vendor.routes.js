import { Router } from "express";
import { col } from "../config/db.js";
import { requireRole, verifyJWT } from "../middleware/auth.js";
import {
  ACTIVE_ITEM_STATUSES,
  CATEGORIES,
  FREE_ITEM_LIMIT,
  HttpError,
  asyncHandler,
  isPremium,
  personInfo,
  toOid,
  usersMap,
  withId,
} from "../utils/helpers.js";

const router = Router();
router.use("/vendor", verifyJWT, requireRole("vendor"));

const items = () => col("menuItems");
const orders = () => col("orders");

function parseItem(body = {}) {
  const errors = [];
  const itemName = String(body.itemName || "").trim();
  const category = String(body.category || "").trim();
  const description = String(body.description || "").trim();
  const location = String(body.location || "").trim();
  const price = Number(body.price);
  const images = Array.isArray(body.images)
    ? body.images.filter((u) => typeof u === "string" && /^https?:\/\//.test(u)).slice(0, 5)
    : [];

  if (itemName.length < 3 || itemName.length > 80) errors.push("Item name must be 3-80 characters");
  if (!CATEGORIES.includes(category)) errors.push("Please choose a valid category");
  if (description.length < 10 || description.length > 1000) errors.push("Description must be 10-1000 characters");
  if (!(price > 0) || price > 100000) errors.push("Price must be a positive number");
  if (location.length < 2 || location.length > 80) errors.push("Location must be 2-80 characters");
  if (!images.length) errors.push("At least one item image is required");
  if (errors.length) throw new HttpError(400, errors.join(". "));

  return { itemName, category, description, price: Math.round(price * 100) / 100, location, images };
}

async function assertCanActivate(user) {
  if (isPremium(user.doc)) return;
  const active = await items().countDocuments({ vendorId: user.id, status: { $in: ACTIVE_ITEM_STATUSES } });
  if (active >= FREE_ITEM_LIMIT) {
    throw new HttpError(403, `Free plan allows only ${FREE_ITEM_LIMIT} active menu items. Upgrade to Premium for unlimited items.`);
  }
}

// Dashboard overview numbers
router.get(
  "/vendor/stats",
  asyncHandler(async (req, res) => {
    const vendorId = req.user.id;
    const [itemGroups, orderGroups] = await Promise.all([
      items().aggregate([{ $match: { vendorId } }, { $group: { _id: "$status", count: { $sum: 1 } } }]).toArray(),
      orders().aggregate([{ $match: { vendorId } }, { $group: { _id: "$status", count: { $sum: 1 } } }]).toArray(),
    ]);
    const itemsByStatus = Object.fromEntries(itemGroups.map((g) => [g._id, g.count]));
    const ordersByStatus = Object.fromEntries(orderGroups.map((g) => [g._id, g.count]));
    res.json({
      totalItems: Object.values(itemsByStatus).reduce((a, b) => a + b, 0),
      activeItems: itemsByStatus.approved || 0,
      pendingOrders: ordersByStatus.pending || 0,
      acceptedOrders: ordersByStatus.accepted || 0,
      plan: isPremium(req.user.doc) ? "premium" : "free",
      planExpiresAt: isPremium(req.user.doc) ? req.user.doc.subscriptionExpiresAt : null,
      itemsByStatus,
      ordersByStatus,
    });
  })
);

// Vendor's own items only
router.get(
  "/vendor/items",
  asyncHandler(async (req, res) => {
    const list = await items().find({ vendorId: req.user.id }).sort({ createdAt: -1 }).toArray();
    res.json({ items: list.map(withId), plan: isPremium(req.user.doc) ? "premium" : "free", freeLimit: FREE_ITEM_LIMIT });
  })
);

router.get(
  "/vendor/items/:id",
  asyncHandler(async (req, res) => {
    const item = await items().findOne({ _id: toOid(req.params.id, 404, "Item not found"), vendorId: req.user.id });
    if (!item) throw new HttpError(404, "Item not found");
    res.json(withId(item));
  })
);

router.post(
  "/vendor/items",
  asyncHandler(async (req, res) => {
    const data = parseItem(req.body);
    await assertCanActivate(req.user);
    const doc = { ...data, vendorId: req.user.id, status: "pending", wasApproved: false, createdAt: new Date() };
    const result = await items().insertOne(doc);
    res.status(201).json(withId({ ...doc, _id: result.insertedId }));
  })
);

// Updating an item sends it back to admin review (status: pending)
router.put(
  "/vendor/items/:id",
  asyncHandler(async (req, res) => {
    const data = parseItem(req.body);
    const _id = toOid(req.params.id, 404, "Item not found");
    const existing = await items().findOne({ _id, vendorId: req.user.id });
    if (!existing) throw new HttpError(404, "Item not found");
    if (!ACTIVE_ITEM_STATUSES.includes(existing.status)) await assertCanActivate(req.user);

    const updated = await items().findOneAndUpdate(
      { _id, vendorId: req.user.id },
      { $set: { ...data, status: "pending", updatedAt: new Date() } },
      { returnDocument: "after" }
    );
    res.json(withId(updated));
  })
);

// Manage availability: approved <-> inactive
router.patch(
  "/vendor/items/:id/availability",
  asyncHandler(async (req, res) => {
    const _id = toOid(req.params.id, 404, "Item not found");
    const item = await items().findOne({ _id, vendorId: req.user.id });
    if (!item) throw new HttpError(404, "Item not found");
    if (item.status === "rejected") throw new HttpError(400, "Rejected items cannot be made available");

    let status;
    if (req.body?.available === true) {
      if (item.status !== "inactive") throw new HttpError(400, "Item is already available");
      await assertCanActivate(req.user);
      status = item.wasApproved ? "approved" : "pending";
    } else {
      if (item.status === "inactive") throw new HttpError(400, "Item is already unavailable");
      status = "inactive";
    }
    const updated = await items().findOneAndUpdate(
      { _id, vendorId: req.user.id },
      { $set: { status, updatedAt: new Date() } },
      { returnDocument: "after" }
    );
    res.json(withId(updated));
  })
);

router.delete(
  "/vendor/items/:id",
  asyncHandler(async (req, res) => {
    const _id = toOid(req.params.id, 404, "Item not found");
    const result = await items().deleteOne({ _id, vendorId: req.user.id });
    if (!result.deletedCount) throw new HttpError(404, "Item not found");
    await orders().updateMany(
      { itemId: String(_id), status: "pending" },
      { $set: { status: "cancelled", statusUpdatedAt: new Date() }, $unset: { activeOrderKey: "" } }
    );
    res.json({ message: "Menu item deleted" });
  })
);

// Orders received by this vendor
router.get(
  "/vendor/orders",
  asyncHandler(async (req, res) => {
    const list = await orders().find({ vendorId: req.user.id }).sort({ createdAt: -1 }).toArray();
    const customers = await usersMap(list.map((o) => o.customerId));
    res.json({ orders: list.map((o) => ({ ...withId(o), customer: personInfo(customers.get(String(o.customerId))) })) });
  })
);

export default router;
