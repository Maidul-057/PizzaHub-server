import { Router } from "express";
import { col } from "../config/db.js";
import { requireRole, verifyJWT } from "../middleware/auth.js";
import {
  CATEGORIES,
  HttpError,
  ITEM_STATUSES,
  asyncHandler,
  escapeRegex,
  isPremium,
  pageParams,
  str,
  toOid,
  userFilter,
  usersMap,
  vendorInfo,
  withId,
} from "../utils/helpers.js";

const router = Router();
router.use("/admin", verifyJWT, requireRole("admin"));

router.get(
  "/admin/stats",
  asyncHandler(async (_req, res) => {
    const users = col("users");
    const menu = col("menuItems");
    const [totalUsers, totalVendors, totalCustomers, totalItems, pendingItems, totalTransactions, itemGroups, revenue] =
      await Promise.all([
        users.countDocuments({}),
        users.countDocuments({ role: "vendor" }),
        users.countDocuments({ role: "customer" }),
        menu.countDocuments({}),
        menu.countDocuments({ status: "pending" }),
        col("transactions").countDocuments({}),
        menu.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]).toArray(),
        col("transactions").aggregate([{ $match: { status: "paid" } }, { $group: { _id: null, total: { $sum: "$amount" } } }]).toArray(),
      ]);
    res.json({
      totalUsers,
      totalVendors,
      totalCustomers,
      totalItems,
      pendingItems,
      totalTransactions,
      revenue: revenue[0]?.total || 0,
      itemsByStatus: Object.fromEntries(itemGroups.map((g) => [g._id, g.count])),
    });
  })
);

// ---------- Users ----------
router.get(
  "/admin/users",
  asyncHandler(async (req, res) => {
    const { page, limit, skip } = pageParams(req.query, 10, 50);
    const filter = {};
    const search = str(req.query.search);
    const role = str(req.query.role);
    if (search) {
      const rx = new RegExp(escapeRegex(search), "i");
      filter.$or = [{ name: rx }, { email: rx }];
    }
    if (["vendor", "customer", "admin"].includes(role)) filter.role = role;

    const [list, total] = await Promise.all([
      col("users").find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).toArray(),
      col("users").countDocuments(filter),
    ]);
    res.json({
      users: list.map((u) => ({
        id: String(u._id),
        name: u.name,
        email: u.email,
        image: u.image || null,
        role: u.role || "customer",
        isBlocked: Boolean(u.isBlocked),
        businessName: u.businessName || null,
        subscriptionPlan: isPremium(u) ? "premium" : "free",
        subscriptionExpiresAt: u.subscriptionExpiresAt || null,
        emailVerified: Boolean(u.emailVerified),
        createdAt: u.createdAt,
      })),
      total,
      page,
      pages: Math.max(1, Math.ceil(total / limit)),
    });
  })
);

router.patch(
  "/admin/users/:id/block",
  asyncHandler(async (req, res) => {
    const blocked = req.body?.blocked;
    if (typeof blocked !== "boolean") throw new HttpError(400, "blocked must be true or false");
    const target = await col("users").findOne(userFilter([req.params.id]));
    if (!target) throw new HttpError(404, "User not found");
    if (String(target._id) === req.user.id) throw new HttpError(400, "You cannot block yourself");
    if (target.role === "admin") throw new HttpError(403, "Admin accounts cannot be blocked");

    await col("users").updateOne({ _id: target._id }, { $set: { isBlocked: blocked, updatedAt: new Date() } });
    if (blocked) {
      // Force logout everywhere
      await col("session").deleteMany({ userId: { $in: [String(target._id), target._id] } });
    }
    res.json({ message: blocked ? "User blocked" : "User unblocked", isBlocked: blocked });
  })
);

// ---------- Menu items ----------
router.get(
  "/admin/menu",
  asyncHandler(async (req, res) => {
    const { page, limit, skip } = pageParams(req.query, 10, 50);
    const filter = {};
    const search = str(req.query.search);
    const status = str(req.query.status);
    const category = str(req.query.category);
    if (search) {
      const rx = new RegExp(escapeRegex(search), "i");
      filter.$or = [{ itemName: rx }, { location: rx }, { description: rx }];
    }
    if (ITEM_STATUSES.includes(status)) filter.status = status;
    if (CATEGORIES.includes(category)) filter.category = category;

    const menu = col("menuItems");
    const [list, total] = await Promise.all([
      menu.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).toArray(),
      menu.countDocuments(filter),
    ]);
    const vendors = await usersMap(list.map((i) => i.vendorId));
    res.json({
      items: list.map((i) => ({
        ...withId(i),
        vendor: { ...vendorInfo(vendors.get(String(i.vendorId))), email: vendors.get(String(i.vendorId))?.email },
      })),
      total,
      page,
      pages: Math.max(1, Math.ceil(total / limit)),
    });
  })
);

router.patch(
  "/admin/menu/:id/status",
  asyncHandler(async (req, res) => {
    const status = req.body?.status;
    if (!ITEM_STATUSES.includes(status)) throw new HttpError(400, "Invalid status");
    const $set = { status, updatedAt: new Date() };
    if (status === "approved") $set.wasApproved = true;
    const updated = await col("menuItems").findOneAndUpdate(
      { _id: toOid(req.params.id, 404, "Item not found") },
      { $set },
      { returnDocument: "after" }
    );
    if (!updated) throw new HttpError(404, "Item not found");
    res.json(withId(updated));
  })
);

router.delete(
  "/admin/menu/:id",
  asyncHandler(async (req, res) => {
    const _id = toOid(req.params.id, 404, "Item not found");
    const result = await col("menuItems").deleteOne({ _id });
    if (!result.deletedCount) throw new HttpError(404, "Item not found");
    await col("orders").updateMany(
      { itemId: String(_id), status: "pending" },
      { $set: { status: "cancelled", statusUpdatedAt: new Date() }, $unset: { activeOrderKey: "" } }
    );
    res.json({ message: "Menu item deleted" });
  })
);

// ---------- Transactions (read-only: there is intentionally no update/delete route) ----------
router.get(
  "/admin/transactions",
  asyncHandler(async (req, res) => {
    const { page, limit, skip } = pageParams(req.query, 10, 50);
    const filter = {};
    const status = str(req.query.status);
    if (["pending", "paid", "failed", "expired"].includes(status)) filter.status = status;

    const tx = col("transactions");
    const [list, total] = await Promise.all([
      tx.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).toArray(),
      tx.countDocuments(filter),
    ]);
    const vendors = await usersMap(list.map((t) => t.vendorId));
    res.json({
      transactions: list.map((t) => {
        const v = vendors.get(String(t.vendorId));
        return { ...withId(t), vendor: v ? { ...vendorInfo(v), email: v.email } : null };
      }),
      total,
      page,
      pages: Math.max(1, Math.ceil(total / limit)),
    });
  })
);

export default router;
