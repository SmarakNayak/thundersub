# ATN Listing Kit — ThunderSub

Everything needed to submit ThunderSub to [addons.thunderbird.net](https://addons.thunderbird.net) (ATN).
Copy-paste the text blocks below into the corresponding fields of the submission form.

---

## Submission steps

1. Build the package: `bash build.sh` → `dist/thundersub-2.0.xpi`.
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

<b>🔍 Deep detection</b>
<ul>
<li>Reads the standard List-Unsubscribe header (RFC 2369) and supports one-click unsubscribe (RFC 8058).</li>
<li>Also finds unsubscribe links embedded in email bodies (HTML and plain text) when senders don't play by the rules — while skipping quoted and forwarded content.</li>
<li>Scans all accounts and folders, skipping Junk, Trash, Sent, Drafts, and Gmail's "All Mail" duplicates. Pause, resume, or stop long scans at any time.</li>
</ul>

<b>📬 Alias-aware</b>
Subscriptions are grouped by sender <i>and</i> receiving address: if a sender mails both your work address and your personal alias, you'll see both — because both need unsubscribing.

<b>✂️ Four ways out</b>
ThunderSub auto-picks the best available method: silent one-click POST, unsubscribe email (opens as a draft for review by default; auto-send is opt-in), or the sender's unsubscribe page in your browser. If a method fails, retry with any other detected one.

<b>🧹 Cleanup included</b>
Delete a sender's entire back catalog (to Trash, never permanently) or move it to any folder — with per-folder control over which copies are touched.

<b>🛟 Dry run by default</b>
Out of the box, every unsubscribe, delete, and move is simulated and reported without touching anything. Explore the whole workflow risk-free, then flip the toggle.

<b>🔒 Private by design</b>
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

## Screenshots (capture before submitting)

ATN strongly recommends screenshots. Suggested set, in order:

1. **Dashboard with pending cards** — the money shot: stats row + grid of subscription cards.
2. **Unsubscribe modal** — method line, folder checkboxes, delete/move/keep options.
3. **Scan in progress** — progress bar, live counters, Pause/Stop.
4. **Unsubscribed tab** — cards with Cleanup/Retry/Review Again, showing the workflow continues after unsubscribing.

Use a clean profile with believable demo newsletters; avoid real personal addresses in shots.

## Release notes for 2.0

```
Initial public release.
• Scan all accounts and folders for subscriptions (List-Unsubscribe headers + embedded links)
• One-click (RFC 8058), email, and browser unsubscribe methods with retry
• Alias-aware grouping by sender and receiving address
• Cleanup: delete to Trash or move emails per source folder
• Dry-run mode enabled by default
• Keep / dismiss / review-again workflow with stats dashboard
```

---

## Notes to reviewers (paste into "Notes to Reviewer" on upload)

```
Source is plain, unminified JavaScript with no build step and no third-party libraries — the uploaded XPI is the source (repo: https://github.com/SmarakNayak/thundersub).

License: MPL-2.0. Portions of the unsubscribe detection and unsubscribe methods in background.js are adapted from BetterUnsubscribe by Luc Bennett (MPL-2.0, https://github.com/LucBennett/BetterUnsubscribe), with attribution in the file header and README. ThunderSub is an independent add-on with a different scope (whole-mailbox scanning, review queue, cleanup).

Permission justifications:
- messagesRead: read headers/bodies to detect List-Unsubscribe headers and embedded unsubscribe links.
- messagesMove / messagesDelete: the optional cleanup actions (move to a user-chosen folder / delete to Trash; deletePermanently is never used).
- accountsRead / accountsFolders: enumerate accounts/folders for scanning and for the move-destination folder picker (browser.folders.create for the "new folder" option).
- compose / compose.send: prepare mailto: unsubscribe emails. They open as drafts by default; compose.sendMessage is only called if the user enables the explicit "auto-send" toggle.
- storage: persist scan results and user decisions locally.
- <all_urls>: RFC 8058 one-click unsubscribe requires a POST (fetch) to whatever HTTPS endpoint the sender's List-Unsubscribe header specifies, which cannot be known in advance. Requests are only made when the user clicks Unsubscribe.

No remote code is loaded or executed. innerHTML is used for UI rendering only, with all dynamic values passed through an HTML-escaping helper (esc() in tab/tab.js). No user data leaves the machine.

Testing tip: the add-on starts in dry-run mode — all actions are simulated and reported via toasts. Click the toolbar button → "Open ThunderSub" → "Scan Emails" against any profile with newsletter mail.
```
