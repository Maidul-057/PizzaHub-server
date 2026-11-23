import { ObjectId } from "mongodb";
import { col } from "../config/db.js";

export const CATEGORIES = [
  "Classic Pizzas",
  "Vegetarian Pizzas",
  "Meat Lovers",
  "Specialty / Gourmet Pizzas",
  "Sides & Appetizers",
  "Beverages & Desserts",
];
export const ITEM_STATUSES = ["pending", "approved", "rejected", "inactive"];
// "Active" items count against the Free plan limit
export const ACTIVE_ITEM_STATUSES = ["pending", "approved"];
export const FREE_ITEM_LIMIT = 3;

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

const OID_RE = /^[a-f\d]{24}$/i;
export const isOid = (v) => typeof v === "string" && OID_RE.test(v);
export const toOid = (v, status = 400, message = "Invalid ID") => {
  if (!isOid(String(v))) throw new HttpError(status, message);
  return new ObjectId(String(v));
};

export const str = (v) => (typeof v === "string" ? v.trim() : "");
export const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function pageParams(query, defLimit = 10, max = 50) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(max, Math.max(1, parseInt(query.limit, 10) || defLimit));
  return { page, limit, skip: (page - 1) * limit };
}

// Better Auth may store _id as ObjectId or string, so match both forms
export const userFilter = (ids) => ({
  _id: {
    $in: [...new Set(ids.map(String))].flatMap((i) => (isOid(i) ? [i, new ObjectId(i)] : [i])),
  },
});

export async function usersMap(ids) {
  const list = [...new Set(ids.filter(Boolean).map(String))];
  if (!list.length) return new Map();
  const users = await col("users").find(userFilter(list)).toArray();
  return new Map(users.map((u) => [String(u._id), u]));
}

export const isPremium = (u) =>
  Boolean(
    u &&
      u.subscriptionPlan === "premium" &&
      u.subscriptionExpiresAt &&
      new Date(u.subscriptionExpiresAt) > new Date()
  );

// Public vendor info (no email)
export const vendorInfo = (u) =>
  u
    ? {
        id: String(u._id),
        name: u.name,
        businessName: u.businessName || u.name,
        image: u.image || null,
        isPremium: isPremium(u),
      }
    : null;

// Private person info (only for the order's own vendor / customer / admin)
export const personInfo = (u) =>
  u ? { id: String(u._id), name: u.name, email: u.email, image: u.image || null } : null;

export const withId = (doc) => {
  const { _id, ...rest } = doc;
  return { id: String(_id), ...rest };
};

export const addDays = (date, days) => new Date(date.getTime() + days * 86400000);
