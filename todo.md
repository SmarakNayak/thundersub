# ThunderSub — TODO

## Open
1. **Retry on Unsubscribed/Errors tiles?** Should we add an explicit Retry
   action, or is "Review Again" (back to Pending → Unsubscribe) good enough?
2. **Unsubscribe method as a dropdown?** Make the method a dropdown of all
   available methods for a sender (one-click / email / browser / embedded)
   instead of auto-picking the "best" one. If so, does it belong in every modal
   or only the retry modal?

## Resolved
- **Where do delete/move (cleanup) failures land?** A cleanup failure is not an
  unsubscribe failure — the unsubscribe already succeeded. So:
  - Unsubscribe fails → **Errors**.
  - Unsubscribe succeeds but cleanup fails → **Unsubscribed**, emails left in
    place, with the **Cleanup** button available to retry.
  Implemented in the `tab.js` confirm handler (`handleCleanupFailure`).
