document.addEventListener('DOMContentLoaded', () => {
  const totalEl = document.getElementById('total-count');
  const readEl = document.getElementById('read-count');
  const unreadEl = document.getElementById('unread-count');
  const lastSyncEl = document.getElementById('last-sync');
  const openLibraryBtn = document.getElementById('open-library');
  const syncAmazonBtn = document.getElementById('sync-amazon');
  const regionSelect = document.getElementById('amazon-region');

  // ── Stats ──
  function updateStats() {
    chrome.runtime.sendMessage({ type: 'GET_STATS' }, (response) => {
      if (chrome.runtime.lastError || !response) {
        totalEl.textContent = '0';
        readEl.textContent = '0';
        unreadEl.textContent = '0';
        return;
      }

      totalEl.textContent = response.total || 0;
      readEl.textContent = response.read || 0;
      unreadEl.textContent = response.unread || 0;

      const syncDate = response.syncDate;
      if (syncDate) {
        const date = new Date(syncDate);
        const now = new Date();
        const diffMs = now - date;
        const diffMins = Math.floor(diffMs / 60000);
        const diffHours = Math.floor(diffMs / 3600000);
        const diffDays = Math.floor(diffMs / 86400000);

        let formatted;
        if (diffMins < 1) formatted = 'Just now';
        else if (diffMins < 60) formatted = `${diffMins}m ago`;
        else if (diffHours < 24) formatted = `${diffHours}h ago`;
        else if (diffDays < 7) formatted = `${diffDays}d ago`;
        else formatted = date.toLocaleDateString(undefined, {
          month: 'short', day: 'numeric',
          year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined
        });
        lastSyncEl.textContent = formatted;
      } else {
        lastSyncEl.textContent = 'Never';
      }
    });
  }

  // ── Region selector ──
  function loadRegions() {
    chrome.runtime.sendMessage({ type: 'GET_AMAZON_DOMAINS' }, (response) => {
      if (chrome.runtime.lastError || !response) return;
      const { domains, current } = response;
      regionSelect.innerHTML = '';
      for (const [domain, label] of Object.entries(domains)) {
        const opt = document.createElement('option');
        opt.value = domain;
        opt.textContent = label;
        if (domain === current) opt.selected = true;
        regionSelect.appendChild(opt);
      }
    });
  }

  regionSelect.addEventListener('change', () => {
    chrome.runtime.sendMessage({ type: 'SET_AMAZON_DOMAIN', domain: regionSelect.value });
  });

  // ── Buttons ──
  openLibraryBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'OPEN_LIBRARY' });
    window.close();
  });

  syncAmazonBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'TRIGGER_SYNC' });
    window.close();
  });

  // ── Listen for updates ──
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'LIBRARY_UPDATED') updateStats();
  });

  // ── Init ──
  updateStats();
  loadRegions();
});
