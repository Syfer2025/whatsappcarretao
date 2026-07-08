# Users, Sectors, Connection Panel Design

## Goal

Add an admin-managed access area for company users, internal sectors, assignment-based conversation visibility, and a WhatsApp connection panel that shows status/QR only after admin login.

## Current State

- The app has `admins` and `vendors`.
- Vendors already have username/password and only see conversations assigned to their `vendors.id`.
- Admin can assign conversations to vendors.
- The login page currently polls `/api/status` and can show the WhatsApp QR code before login.
- Message bubbles currently label outgoing team messages generically instead of identifying which company user sent them.

## Decisions

### Access Rules

- Admin users can see all conversations, all users, all sectors, and connection controls.
- Company users/vendors can only see conversations assigned directly to their user id.
- Sector membership does not grant access to conversations.
- A user in sector `Vendas` cannot see every `Vendas` conversation unless the conversation is assigned directly to that user.

### Users

- Keep the existing `vendors` table as the company-user table to avoid unnecessary migration risk.
- In the admin UI navigation, list titles, modal titles, and action labels, show "Usuarios" instead of "Vendedores"; internal database/table names can remain `vendors`.
- Each user has:
  - name
  - username
  - password
  - active/inactive status
  - optional sector
- Password changes are admin-controlled.
- Inactive users cannot log in.

### Sectors

- Add a `sectors` table for internal organization.
- Each sector has:
  - id
  - name
  - active/inactive status
  - created/updated timestamps
- Each user can belong to one sector.
- Each conversation can optionally have one sector.
- Sectors are used for admin organization, filtering, and assignment context only.

### Conversation Assignment

- Admin can assign a conversation to a user.
- Admin can assign or change the conversation sector.
- The existing visibility rule remains: assigned user only.
- Conversation lists should show assigned user and sector for admin scanning.

### Message Sender Labels

- Team messages must identify the company user who sent them.
- In message bubbles, vendor/user messages should show:
  - `Vendedor Jackson` when the sender user name is Jackson
  - fallback `Vendedor` if no sender name is available
- For admin-sent messages, show `Admin` or the admin identity when available.
- The message content stays unchanged; this is a display label, not text inserted into WhatsApp message bodies.

### WhatsApp Connection Panel

- Remove WhatsApp QR/status display from `login.html`.
- `/api/status` must not expose QR data to unauthenticated requests.
- Add authenticated admin-only connection endpoints or protect `/api/status` behind admin auth when QR is requested.
- Admin panel includes a "Conexao" area showing:
  - connected/disconnected state
  - current state/error
  - importing status
  - last import summary
  - QR code when the WhatsApp session needs pairing
  - action to reimport history
  - action to reset WhatsApp session

### Reset WhatsApp Session

- Admin can request a WhatsApp session reset from the admin connection panel.
- Reset should:
  - destroy/logout the current WhatsApp client if possible
  - clear local QR/ready status
  - remove local auth session data
  - reinitialize the client so a new QR appears inside the admin panel
- Reset must not be exposed before login.

## Error Handling

- User creation must validate required fields and duplicate usernames.
- Sector creation must validate required name and duplicate names.
- Assigning a conversation to an inactive user should be rejected.
- Reset failures should return a clear admin-facing error message.
- If WhatsApp is disconnected, message sending should fail with a clear status instead of pretending it sent.

## Testing

- Schema tests for `sectors`, `vendors.sector_id`, and `conversations.sector_id`.
- API tests for:
  - admin creating/updating users
  - admin creating/updating sectors
  - duplicate username/sector validation
  - vendor cannot access unassigned or other assigned conversations
  - sector does not grant access
  - unauthenticated status does not expose QR
  - admin status can expose QR
- Query tests for message labels showing vendor names.
- HTML tests that:
  - login page has no QR/status polling
  - admin page has connection/users/sectors UI
  - vendor message labels include sender names.

## Out Of Scope

- Role-based permissions beyond admin vs user/vendor.
- Sector queues where everyone in a sector can see the same conversation.
- Multiple WhatsApp numbers.
- Audit log of every admin action.
