/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * Portions of the unsubscribe detection and unsubscribe methods are
 * adapted from BetterUnsubscribe by Luc Bennett (MPL-2.0):
 * https://github.com/LucBennett/BetterUnsubscribe */

import { UNSUB_REGEX, mayContainUnsubWording } from './unsub-detect.js';
import { buildAddressSkipMatcher } from './scan-scope.js';
import { oneClickUrlBlockReason, browserUrlBlockReason } from './unsub-url.js';
import { junkFolderForGroup } from './junk-routing.js';

// ── State ────────────────────────────────────────────────────────────────────
let scanState = {
  status: 'idle',
  progress: 0,
  total: 0,
  folderProgress: 0,
  folderTotal: 0,
  currentFolder: '',
  messagesScanned: 0,
  sendersFound: 0,
  subscriptionEmailsFound: 0,
  message: '',
  done: false,
  paused: false,
  stopped: false
};
const SESSION_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
const cancelledOperations = new Set();
const UNSCANNABLE_ACCOUNT_TYPES = new Set(['nntp', 'rss']);

// ── Storage helpers ──────────────────────────────────────────────────────────
let stateWriteQueue = Promise.resolve();

function subscriptionKey(senderEmail, recipientAddress, accountIdentityAddress = '') {
  return JSON.stringify([
    String(senderEmail || '').toLowerCase(),
    String(recipientAddress || '').toLowerCase(),
    String(accountIdentityAddress || '').toLowerCase()
  ]);
}

function keyForSubscription(sub) {
  return sub.subscriptionKey || subscriptionKey(
    sub.senderEmail,
    sub.recipientAddress,
    sub.accountIdentityAddress
  );
}

function keyFromRequest(request) {
  return request.subscriptionKey || subscriptionKey(
    request.senderEmail,
    request.recipientAddress,
    request.accountIdentityAddress
  );
}

function tracePhase(traceId, phase, startedAt, details = {}) {
  if (!traceId) return;
  console.log(`[ThunderSub trace ${traceId}] bg:${phase} +${Date.now() - startedAt}ms`, details);
}

function reportCleanupProgress(traceId, phase, current, total, message) {
  if (!traceId) return;
  browser.runtime.sendMessage({
    command: 'cleanupProgress',
    traceId,
    phase,
    current,
    total,
    message
  }).catch(() => {});
}

function operationCancelled(traceId) {
  return Boolean(traceId && cancelledOperations.has(traceId));
}

async function loadSubscriptions() {
  const result = await browser.storage.local.get(['subscriptions', 'subscriptionDecisions', 'subscriptionUpdates']);
  const decisions = result.subscriptionDecisions || {};
  const updates = result.subscriptionUpdates || {};
  return (result.subscriptions || []).map(sub => {
    const key = keyForSubscription(sub);
    return { ...sub, subscriptionKey: key, ...(updates[key] || {}), ...(decisions[key] || {}) };
  });
}

async function clearSubscriptionState() {
  const write = stateWriteQueue.then(() =>
    browser.storage.local.remove(['subscriptionDecisions', 'subscriptionUpdates']));
  stateWriteQueue = write.catch(() => {});
  await write;
}

async function loadSubscriptionsWithStateSnapshot() {
  await stateWriteQueue;
  const result = await browser.storage.local.get(['subscriptions', 'subscriptionDecisions', 'subscriptionUpdates']);
  const decisions = result.subscriptionDecisions || {};
  const updates = result.subscriptionUpdates || {};
  const subscriptions = (result.subscriptions || []).map(sub => {
    const key = keyForSubscription(sub);
    return { ...sub, subscriptionKey: key, ...(updates[key] || {}), ...(decisions[key] || {}) };
  });
  return { subscriptions, decisions, updates };
}

function removeIncorporatedState(current, incorporated) {
  for (const [key, value] of Object.entries(incorporated)) {
    // Preserve state written after the rescan snapshot.
    if (JSON.stringify(current[key]) === JSON.stringify(value)) {
      delete current[key];
    }
  }
}

async function saveRescanSubscriptions(subs, incorporatedDecisions, incorporatedUpdates) {
  const write = stateWriteQueue.then(async () => {
    const result = await browser.storage.local.get(['subscriptionDecisions', 'subscriptionUpdates']);
    const currentDecisions = result.subscriptionDecisions || {};
    const currentUpdates = result.subscriptionUpdates || {};
    removeIncorporatedState(currentDecisions, incorporatedDecisions);
    removeIncorporatedState(currentUpdates, incorporatedUpdates);
    await browser.storage.local.set({
      subscriptions: subs,
      subscriptionDecisions: currentDecisions,
      subscriptionUpdates: currentUpdates
    });
  });
  stateWriteQueue = write.catch(() => {});
  await write;
}

async function saveSubscriptionUpdate(key, update, traceId) {
  const startedAt = Date.now();
  const write = stateWriteQueue.then(async () => {
    const result = await browser.storage.local.get('subscriptionUpdates');
    const updates = result.subscriptionUpdates || {};
    updates[key] = { ...(updates[key] || {}), ...update };
    await browser.storage.local.set({ subscriptionUpdates: updates });
  });
  stateWriteQueue = write.catch(() => {});
  await write;
  tracePhase(traceId, 'persist-subscription-update', startedAt, {
    fields: Object.keys(update),
    messageGroups: update.messageGroups?.length
  });
}

async function loadCurrentMessageGroups(key, fallbackGroups, traceId) {
  const startedAt = Date.now();
  await stateWriteQueue;
  const result = await browser.storage.local.get('subscriptionUpdates');
  const update = (result.subscriptionUpdates || {})[key];
  tracePhase(traceId, 'load-subscription-update', startedAt, { hasUpdate: !!update });
  return update?.messageGroups || fallbackGroups || [];
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
  return result.dryRun === true;
}

async function setDryRun(dryRun) {
  const enabled = dryRun === true;
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

function normalizeDefaultUnsubscribeDispose(value) {
  return ['keep', 'move', 'delete'].includes(value) ? value : 'keep';
}

async function getDefaultUnsubscribeDispose() {
  const result = await browser.storage.local.get('defaultUnsubscribeDispose');
  return normalizeDefaultUnsubscribeDispose(result.defaultUnsubscribeDispose);
}

async function setDefaultUnsubscribeDispose(defaultUnsubscribeDispose) {
  const normalized = normalizeDefaultUnsubscribeDispose(defaultUnsubscribeDispose);
  await browser.storage.local.set({ defaultUnsubscribeDispose: normalized });
  return { defaultUnsubscribeDispose: normalized };
}

async function fullReset() {
  if (scanState.status === 'scanning') {
    throw new Error('Stop the active scan before running a full reset.');
  }
  await clearSubscriptionState();
  await browser.storage.local.remove(['subscriptions', 'lastScan']);
  scanState = {
    status: 'idle',
    progress: 0,
    total: 0,
    folderProgress: 0,
    folderTotal: 0,
    currentFolder: '',
    messagesScanned: 0,
    sendersFound: 0,
    subscriptionEmailsFound: 0,
    message: '',
    done: false,
    paused: false,
    stopped: false
  };
  console.log('[ThunderSub] Full reset completed');
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

function extractHeaderEmailAddresses(raw) {
  const addresses = [];
  const seen = new Set();
  const re = /<([^<>\s]+@[^<>\s]+)>|([^\s<>,;"]+@[^\s<>,;"]+)/g;
  let match;
  while ((match = re.exec(String(raw || ''))) !== null) {
    const address = (match[1] || match[2] || '').trim().toLowerCase();
    if (!address || seen.has(address)) continue;
    seen.add(address);
    addresses.push(address);
  }
  return addresses;
}

function parseListId(headers = {}) {
  const raw = (headers['list-id'] || [])[0];
  if (!raw) return '';
  const bracketed = raw.match(/<([^<>]+)>/);
  return String(bracketed ? bracketed[1] : raw)
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function isReplyOrForwardSubject(subject) {
  return /^\s*(?:(?:re|fw|fwd)\s*:\s*)+/i.test(String(subject || ''));
}

// ── Recipient address extraction ─────────────────────────────────────────────
// Keep the mailbox recipient and configured account identity separate:
// recipientAddress drives cards and To filters; accountIdentityAddress drives
// identity filtering and mailto compose context.
function parseRecipientAddress(fullMessage, accountAddresses = []) {
  const headers = fullMessage.headers || {};
  const candidates = [];
  const deliveryHeaders = ['x-original-to', 'envelope-to', 'delivered-to'];
  const visibleHeaders = ['to', 'cc'];
  for (const header of deliveryHeaders) {
    for (const value of headers[header] || []) {
      for (const address of extractHeaderEmailAddresses(value)) {
        candidates.push({ address, source: header });
      }
    }
  }
  for (const header of visibleHeaders) {
    for (const value of headers[header] || []) {
      for (const address of extractHeaderEmailAddresses(value)) {
        candidates.push({ address, source: header });
      }
    }
  }

  const normalizedAccountAddresses = accountAddresses
    .filter(Boolean)
    .map(address => address.toLowerCase());
  const primaryIdentity = normalizedAccountAddresses[0] || '';
  const identityFor = (address) =>
    normalizedAccountAddresses.includes(address) ? address : primaryIdentity;

  const deliveryCandidate = candidates.find(candidate => deliveryHeaders.includes(candidate.source));
  if (deliveryCandidate) {
    return { ...deliveryCandidate, accountIdentityAddress: identityFor(deliveryCandidate.address), candidates };
  }

  const visibleCandidate = candidates.find(candidate => visibleHeaders.includes(candidate.source));
  if (visibleCandidate) {
    return { ...visibleCandidate, accountIdentityAddress: identityFor(visibleCandidate.address), candidates };
  }

  for (const header of ['return-path', 'sender', 'errors-to']) {
    const values = headers[header] || [];
    const joined = values.join(',').toLowerCase();
    const matchingAddress = normalizedAccountAddresses.find(address =>
      joined.includes(address) || joined.includes(address.replace('@', '=')));
    if (matchingAddress) {
      return {
        address: matchingAddress,
        source: `${header}-verp`,
        accountIdentityAddress: matchingAddress,
        candidates
      };
    }
  }

  if (primaryIdentity) {
    return {
      address: primaryIdentity,
      source: 'account-identity',
      accountIdentityAddress: primaryIdentity,
      candidates
    };
  }

  if (candidates.length > 0) return { ...candidates[0], accountIdentityAddress: '', candidates };
  return { address: '', source: 'unknown', accountIdentityAddress: '', candidates };
}

function recipientMatchesSkip(recipient, skipsRecipient) {
  if (!skipsRecipient) return false;
  const addresses = new Set([
    recipient?.address,
    ...(recipient?.candidates || []).map(candidate => candidate.address)
  ].filter(Boolean));
  for (const address of addresses) {
    if (skipsRecipient(address)) return true;
  }
  return false;
}

// ── Embedded unsubscribe link detection ──────────────────────────────────────
// The localized "unsubscribe" wording (UNSUB_REGEX) is imported from
// unsub-detect.js so the test suite can exercise the term list directly.
const URL_REGEX = /https?:\/\/[^\s"'<>]{1,1000}/g;
const QUOTED_CONTAINER_SELECTOR = [
  'blockquote',
  '.gmail_quote',
  '.gmail_extra',
  '.moz-cite-prefix',
  '.moz-forward-container',
  '.yahoo_quoted',
  '[type="cite"]'
].join(',');
const FORWARDED_TEXT_MARKER = /^\s*(?:begin forwarded message:|[-_]{2,}\s*(?:original|forwarded) message\s*[-_]{2,})\s*$/im;

function findEmbeddedUnsubLink(messagePart) {
  if (!messagePart) return null;
  const htmlLink = findEmbeddedLinkHTML(messagePart);
  if (htmlLink) return htmlLink;
  return findEmbeddedLinkText(messagePart);
}

function findEmbeddedLinkHTML(part) {
  if (part.parts) {
    for (const sub of part.parts) {
      if (String(sub.contentType || '').toLowerCase().startsWith('message/rfc822')) continue;
      const result = findEmbeddedLinkHTML(sub);
      if (result) return result;
    }
  }
  if (!part.body || part.contentType !== 'text/html') return null;
  // Bodies without any unsubscribe wording (the vast majority of mail) skip
  // the DOM parse and tree walks below entirely.
  if (!mayContainUnsubWording(part.body)) return null;

  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(part.body, 'text/html');
    doc.querySelectorAll(QUOTED_CONTAINER_SELECTOR).forEach(el => el.remove());

    // Some clients flatten forwarded content instead of wrapping it in a
    // blockquote. Remove everything after a visible forwarded-message marker.
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      if (FORWARDED_TEXT_MARKER.test(walker.currentNode.textContent || '')) {
        let node = walker.currentNode;
        while (node) {
          const next = nextNodeAfter(node, doc.body);
          node.parentNode?.removeChild(node);
          node = next;
        }
        break;
      }
    }

    const links = doc.querySelectorAll('a[href]');

    for (const link of links) {
      const text = link.textContent || '';
      const href = link.getAttribute('href') || '';
      if (UNSUB_REGEX.test(text) && href.startsWith('http')) {
        return href;
      }
    }
    const textWalker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
    while (textWalker.nextNode()) {
      if (UNSUB_REGEX.test(textWalker.currentNode.textContent)) {
        let el = textWalker.currentNode.parentElement;
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

function nextNodeAfter(node, root) {
  if (node.nextSibling) return node.nextSibling;
  while (node.parentNode && node.parentNode !== root) {
    node = node.parentNode;
    if (node.nextSibling) return node.nextSibling;
  }
  return null;
}

function findEmbeddedLinkText(part) {
  const body = extractTextBody(part);
  if (!body) return null;
  const authoredBody = stripQuotedText(body);

  const unsubMatches = [...authoredBody.matchAll(new RegExp(UNSUB_REGEX.source, 'giu'))];
  if (unsubMatches.length === 0) return null;

  const urlMatches = [...authoredBody.matchAll(URL_REGEX)];
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

function stripQuotedText(body) {
  const lines = String(body || '').split(/\r?\n/);
  const authored = [];
  for (const line of lines) {
    if (FORWARDED_TEXT_MARKER.test(line)) break;
    if (/^\s*>/.test(line)) continue;
    authored.push(line);
  }
  return authored.join('\n');
}

function extractTextBody(part) {
  if (part.body && part.contentType === 'text/plain') return part.body;
  if (part.parts) {
    for (const sub of part.parts) {
      if (String(sub.contentType || '').toLowerCase().startsWith('message/rfc822')) continue;
      const result = extractTextBody(sub);
      if (result) return result;
    }
  }
  return null;
}

function collectContentTypes(part, result = new Set()) {
  if (!part) return [...result];
  if (part.contentType) result.add(part.contentType);
  for (const sub of (part.parts || [])) collectContentTypes(sub, result);
  return [...result];
}

function addDetectionEvidence(sub, evidence) {
  for (const source of evidence.sources) {
    sub.detectionCounts[source] = (sub.detectionCounts[source] || 0) + 1;
  }
  sub.detectionEvidence.push(evidence);
  sub.detectionEvidence.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  sub.detectionEvidence.length = Math.min(sub.detectionEvidence.length, 50);
}

function newestUniqueUrls(candidates) {
  const seen = new Set();
  return candidates
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))
    .map(candidate => candidate.url)
    .filter(url => {
      if (!url || seen.has(url)) return false;
      seen.add(url);
      return true;
    });
}

function newestUniqueMethods(candidates) {
  const priority = { oneclick: 0, mail: 1, web: 2, embedded: 3 };
  const seen = new Set();
  return candidates
    .sort((a, b) =>
      String(b.date || '').localeCompare(String(a.date || '')) ||
      (priority[a.type] ?? 99) - (priority[b.type] ?? 99))
    .filter(candidate => {
      const key = `${candidate.type}|${candidate.url}`;
      if (!candidate.url || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map(({ type, url }) => ({ type, url }));
}

// ── Folder collection ────────────────────────────────────────────────────────
const SCAN_EXCLUDED_FOLDER_TYPES = new Set(['junk', 'trash', 'sent', 'drafts', 'outbox', 'templates']);

function isDefaultScannableFolder(folder) {
  if (SCAN_EXCLUDED_FOLDER_TYPES.has(folder.type)) return false;
  return folder.name !== 'All Mail' && folder.name !== '[Gmail]/All Mail';
}

async function collectAllFolders(account, folderOverrides = {}) {
  const results = [];

  async function walk(folders, parentDefaultExcluded = false) {
    for (const folder of folders) {
      const defaultExcluded = parentDefaultExcluded || !isDefaultScannableFolder(folder);
      const defaultIncluded = !defaultExcluded;
      if ((folderOverrides[folder.id] ?? defaultIncluded) === true) {
        results.push(folder);
      }
      try {
        const subFolders = await browser.folders.getSubFolders(folder.id, false);
        if (subFolders && subFolders.length > 0) {
          await walk(subFolders, defaultExcluded);
        }
      } catch (e) { /* Some folders may not support subfolders */ }
    }
  }

  if (account.folders && account.folders.length > 0) {
    await walk(account.folders);
  }
  return results;
}

// ── Scan scope ───────────────────────────────────────────────────────────────
//
// Folder scan choices are stored as per-folder overrides: true means
// explicitly included, false means explicitly excluded, and absence means use
// the app's default for that folder. From/To skip patterns are exact addresses
// or *@domain (see scan-scope.js).

async function getScanScopeSettings() {
  const result = await browser.storage.local.get([
    'scanExcludedAccountIds', 'scanFolderOverrides', 'scanExcludedFolderIds', 'scanIncludedFolderIds',
    'scanSkipSenders', 'scanSkipRecipients'
  ]);
  const folderOverrides = normalizeFolderOverrides(result.scanFolderOverrides);
  // Compatibility with pre-override settings. New saves write scanFolderOverrides.
  for (const folderId of result.scanExcludedFolderIds || []) {
    if (!(folderId in folderOverrides)) folderOverrides[folderId] = false;
  }
  for (const folderId of result.scanIncludedFolderIds || []) {
    if (!(folderId in folderOverrides)) folderOverrides[folderId] = true;
  }
  return {
    excludedAccountIds: result.scanExcludedAccountIds || [],
    folderOverrides,
    skipSenders: result.scanSkipSenders || [],
    skipRecipients: result.scanSkipRecipients || []
  };
}

function normalizeStringList(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map(v => String(v || '').trim())
    .filter(Boolean))];
}

function normalizeFolderOverrides(overrides) {
  const normalized = {};
  if (!overrides || typeof overrides !== 'object') return normalized;
  for (const [folderId, value] of Object.entries(overrides)) {
    if (value === true || value === false) normalized[String(folderId)] = value;
  }
  return normalized;
}

async function setScanScope({ excludedAccountIds, folderOverrides, skipSenders, skipRecipients }) {
  await browser.storage.local.set({
    scanExcludedAccountIds: normalizeStringList(excludedAccountIds),
    scanFolderOverrides: normalizeFolderOverrides(folderOverrides),
    scanSkipSenders: normalizeStringList(skipSenders).map(p => p.toLowerCase()),
    scanSkipRecipients: normalizeStringList(skipRecipients).map(p => p.toLowerCase())
  });
  await browser.storage.local.remove(['scanExcludedFolderIds', 'scanIncludedFolderIds']);
  return { ok: true };
}

// The full account/folder tree for selectable scan scope, with folders that
// are skipped by default flagged so the UI can keep them unchecked initially.
async function getScanScope() {
  const accounts = await browser.accounts.list();
  const tree = [];
  for (const account of accounts) {
    const node = {
      accountId: account.id,
      accountName: account.name,
      type: account.type,
      scannable: !UNSCANNABLE_ACCOUNT_TYPES.has(account.type),
      folders: []
    };
    if (node.scannable && account.folders && account.folders.length > 0) {
      node.folders = await walkScanScopeFolders(account.folders);
    }
    tree.push(node);
  }
  return { accounts: tree, ...(await getScanScopeSettings()) };
}

async function walkScanScopeFolders(folders, parentDefaultExcluded = false) {
  const result = [];
  for (const folder of folders) {
    const defaultExcluded = parentDefaultExcluded || !isDefaultScannableFolder(folder);
    const node = {
      id: folder.id,
      name: folder.name,
      type: folder.type,
      defaultExcluded,
      subFolders: []
    };
    try {
      const children = await browser.folders.getSubFolders(folder.id, false);
      if (children && children.length > 0) {
        node.subFolders = await walkScanScopeFolders(children, defaultExcluded);
      }
    } catch (e) { /* Some folders may not support subfolders */ }
    result.push(node);
  }
  return result;
}

// ── Message group helpers ────────────────────────────────────────────────────
//
// messageGroups is an array of:
//   { accountName, folderName, folderId, messageIds, headerMessageIds, messageCount, sessionId }
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
    group = { accountName, folderName, folderId, messageIds: [], headerMessageIds: [], sessionId: SESSION_ID };
    groups.push(group);
  }
  if (!group.folderId) group.folderId = folderId;
  group.sessionId = SESSION_ID;
  group.messageIds.push(msgId);
  if (headerMessageId && !group.headerMessageIds.includes(headerMessageId)) {
    group.headerMessageIds.push(headerMessageId);
  }
  group.messageCount = group.headerMessageIds.length || group.messageIds.length;
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
// Numeric ids created in this background session are current. Older ids are
// re-resolved from stable RFC 5322 Message-ID headers within the group's folder.
async function resolveCurrentMessageIds(groups, selectedFolders, senderEmail, traceId) {
  const startedAt = Date.now();
  const expectedSender = String(senderEmail || '').toLowerCase();
  const selected = selectGroupsForFolders(groups, selectedFolders);
  const ids = new Set();
  const unresolvedHeaderIds = new Set();
  let sessionGroups = 0;
  let targetedQueries = 0;
  let queryMs = 0;
  let slowestQueryMs = 0;
  const lookupTasks = [];

  for (const g of selected) {
    if (g.sessionId === SESSION_ID) {
      sessionGroups++;
      for (const id of g.messageIds || []) ids.add(id);
      continue;
    }

    const headerIds = new Set((g.headerMessageIds || []).map(normalizeHeaderMessageId).filter(Boolean));
    if (headerIds.size === 0) {
      // Older data without header ids: fall back to stored numeric ids. These are
      // only valid within the same session, but it's the best we can do.
      for (const id of g.messageIds || []) {
        ids.add(id);
      }
      continue;
    }

    for (const headerMessageId of headerIds) {
      lookupTasks.push({ folderId: g.folderId, headerMessageId });
    }
  }

  const lookupTotal = lookupTasks.length;
  let lookupsCompleted = 0;
  reportCleanupProgress(traceId, 'resolving', 0, lookupTotal, lookupTotal > 0
    ? `Locating messages: 0 of ${lookupTotal}`
    : 'Messages are ready');
  for (const { folderId, headerMessageId } of lookupTasks) {
    if (operationCancelled(traceId)) break;
    const queryStartedAt = Date.now();
    let found = [];
    try {
      found = await queryByHeaderMessageId(folderId, headerMessageId);
    } catch (e) {
      console.warn('[ThunderSub] Failed to resolve message by header id', headerMessageId, e);
    }
    // Message-IDs are sender-supplied and can be forged to collide with an
    // unrelated message in the same folder. Only act on messages whose From
    // matches the subscription, so a collision can't delete or move someone
    // else's mail.
    if (expectedSender) {
      found = found.filter(message => parseFromHeader(message.author).email === expectedSender);
    }
    const duration = Date.now() - queryStartedAt;
    targetedQueries++;
    lookupsCompleted++;
    queryMs += duration;
    slowestQueryMs = Math.max(slowestQueryMs, duration);
    reportCleanupProgress(
      traceId,
      'resolving',
      lookupsCompleted,
      lookupTotal,
      `Locating messages: ${lookupsCompleted} of ${lookupTotal}`
    );
    if (found.length === 0) {
      unresolvedHeaderIds.add(headerMessageId);
      continue;
    }
    for (const message of found) ids.add(message.id);
  }

  tracePhase(traceId, 'resolve-message-ids', startedAt, {
    groups: selected.length,
    sessionGroups,
    targetedQueries,
    concurrency: lookupTotal > 0 ? 1 : 0,
    queryMs,
    slowestQueryMs,
    resolved: ids.size,
    unresolved: unresolvedHeaderIds.size
  });
  return {
    ids: [...ids],
    unresolvedHeaderIds: [...unresolvedHeaderIds],
    cancelled: operationCancelled(traceId)
  };
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
  return groups.reduce((sum, g) => sum + (g.messageCount ?? (g.messageIds || []).length), 0);
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

// Track messages.onMoved while move calls are in flight so each moved
// message's new id is learned directly from the event (exact old->new
// mapping) instead of re-querying the destination folder afterwards.
function startMoveTracking(originalIds) {
  const pending = new Set(originalIds);
  const movedHeaders = [];
  const listener = (originalList, movedList) => {
    const from = (originalList && originalList.messages) || [];
    const to = (movedList && movedList.messages) || [];
    for (let i = 0; i < from.length && i < to.length; i++) {
      if (pending.has(from[i].id)) {
        pending.delete(from[i].id);
        movedHeaders.push(to[i]);
      }
    }
  };
  browser.messages.onMoved.addListener(listener);
  return {
    async finish(graceMs) {
      const deadline = Date.now() + graceMs;
      while (pending.size > 0 && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      browser.messages.onMoved.removeListener(listener);
      return { movedHeaders, unresolvedCount: pending.size };
    }
  };
}

function buildDeferredMovedGroup(headerMessageIds, movedHeaders, destinationFolderId, destinationMeta) {
  const trackedByHeaderId = new Map();
  for (const message of movedHeaders) {
    const headerMessageId = normalizeHeaderMessageId(message.headerMessageId);
    if (headerMessageId) trackedByHeaderId.set(headerMessageId, message.id);
  }
  const permanentIds = [...new Set([
    ...headerMessageIds,
    ...movedHeaders.map(message => message.headerMessageId)
  ].map(normalizeHeaderMessageId).filter(Boolean))];
  const allTracked = permanentIds.length > 0 && permanentIds.every(id => trackedByHeaderId.has(id));
  return {
    accountName: destinationMeta?.accountName || '',
    folderName: destinationMeta?.folderName || destinationMeta?.folderPath || 'Moved',
    folderId: destinationFolderId,
    messageIds: permanentIds.flatMap(id => trackedByHeaderId.has(id) ? [trackedByHeaderId.get(id)] : []),
    headerMessageIds: permanentIds,
    messageCount: permanentIds.length,
    sessionId: allTracked ? SESSION_ID : null
  };
}

// ── Scanner ──────────────────────────────────────────────────────────────────
// A single stalled message fetch (e.g. an IMAP body that never downloads)
// would otherwise hang the sequential scan forever with no error.
const MESSAGE_FETCH_TIMEOUT_MS = 30000;

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms);
    })
  ]);
}

async function runScan() {
  const startedAt = Date.now();
  scanState = { status: 'scanning', progress: 0, total: 0, folderProgress: 0, folderTotal: 0, currentFolder: '', messagesScanned: 0, sendersFound: 0, subscriptionEmailsFound: 0, message: 'Loading accounts...', done: false };
  console.log('[ThunderSub] Scan started');

  try {
    const { excludedAccountIds, folderOverrides, skipSenders, skipRecipients } = await getScanScopeSettings();
    const excludedAccounts = new Set(excludedAccountIds);
    const overriddenFolders = Object.keys(folderOverrides).length;
    const skipsSender = buildAddressSkipMatcher(skipSenders);
    const skipsRecipient = buildAddressSkipMatcher(skipRecipients);
    if (excludedAccounts.size > 0 || overriddenFolders > 0 || skipSenders.length > 0 || skipRecipients.length > 0) {
      console.log(`[ThunderSub] Scan scope: excluding ${excludedAccounts.size} account(s), overriding ${overriddenFolders} folder(s), skipping ${skipSenders.length} From pattern(s) and ${skipRecipients.length} To pattern(s)`);
    }

    const accounts = await browser.accounts.list();
    const allFolders = [];

    for (const account of accounts) {
      // News and feed subscriptions are managed locally and do not have email
      // unsubscribe methods. Reading their full articles can also require a
      // network fetch for every item.
      if (UNSCANNABLE_ACCOUNT_TYPES.has(account.type)) {
        console.log(`[ThunderSub] Skipping unsupported account type "${account.type}": ${account.name}`);
        continue;
      }
      if (excludedAccounts.has(account.id)) {
        console.log(`[ThunderSub] Skipping account excluded from scan scope: ${account.name}`);
        continue;
      }

      const identities = await browser.identities.list(account.id);
      const accountAddresses = identities
        .map(identity => identity.email)
        .filter(Boolean);
      const folders = await collectAllFolders(account, folderOverrides);
      for (const f of folders) {
        let messageCount = 0;
        try {
          const info = await browser.folders.getFolderInfo(f.id);
          messageCount = info.totalMessageCount || 0;
        } catch (e) { /* Count stays unknown; progress total is best-effort */ }
        allFolders.push({ folder: f, accountName: account.name, accountAddresses, messageCount });
      }
    }

    // Progress is message-based: one huge folder no longer pins the bar.
    const totalMessages = allFolders.reduce((sum, f) => sum + f.messageCount, 0);
    scanState.total = totalMessages;
    scanState.folderTotal = allFolders.length;
    scanState.message = `Scanning ${totalMessages.toLocaleString()} messages in ${allFolders.length} folders...`;
    console.log(`[ThunderSub] Scanning ~${totalMessages} messages in ${allFolders.length} folders across ${accounts.length} accounts`);

    // Accumulate by the public subscription key:
    // senderEmail | recipientAddress | accountIdentityAddress.
    const subs = {};

    for (let i = 0; i < allFolders.length; i++) {
      const { folder, accountName, accountAddresses, messageCount } = allFolders[i];
      const folderLabel = `${accountName} | ${folder.name}`;
      const folderStartedAt = Date.now();
      let processedInFolder = 0;
      scanState.folderProgress = i + 1;
      scanState.currentFolder = folderLabel;
      scanState.message = folderLabel;

      if (scanState.stopped) break;
      console.log(`[ThunderSub] Scanning folder ${i + 1}/${allFolders.length}: ${folderLabel} (${messageCount} messages)`);

      try {
        let messageFailures = 0;
        let firstMessageFailure = null;
        let page = await browser.messages.list(folder.id);

        pageLoop:
        while (page && page.messages && page.messages.length > 0) {
          for (const m of page.messages) {
            while (scanState.paused && !scanState.stopped) {
              await new Promise(r => setTimeout(r, 200));
            }
            if (scanState.stopped) break pageLoop;
            scanState.messagesScanned++;
            scanState.progress = scanState.messagesScanned;
            processedInFolder++;
            try {
              // Replies and forwards can contain unsubscribe links or headers
              // belonging to quoted/nested messages, not the outer sender.
              if (isReplyOrForwardSubject(m.subject)) continue;

              // Skip-listed senders are filtered before the body fetch.
              const { name, email } = parseFromHeader(m.author);
              if (skipsSender && email && skipsSender(email)) continue;

              const full = await withTimeout(
                browser.messages.getFull(m.id), MESSAGE_FETCH_TIMEOUT_MS, `getFull(${m.id})`);
              if (!full || !full.headers) continue;

              const recipient = parseRecipientAddress(full, accountAddresses);
              const recipientAddress = recipient.address;
              const accountIdentityAddress = recipient.accountIdentityAddress || '';
              if (recipientMatchesSkip(recipient, skipsRecipient)) continue;

              const listUnsub = full.headers['list-unsubscribe'];
              const listId = parseListId(full.headers);
              let urls = [];
              let oneClick = false;
              let embeddedUrl = null;

              if (listUnsub && listUnsub.length > 0) {
                urls = extractUnsubUrls(listUnsub[0]);
                oneClick = !!(full.headers['list-unsubscribe-post'] &&
                              full.headers['list-unsubscribe-post'].length > 0);
              }

              // Collect embedded links even when header-based methods exist so
              // retry can offer every detected alternative.
              embeddedUrl = findEmbeddedUnsubLink(full);
              if (urls.length === 0 && !embeddedUrl) continue;

              scanState.subscriptionEmailsFound++;

              if (!email) continue;

              const key = subscriptionKey(email, recipientAddress, accountIdentityAddress);

              if (!subs[key]) {
                subs[key] = {
                  subscriptionKey: key,
                  senderName: '',
                  senderNames: {},
                  senderEmail: email,
                  recipientAddress,
                  accountIdentityAddress,
                  listId,
                  emailCount: 0,
                  lastDate: '',
                  sampleSubject: '',
                  unsubCandidates: [],
                  oneClickCandidates: [],
                  embeddedCandidates: [],
                  methodCandidates: [],
                  detectionCounts: { header: 0, embedded: 0 },
                  detectionEvidence: [],
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

              // Preserve candidate dates so the most recently received methods
              // are preferred regardless of folder scan order.
              for (const u of urls) {
                s.unsubCandidates.push({ url: u, date: dateStr });
                if (oneClick && u.startsWith('http')) {
                  s.oneClickCandidates.push({ url: u, date: dateStr });
                  s.methodCandidates.push({ type: 'oneclick', url: u, date: dateStr });
                }
                if (u.startsWith('mailto:')) s.methodCandidates.push({ type: 'mail', url: u, date: dateStr });
                if (u.startsWith('http')) s.methodCandidates.push({ type: 'web', url: u, date: dateStr });
              }
              if (embeddedUrl) {
                s.embeddedCandidates.push({ url: embeddedUrl, date: dateStr });
                s.methodCandidates.push({ type: 'embedded', url: embeddedUrl, date: dateStr });
              }

              const headerMessageId = normalizeHeaderMessageId(m.headerMessageId || full.headers['message-id']);
              addDetectionEvidence(s, {
                headerMessageId,
                subject: m.subject || '',
                author: m.author || '',
                date: dateStr,
                accountName,
                folderName: folder.name,
                recipientSource: recipient.source,
                accountIdentityAddress,
                listId,
                sources: [
                  ...(urls.length > 0 ? ['header'] : []),
                  ...(embeddedUrl ? ['embedded'] : [])
                ],
                headerUrls: urls,
                embeddedUrl,
                contentTypes: collectContentTypes(full)
              });
              addToMessageGroups(s.messageGroups, accountName, folder.name, folder.id, m.id, headerMessageId);
              scanState.sendersFound = Object.keys(subs).length;
            } catch (e) {
              messageFailures++;
              firstMessageFailure ||= e;
            }
          }

          if (page.id) {
            try { page = await browser.messages.continueList(page.id); }
            catch (e) {
              console.warn(`[ThunderSub] Failed to continue listing folder: ${accountName} | ${folder.name}`, e);
              break;
            }
          } else {
            break;
          }
        }
        if (messageFailures > 0) {
          console.warn(`[ThunderSub] Skipped ${messageFailures} unreadable messages in: ${folderLabel}`, firstMessageFailure);
        }
        console.log(`[ThunderSub] Finished folder ${folderLabel}: ${processedInFolder} messages in ${((Date.now() - folderStartedAt) / 1000).toFixed(1)}s`);
      } catch (e) {
        console.warn(`[ThunderSub] Failed to scan folder: ${folderLabel}`, e);
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
      s._nameFreqs = names;
      delete s.senderNames;

      s.unsubUrls = newestUniqueUrls(s.unsubCandidates);
      s.oneClickUrls = newestUniqueUrls(s.oneClickCandidates);
      s.embeddedUrls = newestUniqueUrls(s.embeddedCandidates);
      s.unsubscribeMethods = newestUniqueMethods(s.methodCandidates);
      s.oneClick = s.oneClickUrls.length > 0;
      s.hasMailto = s.unsubUrls.some(u => u.startsWith('mailto:'));
      s.hasHttp = s.unsubUrls.some(u => u.startsWith('http'));
      s.embeddedUrl = s.embeddedUrls[0] || null;
      delete s.unsubCandidates;
      delete s.oneClickCandidates;
      delete s.embeddedCandidates;
      delete s.methodCandidates;
    }

    // Merge with existing stored subscriptions (preserve decisions)
    const {
      subscriptions: existing,
      decisions: incorporatedDecisions,
      updates: incorporatedUpdates
    } = await loadSubscriptionsWithStateSnapshot();
    const existingMap = {};
    for (const sub of existing) {
      existingMap[keyForSubscription(sub)] = sub;
    }

    const now = new Date().toISOString();
    const merged = [];

    for (const [key, s] of Object.entries(subs)) {
      const prev = existingMap[key];

      // A rescan re-evaluates everything, so prior errors and dismissals are
      // cleared: only 'keep'/'unsubscribed' decisions (and their dispose
      // state) carry over.
      const decision = (prev && (prev.decision === 'keep' || prev.decision === 'unsubscribed'))
        ? prev.decision : 'pending';
      const carryPrevState = !!prev && decision === prev.decision;

      merged.push({
        subscriptionKey: s.subscriptionKey || key,
        senderEmail: s.senderEmail,
        senderName: s.senderName,
        recipientAddress: s.recipientAddress,
        accountIdentityAddress: s.accountIdentityAddress || '',
        listId: s.listId || '',
        emailCount: s.emailCount,
        lastDate: s.lastDate,
        sampleSubject: s.sampleSubject,
        unsubUrls: s.unsubUrls,
        oneClickUrls: s.oneClickUrls,
        oneClick: s.oneClick,
        hasMailto: s.hasMailto,
        hasHttp: s.hasHttp,
        hasEmbedded: !!s.embeddedUrl,
        embeddedUrl: s.embeddedUrl,
        embeddedUrls: s.embeddedUrls,
        unsubscribeMethods: s.unsubscribeMethods,
        detectionCounts: s.detectionCounts,
        detectionEvidence: s.detectionEvidence,
        _nameFreqs: s._nameFreqs,
        messageGroups: s.messageGroups,
        decision,
        dispose: carryPrevState ? prev.dispose : null,
        cleanupDestination: carryPrevState ? prev.cleanupDestination : null,
        error: carryPrevState ? prev.error : null,
        dismissed: false,
        updatedAt: now
      });
    }

    for (const prev of existing) {
      const k = keyForSubscription(prev);
      if (!subs[k] && (prev.decision === 'keep' || prev.decision === 'unsubscribed')) {
        merged.push({ ...prev, subscriptionKey: k });
      }
    }

    // Remove only state overlays included in this merge. Changes made after the
    // snapshot stay overlaid on the new scan result.
    await saveRescanSubscriptions(merged, incorporatedDecisions, incorporatedUpdates);

    const finalMessagesScanned = scanState.messagesScanned;
    const finalSendersFound = Object.keys(subs).length;
    const wasStopped = scanState.stopped;

    await saveLastScan({
      messagesScanned: finalMessagesScanned,
      sendersFound: finalSendersFound,
      subscriptionEmailsFound: scanState.subscriptionEmailsFound,
      interrupted: wasStopped,
      at: now
    });

    scanState = {
      status: 'done',
      progress: scanState.progress,
      total: wasStopped ? scanState.total : scanState.progress,
      folderProgress: scanState.folderProgress,
      folderTotal: scanState.folderTotal,
      currentFolder: '',
      messagesScanned: finalMessagesScanned,
      sendersFound: finalSendersFound,
      subscriptionEmailsFound: scanState.subscriptionEmailsFound,
      message: wasStopped ? 'Scan interrupted.' : 'Scan complete.',
      done: true,
      paused: false,
      stopped: false
    };
    console.log(`[ThunderSub] Scan ${wasStopped ? 'stopped' : 'completed'} in ${Math.round((Date.now() - startedAt) / 1000)}s: ${finalSendersFound} subscriptions found`);

  } catch (e) {
    console.error('[ThunderSub] Scan failed:', e);
    scanState = { status: 'idle', progress: 0, total: 0, folderProgress: 0, folderTotal: 0, currentFolder: '', messagesScanned: 0, sendersFound: 0, subscriptionEmailsFound: 0, message: `Error: ${e.message}`, done: false };
  }
}

// ── Unsubscribe methods ──────────────────────────────────────────────────────

async function unsubOneClick(url, traceId) {
  const startedAt = Date.now();
  const blockReason = oneClickUrlBlockReason(url);
  if (blockReason) {
    tracePhase(traceId, 'one-click-blocked', startedAt, { reason: blockReason });
    throw new Error(`Blocked unsafe one-click unsubscribe URL (${blockReason}) — retry with the web or email method instead.`);
  }
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'List-Unsubscribe=One-Click'
  });
  tracePhase(traceId, 'one-click-fetch', startedAt, { status: resp.status, ok: resp.ok });
  return { ok: resp.ok, status: resp.status };
}

async function unsubMail(mailtoUrl, recipientAddress, traceId) {
  const startedAt = Date.now();
  const parsed = new URL(mailtoUrl);
  const to = parsed.pathname;
  const subject = parsed.searchParams.get('subject') || 'unsubscribe';
  const body = parsed.searchParams.get('body') || 'Please unsubscribe me from your mailing list. Thank you.';

  // Send from the identity the subscription is addressed to, so the
  // unsubscribe email never discloses an unrelated address of the user's
  // to the sender. Only without a match fall back to the first identity.
  let identityId = null;
  let fallbackIdentityId = null;
  const wanted = String(recipientAddress || '').toLowerCase();
  try {
    const accounts = await browser.accounts.list();
    outer:
    for (const account of accounts) {
      const identities = await browser.identities.list(account.id);
      for (const identity of identities || []) {
        fallbackIdentityId ||= identity.id;
        if (wanted && (identity.email || '').toLowerCase() === wanted) {
          identityId = identity.id;
          break outer;
        }
      }
    }
  } catch (e) {
    console.warn('[ThunderSub] Failed to select an identity for unsubscribe email; using Thunderbird default', e);
  }
  const identityMatched = !!identityId;
  if (!identityId) identityId = fallbackIdentityId;

  const details = { to, subject, body };
  if (identityId) details.identityId = identityId;

  const composeTab = await browser.compose.beginNew(details);
  const autoSend = await getAutoSendUnsubscribeEmails();
  // Without an identity matching the subscribed address, sending as-is
  // would disclose a different address of the user's to the sender. Always
  // leave the compose window open for review (even when auto-send is on),
  // and flag the mismatch so the UI can warn about the From address.
  if (!identityMatched) {
    console.warn(`[ThunderSub] No identity matches ${recipientAddress || '(unknown)'}; leaving the unsubscribe email as a draft for review`);
    tracePhase(traceId, 'mailto-compose-draft-no-identity', startedAt);
    return { ok: true, to, drafted: true, draftReason: 'no-identity-match' };
  }
  if (!autoSend) {
    tracePhase(traceId, 'mailto-compose-draft', startedAt);
    return { ok: true, to, drafted: true };
  }

  const result = await browser.compose.sendMessage(composeTab.id, { mode: 'sendNow' });

  if (!result || typeof result.headerMessageId === 'undefined') {
    throw new Error('Failed to send unsubscribe email');
  }
  tracePhase(traceId, 'mailto-compose-send', startedAt);
  return { ok: true, to, sent: true };
}

async function openUnsubInBrowser(url, phase, traceId) {
  const startedAt = Date.now();
  const blockReason = browserUrlBlockReason(url);
  if (blockReason) {
    tracePhase(traceId, `${phase}-blocked`, startedAt, { reason: blockReason });
    throw new Error(`Blocked unsafe unsubscribe link (${blockReason}).`);
  }
  await browser.windows.openDefaultBrowser(url);
  tracePhase(traceId, phase, startedAt);
  return { ok: true };
}

async function unsubWeb(url, traceId) {
  return openUnsubInBrowser(url, 'open-browser', traceId);
}

async function unsubEmbedded(url, traceId) {
  return openUnsubInBrowser(url, 'open-embedded-browser', traceId);
}

function dryRunUnsubscribe(type, url) {
  console.log(`[DRY RUN] Would unsubscribe via ${type}: ${url}`);
  return { ok: true, dryRun: true, type, url };
}

// ── Delete / Move ────────────────────────────────────────────────────────────
//
// selectedFolders: [{accountName, folderName}, ...] — which source folders to act on (all if empty)

async function deleteMessages(ids) {
  try {
    try {
      await browser.messages.delete(ids, { deletePermanently: false });
    } catch (e) {
      // The options-object form requires TB 137+; older versions take a
      // boolean skipTrash as the second argument.
      await browser.messages.delete(ids, false);
    }
    return { deleted: ids.length, failed: 0 };
  } catch (e) {
    console.warn('Failed to delete messages:', e);
    return { deleted: 0, failed: ids.length };
  }
}

async function moveMessages(ids, destinationFolderId) {
  try {
    await browser.messages.move(ids, destinationFolderId);
    return { moved: ids.length, failed: 0 };
  } catch (e) {
    console.warn('Failed to move messages:', e);
    return { moved: 0, failed: ids.length };
  }
}

async function findJunkFolderId(account) {
  let junkFolderId = null;
  async function walk(folders) {
    for (const folder of folders) {
      if (folder.type === 'junk') {
        junkFolderId = folder.id;
        return true;
      }
      try {
        const subFolders = await browser.folders.getSubFolders(folder.id, false);
        if (subFolders && subFolders.length > 0 && await walk(subFolders)) return true;
      } catch (e) { /* Some folders may not support subfolders */ }
    }
    return false;
  }
  if (account.folders && account.folders.length > 0) {
    await walk(account.folders);
  }
  return junkFolderId;
}

// Silent handling for phishing/spam senders: flag every message as junk
// (Thunderbird's local filter) and move it to the account's junk/spam folder
// — for Gmail/Outlook IMAP that is the documented "report as spam" signal,
// training the server-side filter. The sender is never contacted, so the
// address is never confirmed active. No delete: spam folders auto-purge, and
// removing the message right after the move could undercut the report.
// Accounts without a junk folder fall back to delete-to-Trash.
async function junkEmails(key, senderEmail, recipientAddress, messageGroups) {
  messageGroups = await loadCurrentMessageGroups(key, messageGroups);
  if (!messageGroups || messageGroups.length === 0) {
    return { junked: 0, movedToSpam: 0, deleted: 0 };
  }

  // Key junk folders by account id, not display name: two accounts can
  // share a name, which would route a junk move into the wrong mailbox.
  const accounts = await browser.accounts.list();
  const junkFolderByAccountId = {};
  for (const account of accounts) {
    junkFolderByAccountId[account.id] = await findJunkFolderId(account);
  }

  let junked = 0;
  let movedToSpam = 0;
  let deleted = 0;
  let failedTotal = 0;
  let totalIds = 0;

  for (const group of messageGroups) {
    const { ids, unresolvedHeaderIds } = await resolveCurrentMessageIds([group], null, senderEmail);
    if (unresolvedHeaderIds.length > 0) {
      console.warn(`[ThunderSub] ${unresolvedHeaderIds.length} message(s) could not be re-resolved before junking:`, unresolvedHeaderIds);
    }
    if (ids.length === 0) continue;
    totalIds += ids.length;

    for (const id of ids) {
      try {
        await browser.messages.update(id, { junk: true });
        junked++;
      } catch (e) {
        console.warn('Failed to mark message as junk:', e);
      }
    }

    const junkFolderId = await junkFolderForGroup(
      group, accounts, junkFolderByAccountId, folderId => browser.folders.get(folderId));
    if (junkFolderId) {
      const { moved, failed } = await moveMessages(ids, junkFolderId);
      movedToSpam += moved;
      failedTotal += failed;
    } else {
      const { deleted: d, failed } = await deleteMessages(ids);
      deleted += d;
      failedTotal += failed;
    }
  }

  if (failedTotal > 0) {
    // Junk flags already set are harmless; keep groups so a retry can finish.
    throw new Error(`Failed to junk ${failedTotal} of ${totalIds} emails.`);
  }

  await saveSubscriptionUpdate(key, {
    messageGroups: [],
    emailCount: 0,
    dismissed: true,
    updatedAt: new Date().toISOString()
  });

  return { junked, movedToSpam, deleted };
}

async function dryRunJunkEmails(senderEmail, recipientAddress, messageGroups) {
  if (!messageGroups || messageGroups.length === 0) {
    return { junked: 0, movedToSpam: 0, deleted: 0, dryRun: true };
  }
  const ids = getIdsForFolders(messageGroups, null);
  console.log(`[DRY RUN] Would mark ${ids.length} emails from ${senderEmail} → ${recipientAddress} as junk and move them to the spam folder`);
  return { junked: ids.length, movedToSpam: ids.length, deleted: 0, dryRun: true };
}

async function deleteEmails(key, senderEmail, recipientAddress, messageGroups, selectedFolders, traceId) {
  let startedAt;
  messageGroups = await loadCurrentMessageGroups(key, messageGroups, traceId);
  if (!messageGroups || messageGroups.length === 0) {
    return { deleted: 0 };
  }

  const { ids, unresolvedHeaderIds, cancelled } = await resolveCurrentMessageIds(messageGroups, selectedFolders, senderEmail, traceId);
  if (cancelled) return { deleted: 0, cancelled: true, actionCompleted: false };
  if (unresolvedHeaderIds.length > 0) {
    console.warn(`[ThunderSub] ${unresolvedHeaderIds.length} message(s) could not be re-resolved before delete (moved or removed):`, unresolvedHeaderIds);
  }
  if (ids.length === 0) return { deleted: 0 };

  reportCleanupProgress(traceId, 'deleting', 0, ids.length, `Deleting ${ids.length} messages...`);
  startedAt = Date.now();
  const { deleted, failed } = await deleteMessages(ids);
  tracePhase(traceId, 'delete-messages-api', startedAt, { requested: ids.length, deleted, failed });

  if (failed > 0) {
    throw new Error(`Failed to delete ${failed} of ${ids.length} emails.`);
  }

  reportCleanupProgress(traceId, 'saving', 0, 1, 'Saving cleanup state...');
  const remainingGroups = removeGroupsForFolders(messageGroups, selectedFolders);
  await saveSubscriptionUpdate(key, {
    messageGroups: remainingGroups,
    emailCount: totalMessageCount(remainingGroups),
    updatedAt: new Date().toISOString()
  }, traceId);

  return {
    deleted,
    cancelled: operationCancelled(traceId),
    actionCompleted: true,
    messageGroups: remainingGroups,
    emailCount: totalMessageCount(remainingGroups)
  };
}

async function moveEmails(key, senderEmail, recipientAddress, messageGroups, selectedFolders, destinationFolderId, destinationMeta, traceId) {
  let startedAt;
  messageGroups = await loadCurrentMessageGroups(key, messageGroups, traceId);
  if (!messageGroups || messageGroups.length === 0) {
    return { moved: 0 };
  }

  const { ids, unresolvedHeaderIds, cancelled } = await resolveCurrentMessageIds(messageGroups, selectedFolders, senderEmail, traceId);
  if (cancelled) return { moved: 0, cancelled: true, actionCompleted: false };
  if (unresolvedHeaderIds.length > 0) {
    console.warn(`[ThunderSub] ${unresolvedHeaderIds.length} message(s) could not be re-resolved before move (moved or removed):`, unresolvedHeaderIds);
  }
  if (ids.length === 0) return { moved: 0 };
  const headerMessageIds = getHeaderIdsForFolders(messageGroups, selectedFolders);

  reportCleanupProgress(traceId, 'moving', 0, ids.length, `Moving ${ids.length} messages...`);
  const tracker = startMoveTracking(ids);
  let moved = 0;
  let failed = 0;
  let tracked;
  try {
    startedAt = Date.now();
    ({ moved, failed } = await moveMessages(ids, destinationFolderId));
    tracePhase(traceId, 'move-messages-api', startedAt, { requested: ids.length, moved, failed });
  } finally {
    // Use events delivered while messages.move() was in flight. Some backends
    // never emit onMoved, so permanent ids remain the authoritative reference.
    startedAt = Date.now();
    tracked = await tracker.finish(0);
    tracePhase(traceId, 'move-event-wait', startedAt, {
      movedEvents: tracked.movedHeaders.length,
      unresolved: tracked.unresolvedCount
    });
  }

  if (failed > 0) {
    throw new Error(`Failed to move ${failed} of ${ids.length} emails.`);
  }

  const remainingGroups = removeGroupsForFolders(messageGroups, selectedFolders);
  const movedGroup = buildDeferredMovedGroup(
    headerMessageIds,
    tracked.movedHeaders,
    destinationFolderId,
    destinationMeta
  );

  reportCleanupProgress(traceId, 'saving', 0, 1, 'Saving cleanup state...');
  const updatedGroups = [...remainingGroups, movedGroup];
  await saveSubscriptionUpdate(key, {
    messageGroups: updatedGroups,
    emailCount: totalMessageCount(updatedGroups),
    updatedAt: new Date().toISOString()
  }, traceId);

  return {
    moved,
    cancelled: operationCancelled(traceId),
    actionCompleted: true,
    messageGroups: updatedGroups,
    emailCount: totalMessageCount(updatedGroups)
  };
}

// ── Other actions ────────────────────────────────────────────────────────────
async function setDecision(key, decision, dispose, cleanupDestination, error, traceId) {
  const startedAt = Date.now();
  const update = {
    decision,
    dispose: dispose || null,
    cleanupDestination: cleanupDestination || null,
    error: error || null,
    updatedAt: new Date().toISOString()
  };

  reportCleanupProgress(traceId, 'finalizing', 0, 1, 'Saving subscription status...');
  const write = stateWriteQueue.then(async () => {
    const result = await browser.storage.local.get('subscriptionDecisions');
    const decisions = result.subscriptionDecisions || {};
    decisions[key] = update;
    await browser.storage.local.set({ subscriptionDecisions: decisions });
  });
  stateWriteQueue = write.catch(() => {});
  await write;
  tracePhase(traceId, 'persist-decision', startedAt, { decision, dispose: dispose || null });
  console.log(`[ThunderSub] Decision saved: ${decision}${dispose ? `, cleanup: ${dispose}` : ''}`);
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
    subscriptionEmails: lastScan ? lastScan.subscriptionEmailsFound || 0 : 0,
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

async function dismissSubscription(key) {
  await saveSubscriptionUpdate(key, {
    dismissed: true,
    updatedAt: new Date().toISOString()
  });
  console.log('[ThunderSub] Subscription dismissed');
}

// ── Dry-run functions for delete/move (no Thunderbird messages touched) ──────

async function dryRunDeleteEmails(senderEmail, recipientAddress, messageGroups, selectedFolders) {
  if (!messageGroups || messageGroups.length === 0) {
    return { deleted: 0, dryRun: true };
  }

  const ids = getIdsForFolders(messageGroups, selectedFolders);
  const folderDesc = selectedFolders && selectedFolders.length
    ? selectedFolders.map(f => `${f.accountName} | ${f.folderName}`).join(', ')
    : 'all';
  console.log(`[DRY RUN] Would DELETE ${ids.length} emails from ${senderEmail} → ${recipientAddress} | folders=${folderDesc}`);

  return { deleted: ids.length, dryRun: true };
}

async function dryRunMoveEmails(senderEmail, recipientAddress, messageGroups, selectedFolders, destinationFolderId, destinationMeta) {
  if (!messageGroups || messageGroups.length === 0) {
    return { moved: 0, dryRun: true };
  }

  const ids = getIdsForFolders(messageGroups, selectedFolders);
  const folderDesc = selectedFolders && selectedFolders.length
    ? selectedFolders.map(f => `${f.accountName} | ${f.folderName}`).join(', ')
    : 'all';
  const destinationLabel = destinationMeta?.label || destinationFolderId;
  console.log(`[DRY RUN] Would MOVE ${ids.length} emails from ${senderEmail} → ${recipientAddress} | folders=${folderDesc} → dest=${destinationLabel}`);

  return { moved: ids.length, dryRun: true };
}

// ── Folder tree / creation / view ────────────────────────────────────────────

async function getFolderTree() {
  const accounts = await browser.accounts.list();
  const tree = [];

  for (const account of accounts) {
    const accountNode = {
      accountId: account.id,
      accountName: account.name,
      rootFolderId: account.rootFolder ? account.rootFolder.id : null,
      folders: []
    };

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
        } catch (e) {
          console.warn(`[ThunderSub] Failed to list move-destination subfolders under: ${f.name}`, e);
        }
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

async function viewSubscription(key, senderEmail) {
  const subs = await loadSubscriptions();
  const sub = subs.find(s => keyForSubscription(s) === key);
  if (!sub || !sub.messageGroups || sub.messageGroups.length === 0) {
    throw new Error('No messages found');
  }

  // Find the folder with the most messages
  let bestGroup = sub.messageGroups[0];
  for (const g of sub.messageGroups) {
    if ((g.messageCount ?? (g.messageIds || []).length) >
        (bestGroup.messageCount ?? (bestGroup.messageIds || []).length)) {
      bestGroup = g;
    }
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
    console.warn('[ThunderSub] Opened subscription folder but failed to apply sender filter', e);
  }

  return { ok: true };
}

// ── Message handler ──────────────────────────────────────────────────────────
function handleRuntimeMessage(request, sender) {
  const requestKey = keyFromRequest(request);
  switch (request.command) {
    case 'scan':
      if (scanState.status !== 'scanning') { runScan(); }
      return Promise.resolve({ ok: true });

    case 'getScanStatus':
      return Promise.resolve(scanState);

    case 'pauseScan':
      if (scanState.status === 'scanning') {
        scanState.paused = !scanState.paused;
        console.log(`[ThunderSub] Scan ${scanState.paused ? 'paused' : 'resumed'}`);
      }
      return Promise.resolve({ ok: true, paused: scanState.paused });

    case 'stopScan':
      scanState.stopped = true;
      scanState.paused = false;
      console.log('[ThunderSub] Scan stop requested');
      return Promise.resolve({ ok: true });

    case 'cancelOperation':
      if (request.traceId) {
        cancelledOperations.add(request.traceId);
        setTimeout(() => cancelledOperations.delete(request.traceId), 10 * 60 * 1000);
      }
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

    case 'getDefaultUnsubscribeDispose':
      return getDefaultUnsubscribeDispose().then(defaultUnsubscribeDispose => ({ defaultUnsubscribeDispose }));

    case 'setDefaultUnsubscribeDispose':
      return setDefaultUnsubscribeDispose(request.defaultUnsubscribeDispose);

    case 'fullReset':
      return fullReset();

    case 'decide':
      return setDecision(requestKey, request.decision, request.dispose, request.cleanupDestination, request.error, request.traceId)
        .then(() => ({ ok: true }));

    case 'dismiss':
      return dismissSubscription(requestKey)
        .then(() => ({ ok: true }));

    case 'junkEmails':
      return getDryRun().then(dryRun => dryRun
        ? dryRunJunkEmails(request.senderEmail, request.recipientAddress, request.messageGroups)
        : junkEmails(requestKey, request.senderEmail, request.recipientAddress, request.messageGroups));

    case 'deleteEmails':
      return getDryRun().then(dryRun => dryRun
        ? dryRunDeleteEmails(request.senderEmail, request.recipientAddress, request.messageGroups, request.selectedFolders)
        : deleteEmails(requestKey, request.senderEmail, request.recipientAddress, request.messageGroups, request.selectedFolders, request.traceId));

    case 'moveEmails':
      return getDryRun().then(dryRun => dryRun
        ? dryRunMoveEmails(request.senderEmail, request.recipientAddress, request.messageGroups, request.selectedFolders, request.destinationFolderId, request.destination)
        : moveEmails(requestKey, request.senderEmail, request.recipientAddress, request.messageGroups, request.selectedFolders, request.destinationFolderId, request.destination, request.traceId));

    case 'getScanScope':
      return getScanScope();

    case 'setScanScope':
      return setScanScope(request);

    case 'getFolderTree':
      return getFolderTree();

    case 'createFolder':
      return createFolderCmd(request.parentFolderId, request.folderName);

    case 'viewSubscription':
      return viewSubscription(requestKey, request.senderEmail);

    case 'unsubOneClick':
      return getDryRun().then(dryRun => dryRun
        ? dryRunUnsubscribe('one-click', request.url)
        : unsubOneClick(request.url, request.traceId));

    case 'unsubMail':
      return getDryRun().then(dryRun => dryRun
        ? dryRunUnsubscribe('email', request.url)
        : unsubMail(request.url, request.recipientAddress, request.traceId));

    case 'unsubWeb':
      return getDryRun().then(dryRun => dryRun
        ? dryRunUnsubscribe('browser', request.url)
        : unsubWeb(request.url, request.traceId));

    case 'unsubEmbedded':
      return getDryRun().then(dryRun => dryRun
        ? dryRunUnsubscribe('embedded link', request.url)
        : unsubEmbedded(request.url, request.traceId));

    case 'openTab':
      return browser.tabs.create({ url: '/tab/tab.html' }).then(() => ({ ok: true }));

    default:
      return Promise.resolve({ error: 'Unknown command' });
  }
}

browser.runtime.onMessage.addListener(async (request, sender) => {
  try {
    return await handleRuntimeMessage(request, sender);
  } catch (e) {
    console.error(`[ThunderSub] Command failed: ${request.command}`, e);
    throw e;
  }
});

console.log('[ThunderSub] Background script loaded');
