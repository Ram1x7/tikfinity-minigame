# LIVE Activity Overlay — production checklist

The existing gacha and roulette stay in `../display.html`. `overlay/combined.html` continues to embed both screens.

## New UI
- `overlay/display.html?demo=1&layout=full`: static demonstration (does not connect to production).
- `overlay/combined.html?env=prod&dk=DISPLAY_KEY_PROD`: production UI, alongside existing gacha and roulette.
- It contains one calendar (select a viewer), per-viewer likes top 5, latest gifts and comments. No streamer logo.
- Default layout is `full`. Use `layout=compact` to hide the calendar.

## Worker
`worker/dist/worker.js` is generated from the sources via `node scripts/build-worker.mjs`.
Manual Cloudflare deployment is necessary; merging GitHub alone does not update the deployed Worker.
Keep existing Worker secrets and endpoints unchanged.

- `POST /overlay/webhook?env=prod&k=WEBHOOK_KEY&type=attendance|like|comment|follow` collects engagement events.
- `POST /overlay/activity?env=prod` with `{"dk":"DISPLAY_KEY_PROD"}` returns private dashboard data.
- `POST /webhook` remains the existing gift lottery endpoint and now also records gift history (without interrupting lottery if activity storage fails).
- Firebase engagement data is stored at `envs/prod/overlay/private`; **do not grant any client-side read access** to this path. Existing `overlay/events` rules may remain unchanged.
- Attendee identity must be sent by TikFinity as `userId`, `username` or `uniqueId`; without it, viewer-specific activity cannot be calculated. Names/content cannot be fabricated.
- TikFinity comment payload must actually contain `comment`, `commentText`, `message`, or `text`. Otherwise the UI shows that the body was unavailable.
- `attendance` should use TikFinity's first-activity trigger rather than a repeated generic join, to record a unique calendar day.
- Recent activity is limited to 150 events, user attendance is limited to the last 366 days.

## Release
1. Run `node scripts/build-worker.mjs --check` and project tests.
2. Retain a backup of the current Cloudflare Worker and PRISM URL.
3. Deploy updated `worker/dist/worker.js` in Cloudflare and confirm existing gift gacha/roulette.
4. Verify Firebase rules deny anonymous read access to `overlay/private`.
5. Send an attendance, a like, a comment and a gift from TikFinity.
6. Confirm private activity data updates, and the combined PRISM display works with its current `dk` parameters.
7. Revert to previous Worker and URL if any problem appears.

**Do not paste the `dk` or `k` secrets into chat or screenshots.**
