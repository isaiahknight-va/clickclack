# Web push evidence

Repeatable checks for the web push authorization and upgrade paths, run
against built binaries rather than unit fixtures. Neither writes message text,
emails, keys, tokens, or endpoints to its output.

## Send-time authorization

```sh
node scripts/web-push-evidence/authorization.mjs --out <dir>
```

Builds the server with `-tags clickclack_e2e_unsafe_callbacks` (the tag only
lets devices point at a loopback push service), serves it with development
authentication off, and signs users in through magic links minted by the admin
CLI. For each case it holds all four delivery workers on a fake push service,
posts a message so the recipient's push waits in the queue, then:

| case | what changes while the push waits |
| --- | --- |
| `control` | nothing |
| `session-revoked` | the recipient signs out |
| `subscription-deleted` | the recipient removes the device |
| `membership-removed` | the recipient's workspace membership row is deleted |

and releases the workers. The recipient's device must receive one push in the
control case and none in the others, each with a `web push delivery skipped`
line naming the reason. `summary.txt` holds the table; `server-webpush.log`
and `server.log` hold what the server printed. The run fails if a session
token, a sign-in token, or an endpoint appears in the server's output.
Requires `go`, `node`, and `sqlite3`.

## Upgrade from a release

```sh
scripts/web-push-evidence/upgrade.sh \
  --sqlite-snapshot <existing.db> \
  --postgres-admin-dsn 'postgres://user@host:port/postgres?sslmode=disable' \
  --out <dir> [--base v0.5.1]
```

Exports the release tag and `HEAD` with `git archive`, builds both, and copies
`upgradeevidence/evidence_test.go` into each tree so the same code questions
both versions. The snapshot is only read; the run upgrades a copy with the
head binary's `migrate`, then upgrades a second copy after the release has
turned Pushover on for every user, so a database whose users never set up
Pushover still exercises recipient selection. On PostgreSQL it creates a
throwaway database, migrates and seeds it with the release, upgrades it with
head, and drops it.

Each pass must show `user_notification_settings` and
`channel_notification_settings` unchanged in row count, contents hash, and
schema; `user_push_subscriptions` created and empty; and the same digest of
Pushover recipient selection (every message, with no mentions and with every
user mentioned, filtered by message access the way the dispatcher does) from
the release before the upgrade and from head after it, with web push off.
Requires `git`, `go`, `sqlite3`, `psql`, and `shasum`.

## First activation and key rotation on a real device

A headless browser will not issue a real push subscription, so these two need
a phone. The server logs make each step checkable.

1. Start the server with a VAPID pair and note the startup line
   `web push enabled: application server key <fingerprint>`.
2. On the phone, remove any existing home-screen install of the server, open
   it in the browser, add it to the Home Screen, open it from there, and sign
   in.
3. Open account settings, then Notifications, turn on
   "Push notifications on this device", and allow notifications. The switch
   must turn on at the first attempt, and the log must show
   `web push device registered for user <id> via <push service host>`.
4. From another account, post a message the user can read, with the app
   closed. The notification must arrive, and the log must show
   `web push delivered for user <id>`.
5. Rotate the pair: generate one with `clickclack admin webpush keygen`
   written straight into the server's configuration, and restart. The startup
   line must show a new fingerprint.
6. With the app still closed, post again. Nothing arrives: the phone's
   subscription belongs to the old key. The log shows the push service
   refusing it, as a `web push delivery failed` line or a
   `reports it is gone` line for the user.
7. Open the app from the Home Screen. The log must show
   `web push device removed by user <id>` followed by
   `web push device registered for user <id>`: the app found its subscription
   was made under the old key, replaced it, and removed the old row. A
   `web push device refreshed` line instead means the browser did not report
   the subscription's key, and the device kept the dead subscription.
8. Close the app and post again. The notification must arrive, with a
   `web push delivered` line.
