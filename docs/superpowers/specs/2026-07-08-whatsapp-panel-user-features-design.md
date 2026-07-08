# WhatsApp Panel User Features Design

## Goal

Add WhatsApp-like operational features while keeping all user-facing state scoped to the logged-in user. Admin and each vendor must have independent read/unread, pinned, muted, notification, draft, favorites, and typing behavior.

## Scope

Implement:
- Global search across visible conversations and messages.
- Loading older chat messages using the existing `before_id` pagination.
- Browser notifications per authenticated user, respecting access and mute state.
- Mark conversation as unread per user.
- Pin conversation per user.
- Open favorites at the exact starred message.
- Media filters for images, videos, audio, and documents.
- Multiple outbound attachments with improved previews.
- Typing indicators between panel users with conversation-level access checks.

Out of scope:
- Voice/video calls, Status, Channels, Communities, and native WhatsApp lifecycle features not exposed reliably by `whatsapp-web.js`.
- Native WhatsApp archive/mute/star synchronization. These features are internal to the panel unless explicitly sent through WhatsApp.

## Data Model

Extend `conversation_user_state` with per-user columns:
- `pinned_at DATETIME`
- `muted_until DATETIME`
- `marked_unread INTEGER DEFAULT 0`
- `draft_text TEXT`
- `draft_updated_at DATETIME`
- `typing_at DATETIME`

Keep `message_stars` as the per-user favorites store. Message media type already lives on `messages.media_type`.

## API

Add endpoints:
- `GET /api/search?q=&media_type=` returns visible conversations and messages for the logged-in user.
- `PATCH /api/conversations/:id/state` updates per-user `pinned`, `muted`, `marked_unread`, and `draft_text`.
- Existing `GET /api/conversations/:id/messages` accepts `before_id`, `limit`, and new `media_type`.
- Existing `GET /api/messages/starred` returns enough metadata for exact navigation.

## Realtime

Socket connections authenticate as existing users. The server stores socket user identity and joins each socket to a user room. Events:
- `conversation:updated` remains global, with clients filtering through their API permissions.
- `message:new` includes conversation ID and message ID.
- `typing:update` is emitted only to users who can access the conversation.
- `notification:new` is emitted only to users who can access the conversation and have not muted it.

## Frontend

Admin and vendor pages receive shared behavior, implemented locally in both files to match the current project style:
- Search box in sidebar with result rendering.
- Conversation action buttons for pin and mark unread.
- Message pagination button at top of chat.
- Media filter control in chat header.
- Multi-file selection and preview list.
- Favorite item opens the conversation and highlights the exact message.
- Browser Notification permission request and notification display.
- Typing status under the chat title and typing emission from the composer.

## Testing

Use Node's built-in test runner:
- Schema migration tests for new per-user state columns.
- Query tests proving state is isolated by user.
- Query tests for search, media filtering, pinned ordering, mark unread, and favorite target metadata.
- Structure tests for new routes and Socket.IO typing/notification events.
- Frontend static tests for search, pagination, notification, multi-file, exact favorite navigation, and typing UI.
