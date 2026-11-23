import { createRemoteJWKSet, jwtVerify } from "jose";
import { col } from "../config/db.js";
import { HttpError, asyncHandler, userFilter } from "../utils/helpers.js";

let jwks;
const getJWKS = () => {
  if (!jwks) {
    const origin = (process.env.CLIENT_URL || "http://localhost:3000").replace(/\/$/, "");
    jwks = createRemoteJWKSet(new URL("/api/auth/jwks", origin));
  }
  return jwks;
};

/**
 * 1. Reads the "Authorization: Bearer <jwt>" header
 * 2. Verifies signature + expiry against the Better Auth JWKS endpoint
 * 3. Loads the user from MongoDB (role / block status are NEVER taken from the token)
 */
export const verifyJWT = asyncHandler(async (req, _res, next) => {
  const [scheme, token] = (req.headers.authorization || "").split(" ");
  if (scheme !== "Bearer" || !token) throw new HttpError(401, "Authentication required");

  let payload;
  try {
    const origin = (process.env.CLIENT_URL || "http://localhost:3000").replace(/\/$/, "");
    ({ payload } = await jwtVerify(token, getJWKS(), {
      issuer: process.env.JWT_ISSUER || origin,
      audience: process.env.JWT_AUDIENCE || undefined,
    }));
  } catch (err) {
    throw new HttpError(401, err.code === "ERR_JWT_EXPIRED" ? "Token expired" : "Invalid token");
  }

  const userId = payload.sub || payload.id;
  if (!userId) throw new HttpError(401, "Invalid token");

  const user = await col("users").findOne(userFilter([userId]));
  if (!user) throw new HttpError(401, "User no longer exists");
  if (user.isBlocked) throw new HttpError(403, "Your account has been blocked");

  req.user = { id: String(user._id), role: user.role || "customer", doc: user };
  next();
});

export const requireRole =
  (...roles) =>
  (req, _res, next) =>
    roles.includes(req.user?.role)
      ? next()
      : next(new HttpError(403, "Forbidden: you do not have access to this resource"));
