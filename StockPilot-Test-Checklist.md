# StockPilot — Functional Verification Checklist

**System:** StockPilot Inventory Management
**Version:** P0 hardening + P1 features 1–9
**Prepared for:** Senior review
**Date:** 30 August 2026

---

## Purpose

This document lets a reviewer verify every shipped feature by hand, in order. Each test states what to do and what should happen. Tick the box when the observed result matches.

Features still in development (stock reservations) are **not** included — they are not ready for review.

## Before you start

| Requirement | Detail |
|---|---|
| Account | An ADMIN login. Some steps also need a STAFF login to verify permissions. |
| Data | At least two locations, one supplier, one customer, and three products. |
| Note | Tests run in order. Later sections depend on stock created earlier. |

**Reference numbers** follow fixed prefixes: `INV-` invoices, `PO-` purchase orders, `GRN-` deliveries, `SRT-` supplier returns, `RET-` sales returns, `CNT-` stock counts.

---

## 1. Access and security

| # | Step | Expected result | ✓ |
|---|---|---|---|
| 1.1 | Log in with valid credentials | Dashboard loads; your name and role appear bottom-left | ☐ |
| 1.2 | Log in with a wrong password | Rejected with a generic error — it must **not** reveal whether the email exists | ☐ |
| 1.3 | Log in as STAFF, open Stock counts | Page loads, but "Start a count" is not offered | ☐ |
| 1.4 | As STAFF, attempt to complete a stock count | Refused — applying adjustments is ADMIN/MANAGER only | ☐ |
| 1.5 | Log out, then press browser Back | You are returned to login, not to cached data | ☐ |

---

## 2. Products and stock

| # | Step | Expected result | ✓ |
|---|---|---|---|
| 2.1 | Create a product with SKU, name, unit and cost | Saved and listed | ☐ |
| 2.2 | Create a second product with the **same SKU** | Rejected — SKU must be unique within the company | ☐ |
| 2.3 | Record a PURCHASE of 100 units at Location A | Stock at A becomes 100 | ☐ |
| 2.4 | Record a SALE of 30 units at Location A | Stock becomes 70 | ☐ |
| 2.5 | Attempt to sell 200 units | **Refused** — stock may never go negative | ☐ |
| 2.6 | Transfer 20 units from A to B | A becomes 50, B becomes 20; total unchanged | ☐ |
| 2.7 | Open the product's movement history | Every step above appears as a separate dated entry | ☐ |

> **Key principle:** stock is never stored as a number. It is the sum of all movements, and movements are never edited or deleted — corrections are added as new entries. This is what makes the history trustworthy.

### 2A. Decimal quantities

| # | Step | Expected result | ✓ |
|---|---|---|---|
| 2.8 | Create a product with unit `kg` and precision `3` | Saved | ☐ |
| 2.9 | Purchase 1 kg, then sell 0.1 kg three times | Remaining shows exactly **0.7**, not 0.7000000000000001 | ☐ |
| 2.10 | Attempt to sell 0.0001 kg | Refused — finer than the product's precision | ☐ |
| 2.11 | On a whole-unit product, attempt to sell 2.5 | Refused — you cannot sell half a unit | ☐ |

---

## 3. Batches and expiry

| # | Step | Expected result | ✓ |
|---|---|---|---|
| 3.1 | Enable batch tracking on a product | Batch number becomes required on incoming stock | ☐ |
| 3.2 | Receive batch **B1** expiring in 60 days, then **B2** expiring in 20 days | Both listed on the Batches page | ☐ |
| 3.3 | Sell a quantity of that product | Stock is taken from **B2 first** — nearest expiry goes first (FEFO) | ☐ |
| 3.4 | Attempt to receive batch stock without a batch number | Refused | ☐ |
| 3.5 | Open Reports → expiring stock | B2 appears ahead of B1 | ☐ |

---

## 4. Purchase orders and receiving

| # | Step | Expected result | ✓ |
|---|---|---|---|
| 4.1 | Create a PO for 100 units at ₹50 | Saved as DRAFT with a `PO-` number | ☐ |
| 4.2 | Mark it ORDERED | Status changes; lines can no longer be edited | ☐ |
| 4.3 | Receive 60 units, accepted, at ₹52 actual | Stock rises by 60; PO shows 60 of 100 received | ☐ |
| 4.4 | Check the product's average cost | Reflects ₹52 actually paid, **not** the ₹50 quoted | ☐ |
| 4.5 | Receive 50 more units | Refused — cannot receive more than ordered | ☐ |
| 4.6 | Receive the remaining 40, rejecting 5 | Stock rises by **35 only**; 5 recorded as rejected | ☐ |
| 4.7 | Open Receiving → Deliveries | A `GRN-` entry appears, linked to the PO | ☐ |

> **Key principle:** only accepted goods enter stock. Rejected goods are recorded so the supplier can be chased, but they were never inventory.

---

## 5. Invoices and sales

| # | Step | Expected result | ✓ |
|---|---|---|---|
| 5.1 | Create an invoice with two lines | Saved as DRAFT with an `INV-` number; stock unchanged | ☐ |
| 5.2 | Edit the draft and change a quantity | Saves correctly | ☐ |
| 5.3 | Issue the invoice | Stock falls by the invoiced quantities | ☐ |
| 5.4 | Attempt to edit the issued invoice | Refused — only drafts are editable | ☐ |
| 5.5 | Create and issue an invoice exceeding stock | Refused at issue | ☐ |
| 5.6 | Cancel an issued invoice | Stock is restored; invoice shows CANCELLED | ☐ |
| 5.7 | Check batch stock after cancelling | Units return to their **original batches**, keeping their original expiry dates | ☐ |

---

## 6. Payments

| # | Step | Expected result | ✓ |
|---|---|---|---|
| 6.1 | Issue an invoice for ₹1,000 | Balance shows ₹1,000 outstanding | ☐ |
| 6.2 | Record a ₹400 cash payment | Status becomes PARTIAL; balance ₹600 | ☐ |
| 6.3 | Record a further ₹600 by UPI | Status becomes PAID; balance ₹0 | ☐ |
| 6.4 | Attempt a further ₹100 payment | Refused — cannot pay more than is owed | ☐ |
| 6.5 | Open Reports → outstanding balances | Fully paid invoices no longer appear | ☐ |

> **Key principle:** payment status is calculated from actual payment records, never set by hand. A half-paid invoice is a real, representable state.

---

## 7. Sales returns

| # | Step | Expected result | ✓ |
|---|---|---|---|
| 7.1 | Raise a return against an issued invoice for 5 units, condition **Sellable** | Created as REQUESTED; stock unchanged | ☐ |
| 7.2 | Approve, then mark received | Stock rises by 5 | ☐ |
| 7.3 | Raise a return with condition **Damaged** | The restock option is disabled and cannot be selected | ☐ |
| 7.4 | Mark the damaged return received | Return is recorded but stock does **not** rise | ☐ |
| 7.5 | Attempt to return more than was sold | Refused | ☐ |
| 7.6 | Record a refund on a received return | Refund amount is stored against the return | ☐ |

---

## 8. Supplier returns

| # | Step | Expected result | ✓ |
|---|---|---|---|
| 8.1 | Open Receiving → Returns to supplier → create from a delivery | Saved as DRAFT with an `SRT-` number; stock unchanged | ☐ |
| 8.2 | Confirm stock is untouched at draft stage | On-hand figure has not moved | ☐ |
| 8.3 | Press **Send** | Stock **decreases** now — this is the moment goods leave | ☐ |
| 8.4 | Mark it Complete | Status updates; stock unchanged by this step | ☐ |
| 8.5 | Attempt to return more than was received | Refused | ☐ |

---

## 9. Reordering

| # | Step | Expected result | ✓ |
|---|---|---|---|
| 9.1 | Set a product minimum of 10; leave Warehouse A at 2 and Warehouse B at 100 | — | ☐ |
| 9.2 | Open Reports → reorder | **Warehouse A is listed** even though the company total is 102 | ☐ |
| 9.3 | Confirm Warehouse B is not listed | Only short locations appear | ☐ |
| 9.4 | Set a location-specific minimum of 50 for Warehouse B | B now appears, using 50 rather than the product default | ☐ |
| 9.5 | Set a location minimum of 0 | That location is excluded from the report entirely | ☐ |
| 9.6 | Check the suggested order quantity | Tops up to the maximum where one is set, otherwise twice the minimum | ☐ |

> **Key principle:** reordering is judged per location. A company-wide total tells you nothing about the shelf someone is standing at.

---

## 10. Stock counts

| # | Step | Expected result | ✓ |
|---|---|---|---|
| 10.1 | Start a count for a location | Sheet is prepared, listing products with stock | ☐ |
| 10.2 | Check the count sheet before entering figures | The **expected quantity is hidden** — only a blank entry box is shown | ☐ |
| 10.3 | Press Begin counting, enter figures for some items | Progress shows "N of M counted"; uncounted rows are highlighted | ☐ |
| 10.4 | Attempt Submit for review with items uncounted | Disabled, stating how many remain | ☐ |
| 10.5 | Enter a figure **lower** than expected on one item, matching on another | — | ☐ |
| 10.6 | Submit for review | Expected, counted and variance columns now appear | ☐ |
| 10.7 | Press Apply adjustments | Confirmation lists each discrepancy before you commit | ☐ |
| 10.8 | Confirm, then open the product's movement history | An **ADJUSTMENT** entry appears for the difference — stock was corrected by an event, not overwritten | ☐ |
| 10.9 | Confirm the matching item produced no entry | Items that agreed with the system generate nothing | ☐ |

> **Key principle:** the expected figure is hidden during counting on purpose. If a counter can see the answer, some will simply confirm it — and the count then measures nothing while appearing perfect.

---

## 11. Reports

| # | Report | Expected result | ✓ |
|---|---|---|---|
| 11.1 | Inventory valuation | Total value matches quantity × average cost | ☐ |
| 11.2 | Profitability | Revenue, cost of goods sold, gross profit and margin are shown | ☐ |
| 11.3 | Sales over time | Figures match the invoices issued | ☐ |
| 11.4 | Purchasing | Totals match the purchase orders raised | ☐ |
| 11.5 | Outstanding balances | Matches unpaid invoice balances | ☐ |
| 11.6 | Expiring stock | Lists batches by nearest expiry | ☐ |
| 11.7 | Low stock | Reflects products at or below their threshold | ☐ |

---

## 12. Data integrity

| # | Step | Expected result | ✓ |
|---|---|---|---|
| 12.1 | Sell the same stock from two browser windows at the same time | One succeeds, one is refused — stock never goes negative | ☐ |
| 12.2 | Create two invoices simultaneously | Both receive distinct numbers; no error | ☐ |
| 12.3 | Attempt to open another company's record by changing the ID in the URL | Not found — data is never shared across companies | ☐ |
| 12.4 | Review the Activity page | Recent actions are listed with the user who performed them | ☐ |

---

## Known limitations

These are recorded deliberately and are not defects to be raised:

1. **Stock reservations** are built but not released. Draft invoices do not yet hold stock.
2. **No screens yet** for Goods Receipt creation outside a purchase order, or for supplier return editing after sending.
3. **Automated tests do not cover database constraints.** The test database is built by schema push rather than by running migrations, so the 34 integrity constraints are active in production but not exercised by the test suite.
4. **GST is a single tax rate.** CGST/SGST/IGST splitting and place-of-supply rules are not yet implemented.

---

## Reviewer sign-off

| Field | Entry |
|---|---|
| Reviewed by | |
| Date | |
| Sections passed | |
| Issues raised | |
