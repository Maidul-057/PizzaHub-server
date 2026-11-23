import { Router } from "express";
import { col } from "../config/db.js";
import { verifyJWT } from "../middleware/auth.js";
import { HttpError, asyncHandler, isPremium } from "../utils/helpers.js";

const router = Router();

// Only name / image / businessName can be changed. role, isBlocked and subscription fields are never accepted.
router.patch(
  "/profile",
  verifyJWT,
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const $set = { updatedAt: new Date() };

    if (body.name !== undefined) {
      const name = String(body.name).trim();
      if (name.length < 2 || name.length > 60) throw new HttpError(400, "Name must be 2-60 characters");
      $set.name = name;
    }
    if (body.image !== undefined) {
      const image = String(body.image || "").trim();
      if (image && !/^https?:\/\//.test(image)) throw new HttpError(400, "Invalid image URL");
      $set.image = image || null;
    }
    if (body.businessName !== undefined && req.user.role === "vendor") {
      const businessName = String(body.businessName).trim();
      if (businessName.length < 2 || businessName.length > 80) throw new HttpError(400, "Restaurant name must be 2-80 characters");
      $set.businessName = businessName;
    }

    await col("users").updateOne({ _id: req.user.doc._id }, { $set });
    const u = await col("users").findOne({ _id: req.user.doc._id });
    res.json({
      id: String(u._id),
      name: u.name,
      email: u.email,
      image: u.image || null,
      role: u.role,
      businessName: u.businessName || null,
      subscriptionPlan: isPremium(u) ? "premium" : "free",
    });
  })
);

export default router;
