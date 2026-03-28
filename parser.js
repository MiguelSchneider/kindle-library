// Shared utility for parsing Kindle book title/author data.
// Used by both the content script (injected on Amazon pages) and the library page.
// Everything is defined on window.KindleParser.

(function () {
  'use strict';

  const SPANISH_MONTHS = {
    enero: '01', febrero: '02', marzo: '03', abril: '04',
    mayo: '05', junio: '06', julio: '07', agosto: '08',
    septiembre: '09', octubre: '10', noviembre: '11', diciembre: '12'
  };

  // Spanish articles, prepositions, and short connectors that belong to titles, not authors.
  const TITLE_STOP_WORDS = new Set([
    'de', 'del', 'los', 'el', 'la', 'las', 'en', 'con', 'por', 'y',
    'un', 'una', 'unos', 'unas', 'sobre', 'entre', 'al', 'se', 'lo',
    'su', 'sus', 'sin', 'que', 'si', 'no', 'mas', 'a'
  ]);

  // Roman numerals used in author names (e.g. "Warden III")
  const ROMAN_NUMERAL = /^(I{1,3}|IV|VI{0,3}|IX|X{1,3})$/;

  /**
   * Check if a word looks like a CamelCase compound (e.g. "GomezJurado").
   * Must have at least two uppercase letters and no hyphens already.
   */
  function isCamelCase(word) {
    if (word.includes('-')) return false;
    // Check for pattern like "GomezJurado" where two capitalized name parts
    // are joined. Both halves must be at least 3 chars.
    // Does NOT match names like "McCarthy" where the prefix is short.
    return /[a-z]{2,}[A-Z][a-z]{2,}/.test(word);
  }

  /**
   * Split a CamelCase word with a hyphen: "GomezJurado" -> "Gomez-Jurado"
   * Only splits when both halves are at least 3 chars (to avoid splitting
   * names like "McCarthy" which has "Mc" + "Carthy").
   */
  function splitCamelCase(word) {
    return word.replace(/([a-z]{2,})([A-Z][a-z]{2,})/g, '$1-$2');
  }

  /**
   * Check if a word is an initial or abbreviated name part.
   * Matches: "J", "G", "A", "J.D.", "J.K.", single uppercase letters.
   */
  function isInitial(word) {
    // Single uppercase letter
    if (/^[A-Z]$/.test(word)) return true;
    // Dotted initials like "J.D." or "J.D"
    if (/^([A-Z]\.)+[A-Z]?\.?$/.test(word)) return true;
    return false;
  }

  /**
   * Check if a word is a number (like "01", "451", "83", "622").
   */
  function isNumber(word) {
    return /^\d+$/.test(word);
  }

  /**
   * Check if a word starts with an uppercase letter (or is a hyphenated name like "Perez-Reverte").
   */
  function isCapitalized(word) {
    if (!word || word.length === 0) return false;
    return word[0] >= 'A' && word[0] <= 'Z';
  }

  /**
   * Check if a word contains a comma (like "Yo,") -- these belong to the title.
   */
  function hasComma(word) {
    return word.includes(',');
  }

  /**
   * Check if a word is a Roman numeral.
   */
  function isRomanNumeral(word) {
    return ROMAN_NUMERAL.test(word);
  }

  /**
   * Parse an underscore-separated raw title into { title, author }.
   *
   * Algorithm:
   * 1. Split by "_"
   * 2. Walk backwards collecting author words
   * 3. An "author word" is: capitalized, a single-letter initial, dotted initial, or Roman numeral
   * 4. Stop when: lowercase word (not initial), number, word with comma, or too many words collected
   * 5. CamelCase words get split with hyphen
   */
  function parseUnderscoreTitle(raw) {
    const parts = raw.split('_');

    if (parts.length === 1) {
      return { title: raw, author: 'Unknown' };
    }

    // Find the rightmost "boundary" word -- a word that is clearly NOT an author name:
    // lowercase multi-char word, number, or comma-containing word.
    let boundaryIdx = -1;
    for (let i = parts.length - 1; i >= 0; i--) {
      const w = parts[i];
      if (hasComma(w) || isNumber(w)) {
        boundaryIdx = i;
        break;
      }
      if (!isCapitalized(w) && !isInitial(w) && !isRomanNumeral(w) && w.length > 0) {
        boundaryIdx = i;
        break;
      }
    }

    let authorStart;

    if (boundaryIdx === -1) {
      // No boundary found: all words are capitalized/initials/roman.
      // Use a name-pattern approach: start from the last word (surname),
      // then include preceding initials/roman, then one first-name word,
      // then any more preceding initials, stopping at the 2nd full-name word.
      authorStart = collectAuthorNamePattern(parts, 0);
    } else if (boundaryIdx === parts.length - 1) {
      // Last word is the boundary (lowercase/number/comma).
      // The last word IS the single-name author (e.g. "Maquiavelo").
      authorStart = parts.length - 1;
    } else {
      // Boundary found before the end. Everything after it is candidate author.
      const candidateStart = boundaryIdx + 1;
      const candidateCount = parts.length - candidateStart;

      // Count full-name words in candidate
      let fullNames = 0;
      for (let j = candidateStart; j < parts.length; j++) {
        const w = parts[j];
        if (isCapitalized(w) && !isInitial(w) && !isRomanNumeral(w)) fullNames++;
      }

      const boundaryWord = parts[boundaryIdx];
      const isBoundaryStop = TITLE_STOP_WORDS.has(boundaryWord.toLowerCase());

      if (candidateCount <= 2) {
        // 1-2 words after boundary: always all author
        authorStart = candidateStart;
      } else if (candidateCount === 3 && !isBoundaryStop) {
        // Exactly 3 after a regular lowercase word: all 3 are author
        // e.g. "sangre Cesar Perez Gellida", "viento Carlos Ruiz Zafon"
        authorStart = candidateStart;
      } else if (isBoundaryStop) {
        // After a stop word (de, la, del, etc.), the first capitalized words
        // right after the stop word belong to the title.
        if (candidateCount === 3) {
          // Exactly 3 after stop word: first is title, last 2 are author
          authorStart = candidateStart + 1;
        } else {
          // 4+ after stop word: use collectAuthorFromEnd with max 2
          authorStart = collectAuthorFromEnd(parts, candidateStart, 2);
        }
      } else {
        // 4+ words after a regular lowercase boundary.
        // Use collectAuthorFromEnd with max 2 full-name words.
        authorStart = collectAuthorFromEnd(parts, candidateStart, 2);
      }
    }

    // Ensure at least 1 word for title
    if (authorStart < 1) authorStart = 1;
    if (authorStart >= parts.length) authorStart = parts.length - 1;

    // Build author with CamelCase splitting
    const authorWords = [];
    for (let i = authorStart; i < parts.length; i++) {
      const w = parts[i];
      if (isCamelCase(w)) {
        authorWords.push(splitCamelCase(w));
      } else {
        authorWords.push(w);
      }
    }

    const titleParts = parts.slice(0, authorStart);
    const title = titleParts.join(' ').replace(/ ,/g, ',');
    const author = authorWords.join(' ');

    return { title: title || raw, author: author || 'Unknown' };
  }

  /**
   * For the all-capitalized case (no lowercase boundary): collect author using
   * a name-pattern approach. Walk backwards collecting:
   * 1. Roman numerals at the end (e.g. "III")
   * 2. Surname (first full-name word from end)
   * 3. Initials between surname and first name (e.g. "G" in "Burton G Malkiel")
   * 4. First name (second full-name word from end)
   * 5. Any more preceding initials (e.g. "J D" before "Barker")
   * Stop after 2 full-name words. This prevents initials from bridging to title words.
   */
  function collectAuthorNamePattern(parts, minIdx) {
    let cursor = parts.length - 1;

    // Skip trailing Roman numerals
    while (cursor >= minIdx && isRomanNumeral(parts[cursor])) {
      cursor--;
    }

    // Must have at least one full-name word (surname)
    if (cursor < minIdx || !isCapitalized(parts[cursor])) {
      return parts.length - 1; // fallback: last word
    }
    let surnameIdx = cursor;
    cursor--;

    // Collect initials before surname
    let initialsBeforeSurname = 0;
    while (cursor >= minIdx && isInitial(parts[cursor])) {
      initialsBeforeSurname++;
      cursor--;
    }

    // Collect first name (one more full-name word), but only if there
    // were 0-1 initials between it and the surname. When there are 2+
    // initials, they likely ARE the first/middle name (e.g. "J D Barker")
    // and the word before them is a title word.
    if (initialsBeforeSurname <= 1 && cursor >= minIdx &&
        isCapitalized(parts[cursor]) && !hasComma(parts[cursor])) {
      cursor--;

      // Collect any more preceding initials
      while (cursor >= minIdx && isInitial(parts[cursor])) {
        cursor--;
      }
    }

    return cursor + 1;
  }

  /**
   * Walk backwards from end of parts array, collecting at most maxFullNames
   * full capitalized words (not counting initials or Roman numerals).
   * Returns the index where the author starts.
   *
   * Key behavior: initials/Roman numerals that appear between the (maxFullNames)th
   * full-name word and a (maxFullNames+1)th word are NOT included. This prevents
   * titles like "El Cuarto Mono J D Barker" from including "Mono" just because
   * initials J and D bridge it to "Barker".
   */
  function collectAuthorFromEnd(parts, minIdx, maxFullNames) {
    let fullCount = 0;
    let cursor = parts.length - 1;
    // Track the position after the last full-name word we accepted
    let lastFullNameIdx = parts.length;

    while (cursor >= minIdx) {
      const w = parts[cursor];
      if (isRomanNumeral(w) || isInitial(w)) {
        cursor--;
        continue;
      }
      if (isCapitalized(w) && !hasComma(w)) {
        fullCount++;
        if (fullCount > maxFullNames) {
          // We've gone too far. The author starts at lastFullNameIdx,
          // but we need to include any initials/roman that are between
          // lastFullNameIdx and the end, and that are AFTER this word.
          // Actually, we should start from the last accepted full name's position
          // and include initials that precede it (towards the start).
          break;
        }
        lastFullNameIdx = cursor;
        cursor--;
        continue;
      }
      break;
    }

    // Start from the earliest accepted full-name word, then walk backwards
    // to include any initials/roman that immediately precede it
    let authorStart = lastFullNameIdx;
    while (authorStart - 1 >= minIdx) {
      const prev = parts[authorStart - 1];
      if (isInitial(prev) || isRomanNumeral(prev)) {
        authorStart--;
      } else {
        break;
      }
    }

    return authorStart;
  }

  /**
   * Parse an Anna's Archive format title.
   * Format: "Title -- Author -- Year -- Publisher -- isbn -- hash -- Anna's Archive"
   * Author may be "Last, First" format.
   * Title may contain " _ " separators or "[eBook ...]" annotations.
   */
  function parseAnnasArchive(raw) {
    const segments = raw.split(' -- ');
    if (segments.length < 2) return null;

    // First segment is the title (may contain "[eBook ...]" or "_ " parts)
    let title = segments[0].trim();
    // Clean up "[eBook - ...]" annotations and "_ " separators
    title = title.replace(/\s*\[eBook[^\]]*\]\s*/g, ' ').trim();
    title = title.replace(/\s*_\s*/g, ' ').trim();
    // Collapse multiple spaces
    title = title.replace(/\s+/g, ' ').trim();

    // Second segment is the author
    let author = segments[1].trim();
    // Handle "Last, First" format
    if (/^[^,]+,\s+[^,]+$/.test(author)) {
      const commaIdx = author.indexOf(',');
      const last = author.substring(0, commaIdx).trim();
      const first = author.substring(commaIdx + 1).trim();
      author = first + ' ' + last;
    }

    return { title, author };
  }

  /**
   * Detect if rawTitle looks like an Anna's Archive filename hash.
   * Pattern: "annas-arch-HEXHASH"
   */
  function isAnnasArchHash(raw) {
    return /^annas-arch-[0-9a-f]+$/i.test(raw);
  }

  /**
   * Detect if rawTitle looks like an Anna's Archive format (contains " -- " and "Anna's Archive").
   */
  function isAnnasArchiveFormat(raw) {
    return raw.includes(' -- ') && raw.includes("Anna's Archive");
  }

  /**
   * Detect if rawTitle is a "clean" title (no underscores used for separation,
   * contains spaces, looks like a real book title).
   */
  function isCleanTitle(raw) {
    // Has spaces but no underscores used as separators
    return raw.includes(' ') && !raw.includes('_');
  }

  /**
   * Detect if rawTitle + amazonAuthor are swapped.
   * Heuristic: rawTitle looks like "Last, First" (an author name) and
   * amazonAuthor looks like a real title (no comma pattern).
   */
  function isSwapped(rawTitle, amazonAuthor) {
    if (!amazonAuthor) return false;
    // rawTitle matches "Last, First" pattern and amazonAuthor does not
    return /^[A-Z][a-z]+,\s+[A-Z]/.test(rawTitle) &&
           !/^[A-Z][a-z]+,\s+[A-Z]/.test(amazonAuthor);
  }

  /**
   * Main parsing function.
   *
   * @param {string} rawTitle - The raw title string from the Kindle library
   * @param {string} [amazonAuthor] - Author from Amazon metadata (may be owner name)
   * @param {string} [accountOwner] - The Kindle account owner name to filter out
   * @returns {{ title: string, author: string }}
   */
  function parseBook(rawTitle, amazonAuthor, accountOwner) {
    if (!rawTitle) return { title: 'Unknown', author: 'Unknown' };

    rawTitle = rawTitle.trim();

    // If amazonAuthor equals accountOwner, ignore it
    const effectiveAmazonAuthor =
      amazonAuthor && accountOwner && amazonAuthor.trim() === accountOwner.trim()
        ? null
        : amazonAuthor ? amazonAuthor.trim() : null;

    // Format 4: Anna's Archive hash filenames
    if (isAnnasArchHash(rawTitle)) {
      return { title: 'Unknown Book (' + rawTitle + ')', author: 'Unknown' };
    }

    // Format 4: Swapped title/author
    if (effectiveAmazonAuthor && isSwapped(rawTitle, effectiveAmazonAuthor)) {
      // rawTitle is actually "Last, First" author, amazonAuthor is the real title
      const commaIdx = rawTitle.indexOf(',');
      const last = rawTitle.substring(0, commaIdx).trim();
      const first = rawTitle.substring(commaIdx + 1).trim();
      return { title: effectiveAmazonAuthor, author: first + ' ' + last };
    }

    // Format 2: Anna's Archive format
    if (isAnnasArchiveFormat(rawTitle)) {
      const result = parseAnnasArchive(rawTitle);
      if (result) return result;
    }

    // Format 3: Clean title with amazonAuthor
    if (isCleanTitle(rawTitle) && effectiveAmazonAuthor) {
      let author = effectiveAmazonAuthor;
      // Handle "Last, First" amazon author format (e.g. "Garcia Marquez, Gabriel")
      if (/^[^,]+,\s+[^,]+$/.test(author)) {
        const commaIdx = author.indexOf(',');
        const last = author.substring(0, commaIdx).trim();
        const first = author.substring(commaIdx + 1).trim();
        author = first + ' ' + last;
      }
      return { title: rawTitle, author };
    }

    // Format 3: Clean title without amazonAuthor -- just use as-is
    if (isCleanTitle(rawTitle) && !rawTitle.includes('_')) {
      return { title: rawTitle, author: effectiveAmazonAuthor || 'Unknown' };
    }

    // Format 1: Underscore-separated
    if (rawTitle.includes('_')) {
      return parseUnderscoreTitle(rawTitle);
    }

    // Fallback: single word or unrecognized format
    return { title: rawTitle, author: effectiveAmazonAuthor || 'Unknown' };
  }

  /**
   * Convert a Spanish date string to ISO format.
   * "28 de marzo de 2026" -> "2026-03-28"
   * "1 de marzo de 2026" -> "2026-03-01"
   *
   * @param {string} spanishDateStr
   * @returns {string} ISO date string (YYYY-MM-DD) or empty string on failure
   */
  const ENGLISH_MONTHS = {
    january:'01', february:'02', march:'03', april:'04',
    may:'05', june:'06', july:'07', august:'08',
    september:'09', october:'10', november:'11', december:'12'
  };

  function dateToISO(dateStr) {
    if (!dateStr) return '';
    const s = dateStr.trim();

    // Spanish: "28 de marzo de 2026"
    const esMatch = s.match(/^(\d{1,2})\s+de\s+(\w+)\s+de\s+(\d{4})$/i);
    if (esMatch) {
      const month = SPANISH_MONTHS[esMatch[2].toLowerCase()];
      if (month) return esMatch[3] + '-' + month + '-' + esMatch[1].padStart(2, '0');
    }

    // English: "March 28, 2026" or "28 March 2026"
    const enMatch1 = s.match(/^(\w+)\s+(\d{1,2}),?\s+(\d{4})$/i);
    if (enMatch1) {
      const month = ENGLISH_MONTHS[enMatch1[1].toLowerCase()];
      if (month) return enMatch1[3] + '-' + month + '-' + enMatch1[2].padStart(2, '0');
    }
    const enMatch2 = s.match(/^(\d{1,2})\s+(\w+)\s+(\d{4})$/i);
    if (enMatch2) {
      const month = ENGLISH_MONTHS[enMatch2[2].toLowerCase()];
      if (month) return enMatch2[3] + '-' + month + '-' + enMatch2[1].padStart(2, '0');
    }

    return '';
  }

  /**
   * Generate a stable numeric hash for deduplication.
   * Uses only rawTitle (the Kindle filename) — stable across browsers,
   * Amazon regions, and date-format differences.
   *
   * @param {string} rawTitle
   * @returns {number} A positive integer hash
   */
  function generateId(rawTitle) {
    const str = rawTitle || '';
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + ch;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash);
  }

  // Export everything on window.KindleParser
  window.KindleParser = {
    parseBook: parseBook,
    dateToISO: dateToISO,
    generateId: generateId,
    // Expose internals for testing
    _parseUnderscoreTitle: parseUnderscoreTitle,
    _parseAnnasArchive: parseAnnasArchive,
    _isAnnasArchHash: isAnnasArchHash,
    _isAnnasArchiveFormat: isAnnasArchiveFormat,
    _isCamelCase: isCamelCase,
    _splitCamelCase: splitCamelCase
  };
})();
