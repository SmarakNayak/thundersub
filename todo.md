# ThunderSub — TODO

_No open items._

## Resolved
- **Where do delete/move (cleanup) failures land?** A cleanup failure is not an
  unsubscribe failure — the unsubscribe already succeeded. So:
  - Unsubscribe fails → **Errors**.
  - Unsubscribe succeeds but cleanup fails → **Unsubscribed**, emails left in
    place, with the **Cleanup** button available to retry.
  Implemented in the `tab.js` confirm handler (`handleCleanupFailure`).
