#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "pg";

const BOOK_ORDER_START = 40;
const LANGUAGE = "manipuri_roman";
const BATCH_SIZE = 300;
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
const TABLE_NAMES = ["books", "chapters", "verses", "verse_translations"];

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");
const previewPath = path.join(scriptDirectory, "output", "manipuri-roman-nt-preview.json");
const envPath = path.join(projectRoot, ".env.local");
let activeConnectionString = "";

function parseArguments(args) {
  let confirm = false;
  let dryRun = false;
  for (const argument of args) {
    if (argument === "--dry-run") dryRun = true;
    if (argument === "--confirm") confirm = true;
    else if (argument === "--help" || argument === "-h") {
      console.log("Usage: node scripts/import-to-postgres.mjs [--dry-run | --confirm]");
      console.log("Default: perform the full import transaction and ROLLBACK.");
      console.log("--confirm: perform the import transaction and COMMIT.");
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }
  if (confirm && dryRun) throw new Error("Choose either --dry-run or --confirm, not both.");
  return { confirm };
}

function parseEnvFile(text) {
  for (const line of text.split(/\r?\n/u)) {
    const match = line.match(/^\s*SUPABASE_DB_URL\s*=\s*(.*?)\s*$/u);
    if (!match) continue;
    const value = match[1];
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      return value.slice(1, -1);
    }
    return value;
  }
  throw new Error("SUPABASE_DB_URL is missing from the project-root .env.local file.");
}

function safeErrorMessage(error, connectionString) {
  const message = error instanceof Error ? error.message : String(error);
  return connectionString ? message.split(connectionString).join("[redacted connection string]") : message;
}

function assertInteger(value, description, minimum = 1) {
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`${description} must be an integer of at least ${minimum}.`);
  }
}

export function expandPreview(preview) {
  if (!preview || preview.testament !== "new" || !Array.isArray(preview.books)) {
    throw new Error("Preview must contain New Testament books.");
  }
  if (preview.validation?.passed !== true) {
    throw new Error("Preview validation did not pass; regenerate it with scripts/import-usfm.mjs.");
  }
  if (preview.books.length !== CANONICAL_NEW_TESTAMENT.length) {
    throw new Error(`Expected 27 New Testament books; found ${preview.books.length}.`);
  }
  if (!Array.isArray(preview.validation.books) || preview.validation.books.length !== 27) {
    throw new Error("Preview validation report must list all 27 New Testament books.");
  }

  const books = [];
  const chapters = [];
  const verses = [];
  const chapterTargets = [];
  const verseKeys = new Set();
  const chapterKeys = new Set();
  const sourceEntryCount = preview.books.reduce(
    (sum, book) =>
      sum +
      (Array.isArray(book.chapters)
        ? book.chapters.reduce(
            (chapterSum, chapter) =>
              chapterSum + (Array.isArray(chapter.verses) ? chapter.verses.length : 0),
            0,
          )
        : 0),
    0,
  );
  let verseRanges = 0;

  preview.books.forEach((book, bookIndex) => {
    const [expectedUsfmId, expectedBookId] = CANONICAL_NEW_TESTAMENT[bookIndex];
    if (
      book.usfmId !== expectedUsfmId ||
      book.id !== expectedBookId ||
      !book.name ||
      preview.validation.books[bookIndex]?.id !== book.id ||
      preview.validation.books[bookIndex]?.name !== book.name ||
      preview.validation.books[bookIndex]?.chapters !== book.chapters?.length
    ) {
      throw new Error(`Preview book at index ${bookIndex} does not match canonical New Testament order.`);
    }
    const bookOrder = BOOK_ORDER_START + bookIndex;
    books.push({
      name: book.name,
      testament: "new",
      book_order: bookOrder,
      chapter_count: book.chapters.length,
    });

    book.chapters.forEach((chapter, chapterIndex) => {
      if (chapter.chapter !== chapterIndex + 1 || !Array.isArray(chapter.verses)) {
        throw new Error(`${book.name}: chapter sequence is invalid.`);
      }
      const chapterKey = `${bookOrder}:${chapter.chapter}`;
      if (chapterKeys.has(chapterKey)) throw new Error(`${book.name}: duplicate chapter ${chapter.chapter}.`);
      chapterKeys.add(chapterKey);
      const chapterTarget = { bookOrder, chapterNumber: chapter.chapter };
      chapterTargets.push(chapterTarget);
      chapters.push(chapterTarget);

      for (const verse of chapter.verses) {
        assertInteger(verse.verse, `${book.name} ${chapter.chapter} verse`);
        if (typeof verse.text !== "string" || !verse.text.trim()) {
          throw new Error(`${book.name} ${chapter.chapter}:${verse.verse} has empty text.`);
        }
        const verseEnd = verse.verseEnd ?? verse.verse;
        assertInteger(verseEnd, `${book.name} ${chapter.chapter} verse range end`);
        if (verseEnd < verse.verse) {
          throw new Error(`${book.name} ${chapter.chapter}:${verse.verse} has an invalid verse range.`);
        }
        if (verse.verseEnd !== undefined) verseRanges += 1;

        for (let verseNumber = verse.verse; verseNumber <= verseEnd; verseNumber += 1) {
          const key = `${bookOrder}:${chapter.chapter}:${verseNumber}`;
          if (verseKeys.has(key)) {
            throw new Error(`${book.name} ${chapter.chapter}: duplicate verse ${verseNumber}.`);
          }
          verseKeys.add(key);
          verses.push({
            bookOrder,
            chapterNumber: chapter.chapter,
            verseNumber,
            text: verse.text,
            sourceRange: verseEnd === verse.verse ? null : { start: verse.verse, end: verseEnd },
          });
        }
      }
    });
  });

  if (preview.validation.totals?.books !== books.length) {
    throw new Error("Preview book total does not match the book list.");
  }
  if (preview.validation.totals?.chapters !== chapters.length) {
    throw new Error("Preview chapter total does not match the chapter list.");
  }
  if (preview.validation.totals?.verseEntries !== sourceEntryCount) {
    throw new Error("Preview verse-entry total does not match its verse entries.");
  }
  if (preview.validation.totals?.verseRanges !== verseRanges) {
    throw new Error("Preview verse-range total does not match its verse entries.");
  }
  if (preview.validation.totals?.verses !== verses.length) {
    throw new Error("Preview verse total does not match the expanded verse list.");
  }

  return { books, chapters, chapterTargets, verses, sourceEntryCount, verseRanges };
}

function keyFor(row, columns) {
  return columns.map((column) => String(row[column])).join(":");
}

function uniqueIndex(rows, columns, label) {
  const index = new Map();
  for (const row of rows) {
    const key = keyFor(row, columns);
    if (index.has(key)) throw new Error(`Existing data violates unique ${label}: ${key}.`);
    index.set(key, row);
  }
  return index;
}

const REQUIRED_UNIQUE_CONSTRAINTS = [
  { table: "books", columns: ["book_order"] },
  { table: "chapters", columns: ["book_id", "chapter_number"] },
  { table: "verses", columns: ["chapter_id", "verse_number"] },
  { table: "verse_translations", columns: ["verse_id", "language"] },
];

const REQUIRED_FOREIGN_KEYS = [
  { table: "chapters", columns: ["book_id"], referencedTable: "books", referencedColumns: ["id"] },
  { table: "verses", columns: ["chapter_id"], referencedTable: "chapters", referencedColumns: ["id"] },
  {
    table: "verse_translations",
    columns: ["verse_id"],
    referencedTable: "verses",
    referencedColumns: ["id"],
  },
];

function orderedColumns(value) {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      return [];
    }
  }
  return [];
}

function sameOrderedColumns(actual, expected) {
  const columns = orderedColumns(actual);
  return columns.length === expected.length && columns.every((column, index) => column === expected[index]);
}

function constraintDescription(constraint) {
  const columns = orderedColumns(constraint.columns);
  if (constraint.constraint_type === "f") {
    const referencedColumns = orderedColumns(constraint.referenced_columns);
    return `FOREIGN KEY (${columns.join(", ")}) -> ${constraint.referenced_table} (${referencedColumns.join(", ")})`;
  }
  if (constraint.constraint_type === "u") return `UNIQUE (${columns.join(", ")})`;
  if (constraint.constraint_type === "p") return `PRIMARY KEY (${columns.join(", ")})`;
  if (constraint.constraint_type === "c") return constraint.definition;
  return `constraint (${columns.join(", ")})`;
}

export function buildConstraintReport(constraints) {
  const detected = new Map(TABLE_NAMES.map((table) => [table, []]));
  for (const constraint of constraints) {
    if (!detected.has(constraint.table_name)) continue;
    detected.get(constraint.table_name).push({
      name: constraint.constraint_name,
      description: constraintDescription(constraint),
    });
  }

  const required = [
    ...REQUIRED_UNIQUE_CONSTRAINTS.map((item) => ({
      kind: "unique",
      ...item,
      matches: (constraint) =>
        ["u", "p"].includes(constraint.constraint_type) &&
        sameOrderedColumns(constraint.columns, item.columns),
      description: `UNIQUE (${item.columns.join(", ")})`,
    })),
    ...REQUIRED_FOREIGN_KEYS.map((item) => ({
      kind: "foreign key",
      ...item,
      matches: (constraint) =>
        constraint.constraint_type === "f" &&
        constraint.referenced_table === item.referencedTable &&
        sameOrderedColumns(constraint.columns, item.columns) &&
        sameOrderedColumns(constraint.referenced_columns, item.referencedColumns),
      description:
        `FOREIGN KEY (${item.columns.join(", ")}) -> ` +
        `${item.referencedTable} (${item.referencedColumns.join(", ")})`,
    })),
  ];

  const statuses = required.map((item) => {
    const constraint = constraints.find(
      (candidate) => candidate.table_name === item.table && item.matches(candidate),
    );
    return { ...item, constraint };
  });

  return {
    detected,
    statuses,
    missing: statuses.filter((status) => !status.constraint),
  };
}

export function formatConstraintReport(constraints) {
  const { detected, statuses, missing } = buildConstraintReport(constraints);
  const lines = ["Constraint metadata diagnostic:"];
  for (const table of TABLE_NAMES) {
    lines.push(`  public.${table}:`);
    const tableConstraints = detected.get(table);
    if (tableConstraints.length === 0) lines.push("    Detected: (none)");
    else {
      for (const constraint of tableConstraints) {
        lines.push(`    Detected: ${constraint.name} — ${constraint.description}`);
      }
    }
    for (const status of statuses.filter((item) => item.table === table)) {
      lines.push(
        status.constraint
          ? `    Required ${status.kind}: ${status.constraint.constraint_name} — ${status.description}`
          : `    Missing required ${status.kind}: ${status.description}`,
      );
    }
    if (table === "books") lines.push("    Required foreign keys: (none)");
  }
  return { lines, missing };
}

function validateExistingRows(existing) {
  const booksById = uniqueIndex(existing.books, ["id"], "books.id");
  const booksByOrder = uniqueIndex(existing.books, ["book_order"], "books.book_order");
  const chaptersById = uniqueIndex(existing.chapters, ["id"], "chapters.id");
  const chaptersByKey = uniqueIndex(existing.chapters, ["book_id", "chapter_number"], "chapters");
  const versesById = uniqueIndex(existing.verses, ["id"], "verses.id");
  const versesByKey = uniqueIndex(existing.verses, ["chapter_id", "verse_number"], "verses");
  const translationsById = uniqueIndex(existing.translations, ["id"], "verse_translations.id");
  const translationsByKey = uniqueIndex(
    existing.translations,
    ["verse_id", "language"],
    "verse_translations",
  );

  for (const row of existing.books) {
    if (
      !/^-?\d+$/u.test(String(row.id)) ||
      !Number.isInteger(row.book_order) ||
      !Number.isInteger(row.chapter_count) ||
      row.chapter_count < 1 ||
      typeof row.name !== "string" ||
      typeof row.testament !== "string"
    ) {
      throw new Error(`Existing book row ${row.id} has invalid identity or metadata.`);
    }
  }
  for (const row of existing.chapters) {
    if (!/^-?\d+$/u.test(String(row.id)) || !booksById.has(String(row.book_id))) {
      throw new Error(`Existing chapter ${row.id} has a missing or invalid book foreign key.`);
    }
    assertInteger(row.chapter_number, `Existing chapter ${row.id} chapter_number`);
  }
  for (const row of existing.verses) {
    if (!/^-?\d+$/u.test(String(row.id)) || !chaptersById.has(String(row.chapter_id))) {
      throw new Error(`Existing verse ${row.id} has a missing or invalid chapter foreign key.`);
    }
    assertInteger(row.verse_number, `Existing verse ${row.id} verse_number`);
  }
  for (const row of existing.translations) {
    if (
      !/^-?\d+$/u.test(String(row.id)) ||
      !versesById.has(String(row.verse_id)) ||
      !["manipuri_roman", "english"].includes(row.language) ||
      typeof row.text !== "string" ||
      (row.audio_path !== null && typeof row.audio_path !== "string")
    ) {
      throw new Error(`Existing translation row ${row.id} has invalid data or a missing verse foreign key.`);
    }
  }

  return { booksById, booksByOrder, chaptersById, chaptersByKey, versesById, versesByKey, translationsById, translationsByKey };
}

function buildPlan(target, existing, indexes) {
  const expectedBooksByName = new Map(target.books.map((book) => [book.name, book]));
  const booksByOrder = new Map();
  const bookIdByOrder = new Map();

  for (const book of target.books) {
    const existingBook = indexes.booksByOrder.get(String(book.book_order));
    if (existingBook) {
      if (existingBook.name !== book.name || existingBook.testament !== book.testament) {
        throw new Error(
          `Book-order conflict at ${book.book_order}: expected "${book.name}" (${book.testament}), ` +
            `found "${existingBook.name}" (${existingBook.testament}). Aborting without changing existing data.`,
        );
      }
      booksByOrder.set(book.book_order, existingBook);
      bookIdByOrder.set(book.book_order, String(existingBook.id));
    }
  }
  for (const book of existing.books) {
    const expected = expectedBooksByName.get(book.name);
    if (expected && book.book_order !== expected.book_order) {
      throw new Error(
        `Book identity conflict: "${book.name}" is at book_order ${book.book_order}, expected ${expected.book_order}.`,
      );
    }
  }

  const plan = {
    books: { inserts: [], updates: [], unchanged: [] },
    chapters: { inserts: [], updates: [], unchanged: [] },
    verses: { inserts: [], updates: [], unchanged: [] },
    translations: { inserts: [], updates: [], unchanged: [] },
    bookIdByOrder,
    chapterIdByKey: new Map(),
    verseIdByKey: new Map(),
  };

  for (const book of target.books) {
    const current = booksByOrder.get(book.book_order);
    if (!current) plan.books.inserts.push(book);
    else if (current.chapter_count !== book.chapter_count) {
      plan.books.updates.push({ id: String(current.id), chapter_count: book.chapter_count });
    } else plan.books.unchanged.push(book);
  }

  for (const chapter of target.chapters) {
    const bookId = bookIdByOrder.get(chapter.bookOrder);
    const current = bookId
      ? indexes.chaptersByKey.get(`${bookId}:${chapter.chapterNumber}`)
      : undefined;
    const key = `${chapter.bookOrder}:${chapter.chapterNumber}`;
    if (current) {
      plan.chapterIdByKey.set(key, String(current.id));
      plan.chapters.unchanged.push(chapter);
    } else plan.chapters.inserts.push(chapter);
  }

  for (const verse of target.verses) {
    const chapterKey = `${verse.bookOrder}:${verse.chapterNumber}`;
    const chapterId = plan.chapterIdByKey.get(chapterKey);
    const current = chapterId
      ? indexes.versesByKey.get(`${chapterId}:${verse.verseNumber}`)
      : undefined;
    const key = `${chapterKey}:${verse.verseNumber}`;
    if (current) {
      plan.verseIdByKey.set(key, String(current.id));
      plan.verses.unchanged.push(verse);
    } else plan.verses.inserts.push(verse);
  }

  for (const verse of target.verses) {
    const key = `${verse.bookOrder}:${verse.chapterNumber}:${verse.verseNumber}`;
    const verseId = plan.verseIdByKey.get(key);
    const current = verseId
      ? indexes.translationsByKey.get(`${verseId}:${LANGUAGE}`)
      : undefined;
    if (!current) plan.translations.inserts.push(verse);
    else if (current.text !== verse.text) {
      plan.translations.updates.push({ id: String(current.id), text: verse.text });
    } else plan.translations.unchanged.push(verse);
  }

  return plan;
}

async function verifySchema(client) {
  const tablesResult = await client.query(
    `SELECT c.relname, c.relrowsecurity
       FROM pg_class AS c
       JOIN pg_namespace AS n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname = ANY($1::text[])
        AND c.relkind IN ('r', 'p')`,
    [TABLE_NAMES],
  );
  const tableState = new Map(tablesResult.rows.map((row) => [row.relname, row.relrowsecurity]));
  for (const table of TABLE_NAMES) {
    if (!tableState.has(table)) throw new Error(`Required table public.${table} does not exist.`);
    if (tableState.get(table) !== true) {
      throw new Error(`RLS is not enabled on public.${table}; refusing to continue.`);
    }
  }

  const constraintsResult = await client.query(
    `SELECT constraint_row.conname AS constraint_name,
            table_class.relname AS table_name,
            constraint_row.contype AS constraint_type,
         pg_get_constraintdef(constraint_row.oid) AS definition,
            (SELECT array_agg(attribute_row.attname::text ORDER BY key_row.ordinality)
               FROM unnest(constraint_row.conkey) WITH ORDINALITY AS key_row(attnum, ordinality)
               JOIN pg_attribute AS attribute_row
                 ON attribute_row.attrelid = constraint_row.conrelid
                AND attribute_row.attnum = key_row.attnum) AS columns,
            referenced_class.relname AS referenced_table,
            (SELECT array_agg(attribute_row.attname::text ORDER BY key_row.ordinality)
               FROM unnest(constraint_row.confkey) WITH ORDINALITY AS key_row(attnum, ordinality)
               JOIN pg_attribute AS attribute_row
                 ON attribute_row.attrelid = constraint_row.confrelid
                AND attribute_row.attnum = key_row.attnum) AS referenced_columns
       FROM pg_constraint AS constraint_row
       JOIN pg_class AS table_class ON table_class.oid = constraint_row.conrelid
       JOIN pg_namespace AS schema_row ON schema_row.oid = table_class.relnamespace
       LEFT JOIN pg_class AS referenced_class ON referenced_class.oid = constraint_row.confrelid
      WHERE schema_row.nspname = 'public'
        AND table_class.relname = ANY($1::text[])
        AND constraint_row.contype IN ('u', 'p', 'f', 'c')`,
    [TABLE_NAMES],
  );
  const constraints = constraintsResult.rows;
  const report = formatConstraintReport(constraints);
  for (const line of report.lines) console.log(line);
  if (report.missing.length > 0) {
    throw new Error(
      `Missing ${report.missing.length} required constraint(s): ` +
        report.missing.map((item) => `${item.table} ${item.description}`).join("; "),
    );
  }
}

async function readExistingRows(client) {
  const books = await client.query(
    "SELECT id, name, testament, book_order, chapter_count FROM public.books ORDER BY id",
  );
  const chapters = await client.query(
    "SELECT id, book_id, chapter_number FROM public.chapters ORDER BY id",
  );
  const verses = await client.query(
    "SELECT id, chapter_id, verse_number FROM public.verses ORDER BY id",
  );
  const translations = await client.query(
    "SELECT id, verse_id, language, text, audio_path FROM public.verse_translations ORDER BY id",
  );
  return {
    books: books.rows,
    chapters: chapters.rows,
    verses: verses.rows,
    translations: translations.rows,
  };
}

function createTestIds(existing) {
  const ids = [
    ...existing.books.map((row) => BigInt(row.id)),
    ...existing.chapters.map((row) => BigInt(row.id)),
    ...existing.verses.map((row) => BigInt(row.id)),
    ...existing.translations.map((row) => BigInt(row.id)),
  ];
  let next = ids.length ? ids.reduce((minimum, id) => (id < minimum ? id : minimum), ids[0]) - 1n : -1n;
  return () => {
    if (next < -9223372036854775808n) throw new Error("Cannot allocate a temporary dry-run identity value.");
    const id = next.toString();
    next -= 1n;
    return id;
  };
}

function valueRows(rows, columns, offset = 1) {
  const parameters = [];
  const groups = rows.map((row, rowIndex) => {
    const placeholders = columns.map((column, columnIndex) => {
      parameters.push(row[column]);
      return `$${offset + rowIndex * columns.length + columnIndex}`;
    });
    return `(${placeholders.join(", ")})`;
  });
  return { groups: groups.join(", "), parameters };
}

async function insertRows(client, table, columns, rows, conflictColumns, returning, dryRun, nextTestId) {
  const insertedRows = [];
  for (let offset = 0; offset < rows.length; offset += BATCH_SIZE) {
    const chunk = rows.slice(offset, offset + BATCH_SIZE);
    const insertColumns = dryRun ? ["id", ...columns] : columns;
    const inputRows = dryRun
      ? chunk.map((row) => ({ id: nextTestId(), ...row }))
      : chunk;
    const { groups, parameters } = valueRows(inputRows, insertColumns);
    const result = await client.query(
      `INSERT INTO public.${table} (${insertColumns.join(", ")})` +
        `${dryRun ? " OVERRIDING SYSTEM VALUE" : ""} VALUES ${groups}` +
        ` ON CONFLICT (${conflictColumns.join(", ")}) DO NOTHING RETURNING ${returning.join(", ")}`,
      parameters,
    );
    if (result.rowCount !== chunk.length) {
      throw new Error(
        `Unexpected concurrent or duplicate rows while inserting public.${table}: ` +
          `expected ${chunk.length}, inserted ${result.rowCount}. The transaction will be rolled back.`,
      );
    }
    insertedRows.push(...result.rows);
  }
  return insertedRows;
}

async function updateRows(client, table, rows, keyName, valueName, valueType) {
  for (let offset = 0; offset < rows.length; offset += BATCH_SIZE) {
    const chunk = rows.slice(offset, offset + BATCH_SIZE);
    const parameters = [];
    const values = chunk.map((row, index) => {
      parameters.push(row.id, row[valueName]);
      const position = index * 2;
      return `($${position + 1}::bigint, $${position + 2}::${valueType})`;
    });
    const result = await client.query(
      `UPDATE public.${table} AS target
          SET ${valueName} = source.${valueName}
         FROM (VALUES ${values.join(", ")}) AS source(id, ${valueName})
        WHERE target.${keyName} = source.id
          AND target.${valueName} IS DISTINCT FROM source.${valueName}`,
      parameters,
    );
    if (result.rowCount !== chunk.length) {
      throw new Error(
        `Expected to update ${chunk.length} rows in public.${table}, updated ${result.rowCount}. The transaction will be rolled back.`,
      );
    }
  }
}

async function applyPlan(client, target, plan, existing, dryRun) {
  const nextTestId = dryRun ? createTestIds(existing) : null;

  await updateRows(client, "books", plan.books.updates, "id", "chapter_count", "integer");
  const insertedBooks = await insertRows(
    client,
    "books",
    ["name", "testament", "book_order", "chapter_count"],
    plan.books.inserts,
    ["book_order"],
    ["id", "book_order"],
    dryRun,
    nextTestId,
  );

  const bookIdByOrder = new Map(plan.bookIdByOrder);
  for (const row of insertedBooks) {
    bookIdByOrder.set(row.book_order, String(row.id));
  }

  const chapterInserts = plan.chapters.inserts.map((chapter) => ({
    book_id: bookIdByOrder.get(chapter.bookOrder),
    chapter_number: chapter.chapterNumber,
  }));
  const insertedChapters = await insertRows(
    client,
    "chapters",
    ["book_id", "chapter_number"],
    chapterInserts,
    ["book_id", "chapter_number"],
    ["id", "book_id", "chapter_number"],
    dryRun,
    nextTestId,
  );
  const chapterIdByKey = new Map(plan.chapterIdByKey);
  const bookOrderById = new Map([...bookIdByOrder].map(([order, id]) => [String(id), order]));
  for (const row of insertedChapters) {
    chapterIdByKey.set(
      `${bookOrderById.get(String(row.book_id))}:${row.chapter_number}`,
      String(row.id),
    );
  }

  const verseInserts = plan.verses.inserts.map((verse) => ({
    chapter_id: chapterIdByKey.get(`${verse.bookOrder}:${verse.chapterNumber}`),
    verse_number: verse.verseNumber,
  }));
  const insertedVerses = await insertRows(
    client,
    "verses",
    ["chapter_id", "verse_number"],
    verseInserts,
    ["chapter_id", "verse_number"],
    ["id", "chapter_id", "verse_number"],
    dryRun,
    nextTestId,
  );
  const verseIdByKey = new Map(plan.verseIdByKey);
  const bookAndChapterByChapterId = new Map(
    [...chapterIdByKey].map(([key, id]) => [String(id), key]),
  );
  for (const row of insertedVerses) {
    const [bookOrder, chapterNumber] = bookAndChapterByChapterId.get(String(row.chapter_id)).split(":");
    verseIdByKey.set(
      `${bookOrder}:${chapterNumber}:${row.verse_number}`,
      String(row.id),
    );
  }

  const translationInserts = plan.translations.inserts.map((verse) => ({
    verse_id: verseIdByKey.get(
      `${verse.bookOrder}:${verse.chapterNumber}:${verse.verseNumber}`,
    ),
    language: LANGUAGE,
    text: verse.text,
  }));
  const translationUpdates = plan.translations.updates.map((translation) => ({
    id: translation.id,
    text: translation.text,
  }));
  await updateRows(client, "verse_translations", translationUpdates, "id", "text", "text");
  await insertRows(
    client,
    "verse_translations",
    ["verse_id", "language", "text"],
    translationInserts,
    ["verse_id", "language"],
    ["id"],
    dryRun,
    nextTestId,
  );
}

export async function runImportTransaction(client, preview, { dryRun = true, log = console.log } = {}) {
  const target = expandPreview(preview);
  let transactionStarted = false;
  try {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    transactionStarted = true;
    await client.query(
      "LOCK TABLE public.books, public.chapters, public.verses, public.verse_translations IN SHARE ROW EXCLUSIVE MODE",
    );
    await verifySchema(client);
    const existing = await readExistingRows(client);
    const indexes = validateExistingRows(existing);
    const plan = buildPlan(target, existing, indexes);
    await applyPlan(client, target, plan, existing, dryRun);

    if (dryRun) await client.query("ROLLBACK");
    else await client.query("COMMIT");
    transactionStarted = false;
    return { target, plan };
  } catch (error) {
    if (transactionStarted) {
      try {
        await client.query("ROLLBACK");
      } catch {
        throw new Error(
          `${safeErrorMessage(error)}; additionally, PostgreSQL ROLLBACK failed. Check the connection before retrying.`,
        );
      }
    }
    throw error;
  }
}

function printCounts(plan, target, dryRun) {
  console.log(dryRun ? "PostgreSQL import dry run (transaction rolled back)" : "PostgreSQL import committed");
  console.log("Table                 Insert   Update   Unchanged   Total");
  const report = [
    ["books", plan.books],
    ["chapters", plan.chapters],
    ["verses", plan.verses],
    ["verse_translations", plan.translations],
  ];
  for (const [name, counts] of report) {
    const total = counts.inserts.length + counts.updates.length + counts.unchanged.length;
    console.log(
      `${name.padEnd(22)} ${String(counts.inserts.length).padStart(6)}   ` +
        `${String(counts.updates.length).padStart(6)}   ${String(counts.unchanged.length).padStart(9)}   ${String(total).padStart(6)}`,
    );
  }
  console.log(
    `Source verse entries: ${target.sourceEntryCount} | Ranges: ${target.verseRanges} | ` +
      `Verse rows: ${target.verses.length}`,
  );
  console.log(
    "Each verse covered by a USFM range receives a translation row containing the exact original range text, unchanged.",
  );
  console.log("Existing audio_path values are not modified; English translations and unrelated rows are untouched.");
  console.log("RLS was verified enabled and was not changed.");
}

async function main() {
  const { confirm } = parseArguments(process.argv.slice(2));
  activeConnectionString = parseEnvFile(await readFile(envPath, "utf8"));
  const preview = JSON.parse(await readFile(previewPath, "utf8"));
  const client = new Client({ connectionString: activeConnectionString });
  try {
    await client.connect();
    const { target, plan } = await runImportTransaction(client, preview, { dryRun: !confirm });
    printCounts(plan, target, !confirm);
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    const message = safeErrorMessage(error, activeConnectionString);
    console.error(`PostgreSQL import stopped: ${message}`);
    process.exitCode = 1;
  });
}
