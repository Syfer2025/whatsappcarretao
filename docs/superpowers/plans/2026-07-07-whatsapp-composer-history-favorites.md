# WhatsApp Composer History Favorites Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add WhatsApp-like sending for text, emojis, images, video, audio, voice audio, and documents while making local SQLite history the source of truth and adding message favorites/search.

**Architecture:** SQLite remains the canonical history store. Outbound messages are inserted locally with delivery status, sent through `whatsapp-web.js`, then updated with WhatsApp IDs or failure details. The UI reads only local API data, while startup/manual sync only upserts recent WhatsApp data without deleting local history.

**Tech Stack:** Node.js, Express, better-sqlite3, whatsapp-web.js `MessageMedia`, vanilla HTML/CSS/JS.

---

### Task 1: Schema and Local History Metadata

**Files:**
- Modify: `schema.js`
- Modify: `schema.test.js`
- Modify: `historyImporter.js`
- Modify: `historyImporter.test.js`

- [ ] Add `delivery_status`, `delivery_error`, `sent_at`, `starred`, `starred_at`, `starred_by`, and `starred_by_role` to `messages`.
- [ ] Existing incoming/imported messages default to durable local records and do not disappear when WhatsApp import returns fewer messages.
- [ ] Tests prove new columns are created and old tables migrate.

### Task 2: Outbound Media Sender

**Files:**
- Create: `messageSender.js`
- Create: `messageSender.test.js`
- Modify: `server.js`

- [ ] Validate message payloads containing text and/or base64 media.
- [ ] Save outbound media under `/media`.
- [ ] Insert outbound messages as `pending`, send through WhatsApp, then update to `sent` with `external_id` or `failed` with error.
- [ ] Support `sendAudioAsVoice`, `sendMediaAsDocument`, captions, image/video/audio/document MIME types, and normal emoji text.

### Task 3: Favorites and Search API

**Files:**
- Modify: `server.js`
- Create: `messageQueries.test.js`

- [ ] Add `PATCH /api/messages/:id/star`.
- [ ] Add `GET /api/messages/starred`.
- [ ] Add optional `starred=1` and `q=` filters to conversation message retrieval.
- [ ] Enforce existing admin/vendor conversation access rules.

### Task 4: Admin/Vendor UI

**Files:**
- Modify: `frontend/admin.html`
- Modify: `frontend/vendor.html`

- [ ] Add attachment input, emoji quick picker, voice/document toggles, media preview, and send status rendering.
- [ ] Add star button per message.
- [ ] Add favorites view/search to find starred messages later.
- [ ] Keep UI local-first: reload messages from API after send/favorite changes.

### Task 5: Verification

**Files:**
- All touched files.

- [ ] Run `npm test`.
- [ ] Run `node --check` on changed JS files.
- [ ] Parse inline scripts from both HTML files with `vm.Script`.
- [ ] Start the server, verify `/api/status`, login, and API responses.
