'use strict';

document.addEventListener('DOMContentLoaded', async () => {
  // Load stats
  try {
    const stats = await browser.runtime.sendMessage({ command: 'getStats' });
    document.getElementById('stat-pending').textContent = stats.pending;
    document.getElementById('stat-kept').textContent = stats.kept;
    document.getElementById('stat-unsub').textContent = stats.unsubscribed;
  } catch (e) {
    // Stats unavailable
  }

  // Open full tab UI
  document.getElementById('open-btn').addEventListener('click', async () => {
    await browser.runtime.sendMessage({ command: 'openTab' });
    window.close();
  });
});
