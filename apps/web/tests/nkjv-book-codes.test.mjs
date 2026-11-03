import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { getNkjvBookCode } from "../src/nkjv-book-codes.mjs";
import { getBookDisplayName } from "../src/book-display-names.mjs";

const expectedCodesByName = new Map([
  ["Matthew", "MAT"],
  ["Mark", "MRK"],
  ["Luke", "LUK"],
  ["John", "JHN"],
  ["Pakhonchatpa", "ACT"],
  ["Rome", "ROM"],
  ["1 Corinth", "1CO"],
  ["2 Corinth", "2CO"],
  ["Galatia", "GAL"],
  ["Ephesus", "EPH"],
  ["Philippi", "PHP"],
  ["Colossae", "COL"],
  ["1 Thessalonica", "1TH"],
  ["2 Thessalonica", "2TH"],
  ["1 Timothy", "1TI"],
  ["2 Timothy", "2TI"],
  ["Titus", "TIT"],
  ["Philemon", "PHM"],
  ["Hebrew", "HEB"],
  ["Jacob", "JAS"],
  ["1 Peter", "1PE"],
  ["2 Peter", "2PE"],
  ["1 John", "1JN"],
  ["2 John", "2JN"],
  ["3 John", "3JN"],
  ["Jude", "JUD"],
  ["Phongdokpiba", "REV"],
]);

const expectedEnglishNamesByName = new Map([
  ["Matthew", "Matthew"],
  ["Mark", "Mark"],
  ["Luke", "Luke"],
  ["John", "John"],
  ["Pakhonchatpa", "Acts"],
  ["Rome", "Romans"],
  ["1 Corinth", "1 Corinthians"],
  ["2 Corinth", "2 Corinthians"],
  ["Galatia", "Galatians"],
  ["Ephesus", "Ephesians"],
  ["Philippi", "Philippians"],
  ["Colossae", "Colossians"],
  ["1 Thessalonica", "1 Thessalonians"],
  ["2 Thessalonica", "2 Thessalonians"],
  ["1 Timothy", "1 Timothy"],
  ["2 Timothy", "2 Timothy"],
  ["Titus", "Titus"],
  ["Philemon", "Philemon"],
  ["Hebrew", "Hebrews"],
  ["Jacob", "James"],
  ["1 Peter", "1 Peter"],
  ["2 Peter", "2 Peter"],
  ["1 John", "1 John"],
  ["2 John", "2 John"],
  ["3 John", "3 John"],
  ["Jude", "Jude"],
  ["Phongdokpiba", "Revelation"],
]);

test("maps all 27 imported Manipuri New Testament book names to their USFM IDs", async () => {
  const previewPath = new URL("../../../scripts/output/manipuri-roman-nt-preview.json", import.meta.url);
  const preview = JSON.parse(await readFile(previewPath, "utf8"));

  assert.equal(preview.books.length, 27);
  assert.equal(expectedCodesByName.size, 27);

  for (const book of preview.books) {
    const expectedCode = expectedCodesByName.get(book.name);
    assert.ok(expectedCode, `Unexpected imported book name: ${book.name}`);
    assert.equal(book.usfmId, expectedCode, `${book.name} has an unexpected source USFM ID`);
    assert.equal(
      getNkjvBookCode(book.name),
      book.usfmId,
      `${book.name} does not map to its source USFM ID`,
    );
  }
});

test("maps standard English aliases including James and its Manipuri name Jacob", () => {
  assert.equal(getNkjvBookCode("James"), "JAS");
  assert.equal(getNkjvBookCode("Jacob"), "JAS");
  assert.equal(getNkjvBookCode("Acts"), "ACT");
  assert.equal(getNkjvBookCode("Romans"), "ROM");
  assert.equal(getNkjvBookCode("Revelation"), "REV");
});

test("keeps all 27 original names in Manipuri mode and displays standard English names", async () => {
  const previewPath = new URL("../../../scripts/output/manipuri-roman-nt-preview.json", import.meta.url);
  const preview = JSON.parse(await readFile(previewPath, "utf8"));

  assert.equal(preview.books.length, 27);
  for (const book of preview.books) {
    const expectedEnglishName = expectedEnglishNamesByName.get(book.name);
    assert.ok(expectedEnglishName, `Unexpected imported book name: ${book.name}`);
    assert.equal(
      getBookDisplayName(book.name, "manipuriRoman"),
      book.name,
      `${book.name} should remain unchanged in Manipuri mode`,
    );
    assert.equal(
      getBookDisplayName(book.name, "english"),
      expectedEnglishName,
      `${book.name} should use its standard English name`,
    );
  }

  assert.equal(getBookDisplayName("Phongdokpiba", "english"), "Revelation");
  assert.equal(getBookDisplayName("Pakhonchatpa", "english"), "Acts");
  assert.equal(getBookDisplayName("Rome", "english"), "Romans");
  assert.equal(getBookDisplayName("Jacob", "english"), "James");
  assert.equal(getBookDisplayName("Matthew", "manipuriRoman"), "Matthew");
  assert.equal(getBookDisplayName("Matthew", "english"), "Matthew");
});
