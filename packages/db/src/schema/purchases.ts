import { pgTable, text, serial, uuid, integer, date, numeric, timestamp, index, uniqueIndex, foreignKey } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { customersTable } from "./customers";

export const purchaseStatusEnum = ["pending", "completed", "refunded", "cancelled", "payment_failed"] as const;
export type PurchaseStatus = (typeof purchaseStatusEnum)[number];

export const purchaseClassificationEnum = ["first_order", "recurring", "unknown"] as const;
export const purchaseClassificationSourceEnum = ["bask", "purchase_history", "manual", "unknown"] as const;

export const purchasesTable = pgTable(
  "purchases",
  {
    id: serial("id").primaryKey(),
    customerId: uuid("customer_id").notNull(),
    purchaseDate: date("purchase_date", { mode: "string" }).notNull(),
    orderNumber: text("order_number").notNull(),
    productName: text("product_name").notNull(),
    amountPaid: numeric("amount_paid", { precision: 10, scale: 2 }).notNull(),
    status: text("status", { enum: purchaseStatusEnum }).notNull().default("completed"),
    ecommerceOrderId: text("ecommerce_order_id"),
    orderClassification: text("order_classification", { enum: purchaseClassificationEnum }),
    orderClassificationSource: text("order_classification_source", { enum: purchaseClassificationSourceEnum }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "purchases_customer_id_fk",
      columns: [t.customerId],
      foreignColumns: [customersTable.id],
    }).onDelete("cascade"),
    uniqueIndex("purchases_ecommerce_order_id_key").on(t.ecommerceOrderId),
    index("purchases_customer_id_idx").on(t.customerId),
    // A customer can have at most one purchase classified "first_order" —
    // this is the backstop against the classification race (concurrent
    // purchase creation both reading "no earlier purchase" before either
    // commits), not the primary defense; see the per-customer row lock in
    // createPurchase/handleBaskOrderWebhook. Partial index so "recurring"
    // and "unknown" rows are unaffected.
    uniqueIndex("purchases_customer_first_order_key").on(t.customerId).where(sql`${t.orderClassification} = 'first_order'`),
  ],
);

export const purchaseClassificationAuditsTable = pgTable(
  "purchase_classification_audits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    purchaseId: integer("purchase_id")
      .notNull()
      .references(() => purchasesTable.id, { onDelete: "cascade" }),
    changedBy: text("changed_by").notNull(),
    previousClassification: text("previous_classification", { enum: purchaseClassificationEnum }),
    newClassification: text("new_classification", { enum: purchaseClassificationEnum }).notNull(),
    previousSource: text("previous_source", { enum: purchaseClassificationSourceEnum }),
    newSource: text("new_source", { enum: purchaseClassificationSourceEnum }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("purchase_classification_audits_purchase_id_idx").on(t.purchaseId)],
);

export type Purchase = typeof purchasesTable.$inferSelect;
export type InsertPurchase = typeof purchasesTable.$inferInsert;
