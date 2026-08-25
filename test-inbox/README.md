# ThunderSub test inbox

Run `bash test-inbox.sh` from the repository root. The launcher copies this
minimal offline profile to a temporary directory, installs the current build of
ThunderSub, and opens it in a separate Thunderbird instance. The temporary
profile is removed when Thunderbird exits; pass `--keep` to retain it.

The Inbox contains two synthetic subscriptions for reproducing the activity
queue failure. Queue the first unsubscribe, then queue the second during the
first request's eight-second delay. The buggy result is that the second activity
reports `Subscription is no longer available` after the first switches the UI
to Errors. Those two canonical messages remain unchanged in Local Folders. A
third `Error Subscription` message targets the same failure endpoint so the
error card and Activity details can be checked for HTTP status, status text, and
the complete plaintext response message. A fourth `JSON Error Subscription`
targets `/fail-json` and returns HTTP 422 Unprocessable Content with a structured
JSON body so non-plaintext diagnostics can be checked without losing fields. A
fifth `Email Error Subscription` uses a mailto unsubscribe method: leave
Auto-send disabled to verify draft creation, or enable Auto-send to exercise the
offline profile's email-send failure details.

The committed profile also contains Personal and Work inboxes with ten more
subscriptions and 83 emails, ranging from 1 to 20 messages per subscription.
Personal and Work each have a primary identity plus an alias so scans, filters,
batch actions, and per-identity move destinations can be tested across multiple
addresses and inboxes without generating mail at launch time.

The launcher starts a loopback-only HTTP server on port 8765. The first message
POSTs to `/fail`, which waits eight seconds and returns HTTP 503 Service
Unavailable with a plaintext diagnostic response. The second
POSTs to `/success`, which returns HTTP 200. `/fail-json` returns HTTP 422 with
an `application/json` diagnostic body. The launcher packages an explicitly
named test build that permits only literal loopback HTTP for this integration
test; production builds retain the normal local-URL protections.
