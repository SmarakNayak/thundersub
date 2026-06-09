# ThunderSub — TODO

## Resolved
1. **Retry on Error tiles + move Dismiss to a garbage-can icon.**
   - Add a **Retry** action to Error tiles that re-opens the unsubscribe modal
     in place (no Pending round-trip).
   - Move **Dismiss** out of the button row into a **garbage-can icon top-right**
     of the tile (for dismissable tiles: Unsubscribed + Error). This declutters
     the row, so it can hold up to ~4 buttons cleanly without crowding —
     e.g. Error: View / Cleanup / Retry / Review Again, with the trash icon as a
     visually-separate 5th action.
   - Tile action sets:
     - **Error:** View / Cleanup / Retry / Review Again + trash icon
     - **Unsubscribed:** View / Cleanup / Review Again + trash icon
       (no Retry — only Error tiles get Retry)
2. **Unsubscribe method dropdown.** Keep auto-best as the default selection
   everywhere. Lead with a dropdown of all available methods (one-click / email /
   browser / embedded) in the **retry** modal so a failed one-click can be
   retried via another method. In the first-time modal, keep the `via:` line;
   optionally make it click-to-expand into the same dropdown. Verify we store
   multiple methods per sender (`unsubUrls` + `embeddedUrl`) — else the dropdown
   often has one entry.
3. **Subscription list controls.**
   - Filter tiles by receiving address.
   - Sort tiles by email count or most recent email.

- **Where do delete/move (cleanup) failures land?** A cleanup failure is not an
  unsubscribe failure — the unsubscribe already succeeded. So:
  - Unsubscribe fails → **Errors**.
  - Unsubscribe succeeds but cleanup fails → **Unsubscribed**, emails left in
    place, with the **Cleanup** button available to retry.
  Implemented in the `tab.js` confirm handler (`handleCleanupFailure`).
