'use strict';

let currentFilter = 'all';
let scanPollTimer = null;

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
    renderCards(subs);
  } catch (e) {
    grid.innerHTML = '<div style="color:var(--danger);padding:40px">Failed to load.</div>';
  }
}

function renderCards(subs) {
  const grid = document.getElementById('cards-grid');
  const empty = document.getElementById('empty-state');
  document.getElementById('card-count').textContent = subs.length + ' senders';

  if (!subs.length) {
    grid.innerHTML = '';
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';
  grid.innerHTML = subs.map(s => buildCard(s)).join('');
  attachCardListeners();
}

// ── Message group helpers (mirror background.js) ─────────────────────────────

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

function accountCount(messageGroups, accountName) {
  return (messageGroups || [])
    .filter(g => g.accountName === accountName)
    .reduce((sum, g) => sum + g.messageIds.length, 0);
}

function folderCount(messageGroups, accountName, folderName) {
  return (messageGroups || [])
    .filter(g => g.accountName === accountName && g.folderName === folderName)
    .reduce((sum, g) => sum + g.messageIds.length, 0);
}

// ── Unsub methods ────────────────────────────────────────────────────────────
function getUnsubMethods(s) {
  const methods = [];
  const urls = s.unsubUrls || [];
  const httpUrl = urls.find(u => u.startsWith('http')) || '';
  const mailtoUrl = urls.find(u => u.startsWith('mailto')) || '';

  if (s.oneClick && httpUrl) {
    methods.push({
      type: 'oneclick', label: 'One-Click Unsubscribe',
      description: 'Sends an automatic POST request to the sender (RFC 8058). Fastest and most reliable.',
      url: httpUrl, btnClass: 'btn-success'
    });
  }
  if (mailtoUrl) {
    methods.push({
      type: 'mail', label: 'Send Unsubscribe Email',
      description: 'Sends an email requesting removal from the mailing list.',
      url: mailtoUrl, btnClass: 'btn-accent'
    });
  }
  if (httpUrl && !s.oneClick) {
    methods.push({
      type: 'web', label: 'Open Unsubscribe Page',
      description: 'Opens the unsubscribe link in your browser. You may need to confirm on the page.',
      url: httpUrl, btnClass: 'btn-accent'
    });
  } else if (httpUrl && s.oneClick) {
    methods.push({
      type: 'web', label: 'Open in Browser (fallback)',
      description: 'Opens the unsubscribe page manually if one-click didn\'t work.',
      url: httpUrl, btnClass: 'btn-outline'
    });
  }
  if (s.embeddedUrl) {
    methods.push({
      type: 'embedded', label: 'Open Link from Email Body',
      description: 'Found an unsubscribe link inside the email content. Opens in your browser.',
      url: s.embeddedUrl, btnClass: 'btn-outline'
    });
  }
  return methods;
}

// ── Build card ───────────────────────────────────────────────────────────────
function buildCard(s) {
  const urls = s.unsubUrls || [];
  const groups = s.messageGroups || [];
  const byAccount = groupsByAccount(groups);
  const total = totalCount(groups);
  const color = avatarColor(s.senderEmail);
  const ini = initials(s.senderName, s.senderEmail);
  const id = sid(s.senderEmail);
  const methods = getUnsubMethods(s);
  const accountNames = Object.keys(byAccount);

  // Badges
  let badges = `<span class="badge badge-blue">${s.emailCount} emails</span>`;
  if (s.oneClick) badges += `<span class="badge badge-green">One-Click</span>`;
  if (s.hasMailto) badges += `<span class="badge badge-purple">Mailto</span>`;
  if (s.hasHttp && !s.oneClick) badges += `<span class="badge badge-orange">HTTP</span>`;
  if (s.embeddedUrl && !s.hasHttp && !s.hasMailto && !s.oneClick) badges += `<span class="badge badge-orange">Embedded</span>`;
  if (s.decision === 'keep') badges += `<span class="badge badge-kept">Kept</span>`;
  if (s.decision === 'unsubscribed') badges += `<span class="badge badge-unsub">Unsubscribed</span>`;

  const dateStr = s.lastDate ? new Date(s.lastDate).toLocaleDateString() : '';

  // Unsub methods HTML
  let unsubHtml = '';
  if (methods.length === 0) {
    unsubHtml = '<span style="color:var(--muted);font-size:12px">No unsubscribe method found</span>';
  } else {
    if (urls.length > 0) {
      unsubHtml += `<div class="unsub-urls">${urls.map(u => `<div class="url-item">${esc(u)}</div>`).join('')}</div>`;
    }
    if (s.embeddedUrl && !urls.includes(s.embeddedUrl)) {
      unsubHtml += `<div class="unsub-urls"><div class="url-item">Embedded: ${esc(s.embeddedUrl)}</div></div>`;
    }
    unsubHtml += '<div class="unsub-methods">';
    for (const m of methods) {
      unsubHtml += `
        <div class="unsub-method">
          <button class="btn btn-sm ${m.btnClass} js-unsub-method"
            data-method="${m.type}" data-url="${esc(m.url)}"
            data-sender-email="${esc(s.senderEmail)}" data-sender-name="${esc(s.senderName || '')}"
            >${esc(m.label)}</button>
          <span class="method-desc">${esc(m.description)}</span>
        </div>`;
    }
    unsubHtml += '</div>';
  }

  // Disposition HTML — broken down by account/folder with scoped actions
  let disposeHtml = buildDisposeSection(s, byAccount, total, id);

  const cardId = `card-${id}`;
  const panelId = `panel-${id}`;

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
    <button class="btn btn-unsub js-toggle-panel" data-panel="${panelId}">Unsubscribe</button>
  </div>
  <div class="expand-panel" id="${panelId}">
    <div class="expand-section">
      <h4>Unsubscribe method</h4>
      ${unsubHtml}
    </div>
    <div class="expand-section">
      <h4>What to do with existing emails?</h4>
      ${disposeHtml}
      <div style="margin-top:8px">
        <span class="cancel-link js-toggle-panel" data-panel="${panelId}">Cancel</span>
      </div>
    </div>
  </div>
</div>`;
}

function buildDisposeSection(s, byAccount, total, id) {
  const email = s.senderEmail;
  const name = s.senderName || '';
  const accountNames = Object.keys(byAccount);
  let html = '';

  // Breakdown table
  html += '<div class="dispose-breakdown">';
  for (const acct of accountNames) {
    const folders = byAccount[acct];
    const folderNames = Object.keys(folders);
    const acctTotal = Object.values(folders).reduce((a, b) => a + b, 0);

    html += `<div class="dispose-account">`;
    html += `<div class="dispose-account-header">${esc(acct)} (${acctTotal} emails)</div>`;

    for (const folder of folderNames) {
      const count = folders[folder];
      html += `
        <div class="dispose-folder-row">
          <span class="dispose-folder-label">${esc(folder)}: ${count} emails</span>
          <span class="dispose-folder-actions">
            <button class="btn btn-xs btn-danger js-dispose"
              data-action="delete" data-scope="folder"
              data-sender-email="${esc(email)}" data-sender-name="${esc(name)}"
              data-account="${esc(acct)}" data-folder="${esc(folder)}"
              data-count="${count}"
              >Delete</button>
            <button class="btn btn-xs btn-accent js-dispose"
              data-action="archive" data-scope="folder"
              data-sender-email="${esc(email)}" data-sender-name="${esc(name)}"
              data-account="${esc(acct)}" data-folder="${esc(folder)}"
              data-count="${count}"
              >Archive</button>
          </span>
        </div>`;
    }

    // Per-account actions (only if multiple folders)
    if (folderNames.length > 1) {
      html += `
        <div class="dispose-account-actions">
          <button class="btn btn-xs btn-danger js-dispose"
            data-action="delete" data-scope="account"
            data-sender-email="${esc(email)}" data-sender-name="${esc(name)}"
            data-account="${esc(acct)}" data-folder=""
            data-count="${acctTotal}"
            >Delete all ${acctTotal} in ${esc(acct)}</button>
          <button class="btn btn-xs btn-accent js-dispose"
            data-action="archive" data-scope="account"
            data-sender-email="${esc(email)}" data-sender-name="${esc(name)}"
            data-account="${esc(acct)}" data-folder=""
            data-count="${acctTotal}"
            >Archive all ${acctTotal} in ${esc(acct)}</button>
        </div>`;
    }

    html += '</div>';
  }
  html += '</div>';

  // Global actions (only if multiple accounts or just a nice catch-all)
  if (total > 0) {
    html += `
      <div class="dispose-global">
        <button class="btn btn-sm btn-danger js-dispose"
          data-action="delete" data-scope="all"
          data-sender-email="${esc(email)}" data-sender-name="${esc(name)}"
          data-account="" data-folder=""
          data-count="${total}"
          >Delete all ${total} emails everywhere</button>
        <button class="btn btn-sm btn-accent js-dispose"
          data-action="archive" data-scope="all"
          data-sender-email="${esc(email)}" data-sender-name="${esc(name)}"
          data-account="" data-folder=""
          data-count="${total}"
          >Archive all ${total} emails everywhere</button>
        <button class="btn btn-sm btn-muted js-dispose-keep"
          data-sender-email="${esc(email)}"
          >Keep all emails in place</button>
      </div>`;
  }

  return html;
}

// ── Event delegation ─────────────────────────────────────────────────────────
function attachCardListeners() {
  const grid = document.getElementById('cards-grid');

  grid.addEventListener('click', async (e) => {
    const btn = e.target.closest('button, .cancel-link');
    if (!btn) return;

    if (btn.classList.contains('js-toggle-panel')) {
      const panel = document.getElementById(btn.dataset.panel);
      if (panel) panel.classList.toggle('open');
      return;
    }

    if (btn.classList.contains('js-keep')) {
      await doKeep(btn.dataset.senderEmail);
      return;
    }

    if (btn.classList.contains('js-unsub-method')) {
      await doUnsubscribe(btn.dataset.method, btn.dataset.url, btn.dataset.senderEmail, btn.dataset.senderName, btn);
      return;
    }

    if (btn.classList.contains('js-dispose')) {
      await doDispose(btn);
      return;
    }

    if (btn.classList.contains('js-dispose-keep')) {
      await doDisposeKeep(btn.dataset.senderEmail);
      return;
    }
  });
}

// ── Unsubscribe actions ──────────────────────────────────────────────────────
async function doUnsubscribe(method, url, senderEmail, senderName, btn) {
  const sender = senderName ? `${senderName} <${senderEmail}>` : senderEmail;

  switch (method) {
    case 'oneclick': {
      const ok = confirm(
        `ONE-CLICK UNSUBSCRIBE\n\n` +
        `This will send an automatic POST request to unsubscribe from:\n` +
        `${sender}\n\n` +
        `URL: ${url}\n\n` +
        `Proceed?`
      );
      if (!ok) return;

      btn.disabled = true;
      btn.textContent = 'Sending...';
      try {
        const r = await bg('unsubOneClick', { url });
        if (r.ok) {
          toast(`One-click unsubscribe sent to ${senderEmail}`, 'success');
          btn.textContent = 'Sent';
        } else {
          toast(`Server responded with status ${r.status}`, 'error');
          btn.disabled = false;
          btn.textContent = 'One-Click Unsubscribe';
        }
      } catch (e) {
        toast('Error: ' + e.message, 'error');
        btn.disabled = false;
        btn.textContent = 'One-Click Unsubscribe';
      }
      break;
    }

    case 'mail': {
      let to = url, subject = 'unsubscribe';
      try {
        const parsed = new URL(url);
        to = parsed.pathname;
        subject = parsed.searchParams.get('subject') || 'unsubscribe';
      } catch (e) { /* use raw */ }

      const ok = confirm(
        `SEND UNSUBSCRIBE EMAIL\n\n` +
        `This will compose and immediately send an email:\n\n` +
        `To: ${to}\n` +
        `Subject: ${subject}\n` +
        `Body: "Please unsubscribe me from your mailing list. Thank you."\n\n` +
        `The email will be sent immediately from your default identity.\n\n` +
        `Proceed?`
      );
      if (!ok) return;

      btn.disabled = true;
      btn.textContent = 'Sending...';
      try {
        const r = await bg('unsubMail', { url, senderEmail });
        if (r.ok) {
          toast(`Unsubscribe email sent to ${r.to}`, 'success');
          btn.textContent = 'Sent';
        } else {
          toast('Failed to send email', 'error');
          btn.disabled = false;
          btn.textContent = 'Send Unsubscribe Email';
        }
      } catch (e) {
        toast('Error: ' + e.message, 'error');
        btn.disabled = false;
        btn.textContent = 'Send Unsubscribe Email';
      }
      break;
    }

    case 'web': {
      toast(`Opening unsubscribe page for ${senderEmail}...`, 'info');
      try { await bg('unsubWeb', { url }); }
      catch (e) { toast('Error: ' + e.message, 'error'); }
      break;
    }

    case 'embedded': {
      toast(`Opening embedded unsubscribe link for ${senderEmail}...`, 'info');
      try { await bg('unsubEmbedded', { url }); }
      catch (e) { toast('Error: ' + e.message, 'error'); }
      break;
    }
  }
}

// ── Disposition actions ──────────────────────────────────────────────────────
async function doDispose(btn) {
  const action = btn.dataset.action;     // 'delete' or 'archive'
  const scope = btn.dataset.scope;       // 'folder', 'account', or 'all'
  const senderEmail = btn.dataset.senderEmail;
  const senderName = btn.dataset.senderName;
  const accountName = btn.dataset.account;
  const folderName = btn.dataset.folder;
  const count = btn.dataset.count;

  const sender = senderName ? `${senderName} <${senderEmail}>` : senderEmail;
  const actionVerb = action === 'delete' ? 'Delete' : 'Archive';
  const actionPast = action === 'delete' ? 'deleted' : 'archived';
  const dest = action === 'delete' ? 'Trash' : 'Archive';

  // Build scope description
  let scopeDesc = '';
  if (scope === 'folder') {
    scopeDesc = `in folder "${folderName}" (account: ${accountName})`;
  } else if (scope === 'account') {
    scopeDesc = `in account "${accountName}" (all folders)`;
  } else {
    scopeDesc = `across ALL accounts and folders`;
  }

  const ok = confirm(
    `${actionVerb.toUpperCase()} EMAILS\n\n` +
    `${actionVerb} ${count} emails from:\n` +
    `${sender}\n` +
    `${scopeDesc}\n\n` +
    `Emails will be moved to ${dest}.\n\n` +
    `Are you sure?`
  );
  if (!ok) return;

  const command = action === 'delete' ? 'deleteEmails' : 'archiveEmails';
  toast(`${actionVerb === 'Delete' ? 'Deleting' : 'Archiving'} ${count} emails...`, 'info');

  try {
    const r = await bg(command, {
      senderEmail,
      scope,
      accountName,
      folderName
    });
    if (r.error) {
      toast(r.error, 'error');
      return;
    }
    const n = r.deleted || r.archived || 0;
    toast(`${actionPast.charAt(0).toUpperCase() + actionPast.slice(1)} ${n} emails from ${sender}`, 'success');
  } catch (e) {
    toast('Error: ' + e.message, 'error');
    return;
  }

  // If scope was 'all', mark as unsubscribed and remove card
  if (scope === 'all') {
    await markUnsubscribed(senderEmail, action);
  } else {
    // Partial action — reload the card to reflect new counts
    loadSubs(currentFilter);
  }
  loadStats();
}

async function doDisposeKeep(senderEmail) {
  await markUnsubscribed(senderEmail, 'keep');
  loadStats();
}

async function markUnsubscribed(senderEmail, dispose) {
  try {
    await bg('decide', { senderEmail, decision: 'unsubscribed', dispose });
    toast(`Marked ${senderEmail} as unsubscribed`, 'success');
  } catch (e) {
    toast('Error: ' + e.message, 'error');
    return;
  }

  const cardId = `card-${sid(senderEmail)}`;
  const card = document.getElementById(cardId);
  if (card) {
    card.classList.add('fading');
    setTimeout(() => { card.remove(); updateCardCount(); }, 300);
  }
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
        setTimeout(() => { card.remove(); updateCardCount(); }, 300);
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

function updateCardCount() {
  const cards = document.querySelectorAll('.card');
  document.getElementById('card-count').textContent = cards.length + ' senders';
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
  document.getElementById('scan-msg').textContent = 'Starting...';
  document.getElementById('progress-bar').style.width = '0';

  try {
    await bg('scan');
    pollScanStatus();
  } catch (e) {
    toast('Failed to start scan: ' + e.message, 'error');
    btn.disabled = false;
    btn.textContent = 'Scan Emails';
  }
}

function pollScanStatus() {
  if (scanPollTimer) clearInterval(scanPollTimer);
  scanPollTimer = setInterval(async () => {
    try {
      const s = await bg('getScanStatus');
      const pct = s.total > 0 ? Math.round(s.progress / s.total * 100) : 0;
      document.getElementById('progress-bar').style.width = pct + '%';
      const stats = `${(s.messagesScanned || 0).toLocaleString()} emails scanned, ${s.sendersFound || 0} senders found`;
      document.getElementById('scan-msg').textContent = `${s.message || ''}\n${stats}`;

      if (s.status === 'done' || s.done) {
        clearInterval(scanPollTimer);
        scanPollTimer = null;
        document.getElementById('scan-btn').disabled = false;
        document.getElementById('scan-btn').textContent = 'Scan Emails';
        document.getElementById('progress-bar').style.width = '100%';
        loadStats();
        loadSubs(currentFilter);
        toast('Scan complete! ' + (s.message || ''), 'success');
      }
    } catch (e) { /* ignore */ }
  }, 1000);
}

// ── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  document.getElementById('scan-btn').addEventListener('click', startScan);

  document.querySelectorAll('.filter-tab').forEach(tab => {
    tab.addEventListener('click', () => setFilter(tab.dataset.filter, tab));
  });

  await loadStats();
  await loadSubs('all');

  try {
    const s = await bg('getScanStatus');
    if (s.status === 'scanning') {
      document.getElementById('progress-wrap').style.display = 'block';
      document.getElementById('scan-btn').disabled = true;
      document.getElementById('scan-btn').textContent = 'Scanning...';
      pollScanStatus();
    }
  } catch (e) { /* ignore */ }
});
