'use strict';

// Set to true to route delete/archive through test functions (no emails touched)
const TEST_DELETE = true;

// ── State ────────────────────────────────────────────────────────────────────
let scanState = {
  status: 'idle',
  progress: 0,
  total: 0,
  messagesScanned: 0,
  sendersFound: 0,
  message: '',
  done: false,
  paused: false,
  stopped: false
};

// ── Storage helpers ──────────────────────────────────────────────────────────
async function loadSubscriptions() {
  const result = await browser.storage.local.get('subscriptions');
  return result.subscriptions || [];
}

async function saveSubscriptions(subs) {
  await browser.storage.local.set({ subscriptions: subs });
}

// ── Parsing helpers ──────────────────────────────────────────────────────────
function extractUnsubUrls(raw) {
  if (!raw) return [];
  const urls = [];
  const re = /<([^>]+)>/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const u = m[1].trim();
    if (u) urls.push(u);
  }
  return urls;
}

function parseFromHeader(fromVal) {
  if (!fromVal) return { name: '', email: '' };
  const m = fromVal.match(/^(.*?)\s*<([^>]+)>\s*$/);
  if (m) {
    return {
      name: m[1].trim().replace(/^"|"$/g, ''),
      email: m[2].trim().toLowerCase()
    };
  }
  if (fromVal.includes('@')) {
    return { name: '', email: fromVal.trim().toLowerCase() };
  }
  return { name: fromVal.trim(), email: '' };
}

// ── Recipient address extraction ─────────────────────────────────────────────
function parseRecipientAddress(fullMessage) {
  // delivered-to is most reliable (added by the receiving mail server per-address)
  const deliveredTo = fullMessage.headers && fullMessage.headers['delivered-to'];
  if (deliveredTo && deliveredTo[0]) {
    const parsed = parseFromHeader(deliveredTo[0].split(',')[0].trim());
    if (parsed.email) return parsed.email;
  }
  // Fall back to To header
  const to = fullMessage.headers && fullMessage.headers['to'];
  if (to && to[0]) {
    const parsed = parseFromHeader(to[0].split(',')[0].trim());
    if (parsed.email) return parsed.email;
  }
  return '';
}

// ── Embedded unsubscribe link detection ──────────────────────────────────────
const UNSUB_REGEX = /\bun\W?subscri(?:be|bing|ption)\b/i;
const URL_REGEX = /https?:\/\/[^\s"'<>]{1,1000}/g;

function findEmbeddedUnsubLink(messagePart) {
  if (!messagePart) return null;
  const htmlLink = findEmbeddedLinkHTML(messagePart);
  if (htmlLink) return htmlLink;
  return findEmbeddedLinkText(messagePart);
}

function findEmbeddedLinkHTML(part) {
  if (part.parts) {
    for (const sub of part.parts) {
      const result = findEmbeddedLinkHTML(sub);
      if (result) return result;
    }
  }
  if (!part.body || part.contentType !== 'text/html') return null;

  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(part.body, 'text/html');
    const links = doc.querySelectorAll('a[href]');

    for (const link of links) {
      const text = link.textContent || '';
      const href = link.getAttribute('href') || '';
      if (UNSUB_REGEX.test(text) && href.startsWith('http')) {
        return href;
      }
    }
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      if (UNSUB_REGEX.test(walker.currentNode.textContent)) {
        let el = walker.currentNode.parentElement;
        for (let depth = 0; depth < 5 && el; depth++) {
          if (el.tagName === 'A' && el.href && el.href.startsWith('http')) {
            return el.href;
          }
          const siblingLink = el.querySelector('a[href^="http"]');
          if (siblingLink) return siblingLink.href;
          el = el.parentElement;
        }
      }
    }
  } catch (e) { /* DOM parsing failed */ }
  return null;
}

function findEmbeddedLinkText(part) {
  const body = extractTextBody(part);
  if (!body) return null;

  const unsubMatches = [...body.matchAll(new RegExp(UNSUB_REGEX, 'gi'))];
  if (unsubMatches.length === 0) return null;

  const urlMatches = [...body.matchAll(URL_REGEX)];
  if (urlMatches.length === 0) return null;

  let bestUrl = null;
  let bestDist = 300;
  for (const um of unsubMatches) {
    for (const urlm of urlMatches) {
      const dist = Math.abs(um.index - urlm.index);
      if (dist < bestDist) {
        bestDist = dist;
        bestUrl = urlm[0];
      }
    }
  }
  return bestUrl;
}

function extractTextBody(part) {
  if (part.body && part.contentType === 'text/plain') return part.body;
  if (part.parts) {
    for (const sub of part.parts) {
      const result = extractTextBody(sub);
      if (result) return result;
    }
  }
  return null;
}

// ── Folder collection ────────────────────────────────────────────────────────
async function collectAllFolders(account) {
  const results = [];

  async function walk(folders) {
    for (const folder of folders) {
      if (folder.type === 'junk' || folder.type === 'trash') continue;
      results.push(folder);
      try {
        const subFolders = await browser.folders.getSubFolders(folder, false);
        if (subFolders && subFolders.length > 0) {
          await walk(subFolders);
        }
      } catch (e) { /* Some folders may not support subfolders */ }
    }
  }

  if (account.folders && account.folders.length > 0) {
    await walk(account.folders);
  }
  return results;
}

// ── Message group helpers ────────────────────────────────────────────────────
//
// messageGroups is an array of:
//   { accountName, folderName, messageIds }
//
// Simple (accountName, folderName) keying for delete/archive scope.
// Unsub data lives at the top level of each subscription.

function addToMessageGroups(groups, accountName, folderName, msgId) {
  let group = groups.find(g => g.accountName === accountName && g.folderName === folderName);
  if (!group) {
    group = { accountName, folderName, messageIds: [] };
    groups.push(group);
  }
  group.messageIds.push(msgId);
}

function getIdsForFolders(groups, selectedFolders) {
  if (!selectedFolders || selectedFolders.length === 0) {
    return groups.flatMap(g => g.messageIds);
  }
  return groups
    .filter(g => selectedFolders.some(f => f.accountName === g.accountName && f.folderName === g.folderName))
    .flatMap(g => g.messageIds);
}

function removeGroupsForFolders(groups, selectedFolders) {
  if (!selectedFolders || selectedFolders.length === 0) return [];
  return groups
    .filter(g => !selectedFolders.some(f => f.accountName === g.accountName && f.folderName === g.folderName));
}

function totalMessageCount(groups) {
  return groups.reduce((sum, g) => sum + g.messageIds.length, 0);
}

// ── Scanner ──────────────────────────────────────────────────────────────────
async function runScan() {
  scanState = { status: 'scanning', progress: 0, total: 0, messagesScanned: 0, sendersFound: 0, message: 'Loading accounts...', done: false };

  try {
    const accounts = await browser.accounts.list();
    const allFolders = [];

    for (const account of accounts) {
      const folders = await collectAllFolders(account);
      for (const f of folders) {
        allFolders.push({ folder: f, accountName: account.name });
      }
    }

    scanState.total = allFolders.length;
    scanState.message = `Scanning ${allFolders.length} folders...`;

    // Accumulate by (senderEmail, recipientAddress) — the atomic subscription unit
    const subs = {};

    for (let i = 0; i < allFolders.length; i++) {
      const { folder, accountName } = allFolders[i];
      scanState.progress = i + 1;
      scanState.message = `Folder ${i + 1} of ${allFolders.length}: ${accountName} | ${folder.name}`;

      if (scanState.stopped) break;

      try {
        let page = await browser.messages.list(folder);

        pageLoop:
        while (page && page.messages && page.messages.length > 0) {
          for (const m of page.messages) {
            while (scanState.paused && !scanState.stopped) {
              await new Promise(r => setTimeout(r, 200));
            }
            if (scanState.stopped) break pageLoop;
            try {
              const full = await browser.messages.getFull(m.id);
              if (!full || !full.headers) continue;

              const listUnsub = full.headers['list-unsubscribe'];
              let urls = [];
              let oneClick = false;
              let embeddedUrl = null;
              let hasMailto = false;
              let hasHttp = false;

              if (listUnsub && listUnsub.length > 0) {
                urls = extractUnsubUrls(listUnsub[0]);
                oneClick = !!(full.headers['list-unsubscribe-post'] &&
                              full.headers['list-unsubscribe-post'].length > 0);
                hasMailto = urls.some(u => u.startsWith('mailto:'));
                hasHttp = urls.some(u => u.startsWith('http'));
              }

              if (urls.length === 0) {
                embeddedUrl = findEmbeddedUnsubLink(full);
                if (!embeddedUrl) continue;
              }

              scanState.messagesScanned++;

              const { name, email } = parseFromHeader(m.author);
              if (!email) continue;

              const recipientAddress = parseRecipientAddress(full);
              const key = `${email}|${recipientAddress}`;

              if (!subs[key]) {
                subs[key] = {
                  senderName: name,
                  senderEmail: email,
                  recipientAddress,
                  emailCount: 0,
                  lastDate: '',
                  sampleSubject: '',
                  unsubUrls: [],
                  oneClick: false,
                  hasMailto: false,
                  hasHttp: false,
                  embeddedUrl: null,
                  messageGroups: []
                };
              }

              const s = subs[key];
              s.emailCount++;
              const dateStr = m.date ? new Date(m.date).toISOString() : '';
              if (dateStr && (!s.lastDate || dateStr > s.lastDate)) {
                s.lastDate = dateStr;
                s.sampleSubject = m.subject || '';
              }
              if (name && !s.senderName) s.senderName = name;

              // Merge unsub data at top level
              for (const u of urls) {
                if (!s.unsubUrls.includes(u)) s.unsubUrls.push(u);
              }
              if (oneClick) s.oneClick = true;
              if (hasMailto) s.hasMailto = true;
              if (hasHttp) s.hasHttp = true;
              if (embeddedUrl && !s.embeddedUrl) s.embeddedUrl = embeddedUrl;

              addToMessageGroups(s.messageGroups, accountName, folder.name, m.id);
              scanState.sendersFound = Object.keys(subs).length;
            } catch (e) {
              // Skip individual messages that fail
            }
          }

          if (page.id) {
            try { page = await browser.messages.continueList(page.id); }
            catch (e) { break; }
          } else {
            break;
          }
        }
      } catch (e) {
        console.warn(`Failed to scan folder ${folder.name}:`, e);
      }
    }

    // Merge with existing stored subscriptions (preserve decisions)
    const existing = await loadSubscriptions();
    const existingMap = {};
    for (const sub of existing) {
      const k = `${sub.senderEmail}|${sub.recipientAddress || ''}`;
      existingMap[k] = sub;
    }

    const now = new Date().toISOString();
    const merged = [];

    for (const [key, s] of Object.entries(subs)) {
      const prev = existingMap[key];

      // Cap message IDs per group to avoid storage bloat
      const cappedGroups = s.messageGroups.map(g => ({
        ...g,
        messageIds: g.messageIds.slice(0, 100)
      }));

      merged.push({
        senderEmail: s.senderEmail,
        senderName: s.senderName,
        recipientAddress: s.recipientAddress,
        emailCount: s.emailCount,
        lastDate: s.lastDate,
        sampleSubject: s.sampleSubject,
        unsubUrls: s.unsubUrls,
        oneClick: s.oneClick,
        hasMailto: s.hasMailto,
        hasHttp: s.hasHttp,
        hasEmbedded: !!s.embeddedUrl,
        embeddedUrl: s.embeddedUrl,
        messageGroups: cappedGroups,
        decision: (prev && (prev.decision === 'keep' || prev.decision === 'unsubscribed'))
          ? prev.decision : 'pending',
        dispose: prev ? prev.dispose : null,
        updatedAt: now
      });
    }

    for (const prev of existing) {
      const k = `${prev.senderEmail}|${prev.recipientAddress || ''}`;
      if (!subs[k]) {
        merged.push(prev);
      }
    }

    await saveSubscriptions(merged);

    const finalMessagesScanned = scanState.messagesScanned;
    const finalSendersFound = Object.keys(subs).length;
    const wasStopped = scanState.stopped;

    scanState = {
      status: 'done',
      progress: wasStopped ? scanState.progress : allFolders.length,
      total: allFolders.length,
      messagesScanned: finalMessagesScanned,
      sendersFound: finalSendersFound,
      message: wasStopped ? 'Scan interrupted.' : 'Scan complete.',
      done: true,
      paused: false,
      stopped: false
    };

  } catch (e) {
    console.error('Scan error:', e);
    scanState = { status: 'idle', progress: 0, total: 0, message: `Error: ${e.message}`, done: false };
  }
}

// ── Unsubscribe methods ──────────────────────────────────────────────────────

async function unsubOneClick(url) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'List-Unsubscribe=One-Click'
  });
  return { ok: resp.ok, status: resp.status };
}

async function unsubMail(mailtoUrl) {
  const parsed = new URL(mailtoUrl);
  const to = parsed.pathname;
  const subject = parsed.searchParams.get('subject') || 'unsubscribe';
  const body = parsed.searchParams.get('body') || 'Please unsubscribe me from your mailing list. Thank you.';

  let identityId = null;
  try {
    const accounts = await browser.accounts.list();
    for (const account of accounts) {
      const identities = await browser.identities.list(account.id);
      if (identities && identities.length > 0) {
        identityId = identities[0].id;
        break;
      }
    }
  } catch (e) { /* Fall through */ }

  const details = { to, subject, body };
  if (identityId) details.identityId = identityId;

  const composeTab = await browser.compose.beginNew(details);
  const result = await browser.compose.sendMessage(composeTab.id, { mode: 'sendNow' });

  if (!result || typeof result.headerMessageId === 'undefined') {
    throw new Error('Failed to send unsubscribe email');
  }
  return { ok: true, to };
}

async function unsubWeb(url) {
  await browser.windows.openDefaultBrowser(url);
  return { ok: true };
}

async function unsubEmbedded(url) {
  await browser.windows.openDefaultBrowser(url);
  return { ok: true };
}

// ── Delete / Move ────────────────────────────────────────────────────────────
//
// selectedFolders: [{accountName, folderName}, ...] — which source folders to act on (all if empty)

async function deleteEmails(senderEmail, recipientAddress, selectedFolders) {
  const subs = await loadSubscriptions();
  const sub = subs.find(s => s.senderEmail === senderEmail && s.recipientAddress === recipientAddress);
  if (!sub || !sub.messageGroups || sub.messageGroups.length === 0) {
    return { deleted: 0 };
  }

  const ids = getIdsForFolders(sub.messageGroups, selectedFolders);
  if (ids.length === 0) return { deleted: 0 };

  let deleted = 0;
  const batchSize = 50;
  for (let i = 0; i < ids.length; i += batchSize) {
    const batch = ids.slice(i, i + batchSize);
    try {
      await browser.messages.delete(batch, false);
      deleted += batch.length;
    } catch (e) {
      console.warn('Failed to delete batch:', e);
    }
  }

  sub.messageGroups = removeGroupsForFolders(sub.messageGroups, selectedFolders);
  sub.emailCount = totalMessageCount(sub.messageGroups);
  await saveSubscriptions(subs);

  return { deleted };
}

async function moveEmails(senderEmail, recipientAddress, selectedFolders, destinationFolderId) {
  const subs = await loadSubscriptions();
  const sub = subs.find(s => s.senderEmail === senderEmail && s.recipientAddress === recipientAddress);
  if (!sub || !sub.messageGroups || sub.messageGroups.length === 0) {
    return { moved: 0 };
  }

  const ids = getIdsForFolders(sub.messageGroups, selectedFolders);
  if (ids.length === 0) return { moved: 0 };

  let moved = 0;
  const batchSize = 50;
  for (let i = 0; i < ids.length; i += batchSize) {
    const batch = ids.slice(i, i + batchSize);
    try {
      await browser.messages.move(batch, destinationFolderId);
      moved += batch.length;
    } catch (e) {
      console.warn('Failed to move batch:', e);
    }
  }

  sub.messageGroups = removeGroupsForFolders(sub.messageGroups, selectedFolders);
  sub.emailCount = totalMessageCount(sub.messageGroups);
  await saveSubscriptions(subs);

  return { moved };
}

// ── Other actions ────────────────────────────────────────────────────────────
async function setDecision(senderEmail, recipientAddress, decision, dispose) {
  const subs = await loadSubscriptions();
  const sub = subs.find(s => s.senderEmail === senderEmail && s.recipientAddress === recipientAddress);
  if (!sub) throw new Error('Subscription not found');

  sub.decision = decision;
  sub.dispose = dispose || null;
  sub.updatedAt = new Date().toISOString();
  await saveSubscriptions(subs);
}

async function getStats() {
  const subs = await loadSubscriptions();
  return {
    total: subs.length,
    pending: subs.filter(s => s.decision === 'pending').length,
    kept: subs.filter(s => s.decision === 'keep').length,
    unsubscribed: subs.filter(s => s.decision === 'unsubscribed').length
  };
}

async function getSubscriptions(filter) {
  const subs = await loadSubscriptions();
  let filtered = subs;
  if (filter && filter !== 'all') {
    filtered = subs.filter(s => s.decision === filter);
  }
  filtered.sort((a, b) => b.emailCount - a.emailCount);
  return filtered;
}

// ── Test functions for delete/move (no TB APIs, logs + updates storage) ──────

async function testDeleteEmails(senderEmail, recipientAddress, selectedFolders) {
  const subs = await loadSubscriptions();
  const sub = subs.find(s => s.senderEmail === senderEmail && s.recipientAddress === recipientAddress);
  if (!sub || !sub.messageGroups || sub.messageGroups.length === 0) {
    return { deleted: 0 };
  }

  const ids = getIdsForFolders(sub.messageGroups, selectedFolders);
  const folderDesc = selectedFolders && selectedFolders.length
    ? selectedFolders.map(f => `${f.accountName}/${f.folderName}`).join(', ')
    : 'all';
  console.log(`[TEST] Would DELETE ${ids.length} emails from ${sub.senderName || ''} <${senderEmail}> → ${recipientAddress} | folders=${folderDesc}`);

  sub.messageGroups = removeGroupsForFolders(sub.messageGroups, selectedFolders);
  sub.emailCount = totalMessageCount(sub.messageGroups);
  await saveSubscriptions(subs);

  return { deleted: ids.length };
}

async function testMoveEmails(senderEmail, recipientAddress, selectedFolders, destinationFolderId) {
  const subs = await loadSubscriptions();
  const sub = subs.find(s => s.senderEmail === senderEmail && s.recipientAddress === recipientAddress);
  if (!sub || !sub.messageGroups || sub.messageGroups.length === 0) {
    return { moved: 0 };
  }

  const ids = getIdsForFolders(sub.messageGroups, selectedFolders);
  const folderDesc = selectedFolders && selectedFolders.length
    ? selectedFolders.map(f => `${f.accountName}/${f.folderName}`).join(', ')
    : 'all';
  console.log(`[TEST] Would MOVE ${ids.length} emails from ${sub.senderName || ''} <${senderEmail}> → ${recipientAddress} | folders=${folderDesc} → dest=${destinationFolderId}`);

  sub.messageGroups = removeGroupsForFolders(sub.messageGroups, selectedFolders);
  sub.emailCount = totalMessageCount(sub.messageGroups);
  await saveSubscriptions(subs);

  return { moved: ids.length };
}

// ── Folder tree / creation / view ────────────────────────────────────────────

async function getFolderTree() {
  const accounts = await browser.accounts.list();
  const tree = [];

  for (const account of accounts) {
    const accountNode = { accountId: account.id, accountName: account.name, folders: [] };

    async function walkFolders(tbFolders) {
      const result = [];
      for (const f of tbFolders) {
        if (f.type === 'junk' || f.type === 'trash') continue;
        const node = { id: f.id, name: f.name, path: f.path, type: f.type || '', subFolders: [] };
        try {
          const children = await browser.folders.getSubFolders(f, false);
          if (children && children.length > 0) {
            node.subFolders = await walkFolders(children);
          }
        } catch (e) { /* skip */ }
        result.push(node);
      }
      return result;
    }

    if (account.folders && account.folders.length > 0) {
      accountNode.folders = await walkFolders(account.folders);
    }
    tree.push(accountNode);
  }

  return tree;
}

async function createFolderCmd(parentFolderId, folderName) {
  const folder = await browser.folders.create(parentFolderId, folderName);
  return { id: folder.id, name: folder.name, path: folder.path };
}

async function viewSubscription(senderEmail, recipientAddress) {
  const subs = await loadSubscriptions();
  const sub = subs.find(s => s.senderEmail === senderEmail && s.recipientAddress === recipientAddress);
  if (!sub || !sub.messageGroups || sub.messageGroups.length === 0) {
    throw new Error('No messages found');
  }

  // Find the folder with the most messages
  let bestGroup = sub.messageGroups[0];
  for (const g of sub.messageGroups) {
    if (g.messageIds.length > bestGroup.messageIds.length) bestGroup = g;
  }

  // Resolve folder ID
  const accounts = await browser.accounts.list();
  let folderId = null;
  for (const account of accounts) {
    if (account.name !== bestGroup.accountName) continue;
    const folders = await collectAllFolders(account);
    const found = folders.find(f => f.name === bestGroup.folderName);
    if (found) { folderId = found.id; break; }
  }

  if (!folderId) throw new Error('Folder not found');

  const tab = await browser.mailTabs.create({});
  await browser.mailTabs.update(tab.id, { displayedFolder: folderId });
  try {
    await browser.mailTabs.setQuickFilter(tab.id, {
      text: { text: senderEmail, author: true }
    });
  } catch (e) {
    // Quick filter may fail on some setups — folder is still displayed
  }

  return { ok: true };
}

// ── Message handler ──────────────────────────────────────────────────────────
browser.runtime.onMessage.addListener((request, sender) => {
  switch (request.command) {
    case 'scan':
      if (scanState.status !== 'scanning') { runScan(); }
      return Promise.resolve({ ok: true });

    case 'getScanStatus':
      return Promise.resolve(scanState);

    case 'pauseScan':
      if (scanState.status === 'scanning') {
        scanState.paused = !scanState.paused;
      }
      return Promise.resolve({ ok: true, paused: scanState.paused });

    case 'stopScan':
      scanState.stopped = true;
      scanState.paused = false;
      return Promise.resolve({ ok: true });

    case 'getStats':
      return getStats();

    case 'getSubscriptions':
      return getSubscriptions(request.filter);

    case 'decide':
      return setDecision(request.senderEmail, request.recipientAddress, request.decision, request.dispose)
        .then(() => ({ ok: true }));

    case 'deleteEmails':
      return (TEST_DELETE ? testDeleteEmails : deleteEmails)(
        request.senderEmail, request.recipientAddress, request.selectedFolders);

    case 'moveEmails':
      return (TEST_DELETE ? testMoveEmails : moveEmails)(
        request.senderEmail, request.recipientAddress, request.selectedFolders, request.destinationFolderId);

    case 'getFolderTree':
      return getFolderTree();

    case 'createFolder':
      return createFolderCmd(request.parentFolderId, request.folderName);

    case 'viewSubscription':
      return viewSubscription(request.senderEmail, request.recipientAddress);

    case 'unsubOneClick':
      return unsubOneClick(request.url);

    case 'unsubMail':
      return unsubMail(request.url);

    case 'unsubWeb':
      return unsubWeb(request.url);

    case 'unsubEmbedded':
      return unsubEmbedded(request.url);

    case 'openTab':
      return browser.tabs.create({ url: '/tab/tab.html' }).then(() => ({ ok: true }));

    default:
      return Promise.resolve({ error: 'Unknown command' });
  }
});

console.log('ThunderSub background script loaded');
