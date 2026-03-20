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

function sid(senderEmail, recipientAddress) {
  return (senderEmail + '|' + (recipientAddress || '')).replace(/[^a-zA-Z0-9]/g, '_');
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

// ── Unsub methods ────────────────────────────────────────────────────────────

const METHOD_LABELS = { oneclick: 'one-click', mail: 'email', web: 'browser', embedded: 'embedded link' };

function getBestMethod(sub) {
  const urls = sub.unsubUrls || [];
  const httpUrl = urls.find(u => u.startsWith('http')) || '';
  const mailtoUrl = urls.find(u => u.startsWith('mailto')) || '';
  if (sub.oneClick && httpUrl) return { type: 'oneclick', url: httpUrl };
  if (mailtoUrl) return { type: 'mail', url: mailtoUrl };
  if (httpUrl) return { type: 'web', url: httpUrl };
  if (sub.embeddedUrl) return { type: 'embedded', url: sub.embeddedUrl };
  return null;
}

// ── Build card ───────────────────────────────────────────────────────────────
function buildCard(s) {
  const groups = s.messageGroups || [];
  const byAccount = groupsByAccount(groups);
  const color = avatarColor(s.senderEmail);
  const ini = initials(s.senderName, s.senderEmail);
  const id = sid(s.senderEmail, s.recipientAddress);
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
<div class="card" id="${cardId}" data-sender-email="${esc(s.senderEmail)}" data-recipient-address="${esc(s.recipientAddress || '')}">
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
    ${s.recipientAddress ? `<div class="card-accounts" title="Delivered to ${esc(s.recipientAddress)}">→ ${esc(s.recipientAddress)}</div>` : ''}
    ${s.sampleSubject ? `<div class="card-subject" title="${esc(s.sampleSubject)}">"${esc(s.sampleSubject.substring(0, 80))}"</div>` : ''}
  </div>
  <div class="card-actions">
    <button class="btn btn-view js-view" data-sender-email="${esc(s.senderEmail)}" data-recipient-address="${esc(s.recipientAddress || '')}">View</button>
    <button class="btn btn-keep js-keep" data-sender-email="${esc(s.senderEmail)}" data-recipient-address="${esc(s.recipientAddress || '')}">Keep</button>
    <button class="btn btn-unsub js-open-modal" data-sender-email="${esc(s.senderEmail)}" data-recipient-address="${esc(s.recipientAddress || '')}">Unsubscribe</button>
  </div>
</div>`;
}

// ── Event delegation (attached once in DOMContentLoaded) ─────────────────────
function attachCardListeners() {
  document.getElementById('cards-grid').addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;

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

    if (btn.classList.contains('js-open-modal')) {
      openUnsubModal(btn.dataset.senderEmail, btn.dataset.recipientAddress);
      return;
    }
  });
}

// ── Unsubscribe modal ────────────────────────────────────────────────────────
let modalSenderEmail = null;
let modalRecipientAddress = null;
let folderTreeCache = null;

function openUnsubModal(senderEmail, recipientAddress) {
  const sub = subsCache.find(s => s.senderEmail === senderEmail && s.recipientAddress === recipientAddress);
  if (!sub) return;

  modalSenderEmail = senderEmail;
  modalRecipientAddress = recipientAddress;

  const method = getBestMethod(sub);
  const methodLabel = method ? METHOD_LABELS[method.type] : 'no method';

  document.getElementById('modal-title').textContent =
    `Unsubscribe from ${sub.senderName || sub.senderEmail}`;

  // Recipient address
  const addrEl = document.getElementById('modal-addresses');
  addrEl.innerHTML = `<div class="modal-addr-row">
    <span class="modal-addr">${esc(recipientAddress || '(unknown)')}</span>
    <span class="modal-method">${esc(methodLabel)}</span>
  </div>`;

  // Build source folder checkboxes (hidden until delete/move selected)
  const groups = sub.messageGroups || [];
  const foldersSection = document.getElementById('modal-folders-section');
  const foldersEl = document.getElementById('modal-folders');
  if (groups.length > 0) {
    foldersEl.innerHTML = groups.map((g, i) => `
      <label class="modal-folder-row">
        <input type="checkbox" class="modal-folder-check" data-idx="${i}" checked>
        <span class="modal-folder-name">${esc(g.accountName)} / ${esc(g.folderName)}</span>
        <span class="modal-folder-count">${g.messageIds.length}</span>
      </label>`).join('');
  }
  // Default is delete, so show folder checkboxes if there are groups
  foldersSection.style.display = groups.length > 0 ? 'block' : 'none';

  // Reset dispose & hide destination tree
  document.querySelector('input[name="dispose"][value="delete"]').checked = true;
  document.getElementById('modal-dest-wrap').style.display = 'none';
  document.getElementById('modal-new-folder-form').style.display = 'none';

  const confirmBtn = document.getElementById('modal-confirm');
  confirmBtn.disabled = false;
  confirmBtn.textContent = 'Unsubscribe';

  document.getElementById('unsub-modal-overlay').classList.add('open');
}

function closeUnsubModal() {
  document.getElementById('unsub-modal-overlay').classList.remove('open');
  modalSenderEmail = null;
  modalRecipientAddress = null;
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
    // Filter tree to only accounts relevant to this subscription
    const sub = subsCache.find(s => s.senderEmail === modalSenderEmail && s.recipientAddress === modalRecipientAddress);
    const relevantAccounts = new Set((sub?.messageGroups || []).map(g => g.accountName));
    const filtered = folderTreeCache.filter(a => relevantAccounts.has(a.accountName));
    renderFolderTree(filtered);
  } else {
    destWrap.style.display = 'none';
  }
}

function renderFolderTree(tree) {
  const container = document.getElementById('modal-dest-tree');
  let html = '';
  for (const account of tree) {
    html += `<div class="tree-account">
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
    const indent = depth * 16;
    html += `<div class="tree-node" style="padding-left:${indent}px">
      <label class="tree-folder-label">
        ${hasChildren
          ? `<span class="tree-toggle" data-folder-id="${esc(f.id)}">&#9656;</span>`
          : '<span class="tree-spacer"></span>'}
        <input type="radio" name="dest-folder" value="${esc(f.id)}">
        <span>${esc(f.name)}</span>
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

  const destRadio = document.querySelector('input[name="dest-folder"]:checked');
  if (!destRadio) {
    toast('Select a parent folder first', 'info');
    return;
  }

  try {
    const result = await bg('createFolder', { parentFolderId: destRadio.value, folderName: name });
    toast(`Created folder "${name}"`, 'success');
    nameInput.value = '';
    document.getElementById('modal-new-folder-form').style.display = 'none';
    // Refresh tree and auto-select new folder
    folderTreeCache = await bg('getFolderTree');
    renderFolderTree(folderTreeCache);
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
      return { accountName: g.accountName, folderName: g.folderName };
    });
}

async function doUnsubscribeConfirm() {
  if (!modalSenderEmail) return;
  const sub = subsCache.find(s => s.senderEmail === modalSenderEmail && s.recipientAddress === modalRecipientAddress);
  if (!sub) return;

  const dispose = document.querySelector('input[name="dispose"]:checked').value;
  const selectedFolders = getSelectedFolders();

  const confirmBtn = document.getElementById('modal-confirm');
  confirmBtn.disabled = true;
  confirmBtn.textContent = 'Unsubscribing...';

  // Fire unsubscribe
  let ok = false;
  const method = getBestMethod(sub);
  if (method) {
    try {
      if (method.type === 'oneclick') {
        const r = await bg('unsubOneClick', { url: method.url });
        ok = r.ok;
      } else if (method.type === 'mail') {
        await bg('unsubMail', { url: method.url, senderEmail: modalSenderEmail });
        ok = true;
      } else {
        await bg('unsubWeb', { url: method.url });
        ok = true;
      }
    } catch (e) {
      ok = false;
    }
  }

  // Apply dispose action on selected folders
  if (dispose === 'delete' && selectedFolders.length > 0) {
    try {
      await bg('deleteEmails', { senderEmail: modalSenderEmail, recipientAddress: modalRecipientAddress, selectedFolders });
    } catch (e) {
      toast('Error deleting emails: ' + (e.message || e), 'error');
    }
  } else if (dispose === 'move' && selectedFolders.length > 0) {
    const destRadio = document.querySelector('input[name="dest-folder"]:checked');
    if (destRadio) {
      try {
        await bg('moveEmails', {
          senderEmail: modalSenderEmail,
          recipientAddress: modalRecipientAddress,
          selectedFolders,
          destinationFolderId: destRadio.value
        });
      } catch (e) {
        toast('Error moving emails: ' + (e.message || e), 'error');
      }
    } else {
      toast('Select a destination folder', 'info');
      confirmBtn.disabled = false;
      confirmBtn.textContent = 'Unsubscribe';
      return;
    }
  }

  // Mark as unsubscribed
  try {
    await bg('decide', { senderEmail: modalSenderEmail, recipientAddress: modalRecipientAddress, decision: 'unsubscribed', dispose });
  } catch (e) {
    toast('Error: ' + (e.message || e), 'error');
  }

  // Remove card
  const cardId = `card-${sid(modalSenderEmail, modalRecipientAddress)}`;
  const card = document.getElementById(cardId);
  if (card) {
    card.classList.add('fading');
    setTimeout(() => card.remove(), 300);
  }

  const name = sub.senderName || sub.senderEmail;
  if (ok) {
    toast(`Unsubscribed from ${name}`, 'success');
  } else {
    toast(`Unsubscribed from ${name} (request may have failed)`, 'error');
  }

  closeUnsubModal();
  loadStats();
}

// ── Keep action ──────────────────────────────────────────────────────────────
async function doKeep(senderEmail, recipientAddress) {
  const cardId = `card-${sid(senderEmail, recipientAddress)}`;
  const card = document.getElementById(cardId);

  try {
    await bg('decide', { senderEmail, recipientAddress, decision: 'keep', dispose: null });
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
