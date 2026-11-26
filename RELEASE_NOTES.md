Version 1.1.2 — Quick Review and workflow update.

Unsubscribe page checking (unsub-page.js, background.js, tab.js)

Unsubscribe pages are classified as confirmed, action needed, failed or unclear.
Pages that need input or can’t unsubscribe you leave the tab open and mark the card Needs input. The emails are left untouched.
There is a new Needs input filter tab with its own badge and shortcut (4, with Errors moved to 5).
A Close confirmed unsubscribe tabs setting closes tabs once the page confirms the unsubscribe. It is on by default.
An opt-in Auto-fill my email on unsubscribe pages setting types the address the email was sent to into simple forms and submits them. It skips captchas, surveys and multi-field forms.
A confirmation pattern was added for the geo-blocked “offer not available in your country” page.

Moving from one email to the next
fixed when you are in quick select, and move the arrow to the right, it skips and when at the end of the row, goes down to the next row at the beginning.

Scanning

A Scan for new messages on startup toggle was added.
The first run starts a scan automatically, and only the first run.
Scan scope now has separate From and To skip filters, and the matcher is generalized to addresses (scan-scope.js).

Quick Review

Quick Review is now on by default through a one-time switch. After that, your own choice is respected.
A Select button with a number field (default 200) was added before “Unsubscribe selected”.
The retry dialog has a method dropdown and help text, so you can pick a different unsubscribe method.

Other

junk-routing.js was added to find the junk folder through the message’s source folder and account. Account name is only a fallback.
The English unsubscribe wording match was tightened so words like “unsubscribed” no longer match.
Unsubscribe URLs now go through the safety gate in unsub-url.js. One-click requests are https only, and neither kind of URL may point at private or internal hosts.

Version 1.1.1 — Quick Review and workflow update.

- Added keyboard-first navigation and contextual shortcuts across every review list
- Added a floating keyboard-shortcut reference that stays available while reviewing
- Added Quick Review multi-select with matching batch-action buttons
- Added instant unsubscribe and batch cleanup using the saved cleanup default
- Added per-identity default move destinations, including folder creation
- Added batch retry, review again, view, spam, dismiss, keep, and cleanup actions
- Added clearer unsubscribe destinations and failure details to review cards
- Improved the Activity feed, cancellation, and safe Full Reset handling

Compatible with Thunderbird 128 and later.
