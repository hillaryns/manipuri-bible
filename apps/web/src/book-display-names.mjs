const ENGLISH_DISPLAY_NAMES = {
  matthew: "Matthew",
  mark: "Mark",
  luke: "Luke",
  john: "John",
  pakhonchatpa: "Acts",
  rome: "Romans",
  "1 corinth": "1 Corinthians",
  "2 corinth": "2 Corinthians",
  galatia: "Galatians",
  ephesus: "Ephesians",
  philippi: "Philippians",
  colossae: "Colossians",
  "1 thessalonica": "1 Thessalonians",
  "2 thessalonica": "2 Thessalonians",
  "1 timothy": "1 Timothy",
  "2 timothy": "2 Timothy",
  titus: "Titus",
  philemon: "Philemon",
  hebrew: "Hebrews",
  jacob: "James",
  "1 peter": "1 Peter",
  "2 peter": "2 Peter",
  "1 john": "1 John",
  "2 john": "2 John",
  "3 john": "3 John",
  jude: "Jude",
  phongdokpiba: "Revelation",
};

function normalizeBookName(name) {
  return name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[.]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function getBookDisplayName(bookName, language) {
  if (language === "manipuriRoman") return bookName;
  return ENGLISH_DISPLAY_NAMES[normalizeBookName(bookName)] ?? bookName;
}
