#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const BOOK_ORDER_START = 40;
const LANGUAGE = "manipuri_roman";
const PAGE_SIZE = 1000;
const CANONICAL_NEW_TESTAMENT = [
  ["MAT", "matthew"],
  ["MRK", "mark"],
  ["LUK", "luke"],
  ["JHN", "john"],
  ["ACT", "acts"],
  ["ROM", "romans"],
  ["1CO", "1-corinthians"],
  ["2CO", "2-corinthians"],
  ["GAL", "galatians"],
  ["EPH", "ephesians"],
  ["PHP", "philippians"],
  ["COL", "colossians"],
  ["1TH", "1-thessalonians"],
  ["2TH", "2-thessalonians"],
  ["1TI", "1-timothy"],
  ["2TI", "2-timothy"],
  ["TIT", "titus"],
  ["PHM", "philemon"],
  ["HEB", "hebrews"],
  ["JAS", "james"],
  ["1PE", "1-peter"],
  ["2PE", "2-peter"],
  ["1JN", "1-john"],
  ["2JN", "2-john"],
  ["3JN", "3-john"],
  ["JUD", "jude"],
  ["REV", "revelation"],
];

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");
const previewPath = path.join(scriptDirectory, "output", "manipuri-roman-nt-preview.json");
const envPath = path.join(projectRoot, "apps", "web", ".env");
const webRequire = createRequire(path.join(projectRoot, "apps", "web", "package.json"));

function parseArguments(args) {
  for (const argument of args) {
    if (argument === "--dry-run") continue;
    if (argument === "--confirm") {
      throw new Error(
        "Writes are disabled in this Supabase JS importer. It uses separate REST requests and cannot provide an atomic transaction; use a trusted server-side/Postgres transaction before enabling writes.",
      );
    }
    if (argument === "--help" || argument === "-h") {
      console.log("Usage: node scripts/upload-to-supabase.mjs [--dry-run]");
      console.log("This version is read-only and reports a preflight insert/update plan.");
      console.log("Writes are intentionally disabled until a trusted transactional import path is provided.");
      process.exit(0);
    }
    throw new Error(`Unknown option: ${argument}`);
  }
}

function parseEnvFile(text) {
  const values = new Map();
  for (const line of text.split(/\r?\n/u)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/u);
    if (!match || match[1].startsWith("#")) continue;
    let value = match[2];
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    values.set(match[1], value);
  }
  return values;
}

function isServiceRoleKey(key) {
  if (/^(?:sb_secret_|service_role_)/iu.test(key)) return true;
  const parts = key.split(".");
  if (parts.length !== 3) return false;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return payload.role === "service_role";
  } catch {
    return false;
  }
}

function loadCreateClient() {
  try {
    return webRequire("@supabase/supabase-js").createClient;
  } catch (error) {
    throw new Error(
      `Could not load @supabase/supabase-js from apps/web: ${error.message}. Install workspace dependencies first.`,
    );
  }
}

async function loadSupabaseClient() {
  const env = parseEnvFile(await readFile(envPath, "utf8"));
  const url = env.get("VITE_SUPABASE_URL");
  const key = env.get("VITE_SUPABASE_PUBLISHABLE_KEY");
  if (!url || !key) {
    throw new Error(
      `Set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY in ${path.relative(projectRoot, envPath)}.`,
    );
  }
  if (isServiceRoleKey(key)) {
    throw new Error("Refusing to use a service-role key. This script only accepts the publishable key.");
  }

  const createClient = loadCreateClient();
  return createClient(url, key, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });
}

function validatePreview(preview) {
  if (!preview || preview.testament !== "new" || !Array.isArray(preview.books)) {
    throw new Error("Preview must contain New Testament books.");
  }
  if (preview.validation?.passed !== true) {
    throw new Error("Preview validation did not pass; regenerate it with scripts/import-usfm.mjs.");
  }
  if (preview.books.length !== 27) {
    throw new Error(`Expected 27 New Testament books in the preview; found ${preview.books.length}.`);
  }

  const books = [];
  const bookOrders = new Set();
  const bookIds = new Set();
  const chapterTargets = [];
  const sourceRowsByChapter = new Map();
  const sourceRows = [];
  const chapterKeys = new Set();
  const verseKeys = new Set();
  let verseRanges = 0;

  if (!Array.isArray(preview.validation.books) || preview.validation.books.length !== 27) {
    throw new Error("Preview validation report must list all 27 New Testament books.");
  }

  preview.books.forEach((book, bookIndex) => {
    const [expectedUsfmId, expectedBookId] = CANONICAL_NEW_TESTAMENT[bookIndex];
    if (
      book.usfmId !== expectedUsfmId ||
      book.id !== expectedBookId ||
      preview.validation.books[bookIndex]?.id !== book.id ||
      preview.validation.books[bookIndex]?.name !== book.name ||
      !book.name ||
      !Array.isArray(book.chapters)
    ) {
      throw new Error(`Preview book at index ${bookIndex} is missing required data.`);
    }
    const bookOrder = BOOK_ORDER_START + bookIndex;
    if (bookOrders.has(bookOrder) || bookIds.has(book.id)) {
      throw new Error(`Duplicate book order or ID in preview: ${book.id}.`);
    }
    bookOrders.add(bookOrder);
    bookIds.add(book.id);
    if (preview.validation.books[bookIndex].chapters !== book.chapters.length) {
      throw new Error(`${book.name}: preview chapter count does not match its validation report.`);
    }
    books.push({
      name: book.name,
      testament: "new",
      book_order: bookOrder,
      chapter_count: book.chapters.length,
    });

    book.chapters.forEach((chapter, chapterIndex) => {
      if (
        chapter.chapter !== chapterIndex + 1 ||
        !Array.isArray(chapter.verses)
      ) {
        throw new Error(`${book.name}: invalid chapter data.`);
      }
      const chapterKey = `${bookOrder}:${chapter.chapter}`;
      if (chapterKeys.has(chapterKey)) {
        throw new Error(`${book.name}: duplicate chapter ${chapter.chapter} in preview.`);
      }
      chapterKeys.add(chapterKey);
      chapterTargets.push({ bookOrder, chapterNumber: chapter.chapter });

      chapter.verses.forEach((verse) => {
        if (
          !Number.isInteger(verse.verse) ||
          verse.verse < 1 ||
          typeof verse.text !== "string" ||
          !verse.text.trim()
        ) {
          throw new Error(`${book.name} ${chapter.chapter}: invalid or empty verse text.`);
        }
        const verseEnd = verse.verseEnd ?? verse.verse;
        if (!Number.isInteger(verseEnd) || verseEnd < verse.verse) {
          throw new Error(`${book.name} ${chapter.chapter}:${verse.verse}: invalid verse range.`);
        }
        if (verse.verseEnd !== undefined) verseRanges += 1;

        for (let verseNumber = verse.verse; verseNumber <= verseEnd; verseNumber += 1) {
          const verseKey = `${chapterKey}:${verseNumber}`;
          if (verseKeys.has(verseKey)) {
            throw new Error(`${book.name} ${chapter.chapter}: duplicate verse ${verseNumber} in preview.`);
          }
          verseKeys.add(verseKey);
          sourceRows.push({
            bookOrder,
            chapterNumber: chapter.chapter,
            verseNumber,
            text: verse.text,
            sourceRange:
              verseEnd === verse.verse ? null : { start: verse.verse, end: verseEnd },
          });
          const chapterRows = sourceRowsByChapter.get(chapterKey) ?? [];
          chapterRows.push(sourceRows.at(-1));
          sourceRowsByChapter.set(chapterKey, chapterRows);
        }
      });
    });
  });

  const sourceEntryCount = preview.books.reduce(
    (total, book) =>
      total + book.chapters.reduce((chapterTotal, chapter) => chapterTotal + chapter.verses.length, 0),
    0,
  );
  if (
    Number.isInteger(preview.validation.totals?.verseEntries) &&
    preview.validation.totals.verseEntries !== sourceEntryCount
  ) {
    throw new Error(
      `Preview reports ${preview.validation.totals.verseEntries} verse entries but contains ${sourceEntryCount}.`,
    );
  }
  if (Number.isInteger(preview.validation.totals?.verses) && preview.validation.totals.verses !== sourceRows.length) {
    throw new Error(
      `Preview reports ${preview.validation.totals.verses} verse numbers but expands to ${sourceRows.length}.`,
    );
  }

  return { books, chapterTargets, sourceRows, sourceRowsByChapter, sourceEntryCount, verseRanges };
}

function throwReadError(table, error) {
  const message = error?.message ?? "Unknown Supabase error";
  if (
    error?.code === "42501" ||
    /row.level security|permission denied|violates.*policy/iu.test(message)
  ) {
    throw new Error(
      `Reading ${table} was blocked by Supabase RLS. The preflight requires SELECT access to all existing rows in the four target tables; no writes were attempted.`,
    );
  }
  throw new Error(`Reading ${table} failed${error?.code ? ` (${error.code})` : ""}: ${message}`);
}

async function fetchAll(client, table, columns) {
  const rows = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await client
      .from(table)
      .select(columns)
      .order("id", { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) throwReadError(table, error);
    rows.push(...data);
    if (data.length < PAGE_SIZE) return rows;
  }
}

function assertUnique(rows, keyOf, description) {
  const index = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    if (index.has(key)) throw new Error(`Existing data contains duplicate ${description}: ${key}.`);
    index.set(key, row);
  }
  return index;
}

function indexExistingData({ books, chapters, verses, translations }) {
  const booksById = assertUnique(books, (row) => row.id, "book ID");
  const booksByOrder = assertUnique(books, (row) => row.book_order, "book_order");
  const chaptersById = assertUnique(chapters, (row) => row.id, "chapter ID");
  const chaptersByKey = assertUnique(
    chapters,
    (row) => `${row.book_id}:${row.chapter_number}`,
    "book/chapter key",
  );
  const versesById = assertUnique(verses, (row) => row.id, "verse ID");
  const versesByKey = assertUnique(
    verses,
    (row) => `${row.chapter_id}:${row.verse_number}`,
    "chapter/verse key",
  );
  const translationsByKey = assertUnique(
    translations,
    (row) => `${row.verse_id}:${row.language}`,
    "verse/language key",
  );

  for (const book of books) {
    if (
      !Number.isInteger(book.id) ||
      !Number.isInteger(book.book_order) ||
      typeof book.name !== "string" ||
      !book.name.trim() ||
      typeof book.testament !== "string" ||
      !book.testament.trim() ||
      !Number.isInteger(book.chapter_count) ||
      book.chapter_count < 1
    ) {
      throw new Error(`Existing book ${book.id ?? "(unknown ID)"} has invalid identity or metadata.`);
    }
  }
  for (const chapter of chapters) {
    if (!Number.isInteger(chapter.id) || !Number.isInteger(chapter.book_id)) {
      throw new Error(`Existing chapter ${chapter.id ?? "(unknown ID)"} has an invalid identity or book_id.`);
    }
    if (!booksById.has(chapter.book_id)) {
      throw new Error(`Existing chapter ${chapter.id} references missing book ${chapter.book_id}.`);
    }
    if (!Number.isInteger(chapter.chapter_number) || chapter.chapter_number < 1) {
      throw new Error(`Existing chapter ${chapter.id} has an invalid chapter_number.`);
    }
  }
  for (const verse of verses) {
    if (!Number.isInteger(verse.id) || !Number.isInteger(verse.chapter_id)) {
      throw new Error(`Existing verse ${verse.id ?? "(unknown ID)"} has an invalid identity or chapter_id.`);
    }
    if (!chaptersById.has(verse.chapter_id)) {
      throw new Error(`Existing verse ${verse.id} references missing chapter ${verse.chapter_id}.`);
    }
    if (!Number.isInteger(verse.verse_number) || verse.verse_number < 1) {
      throw new Error(`Existing verse ${verse.id} has an invalid verse_number.`);
    }
  }
  for (const translation of translations) {
    if (
      !Number.isInteger(translation.id) ||
      !Number.isInteger(translation.verse_id) ||
      typeof translation.text !== "string" ||
      (translation.audio_path !== null && typeof translation.audio_path !== "string")
    ) {
      throw new Error(`Existing translation ${translation.id ?? "(unknown ID)"} has invalid data.`);
    }
    if (!versesById.has(translation.verse_id)) {
      throw new Error(
        `Existing translation ${translation.id} references missing verse ${translation.verse_id}.`,
      );
    }
    if (!["manipuri_roman", "english"].includes(translation.language)) {
      throw new Error(
        `Existing translation ${translation.id} has unsupported language "${translation.language}".`,
      );
    }
  }

  return {
    booksById,
    booksByOrder,
    chaptersByKey,
    chaptersById,
    versesByKey,
    versesById,
    translationsByKey,
  };
}

function buildPlan(target, existingRows, indexes) {
  const expectedBookByOrder = new Map(target.books.map((book) => [book.book_order, book]));
  const expectedBookByName = new Map(target.books.map((book) => [book.name, book]));
  const bookIdByOrder = new Map();

  for (const [bookOrder, expected] of expectedBookByOrder) {
    const existing = indexes.booksByOrder.get(bookOrder);
    if (!existing) continue;
    if (existing.name !== expected.name || existing.testament !== expected.testament) {
      throw new Error(
        `Book-order conflict at ${bookOrder}: expected "${expected.name}" (${expected.testament}), ` +
          `found "${existing.name}" (${existing.testament}). Aborting to protect the existing book.`,
      );
    }
    bookIdByOrder.set(bookOrder, existing.id);
  }
  for (const existing of existingRows.books) {
    const expected = expectedBookByName.get(existing.name);
    if (expected && existing.book_order !== expected.book_order) {
      throw new Error(
        `Book identity conflict: "${existing.name}" is already at book_order ${existing.book_order}, ` +
          `not ${expected.book_order}.`,
      );
    }
  }

  const targetChaptersByBook = new Map();
  for (const chapter of target.chapterTargets) {
    const list = targetChaptersByBook.get(chapter.bookOrder) ?? new Set();
    list.add(chapter.chapterNumber);
    targetChaptersByBook.set(chapter.bookOrder, list);
  }
  for (const [bookOrder, bookId] of bookIdByOrder) {
    const expectedChapters = targetChaptersByBook.get(bookOrder);
    for (const existing of existingRows.chapters) {
      if (existing.book_id === bookId && !expectedChapters.has(existing.chapter_number)) {
        throw new Error(
          `Existing chapter ${existing.chapter_number} for book_order ${bookOrder} is outside the preview; refusing to alter this book.`,
        );
      }
    }
  }

  const plan = {
    books: { inserts: 0, updates: 0, unchanged: 0 },
    chapters: { inserts: 0, updates: 0, unchanged: 0 },
    verses: { inserts: 0, updates: 0, unchanged: 0 },
    verse_translations: { inserts: 0, updates: 0, unchanged: 0 },
  };

  for (const expected of target.books) {
    const existing = indexes.booksByOrder.get(expected.book_order);
    if (!existing) plan.books.inserts += 1;
    else if (existing.chapter_count !== expected.chapter_count) plan.books.updates += 1;
    else plan.books.unchanged += 1;
  }

  const plannedVerseRows = [];
  for (const chapterTarget of target.chapterTargets) {
    const bookId = bookIdByOrder.get(chapterTarget.bookOrder);
    const existingChapter = bookId
      ? indexes.chaptersByKey.get(`${bookId}:${chapterTarget.chapterNumber}`)
      : undefined;
    if (existingChapter) plan.chapters.unchanged += 1;
    else plan.chapters.inserts += 1;

    const key = `${chapterTarget.bookOrder}:${chapterTarget.chapterNumber}`;
    for (const verseTarget of target.sourceRowsByChapter.get(key) ?? []) {
      const existingVerse = existingChapter
        ? indexes.versesByKey.get(`${existingChapter.id}:${verseTarget.verseNumber}`)
        : undefined;
      if (existingVerse) plan.verses.unchanged += 1;
      else plan.verses.inserts += 1;
      plannedVerseRows.push({ verseTarget, existingChapter, existingVerse });
    }
  }

  for (const { verseTarget, existingVerse } of plannedVerseRows) {
    const existingTranslation = existingVerse
      ? indexes.translationsByKey.get(`${existingVerse.id}:manipuri_roman`)
      : undefined;
    if (!existingTranslation) plan.verse_translations.inserts += 1;
    else if (existingTranslation.text !== verseTarget.text) plan.verse_translations.updates += 1;
    else plan.verse_translations.unchanged += 1;
  }

  return plan;
}

function printPlan(plan, target) {
  console.log("Supabase import dry run (read-only; no writes)");
  console.log("Table                 Insert   Update   Unchanged   Total");
  for (const table of ["books", "chapters", "verses", "verse_translations"]) {
    const counts = plan[table];
    const total = counts.inserts + counts.updates + counts.unchanged;
    console.log(
      `${table.padEnd(22)} ${String(counts.inserts).padStart(6)}   ` +
        `${String(counts.updates).padStart(6)}   ${String(counts.unchanged).padStart(9)}   ${String(total).padStart(6)}`,
    );
  }
  console.log(`Books: ${target.books.length} | Chapters: ${target.chapterTargets.length}`);
  console.log(
    `Verse source entries: ${target.sourceEntryCount} | Verse ranges: ${target.verseRanges} | ` +
      `Expanded verse/translation rows: ${target.sourceRows.length}`,
  );
  console.log(
    "Range handling: for each USFM range, the full original text is copied unchanged to every covered verse number; no split is inferred.",
  );
  console.log(
    "Writes are disabled. Supabase JS REST requests are separate transactions; use a trusted server-side/Postgres transaction for atomic multi-table imports.",
  );
  console.log(
    "The configured schema has no public INSERT/UPDATE policies. RLS remains enabled; no service-role key is used.",
  );
}

async function main() {
  parseArguments(process.argv.slice(2));
  const preview = JSON.parse(await readFile(previewPath, "utf8"));
  const target = validatePreview(preview);

  const client = await loadSupabaseClient();
  const existingRows = {
    books: await fetchAll(client, "books", "id,name,testament,book_order,chapter_count"),
    chapters: await fetchAll(client, "chapters", "id,book_id,chapter_number"),
    verses: await fetchAll(client, "verses", "id,chapter_id,verse_number"),
    translations: await fetchAll(
      client,
      "verse_translations",
      "id,verse_id,language,text,audio_path",
    ),
  };
  const indexes = indexExistingData(existingRows);
  const plan = buildPlan(target, existingRows, indexes);
  printPlan(plan, target);
}

main().catch((error) => {
  console.error(`Supabase import preflight stopped: ${error.message}`);
  process.exitCode = 1;
});
