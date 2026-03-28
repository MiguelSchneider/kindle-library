// background.js — Manifest V3 service worker for Kindle Library extension
// All state lives in chrome.storage.local; nothing is kept in memory.

const KINDLE_PATH = '/hz/mycd/digital-console/contentlist/pdocs/dateDsc/';
const KINDLE_CONSOLE_PATH = '/hz/mycd/digital-console/*';

const AMAZON_DOMAINS = {
  'amazon.com': 'Amazon.com (US)',
  'amazon.es': 'Amazon.es (Spain)',
  'amazon.co.uk': 'Amazon.co.uk (UK)',
  'amazon.de': 'Amazon.de (Germany)',
  'amazon.fr': 'Amazon.fr (France)',
  'amazon.it': 'Amazon.it (Italy)',
  'amazon.co.jp': 'Amazon.co.jp (Japan)',
  'amazon.ca': 'Amazon.ca (Canada)',
  'amazon.com.au': 'Amazon.com.au (Australia)',
  'amazon.com.br': 'Amazon.com.br (Brazil)',
  'amazon.in': 'Amazon.in (India)',
  'amazon.com.mx': 'Amazon.com.mx (Mexico)',
  'amazon.nl': 'Amazon.nl (Netherlands)',
};

async function getAmazonUrl() {
  const result = await chrome.storage.local.get('kindle-amazon-domain');
  const domain = result['kindle-amazon-domain'] || 'amazon.com';
  return `https://www.${domain}${KINDLE_PATH}`;
}

function getAmazonTabPatterns() {
  return Object.keys(AMAZON_DOMAINS).map(d => `*://*.${d}${KINDLE_CONSOLE_PATH}`);
}

async function findAmazonTab() {
  const patterns = getAmazonTabPatterns();
  for (const pattern of patterns) {
    const tabs = await chrome.tabs.query({ url: pattern });
    if (tabs.length > 0) return tabs[0];
  }
  return null;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message).then(sendResponse).catch((err) => {
    console.error('background message handler error:', err);
    sendResponse({ success: false, error: err.message });
  });
  return true; // keep channel open for async response
});

async function handleMessage(message) {
  switch (message.type) {
    case 'SYNC_COMPLETE':
      return handleSyncComplete(message);
    case 'GET_LIBRARY':
      return handleGetLibrary();
    case 'GET_STATS':
      return handleGetStats();
    case 'SAVE_EDITS':
      return handleSaveEdits(message);
    case 'SAVE_COVERS':
      return handleSaveCovers(message);
    case 'SAVE_GOODREADS':
      return handleSaveGoodreads(message);
    case 'IMPORT_DATA':
      return handleImportData(message);
    case 'OPEN_LIBRARY':
      return handleOpenLibrary();
    case 'OPEN_AMAZON':
      return handleOpenAmazon();
    case 'TRIGGER_SYNC':
      return handleTriggerSync();
    case 'SET_AMAZON_DOMAIN':
      return handleSetAmazonDomain(message);
    case 'GET_AMAZON_DOMAINS':
      return handleGetAmazonDomains();
    default:
      return { success: false, error: `Unknown message type: ${message.type}` };
  }
}

// ---------------------------------------------------------------------------
// SYNC_COMPLETE — content script finished scraping; merge into existing list
// ---------------------------------------------------------------------------
async function handleSyncComplete({ books: scrapedBooks, syncDate }) {
  const stored = await chrome.storage.local.get(['kindle-books', 'kindle-edits']);
  const existing = stored['kindle-books'] || [];
  const existingEdits = stored['kindle-edits'] || {};

  // Migrate edits: remap any old IDs to the new rawTitle-based IDs
  const rawTitleToNewId = new Map(scrapedBooks.map(b => [b.rawTitle, b.id]));
  const oldIdToRawTitle = new Map(existing.map(b => [String(b.id), b.rawTitle]));

  const migratedEdits = {};
  for (const [editId, editData] of Object.entries(existingEdits)) {
    const rawTitle = oldIdToRawTitle.get(String(editId));
    const newId = rawTitle ? rawTitleToNewId.get(rawTitle) : null;
    migratedEdits[String(newId ?? editId)] = editData;
  }

  // Merge by rawTitle — the only stable, browser-agnostic key.
  // Scraped version always wins (fresh from Amazon); books not in this
  // scrape (e.g. deleted from Kindle) are preserved from existing.
  const finalByRawTitle = new Map(existing.map(b => [b.rawTitle, b]));
  let added = 0;
  for (const b of scrapedBooks) {
    if (!finalByRawTitle.has(b.rawTitle)) added++;
    finalByRawTitle.set(b.rawTitle, b);
  }
  const finalBooks = [...finalByRawTitle.values()];

  await chrome.storage.local.set({
    'kindle-books': finalBooks,
    'kindle-edits': migratedEdits,
    'kindle-sync-date': syncDate,
  });

  chrome.runtime.sendMessage({ type: 'LIBRARY_UPDATED' }).catch(() => {});
  return { success: true, added, total: finalBooks.length };
}

// ---------------------------------------------------------------------------
// GET_LIBRARY — library page requests full dataset
// ---------------------------------------------------------------------------
async function handleGetLibrary() {
  const result = await chrome.storage.local.get([
    'kindle-books',
    'kindle-edits',
    'kindle-covers',
    'kindle-goodreads',
    'kindle-sync-date',
  ]);
  return {
    books: result['kindle-books'] || [],
    edits: result['kindle-edits'] || {},
    covers: result['kindle-covers'] || {},
    goodreads: result['kindle-goodreads'] || {},
    syncDate: result['kindle-sync-date'] || null,
  };
}

// ---------------------------------------------------------------------------
// GET_STATS — popup requests summary counts
// ---------------------------------------------------------------------------
async function handleGetStats() {
  const result = await chrome.storage.local.get([
    'kindle-books',
    'kindle-edits',
    'kindle-sync-date',
  ]);

  const books = result['kindle-books'] || [];
  const edits = result['kindle-edits'] || {};
  const total = books.length;

  let read = 0;
  for (const book of books) {
    // Edits override the scraped read status
    const edited = edits[book.id];
    const isRead = edited && typeof edited.read === 'boolean'
      ? edited.read
      : book.read;
    if (isRead) read++;
  }

  return {
    total,
    read,
    unread: total - read,
    syncDate: result['kindle-sync-date'] || null,
  };
}

// ---------------------------------------------------------------------------
// SAVE_EDITS — library page persists user edits
// ---------------------------------------------------------------------------
async function handleSaveEdits({ edits }) {
  await chrome.storage.local.set({ 'kindle-edits': edits });
  return { success: true };
}

// ---------------------------------------------------------------------------
// SAVE_COVERS — library page persists cover image URLs
// ---------------------------------------------------------------------------
async function handleSaveCovers({ covers }) {
  await chrome.storage.local.set({ 'kindle-covers': covers });
  return { success: true };
}

// ---------------------------------------------------------------------------
// SAVE_GOODREADS — library page persists Goodreads rating cache
// ---------------------------------------------------------------------------
async function handleSaveGoodreads({ goodreads }) {
  await chrome.storage.local.set({ 'kindle-goodreads': goodreads });
  return { success: true };
}

// ---------------------------------------------------------------------------
// IMPORT_DATA — merge an exported JSON snapshot into local storage
// ---------------------------------------------------------------------------
async function handleImportData({ books: importedBooks, edits: importedEdits, goodreads: importedGr, covers: importedCovers }) {
  const stored = await chrome.storage.local.get([
    'kindle-books', 'kindle-edits', 'kindle-covers', 'kindle-goodreads',
  ]);

  // Merge books: imported wins for existing IDs, new ones are added
  const existingBooks = stored['kindle-books'] || [];
  const existingById = new Map(existingBooks.map(b => [b.id, b]));
  for (const b of importedBooks) existingById.set(b.id, b);
  const mergedBooks = [...existingById.values()];

  // Merge edits: imported wins (user explicitly marked them in source browser)
  const mergedEdits = { ...(stored['kindle-edits'] || {}), ...importedEdits };

  // Merge caches: imported fills in gaps, existing entries kept
  const mergedGr = { ...importedGr, ...(stored['kindle-goodreads'] || {}) };
  const mergedCovers = { ...importedCovers, ...(stored['kindle-covers'] || {}) };

  await chrome.storage.local.set({
    'kindle-books': mergedBooks,
    'kindle-edits': mergedEdits,
    'kindle-goodreads': mergedGr,
    'kindle-covers': mergedCovers,
  });

  return { success: true, count: mergedBooks.length };
}

// ---------------------------------------------------------------------------
// OPEN_LIBRARY — open the extension's library page
// ---------------------------------------------------------------------------
async function handleOpenLibrary() {
  await chrome.tabs.create({ url: chrome.runtime.getURL('library.html') });
  return { success: true };
}

// ---------------------------------------------------------------------------
// OPEN_AMAZON — focus or create an Amazon Kindle tab
// ---------------------------------------------------------------------------
async function handleOpenAmazon() {
  const tab = await findAmazonTab();
  if (tab) {
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } else {
    const url = await getAmazonUrl();
    await chrome.tabs.create({ url });
  }
  return { success: true };
}

// ---------------------------------------------------------------------------
// TRIGGER_SYNC — always navigate to page 1 before syncing
// ---------------------------------------------------------------------------
async function handleTriggerSync() {
  const url = await getAmazonUrl(); // always page 1 (dateDsc, no pageNumber param)

  // Set flag so content script auto-starts sync when the page loads
  await chrome.storage.local.set({ 'kindle-auto-sync': true });

  const tab = await findAmazonTab();
  if (tab) {
    // Navigate existing tab to page 1 (in case it's mid-library or on a later page)
    await chrome.tabs.update(tab.id, { url, active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url });
  }
  return { success: true };
}

// ---------------------------------------------------------------------------
// SET_AMAZON_DOMAIN — user selects their Amazon region
// ---------------------------------------------------------------------------
async function handleSetAmazonDomain({ domain }) {
  await chrome.storage.local.set({ 'kindle-amazon-domain': domain });
  return { success: true };
}

// ---------------------------------------------------------------------------
// GET_AMAZON_DOMAINS — return list of domains and current selection
// ---------------------------------------------------------------------------
async function handleGetAmazonDomains() {
  const result = await chrome.storage.local.get('kindle-amazon-domain');
  return {
    domains: AMAZON_DOMAINS,
    current: result['kindle-amazon-domain'] || 'amazon.com',
  };
}
