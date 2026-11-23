import "dotenv/config";
import express from "express";
import cors from "cors";
import { connectDB } from "./config/db.js";
import menuRoutes from "./routes/menu.routes.js";
import vendorRoutes from "./routes/vendor.routes.js";
import ordersRoutes from "./routes/orders.routes.js";
import adminRoutes from "./routes/admin.routes.js";
import profileRoutes from "./routes/profile.routes.js";
import paymentsRoutes, { stripeWebhook } from "./routes/payments.routes.js";

const app = express();

const clientOrigin = (process.env.CLIENT_URL || "http://localhost:3000").replace(/\/$/, "");

app.use(
  cors({
    origin: clientOrigin,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// Stripe needs the RAW body to verify the signature, so this route comes BEFORE express.json()
app.post("/api/payments/webhook", express.raw({ type: "application/json" }), stripeWebhook);

app.use(express.json({ limit: "1mb" }));

app.get("/", (_req, res) => res.json({ name: "PizzaHub API", status: "ok" }));
app.get("/api/health", (_req, res) => res.json({ status: "ok" }));

app.use("/api", menuRoutes);
app.use("/api", vendorRoutes);
app.use("/api", ordersRoutes);
app.use("/api", adminRoutes);
app.use("/api", paymentsRoutes);
app.use("/api", profileRoutes);

app.use((req, res) => res.status(404).json({ message: `Route not found: ${req.method} ${req.originalUrl}` }));

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ message: status >= 500 ? "Something went wrong on the server" : err.message });
});

const port = process.env.PORT || 5000;
connectDB()
  .then(() => app.listen(port, () => console.log(`PizzaHub API running on port ${port}`)))
  .catch((err) => {
    console.error("Failed to start server:", err);
    process.exit(1);
  });
