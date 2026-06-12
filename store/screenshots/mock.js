/* Screenshot harness: stubs browser.runtime with demo data so the real,
 * unmodified tab UI (tab.html/tab.css/tab.js) can be rendered and captured
 * outside Thunderbird. Scenario is chosen via ?shot= query param.
 * Used only by store/screenshots/make.sh — never shipped in the xpi. */

'use strict';

const SHOT = new URLSearchParams(location.search).get('shot') || 'dashboard';
const NOW = Date.now();
const MIN = 60000, DAY = 86400000;

function iso(msAgo) { return new Date(NOW - msAgo).toISOString(); }
function ids(n) { return Array.from({ length: n }, (_, i) => i + 1); }

function sub(o) {
  const groups = o.groups || [['Personal', 'Inbox', o.emailCount]];
  return Object.assign({
    senderName: '', senderEmail: '', recipientAddress: 'alex@example.net',
    emailCount: 0, lastDate: iso(2 * DAY), sampleSubject: '',
    unsubUrls: [`https://unsubscribe.${(o.senderEmail || 'x@x').split('@')[1]}/u/d41d8cd98f`],
    oneClick: true, embeddedUrl: null, decision: 'pending', dispose: null,
    error: null, dismissed: false,
    messageGroups: groups.map(([accountName, folderName, n], i) => ({
      accountName, folderName, folderId: `f-${(o.senderEmail || 'x')}-${i}`,
      messageIds: ids(n), headerMessageIds: []
    }))
  }, o);
}

const SUBS = [
  // ── Pending ──
  sub({ senderName: 'Daily Tech Digest', senderEmail: 'newsletter@dailytechdigest.example',
    emailCount: 312, lastDate: iso(3 * 60 * MIN), sampleSubject: 'Issue #1,204: The GPU shortage is over (again)' }),
  sub({ senderName: 'FlightDeals', senderEmail: 'deals@flightdeals.example',
    emailCount: 184, lastDate: iso(9 * 60 * MIN), sampleSubject: 'Round-trip to Lisbon from $379 — this weekend only',
    unsubUrls: ['https://unsubscribe.flightdeals.example/u/abc123', 'mailto:unsub@flightdeals.example?subject=unsubscribe'],
    groups: [['Personal', 'Inbox', 142], ['Personal', 'Travel', 42]] }),
  sub({ senderName: 'Acme Store', senderEmail: 'offers@acmestore.example',
    recipientAddress: 'alex+deals@example.net', emailCount: 97, lastDate: iso(1 * DAY),
    sampleSubject: '48-hour flash sale: everything 30% off' }),
  sub({ senderName: 'Fitness Weekly', senderEmail: 'hello@fitnessweekly.example',
    emailCount: 64, lastDate: iso(2 * DAY), sampleSubject: 'Your 4-week summer training plan is here' }),
  sub({ senderName: 'The Recipe Box', senderEmail: 'chef@recipebox.example',
    emailCount: 51, lastDate: iso(3 * DAY), sampleSubject: '5 weeknight dinners under 30 minutes' }),
  sub({ senderName: 'DevJobs Alert', senderEmail: 'alerts@devjobs.example',
    emailCount: 45, lastDate: iso(12 * 60 * MIN), sampleSubject: '14 new Senior Backend roles near you',
    oneClick: false, unsubUrls: ['mailto:leave@devjobs.example'] }),
  sub({ senderName: 'City Events Guide', senderEmail: 'events@cityguide.example',
    emailCount: 38, lastDate: iso(4 * DAY), sampleSubject: 'This week: open-air cinema, food market, jazz night' }),
  sub({ senderName: 'CloudNotes', senderEmail: 'updates@cloudnotes.example',
    emailCount: 29, lastDate: iso(6 * DAY), sampleSubject: "What's new in CloudNotes 14",
    oneClick: false, unsubUrls: [], embeddedUrl: 'https://cloudnotes.example/email/preferences' }),
  sub({ senderName: 'Photo Monthly', senderEmail: 'editor@photomonthly.example',
    recipientAddress: 'alex+deals@example.net', emailCount: 17, lastDate: iso(11 * DAY),
    sampleSubject: 'The winners of our street photography contest' }),
  // ── Unsubscribed ──
  sub({ senderName: 'StreamBox', senderEmail: 'no-reply@streambox.example',
    decision: 'unsubscribed', dispose: 'delete', emailCount: 0, groups: [],
    lastDate: iso(5 * DAY), sampleSubject: 'New this month on StreamBox' }),
  sub({ senderName: 'MegaMart Offers', senderEmail: 'promo@megamart.example',
    decision: 'unsubscribed', dispose: 'move', emailCount: 88,
    groups: [['Personal', 'Archive/Newsletters', 88]],
    lastDate: iso(7 * DAY), sampleSubject: 'Weekly savings inside — up to 50% off' }),
  sub({ senderName: 'Daily Horoscope', senderEmail: 'stars@dailyhoroscope.example',
    decision: 'unsubscribed', dispose: 'keep', emailCount: 156,
    lastDate: iso(9 * DAY), sampleSubject: 'Your reading for today' }),
  sub({ senderName: 'Webinar Invites', senderEmail: 'events@webinarhub.example',
    decision: 'unsubscribed', dispose: 'delete', emailCount: 0, groups: [],
    lastDate: iso(14 * DAY), sampleSubject: 'Live tomorrow: Scaling your data pipeline' }),
  // ── Kept ──
  sub({ senderName: 'Open Source Weekly', senderEmail: 'digest@osweekly.example',
    decision: 'keep', emailCount: 120, lastDate: iso(1 * DAY), sampleSubject: 'OSW #312: curl turns 30' }),
  sub({ senderName: 'Cloud Invoice Receipts', senderEmail: 'billing@cloudhost.example',
    decision: 'keep', emailCount: 36, lastDate: iso(8 * DAY), sampleSubject: 'Your invoice for May 2026' }),
  sub({ senderName: 'Neighborhood Updates', senderEmail: 'news@neighborhood.example',
    decision: 'keep', emailCount: 22, lastDate: iso(2 * DAY), sampleSubject: 'Road closure on Elm St next week' })
];

const STATS = {
  emailsScanned: 48217,
  subscriptionEmails: SUBS.reduce((sum, s) => sum + s.emailCount, 0),
  total: SUBS.length,
  pending: SUBS.filter(s => s.decision === 'pending').length,
  kept: SUBS.filter(s => s.decision === 'keep').length,
  unsubscribed: SUBS.filter(s => s.decision === 'unsubscribed').length,
  error: SUBS.filter(s => s.decision === 'error').length,
  lastScanAt: iso(18 * MIN)
};

const SCANNING = {
  status: 'scanning', progress: 19438, total: 48217,
  folderProgress: 7, folderTotal: 18, currentFolder: 'Personal | Inbox',
  messagesScanned: 19438, sendersFound: 11, subscriptionEmailsFound: 614,
  message: 'Personal | Inbox',
  done: false, paused: false, stopped: false
};

// The scope shot shows a lived-in configuration (an excluded folder and
// skip patterns); every other shot keeps the default "all folders" scope.
const SCOPE = {
  accounts: [
    { accountId: 'a1', accountName: 'Personal', type: 'imap', scannable: true, folders: [
      { id: 'p-inbox', name: 'Inbox', subFolders: [] },
      { id: 'p-archive', name: 'Archive', subFolders: [
        { id: 'p-archive-news', name: 'Newsletters', subFolders: [] },
        { id: 'p-archive-receipts', name: 'Receipts', subFolders: [] }
      ] },
      { id: 'p-travel', name: 'Travel', subFolders: [] }
    ] },
    { accountId: 'a2', accountName: 'Work', type: 'imap', scannable: true, folders: [
      { id: 'w-inbox', name: 'Inbox', subFolders: [] },
      { id: 'w-projects', name: 'Projects', subFolders: [] }
    ] },
    { accountId: 'a3', accountName: 'News Feeds', type: 'rss', scannable: false, folders: [] }
  ],
  excludedAccountIds: [],
  excludedFolderIds: SHOT === 'scope' ? ['p-archive-news'] : [],
  skipSenders: SHOT === 'scope'
    ? ['phish@scamletter.example', 'megadeals.example', '*@*.trackster.example'] : []
};

globalThis.browser = {
  runtime: {
    onMessage: { addListener() {}, removeListener() {} },
    sendMessage(request) {
      switch (request.command) {
        case 'getDryRun': return Promise.resolve({ dryRun: false });
        case 'getAutoSendUnsubscribeEmails': return Promise.resolve({ autoSendUnsubscribeEmails: false });
        case 'getStats': return Promise.resolve(SHOT === 'scan'
          ? Object.assign({}, STATS, { lastScanAt: null }) : STATS);
        case 'getSubscriptions': {
          const f = request.filter;
          const list = SUBS.filter(s => !f || f === 'all' ? true : s.decision === f);
          return Promise.resolve(JSON.parse(JSON.stringify(list)));
        }
        case 'getScanStatus': return Promise.resolve(SHOT === 'scan'
          ? SCANNING
          : { status: 'idle', progress: 0, total: 0, message: '', done: false });
        case 'scan': return Promise.resolve({ ok: true });
        case 'getScanScope': return Promise.resolve(JSON.parse(JSON.stringify(SCOPE)));
        case 'getFolderTree': return Promise.resolve([]);
        default: return Promise.resolve({ ok: true });
      }
    }
  }
};

// Wait until the app has finished initializing (cards rendered, listeners
// attached) before driving the UI — the filter tabs exist in static HTML
// long before tab.js wires them up.
function clickWhenReady(selector, attempts = 50) {
  const ready = document.querySelector('.card');
  const el = ready && document.querySelector(selector);
  if (el) { el.click(); return; }
  if (attempts > 0) setTimeout(() => clickWhenReady(selector, attempts - 1), 100);
}

document.addEventListener('DOMContentLoaded', () => {
  if (SHOT === 'modal') {
    clickWhenReady('.card[data-sender-email="deals@flightdeals.example"] .js-open-modal');
  } else if (SHOT === 'unsubscribed') {
    clickWhenReady('.filter-tab[data-filter="unsubscribed"]');
  } else if (SHOT === 'scope') {
    clickWhenReady('#scan-scope-btn');
    // Once the modal's tree renders, expand Archive so the excluded
    // Newsletters subfolder (and the account tri-state) is visible.
    clickWhenReady('#scope-tree .tree-toggle[data-folder-id="p-archive"]');
  }
});
