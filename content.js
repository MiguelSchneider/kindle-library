// Kindle Library Extension - Content Script
// Runs on Amazon Kindle content management pages after parser.js loads.
// Scrapes book entries, auto-paginates, and sends data to the background script.

(function () {
  'use strict';

  const ENTRY_SELECTOR = '[class*="DigitalEntitySummary-module__container"]';
  const SIZE_RE = /^\d+(\.\d+)?\s*(KB|MB|GB|bytes)$/i;
  // Match Spanish ("Fecha de creación") and English ("Date Added") labels
  const DATE_PREFIX_RE = /^(?:Fecha de creaci\u00f3n|Date Added)[:\s]*/i;
  const PAGE_LOAD_TIMEOUT = 15000;
  const PAGE_LOAD_POLL_MS = 300;

  let isSyncing = false;

  // ── UI Helpers ──

  function createSyncButton() {
    if (document.querySelector('.kindle-ext-sync-btn')) return;
    const btn = document.createElement('button');
    btn.className = 'kindle-ext-sync-btn';
    btn.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
        '<path d="M4 19.5A2.5 2.5 0 016.5 17H20"/>' +
        '<path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z"/>' +
        '<polyline points="12 8 16 12 12 16"/><line x1="8" y1="12" x2="16" y2="12"/>' +
      '</svg>' +
      'Sync to Kindle Library';
    btn.addEventListener('click', () => startSync());
    document.body.appendChild(btn);
  }

  function showOverlay() {
    removeOverlay();
    const overlay = document.createElement('div');
    overlay.className = 'kindle-ext-overlay';
    overlay.id = 'kindle-ext-overlay';
    overlay.innerHTML =
      '<div class="kindle-ext-overlay-card" style="position:relative;">' +
        '<button class="kindle-ext-close" id="kindle-ext-close">&times;</button>' +
        '<div class="kindle-ext-spinner" id="kindle-ext-spinner"></div>' +
        '<div class="kindle-ext-check" id="kindle-ext-check">&#10003;</div>' +
        '<div class="kindle-ext-error-icon" id="kindle-ext-error-icon">!</div>' +
        '<div class="kindle-ext-progress-title" id="kindle-ext-title">Syncing...</div>' +
        '<div class="kindle-ext-progress-detail" id="kindle-ext-detail">Preparing...</div>' +
        '<button class="kindle-ext-link" id="kindle-ext-link" style="display:none;">Open Library</button>' +
      '</div>';
    document.body.appendChild(overlay);
    document.getElementById('kindle-ext-close').addEventListener('click', () => {
      removeOverlay();
    });
    document.getElementById('kindle-ext-link').addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'OPEN_LIBRARY' });
    });
  }

  function updateOverlay(title, detail) {
    const t = document.getElementById('kindle-ext-title');
    const d = document.getElementById('kindle-ext-detail');
    if (t) t.textContent = title;
    if (d) d.textContent = detail;
  }

  function showComplete(added, total) {
    const card = document.querySelector('.kindle-ext-overlay-card');
    if (card) card.classList.add('kindle-ext-complete');
    const detail = added > 0
      ? added + ' new book' + (added !== 1 ? 's' : '') + ' added · ' + total + ' total'
      : 'Already up to date · ' + total + ' books';
    updateOverlay('Sync complete!', detail);
    const link = document.getElementById('kindle-ext-link');
    if (link) link.style.display = 'inline-block';
  }

  function showError(msg) {
    const card = document.querySelector('.kindle-ext-overlay-card');
    if (card) card.classList.add('kindle-ext-error');
    updateOverlay('Sync failed', msg);
  }

  function removeOverlay() {
    const el = document.getElementById('kindle-ext-overlay');
    if (el) el.remove();
  }

  // ── Page Data Detection ──

  function detectAccountOwner() {
    // Try the nav greeting: "Hola, Michael"
    const accountLink = document.getElementById('nav-link-accountList');
    if (accountLink) {
      const greetText = accountLink.querySelector('.nav-line-1, [data-csa-c-content-id="nav_greeting"]');
      if (greetText) {
        const m = greetText.textContent.match(/(?:Hola|Hello|Hi),?\s+(.+)/i);
        if (m) return m[1].trim();
      }
      // Fallback: just get the first line text
      const firstLine = accountLink.querySelector('.nav-line-1');
      if (firstLine) {
        const m = firstLine.textContent.match(/(?:Hola|Hello|Hi),?\s+(.+)/i);
        if (m) return m[1].trim();
      }
    }
    // Broader search for greeting text
    const spans = document.querySelectorAll('#nav-link-accountList span, .nav-line-1');
    for (const span of spans) {
      const m = span.textContent.match(/(?:Hola|Hello|Hi),?\s+(.+)/i);
      if (m) return m[1].trim();
    }
    return null;
  }

  function detectTotalInfo() {
    const body = document.body.innerText;
    // Spanish: "Mostrando X a Y de Z elementos"
    // English: "Showing X to Y of Z items" or "Showing X - Y of Z"
    const m = body.match(/(?:Mostrando|Showing)\s+(\d+)\s+(?:a|to|-)\s+(\d+)\s+(?:de|of)\s+(\d+)\s+(?:elementos|items?)/i);
    if (m) {
      const from = parseInt(m[1], 10);
      const to = parseInt(m[2], 10);
      const total = parseInt(m[3], 10);
      const perPage = to - from + 1;
      const totalPages = Math.ceil(total / perPage);
      return { from, to, total, perPage, totalPages };
    }
    return null;
  }

  function getCurrentPageNumber() {
    const url = new URL(window.location.href);
    return parseInt(url.searchParams.get('pageNumber') || '1', 10);
  }

  // ── Scraping ──

  function scrapeCurrentPage(accountOwner) {
    const containers = document.querySelectorAll(ENTRY_SELECTOR);
    const books = [];

    for (const container of containers) {
      try {
        const text = container.innerText;
        const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        if (lines.length < 2) continue;

        const rawTitle = lines[0];
        const amazonAuthor = lines[1];

        // Find size line
        let size = '';
        for (const line of lines) {
          if (SIZE_RE.test(line)) {
            size = line;
            break;
          }
        }

        // Find date line — supports Spanish ("Fecha de creación") and English ("Date Added")
        let dateRaw = '';
        for (const line of lines) {
          const m = line.match(DATE_PREFIX_RE);
          if (m) {
            dateRaw = line.substring(m[0].length).trim();
            break;
          }
        }
        // Date might be on the next line after the label
        if (!dateRaw) {
          for (let i = 0; i < lines.length; i++) {
            if (DATE_PREFIX_RE.test(lines[i]) && i + 1 < lines.length) {
              dateRaw = lines[i + 1].trim();
              break;
            }
          }
        }

        // Check if read
        const isRead = lines.some(l => l.toUpperCase().includes('LE\u00cdDO'));

        // Use parser
        const parsed = window.KindleParser.parseBook(rawTitle, amazonAuthor, accountOwner);
        const isoDate = window.KindleParser.dateToISO(dateRaw);
        const id = window.KindleParser.generateId(rawTitle);

        books.push({
          id,
          rawTitle,
          title: parsed.title,
          author: parsed.author,
          amazonAuthor,
          size,
          date: isoDate,
          dateRaw,
          read: isRead
        });
      } catch (err) {
        console.warn('[Kindle Ext] Error parsing entry:', err);
      }
    }

    return books;
  }

  // ── Pagination via Navigation ──

  function navigateToPage(pageNum) {
    const url = new URL(window.location.href);
    url.searchParams.set('pageNumber', String(pageNum));
    window.location.href = url.toString();
  }

  function waitForPageLoad(expectedPageNum) {
    return new Promise((resolve, reject) => {
      const start = Date.now();

      function check() {
        // Check if the page content has loaded for the expected page
        const containers = document.querySelectorAll(ENTRY_SELECTOR);
        const info = detectTotalInfo();

        if (containers.length > 0 && info) {
          // Verify we are on the right page by checking the "Mostrando X a Y" range
          const expectedFrom = (expectedPageNum - 1) * info.perPage + 1;
          if (info.from === expectedFrom || getCurrentPageNumber() === expectedPageNum) {
            resolve();
            return;
          }
        }

        if (Date.now() - start > PAGE_LOAD_TIMEOUT) {
          reject(new Error('Page load timeout for page ' + expectedPageNum));
          return;
        }

        setTimeout(check, PAGE_LOAD_POLL_MS);
      }

      check();
    });
  }

  // Find the next-page clickable element
  function findNextPageElement(currentPage) {
    const targetPage = currentPage + 1;

    // 1. <a href*="pageNumber=N">
    for (const link of document.querySelectorAll('a[href*="pageNumber="]')) {
      const m = (link.getAttribute('href') || '').match(/pageNumber=(\d+)/);
      if (m && parseInt(m[1], 10) === targetPage) return link;
    }

    // 2. Any element (a or button) in pagination with text == targetPage
    const paginationEls = document.querySelectorAll(
      '[class*="pagination"] a, [class*="Pagination"] a, [class*="paging"] a,' +
      '[class*="pagination"] button, [class*="Pagination"] button, [class*="paging"] button'
    );
    for (const el of paginationEls) {
      if (el.textContent.trim() === String(targetPage)) return el;
    }

    // 3. Any "Next" / "Siguiente" button/link
    const allClickable = document.querySelectorAll('a, button');
    for (const el of allClickable) {
      const txt = el.textContent.trim().toLowerCase();
      if (txt === 'siguiente' || txt === 'next' || txt === '›' || txt === '»') return el;
    }

    return null;
  }

  // Use click-based pagination: find the next page link and click it,
  // then wait for the DOM to update using a MutationObserver.
  function goToNextPageViaClick(currentPage) {
    return new Promise((resolve, reject) => {
      const nextLink = findNextPageElement(currentPage);

      if (!nextLink) {
        reject(new Error('Could not find link to page ' + (currentPage + 1)));
        return;
      }

      // Capture current entries to detect change
      const oldEntries = document.querySelectorAll(ENTRY_SELECTOR);
      const oldFirstText = oldEntries.length > 0 ? oldEntries[0].innerText.substring(0, 80) : '';

      const timeout = setTimeout(() => {
        observer.disconnect();
        // Even if observer didn't fire, check if content actually changed
        const newEntries = document.querySelectorAll(ENTRY_SELECTOR);
        if (newEntries.length > 0) {
          resolve();
        } else {
          reject(new Error('Page load timeout waiting for page ' + targetPage));
        }
      }, PAGE_LOAD_TIMEOUT);

      const observer = new MutationObserver(() => {
        const newEntries = document.querySelectorAll(ENTRY_SELECTOR);
        if (newEntries.length > 0) {
          const newFirstText = newEntries[0].innerText.substring(0, 80);
          if (newFirstText !== oldFirstText) {
            clearTimeout(timeout);
            observer.disconnect();
            // Small delay for the DOM to stabilize
            setTimeout(resolve, 500);
          }
        }
      });

      observer.observe(document.body, { childList: true, subtree: true });
      nextLink.click();
    });
  }

  // ── Main Sync Flow ──

  async function startSync() {
    if (isSyncing) return;
    isSyncing = true;
    showOverlay();

    try {
      const accountOwner = detectAccountOwner();
      const info = detectTotalInfo();
      const totalPages = info ? info.totalPages : '?';
      let currentPage = getCurrentPageNumber();

      updateOverlay('Syncing...', 'Page ' + currentPage + ' of ' + totalPages + '…');

      let allBooks = [];

      // Scrape current page first
      const booksOnPage = scrapeCurrentPage(accountOwner);
      allBooks = allBooks.concat(booksOnPage);

      // Paginate through all pages
      while (true) {
        const nextPage = currentPage + 1;
        if (typeof totalPages === 'number' && currentPage >= totalPages) break;
        if (!findNextPageElement(currentPage)) break;

        updateOverlay('Syncing...', 'Page ' + nextPage + ' of ' + totalPages + ' (' + allBooks.length + ' books)');

        try {
          await goToNextPageViaClick(currentPage);
        } catch (navErr) {
          console.warn('[Kindle Ext] Click navigation failed:', navErr);
          break;
        }

        currentPage = nextPage;
        await sleep(300);

        const pageBooksRaw = scrapeCurrentPage(accountOwner);
        if (pageBooksRaw.length === 0) break;
        allBooks = allBooks.concat(pageBooksRaw);
      }

      // Deduplicate by rawTitle (keep first occurrence)
      const seen = new Set();
      const books = [];
      for (const book of allBooks) {
        if (!seen.has(book.rawTitle)) {
          seen.add(book.rawTitle);
          books.push(book);
        }
      }

      // Send to background (background will merge, not replace)
      const result = await chrome.runtime.sendMessage({
        type: 'SYNC_COMPLETE',
        books,
        syncDate: new Date().toISOString()
      });

      const added = result?.added ?? books.length;
      const total = result?.total ?? books.length;
      showComplete(added, total);

    } catch (err) {
      console.error('[Kindle Ext] Sync error:', err);
      showError(err.message || 'An unexpected error occurred.');
    } finally {
      isSyncing = false;
    }
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ── Message Listener ──

  chrome.runtime.onMessage.addListener((msg, _sender, _sendResponse) => {
    if (msg && msg.type === 'START_SYNC') {
      startSync();
    }
  });

  // ── Initialize ──

  createSyncButton();

  // Auto-start sync if triggered from popup/library (flag set by background.js)
  chrome.storage.local.get('kindle-auto-sync', (result) => {
    if (result['kindle-auto-sync']) {
      chrome.storage.local.remove('kindle-auto-sync');
      // Small delay to let the page finish rendering
      setTimeout(() => startSync(), 1500);
    }
  });
})();
