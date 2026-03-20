'use strict';

let currentFilter = 'pending';
let scanPollTimer = null;
let subsCache = [];

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
  }, 3500);
}

function bg(command, data) {
  return browser.runtime.sendMessage({ command, ...data });
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

function sid(email) {
  return email.replace(/[^a-zA-Z0-9]/g, '_');
}

function senderLabel(sub) {
  if (sub.senderName) return `${sub.senderName} <${sub.senderEmail}>`;
  return sub.senderEmail;
}

// ── Stats & filter badges ────────────────────────────────────────────────────
async function loadStats() {
  try {
    const s = await bg('getStats');
    document.getElementById('stat-total').textContent = s.total;
    document.getElementById('stat-pending').textContent = s.pending;
    document.getElementById('stat-kept').textContent = s.kept;
    document.getElementById('stat-unsub').textContent = s.unsubscribed;
    document.getElementById('fb-all').textContent = s.total;
    document.getElementById('fb-pending').textContent = s.pending;
    document.getElementById('fb-keep').textContent = s.kept;
    document.getElementById('fb-unsubscribed').textContent = s.unsubscribed;
  } catch (e) { /* ignore */ }
}

// ── Subscriptions loading ────────────────────────────────────────────────────
async function loadSubs(filter) {
  const grid = document.getElementById('cards-grid');
  grid.innerHTML = '<div id="loading"><div class="spinner"></div>Loading...</div>';
  document.getElementById('empty-state').style.display = 'none';

  try {
    const subs = await bg('getSubscriptions', { filter: filter === 'all' ? null : filter });
    subsCache = subs;
    renderCards(subs);
  } catch (e) {
    grid.innerHTML = '<div style="color:var(--danger);padding:40px">Failed to load.</div>';
  }
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

function groupsByAccount(messageGroups) {
  // Returns: { accountName: { folderName: count, ... }, ... }
  const result = {};
  for (const g of (messageGroups || [])) {
    if (!result[g.accountName]) result[g.accountName] = {};
    result[g.accountName][g.folderName] = (result[g.accountName][g.folderName] || 0) + g.messageIds.length;
  }
  return result;
}

function totalCount(messageGroups) {
  return (messageGroups || []).reduce((sum, g) => sum + g.messageIds.length, 0);
}

// Collapse messageGroups by recipientAddress, merging unsubUrls per address.
// This is the correct unit for unsubscribing — one request per recipient address.
function getRecipientGroups(messageGroups) {
  const byAddr = {};
  for (const g of (messageGroups || [])) {
    const addr = g.recipientAddress || '';
    if (!byAddr[addr]) {
      byAddr[addr] = { recipientAddress: addr, unsubUrls: [...(g.unsubUrls || [])], oneClick: g.oneClick || false, hasMailto: g.hasMailto || false, hasHttp: g.hasHttp || false, embeddedUrl: g.embeddedUrl || null };
    } else {
      for (const u of (g.unsubUrls || [])) {
        if (!byAddr[addr].unsubUrls.includes(u)) byAddr[addr].unsubUrls.push(u);
      }
      if (g.oneClick) byAddr[addr].oneClick = true;
      if (g.hasMailto) byAddr[addr].hasMailto = true;
      if (g.hasHttp) byAddr[addr].hasHttp = true;
      if (g.embeddedUrl && !byAddr[addr].embeddedUrl) byAddr[addr].embeddedUrl = g.embeddedUrl;
    }
  }
  return Object.values(byAddr);
}

// ── Unsub methods ────────────────────────────────────────────────────────────

const METHOD_LABELS = { oneclick: 'one-click', mail: 'email', web: 'browser', embedded: 'embedded link' };

function getBestMethod(group) {
  const urls = group.unsubUrls || [];
  const httpUrl = urls.find(u => u.startsWith('http')) || '';
  const mailtoUrl = urls.find(u => u.startsWith('mailto')) || '';
  if (group.oneClick && httpUrl) return { type: 'oneclick', url: httpUrl };
  if (mailtoUrl) return { type: 'mail', url: mailtoUrl };
  if (httpUrl) return { type: 'web', url: httpUrl };
  if (group.embeddedUrl) return { type: 'embedded', url: group.embeddedUrl };
  return null;
}

// ── Build card ───────────────────────────────────────────────────────────────
function buildCard(s) {
  const groups = s.messageGroups || [];
  const byAccount = groupsByAccount(groups);
  const total = totalCount(groups);
  const color = avatarColor(s.senderEmail);
  const ini = initials(s.senderName, s.senderEmail);
  const id = sid(s.senderEmail);
  const accountNames = Object.keys(byAccount);

  // Badges
  let badges = `<span class="badge badge-blue">${s.emailCount} emails</span>`;
  if (s.oneClick) badges += `<span class="badge badge-green">One-Click</span>`;
  if (s.hasMailto) badges += `<span class="badge badge-purple">Mailto</span>`;
  if (s.hasHttp && !s.oneClick) badges += `<span class="badge badge-orange">HTTP</span>`;
  if (s.hasEmbedded && !s.hasHttp && !s.hasMailto && !s.oneClick) badges += `<span class="badge badge-orange">Embedded</span>`;
  if (s.decision === 'keep') badges += `<span class="badge badge-kept">Kept</span>`;
  if (s.decision === 'unsubscribed') badges += `<span class="badge badge-unsub">Unsubscribed</span>`;

  const dateStr = s.lastDate ? new Date(s.lastDate).toLocaleDateString() : '';
  const cardId = `card-${id}`;

  return `
<div class="card" id="${cardId}" data-sender-email="${esc(s.senderEmail)}">
  <div class="card-body">
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
    ${s.sampleSubject ? `<div class="card-subject" title="${esc(s.sampleSubject)}">"${esc(s.sampleSubject.substring(0, 80))}"</div>` : ''}
  </div>
  <div class="card-actions">
    <button class="btn btn-keep js-keep" data-sender-email="${esc(s.senderEmail)}">Keep</button>
    <button class="btn btn-unsub js-open-modal" data-sender-email="${esc(s.senderEmail)}">Unsubscribe</button>
  </div>
</div>`;
}

// ── Event delegation (attached once in DOMContentLoaded) ─────────────────────
function attachCardListeners() {
  document.getElementById('cards-grid').addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;

    if (btn.classList.contains('js-keep')) {
      await doKeep(btn.dataset.senderEmail);
      return;
    }

    if (btn.classList.contains('js-open-modal')) {
      openUnsubModal(btn.dataset.senderEmail);
      return;
    }
  });
}

// ── Unsubscribe modal ────────────────────────────────────────────────────────
let modalSenderEmail = null;

function openUnsubModal(senderEmail) {
  const sub = subsCache.find(s => s.senderEmail === senderEmail);
  if (!sub) return;

  modalSenderEmail = senderEmail;
  const recipientGroups = getRecipientGroups(sub.messageGroups);

  document.getElementById('modal-title').textContent =
    `Unsubscribe from ${sub.senderName || sub.senderEmail}`;

  const addrEl = document.getElementById('modal-addresses');
  let html = '';
  for (const g of recipientGroups) {
    const m = getBestMethod(g);
    const methodLabel = m ? METHOD_LABELS[m.type] : 'no method';
    if (recipientGroups.length === 1) {
      html += `<div class="modal-addr-row">
        <span class="modal-addr">${esc(g.recipientAddress || '(unknown)')}</span>
        <span class="modal-method">${esc(methodLabel)}</span>
      </div>`;
    } else {
      html += `<label class="modal-addr-row">
        <input type="checkbox" class="modal-addr-check" data-addr="${esc(g.recipientAddress)}" checked>
        <span class="modal-addr">${esc(g.recipientAddress || '(unknown)')}</span>
        <span class="modal-method">${esc(methodLabel)}</span>
      </label>`;
    }
  }
  if (recipientGroups.length === 0) {
    html = '<div class="modal-addr-row"><span class="modal-addr" style="color:var(--muted)">No unsubscribe method available</span></div>';
  }
  addrEl.innerHTML = html;

  document.querySelector('input[name="dispose"][value="delete"]').checked = true;
  const confirmBtn = document.getElementById('modal-confirm');
  confirmBtn.disabled = false;
  confirmBtn.textContent = 'Unsubscribe';

  document.getElementById('unsub-modal-overlay').classList.add('open');
}

function closeUnsubModal() {
  document.getElementById('unsub-modal-overlay').classList.remove('open');
  modalSenderEmail = null;
}

async function doUnsubscribeConfirm() {
  if (!modalSenderEmail) return;
  const sub = subsCache.find(s => s.senderEmail === modalSenderEmail);
  if (!sub) return;

  const recipientGroups = getRecipientGroups(sub.messageGroups);
  const checkboxes = document.querySelectorAll('.modal-addr-check');
  const selectedAddrs = checkboxes.length === 0
    ? recipientGroups.map(g => g.recipientAddress)
    : [...checkboxes].filter(cb => cb.checked).map(cb => cb.dataset.addr);

  const dispose = document.querySelector('input[name="dispose"]:checked').value;

  const confirmBtn = document.getElementById('modal-confirm');
  confirmBtn.disabled = true;
  confirmBtn.textContent = 'Unsubscribing...';

  // Fire unsubscribe for each selected address
  let succeeded = 0;
  let failed = 0;
  for (const addr of selectedAddrs) {
    const group = recipientGroups.find(g => g.recipientAddress === addr);
    if (!group) continue;
    const method = getBestMethod(group);
    if (!method) continue;
    try {
      if (method.type === 'oneclick') {
        const r = await bg('unsubOneClick', { url: method.url });
        if (r.ok) succeeded++; else failed++;
      } else if (method.type === 'mail') {
        await bg('unsubMail', { url: method.url, senderEmail: modalSenderEmail });
        succeeded++;
      } else {
        await bg('unsubWeb', { url: method.url });
        succeeded++;
      }
    } catch (e) {
      failed++;
    }
  }

  // Apply dispose action
  if (dispose !== 'keep') {
    try {
      const command = dispose === 'delete' ? 'deleteEmails' : 'archiveEmails';
      await bg(command, { senderEmail: modalSenderEmail, scope: 'all', accountName: '', folderName: '' });
    } catch (e) {
      toast('Error handling emails: ' + e.message, 'error');
    }
  }

  // Mark as unsubscribed
  try {
    await bg('decide', { senderEmail: modalSenderEmail, decision: 'unsubscribed', dispose });
  } catch (e) {
    toast('Error: ' + e.message, 'error');
  }

  // Remove card
  const cardId = `card-${sid(modalSenderEmail)}`;
  const card = document.getElementById(cardId);
  if (card) {
    card.classList.add('fading');
    setTimeout(() => card.remove(), 300);
  }

  const name = sub.senderName || sub.senderEmail;
  if (failed === 0) {
    toast(`Unsubscribed from ${name}`, 'success');
  } else {
    toast(`Unsubscribed from ${name} (${failed} failed)`, 'error');
  }

  closeUnsubModal();
  loadStats();
}

// ── Keep action ──────────────────────────────────────────────────────────────
async function doKeep(senderEmail) {
  const cardId = `card-${sid(senderEmail)}`;
  const card = document.getElementById(cardId);

  try {
    await bg('decide', { senderEmail, decision: 'keep', dispose: null });
    toast(`Keeping ${senderEmail}`, 'success');

    if (card) {
      if (currentFilter === 'pending' || currentFilter === 'unsubscribed') {
        card.classList.add('fading');
        setTimeout(() => card.remove(), 300);
      } else {
        const badgesEl = card.querySelector('.card-badges');
        badgesEl.querySelectorAll('.badge-kept,.badge-unsub').forEach(b => b.remove());
        badgesEl.insertAdjacentHTML('beforeend', '<span class="badge badge-kept">Kept</span>');
      }
    }
    loadStats();
  } catch (e) {
    toast('Error: ' + e.message, 'error');
  }
}


// ── Filter ───────────────────────────────────────────────────────────────────
function setFilter(filter, btn) {
  currentFilter = filter;
  document.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');

  const titles = { all: 'All Subscriptions', pending: 'Pending', keep: 'Kept', unsubscribed: 'Unsubscribed' };
  document.getElementById('main-title').textContent = titles[filter] || filter;
  loadSubs(filter);
}

// ── Scan ─────────────────────────────────────────────────────────────────────
async function startScan() {
  const btn = document.getElementById('scan-btn');
  btn.disabled = true;
  btn.textContent = 'Scanning...';
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
    btn.disabled = false;
    btn.textContent = 'Scan Emails';
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
        document.getElementById('scan-btn').disabled = false;
        document.getElementById('scan-btn').textContent = 'Scan Emails';
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
  attachCardListeners();

  document.getElementById('modal-cancel').addEventListener('click', closeUnsubModal);
  document.getElementById('modal-confirm').addEventListener('click', doUnsubscribeConfirm);
  document.getElementById('unsub-modal-overlay').addEventListener('click', (e) => {
    if (e.target.id === 'unsub-modal-overlay') closeUnsubModal();
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

  await loadStats();
  await loadSubs('pending');

  try {
    const s = await bg('getScanStatus');
    if (s.status === 'scanning') {
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
