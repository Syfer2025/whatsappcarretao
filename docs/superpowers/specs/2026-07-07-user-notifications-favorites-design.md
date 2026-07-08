# User Notifications and Personal Favorites Design

## Context

The app already stores conversations and messages in SQLite, exposes admin and vendor views, polls `/api/conversations` every few seconds, and has a global message favorite mechanism using columns on `messages`.

The new requirement is to make notifications and favorites individual per logged-in user. A message read or favorited by one user must not affect another user's read state or favorites. Conversations should behave like WhatsApp: new activity moves the conversation to the top, open chats refresh with the new message at the bottom, and closed chats show an unread count.

## Goals

- Track unread notifications per user and per conversation.
- Mark a conversation as read only for the user who opens it.
- Store favorite messages per user, not globally on the message row.
- Keep admin and vendor visibility rules unchanged.
- Keep the current polling model for this iteration to reduce risk.
- Preserve existing favorite data where practical by migrating `messages.starred` rows into the new personal table.

## Non-Goals

- No external push notifications.
- No browser Notification API prompt in this iteration.
- No WebSocket/SSE real-time rewrite in this iteration.
- No changes to WhatsApp sending behavior.

## Data Model

Add `conversation_user_state`:

- `conversation_id`
- `user_role`
- `user_id`
- `last_read_message_id`
- `last_read_at`
- unique key on `conversation_id, user_role, user_id`

Add `message_stars`:

- `message_id`
- `user_role`
- `user_id`
- `created_at`
- unique key on `message_id, user_role, user_id`

Keep the existing `messages.starred` columns for backward compatibility, but read/write favorites through `message_stars`.

## API Behavior

`GET /api/conversations` returns the current user's visible conversations with:

- `last_message_preview`
- `last_message_at`
- `unread_count`
- ordering by latest message or `updated_at`, newest first

`GET /api/conversations/:id/messages` continues returning visible messages and includes `starred` calculated for the current user.

Add or update read-state endpoint:

- `POST /api/conversations/:id/read`
- marks the conversation read for the current user up to the latest visible message

`PATCH /api/messages/:id/star` writes to `message_stars` for the current user.

`GET /api/messages/starred` returns only messages favorited by the current user and still visible to that user.

## Incoming Messages

When a client message arrives:

- store the message as today
- update `conversations.updated_at`
- do not send any automatic customer reply
- unread counts increase implicitly for users who can see the conversation and have not read the latest message

For vendors, visibility is only assigned conversations. If an unassigned conversation later gets assigned, unread count is calculated from that vendor's own read state at the time they view it.

## UI Behavior

Admin and vendor conversation lists show:

- newest active conversation at the top
- unread badge beside each conversation when `unread_count > 0`
- last message preview in the list when available

When the current conversation is open:

- polling reloads messages for that chat
- the scroll moves to the bottom when new messages arrive
- the conversation is marked read for that user

When another conversation receives a message:

- the conversation moves to the top
- its unread badge updates for the current user

Favorites views keep the existing layout but read from per-user favorites.

## Error Handling

- If read-state update fails, the conversation still loads; the unread badge may remain until the next successful poll.
- If favorite toggle fails, keep the current UI state and surface the API error through the existing request path.
- If a user cannot access a conversation or message, return the existing `403` behavior.

## Testing

- Schema tests for `conversation_user_state` and `message_stars`.
- Query tests proving unread counts differ by user.
- Query tests proving favorites differ by user.
- API structure tests for the read endpoint.
- Frontend HTML tests proving unread badges, last-message preview, current-chat refresh, and read marking exist in both admin and vendor pages.

