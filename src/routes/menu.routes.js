import { Router } from "express";
import { col } from "../config/db.js";
import {
  CATEGORIES,
  HttpError,
  asyncHandler,
  escapeRegex,
  pageParams,
  str,
  toOid,
  usersMap,
  vendorInfo,
  withId,
} from "../utils/helpers.js";

const router = Router();

const attachVendors = async (items) => {
  const vendors = await usersMap(items.map((i) => i.vendorId));
  return items.map((i) => ({ ...withId(i), vendor: vendorInfo(vendors.get(String(i.vendorId))) }));
};

// Categories (with counts) and locations used by the Browse Menu filters
router.get(
  "/menu/meta",
  asyncHandler(async (_req, res) => {
    const menu = col("menuItems");
    const [counts, locations] = await Promise.all([
      menu.aggregate([{ $match: { status: "approved" } }, { $group: { _id: "$category", count: { $sum: 1 } } }]).toArray(),
      menu.distinct("location", { status: "approved" }),
    ]);
    const countMap = new Map(counts.map((c) => [c._id, c.count]));
    res.json({
      categories: CATEGORIES.map((name) => ({ name, count: countMap.get(name) || 0 })),
      locations: locations.sort((a, b) => a.localeCompare(b)),
    });
  })
);

// Featured items: Premium vendors first, then newest approved items
router.get(
  "/menu/featured",
  asyncHandler(async (_req, res) => {
    const menu = col("menuItems");
    const premium = await col("users")
      .find({ subscriptionPlan: "premium", subscriptionExpiresAt: { $gt: new Date() } }, { projection: { _id: 1 } })
      .toArray();
    const premiumIds = premium.map((v) => String(v._id));

    let items = premiumIds.length
      ? await menu.find({ status: "approved", vendorId: { $in: premiumIds } }).sort({ createdAt: -1 }).limit(8).toArray()
      : [];
    if (items.length < 8) {
      const rest = await menu
        .find({ status: "approved", _id: { $nin: items.map((i) => i._id) } })
        .sort({ createdAt: -1 })
        .limit(8 - items.length)
        .toArray();
      items = [...items, ...rest];
    }
    res.json({ items: await attachVendors(items) });
  })
);

/**
 * Advanced search + sorting
 * GET /api/menu?search=&category=&location=&minPrice=&maxPrice=&sort=newest|price_asc|price_desc&page=&limit=
 */
router.get(
  "/menu",
  asyncHandler(async (req, res) => {
    const search = str(req.query.search);
    const category = str(req.query.category);
    const location = str(req.query.location);
    const sort = str(req.query.sort);
    const { page, limit, skip } = pageParams(req.query, 9, 24);

    const filter = { status: "approved" };

    if (search) {
      const rx = new RegExp(escapeRegex(search), "i");
      const vendors = await col("users")
        .find({ role: "vendor", $or: [{ businessName: rx }, { name: rx }] }, { projection: { _id: 1 } })
        .limit(50)
        .toArray();
      filter.$or = [
        { itemName: rx },
        { description: rx },
        { category: rx },
        { location: rx },
        ...(vendors.length ? [{ vendorId: { $in: vendors.map((v) => String(v._id)) } }] : []),
      ];
    }
    if (CATEGORIES.includes(category)) filter.category = category;
    if (location) filter.location = new RegExp(`^${escapeRegex(location)}$`, "i");

    const min = Number(req.query.minPrice);
    const max = Number(req.query.maxPrice);
    if (req.query.minPrice !== undefined && req.query.minPrice !== "" && !Number.isNaN(min)) {
      filter.price = { ...filter.price, $gte: min };
    }
    if (req.query.maxPrice !== undefined && req.query.maxPrice !== "" && !Number.isNaN(max)) {
      filter.price = { ...filter.price, $lte: max };
    }

    const sortMap = {
      price_asc: { price: 1, _id: 1 },
      price_desc: { price: -1, _id: 1 },
      newest: { createdAt: -1 },
    };

    const menu = col("menuItems");
    const [items, total] = await Promise.all([
      menu.find(filter).sort(sortMap[sort] || sortMap.newest).skip(skip).limit(limit).toArray(),
      menu.countDocuments(filter),
    ]);

    res.json({ items: await attachVendors(items), total, page, pages: Math.max(1, Math.ceil(total / limit)) });
  })
);

// Single item (only approved items are visible to the public)
router.get(
  "/menu/:id",
  asyncHandler(async (req, res) => {
    const item = await col("menuItems").findOne({ _id: toOid(req.params.id, 404, "Menu item not found") });
    if (!item || item.status !== "approved") throw new HttpError(404, "Menu item not found or not available");
    const [withVendor] = await attachVendors([item]);
    res.json(withVendor);
  })
);

export default router;
