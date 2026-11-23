import { MongoClient } from "mongodb";

let client;
let db;

export async function connectDB() {
  if (db) return db;
  client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  db = client.db(process.env.DB_NAME || "pizzahub");

  await Promise.all([
    db.collection("menuItems").createIndex({ vendorId: 1 }),
    db.collection("menuItems").createIndex({ status: 1, price: 1 }),
    db.collection("menuItems").createIndex({ status: 1, vendorId: 1 }),
    db.collection("orders").createIndex({ customerId: 1 }),
    db.collection("orders").createIndex({ vendorId: 1 }),
    db.collection("orders").createIndex(
      { activeOrderKey: 1 },
      { unique: true, partialFilterExpression: { activeOrderKey: { $exists: true } } }
    ),
    db.collection("users").createIndex({ role: 1 }),
    db.collection("users").createIndex({ email: 1 }),
    db.collection("transactions").createIndex({ stripeSessionId: 1 }, { unique: true }),
    db.collection("transactions").createIndex({ vendorId: 1 }),
  ]);
  console.log("MongoDB connected");
  return db;
}

export function col(name) {
  if (!db) throw new Error("Database is not connected");
  return db.collection(name);
}
