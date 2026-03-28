# Kindle Library

A Chrome/Brave extension that turns your **Kindle Personal Documents** library into a beautiful, searchable bookshelf — with book covers, Goodreads ratings, read/unread tracking, and cross-browser sync.

![Kindle Library screenshot](https://via.placeholder.com/900x500/0f0f13/6c63ff?text=Kindle+Library)

---

## Features

- **Auto-sync** — scrapes your full Kindle Personal Documents library directly from Amazon's content management page, paginating through all pages automatically
- **Book covers** — fetched lazily from the Google Books API as you scroll (throttled to avoid rate limits; cached locally)
- **Goodreads ratings** — pulled from Goodreads' autocomplete API; shown as star ratings with review counts
- **Search** — instant full-text search across titles and authors
- **Filter** — show All / Read / Unread books
- **Sort** — by upload date (newest/oldest), Goodreads rating, title, or author
- **Edit metadata** — override title, author, or read/unread status per book; edits survive re-syncs
- **Export / Import** — snapshot your entire library as JSON to migrate between browsers (Chrome ↔ Brave, etc.)
- **Multi-region** — supports 13 Amazon stores (US, UK, ES, DE, FR, IT, JP, CA, AU, BR, IN, MX, NL)
- **Dark theme** — easy on the eyes

---

## Installation

> The extension is not yet published on the Chrome Web Store. Install it manually in developer mode.

1. **Download or clone** this repository
   ```bash
   git clone https://github.com/YOUR_USERNAME/kindle-library.git
   ```

2. Open **Chrome** (or Brave) and navigate to `chrome://extensions`

3. Enable **Developer mode** (toggle in the top-right corner)

4. Click **Load unpacked** and select the cloned folder

5. The Kindle Library icon will appear in your toolbar

---

## How to use

### First sync

1. Click the **Kindle Library** toolbar icon
2. Select your **Amazon region** from the dropdown (e.g. Amazon.es for Spain)
3. Click **Sync from Amazon** — this opens your Amazon Kindle content page
4. Log in to Amazon if prompted
5. A floating **"Sync to Kindle Library"** button appears on the page — click it (or it starts automatically)
6. The extension scrapes all pages of your library and shows a progress overlay
7. When done, click **Open Library** in the overlay (or via the popup)

### Subsequent syncs

Click **Sync** in the library header or popup at any time. New books are added; your edits and read/unread status are preserved.

### Editing a book

Click any book card to open the edit modal. You can:
- Correct the title or author (the parser does its best but filenames vary)
- Toggle read / unread status
- Click **Reset** to restore the original scraped values

### Export / Import (cross-browser)

Use **Export** to save a `.json` snapshot of your library (books, edits, covers, Goodreads cache).
Use **Import** on another browser to merge that snapshot in — no re-sync needed.

---

## How it works

### Architecture

```
manifest.json          Manifest V3 — permissions, content script config
background.js          Service worker — message routing, chrome.storage management
parser.js              Shared — title/author extraction from Kindle filenames
content.js             Injected on Amazon — scrapes books, paginates, shows overlay
content.css            Floating sync button + progress overlay styles
popup.html / popup.js  Extension popup — stats, region picker, quick actions
library.html           Full library page (opened as a tab)
library.js             Library UI — render, search, filter, sort, covers, Goodreads
library.css            Library styles — dark theme, card grid, modal
icons/                 Extension icons (16px, 48px, 128px)
```

### Data flow

```
Amazon page
  └─ content.js scrapes innerText of DigitalEntitySummary containers
       └─ parser.js extracts title/author from raw filenames
            └─ SYNC_COMPLETE → background.js merges into chrome.storage.local
                 └─ LIBRARY_UPDATED broadcast → library.js re-renders
```

### Storage schema (`chrome.storage.local`)

| Key | Contents |
|-----|----------|
| `kindle-books` | Array of scraped book objects |
| `kindle-edits` | Map of `{ [bookId]: { title?, author?, read? } }` overrides |
| `kindle-covers` | Map of `{ [title\|author]: imageUrl }` cover URL cache |
| `kindle-goodreads` | Map of `{ [title\|author]: { rating, ratingsCount, url } }` |
| `kindle-sync-date` | ISO timestamp of last successful sync |
| `kindle-amazon-domain` | Selected Amazon domain (e.g. `"amazon.es"`) |

### Book ID stability

Books are identified by a hash of their **raw Kindle filename** (`rawTitle`). This is stable across browsers, Amazon regions, and date-format differences — enabling safe cross-browser import/export and edit preservation across re-syncs.

### Title/author parsing

Kindle Personal Documents filenames come in several formats:

| Format | Example | Parsed |
|--------|---------|--------|
| Underscore-separated | `El_nombre_del_viento_Patrick_Rothfuss` | Title: *El nombre del viento* · Author: *Patrick Rothfuss* |
| Anna's Archive | `Dune -- Herbert, Frank -- 1965 -- ... -- Anna's Archive` | Title: *Dune* · Author: *Frank Herbert* |
| Clean title + Amazon author | `Sapiens` + Amazon metadata | Title: *Sapiens* · Author: from Amazon |
| Swapped (author as title) | `Rothfuss, Patrick` | Detected and flipped |
| Hash filename | `annas-arch-a1b2c3d4` | Shown as *Unknown Book* |

### Cover loading

Covers are fetched lazily via the **Google Books API** using an `IntersectionObserver` — only cards near the viewport trigger API calls. A 500 ms throttle between requests prevents rate-limiting. Successful URLs are cached permanently; failures are never cached (retried on next library open). On HTTP 429/403, the queue backs off 8 seconds before retrying.

### Goodreads ratings

Ratings are fetched via the Goodreads autocomplete JSON API (`/book/auto_complete?format=json&q=TITLE`). The result with the highest `ratingsCount` is chosen (avoids study guides / summaries). Fetches are queued with an 800 ms delay. Results are cached; entries with fewer than 100 ratings are discarded to filter noise.

---

## Permissions

| Permission | Why |
|------------|-----|
| `storage` | Persist library, edits, covers, Goodreads cache |
| `tabs` | Open Amazon tab, navigate to page 1 before syncing |
| `activeTab` | Read the current Amazon page |
| `*://*.amazon.*/hz/mycd/*` | Inject content script on Kindle management pages |
| `*://*.goodreads.com/*` | Fetch book ratings |
| `*://*.googleapis.com/*` | Fetch book covers from Google Books |
| `*://books.google.com/*` | Cover image CDN |

The extension does **not** collect, transmit, or share any personal data. Everything stays in your browser's local storage.

---

## Development

### Prerequisites

- Chrome or Brave (any recent version)
- No build step — plain HTML/CSS/JS, Manifest V3

### Loading for development

```bash
git clone https://github.com/YOUR_USERNAME/kindle-library.git
# Open chrome://extensions → Developer mode → Load unpacked → select the folder
```

### File editing

Edit any `.js`, `.css`, or `.html` file, then click the **↺ reload** button on the extension card in `chrome://extensions`. The library page and popup pick up changes immediately on next open.

### Running the parser test suite

Open `generate-icons.html` in a browser for icon generation utilities. Parser logic can be tested by opening the browser console on the library page and calling `window.KindleParser` methods directly.

---

## Known limitations

- Requires navigating to the Amazon Kindle content page to sync (cannot fetch in the background without user interaction, by design — avoids needing Amazon credentials)
- Google Books cover API has a daily quota (~1,000 requests/day without an API key); large libraries may not get all covers on the first open
- Goodreads autocomplete API may not find ratings for very obscure books
- Date parsing supports Spanish (`28 de marzo de 2026`) and English (`March 28, 2026`) Amazon page formats

---

## Contributing

Pull requests are welcome. Please open an issue first to discuss significant changes.

---

## License

MIT
