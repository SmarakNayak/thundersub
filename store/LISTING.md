# ATN Listing Kit — ThunderSub

Everything needed to submit ThunderSub to [addons.thunderbird.net](https://addons.thunderbird.net) (ATN).
Copy-paste the text blocks below into the corresponding fields of the submission form.

---

## Submission steps

1. Build the package: `bash build.sh` → `dist/thundersub-<version>.xpi` (version comes from `manifest.json`).
2. Sign in at <https://addons.thunderbird.net> (create an account if needed), then go to
   **Tools → Developer Hub → Submit a New Add-on**.
3. Choose **"On this site"** (listed distribution — ATN hosts, signs, and serves updates automatically).
4. Upload the `.xpi`. The validator runs automatically; warnings are usually fine, errors block submission.
5. Fill in the listing fields using the copy below, upload the icon (`store/icon-128.png`) and screenshots.
6. Pick a license and submit. New add-ons get a human review — typically days, occasionally longer.
   Watch the email on your ATN account for reviewer questions.

Version updates later: Developer Hub → ThunderSub → **Upload New Version**. Bump `"version"` in
`manifest.json` first; ATN rejects re-used version numbers.

---

## Name

```
ThunderSub
```

(Do not call it "Thunderbird Sub…" — ATN trademark policy requires third-party add-ons to use the
form "X for Thunderbird", never "Thunderbird X". "ThunderSub" itself is fine.)

## Summary (max 250 characters)

```
Find every mailing list across all your accounts, unsubscribe with one click, and clean up the emails they left behind. Header + in-body link detection, alias-aware grouping, dry-run mode. 100% local — your mail never leaves Thunderbird.
```

(237 characters.)

## Description

ATN allows limited HTML (`<b> <i> <em> <strong> <ul> <ol> <li> <blockquote> <code> <a>`):

```html
<b>Take back your inbox.</b> ThunderSub scans every folder in your Thunderbird accounts, finds every mailing list you've ever been signed up to, and gives you one place to unsubscribe from all of them — and clean up the thousands of emails they left behind.

<b>Deep detection</b>
<ul>
<li>Reads the standard List-Unsubscribe header (RFC 2369) and supports one-click unsubscribe (RFC 8058).</li>
<li>Also finds unsubscribe links embedded in email bodies (HTML and plain text) in 13 languages (English, Dutch, German, French, Spanish, Italian, Portuguese, Polish, Swedish, Danish, Norwegian, Finnish, and Russian) when senders don't play by the rules — while skipping quoted and forwarded content.</li>
<li>Scans all accounts and folders, skipping Junk, Trash, Sent, Drafts, and Gmail's "All Mail" duplicates by default while keeping every folder selectable. Pause, resume, or stop long scans at any time, with live message-by-message progress.</li>
<li>Scan scope controls: untick whole accounts or folders (skip that giant archive backup), and skip known senders or entire domains (phish@spammer.com, spammer.com).</li>
</ul>

<b>Alias-aware</b>
Subscriptions are grouped by sender <i>and</i> receiving address: if a sender mails both your work address and your personal alias, you'll see both — because both need unsubscribing.

<b>Four ways out</b>
ThunderSub auto-picks the best available method: silent one-click POST, unsubscribe email (opens as a draft for review by default; auto-send is opt-in), or the sender's unsubscribe page in your browser. If a method fails, retry with any other detected one.

<b>Cleanup included</b>
Delete a sender's entire back catalog (to Trash, never permanently), move it to any folder — with per-folder control over which copies are touched — or mark phishing senders as junk to train your spam filter without ever contacting them.

<b>Safe by default</b>
Existing emails are kept on unsubscribe unless you choose otherwise. Senders without the standard unsubscribe header get a warning before you act, and one-click requests are only ever sent to validated public https endpoints. Want to explore risk-free first? Dry-run mode simulates every unsubscribe, delete, and move and reports what would have happened.

<b>Private by design</b>
All data stays in Thunderbird's local storage. No cloud service, no account, no telemetry. The only network requests are the unsubscribe actions you explicitly trigger. A Full Reset wipes everything ThunderSub stored.

Open source: <a href="https://github.com/SmarakNayak/thundersub">github.com/SmarakNayak/thundersub</a>
```

## Categories

Suggested (pick what the form offers closest to): **Privacy and Security**, **Message and News Reading**.

## Tags

```
unsubscribe, newsletter, mailing list, spam, inbox cleanup, privacy, email management
```

## Support / homepage

- Homepage: `https://github.com/SmarakNayak/thundersub`
- Support site: `https://github.com/SmarakNayak/thundersub/issues`

## License

Select **Mozilla Public License 2.0** in the ATN license picker. This matches the repo's `LICENSE`
file and is required: portions of the unsubscribe detection are adapted from BetterUnsubscribe
(MPL-2.0), so the derived code must remain under MPL-2.0.

## Privacy policy field

ThunderSub does not upload user data anywhere, so ATN does not require a privacy policy — but
filling the field builds trust:

```
ThunderSub does not collect, store, or transmit any user data. Scan results and your decisions are kept in Thunderbird's local extension storage on your machine only. The extension makes no network requests except the unsubscribe actions you explicitly trigger (an RFC 8058 one-click POST, or opening a sender's unsubscribe page in your browser). No telemetry, no analytics, no third-party services. The "Full Reset" button removes all locally stored data.
```

## Icon

Upload `store/icon-128.png` (rendered from `icons/icon-64.svg`; `store/icon-64.png` also available).

## Screenshots

Ready to upload from `store/screenshots/`, in this order, with these captions:

1. `01-dashboard.png` — "Every subscription across all your accounts in one place: scan results, email counts, and one-click review."
2. `02-unsubscribe-modal.png` — "Unsubscribe and clean up in one step: pick the method, then keep, move, or delete the sender's existing emails per folder."
3. `03-scan-progress.png` — "Scanning every folder with live progress — pause, resume, or stop at any time without losing results."
4. `04-unsubscribed.png` — "Track what you've unsubscribed from, retry with another method, or clean up leftover emails later."
5. `05-scan-scope.png` — "Control the scan: choose accounts and folders, and skip senders or whole domains before they're ever read."

They show the real tab UI (unmodified `tab/tab.html`/`tab.css`/`tab.js`) rendered with fictional
demo data (`.example` senders, `alex@example.net` recipient) — regenerate any time with
`bash store/screenshots/make.sh` (needs chromium or nix).

## Release notes (1.0.13)

```
Initial public release.

• Scan all accounts and folders for subscriptions (List-Unsubscribe headers + embedded unsubscribe links in 13 languages)
• Scan scope controls: choose which accounts and folders are scanned, and filter From or To addresses and whole domains
• One-click (RFC 8058), email, and browser unsubscribe methods, with retry via any detected method
• Cleanup actions to delete, move, or mark a sender's messages as Junk
• Keep a subscription while deleting or moving its existing emails
• Default unsubscribe cleanup setting to preselect Leave, Move, or Delete
• Alias-aware grouping by sender and receiving address
• Hardened against malicious senders: suspicious unsubscribe links are blocked before opening, one-click endpoints must use public HTTPS, email content is never rendered as HTML, and a warning appears before unsubscribing from senders without the standard unsubscribe header
• Safe defaults: existing emails are kept on unsubscribe unless you choose otherwise
• Optional dry-run mode to preview every action before it runs
• Keep / dismiss / review-again workflow with a stats dashboard
• Background Activity stack for unsubscribe and cleanup jobs, with progress, details, cancellation, and manual dismiss
• Live message-level progress with pause and cancellation for scans and cleanup operations

Compatible with Thunderbird 128 and later.
```

---

## Notes to reviewers (paste into "Notes to Reviewer" on upload)

```
Version 1.0.13 supersedes the pending 1.0 through 1.0.12 submissions. Please review 1.0.13 for the initial public release.

Source is plain, unminified JavaScript with no build step and no third-party libraries — the uploaded XPI is the source (repo: https://github.com/SmarakNayak/thundersub).

The background runs as an ES module via a background page (background.html): background.js imports the localized unsubscribe-wording list from unsub-detect.js (embedded unsubscribe links in 13 languages), the sender skip-pattern matcher from scan-scope.js, the unsubscribe URL safety gates from unsub-url.js, and account-ID-based junk-folder routing from junk-routing.js. All matching is local regex matching; no translation service or network involvement.

License: MPL-2.0. Portions of the unsubscribe detection and unsubscribe methods in background.js are adapted from BetterUnsubscribe by Luc Bennett (MPL-2.0, https://github.com/LucBennett/BetterUnsubscribe), with attribution in the file header and README. ThunderSub is an independent add-on with a different scope (whole-mailbox scanning, review queue, cleanup).

Permission justifications:
- messagesRead: read headers/bodies to detect List-Unsubscribe headers and embedded unsubscribe links.
- messagesUpdate: set the junk flag (messages.update({junk: true})) when the user picks "Mark all emails as junk", so the account's spam filter is trained before the messages are moved to the junk folder.
- messagesMove / messagesDelete: the optional cleanup actions (move to a user-chosen folder / delete to Trash; deletePermanently is never used).
- accountsRead / accountsFolders: enumerate accounts/folders for scanning and for the move-destination folder picker (browser.folders.create for the "new folder" option).
- compose / compose.send: prepare mailto: unsubscribe emails. They open as drafts by default; compose.sendMessage is only called if the user enables the explicit "auto-send" toggle.
- storage: persist scan results and user decisions locally.
- <all_urls>: RFC 8058 one-click unsubscribe requires a POST (fetch) to whatever HTTPS endpoint the sender's List-Unsubscribe header specifies, which cannot be known in advance. Requests are only made when the user clicks Unsubscribe. One-click URLs are limited to public HTTPS endpoints; browser-opened unsubscribe links may use HTTP or HTTPS. Both refuse localhost, private/reserved IP ranges, and internal hostnames (unsub-url.js).

No remote code is loaded or executed. The UI never uses innerHTML: all rendering goes through a createElement/textContent element builder (el() in tab/tab.js), so strings from emails can only become text nodes and are never parsed as HTML. No user data leaves the machine.

Testing tip: click the toolbar button -> "Open ThunderSub" -> "Scan Emails" against any profile with newsletter mail. Enabling the "Dry Run" toggle in the sidebar makes every action simulated and reported via toasts instead of executed.
```
