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

Web push is off until the server has a VAPID key pair. Generate one:

```sh
clickclack admin webpush keygen
```

It prints the two environment variables once. Put them in the server's
configuration, along with a contact address, and restart:

- `CLICKCLACK_WEBPUSH_VAPID_PUBLIC_KEY`
- `CLICKCLACK_WEBPUSH_VAPID_PRIVATE_KEY`
- `CLICKCLACK_WEBPUSH_SUBJECT`, a `mailto:` address or an `https` URL the push
  services can use to reach the operator. It defaults to `CLICKCLACK_PUBLIC_URL`.

Keep the private key like any other server secret. Rotating it invalidates
every registered device; each one re-registers the next time its owner opens
the app.

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

iOS 16.4 or later is required. Android and desktop browsers use the same
standard and work where the browser supports it.

## What the server sends

Each notification is a JSON payload under 3 KB, encrypted for one subscription:

```json
{ "title": "Ari in #general", "body": "the build is green", "tag": "clickclack:msg_...", "url": "/app/wsp_.../chn_..." }
```

The title matches the one an open tab shows, and the tag matches too, so a
device that both has the app open and receives a push shows one notification
rather than two. The body is truncated to 240 characters. Tapping the
notification focuses an open app window and routes it, or opens one.

Delivery happens off the request path in a small worker pool, so posting a
message never waits on a push service. The push service is called through the
same outbound policy as webhooks: no proxy, no redirects, and no destination
inside the deployment's own network.

Failures are handled by what the push service says:

- 404 or 410 means the subscription is dead. The row is deleted.
- Anything else, including 429, a 5xx, and a timeout, sets a backoff (one
  minute, then five, thirty, two hours, six, and a day at most, honoring a
  longer `Retry-After`). The row is never deleted for this: a relay outage must
  not cost users their devices. A success clears the backoff.

Log lines name the push service host, the user, and the failure. They never
contain an endpoint or a key: an endpoint's path is the device's delivery
secret.

## What is stored

One row per device in `user_push_subscriptions`: the endpoint, the two client
keys, a short device label, timestamps, the failure count and backoff, and the
session that registered it. `GET /api/me/push` returns only the label, the
timestamps, and the failure count. The endpoint and the keys never leave the
server, and a JSON export carries them because a restored backup needs them to
keep delivering.

A subscription follows its session. Signing out, a revoked session, or an
expired one stops that device receiving message text, even if the device never
unsubscribed.

## Endpoints

```http
GET    /api/me/push
PUT    /api/me/push/subscriptions
DELETE /api/me/push/subscriptions
```

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
