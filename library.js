// ---- STATE ----
let books = [];
let booksData = []; // base data from storage (pre-edits)
let coverCache = {};
let goodreadsCache = {};
let edits = {};
let currentFilter = 'all';
let currentSort = 'date-desc';
let currentSearch = '';
let editingBook = null;

// ---- DATA LOADING (chrome.storage via background) ----
async function loadBooks() {
  const resp = await chrome.runtime.sendMessage({ type: 'GET_LIBRARY' });
  booksData = resp.books || [];
  // Strip 'none' entries from cover cache so failed fetches retry on next load
  const rawCovers = resp.covers || {};
  coverCache = {};
  for (const [k, v] of Object.entries(rawCovers)) {
    if (v && v !== 'none') coverCache[k] = v;
  }

  // Strip 'none' entries and stale low-count entries (from old HTML scraper)
  const raw = resp.goodreads || {};
  goodreadsCache = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v && v !== 'none' && v.ratingsCount > 100) goodreadsCache[k] = v;
  }
  edits = resp.edits || {};

  // Apply edits: merge base data with user overrides.
  // _idx = original storage position (Amazon returns books in dateDsc order,
  // so idx 0 is the newest book — used as a date-sort fallback when date is empty).
  books = booksData.map((b, i) => {
    const e = edits[b.id];
    return e
      ? { ...b, title: e.title ?? b.title, author: e.author ?? b.author, read: e.read ?? b.read, _idx: i }
      : { ...b, _idx: i };
  });

  updateStats();

  if (books.length === 0) {
    showWelcome();
  } else {
    hideWelcome();
    render();
  }
}

function saveCoverCache() {
  chrome.runtime.sendMessage({ type: 'SAVE_COVERS', covers: coverCache });
}

function saveEdits() {
  chrome.runtime.sendMessage({ type: 'SAVE_EDITS', edits });
}

function saveGoodreadsCache() {
  chrome.runtime.sendMessage({ type: 'SAVE_GOODREADS', goodreads: goodreadsCache });
}

// ---- LISTEN FOR SYNC UPDATES ----
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'LIBRARY_UPDATED') loadBooks();
});

// ---- SYNC BUTTON ----
function initSyncButton() {
  const btn = document.getElementById('syncBtn');
  btn.addEventListener('click', () => {
    btn.classList.add('syncing');
    chrome.runtime.sendMessage({ type: 'TRIGGER_SYNC' });
    // Remove syncing state after a timeout or when LIBRARY_UPDATED arrives
    setTimeout(() => btn.classList.remove('syncing'), 30000);
  });

  // Also clear syncing state when library updates
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'LIBRARY_UPDATED') {
      btn.classList.remove('syncing');
    }
  });
}

// ---- WELCOME / EMPTY STATE ----
function showWelcome() {
  const container = document.querySelector('.grid-container');
  container.innerHTML = `
    <div class="welcome">
      <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/>
        <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>
        <line x1="9" y1="7" x2="15" y2="7"/>
        <line x1="9" y1="11" x2="15" y2="11"/>
      </svg>
      <h2>Welcome to Kindle Library</h2>
      <p>Sync your Kindle Personal Documents from Amazon to view them here.</p>
      <button class="btn btn-primary" id="welcomeSyncBtn">Sync from Amazon</button>
    </div>
  `;
  document.getElementById('welcomeSyncBtn').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'TRIGGER_SYNC' });
    document.getElementById('syncBtn').classList.add('syncing');
  });
}

function hideWelcome() {
  const container = document.querySelector('.grid-container');
  // Restore grid structure if welcome was shown
  if (!document.getElementById('grid')) {
    container.innerHTML = `
      <div class="book-count" id="bookCount"></div>
      <div class="grid" id="grid"></div>
    `;
  }
}

// ---- RENDER ----
function getFilteredBooks() {
  let filtered = books;
  if (currentFilter === 'read') filtered = filtered.filter(b => b.read);
  if (currentFilter === 'unread') filtered = filtered.filter(b => !b.read);
  if (currentSearch) {
    const q = currentSearch.toLowerCase();
    filtered = filtered.filter(b =>
      b.title.toLowerCase().includes(q) || b.author.toLowerCase().includes(q)
    );
  }
  // Sort
  const [key, dir] = currentSort.split('-');
  const mult = dir === 'asc' ? 1 : -1;
  filtered.sort((a, b) => {
    if (key === 'date') {
      // Amazon scrapes books in dateDsc order: _idx 0 = most recently uploaded.
      // Use position directly — no date parsing needed.
      return dir === 'desc' ? a._idx - b._idx : b._idx - a._idx;
    }
    if (key === 'title') return mult * a.title.localeCompare(b.title, 'es');
    if (key === 'author') return mult * a.author.localeCompare(b.author, 'es');
    if (key === 'rating') {
      const cacheKeyA = a.title + '|' + a.author;
      const cacheKeyB = b.title + '|' + b.author;
      const rA = goodreadsCache[cacheKeyA]?.rating ?? -1;
      const rB = goodreadsCache[cacheKeyB]?.rating ?? -1;
      return mult * (rA - rB);
    }
    return 0;
  });
  return filtered;
}

function getPlaceholderColor(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
  const hue = Math.abs(hash % 360);
  return `hsl(${hue}, 35%, 22%)`;
}

function getInitials(title) {
  return title.split(/\s+/).filter(w => w.length > 2).slice(0, 2).map(w => w[0].toUpperCase()).join('');
}

function createCard(book) {
  const card = document.createElement('div');
  card.className = 'card';
  card.dataset.id = book.id;

  const bgColor = getPlaceholderColor(book.title + book.author);
  const initials = getInitials(book.title);

  card.innerHTML = `
    <div class="card-cover">
      <div class="card-placeholder" style="background:${bgColor}">
        <div class="initials">${initials}</div>
        <div class="ph-title">${escHtml(book.title)}</div>
      </div>
      ${book.read ? '<span class="read-badge read">Read</span>' : ''}
    </div>
    <div class="card-info">
      <div class="card-title">${escHtml(book.title)}</div>
      <div class="card-author">${escHtml(book.author)}</div>
      <div class="card-meta">
        <span>${book.size}</span>
        <span>${shortDate(book.date)}</span>
      </div>
    </div>
  `;

  // Load cover and Goodreads rating
  loadCover(book, card);
  loadGoodreads(book, card);

  card.addEventListener('click', () => openModal(book));
  return card;
}

// ---- COVER LOADING (IntersectionObserver + throttled queue) ----
// Only visible cards trigger fetches — avoids hammering Google Books with
// 234 simultaneous requests and hitting rate limits on the first page open.

let coverQueue = [];
let coverFetching = false;
let coverObserver = null;

function initCoverObserver() {
  if (coverObserver) coverObserver.disconnect();
  coverObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        coverObserver.unobserve(entry.target);
        scheduleCoverForCard(entry.target);
      }
    }
  }, { rootMargin: '400px' }); // pre-load cards 400px before they scroll into view
}

function scheduleCoverForCard(card) {
  if (card.dataset.coverQueued) return;
  const bookId = card.dataset.id;
  const book = books.find(b => String(b.id) === String(bookId));
  if (!book) return;
  const cacheKey = book.title + '|' + book.author;
  if (coverCache[cacheKey]) { insertCoverImg(card, coverCache[cacheKey]); return; }
  card.dataset.coverQueued = '1';
  coverQueue.push({ book, card, cacheKey });
  processCoverQueue();
}

function loadCover(book, card) {
  const cacheKey = book.title + '|' + book.author;
  // Cache hit — show immediately
  if (coverCache[cacheKey]) { insertCoverImg(card, coverCache[cacheKey]); return; }
  // Skip known-junk titles
  if (book.title.startsWith('Unknown Book') || book.title.startsWith('annas-arch') || book.title.includes('OWD User Tests')) return;
  // Defer to IntersectionObserver so only visible cards make API calls
  if (coverObserver) coverObserver.observe(card);
}

async function processCoverQueue() {
  if (coverFetching || coverQueue.length === 0) return;
  coverFetching = true;
  while (coverQueue.length > 0) {
    const { book, card, cacheKey } = coverQueue.shift();
    // Already cached by a parallel entry
    if (coverCache[cacheKey]) { insertCoverImg(card, coverCache[cacheKey]); continue; }
    try {
      const q = encodeURIComponent(book.title + ' ' + book.author);
      const r = await fetch(`https://www.googleapis.com/books/v1/volumes?q=${q}&maxResults=1`);

      if (r.status === 429 || r.status === 403) {
        // Rate limited — put back at front of queue and wait before retrying
        coverQueue.unshift({ book, card, cacheKey });
        delete card.dataset.coverQueued;
        await new Promise(r => setTimeout(r, 8000));
        continue;
      }

      if (r.ok) {
        const data = await r.json();
        const thumb = data.items?.[0]?.volumeInfo?.imageLinks?.thumbnail;
        if (thumb) {
          const url = thumb.replace('http://', 'https://');
          coverCache[cacheKey] = url;
          saveCoverCache();
          insertCoverImg(card, url);
        }
        // No result → don't cache anything; will retry on next library open
      }
    } catch (e) {
      // Network error → don't cache; retry next time
      console.warn('[Kindle] Cover fetch error for', book.title, e);
    }
    // 500ms between requests: safe for Google's free-tier rate limit
    await new Promise(r => setTimeout(r, 500));
  }
  coverFetching = false;
}

function insertCoverImg(card, url) {
  const cover = card.querySelector('.card-cover');
  if (!cover) return;
  const img = document.createElement('img');
  img.className = 'loading';
  img.alt = '';
  img.loading = 'lazy';
  img.onload = () => { img.className = 'loaded'; };
  img.onerror = () => { img.remove(); };
  img.src = url;
  cover.insertBefore(img, cover.querySelector('.read-badge'));
}

// ---- GOODREADS ----
let grQueue = [];
let grFetching = false;

function loadGoodreads(book, card) {
  const cacheKey = book.title + '|' + book.author;
  if (goodreadsCache[cacheKey]) {
    insertGoodreads(card, goodreadsCache[cacheKey]);
    return;
  }
  if (card.dataset.grDone) return;
  if (book.title.startsWith('Unknown Book') || book.title.startsWith('annas-arch') || book.title.includes('OWD User Tests') || book.author === 'Unknown') {
    return;
  }
  grQueue.push({ book, card, cacheKey });
  processGrQueue();
}

async function processGrQueue() {
  if (grFetching || grQueue.length === 0) return;
  grFetching = true;
  while (grQueue.length > 0) {
    const { book, card, cacheKey } = grQueue.shift();
    // Skip if already fetched while queued
    if (goodreadsCache[cacheKey]) {
      if (goodreadsCache[cacheKey] !== 'none') insertGoodreads(card, goodreadsCache[cacheKey]);
      continue;
    }
    try {
      // Use autocomplete JSON API — returns real rating counts (not lazy-loaded HTML)
      // Search by title only: including author suppresses main book in favor of summaries
      const q = encodeURIComponent(book.title);
      const resp = await fetch(`https://www.goodreads.com/book/auto_complete?format=json&q=${q}`);
      const results = await resp.json();

      // Pick the result with the most ratings (ignores summaries/study guides)
      let best = null;
      let bestCount = 0;
      for (const item of results) {
        const count = item.ratingsCount || 0;
        if (count > bestCount) {
          bestCount = count;
          best = {
            url: 'https://www.goodreads.com' + item.bookUrl,
            rating: parseFloat(item.avgRating) || 0,
            ratingsCount: count,
          };
        }
      }

      if (best && best.ratingsCount > 0 && best.rating > 0) {
        goodreadsCache[cacheKey] = best;
        insertGoodreads(card, best);
        saveGoodreadsCache();
      }
      // Don't cache 'none' — allow retry on next load if not found
    } catch (e) {
      console.warn('[Kindle] Goodreads fetch failed for', book.title, e);
    }
    // Throttle: wait 800ms between requests
    await new Promise(r => setTimeout(r, 800));
  }
  grFetching = false;
}

function insertGoodreads(card, data) {
  if (card.dataset.grDone) return; // prevent any double-insertion
  card.dataset.grDone = '1';
  const info = card.querySelector('.card-info');
  if (!info) return;

  const stars = renderStars(data.rating);
  const countStr = data.ratingsCount >= 1000000
    ? (data.ratingsCount / 1000000).toFixed(1) + 'M'
    : data.ratingsCount >= 1000
      ? Math.round(data.ratingsCount / 1000) + 'K'
      : data.ratingsCount.toString();

  const el = document.createElement('a');
  el.className = 'gr-rating';
  el.href = data.url;
  el.target = '_blank';
  el.rel = 'noopener';
  el.title = `${data.rating} avg rating · ${data.ratingsCount.toLocaleString()} ratings on Goodreads`;
  el.innerHTML = `<span class="gr-stars">${stars}</span><span class="gr-num">${data.rating.toFixed(2)}</span><span class="gr-count">· ${countStr}</span>`;
  el.addEventListener('click', (e) => e.stopPropagation());
  info.insertBefore(el, info.querySelector('.card-meta'));
}

function renderStars(rating) {
  let html = '';
  for (let i = 1; i <= 5; i++) {
    if (rating >= i) html += '<span class="gr-star full">&#9733;</span>';
    else if (rating >= i - 0.5) html += '<span class="gr-star half">&#9733;</span>';
    else html += '<span class="gr-star empty">&#9734;</span>';
  }
  return html;
}

function render() {
  initCoverObserver(); // reset observer so new cards get observed
  const filtered = getFilteredBooks();
  const grid = document.getElementById('grid');
  if (!grid) return;
  grid.innerHTML = '';

  document.getElementById('bookCount').textContent =
    `Showing ${filtered.length} of ${books.length} books`;

  if (filtered.length === 0) {
    grid.innerHTML = `
      <div class="empty" style="grid-column:1/-1">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        <p>No books found</p>
      </div>`;
    return;
  }

  const fragment = document.createDocumentFragment();
  filtered.forEach(b => fragment.appendChild(createCard(b)));
  grid.appendChild(fragment);
}

function updateStats() {
  const read = books.filter(b => b.read).length;
  const total = books.length;
  document.getElementById('stats').innerHTML =
    `<span><span class="num">${total}</span> books</span>
     <span><span class="num">${read}</span> read</span>
     <span><span class="num">${total - read}</span> unread</span>`;
}

// ---- MODAL ----
function openModal(book) {
  editingBook = book;
  document.getElementById('editTitle').value = book.title;
  document.getElementById('editAuthor').value = book.author;
  document.getElementById('editSize').value = book.size;
  document.getElementById('editDate').value = book.date;
  setToggle(book.read);
  document.getElementById('modal').classList.add('open');
  document.getElementById('editTitle').focus();
}

function closeModal() {
  document.getElementById('modal').classList.remove('open');
  editingBook = null;
}

function setToggle(on) {
  const track = document.getElementById('toggleTrack');
  const label = document.getElementById('toggleLabel');
  if (on) { track.classList.add('on'); label.textContent = 'Read'; }
  else { track.classList.remove('on'); label.textContent = 'Unread'; }
}

function saveEdit() {
  if (!editingBook) return;
  const newTitle = document.getElementById('editTitle').value.trim();
  const newAuthor = document.getElementById('editAuthor').value.trim();
  const newRead = document.getElementById('toggleTrack').classList.contains('on');

  if (!newTitle) return;

  // Find original base data (pre-edits)
  const orig = booksData.find(b => b.id === editingBook.id);
  const changed = newTitle !== orig.title || newAuthor !== orig.author || newRead !== orig.read;

  if (changed) {
    edits[editingBook.id] = { title: newTitle, author: newAuthor, read: newRead };
  } else {
    delete edits[editingBook.id];
  }
  saveEdits();

  // Update in-memory
  const book = books.find(b => b.id === editingBook.id);
  book.title = newTitle;
  book.author = newAuthor;
  book.read = newRead;

  // Clear cover cache if title/author changed
  if (newTitle !== editingBook.title || newAuthor !== editingBook.author) {
    const oldKey = editingBook.title + '|' + editingBook.author;
    delete coverCache[oldKey];
    saveCoverCache();
  }

  updateStats();
  render();
  closeModal();
}

function resetEdit() {
  if (!editingBook) return;
  const orig = booksData.find(b => b.id === editingBook.id);
  if (!orig) return;

  // Remove the edit override
  delete edits[editingBook.id];
  saveEdits();

  // Restore original values in the in-memory book
  const book = books.find(b => b.id === editingBook.id);
  book.title = orig.title;
  book.author = orig.author;
  book.read = orig.read;

  // Update modal fields to show restored values
  document.getElementById('editTitle').value = orig.title;
  document.getElementById('editAuthor').value = orig.author;
  setToggle(orig.read);

  updateStats();
  render();
}

// ---- HELPERS ----
function escHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function shortDate(dateStr) {
  if (!dateStr) return '';
  // ISO format: "2026-03-28"
  const iso = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    const d = new Date(dateStr + 'T00:00:00');
    return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
  }
  // Spanish format: "28 de marzo de 2026"
  const m = dateStr.match(/de\s+(\w+)\s+de\s+(\d{4})/);
  if (!m) return dateStr;
  const months = {
    enero:'Jan',febrero:'Feb',marzo:'Mar',abril:'Apr',mayo:'May',junio:'Jun',
    julio:'Jul',agosto:'Aug',septiembre:'Sep',octubre:'Oct',noviembre:'Nov',diciembre:'Dec'
  };
  return (months[m[1]] || m[1]) + ' ' + m[2];
}

// ---- EVENTS ----
function bindEvents() {
  // Search
  let searchTimer;
  document.getElementById('search').addEventListener('input', e => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      currentSearch = e.target.value.trim();
      render();
    }, 200);
  });

  // Filters
  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentFilter = btn.dataset.filter;
      render();
    });
  });

  // Sort
  document.getElementById('sort').addEventListener('change', e => {
    currentSort = e.target.value;
    render();
  });

  // Modal
  document.getElementById('modalClose').addEventListener('click', closeModal);
  document.getElementById('cancelBtn').addEventListener('click', closeModal);
  document.getElementById('saveBtn').addEventListener('click', saveEdit);
  document.getElementById('resetBtn').addEventListener('click', resetEdit);
  document.getElementById('readToggle').addEventListener('click', () => {
    const track = document.getElementById('toggleTrack');
    setToggle(!track.classList.contains('on'));
  });
  document.getElementById('modal').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeModal();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeModal();
  });
}

// ---- EXPORT / IMPORT ----
async function exportLibrary() {
  const resp = await chrome.runtime.sendMessage({ type: 'GET_LIBRARY' });
  const payload = {
    version: 1,
    exportDate: new Date().toISOString(),
    books: resp.books || [],
    edits: resp.edits || {},
    goodreads: resp.goodreads || {},
    covers: resp.covers || {},
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'kindle-library-' + new Date().toISOString().slice(0, 10) + '.json';
  a.click();
  URL.revokeObjectURL(url);
}

async function importLibrary(file) {
  const text = await file.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    alert('Invalid file — could not parse JSON.');
    return;
  }
  if (!payload.books || !Array.isArray(payload.books)) {
    alert('Invalid export file — missing books array.');
    return;
  }

  // Merge imported data with existing (imported takes precedence for edits/goodreads/covers)
  await chrome.runtime.sendMessage({
    type: 'IMPORT_DATA',
    books: payload.books,
    edits: payload.edits || {},
    goodreads: payload.goodreads || {},
    covers: payload.covers || {},
  });

  await loadBooks();
  alert(`Import complete — ${payload.books.length} books loaded.`);
}

function initImportExport() {
  document.getElementById('exportBtn').addEventListener('click', exportLibrary);
  document.getElementById('importFile').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) importLibrary(file);
    e.target.value = ''; // allow re-importing same file
  });
}

// ---- START ----
async function init() {
  bindEvents();
  initSyncButton();
  initImportExport();
  await loadBooks();
}

init();
