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
let activityQueue = [];
let activeActivityJob = null;
let recentActivityJobs = [];
let nextActivityJobId = 1;
let activityModalJobId = null;

// The scan button reads "Rescan Emails" once a scan has produced data, else
// "Scan Emails". Only touches the label while the button is idle so it never
// clobbers "Scanning..." mid-scan.
function refreshScanButtonLabel() {
  const btn = document.getElementById('scan-btn');
  if (!btn || btn.disabled) return;
  btn.textContent = hasScannedBefore ? 'Rescan Emails' : 'Scan Emails';
}

// ── Utils ────────────────────────────────────────────────────────────────────
// All UI is built with this element helper — never innerHTML — so strings
// from emails can only ever become text nodes; no string is parsed as HTML
// anywhere in the page. Children may be elements, strings/numbers (text),
// or nested arrays; null/undefined/false children are dropped, so
// `cond && el(...)` works. Attribute values go through setAttribute
// (boolean true sets an empty attribute, false/null omits it), and
// event-handler attributes are rejected — listeners are attached with
// addEventListener only.
const URL_ATTRS = new Set(['href', 'src', 'xlink:href', 'action', 'formaction', 'poster', 'background']);
const UNSAFE_URL_SCHEME = /^\s*(?:javascript|data|vbscript):/i;

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (/^on/i.test(name)) throw new Error(`Refusing event-handler attribute: ${name}`);
    // No URL-bearing attribute in this UI carries untrusted data today, but
    // guard the scheme so a future href/src built from email content can't
    // smuggle javascript:/data: past the no-innerHTML rule.
    if (URL_ATTRS.has(name.toLowerCase()) && UNSAFE_URL_SCHEME.test(String(value))) {
      throw new Error(`Refusing unsafe ${name} value: ${value}`);
    }
    node.setAttribute(name, value === true ? '' : String(value));
  }
  node.append(...children.flat(Infinity).filter(c => c !== null && c !== undefined && c !== false));
  return node;
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

function activityJobLabel(job) {
  const sub = subsCache.find(s => s.senderEmail === job.senderEmail && s.recipientAddress === job.recipientAddress);
  return sub?.senderName || job.senderEmail;
}

function isActivityJobFor(job, sub) {
  return job?.senderEmail === sub.senderEmail && job?.recipientAddress === (sub.recipientAddress || '');
}

function isSubscriptionProcessing(sub) {
  return isActivityJobFor(activeActivityJob, sub) || activityQueue.some(job => isActivityJobFor(job, sub));
}

function syncProcessingFlags() {
  for (const sub of subsCache) sub.processing = isSubscriptionProcessing(sub);
}

function allActivityJobs() {
  return [
    ...(activeActivityJob ? [activeActivityJob] : []),
    ...activityQueue,
    ...recentActivityJobs,
  ];
}

function findActivityJob(jobId) {
  return allActivityJobs().find(job => job.id === jobId);
}

function activityStatus(job) {
  if (job.status === 'queued') return { label: 'Queued', className: 'running' };
  if (job.status === 'running') return { label: job.cancelRequested ? 'Cancelling' : 'Running', className: 'running' };
  if (job.status === 'complete') return { label: 'Done', className: 'done' };
  if (job.status === 'cancelled') return { label: 'Cancelled', className: 'cancelled' };
  return { label: 'Error', className: 'error' };
}

function renderActivityQueue() {
  const section = document.getElementById('activity-section');
  const list = document.getElementById('activity-list');
  if (!section || !list) return;

  const jobs = allActivityJobs();
  section.classList.toggle('open', jobs.length > 0);
  list.replaceChildren(...jobs.map(job => {
    const status = activityStatus(job);
    return el('div', { class: 'activity-item js-open-activity', 'data-job-id': job.id, title: 'View activity details' },
      el('div', { class: 'activity-row' },
        el('div', { class: 'activity-name', title: activityJobLabel(job) }, activityJobLabel(job)),
        el('div', { class: 'activity-actions' },
          el('div', { class: `activity-status ${status.className}` }, status.label),
          (job.status === 'complete' || job.status === 'failed' || job.status === 'cancelled') && el('button', {
            class: 'activity-dismiss js-dismiss-activity',
            title: 'Dismiss activity item',
            'aria-label': 'Dismiss activity item',
            'data-job-id': job.id
          }, 'x'))),
      el('div', { class: 'activity-detail', title: job.message || '' }, job.message || 'Waiting...'),
      (job.status === 'queued' || job.status === 'running') && el('div', { class: 'activity-progress-track' },
        el('div', { class: 'activity-progress-bar', style: `width:${Math.max(0, Math.min(100, job.progress || 0))}%` })));
  }));
}

function setActivityJobProgress(job, message, progress) {
  job.message = message;
  if (Number.isFinite(progress)) job.progress = progress;
  renderActivityQueue();
  if (activityModalJobId === job.id) renderActivityModal(job);
}

function clearProcessingFlag(job) {
  const sub = subsCache.find(s => s.senderEmail === job.senderEmail && s.recipientAddress === job.recipientAddress);
  if (sub) {
    sub.processing = false;
    renderFilteredCards();
  }
}

function enqueueActivityJob(job) {
  const queuedJob = {
    id: nextActivityJobId++,
    status: 'queued',
    progress: 0,
    message: 'Waiting...',
    ...job
  };
  const sub = subsCache.find(s => s.senderEmail === queuedJob.senderEmail && s.recipientAddress === queuedJob.recipientAddress);
  if (sub && isSubscriptionProcessing(sub)) {
    toast('That subscription is already processing', 'info');
    return;
  }
  if (sub) {
    sub.processing = true;
    renderFilteredCards();
  }
  activityQueue.push(queuedJob);
  renderActivityQueue();
  runNextActivityJob();
}

async function runNextActivityJob() {
  if (activeActivityJob || activityQueue.length === 0) return;
  activeActivityJob = activityQueue.shift();
  activeActivityJob.status = 'running';
  renderActivityQueue();
  try {
    await processActivityJob(activeActivityJob);
  } catch (e) {
    activeActivityJob.status = 'failed';
    setActivityJobProgress(activeActivityJob, `Failed: ${e.message || e}`, 100);
    clearProcessingFlag(activeActivityJob);
  }
  const finishedJob = activeActivityJob;
  activeActivityJob = null;
  recentActivityJobs = [finishedJob, ...recentActivityJobs];
  renderActivityQueue();
  runNextActivityJob();
}

function dismissActivityJob(jobId) {
  recentActivityJobs = recentActivityJobs.filter(job => job.id !== jobId);
  if (activityModalJobId === jobId) closeActivityModal();
  renderActivityQueue();
}

function clearActivityQueue() {
  activityQueue = [];
  activeActivityJob = null;
  recentActivityJobs = [];
  closeActivityModal();
  renderActivityQueue();
}

function activityDetailRows(job) {
  const method = job.method ? `${METHOD_LABELS[job.method.type] || job.method.type}: ${job.method.url}` : 'None';
  const dispose = DISPOSE_LABELS[job.dispose] || job.dispose || 'None';
  const folderText = job.selectedFolders?.length
    ? job.selectedFolders.map(f => `${f.accountName} | ${f.folderName}`).join(', ')
    : 'All current folders';
  const rows = [
    ['Status', activityStatus(job).label],
    ['From', job.senderEmail],
    ['To', job.recipientAddress || '(unknown)'],
    ['Mode', job.mode === 'cleanup' ? 'Cleanup' : 'Unsubscribe'],
    ['Method', method],
    ['Email action', dispose],
    ['Messages', String(job.selectedMessages || 0)],
    ['Folders', folderText],
  ];
  if (job.destination) rows.push(['Destination', job.destination.label || job.destination.folderName || job.destination.id]);
  if (job.traceId) rows.push(['Trace', job.traceId]);
  return rows;
}

function renderActivityModal(job) {
  const title = document.getElementById('activity-modal-title');
  const body = document.getElementById('activity-modal-body');
  const cancelBtn = document.getElementById('activity-modal-cancel-job');
  if (!title || !body || !cancelBtn) return;

  title.textContent = activityJobLabel(job);
  body.replaceChildren(
    el('div', { class: 'activity-modal-detail' },
      activityDetailRows(job).map(([label, value]) =>
        el('div', { class: 'activity-modal-row' },
          el('div', { class: 'activity-modal-label' }, label),
          el('div', { class: 'activity-modal-value' }, value))),
      el('div', { class: 'activity-modal-message' }, job.message || 'Waiting...')));

  const cancellable = job.status === 'queued' || job.status === 'running';
  cancelBtn.style.display = cancellable ? '' : 'none';
  cancelBtn.disabled = job.cancelRequested === true;
  cancelBtn.textContent = job.cancelRequested ? 'Cancelling...' : 'Cancel Job';
}

function openActivityModal(jobId) {
  const job = findActivityJob(jobId);
  if (!job) return;
  activityModalJobId = jobId;
  renderActivityModal(job);
  document.getElementById('activity-modal-overlay').classList.add('open');
}

function closeActivityModal() {
  activityModalJobId = null;
  document.getElementById('activity-modal-overlay')?.classList.remove('open');
}

async function cancelActivityJob(jobId) {
  const job = findActivityJob(jobId);
  if (!job || job.status === 'complete' || job.status === 'failed' || job.status === 'cancelled') return;

  if (job.status === 'queued') {
    activityQueue = activityQueue.filter(candidate => candidate !== job);
    job.status = 'cancelled';
    job.message = 'Cancelled before it started';
    job.progress = 100;
    recentActivityJobs = [job, ...recentActivityJobs];
    clearProcessingFlag(job);
    renderActivityQueue();
    renderActivityModal(job);
    runNextActivityJob();
    return;
  }

  job.cancelRequested = true;
  setActivityJobProgress(job, job.message ? `${job.message} (cancelling...)` : 'Cancelling...');
  renderActivityModal(job);
  if (job.traceId) {
    try {
      await bg('cancelOperation', { traceId: job.traceId });
    } catch (e) {
      job.cancelRequested = false;
      setActivityJobProgress(job, `Failed to request cancellation: ${e.message || e}`);
      toast('Failed to request cancellation: ' + (e.message || e), 'error');
    }
  }
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
    clearActivityQueue();

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
    document.getElementById('stat-subemails').textContent = (s.subscriptionEmails || 0).toLocaleString();
    document.getElementById('stat-total').textContent = s.total;
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
    pending: ['fb-pending'],
    keep: ['fb-keep'],
    unsubscribed: ['fb-unsubscribed'],
    error: ['fb-error']
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
      pending: ['fb-pending'],
      keep: ['fb-keep'],
      unsubscribed: ['fb-unsubscribed'],
      error: ['fb-error']
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
  grid.replaceChildren(el('div', { id: 'loading' }, el('div', { class: 'spinner' }), 'Loading...'));
  document.getElementById('empty-state').style.display = 'none';

  try {
    const subs = await bg('getSubscriptions', { filter: filter === 'all' ? null : filter });
    subsCache = subs;
    syncProcessingFlags();
    refreshRecipientFilter();
    renderFilteredCards();
  } catch (e) {
    grid.replaceChildren(el('div', { style: 'color:var(--danger);padding:40px' }, 'Failed to load.'));
  }
}

function refreshRecipientFilter() {
  const select = document.getElementById('recipient-filter');
  const recipients = [...new Set(subsCache.map(s => s.recipientAddress || '').filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
  if (currentRecipientFilter && !recipients.includes(currentRecipientFilter)) {
    currentRecipientFilter = '';
  }
  select.replaceChildren(el('option', { value: '' }, 'All receiving addresses'));
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
    grid.replaceChildren();
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';
  grid.replaceChildren(...subs.map(s => buildCard(s)));
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
// Native <select> popups size themselves to their widest option, and
// unsubscribe URLs routinely run hundreds of characters. Keep the start
// (scheme + domain) and the tail (where tracking tokens differ between
// otherwise-identical URLs); the full URL of the selected method is shown
// in the method-help line under the method. Do not add title tooltips
// to the options — confirmed buggy in Thunderbird 140 (tooltips render
// detached from the cursor and linger after hovering away).
function truncateMiddle(s, max = 64) {
  const str = String(s || '');
  if (str.length <= max) return str;
  return `${str.slice(0, max - 16)}…${str.slice(-15)}`;
}

function methodDetail(method) {
  if (!method) return 'No unsubscribe method was detected for this sender.';
  switch (method.type) {
    case 'oneclick':
      return `One-click unsubscribe - Sends a secure POST request to: ${method.url}`;
    case 'web':
      return `Browser unsubscribe - Opens this page in your browser: ${method.url}`;
    case 'embedded':
      return `Embedded link - Opens this link from the email body: ${method.url}`;
    case 'mail': {
      const addr = method.url.replace(/^mailto:/i, '').split('?')[0];
      return `Email unsubscribe - Sends an unsubscribe email to: ${addr}`;
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
    return [el('div', { class: 'evidence-empty' }, 'No per-message detection evidence is available. Run a new scan.')];
  }
  return evidence.map(e => {
    const urls = [...(e.headerUrls || []), ...(e.embeddedUrl ? [e.embeddedUrl] : [])];
    return el('div', { class: 'evidence-item' },
      el('div', { class: 'evidence-heading' },
        (e.sources || []).map(source =>
          el('span', { class: `badge ${source === 'header' ? 'badge-green' : 'badge-purple'}` }, source)),
        el('span', {}, e.subject || '(no subject)')),
      el('div', { class: 'evidence-meta' },
        el('span', {}, `${e.accountName || ''} | ${e.folderName || ''}`),
        el('span', {}, `Receiver source: ${e.recipientSource || 'unknown'}`),
        el('span', {}, e.author || ''),
        el('span', {}, e.date ? new Date(e.date).toLocaleString() : '')),
      urls.length > 0 && el('div', { class: 'evidence-urls' }, urls.map(url => el('div', {}, url))),
      e.headerMessageId && el('div', { class: 'evidence-message-id' }, `Message-ID: ${e.headerMessageId}`));
  });
}

// ── Build card ───────────────────────────────────────────────────────────────
function buildActions(s) {
  const attrs = { 'data-sender-email': s.senderEmail, 'data-recipient-address': s.recipientAddress || '' };
  const reviewTitle = 'Move this subscription back to Pending for review.';
  const btn = (cls, label, title) => el('button', { class: cls, title, ...attrs }, label);

  if (s.processing) {
    return [el('span', { class: 'action-note' }, 'Processing in Activity...')];
  }

  if (s.decision === 'keep') {
    return [
      btn('btn btn-view js-view', 'View'),
      btn('btn btn-keep js-unkeep', 'Review Again', reviewTitle)
    ];
  }

  if (s.decision === 'unsubscribed' || s.decision === 'error') {
    // View and Cleanup act on stored messages; with none left they can only fail.
    const messageButtons = subHasMessages(s) ? [
      btn('btn btn-view js-view', 'View'),
      btn('btn btn-outline js-cleanup', 'Cleanup')
    ] : [];
    return [
      ...messageButtons,
      btn('btn btn-unsub js-retry', 'Retry'),
      btn('btn btn-keep js-reset-pending', 'Review Again', reviewTitle)
    ];
  }

  return [
    btn('btn btn-view js-view', 'View'),
    btn('btn btn-keep js-keep', 'Keep Subscription'),
    btn('btn btn-unsub js-open-modal', 'Unsubscribe')
  ];
}

function buildCard(s) {
  const groups = s.messageGroups || [];
  const byAccount = groupsByAccount(groups);
  const color = avatarColor(s.senderEmail);
  const ini = initials(s.senderName, s.senderEmail);
  const id = sid(s.senderEmail, s.recipientAddress);
  const accountNames = Object.keys(byAccount);

  // Badges
  const badges = [el('span', { class: 'badge badge-blue' }, `${s.emailCount} emails`)];
  if (s.processing) badges.push(el('span', { class: 'badge badge-processing' }, 'Processing'));
  if (s.decision === 'keep') badges.push(el('span', { class: 'badge badge-kept' }, 'Kept'));
  if (s.decision === 'unsubscribed') {
    badges.push(el('span', { class: 'badge badge-unsub' }, 'Unsubscribed'));
    if (s.dispose && DISPOSE_LABELS[s.dispose]) badges.push(el('span', { class: 'badge badge-neutral' }, DISPOSE_LABELS[s.dispose]));
  }
  if (s.decision === 'error') badges.push(el('span', { class: 'badge badge-error' }, 'Error'));

  const dateStr = s.lastDate ? new Date(s.lastDate).toLocaleDateString() : '';
  const dismissable = s.decision === 'unsubscribed' || s.decision === 'error';
  const attrs = { 'data-sender-email': s.senderEmail, 'data-recipient-address': s.recipientAddress || '' };

  return el('div', { class: `card${s.processing ? ' processing' : ''}`, id: `card-${id}`, ...attrs },
    el('div', { class: 'card-body' },
      dismissable && el('button', {
        class: 'card-dismiss js-dismiss',
        title: 'Dismiss and stop tracking this subscription',
        'aria-label': 'Dismiss and stop tracking this subscription',
        ...attrs
      }, '\u{1F5D1}'),
      s.decision === 'pending' && subHasMessages(s) && el('button', {
        class: 'card-dismiss js-junk',
        title: 'Phishing or spam? Mark all emails as junk and move them to spam — trains your filters, and the sender is never contacted',
        'aria-label': 'Mark all emails as junk and move them to spam',
        ...attrs
      }, '\u{1F525}'),
      el('div', { class: 'card-top' },
        el('div', { class: 'avatar', style: `background:${color}` }, ini),
        el('div', { class: 'card-info' },
          el('div', { class: 'sender-name', title: s.senderName }, s.senderName || '(no name)'),
          el('div', { class: 'sender-email', title: s.senderEmail }, s.senderEmail))),
      el('div', { class: 'card-badges' }, badges),
      el('div', { class: 'card-meta' },
        el('span', {}, dateStr),
        el('span', {}, accountNames.join(', '))),
      s.recipientAddress && el('div', { class: 'card-accounts', title: `Delivered to ${s.recipientAddress}` }, `→ ${s.recipientAddress}`),
      s.sampleSubject && el('div', { class: 'card-subject', title: s.sampleSubject }, `"${s.sampleSubject.substring(0, 80)}"`),
      s.error?.message && el('div', { class: 'card-error', title: s.error.message }, `${s.error.stage || 'Error'}: ${s.error.message}`),
      SHOW_DETECTION_UI && el('button', { class: 'evidence-toggle js-evidence-toggle', type: 'button' }, 'Why detected?')),
    SHOW_DETECTION_UI && el('div', { class: 'detection-evidence' }, buildDetectionEvidence(s)),
    el('div', { class: 'card-actions' }, buildActions(s)));
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
let modalProgressMessage = 'Working...';

function renderModalProgressText() {
  document.getElementById('modal-progress-text').textContent = modalCancelRequested
    ? `${modalProgressMessage} (cancelling after this action)`
    : modalProgressMessage;
}

function resetModalProgress() {
  modalOperationTraceId = null;
  modalCancelRequested = false;
  modalProgressMessage = 'Working...';
  const progress = document.getElementById('modal-progress');
  progress.classList.remove('active');
  document.getElementById('modal-progress-bar').style.width = '0';
  renderModalProgressText();
  const cancelBtn = document.getElementById('modal-cancel');
  cancelBtn.disabled = false;
  cancelBtn.textContent = 'Cancel';
}

function showModalProgress(traceId, message, percent) {
  modalOperationTraceId = traceId;
  document.getElementById('modal-progress').classList.add('active');
  modalProgressMessage = message;
  renderModalProgressText();
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
  renderModalProgressText();
  try {
    await bg('cancelOperation', { traceId: modalOperationTraceId });
  } catch (e) {
    toast('Failed to request cancellation: ' + (e.message || e), 'error');
    modalCancelRequested = false;
    cancelBtn.disabled = false;
    cancelBtn.textContent = 'Cancel';
    renderModalProgressText();
  }
}

function finishModalCancellation(trace, message = 'Operation cancelled') {
  const confirmBtn = document.getElementById('modal-confirm');
  confirmBtn.disabled = false;
  confirmBtn.textContent = modalConfirmLabel();
  resetModalProgress();
  closeUnsubModal();
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
  if (request.command !== 'cleanupProgress') return;
  const percent = cleanupProgressPercent(request.phase, request.current, request.total);
  if (request.traceId === modalOperationTraceId) {
    showModalProgress(request.traceId, request.message || 'Working...', percent);
    return;
  }
  if (activeActivityJob?.traceId === request.traceId) {
    setActivityJobProgress(activeActivityJob, request.message || 'Working...', percent);
  }
});

function modalConfirmLabel() {
  if (modalMode === 'cleanup') return 'Apply';
  return modalIsRetry ? 'Retry' : 'Unsubscribe';
}

function renderModalSourceFolders(sub) {
  const groups = sub.messageGroups || [];
  const foldersSection = document.getElementById('modal-folders-section');
  const foldersEl = document.getElementById('modal-folders');

  foldersEl.replaceChildren(...groups.map((g, i) =>
    el('label', { class: 'modal-folder-row' },
      el('input', { type: 'checkbox', class: 'modal-folder-check', 'data-idx': i, checked: true }),
      el('span', { class: 'modal-folder-name' }, `${g.accountName} | ${g.folderName}`),
      el('span', { class: 'modal-folder-count' }, groupMessageCount(g)))));
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
    el('option', { value: index },
      `${METHOD_LABELS[candidate.type]}: ${truncateMiddle(candidate.url)}`)
  );

  // Retry exposes every detected method while first-time unsubscribe shows the auto-best choice.
  const addrEl = document.getElementById('modal-addresses');
  addrEl.replaceChildren(
    el('div', { class: 'modal-addr-row modal-addr-box' },
      el('div', { class: 'modal-kv' },
        el('span', { class: 'modal-kv-label' }, 'From:'),
        el('span', { class: 'modal-addr' }, sub.senderEmail)),
      el('div', { class: 'modal-kv' },
        el('span', { class: 'modal-kv-label' }, 'To:'),
        el('span', { class: 'modal-addr' }, recipientAddress || '(unknown)')),
      el('div', { class: 'modal-kv' },
        el('span', { class: 'modal-kv-label' }, 'Via:'),
        isRetry
          ? el('select', { id: 'modal-method-select', class: 'method-select' },
              el('option', { value: 'auto' }, `Auto-best (${methodLabel})`),
              methodOptions)
          : el('span', { class: 'modal-method' }, methodLabel)),
      el('div', { id: 'modal-method-help', class: 'method-help' }, detail)));

  if (isRetry) {
    document.getElementById('modal-method-select').addEventListener('change', (e) => {
      modalSelectedMethod = e.target.value === 'auto' ? null : availableMethods[Number(e.target.value)];
      const selectedDetail = methodDetail(modalSelectedMethod || method);
      document.getElementById('modal-method-help').textContent = selectedDetail;
      document.getElementById('modal-confirm').title = selectedDetail;
    });
  }

  // Every unsubscribe method confirms to the sender that the address is
  // live — warn harder when there's no List-Unsubscribe header, since
  // body-scraped links from unknown senders are the riskiest to follow.
  const trustHint = document.getElementById('modal-trust-hint');
  const headerBased = (sub.unsubUrls || []).length > 0;
  trustHint.classList.toggle('warn', !headerBased);
  trustHint.textContent = headerBased
    ? "Unsubscribing confirms to the sender that your address is active. Don't recognise this sender? Mark it as junk (🔥 on the card) instead."
    : "⚠ This sender doesn't use the standard unsubscribe header — only a link found in the email body. Unsubscribing from untrusted senders is not recommended: it confirms your address is active. If in doubt, mark it as junk (🔥 on the card) instead.";

  renderModalSourceFolders(sub);
  document.querySelector('.modal-dispose h4').textContent = 'What to do with existing emails?';
  document.querySelector('.modal-dispose').style.display = 'block';

  // Reset dispose & hide destination tree. "Leave emails" is the default:
  // deletion should be a deliberate choice, not a hasty confirm away.
  document.querySelector('input[name="dispose"][value="keep"]').checked = true;
  document.getElementById('modal-dest-wrap').style.display = 'none';
  document.getElementById('modal-new-folder-form').style.display = 'none';

  const confirmBtn = document.getElementById('modal-confirm');
  confirmBtn.disabled = false;
  confirmBtn.textContent = modalConfirmLabel();
  confirmBtn.title = detail;

  document.getElementById('unsub-modal-overlay').classList.add('open');
  onDisposeChange();
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
  document.getElementById('modal-addresses').replaceChildren(
    el('div', { class: 'modal-addr-row modal-addr-box' },
      el('div', { class: 'modal-kv' },
        el('span', { class: 'modal-kv-label' }, 'From:'),
        el('span', { class: 'modal-addr' }, sub.senderEmail)),
      el('div', { class: 'modal-kv' },
        el('span', { class: 'modal-kv-label' }, 'To:'),
        el('span', { class: 'modal-addr' }, recipientAddress || '(unknown)')),
      el('div', { class: 'modal-kv' },
        el('span', { class: 'modal-kv-label' }, 'Status:'),
        el('span', { class: 'modal-method' }, statusLabel))));

  document.getElementById('modal-trust-hint').textContent = '';

  renderModalSourceFolders(sub);
  document.querySelector('.modal-dispose h4').textContent = 'Email action';
  document.querySelector('.modal-dispose').style.display = 'block';
  document.querySelector(`input[name="dispose"][value="${action || 'keep'}"]`).checked = true;
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
      document.getElementById('modal-dest-tree').replaceChildren(
        el('div', { style: 'padding:8px;color:var(--muted);font-size:12px' }, 'Loading folders...'));
      try {
        folderTreeCache = await bg('getFolderTree');
      } catch (e) {
        document.getElementById('modal-dest-tree').replaceChildren(
          el('div', { style: 'padding:8px;color:var(--danger);font-size:12px' }, 'Failed to load folders.'));
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
  container.replaceChildren(...tree.map(account =>
    el('div', { class: 'tree-account', 'data-root-folder-id': account.rootFolderId || '' },
      el('div', { class: 'tree-account-name' }, account.accountName),
      renderFolderNodes(account.folders, 0))));
}

function renderFolderNodes(folders, depth) {
  const nodes = [];
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
    nodes.push(el('div', { class: 'tree-node', style: `padding-left:${depth * 16}px` },
      el('label', {
        class: `tree-folder-label${isMoveTargetDisabled ? ' tree-folder-disabled' : ''}`,
        title: isMoveTargetDisabled ? 'Messages cannot be moved into this folder, but it can be the parent of a new folder' : ''
      },
        hasChildren
          ? el('span', { class: 'tree-toggle', 'data-folder-id': f.id }, '▸')
          : el('span', { class: 'tree-spacer' }),
        el('input', {
          type: 'radio', name: 'dest-folder', value: f.id,
          'data-folder-name': f.name, 'data-folder-path': f.path || f.name,
          'data-move-disabled': isMoveTargetDisabled ? '1' : false
        }),
        el('span', { class: 'tree-folder-name' }, `${f.name}${isMoveTargetDisabled ? ' (cannot receive mail)' : ''}`))));
    if (hasChildren) {
      nodes.push(el('div', { class: 'tree-subtree', 'data-parent-id': f.id, style: 'display:none' },
        renderFolderNodes(f.subFolders, depth + 1)));
    }
  }
  return nodes;
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

function dryRunSummary(sub, method, dispose, selectedFolders, destination, mode = modalMode) {
  if (mode === 'cleanup') {
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

  enqueueActivityJob({
    senderEmail: modalSenderEmail,
    recipientAddress: modalRecipientAddress,
    mode: modalMode,
    method,
    dispose,
    selectedFolders,
    destination,
    selectedMessages: selectedMessageCount(sub, selectedFolders)
  });
  closeUnsubModal();
}

async function processActivityJob(job) {
  const sub = subsCache.find(s => s.senderEmail === job.senderEmail && s.recipientAddress === job.recipientAddress);
  if (!sub) {
    job.status = 'failed';
    job.message = 'Subscription is no longer available';
    job.progress = 100;
    renderActivityQueue();
    return;
  }

  const { method, dispose, selectedFolders, destination } = job;
  const trace = createTrace('unsubscribe', {
    mode: job.mode,
    method: method?.type || 'none',
    dispose,
    selectedFolders: selectedFolders.length,
    selectedMessages: job.selectedMessages
  });
  job.traceId = trace.id;
  setActivityJobProgress(job, job.mode === 'cleanup' ? 'Preparing cleanup...' : 'Sending unsubscribe request...', 5);

  try {
    const result = await trace.bg('getDryRun');
    dryRun = result.dryRun === true;
    document.getElementById('dry-run-toggle').checked = dryRun;
  } catch (e) {
    dryRun = false;
    document.getElementById('dry-run-toggle').checked = false;
  }

  if (job.cancelRequested) {
    job.status = 'cancelled';
    setActivityJobProgress(job, 'Cancelled before sending unsubscribe request', 100);
    clearProcessingFlag(job);
    trace.log('unsubscribe:cancelled');
    return;
  }

  if (dryRun) {
    const summary = dryRunSummary(sub, method, dispose, selectedFolders, destination, job.mode);
    toast(summary, 'info');
    job.status = 'complete';
    setActivityJobProgress(job, summary, 100);
    clearProcessingFlag(job);
    trace.log('unsubscribe:dry-run-complete');
    return;
  }

  // Fire unsubscribe
  let ok = false;
  let unsubscribeResult = null;
  if (job.mode === 'cleanup') {
    ok = true;
    setActivityJobProgress(job, 'Applying cleanup...', 10);
  } else if (method) {
    try {
      if (method.type === 'oneclick') {
        const r = await trace.bg('unsubOneClick', { url: method.url });
        unsubscribeResult = r;
        ok = r.ok;
      } else if (method.type === 'mail') {
        unsubscribeResult = await trace.bg('unsubMail', { url: method.url, recipientAddress: job.recipientAddress });
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

  if (!ok) {
    const message = method ? 'Unsubscribe request failed' : 'No unsubscribe method is available';
    await trace.bg('decide', {
      senderEmail: job.senderEmail,
      recipientAddress: job.recipientAddress,
      decision: 'error',
      dispose,
      error: errorPayload('unsubscribe', message)
    });
    updateDecisionStats(sub.decision, 'error');
    sub.decision = 'error';
    sub.processing = false;
    toast(message, 'error');
    showErrorsView();
    trace.log('unsubscribe:failed', undefined, { stage: 'unsubscribe' });
    job.status = 'failed';
    setActivityJobProgress(job, message, 100);
    return;
  }

  // Outcome of the unsubscribe step itself, independent of cleanup: a real
  // unsubscribe → unsubscribed; a standalone cleanup keeps the prior decision.
  const outcomeDecision = job.mode === 'cleanup' ? (sub.decision || 'unsubscribed') : 'unsubscribed';

  if (job.cancelRequested) {
    if (job.mode !== 'cleanup') {
      await trace.bg('decide', {
        senderEmail: job.senderEmail,
        recipientAddress: job.recipientAddress,
        decision: 'unsubscribed',
        dispose: null
      });
      sub.dispose = null;
      sub.processing = false;
      updateCachedDecision(sub, 'unsubscribed');
      job.status = 'complete';
      setActivityJobProgress(job, 'Unsubscribed; remaining actions cancelled', 100);
      toast('Unsubscribed; remaining actions cancelled', 'info');
    } else {
      job.status = 'cancelled';
      setActivityJobProgress(job, 'Cleanup cancelled', 100);
      toast('Cleanup cancelled', 'info');
      clearProcessingFlag(job);
    }
    trace.log('unsubscribe:cancelled');
    return;
  }

  // A cleanup (delete/move) failure is NOT an unsubscribe failure — the
  // unsubscribe already succeeded. Keep the unsubscribe outcome, leave the
  // emails in place (dispose: null), and let the Cleanup button retry.
  async function handleCleanupFailure(stage, e) {
    await trace.bg('decide', {
      senderEmail: job.senderEmail,
      recipientAddress: job.recipientAddress,
      decision: outcomeDecision,
      dispose: null,
      error: outcomeDecision === 'error' ? sub.error : undefined
    });
    sub.dispose = null;
    sub.processing = false;
    updateCachedDecision(sub, outcomeDecision);
    const msg = job.mode === 'cleanup'
      ? `Cleanup failed while ${stage} emails: ${e.message || e}. Use Cleanup to retry.`
      : `Unsubscribed, but ${stage} emails failed: ${e.message || e}. Use Cleanup to retry.`;
    toast(msg, 'error');
    trace.log('unsubscribe:cleanup-failed', undefined, { stage });
    job.status = 'failed';
    setActivityJobProgress(job, msg, 100);
    clearProcessingFlag(job);
  }

  // Apply dispose action on selected folders
  let cleanupResult = null;
  if (dispose === 'delete' && selectedFolders.length > 0) {
    try {
      setActivityJobProgress(job, 'Deleting emails...', 75);
      const result = await trace.bg('deleteEmails', {
        senderEmail: job.senderEmail,
        recipientAddress: job.recipientAddress,
        messageGroups: sub.messageGroups,
        selectedFolders
      });
      cleanupResult = result;
      if (result?.dryRun) toast(`Dry run: would delete ${result.deleted || 0} emails`, 'info');
      if (result?.cancelled && !result.actionCompleted) {
        if (job.mode !== 'cleanup') {
          await trace.bg('decide', {
            senderEmail: job.senderEmail,
            recipientAddress: job.recipientAddress,
            decision: outcomeDecision,
            dispose: null,
            error: outcomeDecision === 'error' ? sub.error : undefined
          });
          sub.dispose = null;
          sub.processing = false;
          updateCachedDecision(sub, outcomeDecision);
          job.status = 'complete';
          setActivityJobProgress(job, 'Unsubscribed; cleanup cancelled', 100);
          toast('Unsubscribed; cleanup cancelled', 'info');
        } else {
          job.status = 'cancelled';
          setActivityJobProgress(job, 'Cleanup cancelled', 100);
          toast('Cleanup cancelled', 'info');
        }
        clearProcessingFlag(job);
        return;
      }
    } catch (e) {
      await handleCleanupFailure('deleting', e);
      return;
    }
  } else if (dispose === 'move' && selectedFolders.length > 0) {
    try {
      setActivityJobProgress(job, 'Moving emails...', 75);
      const result = await trace.bg('moveEmails', {
        senderEmail: job.senderEmail,
        recipientAddress: job.recipientAddress,
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
        if (job.mode !== 'cleanup') {
          await trace.bg('decide', {
            senderEmail: job.senderEmail,
            recipientAddress: job.recipientAddress,
            decision: outcomeDecision,
            dispose: null,
            error: outcomeDecision === 'error' ? sub.error : undefined
          });
          sub.dispose = null;
          sub.processing = false;
          updateCachedDecision(sub, outcomeDecision);
          job.status = 'complete';
          setActivityJobProgress(job, 'Unsubscribed; cleanup cancelled', 100);
          toast('Unsubscribed; cleanup cancelled', 'info');
        } else {
          job.status = 'cancelled';
          setActivityJobProgress(job, 'Cleanup cancelled', 100);
          toast('Cleanup cancelled', 'info');
        }
        clearProcessingFlag(job);
        return;
      }
    } catch (e) {
      await handleCleanupFailure('moving', e);
      return;
    }
  }

  // Finalize decision (cleanup succeeded or nothing to dispose).
  try {
    setActivityJobProgress(job, 'Saving result...', 90);
    await trace.bg('decide', {
      senderEmail: job.senderEmail,
      recipientAddress: job.recipientAddress,
      decision: outcomeDecision,
      dispose,
      cleanupDestination: destination,
      error: outcomeDecision === 'error' ? sub.error : undefined
    });
  } catch (e) {
    toast('Error: ' + (e.message || e), 'error');
    trace.log('unsubscribe:failed', undefined, { stage: 'persist-decision' });
    job.status = 'failed';
    setActivityJobProgress(job, `Failed to save result: ${e.message || e}`, 100);
    clearProcessingFlag(job);
    return;
  }

  if (cleanupResult?.messageGroups) {
    sub.messageGroups = cleanupResult.messageGroups;
    sub.emailCount = cleanupResult.emailCount;
  }
  sub.dispose = dispose;
  sub.cleanupDestination = destination;
  sub.processing = false;
  updateCachedDecision(sub, outcomeDecision);

  const name = sub.senderName || sub.senderEmail;
  let outcomeMessage;
  let outcomeType = 'success';
  if (job.mode === 'cleanup') {
    outcomeMessage = `Updated email cleanup for ${name}`;
  } else if (unsubscribeResult?.drafted) {
    if (unsubscribeResult.draftReason === 'no-identity-match') {
      outcomeMessage = `Opened unsubscribe email as a draft for ${name} - no identity matches ${sub.recipientAddress || 'the receiving address'}, so check the From address and send it yourself`;
      outcomeType = 'info';
    } else {
      outcomeMessage = `Prepared unsubscribe email draft for ${name}`;
    }
  } else if (unsubscribeResult?.sent) {
    outcomeMessage = `Sent unsubscribe email for ${name}`;
  } else if (ok) {
    outcomeMessage = `Unsubscribed from ${name}`;
  } else {
    outcomeMessage = `Unsubscribed from ${name} (request may have failed)`;
    outcomeType = 'error';
  }

  toast(outcomeMessage, outcomeType);
  job.status = outcomeType === 'error' ? 'failed' : 'complete';
  setActivityJobProgress(job, outcomeMessage, 100);
  clearProcessingFlag(job);
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

// ── Scan scope ───────────────────────────────────────────────────────────────

function accountTypeLabel(type) {
  return { rss: 'RSS', nntp: 'News' }[type] || type;
}

async function openScanScopeModal() {
  document.getElementById('scope-modal-overlay').classList.add('open');
  const treeEl = document.getElementById('scope-tree');
  treeEl.replaceChildren(el('div', { style: 'padding:8px;color:var(--muted);font-size:12px' }, 'Loading folders...'));
  let scope;
  try {
    scope = await bg('getScanScope');
  } catch (e) {
    treeEl.replaceChildren(el('div', { style: 'padding:8px;color:var(--danger);font-size:12px' }, 'Failed to load folders.'));
    return;
  }
  renderScopeTree(scope);
  document.getElementById('scope-skip-senders').value = (scope.skipSenders || []).join('\n');
  document.getElementById('scope-skip-recipients').value = (scope.skipRecipients || []).join('\n');
}

function closeScanScopeModal() {
  document.getElementById('scope-modal-overlay').classList.remove('open');
}

function renderScopeTree(scope) {
  const excludedAccounts = new Set(scope.excludedAccountIds || []);
  const folderOverrides = scope.folderOverrides || {};
  const accounts = (scope.accounts || []).map(account => {
    if (!account.scannable) {
      return el('div', { class: 'tree-account' },
        el('label', {
          class: 'tree-account-label tree-account-disabled',
          title: `${accountTypeLabel(account.type)} accounts have no email subscriptions to scan`
        },
          el('input', { type: 'checkbox', disabled: true }),
          el('span', { class: 'tree-account-name' }, `${account.accountName} (${accountTypeLabel(account.type)} — can't be scanned)`)));
    }
    const accountExcluded = excludedAccounts.has(account.accountId);
    return el('div', { class: 'tree-account', 'data-account-id': account.accountId },
      el('label', { class: 'tree-account-label' },
        el('input', { type: 'checkbox', class: 'scope-account-check', checked: !accountExcluded }),
        el('span', { class: 'tree-account-name' }, account.accountName)),
      renderScopeFolderNodes(account.folders, 0, accountExcluded, folderOverrides));
  });
  document.getElementById('scope-tree').replaceChildren(...accounts);
  for (const accountEl of document.querySelectorAll('#scope-tree .tree-account[data-account-id]')) {
    syncScopeAccountState(accountEl);
  }
}

function renderScopeFolderNodes(folders, depth, parentExcluded, folderOverrides) {
  const nodes = [];
  for (const f of folders || []) {
    const hasChildren = f.subFolders && f.subFolders.length > 0;
    const defaultIncluded = !f.defaultExcluded;
    const checked = !parentExcluded && (folderOverrides[f.id] ?? defaultIncluded);
    nodes.push(el('div', { class: 'tree-node', style: `padding-left:${depth * 16}px` },
      el('label', {
        class: 'tree-folder-label',
        title: f.defaultExcluded ? 'Skipped by default. Check to include this folder in scans.' : ''
      },
        hasChildren
          ? el('span', { class: 'tree-toggle', 'data-folder-id': f.id }, '▸')
          : el('span', { class: 'tree-spacer' }),
        el('input', { type: 'checkbox', class: 'scope-folder-check', value: f.id, checked, 'data-default-excluded': f.defaultExcluded ? 'true' : 'false' }),
        el('span', { class: 'tree-folder-name' }, f.name))));
    if (hasChildren) {
      nodes.push(el('div', { class: 'tree-subtree', 'data-parent-id': f.id, style: 'display:none' },
        renderScopeFolderNodes(f.subFolders, depth + 1, parentExcluded, folderOverrides)));
    }
  }
  return nodes;
}

function syncScopeAccountState(accountEl) {
  const accountCheck = accountEl.querySelector('.scope-account-check');
  const folderChecks = [...accountEl.querySelectorAll('.scope-folder-check')];
  if (!accountCheck || folderChecks.length === 0) return;
  const checkedCount = folderChecks.filter(cb => cb.checked).length;
  accountCheck.checked = checkedCount > 0;
  accountCheck.indeterminate = checkedCount > 0 && checkedCount < folderChecks.length;
}

function onScopeTreeChange(e) {
  const target = e.target;
  if (target.classList.contains('scope-account-check')) {
    target.indeterminate = false;
    for (const cb of target.closest('.tree-account').querySelectorAll('.scope-folder-check')) {
      cb.checked = target.checked;
    }
  } else if (target.classList.contains('scope-folder-check')) {
    // Cascade to subfolders, then recompute the account tri-state.
    const subtree = target.closest('.tree-node').nextElementSibling;
    if (subtree && subtree.classList.contains('tree-subtree')) {
      for (const cb of subtree.querySelectorAll('.scope-folder-check')) {
        cb.checked = target.checked;
      }
    }
    syncScopeAccountState(target.closest('.tree-account'));
  }
}

// Must stay in sync with SENDER_PATTERN_REGEX in scan-scope.js (this file is
// not a module, so it cannot import it).
const SCOPE_ADDRESS_PATTERN = /^((\*|[^\s@*]*)@[^\s@*]+|\*?@\*\.[^\s@*]+|[^\s@*]+\.[^\s@*]+)$/;

async function saveScanScope() {
  const excludedAccountIds = [];
  const folderOverrides = {};
  for (const accountEl of document.querySelectorAll('#scope-tree .tree-account[data-account-id]')) {
    const folderChecks = [...accountEl.querySelectorAll('.scope-folder-check')];
    const accountChecked = accountEl.querySelector('.scope-account-check').checked;
    const checkedCount = folderChecks.filter(cb => cb.checked).length;
    if ((folderChecks.length > 0 && checkedCount === 0) ||
        (folderChecks.length === 0 && !accountChecked)) {
      excludedAccountIds.push(accountEl.dataset.accountId);
    } else {
      for (const cb of folderChecks) {
        const defaultIncluded = cb.dataset.defaultExcluded !== 'true';
        if (cb.checked !== defaultIncluded) folderOverrides[cb.value] = cb.checked;
      }
    }
  }

  const skipSenders = document.getElementById('scope-skip-senders').value
    .split('\n').map(line => line.trim()).filter(Boolean);
  const skipRecipients = document.getElementById('scope-skip-recipients').value
    .split('\n').map(line => line.trim()).filter(Boolean);
  const invalid = [...skipSenders, ...skipRecipients].find(p => !SCOPE_ADDRESS_PATTERN.test(p));
  if (invalid) {
    toast(`Invalid address pattern "${invalid}" — use name@domain.com, domain.com, *@domain.com, or *@*.domain.com`, 'error');
    return;
  }

  try {
    await bg('setScanScope', { excludedAccountIds, folderOverrides, skipSenders, skipRecipients });
    closeScanScopeModal();
    toast('Scan scope saved', 'success');
    refreshScanScopeLabel();
  } catch (e) {
    toast('Failed to save scan scope: ' + (e.message || e), 'error');
  }
}

async function refreshScanScopeLabel() {
  const btn = document.getElementById('scan-scope-btn');
  try {
    const scope = await bg('getScanScope');
    const excludedAccounts = new Set(scope.excludedAccountIds || []);
    const folderOverrides = scope.folderOverrides || {};
    let total = 0;
    let excluded = 0;
    let includedDefaultOff = 0;
    const countFolders = (folders, accountExcluded) => {
      for (const f of folders || []) {
        const included = !accountExcluded && (folderOverrides[f.id] ?? !f.defaultExcluded);
        if (f.defaultExcluded) {
          if (included) includedDefaultOff++;
        } else {
          total++;
          if (!included) excluded++;
        }
        countFolders(f.subFolders, accountExcluded);
      }
    };
    for (const account of scope.accounts || []) {
      if (!account.scannable) continue;
      countFolders(account.folders, excludedAccounts.has(account.accountId));
    }
    const skippedFrom = (scope.skipSenders || []).length;
    const skippedTo = (scope.skipRecipients || []).length;
    const parts = [excluded > 0 ? `${total - excluded}/${total} folders` : 'all folders'];
    if (includedDefaultOff > 0) parts.push(`${includedDefaultOff} default-skipped folder${includedDefaultOff === 1 ? '' : 's'}`);
    if (skippedFrom > 0) parts.push(`${skippedFrom} From filter${skippedFrom === 1 ? '' : 's'}`);
    if (skippedTo > 0) parts.push(`${skippedTo} To filter${skippedTo === 1 ? '' : 's'}`);
    btn.textContent = `Scan scope: ${parts.join(' · ')}`;
    btn.title = btn.textContent;
  } catch (e) { /* keep the default label */ }
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
  document.getElementById('scan-stat-folders').textContent = '';
  document.getElementById('scan-stat-subs').textContent = '';
  document.getElementById('scan-stat-subemails').textContent = '';
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
      const pct = s.total > 0 ? Math.min(100, Math.round(s.progress / s.total * 100)) : 0;
      document.getElementById('progress-bar').style.width = pct + '%';

      const msgEl = document.getElementById('scan-msg');
      const badgeEl = document.getElementById('scan-state-badge');
      const scannedCount = (s.messagesScanned || 0).toLocaleString();
      const scannedText = s.total > 0
        ? `${scannedCount}/${s.total.toLocaleString()} emails scanned`
        : `${scannedCount} emails scanned`;
      const foldersEl = document.getElementById('scan-stat-folders');
      foldersEl.textContent = s.folderTotal > 0
        ? `${s.folderProgress || 0}/${s.folderTotal} folders${s.currentFolder ? ` — ${s.currentFolder}` : ''}`
        : '';
      // Long account/folder names are ellipsized; the tooltip has the full text.
      foldersEl.title = foldersEl.textContent;
      document.getElementById('scan-stat-subs').textContent = (s.sendersFound || 0) + ' subscriptions found';
      document.getElementById('scan-stat-subemails').textContent =
        (s.subscriptionEmailsFound || 0).toLocaleString() + ' subscription emails found';
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
        // The top line starts as "Starting..."/"Loading accounts..." and
        // becomes the live counter once the scan is underway.
        msgEl.textContent = (s.total > 0 || s.messagesScanned > 0) ? scannedText : (s.message || '');
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

  // Scan scope modal
  document.getElementById('scan-scope-btn').addEventListener('click', openScanScopeModal);
  document.getElementById('scope-cancel').addEventListener('click', closeScanScopeModal);
  document.getElementById('scope-save').addEventListener('click', saveScanScope);
  document.getElementById('scope-modal-overlay').addEventListener('click', (e) => {
    if (e.target.id === 'scope-modal-overlay') closeScanScopeModal();
  });
  document.getElementById('scope-tree').addEventListener('change', onScopeTreeChange);
  document.getElementById('scope-tree').addEventListener('click', (e) => {
    const toggle = e.target.closest('.tree-toggle');
    if (!toggle) return;
    // The toggle sits inside the checkbox label: stop the click from
    // flipping the checkbox while expanding/collapsing.
    e.preventDefault();
    const subtree = document.querySelector(`#scope-tree .tree-subtree[data-parent-id="${CSS.escape(toggle.dataset.folderId)}"]`);
    if (!subtree) return;
    const open = subtree.style.display !== 'none';
    subtree.style.display = open ? 'none' : 'block';
    toggle.textContent = open ? '▸' : '▾';
  });
  refreshScanScopeLabel();
  document.getElementById('dry-run-toggle').addEventListener('change', (e) => {
    updateDryRun(e.target.checked);
  });
  document.getElementById('auto-send-email-toggle').addEventListener('change', (e) => {
    updateAutoSendUnsubscribeEmails(e.target.checked);
  });
  document.getElementById('full-reset-btn').addEventListener('click', doFullReset);
  document.getElementById('activity-list').addEventListener('click', (e) => {
    const dismissBtn = e.target.closest('.js-dismiss-activity');
    if (dismissBtn) {
      dismissActivityJob(Number(dismissBtn.dataset.jobId));
      return;
    }
    const item = e.target.closest('.js-open-activity');
    if (item) openActivityModal(Number(item.dataset.jobId));
  });
  document.getElementById('activity-modal-close').addEventListener('click', closeActivityModal);
  document.getElementById('activity-modal-cancel-job').addEventListener('click', () => {
    if (activityModalJobId != null) cancelActivityJob(activityModalJobId);
  });
  document.getElementById('activity-modal-overlay').addEventListener('click', (e) => {
    if (e.target.id === 'activity-modal-overlay') closeActivityModal();
  });
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
    toggle.textContent = open ? '▸' : '▾';
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
