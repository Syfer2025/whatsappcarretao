# WhatsApp Panel User Features Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-user WhatsApp-like panel features for search, pagination, notifications, unread/pin state, exact favorites, media filters, multi-attachment sending, and typing indicators.

**Architecture:** Extend the existing SQLite state tables and message query helpers, expose small Express routes for per-user state and search, and add Socket.IO events scoped by authenticated user and conversation access. Update both existing HTML frontends in place because the current project has no shared frontend bundle.

**Tech Stack:** Node.js, Express, Socket.IO, better-sqlite3, vanilla HTML/CSS/JS, node:test.

---

### Task 1: Schema and query behavior

- [ ] Add failing tests for new `conversation_user_state` columns, per-user pin/unread/mute/draft behavior, media filtering, exact favorite metadata, and global search.
- [ ] Implement schema migration and query helpers.
- [ ] Run `node --test schema.test.js messageQueries.test.js`.

### Task 2: HTTP and realtime API

- [ ] Add failing structure tests for `/api/search`, `/api/conversations/:id/state`, media filters, typing events, and notification events.
- [ ] Implement routes and Socket.IO helpers with access checks.
- [ ] Run `node --test serverStructure.test.js messageQueries.test.js`.

### Task 3: Admin and vendor UI

- [ ] Add failing frontend static tests for search, older messages, browser notifications, pin/unread actions, exact favorite navigation, media filters, multi-file previews, and typing indicators.
- [ ] Update `frontend/admin.html` and `frontend/vendor.html`.
- [ ] Run `node --test frontendHtml.test.js`.

### Task 4: Verification

- [ ] Run `npm run lint && npm test`.
- [ ] Restart the local server.
- [ ] Verify `/health`, `/admin.html`, and `/api/status`.
