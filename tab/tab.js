/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

'use strict';

let currentFilter = 'pending';
let scanPollTimer = null;
let subsCache = [];
let dryRun = false;
let autoSendUnsubscribeEmails = false;
let hasScannedBefore = false;
let scanInProgress = false;
let currentRecipientFilter = '';
let currentSort = 'recent';
const SHOW_DETECTION_UI = false;

// The scan button reads "Rescan Emails" once a scan has produced data, else
// "Scan Emails". Only touches the label while the button is idle so it never
// clobbers "Scanning..." mid-scan.
function refreshScanButtonLabel() {
  const btn = document.getElementById('scan-btn');
  if (!btn || btn.disabled) return;
  btn.textContent = hasScannedBefore ? 'Rescan Emails' : 'Scan Emails';
}

// ── Utils ────────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function toast(msg, type = 'info') {
  const c = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = msg;
  c.appendChild(el);
  setTimeout(() => {
    el.style.animation = 'fadeOut .3s ease forwards';
    setTimeout(() => el.remove(), 300);
  }, 6000);
}

function bg(command, data) {
  return browser.runtime.sendMessage({ command, ...data });
}

function createTrace(label, details = {}) {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const startedAt = performance.now();
  const log = (phase, phaseStartedAt = startedAt, extra = {}) => {
    console.log(`[ThunderSub trace ${id}] ${phase} +${Math.round(performance.now() - phaseStartedAt)}ms`, {
      elapsedMs: Math.round(performance.now() - startedAt),
      ...extra
    });
  };
  log(`${label}:start`, startedAt, details);
  return {
    id,
    log,
    async bg(command, data = {}) {
      const phaseStartedAt = performance.now();
      try {
        const result = await bg(command, { ...data, traceId: id });
        log(`ui:${command}`, phaseStartedAt);
        return result;
      } catch (error) {
        log(`ui:${command}:failed`, phaseStartedAt, { error: String(error?.message || error) });
        throw error;
      }
    }
  };
}

function avatarColor(email) {
  let h = 0;
  for (let i = 0; i < email.length; i++) h = (h * 31 + email.charCodeAt(i)) & 0xffffff;
  const colors = ['#6366f1', '#8b5cf6', '#ec4899', '#f59e0b', '#10b981', '#3b82f6', '#ef4444', '#14b8a6'];
  return colors[Math.abs(h) % colors.length];
}

function initials(name, email) {
  const s = name || email || '?';
  const parts = s.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return (s[0] || '?').toUpperCase();
}

function sid(senderEmail, recipientAddress) {
  return (senderEmail + '|' + (recipientAddress || '')).replace(/[^a-zA-Z0-9]/g, '_');
}

function senderLabel(sub) {
  if (sub.senderName) return `${sub.senderName} <${sub.senderEmail}>`;
  return sub.senderEmail;
}

// ── Stats & filter badges ────────────────────────────────────────────────────
async function loadDryRun() {
  try {
    const result = await bg('getDryRun');
    dryRun = result.dryRun === true;
    document.getElementById('dry-run-toggle').checked = dryRun;
  } catch (e) {
    dryRun = false;
    document.getElementById('dry-run-toggle').checked = false;
  }
}

async function updateDryRun(enabled) {
  try {
    const result = await bg('setDryRun', { dryRun: enabled });
    dryRun = result.dryRun === true;
    document.getElementById('dry-run-toggle').checked = dryRun;
    toast(dryRun ? 'Dry run enabled' : 'Dry run disabled', dryRun ? 'info' : 'success');
  } catch (e) {
    document.getElementById('dry-run-toggle').checked = dryRun;
    toast('Failed to update dry run setting: ' + (e.message || e), 'error');
  }
}

async function loadAutoSendUnsubscribeEmails() {
  try {
    const result = await bg('getAutoSendUnsubscribeEmails');
    autoSendUnsubscribeEmails = result.autoSendUnsubscribeEmails === true;
    document.getElementById('auto-send-email-toggle').checked = autoSendUnsubscribeEmails;
  } catch (e) {
    autoSendUnsubscribeEmails = false;
    document.getElementById('auto-send-email-toggle').checked = false;
  }
}

async function updateAutoSendUnsubscribeEmails(enabled) {
  try {
    const result = await bg('setAutoSendUnsubscribeEmails', { autoSendUnsubscribeEmails: enabled });
    autoSendUnsubscribeEmails = result.autoSendUnsubscribeEmails === true;
    document.getElementById('auto-send-email-toggle').checked = autoSendUnsubscribeEmails;
    toast(
      autoSendUnsubscribeEmails ? 'Unsubscribe emails will be sent automatically' : 'Unsubscribe emails will open as drafts',
      autoSendUnsubscribeEmails ? 'info' : 'success'
    );
  } catch (e) {
    document.getElementById('auto-send-email-toggle').checked = autoSendUnsubscribeEmails;
    toast('Failed to update email unsubscribe setting: ' + (e.message || e), 'error');
  }
}

async function doFullReset() {
  const confirmed = confirm('Full reset clears saved scan results and subscription decisions. It does not delete, move, or send emails. Continue?');
  if (!confirmed) return;

  const btn = document.getElementById('full-reset-btn');
  btn.disabled = true;
  btn.textContent = 'Resetting...';

  try {
    await bg('fullReset');
    document.getElementById('progress-wrap').style.display = 'none';
    document.getElementById('scan-controls').style.display = 'none';
    document.getElementById('scan-btn').disabled = false;
    hasScannedBefore = false;
    refreshScanButtonLabel();
    document.getElementById('pause-btn').textContent = 'Pause';
    document.getElementById('stop-btn').disabled = false;
    document.getElementById('stop-btn').textContent = 'Stop';

    currentFilter = 'pending';
    document.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
    document.querySelector('.filter-tab[data-filter="pending"]')?.classList.add('active');
    document.getElementById('main-title').textContent = 'Pending';
    await loadStats();
    await loadSubs('pending');
    toast('Full reset complete', 'success');
  } catch (e) {
    toast('Full reset failed: ' + (e.message || e), 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Full Reset';
  }
}

async function loadStats() {
  try {
    const s = await bg('getStats');
    document.getElementById('stat-scanned').textContent = (s.emailsScanned || 0).toLocaleString();
    document.getElementById('stat-total').textContent = s.total;
    document.getElementById('stat-pending').textContent = s.pending;
    document.getElementById('stat-kept').textContent = s.kept;
    document.getElementById('stat-unsub').textContent = s.unsubscribed;
    document.getElementById('stat-error').textContent = s.error || 0;
    document.getElementById('fb-pending').textContent = s.pending;
    document.getElementById('fb-keep').textContent = s.kept;
    document.getElementById('fb-unsubscribed').textContent = s.unsubscribed;
    document.getElementById('fb-error').textContent = s.error || 0;
    hasScannedBefore = s.total > 0;
    refreshScanButtonLabel();
    const lastEl = document.getElementById('scan-last');
    if (lastEl) {
      lastEl.textContent = (!scanInProgress && s.lastScanAt) ? `Last scanned ${formatLastScan(s.lastScanAt)}` : '';
    }
  } catch (e) { /* ignore */ }
}

function updateDecisionStats(previousDecision, nextDecision) {
  if (!previousDecision || previousDecision === nextDecision) return;
  const ids = {
    pending: ['stat-pending', 'fb-pending'],
    keep: ['stat-kept', 'fb-keep'],
    unsubscribed: ['stat-unsub', 'fb-unsubscribed'],
    error: ['stat-error', 'fb-error']
  };
  const adjust = (decision, amount) => {
    for (const id of (ids[decision] || [])) {
      const el = document.getElementById(id);
      const value = Number.parseInt(el?.textContent || '', 10);
      if (el && Number.isFinite(value)) el.textContent = Math.max(0, value + amount);
    }
  };
  adjust(previousDecision, -1);
  adjust(nextDecision, 1);
}

function adjustStat(ids, amount) {
  for (const id of ids) {
    const el = document.getElementById(id);
    const value = Number.parseInt(el?.textContent || '', 10);
    if (el && Number.isFinite(value)) el.textContent = Math.max(0, value + amount);
  }
}

function removeCachedSubscription(sub, dismissed = false) {
  subsCache = subsCache.filter(s => s !== sub);
  if (dismissed) {
    adjustStat(['stat-total'], -1);
    adjustStat({
      pending: ['stat-pending', 'fb-pending'],
      keep: ['stat-kept', 'fb-keep'],
      unsubscribed: ['stat-unsub', 'fb-unsubscribed'],
      error: ['stat-error', 'fb-error']
    }[sub.decision] || [], -1);
  }
  refreshRecipientFilter();
  renderFilteredCards();
}

function updateCachedDecision(sub, nextDecision) {
  updateDecisionStats(sub.decision, nextDecision);
  sub.decision = nextDecision;
  if (nextDecision !== currentFilter) {
    removeCachedSubscription(sub);
  } else {
    renderFilteredCards();
  }
}

function formatLastScan(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const diffMs = Date.now() - d.getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hr ago`;
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) +
    ' at ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

// ── Subscriptions loading ────────────────────────────────────────────────────
async function loadSubs(filter) {
  const grid = document.getElementById('cards-grid');
  grid.innerHTML = '<div id="loading"><div class="spinner"></div>Loading...</div>';
  document.getElementById('empty-state').style.display = 'none';

  try {
    const subs = await bg('getSubscriptions', { filter: filter === 'all' ? null : filter });
    subsCache = subs;
    refreshRecipientFilter();
    renderFilteredCards();
  } catch (e) {
    grid.innerHTML = '<div style="color:var(--danger);padding:40px">Failed to load.</div>';
  }
}

function refreshRecipientFilter() {
  const select = document.getElementById('recipient-filter');
  const recipients = [...new Set(subsCache.map(s => s.recipientAddress || '').filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
  if (currentRecipientFilter && !recipients.includes(currentRecipientFilter)) {
    currentRecipientFilter = '';
  }
  select.innerHTML = '<option value="">All receiving addresses</option>';
  for (const recipient of recipients) {
    const option = document.createElement('option');
    option.value = recipient;
    option.textContent = recipient;
    select.appendChild(option);
  }
  select.value = currentRecipientFilter;
}

function renderFilteredCards() {
  const filtered = subsCache
    .filter(s => !currentRecipientFilter || s.recipientAddress === currentRecipientFilter)
    .sort((a, b) => {
      if (currentSort === 'recent') {
        return new Date(b.lastDate || 0).getTime() - new Date(a.lastDate || 0).getTime();
      }
      return (b.emailCount || 0) - (a.emailCount || 0);
    });
  renderCards(filtered);
}

function renderCards(subs) {
  const grid = document.getElementById('cards-grid');
  const empty = document.getElementById('empty-state');

  if (!subs.length) {
    grid.innerHTML = '';
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';
  grid.innerHTML = subs.map(s => buildCard(s)).join('');
}

// ── Message group helpers ─────────────────────────────────────────────────────

function subHasMessages(s) {
  return (s.messageGroups || []).some(g => groupMessageCount(g) > 0);
}

function groupMessageCount(group) {
  return group.messageCount ?? (group.messageIds || []).length;
}

function groupsByAccount(messageGroups) {
  // Returns: { accountName: { folderName: count, ... }, ... }
  const result = {};
  for (const g of (messageGroups || [])) {
    if (!result[g.accountName]) result[g.accountName] = {};
    result[g.accountName][g.folderName] = (result[g.accountName][g.folderName] || 0) + groupMessageCount(g);
  }
  return result;
}

// ── Unsub methods ────────────────────────────────────────────────────────────

const METHOD_LABELS = { oneclick: 'one-click', mail: 'email', web: 'browser', embedded: 'embedded link' };
const DISPOSE_LABELS = { delete: 'Deleted emails', move: 'Moved emails', keep: 'Left emails' };

// Full, human-readable description of how the unsubscribe will be performed,
// including the destination website (for link methods) or address (for email).
// Shown on hover so the modal stays uncluttered.
function methodDetail(method) {
  if (!method) return 'No unsubscribe method was detected for this sender.';
  switch (method.type) {
    case 'oneclick':
      return `One-click unsubscribe\nSends a secure POST request to:\n${method.url}`;
    case 'web':
      return `Browser unsubscribe\nOpens this page in your browser:\n${method.url}`;
    case 'embedded':
      return `Embedded link\nOpens this link from the email body:\n${method.url}`;
    case 'mail': {
      const addr = method.url.replace(/^mailto:/i, '').split('?')[0];
      return `Email unsubscribe\nSends an unsubscribe email to:\n${addr}`;
    }
    default:
      return method.url || '';
  }
}

function getBestMethod(sub) {
  if (sub.unsubscribeMethods?.length) return sub.unsubscribeMethods[0];

  const urls = sub.unsubUrls || [];
  const httpUrl = urls.find(u => u.startsWith('http')) || '';
  const mailtoUrl = urls.find(u => u.startsWith('mailto')) || '';
  const oneClickUrl = sub.oneClickUrls?.[0] || (sub.oneClick ? httpUrl : '');
  if (oneClickUrl) return { type: 'oneclick', url: oneClickUrl };
  if (mailtoUrl) return { type: 'mail', url: mailtoUrl };
  if (httpUrl) return { type: 'web', url: httpUrl };
  if (sub.embeddedUrl) return { type: 'embedded', url: sub.embeddedUrl };
  return null;
}

function getAvailableMethods(sub) {
  if (sub.unsubscribeMethods?.length) return sub.unsubscribeMethods;

  const methods = [];
  const oneClickUrls = sub.oneClickUrls || [];
  const add = (type, url) => {
    if (url && !methods.some(m => m.type === type && m.url === url)) methods.push({ type, url });
  };
  for (const url of oneClickUrls) add('oneclick', url);
  for (const url of (sub.unsubUrls || [])) {
    if (url.startsWith('http')) {
      if (!oneClickUrls.length && sub.oneClick) add('oneclick', url);
      add('web', url);
    } else if (url.startsWith('mailto:')) {
      add('mail', url);
    }
  }
  for (const url of (sub.embeddedUrls || [sub.embeddedUrl])) add('embedded', url);
  return methods;
}

function buildDetectionEvidence(s) {
  const evidence = s.detectionEvidence || [];
  if (!evidence.length) {
    return '<div class="evidence-empty">No per-message detection evidence is available. Run a new scan.</div>';
  }
  return evidence.map(e => {
    const sources = (e.sources || []).map(source =>
      `<span class="badge ${source === 'header' ? 'badge-green' : 'badge-purple'}">${esc(source)}</span>`
    ).join('');
    const urls = [...(e.headerUrls || []), ...(e.embeddedUrl ? [e.embeddedUrl] : [])];
    return `
      <div class="evidence-item">
        <div class="evidence-heading">${sources}<span>${esc(e.subject || '(no subject)')}</span></div>
        <div class="evidence-meta">
          <span>${esc(e.accountName || '')} | ${esc(e.folderName || '')}</span>
          <span>Receiver source: ${esc(e.recipientSource || 'unknown')}</span>
          <span>${esc(e.author || '')}</span>
          <span>${esc(e.date ? new Date(e.date).toLocaleString() : '')}</span>
        </div>
        ${urls.length ? `<div class="evidence-urls">${urls.map(url => `<div>${esc(url)}</div>`).join('')}</div>` : ''}
        ${e.headerMessageId ? `<div class="evidence-message-id">Message-ID: ${esc(e.headerMessageId)}</div>` : ''}
      </div>`;
  }).join('');
}

// ── Build card ───────────────────────────────────────────────────────────────
function buildActions(s) {
  const attrs = `data-sender-email="${esc(s.senderEmail)}" data-recipient-address="${esc(s.recipientAddress || '')}"`;

  if (s.decision === 'keep') {
    return `
    <button class="btn btn-view js-view" ${attrs}>View</button>
    <button class="btn btn-keep js-unkeep" title="Move this subscription back to Pending for review." ${attrs}>Review Again</button>`;
  }

  if (s.decision === 'unsubscribed' || s.decision === 'error') {
    // View and Cleanup act on stored messages; with none left they can only fail.
    const messageButtons = subHasMessages(s) ? `
    <button class="btn btn-view js-view" ${attrs}>View</button>
    <button class="btn btn-outline js-cleanup" ${attrs}>Cleanup</button>` : '';
    return `${messageButtons}
    <button class="btn btn-unsub js-retry" ${attrs}>Retry</button>
    <button class="btn btn-keep js-reset-pending" title="Move this subscription back to Pending for review." ${attrs}>Review Again</button>`;
  }

  return `
    <button class="btn btn-view js-view" ${attrs}>View</button>
    <button class="btn btn-keep js-keep" ${attrs}>Keep Subscription</button>
    <button class="btn btn-unsub js-open-modal" ${attrs}>Unsubscribe</button>`;
}

function buildCard(s) {
  const groups = s.messageGroups || [];
  const byAccount = groupsByAccount(groups);
  const color = avatarColor(s.senderEmail);
  const ini = initials(s.senderName, s.senderEmail);
  const id = sid(s.senderEmail, s.recipientAddress);
  const accountNames = Object.keys(byAccount);

  // Badges
  let badges = `<span class="badge badge-blue">${s.emailCount} emails</span>`;
  if (s.decision === 'keep') badges += `<span class="badge badge-kept">Kept</span>`;
  if (s.decision === 'unsubscribed') {
    badges += `<span class="badge badge-unsub">Unsubscribed</span>`;
    if (s.dispose && DISPOSE_LABELS[s.dispose]) badges += `<span class="badge badge-neutral">${DISPOSE_LABELS[s.dispose]}</span>`;
  }
  if (s.decision === 'error') badges += `<span class="badge badge-error">Error</span>`;

  const dateStr = s.lastDate ? new Date(s.lastDate).toLocaleDateString() : '';
  const cardId = `card-${id}`;
  const dismissable = s.decision === 'unsubscribed' || s.decision === 'error';
  const attrs = `data-sender-email="${esc(s.senderEmail)}" data-recipient-address="${esc(s.recipientAddress || '')}"`;

  return `
<div class="card" id="${cardId}" data-sender-email="${esc(s.senderEmail)}" data-recipient-address="${esc(s.recipientAddress || '')}">
  <div class="card-body">
    ${dismissable ? `<button class="card-dismiss js-dismiss" title="Dismiss and stop tracking this subscription" aria-label="Dismiss and stop tracking this subscription" ${attrs}>&#128465;</button>` : ''}
    ${s.decision === 'pending' && subHasMessages(s) ? `<button class="card-dismiss js-junk" title="Phishing or spam? Mark all emails as junk and move them to spam — trains your filters, and the sender is never contacted" aria-label="Mark all emails as junk and move them to spam" ${attrs}>&#128293;</button>` : ''}
    <div class="card-top">
      <div class="avatar" style="background:${color}">${esc(ini)}</div>
      <div class="card-info">
        <div class="sender-name" title="${esc(s.senderName)}">${esc(s.senderName || '(no name)')}</div>
        <div class="sender-email" title="${esc(s.senderEmail)}">${esc(s.senderEmail)}</div>
      </div>
    </div>
    <div class="card-badges">${badges}</div>
    <div class="card-meta">
      <span>${esc(dateStr)}</span>
      <span>${accountNames.map(a => esc(a)).join(', ')}</span>
    </div>
    ${s.recipientAddress ? `<div class="card-accounts" title="Delivered to ${esc(s.recipientAddress)}">→ ${esc(s.recipientAddress)}</div>` : ''}
    ${s.sampleSubject ? `<div class="card-subject" title="${esc(s.sampleSubject)}">"${esc(s.sampleSubject.substring(0, 80))}"</div>` : ''}
    ${s.error?.message ? `<div class="card-error" title="${esc(s.error.message)}">${esc(s.error.stage || 'Error')}: ${esc(s.error.message)}</div>` : ''}
    ${SHOW_DETECTION_UI ? '<button class="evidence-toggle js-evidence-toggle" type="button">Why detected?</button>' : ''}
  </div>
  ${SHOW_DETECTION_UI ? `<div class="detection-evidence">${buildDetectionEvidence(s)}</div>` : ''}
  <div class="card-actions">
    ${buildActions(s)}
  </div>
</div>`;
}

// ── Event delegation (attached once in DOMContentLoaded) ─────────────────────
function attachCardListeners() {
  document.getElementById('cards-grid').addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;

    if (btn.classList.contains('js-evidence-toggle')) {
      const card = btn.closest('.card');
      const evidence = card?.querySelector('.detection-evidence');
      if (evidence) {
        const open = evidence.classList.toggle('open');
        btn.textContent = open ? 'Hide detection details' : 'Why detected?';
      }
      return;
    }

    if (btn.classList.contains('js-view')) {
      try {
        await bg('viewSubscription', { senderEmail: btn.dataset.senderEmail, recipientAddress: btn.dataset.recipientAddress });
      } catch (e) {
        toast('Failed to open emails: ' + (e.message || e), 'error');
      }
      return;
    }

    if (btn.classList.contains('js-keep')) {
      await doKeep(btn.dataset.senderEmail, btn.dataset.recipientAddress);
      return;
    }

    if (btn.classList.contains('js-unkeep') || btn.classList.contains('js-reset-pending')) {
      await doPending(btn.dataset.senderEmail, btn.dataset.recipientAddress);
      return;
    }

    if (btn.classList.contains('js-open-modal')) {
      openUnsubModal(btn.dataset.senderEmail, btn.dataset.recipientAddress);
      return;
    }

    if (btn.classList.contains('js-retry')) {
      openUnsubModal(btn.dataset.senderEmail, btn.dataset.recipientAddress, true);
      return;
    }

    if (btn.classList.contains('js-cleanup')) {
      openCleanupModal(btn.dataset.senderEmail, btn.dataset.recipientAddress);
      return;
    }

    if (btn.classList.contains('js-dismiss')) {
      await doDismiss(btn.dataset.senderEmail, btn.dataset.recipientAddress);
      return;
    }

    if (btn.classList.contains('js-junk')) {
      await doJunk(btn.dataset.senderEmail, btn.dataset.recipientAddress);
      return;
    }
  });
}

async function doJunk(senderEmail, recipientAddress) {
  const sub = subsCache.find(s => s.senderEmail === senderEmail && s.recipientAddress === recipientAddress);
  if (!sub) return;
  const count = (sub.messageGroups || []).reduce((sum, g) => sum + groupMessageCount(g), 0);
  const name = sub.senderName || senderEmail;
  if (!confirm(`Mark ${count} emails from ${name} as junk and move them to the spam folder? The sender will not be contacted.`)) return;

  try {
    const result = await bg('junkEmails', { senderEmail, recipientAddress, messageGroups: sub.messageGroups });
    if (result?.dryRun) {
      toast(`Dry run: would mark ${result.junked || 0} emails as junk and move them to spam. No changes made.`, 'info');
    } else {
      const action = (result?.deleted || 0) > 0 && !(result?.movedToSpam || 0)
        ? 'deleted them (no spam folder found)'
        : 'moved them to spam';
      toast(`Marked ${result.junked || 0} emails from ${name} as junk and ${action}`, 'success');
      removeCachedSubscription(sub, true);
    }
  } catch (e) {
    toast('Failed to junk emails: ' + (e.message || e), 'error');
  }
}

async function doDismiss(senderEmail, recipientAddress) {
  const sub = subsCache.find(s => s.senderEmail === senderEmail && s.recipientAddress === recipientAddress);
  if (!sub) return;
  try {
    await bg('dismiss', { senderEmail, recipientAddress });
    removeCachedSubscription(sub, true);
  } catch (e) {
    toast('Failed to dismiss: ' + (e.message || e), 'error');
  }
}

// ── Unsubscribe modal ────────────────────────────────────────────────────────
let modalSenderEmail = null;
let modalRecipientAddress = null;
let folderTreeCache = null;
let modalMode = 'unsubscribe';
let modalIsRetry = false;
let modalSelectedMethod = null;
let cleanupDefaultAction = null;
let modalOperationTraceId = null;
let modalCancelRequested = false;

function resetModalProgress() {
  modalOperationTraceId = null;
  modalCancelRequested = false;
  const progress = document.getElementById('modal-progress');
  progress.classList.remove('active');
  document.getElementById('modal-progress-bar').style.width = '0';
  document.getElementById('modal-progress-text').textContent = 'Working...';
  const cancelBtn = document.getElementById('modal-cancel');
  cancelBtn.disabled = false;
  cancelBtn.textContent = 'Cancel';
}

function showModalProgress(traceId, message, percent) {
  modalOperationTraceId = traceId;
  document.getElementById('modal-progress').classList.add('active');
  if (!modalCancelRequested) {
    document.getElementById('modal-progress-text').textContent = message;
  }
  document.getElementById('modal-progress-bar').style.width = `${Math.max(0, Math.min(100, percent))}%`;
}

async function cancelOrCloseUnsubModal() {
  if (!modalOperationTraceId) {
    closeUnsubModal();
    return;
  }
  if (modalCancelRequested) return;

  modalCancelRequested = true;
  const cancelBtn = document.getElementById('modal-cancel');
  cancelBtn.disabled = true;
  cancelBtn.textContent = 'Cancelling...';
  document.getElementById('modal-progress-text').textContent = 'Cancelling after the current action...';
  try {
    await bg('cancelOperation', { traceId: modalOperationTraceId });
  } catch (e) {
    toast('Failed to request cancellation: ' + (e.message || e), 'error');
    modalCancelRequested = false;
    cancelBtn.disabled = false;
    cancelBtn.textContent = 'Cancel';
  }
}

function finishModalCancellation(trace, message = 'Operation cancelled') {
  const confirmBtn = document.getElementById('modal-confirm');
  confirmBtn.disabled = false;
  confirmBtn.textContent = modalConfirmLabel();
  resetModalProgress();
  closeUnsubModal();
  loadStats();
  loadSubs(currentFilter);
  toast(message, 'info');
  trace.log('unsubscribe:cancelled');
}

function cleanupProgressPercent(phase, current, total) {
  if (phase === 'resolving') return total > 0 ? 15 + Math.round((current / total) * 50) : 65;
  if (phase === 'deleting' || phase === 'moving') return 75;
  if (phase === 'saving') return 90;
  if (phase === 'finalizing') return 96;
  return 5;
}

browser.runtime.onMessage.addListener(request => {
  if (request.command !== 'cleanupProgress' || request.traceId !== modalOperationTraceId) return;
  showModalProgress(
    request.traceId,
    request.message || 'Working...',
    cleanupProgressPercent(request.phase, request.current, request.total)
  );
});

function modalConfirmLabel() {
  if (modalMode === 'cleanup') return 'Apply';
  return modalIsRetry ? 'Retry' : 'Unsubscribe';
}

function renderModalSourceFolders(sub) {
  const groups = sub.messageGroups || [];
  const foldersSection = document.getElementById('modal-folders-section');
  const foldersEl = document.getElementById('modal-folders');

  foldersEl.innerHTML = '';
  if (groups.length > 0) {
    foldersEl.innerHTML = groups.map((g, i) => `
      <label class="modal-folder-row">
        <input type="checkbox" class="modal-folder-check" data-idx="${i}" checked>
        <span class="modal-folder-name">${esc(g.accountName)} | ${esc(g.folderName)}</span>
        <span class="modal-folder-count">${groupMessageCount(g)}</span>
      </label>`).join('');
  }
  foldersSection.style.display = groups.length > 0 ? 'block' : 'none';
}

function openUnsubModal(senderEmail, recipientAddress, isRetry = false) {
  const sub = subsCache.find(s => s.senderEmail === senderEmail && s.recipientAddress === recipientAddress);
  if (!sub) return;

  modalSenderEmail = senderEmail;
  modalRecipientAddress = recipientAddress;
  modalMode = 'unsubscribe';
  modalIsRetry = isRetry;
  modalSelectedMethod = null;
  cleanupDefaultAction = null;
  resetModalProgress();

  const method = getBestMethod(sub);
  const methodLabel = method ? METHOD_LABELS[method.type] : 'none';
  const detail = methodDetail(method);

  document.getElementById('modal-title').textContent =
    `Unsubscribe from ${sub.senderName || sub.senderEmail}`;

  const availableMethods = getAvailableMethods(sub);
  const methodOptions = availableMethods.map((candidate, index) =>
    `<option value="${index}">${esc(METHOD_LABELS[candidate.type])}: ${esc(candidate.url)}</option>`
  ).join('');

  // Retry exposes every detected method while first-time unsubscribe shows the auto-best choice.
  const addrEl = document.getElementById('modal-addresses');
  addrEl.innerHTML = `
    <div class="modal-addr-row modal-addr-box">
      <div class="modal-kv">
        <span class="modal-kv-label">From:</span>
        <span class="modal-addr">${esc(sub.senderEmail)}</span>
      </div>
      <div class="modal-kv">
        <span class="modal-kv-label">To:</span>
        <span class="modal-addr">${esc(recipientAddress || '(unknown)')}</span>
      </div>
      <div class="modal-kv">
        <span class="modal-kv-label">Via:</span>
        ${isRetry
          ? `<select id="modal-method-select" class="method-select">
              <option value="auto">Auto-best (${esc(methodLabel)})</option>
              ${methodOptions}
            </select>`
          : `<span class="modal-method has-detail" title="${esc(detail)}">${esc(methodLabel)}</span>`}
      </div>
      ${isRetry ? `<div id="modal-method-help" class="method-help">${esc(detail)}</div>` : ''}
    </div>`;

  if (isRetry) {
    document.getElementById('modal-method-select').addEventListener('change', (e) => {
      modalSelectedMethod = e.target.value === 'auto' ? null : availableMethods[Number(e.target.value)];
      const selected = modalSelectedMethod || method;
      document.getElementById('modal-method-help').textContent = methodDetail(selected);
      document.getElementById('modal-confirm').title = methodDetail(selected);
    });
  }

  renderModalSourceFolders(sub);
  document.querySelector('.modal-dispose h4').textContent = 'What to do with existing emails?';
  document.querySelector('.modal-dispose').style.display = 'block';

  // Reset dispose & hide destination tree
  document.querySelector('input[name="dispose"][value="delete"]').checked = true;
  document.getElementById('modal-dest-wrap').style.display = 'none';
  document.getElementById('modal-new-folder-form').style.display = 'none';

  const confirmBtn = document.getElementById('modal-confirm');
  confirmBtn.disabled = false;
  confirmBtn.textContent = modalConfirmLabel();
  confirmBtn.title = detail;

  document.getElementById('unsub-modal-overlay').classList.add('open');
}

function openCleanupModal(senderEmail, recipientAddress, action) {
  const sub = subsCache.find(s => s.senderEmail === senderEmail && s.recipientAddress === recipientAddress);
  if (!sub) return;

  modalSenderEmail = senderEmail;
  modalRecipientAddress = recipientAddress;
  modalMode = 'cleanup';
  modalIsRetry = false;
  modalSelectedMethod = null;
  cleanupDefaultAction = action;
  resetModalProgress();

  const statusLabel = sub.decision === 'error'
    ? (sub.error?.stage === 'unsubscribe' ? 'unsubscribe failed' : `${sub.error?.stage || 'action'} failed`)
    : 'already unsubscribed';

  document.getElementById('modal-title').textContent =
    `Manage emails from ${sub.senderName || sub.senderEmail}`;
  document.getElementById('modal-addresses').innerHTML = `
    <div class="modal-addr-row modal-addr-box">
      <div class="modal-kv">
        <span class="modal-kv-label">From:</span>
        <span class="modal-addr">${esc(sub.senderEmail)}</span>
      </div>
      <div class="modal-kv">
        <span class="modal-kv-label">To:</span>
        <span class="modal-addr">${esc(recipientAddress || '(unknown)')}</span>
      </div>
      <div class="modal-kv">
        <span class="modal-kv-label">Status:</span>
        <span class="modal-method">${esc(statusLabel)}</span>
      </div>
    </div>`;

  renderModalSourceFolders(sub);
  document.querySelector('.modal-dispose h4').textContent = 'Email action';
  document.querySelector('.modal-dispose').style.display = 'block';
  document.querySelector(`input[name="dispose"][value="${action || 'delete'}"]`).checked = true;
  document.getElementById('modal-dest-wrap').style.display = 'none';
  document.getElementById('modal-new-folder-form').style.display = 'none';

  const confirmBtn = document.getElementById('modal-confirm');
  confirmBtn.disabled = false;
  confirmBtn.textContent = 'Apply';
  confirmBtn.title = '';

  document.getElementById('unsub-modal-overlay').classList.add('open');
  onDisposeChange();
}

function closeUnsubModal() {
  if (modalOperationTraceId) return;
  document.getElementById('unsub-modal-overlay').classList.remove('open');
  modalSenderEmail = null;
  modalRecipientAddress = null;
  modalMode = 'unsubscribe';
  modalIsRetry = false;
  modalSelectedMethod = null;
  cleanupDefaultAction = null;
}

// Show/hide folders section and destination tree when dispose option changes
async function onDisposeChange() {
  const dispose = document.querySelector('input[name="dispose"]:checked').value;
  const foldersSection = document.getElementById('modal-folders-section');
  const destWrap = document.getElementById('modal-dest-wrap');
  const hasGroups = document.querySelectorAll('.modal-folder-check').length > 0;

  // Show source folder checkboxes for delete or move
  const showFolders = (dispose === 'delete' || dispose === 'move') && hasGroups;
  foldersSection.style.display = showFolders ? 'block' : 'none';
  if (showFolders) {
    document.getElementById('modal-folders-title').textContent = 'From folders';
  }

  if (dispose === 'move') {
    destWrap.style.display = 'block';
    // Lazy-load folder tree
    if (!folderTreeCache) {
      document.getElementById('modal-dest-tree').innerHTML =
        '<div style="padding:8px;color:var(--muted);font-size:12px">Loading folders...</div>';
      try {
        folderTreeCache = await bg('getFolderTree');
      } catch (e) {
        document.getElementById('modal-dest-tree').innerHTML =
          '<div style="padding:8px;color:var(--danger);font-size:12px">Failed to load folders.</div>';
        return;
      }
    }
    renderRelevantFolderTree();
  } else {
    destWrap.style.display = 'none';
  }
}

// Render the destination tree showing only accounts this subscription has
// messages in — a move can't target an unrelated mailbox.
function renderRelevantFolderTree() {
  const sub = subsCache.find(s => s.senderEmail === modalSenderEmail && s.recipientAddress === modalRecipientAddress);
  const relevantAccounts = new Set((sub?.messageGroups || []).map(g => g.accountName));
  renderFolderTree((folderTreeCache || []).filter(a => relevantAccounts.has(a.accountName)));
}

function renderFolderTree(tree) {
  const container = document.getElementById('modal-dest-tree');
  let html = '';
  for (const account of tree) {
    html += `<div class="tree-account" data-root-folder-id="${esc(account.rootFolderId || '')}">
      <div class="tree-account-name">${esc(account.accountName)}</div>
      ${renderFolderNodes(account.folders, 0)}
    </div>`;
  }
  container.innerHTML = html;
}

function renderFolderNodes(folders, depth) {
  let html = '';
  for (const f of folders) {
    const hasChildren = f.subFolders && f.subFolders.length > 0;
    const name = (f.name || '').toLowerCase();
    const path = (f.path || '').toLowerCase();
    const isMoveTargetDisabled =
      name === '[gmail]' ||
      path === '[gmail]' ||
      path === '/[gmail]' ||
      name === 'all mail' ||
      path === 'all mail' ||
      path.endsWith('/all mail') ||
      f.type === 'virtual';
    const indent = depth * 16;
    html += `<div class="tree-node" style="padding-left:${indent}px">
      <label class="tree-folder-label${isMoveTargetDisabled ? ' tree-folder-disabled' : ''}" title="${isMoveTargetDisabled ? 'Messages cannot be moved into this folder, but it can be the parent of a new folder' : ''}">
        ${hasChildren
          ? `<span class="tree-toggle" data-folder-id="${esc(f.id)}">&#9656;</span>`
          : '<span class="tree-spacer"></span>'}
        <input type="radio" name="dest-folder" value="${esc(f.id)}" data-folder-name="${esc(f.name)}" data-folder-path="${esc(f.path || f.name)}"${isMoveTargetDisabled ? ' data-move-disabled="1"' : ''}>
        <span class="tree-folder-name">${esc(f.name)}${isMoveTargetDisabled ? ' (cannot receive mail)' : ''}</span>
      </label>
    </div>`;
    if (hasChildren) {
      html += `<div class="tree-subtree" data-parent-id="${esc(f.id)}" style="display:none">
        ${renderFolderNodes(f.subFolders, depth + 1)}
      </div>`;
    }
  }
  return html;
}

async function createNewFolder() {
  const nameInput = document.getElementById('modal-new-folder-name');
  const name = nameInput.value.trim();
  if (!name) return;

  // Parent = the selected folder, or the account root (top-level folder)
  // when nothing is selected. Only ambiguous with multiple accounts shown.
  const destRadio = document.querySelector('input[name="dest-folder"]:checked');
  let parentFolderId = destRadio ? destRadio.value : null;
  if (!parentFolderId) {
    const accounts = document.querySelectorAll('#modal-dest-tree .tree-account');
    if (accounts.length === 1 && accounts[0].dataset.rootFolderId) {
      parentFolderId = accounts[0].dataset.rootFolderId;
    } else {
      toast('Select a parent folder first', 'info');
      return;
    }
  }

  try {
    const result = await bg('createFolder', { parentFolderId, folderName: name });
    toast(`Created folder "${name}"`, 'success');
    nameInput.value = '';
    document.getElementById('modal-new-folder-form').style.display = 'none';
    // Refresh tree and auto-select new folder
    folderTreeCache = await bg('getFolderTree');
    renderRelevantFolderTree();
    // Select the new folder
    const newRadio = document.querySelector(`input[name="dest-folder"][value="${CSS.escape(result.id)}"]`);
    if (newRadio) newRadio.checked = true;
  } catch (e) {
    toast('Failed to create folder: ' + (e.message || e), 'error');
  }
}

function getSelectedFolders() {
  const sub = subsCache.find(s => s.senderEmail === modalSenderEmail && s.recipientAddress === modalRecipientAddress);
  if (!sub) return [];
  const groups = sub.messageGroups || [];
  const checks = document.querySelectorAll('.modal-folder-check');
  if (checks.length === 0) return [];
  return [...checks]
    .filter(cb => cb.checked)
    .map(cb => {
      const g = groups[parseInt(cb.dataset.idx)];
      return { accountName: g.accountName, folderName: g.folderName, folderId: g.folderId };
    });
}

function getSelectedDestination() {
  const radio = document.querySelector('input[name="dest-folder"]:checked');
  if (!radio) return null;
  const accountEl = radio.closest('.tree-account')?.querySelector('.tree-account-name');
  const accountName = accountEl ? accountEl.textContent.trim() : '';
  const folderName = radio.dataset.folderName || radio.value;
  const folderPath = radio.dataset.folderPath || folderName;
  const folderLabel = displayFolderPath(folderPath, folderName);
  return {
    id: radio.value,
    accountName,
    folderName,
    folderPath,
    label: accountName ? `${accountName} | ${folderLabel}` : folderLabel,
    disabled: radio.dataset.moveDisabled === '1'
  };
}

function selectedMessageCount(sub, selectedFolders) {
  const groups = sub.messageGroups || [];
  if (!selectedFolders || selectedFolders.length === 0) {
    return groups.reduce((sum, g) => sum + groupMessageCount(g), 0);
  }
  return groups
    .filter(g => selectedFolders.some(f => (
      g.folderId && f.folderId
        ? g.folderId === f.folderId
        : f.accountName === g.accountName && f.folderName === g.folderName
    )))
    .reduce((sum, g) => sum + groupMessageCount(g), 0);
}

function displayFolderPath(path, fallback) {
  return String(path || fallback || '').replace(/^\/+/, '');
}

function dryRunSummary(sub, method, dispose, selectedFolders, destination) {
  if (modalMode === 'cleanup') {
    if (dispose === 'delete') return `Dry run: would delete ${selectedMessageCount(sub, selectedFolders)} emails. No changes made.`;
    if (dispose === 'move') {
      let summary = `Dry run: would move ${selectedMessageCount(sub, selectedFolders)} emails`;
      if (destination) summary += ` to ${destination.label}`;
      return `${summary}. No changes made.`;
    }
    return 'Dry run: would leave existing emails as-is. No changes made.';
  }

  let summary;
  if (!method) {
    summary = 'Dry run: no unsubscribe method is available';
  } else if (method.type === 'mail' && !autoSendUnsubscribeEmails) {
    summary = 'Dry run: would prepare an unsubscribe email draft';
  } else {
    summary = `Dry run: would unsubscribe via ${METHOD_LABELS[method.type]}`;
  }
  if (dispose === 'delete') {
    summary += ` and delete ${selectedMessageCount(sub, selectedFolders)} emails`;
  } else if (dispose === 'move') {
    summary += ` and move ${selectedMessageCount(sub, selectedFolders)} emails`;
    if (destination) summary += ` to ${destination.label}`;
  } else {
    summary += ' and keep existing emails';
  }
  return `${summary}. No changes made.`;
}

function errorPayload(stage, message) {
  return { stage, message: String(message || 'Unknown error'), at: new Date().toISOString() };
}

async function doUnsubscribeConfirm() {
  if (!modalSenderEmail) return;
  const sub = subsCache.find(s => s.senderEmail === modalSenderEmail && s.recipientAddress === modalRecipientAddress);
  if (!sub) return;

  const dispose = document.querySelector('input[name="dispose"]:checked').value;
  const selectedFolders = getSelectedFolders();
  const method = modalSelectedMethod || getBestMethod(sub);
  const destination = dispose === 'move' ? getSelectedDestination() : null;
  const trace = createTrace('unsubscribe', {
    mode: modalMode,
    method: method?.type || 'none',
    dispose,
    selectedFolders: selectedFolders.length,
    selectedMessages: selectedMessageCount(sub, selectedFolders)
  });

  // Validate the move destination before anything fires — especially the
  // unsubscribe request, which cannot be taken back.
  if (dispose === 'move' && selectedFolders.length > 0) {
    if (!destination) {
      toast('Select a destination folder', 'info');
      return;
    }
    if (destination.disabled) {
      toast('Select an available destination folder', 'info');
      return;
    }
  }

  const confirmBtn = document.getElementById('modal-confirm');
  confirmBtn.disabled = true;
  confirmBtn.textContent = 'Checking...';
  showModalProgress(trace.id, modalMode === 'cleanup' ? 'Preparing cleanup...' : 'Sending unsubscribe request...', 5);

  try {
    const result = await trace.bg('getDryRun');
    dryRun = result.dryRun === true;
    document.getElementById('dry-run-toggle').checked = dryRun;
  } catch (e) {
    dryRun = false;
    document.getElementById('dry-run-toggle').checked = false;
  }

  if (modalCancelRequested) {
    finishModalCancellation(trace);
    return;
  }

  if (dryRun) {
    toast(dryRunSummary(sub, method, dispose, selectedFolders, destination), 'info');
    confirmBtn.disabled = false;
    confirmBtn.textContent = modalConfirmLabel();
    resetModalProgress();
    closeUnsubModal();
    trace.log('unsubscribe:dry-run-complete');
    return;
  }

  confirmBtn.textContent = 'Unsubscribing...';

  // Fire unsubscribe
  let ok = false;
  let unsubscribeResult = null;
  if (modalMode === 'cleanup') {
    ok = true;
    confirmBtn.textContent = 'Applying...';
  } else if (method) {
    try {
      if (method.type === 'oneclick') {
        const r = await trace.bg('unsubOneClick', { url: method.url });
        unsubscribeResult = r;
        ok = r.ok;
      } else if (method.type === 'mail') {
        unsubscribeResult = await trace.bg('unsubMail', { url: method.url, senderEmail: modalSenderEmail });
        ok = true;
      } else if (method.type === 'embedded') {
        unsubscribeResult = await trace.bg('unsubEmbedded', { url: method.url });
        ok = true;
      } else {
        unsubscribeResult = await trace.bg('unsubWeb', { url: method.url });
        ok = true;
      }
    } catch (e) {
      ok = false;
    }
  }

  if (modalCancelRequested) {
    if (modalMode !== 'cleanup' && ok) {
      await trace.bg('decide', {
        senderEmail: modalSenderEmail,
        recipientAddress: modalRecipientAddress,
        decision: 'unsubscribed',
        dispose: null
      });
    }
    finishModalCancellation(trace, ok && modalMode !== 'cleanup'
      ? 'Unsubscribed; remaining actions cancelled'
      : 'Operation cancelled');
    return;
  }

  if (!ok) {
    const message = method ? 'Unsubscribe request failed' : 'No unsubscribe method is available';
    await trace.bg('decide', {
      senderEmail: modalSenderEmail,
      recipientAddress: modalRecipientAddress,
      decision: 'error',
      dispose,
      error: errorPayload('unsubscribe', message)
    });
    updateDecisionStats(sub.decision, 'error');
    sub.decision = 'error';
    toast(message, 'error');
    confirmBtn.disabled = false;
    confirmBtn.textContent = modalConfirmLabel();
    showErrorsView();
    trace.log('unsubscribe:failed', undefined, { stage: 'unsubscribe' });
    resetModalProgress();
    closeUnsubModal();
    return;
  }

  // Outcome of the unsubscribe step itself, independent of cleanup: a real
  // unsubscribe → unsubscribed; a standalone cleanup keeps the prior decision.
  const outcomeDecision = modalMode === 'cleanup' ? (sub.decision || 'unsubscribed') : 'unsubscribed';

  // A cleanup (delete/move) failure is NOT an unsubscribe failure — the
  // unsubscribe already succeeded. Keep the unsubscribe outcome, leave the
  // emails in place (dispose: null), and let the Cleanup button retry.
  async function handleCleanupFailure(stage, e) {
    await trace.bg('decide', {
      senderEmail: modalSenderEmail,
      recipientAddress: modalRecipientAddress,
      decision: outcomeDecision,
      dispose: null,
      error: outcomeDecision === 'error' ? sub.error : undefined
    });
    updateDecisionStats(sub.decision, outcomeDecision);
    sub.decision = outcomeDecision;
    const msg = modalMode === 'cleanup'
      ? `Cleanup failed while ${stage} emails: ${e.message || e}. Use Cleanup to retry.`
      : `Unsubscribed, but ${stage} emails failed: ${e.message || e}. Use Cleanup to retry.`;
    toast(msg, 'error');
    confirmBtn.disabled = false;
    confirmBtn.textContent = modalConfirmLabel();
    resetModalProgress();
    closeUnsubModal();
    loadSubs(currentFilter);
    trace.log('unsubscribe:cleanup-failed', undefined, { stage });
  }

  // Apply dispose action on selected folders
  let cleanupResult = null;
  if (dispose === 'delete' && selectedFolders.length > 0) {
    try {
      const result = await trace.bg('deleteEmails', {
        senderEmail: modalSenderEmail,
        recipientAddress: modalRecipientAddress,
        messageGroups: sub.messageGroups,
        selectedFolders
      });
      cleanupResult = result;
      if (result?.dryRun) toast(`Dry run: would delete ${result.deleted || 0} emails`, 'info');
      if (result?.cancelled && !result.actionCompleted) {
        if (modalMode !== 'cleanup') {
          await trace.bg('decide', {
            senderEmail: modalSenderEmail,
            recipientAddress: modalRecipientAddress,
            decision: outcomeDecision,
            dispose: null,
            error: outcomeDecision === 'error' ? sub.error : undefined
          });
        }
        finishModalCancellation(trace);
        return;
      }
    } catch (e) {
      await handleCleanupFailure('deleting', e);
      return;
    }
  } else if (dispose === 'move' && selectedFolders.length > 0) {
    try {
      const result = await trace.bg('moveEmails', {
        senderEmail: modalSenderEmail,
        recipientAddress: modalRecipientAddress,
        messageGroups: sub.messageGroups,
        selectedFolders,
        destinationFolderId: destination.id,
        destination
      });
      cleanupResult = result;
      if (result?.dryRun) {
        toast(`Dry run: would move ${result.moved || 0} emails`, 'info');
      }
      if (result?.cancelled && !result.actionCompleted) {
        if (modalMode !== 'cleanup') {
          await trace.bg('decide', {
            senderEmail: modalSenderEmail,
            recipientAddress: modalRecipientAddress,
            decision: outcomeDecision,
            dispose: null,
            error: outcomeDecision === 'error' ? sub.error : undefined
          });
        }
        finishModalCancellation(trace);
        return;
      }
    } catch (e) {
      await handleCleanupFailure('moving', e);
      return;
    }
  }

  // Finalize decision (cleanup succeeded or nothing to dispose).
  try {
    await trace.bg('decide', {
      senderEmail: modalSenderEmail,
      recipientAddress: modalRecipientAddress,
      decision: outcomeDecision,
      dispose,
      cleanupDestination: destination,
      error: outcomeDecision === 'error' ? sub.error : undefined
    });
  } catch (e) {
    toast('Error: ' + (e.message || e), 'error');
    confirmBtn.disabled = false;
    confirmBtn.textContent = modalConfirmLabel();
    trace.log('unsubscribe:failed', undefined, { stage: 'persist-decision' });
    resetModalProgress();
    return;
  }

  if (modalCancelRequested) {
    finishModalCancellation(trace, 'Current action completed before cancellation');
    return;
  }
  if (cleanupResult?.messageGroups) {
    sub.messageGroups = cleanupResult.messageGroups;
    sub.emailCount = cleanupResult.emailCount;
  }
  sub.dispose = dispose;
  sub.cleanupDestination = destination;
  updateCachedDecision(sub, outcomeDecision);

  const name = sub.senderName || sub.senderEmail;
  if (modalMode === 'cleanup') {
    toast(`Updated email cleanup for ${name}`, 'success');
  } else if (unsubscribeResult?.drafted) {
    toast(`Prepared unsubscribe email draft for ${name}`, 'success');
  } else if (unsubscribeResult?.sent) {
    toast(`Sent unsubscribe email for ${name}`, 'success');
  } else if (ok) {
    toast(`Unsubscribed from ${name}`, 'success');
  } else {
    toast(`Unsubscribed from ${name} (request may have failed)`, 'error');
  }

  showModalProgress(trace.id, 'Complete', 100);
  resetModalProgress();
  closeUnsubModal();
  trace.log('unsubscribe:complete');
}

// ── Keep action ──────────────────────────────────────────────────────────────
async function doKeep(senderEmail, recipientAddress) {
  const sub = subsCache.find(s => s.senderEmail === senderEmail && s.recipientAddress === recipientAddress);
  if (!sub) return;

  try {
    await bg('decide', { senderEmail, recipientAddress, decision: 'keep', dispose: null });
    toast(`Kept subscription ${senderEmail}`, 'success');
    updateCachedDecision(sub, 'keep');
  } catch (e) {
    toast('Error: ' + e.message, 'error');
  }
}

async function doPending(senderEmail, recipientAddress) {
  const sub = subsCache.find(s => s.senderEmail === senderEmail && s.recipientAddress === recipientAddress);
  if (!sub) return;
  try {
    await bg('decide', { senderEmail, recipientAddress, decision: 'pending', dispose: null });
    toast(`Moved ${senderEmail} back to pending`, 'success');
    updateCachedDecision(sub, 'pending');
  } catch (e) {
    toast('Error: ' + (e.message || e), 'error');
  }
}

function showErrorsView() {
  const errorTab = document.querySelector('.filter-tab[data-filter="error"]');
  if (errorTab) setFilter('error', errorTab);
  else loadSubs('error');
}

// ── Filter ───────────────────────────────────────────────────────────────────
function setFilter(filter, btn) {
  currentFilter = filter;
  document.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');

  const titles = { pending: 'Pending', keep: 'Kept', unsubscribed: 'Unsubscribed', error: 'Errors' };
  document.getElementById('main-title').textContent = titles[filter] || filter;
  loadSubs(filter);
}

// ── Scan ─────────────────────────────────────────────────────────────────────
async function startScan() {
  const btn = document.getElementById('scan-btn');
  btn.disabled = true;
  btn.textContent = 'Scanning...';
  scanInProgress = true;
  document.getElementById('scan-last').textContent = '';
  document.getElementById('progress-wrap').style.display = 'block';
  document.getElementById('progress-bar').style.width = '0';
  const msgEl = document.getElementById('scan-msg');
  msgEl.textContent = 'Starting...';
  msgEl.classList.remove('wrap');
  document.getElementById('scan-state-badge').textContent = '';
  document.getElementById('scan-state-badge').className = '';
  document.getElementById('scan-stat-emails').textContent = '';
  document.getElementById('scan-stat-subs').textContent = '';
  document.getElementById('scan-controls').style.display = 'flex';

  try {
    await bg('scan');
    pollScanStatus();
  } catch (e) {
    toast('Failed to start scan: ' + e.message, 'error');
    scanInProgress = false;
    btn.disabled = false;
    refreshScanButtonLabel();
    document.getElementById('scan-controls').style.display = 'none';
  }
}

function pollScanStatus() {
  if (scanPollTimer) clearInterval(scanPollTimer);
  scanPollTimer = setInterval(async () => {
    try {
      const s = await bg('getScanStatus');
      const pct = s.total > 0 ? Math.round(s.progress / s.total * 100) : 0;
      document.getElementById('progress-bar').style.width = pct + '%';

      const msgEl = document.getElementById('scan-msg');
      const badgeEl = document.getElementById('scan-state-badge');
      document.getElementById('scan-stat-emails').textContent = (s.messagesScanned || 0).toLocaleString() + ' emails scanned';
      document.getElementById('scan-stat-subs').textContent = (s.sendersFound || 0) + ' subscriptions found';
      document.getElementById('pause-btn').textContent = s.paused ? 'Resume' : 'Pause';

      if (s.status === 'done' || s.done) {
        clearInterval(scanPollTimer);
        scanPollTimer = null;
        scanInProgress = false;
        document.getElementById('scan-btn').disabled = false;
        hasScannedBefore = true;
        refreshScanButtonLabel();
        document.getElementById('progress-bar').style.width = '100%';
        document.getElementById('scan-controls').style.display = 'none';
        document.getElementById('pause-btn').textContent = 'Pause';
        document.getElementById('stop-btn').disabled = false;
        document.getElementById('stop-btn').textContent = 'Stop';
        msgEl.textContent = s.message || 'Done.';
        msgEl.classList.add('wrap');
        badgeEl.textContent = '';
        badgeEl.className = '';
        loadStats();
        loadSubs(currentFilter);
        const interrupted = s.message === 'Scan interrupted.';
        toast(`${s.message} Found ${s.sendersFound || 0} subscriptions.`, interrupted ? 'info' : 'success');
      } else {
        msgEl.textContent = s.message || '';
        msgEl.classList.remove('wrap');
        if (s.paused) {
          badgeEl.textContent = 'Paused';
          badgeEl.className = 'badge-paused';
        } else {
          badgeEl.textContent = '';
          badgeEl.className = '';
        }
      }
    } catch (e) { /* ignore */ }
  }, 1000);
}

// ── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  document.getElementById('scan-btn').addEventListener('click', startScan);
  document.getElementById('dry-run-toggle').addEventListener('change', (e) => {
    updateDryRun(e.target.checked);
  });
  document.getElementById('auto-send-email-toggle').addEventListener('change', (e) => {
    updateAutoSendUnsubscribeEmails(e.target.checked);
  });
  document.getElementById('full-reset-btn').addEventListener('click', doFullReset);
  attachCardListeners();

  document.getElementById('modal-cancel').addEventListener('click', cancelOrCloseUnsubModal);
  document.getElementById('modal-confirm').addEventListener('click', doUnsubscribeConfirm);
  document.getElementById('unsub-modal-overlay').addEventListener('click', (e) => {
    if (e.target.id === 'unsub-modal-overlay') closeUnsubModal();
  });

  // Dispose radio change → show/hide folder tree
  document.querySelectorAll('input[name="dispose"]').forEach(r => {
    r.addEventListener('change', onDisposeChange);
  });

  // Folder tree toggle (expand/collapse) — delegated
  document.getElementById('modal-dest-tree').addEventListener('click', (e) => {
    const toggle = e.target.closest('.tree-toggle');
    if (!toggle) return;
    const folderId = toggle.dataset.folderId;
    const subtree = document.querySelector(`.tree-subtree[data-parent-id="${CSS.escape(folderId)}"]`);
    if (!subtree) return;
    const open = subtree.style.display !== 'none';
    subtree.style.display = open ? 'none' : 'block';
    toggle.innerHTML = open ? '&#9656;' : '&#9662;';
  });

  // New folder UI
  document.getElementById('modal-new-folder-btn').addEventListener('click', () => {
    const form = document.getElementById('modal-new-folder-form');
    form.style.display = form.style.display === 'none' ? 'flex' : 'none';
    if (form.style.display === 'flex') document.getElementById('modal-new-folder-name').focus();
  });
  document.getElementById('modal-create-folder-btn').addEventListener('click', createNewFolder);
  document.getElementById('modal-new-folder-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') createNewFolder();
  });

  document.getElementById('pause-btn').addEventListener('click', async () => {
    const r = await bg('pauseScan');
    document.getElementById('pause-btn').textContent = r.paused ? 'Resume' : 'Pause';
  });

  document.getElementById('stop-btn').addEventListener('click', async () => {
    if (!confirm('Stop the scan? Progress so far will be saved.')) return;
    document.getElementById('stop-btn').disabled = true;
    document.getElementById('stop-btn').textContent = 'Stopping...';
    await bg('stopScan');
  });

  document.querySelectorAll('.filter-tab').forEach(tab => {
    tab.addEventListener('click', () => setFilter(tab.dataset.filter, tab));
  });
  document.getElementById('recipient-filter').addEventListener('change', (e) => {
    currentRecipientFilter = e.target.value;
    renderFilteredCards();
  });
  document.getElementById('sort-select').addEventListener('change', (e) => {
    currentSort = e.target.value;
    renderFilteredCards();
  });

  await loadDryRun();
  await loadAutoSendUnsubscribeEmails();
  await loadStats();
  await loadSubs('pending');

  try {
    const s = await bg('getScanStatus');
    if (s.status === 'scanning') {
      scanInProgress = true;
      document.getElementById('scan-last').textContent = '';
      document.getElementById('progress-wrap').style.display = 'block';
      document.getElementById('scan-controls').style.display = 'flex';
      document.getElementById('scan-btn').disabled = true;
      document.getElementById('scan-btn').textContent = 'Scanning...';
      document.getElementById('pause-btn').textContent = s.paused ? 'Resume' : 'Pause';
      if (s.paused) {
        document.getElementById('scan-state-badge').textContent = 'Paused';
        document.getElementById('scan-state-badge').className = 'badge-paused';
      }
      pollScanStatus();
    }
  } catch (e) { /* ignore */ }
});
