# PWA + push notifications — setup

The CRM is now a Progressive Web App (PWA). It can be installed on phones, tablets, and desktops, and supports push notifications for time-sensitive events.

This doc covers the one-time setup steps needed before push notifications work, plus how install + permission flows look from the user's perspective.

## One-time setup

### 1. Run the database migration

Open Supabase SQL Editor → paste the contents of `migrations/2026-05-03-add-user-push-subscriptions.sql` → click Run.

This creates the `user_push_subscriptions` table that stores each device's push subscription keys.

### 2. Add three Vercel environment variables

Go to vercel.com → hnc-crm project → Settings → Environment Variables. Add:

| Name | Value | Environment |
|---|---|---|
| `VAPID_PUBLIC_KEY` | `BKv-MYk2wY2qpqNPcG19y9nrJYF2YoTDrZQRx-YIp8iSqimnhcqwQdvEge-6h7eMewrJ9GEywmqINw8DpFzNQW4` | Production, Preview, Development |
| `VAPID_PRIVATE_KEY` | `p8M7K4D9Exr6hT980k64HRVkTjRPdbj_vU4ppo1Xh_0` | Production, Preview, Development |
| `VAPID_SUBJECT` | `mailto:dane@hawaiinaturalclean.net` | Production, Preview, Development |

These are VAPID keys — VAPID is the Web Push standard's identity protocol, used by browsers to verify push messages came from us and not a random attacker. The public key is also exposed via `/api/vapid-public-key` for the frontend; the private key stays server-side.

After adding the env vars, **redeploy the project** (or trigger any commit) so the functions pick up the new variables.

### 3. (Optional) verify the setup

Visit `https://hnc-crm.vercel.app/api/vapid-public-key` in your browser. You should see:

```json
{ "key": "BKv-MYk2wY2..." }
```

If you get `{ "error": "VAPID_PUBLIC_KEY not configured" }`, the env var didn't take. Recheck Vercel settings.

## How install + push works for users

### iPhone (Safari)

1. User opens `book.hawaiinaturalclean.com` (or the CRM URL) in Safari
2. After ~2.5 seconds an install banner appears at the bottom: *"Install HNC CRM — Tap the Share button below, then Add to Home Screen."*
3. User taps Share → Add to Home Screen → Add
4. App icon appears on home screen
5. User opens app from home screen (this is critical — iOS only allows push notifications for PWAs launched from the home screen, not from inside Safari)
6. After login, a second banner appears: *"Get notified about lead replies — Enable / Not now"*
7. User taps Enable → iOS shows the OS-level permission prompt → user allows
8. Notifications now fire to that device whenever the backend sends them

### Android (Chrome)

1. User opens the URL in Chrome
2. Either the install banner appears with *"tap menu → Install app"*, OR Chrome shows its own native install prompt at the bottom
3. User installs via either method
4. Open the installed app
5. After login, "Enable notifications" banner appears → user allows → done

### Desktop (Chrome / Edge / Brave)

1. User opens the URL
2. Browser shows a small install icon in the address bar (usually right side)
3. User clicks → Install
4. App opens in its own window (no browser chrome)
5. Notifications work the same way

### Safari (macOS)

Safari on macOS supports Web Push since macOS Ventura. Process is similar to Chrome.

## What notifications fire today

After this setup is complete, push notifications fire when:

- **A lead replies and AI classifies it as lost** with medium or high confidence → all subscribed devices get a notification *"Sharon replied — mark as lost?"* with the SMS quoted and the AI's confidence level. Tapping the notification opens the Tasks page where you can hit Mark as lost or Not lost.

This is the only event wired up so far. To add more:

- New lead form submission
- Cleaner cancellations
- Same-day bookings
- Payment received

…each one is just an `import { sendPushToAllSubscribed } from './utils/send-push.js'` and a one-line call inside the existing endpoint. Coming in subsequent commits as we decide which events are worth notifications.

## Troubleshooting

### "Notifications enabled" toast appeared but I'm not getting pushes

Check the user's `user_push_subscriptions` row exists:

```sql
select id, user_agent, created_at, last_used_at
from user_push_subscriptions
where user_id = '<the user's UUID>';
```

If no row → registration failed silently. Check Vercel function logs for `/api/register-push-subscription` errors.

If row exists but no notifications:
- Test by hitting `/api/openphone-webhook` directly with a synthetic payload (see existing diagnostic notes)
- Check Vercel logs for `[openphone-webhook] Push fanout: {...}` — this tells you sent/removed/errors counts
- If `removed > 0`, the user's subscription went stale (uninstalled / cleared browser data). User needs to re-enable in the CRM.

### iOS PWA: notifications not arriving even after granting permission

iOS Web Push has a few known requirements:
- App must be installed via Add to Home Screen (not just a Safari tab)
- App must be opened from the home screen icon at least once after install
- iOS 16.4 or later
- Notification permission must be granted (Settings → HNC CRM → Notifications)

If all of those are true and pushes still aren't arriving, the subscription might have invalid keys. Have the user disable notifications via `window.hncDisableNotifications()` in the console, then re-enable.

### Service worker not updating after a deploy

Bump the `SW_VERSION` constant in `service-worker.js` and redeploy. The browser only refetches the SW if its bytes have changed.

For aggressive recovery: have the user navigate to `chrome://serviceworker-internals` (Chrome) or Safari Develop menu → Service Workers, find the HNC CRM entry, and click Unregister. Next page load will pick up the latest SW.

## Cost

Web Push is free (uses Apple's APNs / Google's FCM under the hood, exposed via the standard Web Push protocol). VAPID auth is free. Storage is one row per device per user — negligible.

## Security

- The private VAPID key never leaves the server. Anyone with it could impersonate us to push services, but they couldn't send pushes to user devices without also having the device-specific subscription endpoints.
- Subscriptions are tied to Supabase user IDs. RLS prevents users from reading/writing other users' subscriptions; only the service role (used by webhooks/crons) can fan out across users.
- The `endpoint` URL contains a randomized device-specific token. It's not personally identifying on its own, but treat the table as containing PII just to be safe.

## Files involved

- `manifest.json` — PWA manifest
- `service-worker.js` — push handler, install/activate lifecycle
- `icons/` — PWA icon set
- `api/register-push-subscription.js` — register/unregister endpoint
- `api/vapid-public-key.js` — exposes public key to frontend
- `api/utils/send-push.js` — shared helper for sending pushes (use this from any backend endpoint)
- `migrations/2026-05-03-add-user-push-subscriptions.sql` — schema
- Frontend bootstrap + subscription flow lives in `index.html` (search for `pwaBootstrap` and `hncMaybePromptForPush`)
