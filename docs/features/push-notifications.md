---
read_when:
  - enabling or debugging phone notifications
  - changing web push storage, delivery, or the service worker
---

# Push notifications

ClickClack delivers notifications to a phone or a desktop browser over standard
Web Push (RFC 8030, RFC 8291, RFC 8292). The browser's own push service carries
the message, so a self-hosted server needs no account anywhere and no mobile
app: the user installs ClickClack to their home screen and flips one switch.

This is the third notification path, beside the in-page alerts a tab shows and
[Pushover](../configuration.md). Each is independent, and the per-channel
`all` / `mentions` / `muted` preference in
[Channel notifications](channel-notifications.md) governs all of them.

## Turning it on as an operator

Web push takes three settings. They are documented on this page, not in the
[configuration reference](../configuration.md):

- `CLICKCLACK_WEBPUSH_VAPID_PUBLIC_KEY` (config file key `webpush_vapid_public_key`)
- `CLICKCLACK_WEBPUSH_VAPID_PRIVATE_KEY` (config file key `webpush_vapid_private_key`)
- `CLICKCLACK_WEBPUSH_SUBJECT` (config file key `webpush_subject`), a `mailto:`
  address or an `https` URL the push services can use to reach the operator.
  It defaults to `CLICKCLACK_PUBLIC_URL`.

Web push is off until the server has a VAPID key pair. Generate one:

```sh
clickclack admin webpush keygen
```

It prints the two key variables once. Put them in the server's configuration,
along with the subject, and restart.

Keep the private key like any other server secret. Rotating it invalidates
every registered device; each one re-registers the next time its owner opens
the app. The app compares the key its subscription was made under with the
server's current key, and replaces a subscription made under the old one. At
startup the server logs a short fingerprint of the configured public key
(`web push enabled: application server key ...`), so a rotation is visible in
the log, followed by a `registered` line as each device returns.

With no key pair configured, `GET /api/me/push` reports `enabled: false`, the
settings row is hidden, the write endpoints answer 404, and no subscription is
ever stored.

## Turning it on as a user

1. Open the server in the phone's browser and sign in.
2. Add ClickClack to the Home Screen from the Share menu. On iOS this step is
   required: a Safari tab cannot subscribe to push, only an installed app can.
3. Open ClickClack from the Home Screen. It is a separate app with its own
   cookie jar, so sign in again there.
4. Open account settings, then Notifications, and turn on
   "Push notifications on this device".
5. Allow notifications when the browser asks.

The switch is per device. A user with a phone and a laptop turns it on in each,
and the account keeps up to ten devices; registering an eleventh drops the
oldest.

Deleting the Home Screen app deletes its storage, so a reinstalled app is a
fresh opt-in: turn the switch on again. A key rotation, by contrast, heals on
the next open without the user doing anything.

iOS 16.4 or later is required. Android and desktop browsers use the same
standard and work where the browser supports it.

## What the server sends

Each notification is a JSON payload under 3 KB, encrypted for one subscription:

```json
{ "title": "Ari in #general", "body": "the build is green", "tag": "clickclack:msg_...", "url": "/app/wsp_.../chn_..." }
```

The title matches the one an open tab shows, including "ClickClack" in place of
an author with no name, and the tag matches too, so a
device that both has the app open and receives a push shows one notification
rather than two. The body is truncated to 240 characters.

Tapping the notification lands at the conversation's newest message whether
or not the app is open:

- With an app window open, the service worker focuses it and posts it the
  URL. The window routes to the conversation, waits for its messages to load,
  and jumps to the newest one.
- With no app window open, the service worker opens one at the URL with
  `?from=push` added. On start the app removes the mark, routes to the
  conversation, waits for its messages to load, and jumps to the newest one.
  The mark travels in the URL because a message posted to a window that is
  still starting can arrive before the app is listening.

Delivery happens off the request path in a small worker pool, so posting a
message never waits on a push service. A push can wait in that queue behind a
slow push service, so it is checked again immediately before it is sent: the
device must still be registered to the recipient, under a session that is
still live, with any backoff elapsed, and the recipient must still be able to
read the message, which must not have been deleted. A push that fails any of these is dropped with one log line
naming the reason, and nothing is sent. The push service is called through the
same outbound policy as webhooks: no proxy, no redirects, and no destination
inside the deployment's own network.

Failures are handled by what the push service says:

- 404 or 410 means the subscription is dead. The row is deleted.
- Anything else, including 429, a 5xx, and a timeout, sets a backoff (one
  minute, then five, thirty, two hours, six, and a day at most, honoring a
  longer `Retry-After`). The row is never deleted for this: a relay outage must
  not cost users their devices. A success clears the backoff. The failure is
  recorded on its own deadline, so a push service that used the whole send
  timeout still gets its backoff.

Log lines name the push service host, the user, and what happened: a device
registered, refreshed, or removed; a push delivered, skipped and why, or
failed. They never contain an endpoint or a key: an endpoint's path is the
device's delivery secret.

## What is stored

One row per device in `user_push_subscriptions`: the endpoint, the two client
keys, a short device label, timestamps, the failure count and backoff, and the
session that registered it. `GET /api/me/push` returns only the label, the
timestamps, and the failure count for each device, plus whether the asking
browser is one of them. The endpoint and the keys never leave the server.

A database-level backup preserves device registrations: `clickclack backup`
for SQLite, or the operator's own PostgreSQL dump. A JSON export does not. It
leaves `user_push_subscriptions` out entirely, and it redacts session tokens,
which a restored registration would need in order to follow its session.
After restoring from a JSON export, each device registers again the next time
its owner opens the app.

A subscription follows its session. Signing out, a revoked session, or an
expired one stops that device receiving message text, even if the device never
unsubscribed. Every registration needs a session to follow: a browser session
cookie, or, behind Cloudflare Access, the session the Access assertion creates
for that request. Only the loopback development identity may register without
one; any other caller is refused with `403`.

## Endpoints

```http
GET    /api/me/push
PUT    /api/me/push/subscriptions
DELETE /api/me/push/subscriptions
```

`GET` takes an optional `device` query: the unpadded base64url SHA-256 of the
endpoint the browser holds. The answer's `this_device` is true when that
digest matches one of the user's devices, and false when it matches none or
no device is named. The settings switch reads on only when it is true.

`PUT` takes the browser's subscription (`endpoint` and the `p256dh` and `auth`
keys) plus a short `user_agent` label, and replaces any existing registration
for the same endpoint. The endpoint must be an `https` URL at a public host;
the client keys are rejected unless the public key is a point on P-256 and the
auth secret is 16 bytes. `DELETE` takes an endpoint and is idempotent.

## Privacy

Message text leaves the server encrypted for one device under RFC 8291. The
push service sees ciphertext, the endpoint, the signed application server
token, and the timing. It cannot read the message. A self-hoster who chose
ClickClack to keep chat off other people's servers should still know that the
existence and timing of a notification is visible to Apple, Google, or Mozilla,
depending on the browser.

## Known limits

- The server does not know what the phone is looking at, so a message in a
  channel the user is currently reading in the installed app still raises a
  notification.
- The service worker shows notifications and nothing else. It installs no fetch
  handler and caches nothing, so releases behave exactly as they do without it.
- Permission and subscriptions belong to an origin. Moving the server to a
  different hostname ends both, and every device has to opt in again.
- The desktop app shows its own notifications and hides this switch.
- A browser holds one push subscription for every account signed in on it, and
  the server keeps that device for the account that registered it last; for
  that account it is a new registration. On a device several accounts use,
  the switch reads on only for the account the server delivers to on this
  device, even when another account has devices elsewhere, and opening the
  app as an account that turned push on there moves the device back to it.
  Turning the switch off on a shared device unsubscribes the browser, so every
  account on that device stops receiving until one turns it on again.
- When the browser replaces a subscription on its own, the service worker does
  not register the replacement, because it cannot tell which account on the
  device turned push on. It asks an open app window to re-register, and only
  an account that turned push on there does. If the app is closed when this
  happens, the device re-registers the next time the app opens and receives
  nothing until then.
