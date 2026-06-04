'use strict';

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

async function getLastScan() {
  const result = await browser.storage.local.get('lastScan');
  return result.lastScan || null;
}

async function saveLastScan(lastScan) {
  await browser.storage.local.set({ lastScan });
}

async function getDryRun() {
  const result = await browser.storage.local.get('dryRun');
  return result.dryRun !== false;
}

async function setDryRun(dryRun) {
  const enabled = dryRun !== false;
  await browser.storage.local.set({ dryRun: enabled });
  return { dryRun: enabled };
}

async function getAutoSendUnsubscribeEmails() {
  const result = await browser.storage.local.get('autoSendUnsubscribeEmails');
  return result.autoSendUnsubscribeEmails === true;
}

async function setAutoSendUnsubscribeEmails(autoSendUnsubscribeEmails) {
  const enabled = autoSendUnsubscribeEmails === true;
  await browser.storage.local.set({ autoSendUnsubscribeEmails: enabled });
  return { autoSendUnsubscribeEmails: enabled };
}

async function fullReset() {
  if (scanState.status === 'scanning') {
    throw new Error('Stop the active scan before running a full reset.');
  }
  await browser.storage.local.remove('subscriptions');
  await browser.storage.local.remove('lastScan');
  scanState = {
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
  return { ok: true };
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
      if (folder.name === 'All Mail' || folder.name === '[Gmail]/All Mail') continue;
      results.push(folder);
      try {
        const subFolders = await browser.folders.getSubFolders(folder.id, false);
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
//   { accountName, folderName, folderId, messageIds, headerMessageIds }
//
// Simple (accountName, folderName) keying for delete/archive scope.
// Unsub data lives at the top level of each subscription.

function normalizeHeaderMessageId(value) {
  const raw = Array.isArray(value) ? value[0] : value;
  return String(raw || '').trim().replace(/^<|>$/g, '');
}

function addToMessageGroups(groups, accountName, folderName, folderId, msgId, headerMessageId) {
  let group = groups.find(g => g.accountName === accountName && g.folderName === folderName);
  if (!group) {
    group = { accountName, folderName, folderId, messageIds: [], headerMessageIds: [] };
    groups.push(group);
  }
  if (!group.folderId) group.folderId = folderId;
  group.messageIds.push(msgId);
  if (headerMessageId && !group.headerMessageIds.includes(headerMessageId)) {
    group.headerMessageIds.push(headerMessageId);
  }
}

function folderMatchesSelection(group, selectedFolder) {
  if (group.folderId && selectedFolder.folderId) return group.folderId === selectedFolder.folderId;
  return selectedFolder.accountName === group.accountName && selectedFolder.folderName === group.folderName;
}

function selectGroupsForFolders(groups, selectedFolders) {
  if (!selectedFolders || selectedFolders.length === 0) return groups;
  return groups.filter(g => selectedFolders.some(f => folderMatchesSelection(g, f)));
}

function getIdsForFolders(groups, selectedFolders) {
  return selectGroupsForFolders(groups, selectedFolders).flatMap(g => g.messageIds);
}

// Stored numeric message ids (messages.MessageId) are internal tracking numbers
// that do NOT survive a Thunderbird restart and do NOT follow a moved message.
// See: https://webextension-api.thunderbird.net/en/latest/messages.html#messages-messageid
// So before deleting/moving we re-resolve the *current* numeric ids from the
// stable RFC 5322 Message-ID header (headerMessageIds) within each group's folder.
async function resolveCurrentMessageIds(groups, selectedFolders) {
  const selected = selectGroupsForFolders(groups, selectedFolders);
  const ids = [];
  const unresolvedHeaderIds = [];

  for (const g of selected) {
    const headerIds = g.headerMessageIds || [];
    if (headerIds.length === 0) {
      // Older data without header ids: fall back to stored numeric ids. These are
      // only valid within the same session, but it's the best we can do.
      for (const id of g.messageIds || []) {
        if (!ids.includes(id)) ids.push(id);
      }
      continue;
    }
    for (const headerMessageId of headerIds) {
      let found = [];
      try {
        found = await queryByHeaderMessageId(g.folderId, headerMessageId);
      } catch (e) {
        console.warn('[ThunderSub] Failed to resolve message by header id', headerMessageId, e);
      }
      if (found.length === 0) {
        unresolvedHeaderIds.push(headerMessageId);
        continue;
      }
      for (const m of found) {
        if (!ids.includes(m.id)) ids.push(m.id);
      }
    }
  }

  return { ids, unresolvedHeaderIds };
}

function getHeaderIdsForFolders(groups, selectedFolders) {
  const selected = (!selectedFolders || selectedFolders.length === 0)
    ? groups
    : groups.filter(g => selectedFolders.some(f => folderMatchesSelection(g, f)));
  return [...new Set(selected.flatMap(g => g.headerMessageIds || []).filter(Boolean))];
}

function removeGroupsForFolders(groups, selectedFolders) {
  if (!selectedFolders || selectedFolders.length === 0) return [];
  return groups
    .filter(g => !selectedFolders.some(f => folderMatchesSelection(g, f)));
}

function totalMessageCount(groups) {
  return groups.reduce((sum, g) => sum + g.messageIds.length, 0);
}

async function collectAllQueryResults(queryInfo) {
  const messages = [];
  let page = await browser.messages.query(queryInfo);
  while (page && page.messages && page.messages.length > 0) {
    messages.push(...page.messages);
    if (!page.id) break;
    page = await browser.messages.continueList(page.id);
  }
  return messages;
}

async function queryByHeaderMessageId(folderId, headerMessageId) {
  const values = [headerMessageId];
  if (headerMessageId && !headerMessageId.startsWith('<')) {
    values.push(`<${headerMessageId}>`);
  }

  for (const value of values) {
    const found = await collectAllQueryResults({
      folderId,
      headerMessageId: value,
      messagesPerPage: 100
    });
    if (found.length > 0) return found;
  }
  return [];
}

async function buildMovedMessageGroup(headerMessageIds, destinationFolderId, destinationMeta) {
  if (!headerMessageIds.length) return null;

  const messageIds = [];
  const foundHeaderIds = [];
  const unresolved = new Set(headerMessageIds);
  for (const delayMs of [0, 250, 750, 1500]) {
    if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));

    for (const headerMessageId of [...unresolved]) {
      let found = [];
      try {
        found = await queryByHeaderMessageId(destinationFolderId, headerMessageId);
      } catch (e) {
        console.warn('Failed to resolve moved message:', e);
      }
      for (const m of found) {
        if (!messageIds.includes(m.id)) messageIds.push(m.id);
      }
      if (found.length > 0) {
        foundHeaderIds.push(headerMessageId);
        unresolved.delete(headerMessageId);
      }
    }

    if (unresolved.size === 0) break;
  }

  if (!messageIds.length) return null;
  return {
    accountName: destinationMeta?.accountName || '',
    folderName: destinationMeta?.folderName || destinationMeta?.folderPath || 'Moved',
    folderId: destinationFolderId,
    messageIds,
    headerMessageIds: foundHeaderIds
  };
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
        let page = await browser.messages.list(folder.id);

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
                  senderName: '',
                  senderNames: {},
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
              if (name) {
                s.senderNames[name] = (s.senderNames[name] || 0) + 1;
              }
              const dateStr = m.date ? new Date(m.date).toISOString() : '';
              if (dateStr && (!s.lastDate || dateStr > s.lastDate)) {
                s.lastDate = dateStr;
                s.sampleSubject = m.subject || '';
              }

              // Merge unsub data at top level
              for (const u of urls) {
                if (!s.unsubUrls.includes(u)) s.unsubUrls.push(u);
              }
              if (oneClick) s.oneClick = true;
              if (hasMailto) s.hasMailto = true;
              if (hasHttp) s.hasHttp = true;
              if (embeddedUrl && !s.embeddedUrl) s.embeddedUrl = embeddedUrl;

              const headerMessageId = normalizeHeaderMessageId(m.headerMessageId || full.headers['message-id']);
              addToMessageGroups(s.messageGroups, accountName, folder.name, folder.id, m.id, headerMessageId);
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

    // Resolve most frequent sender name per subscription
    for (const s of Object.values(subs)) {
      const names = s.senderNames;
      let best = '', bestCount = 0;
      for (const [n, c] of Object.entries(names)) {
        if (c > bestCount) { best = n; bestCount = c; }
      }
      s.senderName = best;
      if (Object.keys(names).length > 1) {
        console.log(`[NAME] ${s.senderEmail} → picked "${best}" (${bestCount}) from:`, names);
      }
      s._nameFreqs = names;
      delete s.senderNames;
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

      // A rescan re-evaluates everything, so prior errors are cleared: only
      // 'keep'/'unsubscribed' decisions (and their dispose state) carry over.
      const decision = (prev && (prev.decision === 'keep' || prev.decision === 'unsubscribed'))
        ? prev.decision : 'pending';
      const carryPrevState = !!prev && decision === prev.decision;

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
        _nameFreqs: s._nameFreqs,
        messageGroups: s.messageGroups,
        decision,
        dispose: carryPrevState ? prev.dispose : null,
        cleanupDestination: carryPrevState ? prev.cleanupDestination : null,
        error: carryPrevState ? prev.error : null,
        dismissed: carryPrevState ? !!prev.dismissed : false,
        updatedAt: now
      });
    }

    for (const prev of existing) {
      const k = `${prev.senderEmail}|${prev.recipientAddress || ''}`;
      if (!subs[k] && (prev.decision === 'keep' || prev.decision === 'unsubscribed')) {
        merged.push(prev);
      }
    }

    await saveSubscriptions(merged);

    const finalMessagesScanned = scanState.messagesScanned;
    const finalSendersFound = Object.keys(subs).length;
    const wasStopped = scanState.stopped;

    await saveLastScan({
      messagesScanned: finalMessagesScanned,
      sendersFound: finalSendersFound,
      interrupted: wasStopped,
      at: now
    });

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
  const autoSend = await getAutoSendUnsubscribeEmails();
  if (!autoSend) {
    return { ok: true, to, drafted: true };
  }

  const result = await browser.compose.sendMessage(composeTab.id, { mode: 'sendNow' });

  if (!result || typeof result.headerMessageId === 'undefined') {
    throw new Error('Failed to send unsubscribe email');
  }
  return { ok: true, to, sent: true };
}

async function unsubWeb(url) {
  await browser.windows.openDefaultBrowser(url);
  return { ok: true };
}

async function unsubEmbedded(url) {
  await browser.windows.openDefaultBrowser(url);
  return { ok: true };
}

function dryRunUnsubscribe(type, url) {
  console.log(`[DRY RUN] Would unsubscribe via ${type}: ${url}`);
  return { ok: true, dryRun: true, type, url };
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

  const { ids, unresolvedHeaderIds } = await resolveCurrentMessageIds(sub.messageGroups, selectedFolders);
  if (unresolvedHeaderIds.length > 0) {
    console.warn(`[ThunderSub] ${unresolvedHeaderIds.length} message(s) could not be re-resolved before delete (moved or removed):`, unresolvedHeaderIds);
  }
  if (ids.length === 0) return { deleted: 0 };

  let deleted = 0;
  let failed = 0;
  const batchSize = 50;
  for (let i = 0; i < ids.length; i += batchSize) {
    const batch = ids.slice(i, i + batchSize);
    try {
      await browser.messages.delete(batch, { deletePermanently: false });
      deleted += batch.length;
    } catch (e) {
      failed += batch.length;
      console.warn('Failed to delete batch:', e);
    }
  }

  if (failed > 0) {
    throw new Error(`Failed to delete ${failed} of ${ids.length} emails.`);
  }

  sub.messageGroups = removeGroupsForFolders(sub.messageGroups, selectedFolders);
  sub.emailCount = totalMessageCount(sub.messageGroups);
  await saveSubscriptions(subs);

  return { deleted };
}

async function moveEmails(senderEmail, recipientAddress, selectedFolders, destinationFolderId, destinationMeta) {
  const subs = await loadSubscriptions();
  const sub = subs.find(s => s.senderEmail === senderEmail && s.recipientAddress === recipientAddress);
  if (!sub || !sub.messageGroups || sub.messageGroups.length === 0) {
    return { moved: 0 };
  }

  const { ids, unresolvedHeaderIds } = await resolveCurrentMessageIds(sub.messageGroups, selectedFolders);
  if (unresolvedHeaderIds.length > 0) {
    console.warn(`[ThunderSub] ${unresolvedHeaderIds.length} message(s) could not be re-resolved before move (moved or removed):`, unresolvedHeaderIds);
  }
  if (ids.length === 0) return { moved: 0 };
  const headerMessageIds = getHeaderIdsForFolders(sub.messageGroups, selectedFolders);

  let moved = 0;
  let failed = 0;
  const batchSize = 50;
  for (let i = 0; i < ids.length; i += batchSize) {
    const batch = ids.slice(i, i + batchSize);
    try {
      await browser.messages.move(batch, destinationFolderId);
      moved += batch.length;
    } catch (e) {
      failed += batch.length;
      console.warn('Failed to move batch:', e);
    }
  }

  if (failed > 0) {
    throw new Error(`Failed to move ${failed} of ${ids.length} emails.`);
  }

  const remainingGroups = removeGroupsForFolders(sub.messageGroups, selectedFolders);
  const movedGroup = await buildMovedMessageGroup(headerMessageIds, destinationFolderId, destinationMeta);
  sub.messageGroups = movedGroup ? [...remainingGroups, movedGroup] : remainingGroups;
  sub.emailCount = totalMessageCount(sub.messageGroups);
  await saveSubscriptions(subs);

  return {
    moved,
    resolved: !!movedGroup,
    resolvedCount: movedGroup ? movedGroup.messageIds.length : 0
  };
}

// ── Other actions ────────────────────────────────────────────────────────────
async function setDecision(senderEmail, recipientAddress, decision, dispose, cleanupDestination, error) {
  const subs = await loadSubscriptions();
  const sub = subs.find(s => s.senderEmail === senderEmail && s.recipientAddress === recipientAddress);
  if (!sub) throw new Error('Subscription not found');

  sub.decision = decision;
  sub.dispose = dispose || null;
  sub.cleanupDestination = cleanupDestination || null;
  sub.error = error || null;
  sub.updatedAt = new Date().toISOString();
  await saveSubscriptions(subs);
}

async function getStats() {
  const subs = (await loadSubscriptions()).filter(s => !s.dismissed);
  const lastScan = await getLastScan();
  return {
    total: subs.length,
    pending: subs.filter(s => s.decision === 'pending').length,
    kept: subs.filter(s => s.decision === 'keep').length,
    unsubscribed: subs.filter(s => s.decision === 'unsubscribed').length,
    error: subs.filter(s => s.decision === 'error').length,
    emailsScanned: lastScan ? lastScan.messagesScanned : 0,
    lastScanAt: lastScan ? lastScan.at : null
  };
}

async function getSubscriptions(filter) {
  const subs = (await loadSubscriptions()).filter(s => !s.dismissed);
  let filtered = subs;
  if (filter && filter !== 'all') {
    filtered = subs.filter(s => s.decision === filter);
  }
  filtered.sort((a, b) => b.emailCount - a.emailCount);
  return filtered;
}

async function dismissSubscription(senderEmail, recipientAddress) {
  const subs = await loadSubscriptions();
  const sub = subs.find(s => s.senderEmail === senderEmail && s.recipientAddress === recipientAddress);
  if (!sub) throw new Error('Subscription not found');
  sub.dismissed = true;
  sub.updatedAt = new Date().toISOString();
  await saveSubscriptions(subs);
}

// ── Dry-run functions for delete/move (no Thunderbird messages touched) ──────

async function dryRunDeleteEmails(senderEmail, recipientAddress, selectedFolders) {
  const subs = await loadSubscriptions();
  const sub = subs.find(s => s.senderEmail === senderEmail && s.recipientAddress === recipientAddress);
  if (!sub || !sub.messageGroups || sub.messageGroups.length === 0) {
    return { deleted: 0, dryRun: true };
  }

  const ids = getIdsForFolders(sub.messageGroups, selectedFolders);
  const folderDesc = selectedFolders && selectedFolders.length
    ? selectedFolders.map(f => `${f.accountName} | ${f.folderName}`).join(', ')
    : 'all';
  console.log(`[DRY RUN] Would DELETE ${ids.length} emails from ${sub.senderName || ''} <${senderEmail}> → ${recipientAddress} | folders=${folderDesc}`);

  return { deleted: ids.length, dryRun: true };
}

async function dryRunMoveEmails(senderEmail, recipientAddress, selectedFolders, destinationFolderId, destinationMeta) {
  const subs = await loadSubscriptions();
  const sub = subs.find(s => s.senderEmail === senderEmail && s.recipientAddress === recipientAddress);
  if (!sub || !sub.messageGroups || sub.messageGroups.length === 0) {
    return { moved: 0, dryRun: true };
  }

  const ids = getIdsForFolders(sub.messageGroups, selectedFolders);
  const folderDesc = selectedFolders && selectedFolders.length
    ? selectedFolders.map(f => `${f.accountName} | ${f.folderName}`).join(', ')
    : 'all';
  const destinationLabel = destinationMeta?.label || destinationFolderId;
  console.log(`[DRY RUN] Would MOVE ${ids.length} emails from ${sub.senderName || ''} <${senderEmail}> → ${recipientAddress} | folders=${folderDesc} → dest=${destinationLabel}`);

  return { moved: ids.length, dryRun: true };
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
          const children = await browser.folders.getSubFolders(f.id, false);
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

  let folderId = bestGroup.folderId || null;
  if (!folderId) {
    const accounts = await browser.accounts.list();
    for (const account of accounts) {
      if (account.name !== bestGroup.accountName) continue;
      const folders = await collectAllFolders(account);
      const found = folders.find(f => f.name === bestGroup.folderName);
      if (found) { folderId = found.id; break; }
    }
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

    case 'getDryRun':
      return getDryRun().then(dryRun => ({ dryRun }));

    case 'setDryRun':
      return setDryRun(request.dryRun);

    case 'getAutoSendUnsubscribeEmails':
      return getAutoSendUnsubscribeEmails().then(autoSendUnsubscribeEmails => ({ autoSendUnsubscribeEmails }));

    case 'setAutoSendUnsubscribeEmails':
      return setAutoSendUnsubscribeEmails(request.autoSendUnsubscribeEmails);

    case 'fullReset':
      return fullReset();

    case 'decide':
      return setDecision(request.senderEmail, request.recipientAddress, request.decision, request.dispose, request.cleanupDestination, request.error)
        .then(() => ({ ok: true }));

    case 'dismiss':
      return dismissSubscription(request.senderEmail, request.recipientAddress)
        .then(() => ({ ok: true }));

    case 'deleteEmails':
      return getDryRun().then(dryRun => (dryRun ? dryRunDeleteEmails : deleteEmails)(
        request.senderEmail, request.recipientAddress, request.selectedFolders));

    case 'moveEmails':
      return getDryRun().then(dryRun => (dryRun ? dryRunMoveEmails : moveEmails)(
        request.senderEmail, request.recipientAddress, request.selectedFolders, request.destinationFolderId, request.destination));

    case 'getFolderTree':
      return getFolderTree();

    case 'createFolder':
      return createFolderCmd(request.parentFolderId, request.folderName);

    case 'viewSubscription':
      return viewSubscription(request.senderEmail, request.recipientAddress);

    case 'unsubOneClick':
      return getDryRun().then(dryRun => dryRun
        ? dryRunUnsubscribe('one-click', request.url)
        : unsubOneClick(request.url));

    case 'unsubMail':
      return getDryRun().then(dryRun => dryRun
        ? dryRunUnsubscribe('email', request.url)
        : unsubMail(request.url));

    case 'unsubWeb':
      return getDryRun().then(dryRun => dryRun
        ? dryRunUnsubscribe('browser', request.url)
        : unsubWeb(request.url));

    case 'unsubEmbedded':
      return getDryRun().then(dryRun => dryRun
        ? dryRunUnsubscribe('embedded link', request.url)
        : unsubEmbedded(request.url));

    case 'openTab':
      return browser.tabs.create({ url: '/tab/tab.html' }).then(() => ({ ok: true }));

    default:
      return Promise.resolve({ error: 'Unknown command' });
  }
});

console.log('ThunderSub background script loaded');
