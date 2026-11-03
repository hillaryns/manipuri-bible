#!/usr/bin/env node

import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BOOKS = [
  ["MAT", "matthew", "Matthew", 28],
  ["MRK", "mark", "Mark", 16],
  ["LUK", "luke", "Luke", 24],
  ["JHN", "john", "John", 21],
  ["ACT", "acts", "Acts", 28],
  ["ROM", "romans", "Romans", 16],
  ["1CO", "1-corinthians", "1 Corinthians", 16],
  ["2CO", "2-corinthians", "2 Corinthians", 13],
  ["GAL", "galatians", "Galatians", 6],
  ["EPH", "ephesians", "Ephesians", 6],
  ["PHP", "philippians", "Philippians", 4],
  ["COL", "colossians", "Colossians", 4],
  ["1TH", "1-thessalonians", "1 Thessalonians", 5],
  ["2TH", "2-thessalonians", "2 Thessalonians", 3],
  ["1TI", "1-timothy", "1 Timothy", 6],
  ["2TI", "2-timothy", "2 Timothy", 4],
  ["TIT", "titus", "Titus", 3],
  ["PHM", "philemon", "Philemon", 1],
  ["HEB", "hebrews", "Hebrews", 13],
  ["JAS", "james", "James", 5],
  ["1PE", "1-peter", "1 Peter", 5],
  ["2PE", "2-peter", "2 Peter", 3],
  ["1JN", "1-john", "1 John", 5],
  ["2JN", "2-john", "2 John", 1],
  ["3JN", "3-john", "3 John", 1],
  ["JUD", "jude", "Jude", 1],
  ["REV", "revelation", "Revelation", 22],
];

const NEW_TESTAMENT = BOOKS;
const BOOK_BY_USFM_ID = new Map(NEW_TESTAMENT.map((book, index) => [book[0], { book, index }]));
const VERSE_MARKER = /^(\d+)(?:-(\d+))?$/;
const MARKER_PATTERN = /\\([A-Za-z0-9+_-]+)(\*)?|\\\*/g;
const NOTE_MARKERS = new Set(["f", "x"]);
const QUOTE_ARTIFACT_PATTERN = /[\u0092\u0093\u0094]/u;
const UNEXPECTED_CONTROL_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u;
const HEADING_MARKERS = new Set([
  "d", "h", "im", "imt1", "ip", "iot", "io1", "io2", "ior", "ior*",
  "mt1", "mt2", "r", "s1", "toc1", "toc2", "toc3",
]);

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");
const defaultOutput = path.join(scriptDirectory, "output", "manipuri-roman-nt-preview.json");

function parseArguments(args) {
  let outputPath = defaultOutput;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--dry-run") continue;
    if (argument === "--output") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--output requires a file path");
      }
      outputPath = path.resolve(process.cwd(), value);
      index += 1;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      console.log("Usage: node scripts/import-usfm.mjs [--dry-run] [--output <file>]");
      console.log("Reads root-level NT USFM files and writes a JSON preview; no database writes are performed.");
      process.exit(0);
    }
    throw new Error(`Unknown option: ${argument}`);
  }

  return outputPath;
}

function cleanBookName(value) {
  return value
    .replace(/^\s+|\s+$/g, "")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s{2,}/g, " ");
}

function repairDuplicatedCp1252QuoteArtifacts(text) {
  return text
    .replace(/\u0093(?=[\u2018\u201C])/gu, "")
    .replace(/([\u2019\u201D])\u0092/gu, "$1")
    .replace(/(\u201D)\u0094/gu, "$1");
}

function parseUsfm(text, fileName, warnings) {
  const content = repairDuplicatedCp1252QuoteArtifacts(text.replace(/^\uFEFF/, ""));
  const idMatch = content.match(/^\\id\s+([^\s]+)(?:\s+([^\r\n]*))?/m);
  if (!idMatch) {
    warnings.push(`${fileName}: missing \\id marker`);
    return null;
  }

  const usfmId = idMatch[1].toUpperCase();
  const knownBook = BOOK_BY_USFM_ID.get(usfmId);
  if (!knownBook) {
    warnings.push(`${fileName}: unknown or non-New-Testament book ID "${usfmId}"`);
    return null;
  }

  const [, bookId, canonicalName, expectedChapters] = knownBook.book;
  const chapters = [];
  let currentChapter = null;
  let currentVerse = null;
  let pendingMarker = null;
  let noteStack = [];
  let headerName = "";
  let tocName = "";
  let lastVerseEnd = 0;

  function appendText(segment) {
    if (noteStack.length > 0) return;

    if (pendingMarker) {
      const marker = pendingMarker;
      pendingMarker = null;
      const value = segment.trimStart();

      if (marker === "c") {
        const match = value.match(/^(\d+)\b/);
        if (!match) {
          warnings.push(`${fileName}: chapter marker has no number`);
          currentChapter = null;
          currentVerse = null;
          return;
        }
        const chapterNumber = Number(match[1]);
        currentChapter = { chapter: chapterNumber, verses: [] };
        chapters.push(currentChapter);
        currentVerse = null;
        lastVerseEnd = 0;
        return;
      }

      if (marker === "v") {
        const match = value.match(/^(\d+(?:-\d+)?)(?:\s+|$)/);
        if (!match) {
          warnings.push(`${fileName}: verse marker has no valid number`);
          currentVerse = null;
          return;
        }
        if (!currentChapter) {
          warnings.push(`${fileName}: verse ${match[1]} appears before a chapter marker`);
          currentVerse = null;
          return;
        }

        const numberMatch = match[1].match(VERSE_MARKER);
        const verse = Number(numberMatch[1]);
        const verseEnd = numberMatch[2] ? Number(numberMatch[2]) : verse;
        if (verseEnd < verse) {
          warnings.push(`${fileName}: verse range ${match[1]} ends before it starts`);
        }
        if (verse <= lastVerseEnd) {
          warnings.push(
            `${fileName}: verse ${match[1]} is out of order or overlaps a previous verse in chapter ${currentChapter.chapter}`,
          );
        }
        lastVerseEnd = Math.max(lastVerseEnd, verseEnd);
        currentVerse = {
          chapter: currentChapter.chapter,
          verse,
          ...(verseEnd === verse ? {} : { verseEnd }),
          text: value.slice(match[0].length),
        };
        currentChapter.verses.push(currentVerse);
        return;
      }

      if (marker === "toc2") tocName = cleanBookName(segment);
      if (marker === "h") headerName = cleanBookName(segment);
      return;
    }

    if (currentVerse) currentVerse.text += segment;
  }

  let cursor = 0;
  for (const match of content.matchAll(MARKER_PATTERN)) {
    appendText(content.slice(cursor, match.index));
    cursor = match.index + match[0].length;

    const markerName = match[1] ?? "";
    const isClosing = Boolean(match[2]) || markerName === "";

    if (noteStack.length > 0) {
      const blockMarkerName = markerName.replace(/^\+/, "");
      if (NOTE_MARKERS.has(blockMarkerName) && !isClosing) noteStack.push(blockMarkerName);
      else if (isClosing && noteStack.at(-1) === blockMarkerName) noteStack.pop();
      continue;
    }

    const blockMarkerName = markerName.replace(/^\+/, "");
    if (NOTE_MARKERS.has(blockMarkerName) && !isClosing) {
      noteStack.push(blockMarkerName);
      continue;
    }

    if (isClosing) continue;

    if (markerName === "c" || markerName === "v" || markerName === "h" || markerName === "toc2") {
      pendingMarker = markerName;
      continue;
    }

    if (HEADING_MARKERS.has(markerName)) {
      currentVerse = null;
    }
  }
  appendText(content.slice(cursor));

  if (noteStack.length > 0) warnings.push(`${fileName}: unterminated footnote or cross-reference block`);
  if (pendingMarker === "c" || pendingMarker === "v") {
    warnings.push(`${fileName}: trailing \\${pendingMarker} marker has no value`);
  }
  for (const chapter of chapters) {
    for (const verse of chapter.verses) verse.text = verse.text.trim();
  }

  return {
    id: bookId,
    usfmId,
    name: tocName || headerName || canonicalName,
    expectedChapters,
    chapters,
  };
}

function validateBooks(books, warnings, errors) {
  if (books.length !== NEW_TESTAMENT.length) {
    errors.push(`Expected ${NEW_TESTAMENT.length} canonical New Testament books; found ${books.length}.`);
  }

  const seenBooks = new Set();
  const verseKeys = new Set();
  let totalChapters = 0;
  let totalVerseEntries = 0;
  let totalVerseNumbers = 0;
  let totalVerseRanges = 0;
  let duplicateVerseCount = 0;
  let emptyVerseCount = 0;
  let quoteArtifactCount = 0;
  let unexpectedControlCount = 0;
  const report = [];

  for (const book of books) {
    if (seenBooks.has(book.usfmId)) {
      errors.push(`${book.usfmId}: duplicate book ID.`);
    }
    seenBooks.add(book.usfmId);

    if (book.chapters.length !== book.expectedChapters) {
      errors.push(
        `${book.name}: expected ${book.expectedChapters} chapters; found ${book.chapters.length}.`,
      );
    }

    let bookVerseNumbers = 0;
    const chapterCounts = [];
    for (let index = 0; index < book.chapters.length; index += 1) {
      const chapter = book.chapters[index];
      if (chapter.chapter !== index + 1) {
        errors.push(`${book.name}: expected chapter ${index + 1}; found chapter ${chapter.chapter}.`);
      }
      if (chapter.verses.length === 0) {
        errors.push(`${book.name} ${chapter.chapter}: no verses found.`);
      }

      let chapterVerseNumbers = 0;
      for (const verse of chapter.verses) {
        totalVerseEntries += 1;
        const lastNumber = verse.verseEnd ?? verse.verse;
        chapterVerseNumbers += lastNumber - verse.verse + 1;
        if (verse.verseEnd) totalVerseRanges += 1;

        if (!verse.text.trim()) {
          emptyVerseCount += 1;
          warnings.push(`${book.name} ${chapter.chapter}:${verse.verse}: empty verse text.`);
        }
        if (QUOTE_ARTIFACT_PATTERN.test(verse.text)) {
          quoteArtifactCount += 1;
          errors.push(
            `${book.name} ${chapter.chapter}:${verse.verse}: unexpected duplicated quote artifact remains.`,
          );
        }
        const controlMatch = verse.text.match(UNEXPECTED_CONTROL_PATTERN);
        if (controlMatch) {
          unexpectedControlCount += 1;
          errors.push(
            `${book.name} ${chapter.chapter}:${verse.verse}: unexpected control character U+${controlMatch[0]
              .codePointAt(0)
              .toString(16)
              .toUpperCase()
              .padStart(4, "0")}.`,
          );
        }

        for (let number = verse.verse; number <= lastNumber; number += 1) {
          const key = `${book.id}:${chapter.chapter}:${number}`;
          if (verseKeys.has(key)) {
            duplicateVerseCount += 1;
            errors.push(`${book.name} ${chapter.chapter}:${number}: duplicate verse number.`);
          }
          verseKeys.add(key);
        }
      }

      if (chapterVerseNumbers === 0) {
        errors.push(`${book.name} ${chapter.chapter}: verse count is zero.`);
      }
      bookVerseNumbers += chapterVerseNumbers;
      chapterCounts.push(chapterVerseNumbers);
    }

    totalChapters += book.chapters.length;
    totalVerseNumbers += bookVerseNumbers;
    report.push({
      id: book.id,
      name: book.name,
      chapters: book.chapters.length,
      verses: bookVerseNumbers,
      versesPerChapter: chapterCounts,
    });
  }

  for (const [usfmId, bookId] of BOOK_BY_USFM_ID) {
    if (!seenBooks.has(usfmId)) errors.push(`${bookId.book[2]}: missing canonical book ID ${usfmId}.`);
  }

  return {
    books: report,
    totals: {
      books: books.length,
      chapters: totalChapters,
      verseEntries: totalVerseEntries,
      verses: totalVerseNumbers,
      verseRanges: totalVerseRanges,
      duplicateVerses: duplicateVerseCount,
      emptyVerses: emptyVerseCount,
      quoteArtifacts: quoteArtifactCount,
      unexpectedControlCharacters: unexpectedControlCount,
    },
  };
}

async function main() {
  const outputPath = parseArguments(process.argv.slice(2));
  const warnings = [];
  const errors = [];
  const files = (await readdir(projectRoot, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /\.usfm$/i.test(entry.name))
    .map((entry) => entry.name);

  if (files.length !== NEW_TESTAMENT.length) {
    errors.push(`Expected ${NEW_TESTAMENT.length} root-level .usfm files; found ${files.length}.`);
  }

  const parsed = [];
  for (const fileName of files) {
    const text = await readFile(path.join(projectRoot, fileName), "utf8");
    const book = parseUsfm(text, fileName, warnings);
    if (book) parsed.push(book);
  }

  const bookOrder = new Map(NEW_TESTAMENT.map(([usfmId], index) => [usfmId, index]));
  parsed.sort((left, right) => bookOrder.get(left.usfmId) - bookOrder.get(right.usfmId));
  const validation = validateBooks(parsed, warnings, errors);
  const preview = {
    source: {
      title: "ANOUBA WAREPNABA",
      copyright: "© 2022 The Word for the World International",
      license: {
        name: "CC BY 4.0",
        url: "https://creativecommons.org/licenses/by/4.0/",
      },
      attribution:
        "ANOUBA WAREPNABA, © 2022 The Word for the World International, licensed under CC BY 4.0.",
    },
    language: "Manipuri (Roman script)",
    testament: "new",
    generatedAt: new Date().toISOString(),
    validation: {
      passed: errors.length === 0,
      ...validation,
    },
    books: parsed.map(({ expectedChapters: _expectedChapters, ...book }) => book),
  };

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(preview, null, 2)}\n`, "utf8");

  console.log(`USFM dry run ${errors.length === 0 ? "completed" : "completed with validation errors"}`);
  console.log(`Input files: ${files.length} | Books parsed: ${validation.totals.books}/${NEW_TESTAMENT.length}`);
  console.log(
    `Chapters: ${validation.totals.chapters} | Verses: ${validation.totals.verses} ` +
      `(${validation.totals.verseEntries} entries; ${validation.totals.verseRanges} ranges) | ` +
      `Duplicates: ${validation.totals.duplicateVerses} | Empty verses: ${validation.totals.emptyVerses} | ` +
      `Quote artifacts: ${validation.totals.quoteArtifacts} | ` +
      `Unexpected controls: ${validation.totals.unexpectedControlCharacters}`,
  );
  console.log(`Preview: ${path.relative(projectRoot, outputPath)}`);

  for (const book of validation.books) {
    console.log(
      `  ${book.name}: ${book.chapters} chapter${book.chapters === 1 ? "" : "s"}, ${book.verses} verses`,
    );
  }
  for (const warning of warnings) console.warn(`Warning: ${warning}`);
  for (const error of errors) console.error(`Error: ${error}`);
  console.log("No Supabase connection or database writes were made.");

  if (errors.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`Import preview failed: ${error.message}`);
  process.exitCode = 1;
});