import { Router } from "express";
import { col } from "../config/db.js";
import { requireRole, verifyJWT } from "../middleware/auth.js";
import { HttpError, asyncHandler, personInfo, toOid, usersMap, vendorInfo, withId } from "../utils/helpers.js";

const router = Router();
const orders = () => col("orders");

// Customer places an order
router.post(
  "/orders",
  verifyJWT,
  requireRole("customer"),
  asyncHandler(async (req, res) => {
    const { itemId, deliveryDate, deliveryAddress, message = "" } = req.body || {};
    const item = await col("menuItems").findOne({ _id: toOid(itemId, 400, "Invalid menu item") });
    if (!item || item.status !== "approved") throw new HttpError(404, "This item is not available for ordering");
    if (String(item.vendorId) === req.user.id) throw new HttpError(403, "You cannot order your own item");

    const date = String(deliveryDate || "");
    const today = new Date().toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) throw new HttpError(400, "Please choose a valid delivery date");
    if (date < today) throw new HttpError(400, "Delivery date cannot be in the past");

    const address = String(deliveryAddress || "").trim();
    if (address.length < 5 || address.length > 250) throw new HttpError(400, "Delivery address must be 5-250 characters");
    const note = String(message || "").trim();
    if (note.length > 500) throw new HttpError(400, "Message must be 500 characters or less");

    const duplicate = await orders().findOne({
      customerId: req.user.id,
      itemId: String(item._id),
      deliveryDate: date,
      status: { $in: ["pending", "accepted"] },
    });
    if (duplicate) throw new HttpError(409, "You already have an active order for this item on that date");

    const doc = {
      itemId: String(item._id),
      vendorId: item.vendorId,
      customerId: req.user.id,
      activeOrderKey: `${req.user.id}:${String(item._id)}:${date}`,
      itemName: item.itemName,
      itemImage: item.images?.[0] || null,
      price: item.price,
      deliveryDate: date,
      deliveryAddress: address,
      message: note,
      status: "pending",
      createdAt: new Date(),
      statusUpdatedAt: null,
    };
    let result;
    try {
      result = await orders().insertOne(doc);
    } catch (err) {
      if (err?.code === 11000) throw new HttpError(409, "You already have an active order for this item on that date");
      throw err;
    }
    res.status(201).json(withId({ ...doc, _id: result.insertedId }));
  })
);

// Customer dashboard numbers
router.get(
  "/customer/stats",
  verifyJWT,
  requireRole("customer"),
  asyncHandler(async (req, res) => {
    const groups = await orders()
      .aggregate([{ $match: { customerId: req.user.id } }, { $group: { _id: "$status", count: { $sum: 1 } } }])
      .toArray();
    const byStatus = Object.fromEntries(groups.map((g) => [g._id, g.count]));
    res.json({
      total: Object.values(byStatus).reduce((a, b) => a + b, 0),
      pending: byStatus.pending || 0,
      accepted: byStatus.accepted || 0,
      rejected: byStatus.rejected || 0,
      cancelled: byStatus.cancelled || 0,
    });
  })
);

router.get(
  "/orders/my",
  verifyJWT,
  requireRole("customer"),
  asyncHandler(async (req, res) => {
    const list = await orders().find({ customerId: req.user.id }).sort({ createdAt: -1 }).toArray();
    const vendors = await usersMap(list.map((o) => o.vendorId));
    res.json({ orders: list.map((o) => ({ ...withId(o), vendor: vendorInfo(vendors.get(String(o.vendorId))) })) });
  })
);

// Order details: only the customer or the vendor of that order
router.get(
  "/orders/:id",
  verifyJWT,
  requireRole("customer", "vendor"),
  asyncHandler(async (req, res) => {
    const order = await orders().findOne({ _id: toOid(req.params.id, 404, "Order not found") });
    const allowed = order && (order.customerId === req.user.id || order.vendorId === req.user.id);
    if (!allowed) throw new HttpError(404, "Order not found");
    const users = await usersMap([order.vendorId, order.customerId]);
    res.json({
      ...withId(order),
      vendor: vendorInfo(users.get(String(order.vendorId))),
      customer: personInfo(users.get(String(order.customerId))),
    });
  })
);

// Customer cancels own PENDING order
router.patch(
  "/orders/:id/cancel",
  verifyJWT,
  requireRole("customer"),
  asyncHandler(async (req, res) => {
    const _id = toOid(req.params.id, 404, "Order not found");
    const updated = await orders().findOneAndUpdate(
      { _id, customerId: req.user.id, status: "pending" },
      { $set: { status: "cancelled", statusUpdatedAt: new Date() }, $unset: { activeOrderKey: "" } },
      { returnDocument: "after" }
    );
    if (!updated) {
      const exists = await orders().findOne({ _id, customerId: req.user.id });
      if (!exists) throw new HttpError(404, "Order not found");
      throw new HttpError(409, `Only pending orders can be cancelled. This order is already ${exists.status}.`);
    }
    res.json(withId(updated));
  })
);

// Vendor accepts or rejects a PENDING order (once)
router.patch(
  "/orders/:id/status",
  verifyJWT,
  requireRole("vendor"),
  asyncHandler(async (req, res) => {
    const status = req.body?.status;
    if (!["accepted", "rejected"].includes(status)) throw new HttpError(400, "Status must be accepted or rejected");
    const _id = toOid(req.params.id, 404, "Order not found");
    const updated = await orders().findOneAndUpdate(
      { _id, vendorId: req.user.id, status: "pending" },
      {
        $set: { status, statusUpdatedAt: new Date() },
        ...(status === "rejected" ? { $unset: { activeOrderKey: "" } } : {}),
      },
      { returnDocument: "after" }
    );
    if (!updated) {
      const exists = await orders().findOne({ _id, vendorId: req.user.id });
      if (!exists) throw new HttpError(404, "Order not found");
      throw new HttpError(409, `Only pending orders can be updated. This order is already ${exists.status}.`);
    }
    res.json(withId(updated));
  })
);

export default router;
