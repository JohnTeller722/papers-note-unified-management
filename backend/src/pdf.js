const pdfParse = require("pdf-parse");

function pickYear(text) {
  const candidates = text.match(/\b(19\d{2}|20\d{2})\b/g) || [];
  if (candidates.length === 0) return "";
  const currentYear = new Date().getFullYear();
  const years = candidates
    .map((y) => Number(y))
    .filter((y) => y >= 1980 && y <= currentYear + 1)
    .sort((a, b) => b - a);
  return years[0] ? String(years[0]) : "";
}

function pickTitle(lines, metaTitle) {
  if (metaTitle && metaTitle.trim().length > 6) return metaTitle.trim();
  const candidate = lines.find(
    (line) =>
      line.length >= 10 &&
      line.length <= 180 &&
      !/^(abstract|摘要|introduction|references)$/i.test(line)
  );
  return candidate || "";
}

function pickAuthors(lines, metaAuthor) {
  if (metaAuthor && metaAuthor.trim().length > 2) return metaAuthor.trim();
  const authorLine = lines.find(
    (line) =>
      line.length <= 120 &&
      /,| and |;|，/.test(line) &&
      !/university|institute|department|school|college|实验室|大学|学院/i.test(line)
  );
  return authorLine || "";
}

function pickDoi(text) {
  const match = text.match(/10\.\d{4,9}\/[-._;()/:A-Z0-9]+/i);
  return match ? match[0] : "";
}

async function parsePdfMetadata(buffer) {
  const parsed = await pdfParse(buffer, { max: 2 });
  const text = (parsed.text || "").replace(/\t/g, " ");
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 60);

  const title = pickTitle(lines, parsed.info?.Title || "");
  const authors = pickAuthors(lines, parsed.info?.Author || "");
  const year = pickYear(text);
  const doi = pickDoi(text);

  return {
    title,
    authors,
    year,
    doi,
    info: {
      pages: parsed.numpages || 0,
      producer: parsed.info?.Producer || "",
      creator: parsed.info?.Creator || "",
    },
  };
}

async function parsePdfFullText(buffer) {
  const parsed = await pdfParse(buffer);
  return {
    text: (parsed.text || "").replace(/\t/g, " "),
    pages: Number(parsed.numpages || 0),
  };
}

module.exports = { parsePdfMetadata, parsePdfFullText };