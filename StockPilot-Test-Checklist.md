# StockPilot — Functional Verification Checklist

**System:** StockPilot Inventory Management
**Version:** P0 hardening + P1 features 1–9 + P2 features 1–6 + P3 features 1–4
**Prepared for:** Senior review
**Date:** 2 September 2026

---

## Purpose

This document lets a reviewer verify every shipped feature by hand, in order. Each test states what to do and what should happen. Tick the box when the observed result matches.

## Sections at a glance

| Sections | Covers | Interface |
|---|---|---|
| 1–12 | Core system (P0 + P1) | Full UI |
| 13–18 | Reservations, stock conditions, GST, sessions, audit log (P2) | Full UI |
| 19–22 | Purchase automation, analytics, forecasting, point of sale (P3) | Full UI |

Every section is now testable from the interface. Work through them in order.

## Before you start

| Requirement | Detail |
|---|---|
| Account | An ADMIN login. Some steps also need a STAFF login to verify permissions. |
| Data | At least two locations, one supplier, one customer, and three products. |
| GST | If your business is registered, set a **state code** in Settings first. Several sections depend on it. |
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
| 2.2a | **If your business has a state code set:** create a product leaving GST rate blank | Refused. "Not set" is not offered, and the form asks you to choose a rate | ☐ |
| 2.2b | Set the rate to **0%** and save | Accepted — nil-rated is a real answer | ☐ |
| 2.2c | Edit an older product that has no GST rate | You are asked for one before it will save | ☐ |
| 2.3 | Record a PURCHASE of 100 units at Location A | Stock at A becomes 100 | ☐ |
| 2.4 | Record a SALE of 30 units at Location A | Stock becomes 70 | ☐ |
| 2.5 | Attempt to sell 200 units | **Refused** — stock may never go negative | ☐ |
| 2.6 | Transfer 20 units from A to B | A becomes 50, B becomes 20; total unchanged | ☐ |
| 2.7 | Open the product's movement history | Every step above appears as a separate dated entry | ☐ |

> **Key principle:** stock is never stored as a number. It is the sum of all movements, and movements are never edited or deleted — corrections are added as new entries. This is what makes the history trustworthy.

> **Why 2.2a refuses rather than defaulting to 0%:** a blank rate and a 0% rate are different facts. Blank means nobody decided; 0% means the goods are nil-rated or exempt. If blank were treated as zero, the invoice would print "CGST @ 0%" — which on a tax document is a claim about the goods, not a note about an empty field. Businesses not registered for GST are never asked.

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
| 7.4 | Mark the damaged return received | **On hand rises**, but available does **not** — the units appear under Damaged | ☐ |
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

## 13. Reservations — stock a draft invoice is holding

Since P2, a **draft** invoice sets stock aside. The goods stay on the shelf and are still owned; they simply can't be promised to a second customer.

| # | Step | Expected result | ✓ |
|---|---|---|---|
| 13.1 | Note a product's **available** figure at a location | e.g. 50 available | ☐ |
| 13.2 | Create an invoice for 10 of that product and leave it as a **draft** | Saved; not issued | ☐ |
| 13.3 | Reopen the product | **On hand still 50**, but available now **40** — a blue "Reserved 10" band appears | ☐ |
| 13.4 | Try to sell 45 of that product directly from the Stock page | Refused, and the message says how much is reserved | ☐ |
| 13.5 | Issue the draft invoice | On hand drops to 40; reserved returns to 0 — the stock has actually left | ☐ |
| 13.6 | Create another draft for 5, then **cancel** it | Available returns to its previous figure; nothing stays held | ☐ |
| 13.7 | Create a draft for more units than exist | The draft still **saves**, holding only what was available | ☐ |
| 13.8 | Try to issue that draft | **Refused** — a draft may be optimistic, a sale may not | ☐ |

> **Key principle:** a draft is work in progress, not a promise. You can write up an order before the delivery that fills it arrives. Issuing is where the system says no.

---

## 14. Stock conditions — damaged, quarantine, expired

Stock can be **owned without being sellable**. A crushed box is still company property: it belongs in the valuation and a stocktake must find it — but no order should ever be filled from it.

| # | Step | Expected result | ✓ |
|---|---|---|---|
| 14.1 | Open a product with stock at a location | Shows "N available" | ☐ |
| 14.2 | Click **Change condition** | Dialog opens showing that location's quantities | ☐ |
| 14.3 | Move 3 units from **Available** to **Damaged**, with a reason | Saved | ☐ |
| 14.4 | Check the on-hand figure | **Unchanged** — nothing physically moved | ☐ |
| 14.5 | Check available | Down by 3; a red "Damaged 3" band appears | ☐ |
| 14.6 | Open the product's history | **Two** new ADJUSTMENT entries (−3 and +3), one tagged DAMAGED | ☐ |
| 14.7 | Move those 3 back from **Damaged** to **Available** | Bar returns to all-green; two more entries recorded | ☐ |
| 14.8 | Create a draft invoice reserving most of the stock, then try to quarantine more than the remainder | Refused — reserved goods are promised and can't be quarantined | ☐ |
| 14.9 | Sell a batch-tracked product that has a quarantined lot expiring soonest | The **quarantined lot is skipped**; stock comes from a good lot | ☐ |

> **Key principle:** conditions are never edited in place. Moving stock between conditions records two ledger entries with a name and time against them — so "these units sat in quarantine for a week" stays answerable.

---

## 15. Reporting — what you cannot sell

| # | Step | Expected result | ✓ |
|---|---|---|---|
| 15.1 | Damage some stock (test 14.3), then open **Reports** | A "Stock you can't sell" section appears | ☐ |
| 15.2 | Check the headline figure | Shows the **money value** tied up, not just a unit count | ☐ |
| 15.3 | Check the table | Lists the product with its quarantine / damaged / expired columns | ☐ |
| 15.4 | Return all stock to Available, reload | Section reads "Nothing blocked" | ☐ |
| 15.5 | Issue an invoice, then check the dashboard | Revenue, gross profit and margin update | ☐ |
| 15.6 | Reserve stock with a draft, then check low-stock warnings | Low stock is judged on **available** — a fully reserved shelf counts as low | ☐ |

---

## 16. GST invoicing

**Setup:** Settings → set your business **state code** (and GSTIN). Give one product an 18% rate.

| # | Step | Expected result | ✓ |
|---|---|---|---|
| 16.1 | Create an invoice, tick **GST invoice**, leave place of supply as your own state | Lines show **CGST + SGST**, each half the rate. A `CGST+SGST` badge appears by the invoice number | ☐ |
| 16.2 | Change place of supply to a different state, save | Tax switches to a single **IGST** line; badge changes to `IGST` | ☐ |
| 16.3 | Press **Save changes** on a GST draft | Tax figures are still shown afterwards — they must not vanish on save | ☐ |
| 16.4 | Override the rate on one line to 12%, save | That line uses 12%; the others keep the product rate | ☐ |
| 16.5 | Issue the invoice, then change the product's GST rate | The issued invoice is **unchanged** — tax was stamped at issue | ☐ |
| 16.6 | Print / PDF an inter-state invoice | Shows IGST only, never CGST/SGST | ☐ |
| 16.7 | Add a discount to a GST invoice | Discount is spread across lines **before** tax is calculated | ☐ |
| 16.8 | Raise an invoice **without** ticking GST | Uses the flat rate; no GST rows appear | ☐ |

> **Key principle:** tax is calculated once and written onto the invoice. An issued invoice is a legal document — if tax were recalculated on every view, changing a rate today would silently rewrite last year's invoices, and the customer's copy would stop matching yours.

> **Not claimed as GST compliance.** Reverse charge, composition scheme, e-way bills, e-invoicing/IRN, exports and SEZ, input-tax-credit matching and GSTR filing are **not** implemented.

---

## 17. Sessions and sign-in security

**Where:** Settings → Security panel.

| # | Step | Expected result | ✓ |
|---|---|---|---|
| 17.1 | Sign in on a second browser, then open Settings → Security | Both sessions are listed, with device and last-used time | ☐ |
| 17.2 | Sign out from the app | You return to login and cannot get back with the Back button | ☐ |
| 17.3 | Revoke the *other* browser's session, then use that browser | Within about 15 minutes it is signed out and must log in again | ☐ |
| 17.4 | Change your password | Every **other** device is signed out; the one you changed it on stays in | ☐ |
| 17.5 | Log in with the new password | Works. The old password no longer does | ☐ |

> **The 15-minute delay in 17.3 is deliberate**, not a bug. Access tokens are short-lived and checked without a database lookup; verifying every request against the database would make it a single point of failure for the whole system. Revocation takes effect at the next token refresh.

---

## 18. Audit trail

**Where:** Activity page.

| # | Step | Expected result | ✓ |
|---|---|---|---|
| 18.1 | Attempt a login with a wrong password, then check Activity | The **failed** attempt is recorded, with the email tried | ☐ |
| 18.2 | Change a product's selling price, then check Activity | Entry shows the **old and new** value, who changed it, and when | ☐ |
| 18.3 | Record a payment, cancel an invoice, reclassify stock | Each appears as its own entry | ☐ |
| 18.4 | Filter by date and by kind | Filters narrow the list correctly | ☐ |
| 18.5 | Search the log for any password | Nothing — passwords are never recorded | ☐ |
| 18.6 | Attempt an action that fails (e.g. oversell) | **No** log entry is written — the record and the event succeed or fail together | ☐ |

> Ordinary stock movements are **deliberately not** duplicated here: the stock ledger is already permanent and unedited, so it is its own audit trail.

---

## 19. Purchase automation

**Where:** Reports → Reorder suggestions.

**Setup:** put at least two products below their reorder level, each with a **preferred supplier** set, plus one below level with **no** supplier.

| # | Step | Expected result | ✓ |
|---|---|---|---|
| 19.1 | Open Reports → Reorder suggestions | Short shelves are listed **per location**, not merged across the company | ☐ |
| 19.2 | Press **Create draft orders** | One order per supplier — not one per product | ☐ |
| 19.3 | Open a generated order | Status is **DRAFT**. It has not been sent anywhere | ☐ |
| 19.4 | Check the product with no preferred supplier | Listed under **Not ordered**, with the reason | ☐ |
| 19.5 | Check a product short at two locations | Appears as **one line**, quantities added together | ☐ |
| 19.6 | Move a generated order to ORDERED yourself | Works normally — this is the only way an order reaches a supplier | ☐ |

> **Key principle: the system never places an order.** It cannot — the generator has no way to create anything but a draft. A human always decides what is actually bought. It also refuses to guess a supplier: choosing one for you would be inventing a commercial relationship.

---

## 20. Advanced analytics

**Where:** Analytics page. Default range is the last 3 months.

| # | Step | Expected result | ✓ |
|---|---|---|---|
| 20.1 | Open Analytics | Turnover, dead stock, ABC and trends all load | ☐ |
| 20.2 | Read the turnover card | Shows opening → closing stock value so the ratio can be checked by hand | ☐ |
| 20.3 | Look for a "—" instead of a number | Wherever a figure is missing, a **reason** is printed beside it | ☐ |
| 20.4 | Check dead stock | Products never sold are marked **NEVER SOLD**, separately from merely slow ones | ☐ |
| 20.5 | Check the dead-stock total | Shows money tied up, sorted with the most expensive first | ☐ |
| 20.6 | Check ABC with fewer than 10 selling products | Refuses to classify, and says why — products are still ranked | ☐ |
| 20.7 | Switch ABC to **By quantity** | Ranking re-sorts by units instead of revenue | ☐ |
| 20.8 | Check the trend badges | A small change reads **Steady**, not a percentage; a short range reads **Unclear** | ☐ |
| 20.9 | Change the date range and Apply | Turnover, ABC and trends update. Dead stock does **not** — it ignores the range by design | ☐ |

> **Key principle: every figure may answer "I don't know".** A turnover ratio from two weeks of data, or an ABC classification of four products, looks exactly like a real measurement and is not one. A blank prompts a question; a wrong number ends one.

---

## 21. Demand forecasting

**Where:** Analytics → Demand forecast (top of the page).

| # | Step | Expected result | ✓ |
|---|---|---|---|
| 21.1 | Open the forecast | The advisory notice appears above the table, before any number | ☐ |
| 21.2 | Check a product with little sales history | No forecast; the reason says how much history exists | ☐ |
| 21.3 | Check the headline counts | "Not enough history" is shown as a headline figure, not hidden in the rows | ☐ |
| 21.4 | Check a product with steady sales | Shows predicted demand, a per-day rate, and days of cover | ☐ |
| 21.5 | Check **Consider ordering** where stock is plentiful | Reads **enough** — never a negative number | ☐ |
| 21.6 | Check the **Basis** column | States how many days the product sold on, out of how many | ☐ |
| 21.7 | Reload the page | Figures recompute; nothing was saved to be acted on later | ☐ |
| 21.8 | Look for any button that acts on a forecast | **There is none.** To buy anything you raise a purchase order yourself | ☐ |

> **Key principle: a forecast is the only number here describing something that has not happened**, and it arrives looking exactly like a measurement. It writes nothing, orders nothing, and changes no stock. Suggested quantities also do **not** allow for supplier lead time — the system does not record it, and the notice says so.

---

## 22. Point of sale (the till)

**Where:** Till (POS).

| # | Step | Expected result | ✓ |
|---|---|---|---|
| 22.1 | Open the till and add a product by name | Appears in the basket at the **catalogue** price | ☐ |
| 22.2 | Scan the same item twice (or add it twice) | One line with quantity 2 — not two lines | ☐ |
| 22.3 | Take payment with **Cash tendered** left blank | Sale completes; invoice marked PAID | ☐ |
| 22.4 | **Check Stock for that product** | Down by exactly the quantity sold | ☐ |
| 22.5 | Open the invoice from the receipt | An ordinary invoice with an `INV-` number, in the same number sequence as typed invoices | ☐ |
| 22.6 | Ring a sale with cash **above** the total | Receipt shows **Change** to hand back. The payment recorded equals the bill, not the cash tendered | ☐ |
| 22.7 | Ring a sale with cash **below** the total | Recorded as a part payment; balance still owing | ☐ |
| 22.8 | Tick **Put on account** and complete | Stock still moves; invoice is ISSUED and unpaid, and appears in outstanding balances | ☐ |
| 22.9 | Try to sell more than you hold | Refused — exactly as an invoice would be | ☐ |
| 22.10 | Tick **GST invoice** with a product that has no rate | Warning appears **immediately**, naming the product; the button is disabled | ☐ |
| 22.11 | Tick **GST invoice** with rated products | Sale completes; the invoice shows CGST/SGST or IGST correctly | ☐ |
| 22.12 | Check Reports → profitability after a till sale | The sale appears in revenue **and** cost of goods sold | ☐ |

> **Key principle: the till is not a second system.** It creates an ordinary invoice, issues it through the ordinary path, and records an ordinary payment. That is why 22.4, 22.5, 22.9 and 22.12 pass without anything being written twice — and why every rule added to invoicing in future applies to the counter automatically.

---

## Known limitations

These are recorded deliberately and are not defects to be raised:

1. **The till reports unsellable stock at the payment moment, not at scan time.** A batch-tracked product whose batch pool is empty fails when you press *Take payment*, after the basket is built. The GST equivalent was moved earlier (22.10); this one needs a per-location stock lookup for every basket line, and is outstanding.
2. **No screens yet** for Goods Receipt creation outside a purchase order, or for supplier return editing after sending.
3. **Expired stock is reported, not written off automatically.** Nothing changes condition on a schedule — a person decides. This is intentional: stock quietly reclassifying itself overnight would be harder to explain than to prevent.
4. **Access tokens remain valid for up to 15 minutes after a session is revoked.** Checking every request against the database would make it a single point of failure for the whole system; the short lifetime is the trade.
5. **Forecasts ignore supplier lead time.** The system does not record how long a supplier takes, so a suggested quantity covers the forecast horizon only. Order earlier than it suggests if a supplier is slow.
6. **Historical stock is valued at today's average cost** in the turnover figure. Adequate for a ratio; it is not a basis for a balance sheet, and the report says so on screen.
7. **The point of sale is online-only.** There is no offline queue. A sale that cannot reach the server has not happened — and the operator is told immediately rather than discovering at closing time that a queue never drained.
8. **Accounting integration is not implemented** and was explicitly out of scope.

---

## Reviewer sign-off

| Field | Entry |
|---|---|
| Reviewed by | |
| Date | |
| Sections passed | |
| Issues raised | |
