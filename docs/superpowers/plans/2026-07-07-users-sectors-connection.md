# Users Sectors Connection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add admin-managed users, internal sectors, assignment-only visibility, named sender labels, and an authenticated WhatsApp connection panel.

**Architecture:** Keep the existing `vendors` table as the company-user table and add `sectors` plus `sector_id` columns. Put admin CRUD and assignment rules in a small service module used by `server.js`; keep conversation access assignment-based in `messageQueries.js`. Move QR exposure to an admin-authenticated endpoint and remove QR polling from login.

**Tech Stack:** Node.js, Express, better-sqlite3, bcryptjs, jsonwebtoken, whatsapp-web.js, vanilla HTML/CSS/JS, node:test.

---

### Task 1: Schema And Admin Service

**Files:**
- Modify: `schema.js`
- Modify: `schema.test.js`
- Create: `adminServices.js`
- Create: `adminServices.test.js`

- [ ] Write failing schema tests for `sectors`, `vendors.sector_id`, and `conversations.sector_id`.
- [ ] Write failing admin service tests for creating/updating sectors, creating/updating users, rejecting duplicate names/usernames, and rejecting inactive assignees.
- [ ] Implement schema migrations and `adminServices.js`.
- [ ] Run `node --test schema.test.js adminServices.test.js`.

### Task 2: Message Sender Labels And Access Rules

**Files:**
- Modify: `messageQueries.js`
- Modify: `messageQueries.test.js`
- Modify: `frontend/admin.html`
- Modify: `frontend/vendor.html`

- [ ] Write failing tests that sector membership does not grant access and vendor messages include sender names.
- [ ] Join `vendors`/`admins` where useful and return `sender_label`.
- [ ] Render vendor labels as `Vendedor <nome>` with fallback `Vendedor`; admin messages show `Admin`.
- [ ] Run `node --test messageQueries.test.js frontendHtml.test.js`.

### Task 3: Server Endpoints

**Files:**
- Modify: `server.js`
- Modify: `frontendHtml.test.js`

- [ ] Add `/api/sectors` CRUD for admin.
- [ ] Update `/api/vendors` to use the service and include sectors/password updates.
- [ ] Update `/api/conversations/:id/assign` to accept `vendor_id` and `sector_id`.
- [ ] Make public `/api/status` omit QR data.
- [ ] Add admin-only `/api/admin/connection`, `/api/admin/import-history`, and `/api/admin/reset-whatsapp`.
- [ ] Run focused HTML/static tests and syntax checks.

### Task 4: Admin UI And Login UI

**Files:**
- Modify: `frontend/login.html`
- Modify: `frontend/admin.html`

- [ ] Remove login QR/status polling.
- [ ] Add admin tabs for `Usuarios`, `Setores`, and `Conexao`.
- [ ] Add user create/edit with sector, password, active state.
- [ ] Add sector create/edit.
- [ ] Add conversation sector selector.
- [ ] Add connection panel with status, QR, import, and reset action.
- [ ] Run `npm test`.

### Task 5: Runtime Verification

**Files:**
- Runtime only

- [ ] Run `node --check` for changed JS files.
- [ ] Restart `node server.js`.
- [ ] Verify `/api/status` has no QR and admin panel can fetch authenticated connection status.
- [ ] Verify server remains `READY`.
