const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const multer = require("multer");
const open = require("open");
const { parsePdfMetadata, parsePdfFullText } = require("./pdf");
const { buildExcelBuffer } = require("./exporter");
const {
  run,
  get,
  all,
  initDb,
  now,
  getTemplateByKind,
  getTemplateById,
  listTemplates,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  getEnumGroupsWithOptions,
  getAppSettings,
  updateAppSettings,
} = require("./db");

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

const PROJECT_ROOT = path.resolve(__dirname, "../../");
const FRONTEND_DIR = path.join(PROJECT_ROOT, "frontend");
const EXPORT_DIR = path.join(PROJECT_ROOT, "backend", "data", "exports");
const PDF_UPLOAD_DIR = path.join(PROJECT_ROOT, "backend", "data", "pdfs");
const DEFAULT_NOTES_DIR = path.join(PROJECT_ROOT, "notes");
const LOCAL_ENV_PATH = path.join(PROJECT_ROOT, ".env");

if (!fs.existsSync(EXPORT_DIR)) {
  fs.mkdirSync(EXPORT_DIR, { recursive: true });
}

if (!fs.existsSync(PDF_UPLOAD_DIR)) {
  fs.mkdirSync(PDF_UPLOAD_DIR, { recursive: true });
}

if (!fs.existsSync(DEFAULT_NOTES_DIR)) {
  fs.mkdirSync(DEFAULT_NOTES_DIR, { recursive: true });
}

app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true }));
app.use("/exports", express.static(EXPORT_DIR));
app.use(express.static(FRONTEND_DIR));

function normalizePaper(row) {
  return {
    id: row.id,
    stage: row.stage,
    templateId: row.template_id || null,
    title: row.title,
    year: row.year,
    venue: row.venue,
    authors: row.authors,
    link: row.link,
    pdfPath: row.pdf_path,
    mdPath: row.md_path,
    priority: row.priority,
    category: row.category,
    relationType: row.relation_type,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    fieldValues: {},
  };
}

function slugifyForFileName(text) {
  return String(text || "")
    .trim()
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function pickNotesDir(settings) {
  const configured = settings?.notesDir?.trim();
  if (!configured) return DEFAULT_NOTES_DIR;
  return path.resolve(configured);
}

const AI_SESSION_TTL_MS = 20 * 60 * 1000;
const AI_MAX_PDF_BYTES = 10 * 1024 * 1024;
const AI_MAX_PROMPT_CHARS = 24000;
const aiSessions = new Map();

function loadLocalEnvVars() {
  if (!fs.existsSync(LOCAL_ENV_PATH)) {
    return {};
  }

  const raw = fs.readFileSync(LOCAL_ENV_PATH, "utf8");
  const result = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex <= 0) continue;

    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }

  return result;
}

function safeParseJson(text, fallback) {
  try {
    return JSON.parse(text);
  } catch (_err) {
    return fallback;
  }
}

function normalizeAiMode(mode) {
  return ["paper_only", "note_only", "combined"].includes(mode) ? mode : "combined";
}

function normalizePdfPolicy(policy) {
  return ["full_pdf", "metadata_only"].includes(policy) ? policy : "full_pdf";
}

function sanitizeAiTargetFieldKeys(input) {
  if (!Array.isArray(input)) return [];
  return input
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .filter((item, index, list) => list.indexOf(item) === index)
    .slice(0, 12);
}

function resolveAiFieldPlan(requestedKeys, blockedFieldKeys = []) {
  const blockedSet = new Set(
    (Array.isArray(blockedFieldKeys) ? blockedFieldKeys : [])
      .map((item) => String(item || "").trim())
      .filter(Boolean)
  );
  const allowedKeys = requestedKeys.filter((key) => !blockedSet.has(key));
  const blockedKeys = requestedKeys.filter((key) => blockedSet.has(key));
  return { allowedKeys, blockedKeys };
}

function buildPromptForField({ paperData, fieldKey, mode, template }) {
  const promptTemplate = String(template || "").trim();
  if (!promptTemplate) {
    throw new Error("AI 字段提示词模板为空，请先在设置中配置");
  }

  const paperJson = JSON.stringify(
    {
      title: paperData.title || "",
      authors: paperData.authors || "",
      year: paperData.year || "",
      venue: paperData.venue || "",
      link: paperData.link || "",
      fieldValues: paperData.fieldValues || {},
    },
    null,
    2
  );

  const noteExcerpt = mode === "paper_only" ? "" : String(paperData.noteContent || "").slice(0, 8000);
  const pdfExcerpt = String(paperData.pdfText || "").slice(0, 12000);

  return promptTemplate
    .replaceAll("{{field_key}}", fieldKey)
    .replaceAll("{{mode}}", mode)
    .replaceAll("{{paper_json}}", paperJson)
    .replaceAll("{{note_content}}", noteExcerpt || "(无)")
    .replaceAll("{{pdf_excerpt}}", pdfExcerpt || "(无)");
}

async function callOpenAiCompatible({ settings, messages }) {
  const envVars = loadLocalEnvVars();
  const apiKey = String(envVars.AI_API_KEY || "").trim();
  if (!apiKey) {
    throw new Error("未在 .env 配置 AI_API_KEY");
  }

  const baseUrl = String(envVars.AI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
  const model = String(settings?.ai?.model || "gpt-4.1-mini");
  const timeoutMs = Number(settings?.ai?.timeoutMs || 30000);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.2,
        response_format: { type: "json_object" },
      }),
      signal: controller.signal,
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const errorMessage = payload?.error?.message || payload?.message || `AI服务请求失败(${response.status})`;
      throw new Error(errorMessage);
    }

    const content = payload?.choices?.[0]?.message?.content || "{}";
    return safeParseJson(content, {});
  } finally {
    clearTimeout(timer);
  }
}

function cleanupAiSessions() {
  const nowTs = Date.now();
  for (const [sessionId, info] of aiSessions.entries()) {
    if (!info?.updatedAt || nowTs - info.updatedAt > AI_SESSION_TTL_MS) {
      aiSessions.delete(sessionId);
    }
  }
}

async function collectPaperDataForAi(paperId, mode) {
  const paperRow = await get("SELECT * FROM papers WHERE id = ?", [paperId]);
  if (!paperRow) throw new Error("文献不存在");

  const paper = await hydratePaper(normalizePaper(paperRow));
  let noteContent = "";
  if (mode !== "paper_only" && paper.mdPath) {
    try {
      const normalized = path.resolve(paper.mdPath);
      if (fs.existsSync(normalized) && fs.statSync(normalized).isFile()) {
        noteContent = fs.readFileSync(normalized, "utf8").slice(0, AI_MAX_PROMPT_CHARS);
      }
    } catch (_err) {
      noteContent = "";
    }
  }

  let pdfText = "";
  let pdfInfo = { pages: 0, bytes: 0 };
  if (paper.pdfPath) {
    try {
      const normalizedPdf = path.resolve(paper.pdfPath);
      if (fs.existsSync(normalizedPdf) && fs.statSync(normalizedPdf).isFile()) {
        const stats = fs.statSync(normalizedPdf);
        pdfInfo = { pages: 0, bytes: Number(stats.size || 0) };
        if (stats.size <= AI_MAX_PDF_BYTES) {
          const buffer = fs.readFileSync(normalizedPdf);
          const parsed = await parsePdfFullText(buffer);
          pdfText = parsed.text.slice(0, AI_MAX_PROMPT_CHARS);
          pdfInfo.pages = parsed.pages;
        }
      }
    } catch (_err) {
      pdfText = "";
    }
  }

  return {
    ...paper,
    noteContent,
    pdfText,
    pdfInfo,
    hasPdfFile: Boolean(paper.pdfPath),
    usedPdfText: Boolean(pdfText),
  };
}

function newAiSessionId() {
  return `ais_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

async function createNoteFileForPaper({ paperTitle, year }) {
  const settings = await getAppSettings();
  const notesDir = pickNotesDir(settings);
  if (!fs.existsSync(notesDir)) {
    fs.mkdirSync(notesDir, { recursive: true });
  }

  const base = slugifyForFileName(`${paperTitle || "untitled"}-${year || ""}`) || `paper-${Date.now()}`;
  let filename = `${base}.md`;
  let fullPath = path.join(notesDir, filename);
  let idx = 1;
  while (fs.existsSync(fullPath)) {
    filename = `${base}-${idx}.md`;
    fullPath = path.join(notesDir, filename);
    idx += 1;
  }

  const templateContent = `# ${paperTitle || "未命名论文"}\n\n- 年份：${year || ""}\n- 阅读阶段：粗读\n\n## 摘要笔记\n\n\n## 方法拆解\n\n\n## 结论与启发\n\n`;
  fs.writeFileSync(fullPath, templateContent, "utf8");
  return fullPath;
}

async function getPaperFieldValues(paperId) {
  const rows = await all(
    "SELECT field_key, value_text, source, updated_at FROM paper_field_values WHERE paper_id = ?",
    [paperId]
  );
  const out = {};
  rows.forEach((row) => {
    out[row.field_key] = row.value_text || "";
  });
  return out;
}

async function hydratePaper(paper) {
  const result = { ...paper };
  result.fieldValues = await getPaperFieldValues(paper.id);
  return result;
}

async function upsertFieldValues(paperId, fieldValues, source = "manual") {
  if (!fieldValues || typeof fieldValues !== "object") return;

  const entries = Object.entries(fieldValues).filter(([, value]) => value !== undefined && value !== null);

  for (const [fieldKey, value] of entries) {
    const valueText = typeof value === "string" ? value : JSON.stringify(value);
    const existing = await get(
      "SELECT id FROM paper_field_values WHERE paper_id = ? AND field_key = ?",
      [paperId, fieldKey]
    );

    if (existing) {
      await run(
        "UPDATE paper_field_values SET value_text = ?, source = ?, updated_at = ? WHERE id = ?",
        [valueText, source, now(), existing.id]
      );
    } else {
      await run(
        "INSERT INTO paper_field_values(paper_id, field_key, value_text, value_json, source, updated_at) VALUES(?, ?, ?, NULL, ?, ?)",
        [paperId, fieldKey, valueText, source, now()]
      );
    }
  }
}

async function listPapers(filters) {
  const where = [];
  const params = [];

  if (filters.stage) {
    where.push("p.stage = ?");
    params.push(filters.stage);
  }
  if (filters.keyword) {
    where.push("(p.title LIKE ? OR p.authors LIKE ? OR p.venue LIKE ?)");
    const kw = `%${filters.keyword}%`;
    params.push(kw, kw, kw);
  }
  if (filters.priority) {
    where.push("p.priority = ?");
    params.push(filters.priority);
  }
  if (filters.category) {
    where.push("p.category = ?");
    params.push(filters.category);
  }
  if (filters.relationType) {
    where.push("p.relation_type = ?");
    params.push(filters.relationType);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const rows = await all(
    `SELECT p.* FROM papers p ${whereSql} ORDER BY p.updated_at DESC, p.id DESC`,
    params
  );

  const papers = [];
  for (const row of rows) {
    const paper = normalizePaper(row);
    papers.push(await hydratePaper(paper));
  }
  return papers;
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, now: now() });
});

app.get("/api/templates", async (_req, res) => {
  try {
    const templates = await listTemplates();
    const roughTemplates = templates.filter((t) => t.kind === "rough");
    const deepTemplates = templates.filter((t) => t.kind === "deep");
    res.json({
      roughTemplates,
      deepTemplates,
      defaultRough: roughTemplates[0] || null,
      defaultDeep: deepTemplates[0] || null,
    });
  } catch (error) {
    res.status(500).json({ message: "模板获取失败", error: error.message });
  }
});

app.post("/api/templates", async (req, res) => {
  try {
    const payload = req.body || {};
    const created = await createTemplate({
      kind: payload.kind,
      name: payload.name,
      baseTemplateId: payload.baseTemplateId || null,
      fields: payload.fields || [],
    });
    res.status(201).json(created);
  } catch (error) {
    res.status(400).json({ message: "创建模板失败", error: error.message });
  }
});

app.put("/api/templates/:id", async (req, res) => {
  try {
    const templateId = Number(req.params.id);
    const updated = await updateTemplate(templateId, req.body || {});
    res.json(updated);
  } catch (error) {
    res.status(400).json({ message: "更新模板失败", error: error.message });
  }
});

app.delete("/api/templates/:id", async (req, res) => {
  try {
    const templateId = Number(req.params.id);
    await deleteTemplate(templateId);
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ message: "删除模板失败", error: error.message });
  }
});

app.get("/api/enums", async (_req, res) => {
  try {
    const groups = await getEnumGroupsWithOptions();
    res.json(groups);
  } catch (error) {
    res.status(500).json({ message: "选项获取失败", error: error.message });
  }
});

app.get("/api/settings", async (_req, res) => {
  try {
    const settings = await getAppSettings();
    const notesDir = pickNotesDir(settings);
    if (!fs.existsSync(notesDir)) {
      fs.mkdirSync(notesDir, { recursive: true });
    }
    res.json({ ...settings, notesDir });
  } catch (error) {
    res.status(500).json({ message: "设置读取失败", error: error.message });
  }
});

app.put("/api/settings", async (req, res) => {
  try {
    const payload = req.body || {};
    const notesDir = payload.notesDir ? path.resolve(String(payload.notesDir)) : "";
    if (notesDir && !fs.existsSync(notesDir)) {
      fs.mkdirSync(notesDir, { recursive: true });
    }

    const aiPayload = payload.ai && typeof payload.ai === "object"
      ? {
          enabled: Boolean(payload.ai.enabled),
          provider: String(payload.ai.provider || "openai_compatible"),
          baseUrl: String(payload.ai.baseUrl || "https://api.openai.com/v1"),
          model: String(payload.ai.model || "gpt-4.1-mini"),
          timeoutMs: Number(payload.ai.timeoutMs || 30000),
          pdfPolicy: normalizePdfPolicy(payload.ai.pdfPolicy || "full_pdf"),
          systemPrompt: String(payload.ai.systemPrompt || "").trim(),
          fieldPromptTemplate: String(payload.ai.fieldPromptTemplate || "").trim(),
          blockedFieldKeys: Array.isArray(payload.ai.blockedFieldKeys)
            ? payload.ai.blockedFieldKeys.map((item) => String(item || "").trim()).filter(Boolean)
            : undefined,
          requirePdf: payload.ai.requirePdf === undefined ? undefined : Boolean(payload.ai.requirePdf),
        }
      : undefined;

    const updated = await updateAppSettings({ notesDir, ai: aiPayload });
    res.json({ ...updated, notesDir: pickNotesDir(updated) });
  } catch (error) {
    res.status(400).json({ message: "设置更新失败", error: error.message });
  }
});

app.post("/api/enums/:groupKey/options", async (req, res) => {
  try {
    const { groupKey } = req.params;
    const { value, label } = req.body;
    if (!value || !label) {
      return res.status(400).json({ message: "value 和 label 必填" });
    }

    const group = await get("SELECT * FROM enum_groups WHERE group_key = ?", [groupKey]);
    if (!group) return res.status(404).json({ message: "分组不存在" });

    const orderInfo = await get("SELECT COALESCE(MAX(order_no),0) as maxOrder FROM enum_options WHERE group_id = ?", [group.id]);

    await run(
      "INSERT INTO enum_options(group_id, value, label, order_no, is_active) VALUES(?, ?, ?, ?, 1)",
      [group.id, value, label, (orderInfo?.maxOrder || 0) + 1]
    );

    const groups = await getEnumGroupsWithOptions();
    return res.json(groups[groupKey]);
  } catch (error) {
    return res.status(500).json({ message: "新增选项失败", error: error.message });
  }
});

app.put("/api/enums/:groupKey/options/:optionId", async (req, res) => {
  try {
    const { groupKey, optionId } = req.params;
    const { value, label, isActive } = req.body;
    const group = await get("SELECT * FROM enum_groups WHERE group_key = ?", [groupKey]);
    if (!group) return res.status(404).json({ message: "分组不存在" });

    const opt = await get("SELECT * FROM enum_options WHERE id = ? AND group_id = ?", [optionId, group.id]);
    if (!opt) return res.status(404).json({ message: "选项不存在" });

    await run(
      "UPDATE enum_options SET value = ?, label = ?, is_active = ? WHERE id = ?",
      [value ?? opt.value, label ?? opt.label, isActive === undefined ? opt.is_active : Number(Boolean(isActive)), optionId]
    );

    const groups = await getEnumGroupsWithOptions();
    return res.json(groups[groupKey]);
  } catch (error) {
    return res.status(500).json({ message: "更新选项失败", error: error.message });
  }
});

app.delete("/api/enums/:groupKey/options/:optionId", async (req, res) => {
  try {
    const { groupKey, optionId } = req.params;
    const group = await get("SELECT * FROM enum_groups WHERE group_key = ?", [groupKey]);
    if (!group) return res.status(404).json({ message: "分组不存在" });

    await run("DELETE FROM enum_options WHERE id = ? AND group_id = ?", [optionId, group.id]);
    const groups = await getEnumGroupsWithOptions();
    return res.json(groups[groupKey]);
  } catch (error) {
    return res.status(500).json({ message: "删除选项失败", error: error.message });
  }
});

app.post("/api/pdf/parse", upload.single("pdf"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: "请上传 PDF 文件" });
    }

    const originalName = String(req.file.originalname || "uploaded-pdf");
    const originalExt = path.extname(originalName).toLowerCase();
    const baseName = slugifyForFileName(path.basename(originalName, originalExt)) || "uploaded-pdf";
    const fileName = `${baseName}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.pdf`;
    const filePath = path.join(PDF_UPLOAD_DIR, fileName);

    fs.writeFileSync(filePath, req.file.buffer);

    const parsed = await parsePdfMetadata(req.file.buffer);
    return res.json({
      metadata: parsed,
      source: "pdf_auto",
      pdfPath: filePath,
      fileName,
    });
  } catch (error) {
    return res.status(500).json({ message: "PDF 解析失败", error: error.message });
  }
});

app.get("/api/papers", async (req, res) => {
  try {
    const papers = await listPapers({
      stage: req.query.stage || "",
      keyword: req.query.keyword || "",
      priority: req.query.priority || "",
      category: req.query.category || "",
      relationType: req.query.relationType || "",
    });
    return res.json({ items: papers, total: papers.length });
  } catch (error) {
    return res.status(500).json({ message: "获取文献失败", error: error.message });
  }
});

app.get("/api/papers/:id", async (req, res) => {
  try {
    const row = await get("SELECT * FROM papers WHERE id = ?", [req.params.id]);
    if (!row) return res.status(404).json({ message: "文献不存在" });
    const paper = await hydratePaper(normalizePaper(row));
    return res.json(paper);
  } catch (error) {
    return res.status(500).json({ message: "获取文献详情失败", error: error.message });
  }
});

app.post("/api/papers", async (req, res) => {
  try {
    const payload = req.body || {};
    if (!payload.title || !payload.title.trim()) {
      return res.status(400).json({ message: "论文题目必填" });
    }

    const stage = payload.stage === "deep" ? "deep" : "rough";

    let template = null;
    if (payload.templateId) {
      template = await getTemplateById(Number(payload.templateId));
      if (!template) {
        return res.status(400).json({ message: "所选模板不存在" });
      }
    } else {
      template = await getTemplateByKind(stage);
    }

    let mdPath = payload.mdPath || "";
    if (payload.autoCreateMd && !mdPath.trim()) {
      mdPath = await createNoteFileForPaper({ paperTitle: payload.title, year: payload.year || "" });
    }

    const timestamp = now();
    const insert = await run(
      `INSERT INTO papers(stage,template_id,title,year,venue,authors,link,pdf_path,md_path,priority,category,relation_type,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        stage,
        template?.id || null,
        payload.title.trim(),
        payload.year || "",
        payload.venue || "",
        payload.authors || "",
        payload.link || "",
        payload.pdfPath || "",
        mdPath,
        payload.priority || payload.fieldValues?.priority || "",
        payload.category || payload.fieldValues?.category || "",
        payload.relationType || payload.fieldValues?.relation_type || "",
        timestamp,
        timestamp,
      ]
    );

    await upsertFieldValues(insert.lastID, payload.fieldValues || {}, payload.source || "manual");

    const row = await get("SELECT * FROM papers WHERE id = ?", [insert.lastID]);
    return res.status(201).json(await hydratePaper(normalizePaper(row)));
  } catch (error) {
    return res.status(500).json({ message: "新建文献失败", error: error.message });
  }
});

app.put("/api/papers/:id", async (req, res) => {
  try {
    const paperId = Number(req.params.id);
    const existing = await get("SELECT * FROM papers WHERE id = ?", [paperId]);
    if (!existing) return res.status(404).json({ message: "文献不存在" });

    const payload = req.body || {};
    const stage = payload.stage === "deep" ? "deep" : payload.stage === "rough" ? "rough" : existing.stage;

    await run(
      `UPDATE papers
       SET stage = ?, template_id = ?, title = ?, year = ?, venue = ?, authors = ?, link = ?, pdf_path = ?, md_path = ?, priority = ?, category = ?, relation_type = ?, updated_at = ?
       WHERE id = ?`,
      [
        stage,
        payload.templateId === undefined ? existing.template_id : payload.templateId,
        payload.title ?? existing.title,
        payload.year ?? existing.year,
        payload.venue ?? existing.venue,
        payload.authors ?? existing.authors,
        payload.link ?? existing.link,
        payload.pdfPath ?? existing.pdf_path,
        payload.mdPath ?? existing.md_path,
        payload.priority ?? payload.fieldValues?.priority ?? existing.priority,
        payload.category ?? payload.fieldValues?.category ?? existing.category,
        payload.relationType ?? payload.fieldValues?.relation_type ?? existing.relation_type,
        now(),
        paperId,
      ]
    );

    await upsertFieldValues(paperId, payload.fieldValues || {}, payload.source || "manual");

    const row = await get("SELECT * FROM papers WHERE id = ?", [paperId]);
    return res.json(await hydratePaper(normalizePaper(row)));
  } catch (error) {
    return res.status(500).json({ message: "更新文献失败", error: error.message });
  }
});

app.post("/api/papers/:id/upgrade", async (req, res) => {
  try {
    const paperId = Number(req.params.id);
    const existing = await get("SELECT * FROM papers WHERE id = ?", [paperId]);
    if (!existing) return res.status(404).json({ message: "文献不存在" });

    if (existing.stage === "deep") {
      const deepPaper = await hydratePaper(normalizePaper(existing));
      return res.json(deepPaper);
    }

    await run("UPDATE papers SET stage = ?, updated_at = ? WHERE id = ?", ["deep", now(), paperId]);
    await run(
      "INSERT INTO paper_transitions(paper_id, from_stage, to_stage, operator, created_at) VALUES(?,?,?,?,?)",
      [paperId, "rough", "deep", "user", now()]
    );

    const row = await get("SELECT * FROM papers WHERE id = ?", [paperId]);
    return res.json(await hydratePaper(normalizePaper(row)));
  } catch (error) {
    return res.status(500).json({ message: "升级为精读失败", error: error.message });
  }
});

app.delete("/api/papers/:id", async (req, res) => {
  try {
    const paperId = Number(req.params.id);
    const existing = await get("SELECT * FROM papers WHERE id = ?", [paperId]);
    if (!existing) return res.status(404).json({ message: "文献不存在" });

    await run("DELETE FROM papers WHERE id = ?", [paperId]);
    return res.json({ ok: true });
  } catch (error) {
    return res.status(500).json({ message: "删除文献失败", error: error.message });
  }
});

app.post("/api/papers/create-md", async (req, res) => {
  try {
    const payload = req.body || {};
    const title = String(payload.title || "").trim() || "未命名论文";
    const year = String(payload.year || "").trim();
    const mdPath = await createNoteFileForPaper({ paperTitle: title, year });
    return res.json({ ok: true, mdPath });
  } catch (error) {
    return res.status(500).json({ message: "创建MD失败", error: error.message });
  }
});

app.post("/api/papers/open-md", async (req, res) => {
  try {
    const mdPath = req.body?.mdPath;
    const title = String(req.body?.title || "未命名论文").trim();
    const year = String(req.body?.year || "").trim();

    if (!mdPath || !mdPath.trim()) {
      return res.status(400).json({ message: "mdPath 不能为空" });
    }

    const normalizedPath = path.resolve(mdPath.trim());
    const ext = path.extname(normalizedPath).toLowerCase();
    if (![".md", ".markdown"].includes(ext)) {
      return res.status(400).json({ message: "仅支持打开 .md/.markdown 文件" });
    }

    if (!fs.existsSync(normalizedPath)) {
      const dir = path.dirname(normalizedPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const templateContent = `# ${title || "未命名论文"}\n\n- 年份：${year || ""}\n\n## 摘要笔记\n\n## 方法拆解\n\n## 结论与启发\n`;
      fs.writeFileSync(normalizedPath, templateContent, "utf8");
    }

    try {
      await open(normalizedPath, { wait: false });
    } catch (_err) {
      if (process.platform === "win32") {
        const { execFileSync } = require("node:child_process");
        execFileSync("cmd", ["/c", "start", "", normalizedPath], { windowsHide: true });
      } else {
        throw _err;
      }
    }

    return res.json({ ok: true, mdPath: normalizedPath });
  } catch (error) {
    return res.status(500).json({ message: "打开 MD 失败", error: error.message });
  }
});

app.post("/api/export", async (req, res) => {
  try {
    const { selectedIds = [], viewMode = "deep", filters = {} } = req.body || {};
    let papers = [];

    if (Array.isArray(selectedIds) && selectedIds.length > 0) {
      const placeholders = selectedIds.map(() => "?").join(",");
      const rows = await all(`SELECT * FROM papers WHERE id IN (${placeholders}) ORDER BY updated_at DESC`, selectedIds);
      for (const row of rows) {
        papers.push(await hydratePaper(normalizePaper(row)));
      }
    } else {
      papers = await listPapers(filters);
    }

    const buffer = await buildExcelBuffer(papers, viewMode === "rough" ? "rough" : "deep");
    const fileName = `papers-export-${Date.now()}.xlsx`;
    const filePath = path.join(EXPORT_DIR, fileName);
    fs.writeFileSync(filePath, Buffer.from(buffer));

    await run(
      "INSERT INTO exports(filter_json, selected_ids_json, file_path, status, created_at) VALUES(?,?,?,?,?)",
      [JSON.stringify(filters || {}), JSON.stringify(selectedIds || []), filePath, "done", now()]
    );

    return res.json({
      ok: true,
      fileName,
      downloadUrl: `/exports/${fileName}`,
    });
  } catch (error) {
    return res.status(500).json({ message: "导出失败", error: error.message });
  }
});

app.post("/api/ai/analyze-and-fill", async (req, res) => {
  let jobId = 0;
  try {
    cleanupAiSessions();
    const {
      paperId,
      targetFieldKeys = [],
      mode: modeInput,
      pdfPolicy: pdfPolicyInput,
      consent,
      aiSessionId,
      forceRefreshContext,
    } = req.body || {};

    if (!paperId) {
      return res.status(400).json({ message: "paperId 必填" });
    }

    const settings = await getAppSettings();
    if (!settings?.ai?.enabled) {
      return res.status(400).json({ message: "AI 功能未启用，请先在设置中开启" });
    }

    const mode = normalizeAiMode(modeInput);
    const configuredPolicy = normalizePdfPolicy(settings?.ai?.pdfPolicy);
    const pdfPolicy = normalizePdfPolicy(pdfPolicyInput || configuredPolicy);

    const requestedFields = sanitizeAiTargetFieldKeys(targetFieldKeys);
    if (requestedFields.length === 0) {
      return res.status(400).json({ message: "targetFieldKeys 至少包含 1 个字段" });
    }

    const { allowedKeys: fields, blockedKeys } = resolveAiFieldPlan(
      requestedFields,
      settings?.ai?.blockedFieldKeys || []
    );
    if (fields.length === 0) {
      return res.status(400).json({ message: "所选字段均被策略限制，当前不允许自动补全" });
    }

    const paperExists = await get("SELECT id FROM papers WHERE id = ?", [paperId]);
    if (!paperExists) {
      return res.status(404).json({ message: "文献不存在" });
    }

    const inputRef = `paper:${paperId}`;
    const startedAt = now();
    const created = await run(
      "INSERT INTO ai_jobs(paper_id, job_type, input_ref, status, result_json, created_at, job_scope, mode, target_field_keys_json, started_at, session_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      [paperId, "analyze_and_fill", inputRef, "running", "{}", startedAt, "single", mode, JSON.stringify(fields), startedAt, aiSessionId || null]
    );
    jobId = created.lastID;

    const paperData = await collectPaperDataForAi(Number(paperId), mode);
    const warnings = [];
    if (paperData.pdfInfo.bytes > AI_MAX_PDF_BYTES) {
      warnings.push(`PDF大小超过限制(${AI_MAX_PDF_BYTES} bytes)，已跳过全文发送`);
    }

    if (settings?.ai?.requirePdf) {
      if (!paperData.hasPdfFile) {
        await run(
          "UPDATE ai_jobs SET status = ?, finished_at = ?, error_json = ? WHERE id = ?",
          ["failed", now(), JSON.stringify({ message: "当前策略要求先上传PDF，才能执行AI生成" }), jobId]
        );
        return res.status(400).json({ message: "当前策略要求先上传PDF，才能执行AI生成" });
      }
      if (pdfPolicy === "full_pdf" && !paperData.usedPdfText) {
        await run(
          "UPDATE ai_jobs SET status = ?, finished_at = ?, error_json = ? WHERE id = ?",
          ["failed", now(), JSON.stringify({ message: "未能读取可用PDF全文，请检查文件路径与大小限制" }), jobId]
        );
        return res.status(400).json({ message: "未能读取可用PDF全文，请检查文件路径与大小限制" });
      }
    }

    let session = aiSessionId ? aiSessions.get(aiSessionId) : null;
    const isSamePaperSession = Boolean(session && Number(session.paperId) === Number(paperId));
    const isStalePaperSession =
      Boolean(isSamePaperSession) &&
      String(session?.paperUpdatedAt || "") !== String(paperData.updatedAt || "");
    const shouldBuildSession = !isSamePaperSession || Boolean(forceRefreshContext) || isStalePaperSession;

    if (shouldBuildSession && pdfPolicy === "full_pdf") {
      const granted = Boolean(consent?.accepted);
      if (!granted) {
        await run(
          "UPDATE ai_jobs SET status = ?, finished_at = ?, error_json = ? WHERE id = ?",
          ["failed", now(), JSON.stringify({ message: "需要确认后才能发送全文给AI" }), jobId]
        );
        return res.status(400).json({ message: "需要确认后才能发送全文给AI" });
      }
    }

    if (shouldBuildSession) {
      const sessionId = newAiSessionId();
      const contextData = {
        title: paperData.title,
        authors: paperData.authors,
        year: paperData.year,
        venue: paperData.venue,
        link: paperData.link,
        fieldValues: paperData.fieldValues,
        noteContent: mode === "paper_only" ? "" : paperData.noteContent,
        pdfText: pdfPolicy === "full_pdf" ? paperData.pdfText : "",
      };
      session = {
        id: sessionId,
        paperId: Number(paperId),
        paperUpdatedAt: String(paperData.updatedAt || ""),
        contextData,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      aiSessions.set(sessionId, session);
    } else {
      session.updatedAt = Date.now();
    }

    const suggestedValues = {};
    const confidenceList = [];
    const rationaleList = [];

    for (const fieldKey of fields) {
      const prompt = buildPromptForField({
        paperData: session.contextData,
        fieldKey,
        mode,
        template: settings?.ai?.fieldPromptTemplate,
      });
      const aiJson = await callOpenAiCompatible({
        settings,
        messages: [
          {
            role: "system",
            content: String(settings?.ai?.systemPrompt || "你是论文阅读助手。输出 JSON。"),
          },
          { role: "user", content: prompt.slice(0, AI_MAX_PROMPT_CHARS) },
        ],
      });

      const value = String(aiJson?.value || "").trim();
      if (value) {
        suggestedValues[fieldKey] = value;
      }
      const confidence = Number(aiJson?.confidence);
      if (!Number.isNaN(confidence) && confidence >= 0) {
        confidenceList.push(Math.max(0, Math.min(1, confidence)));
      }
      if (aiJson?.rationale) {
        rationaleList.push(`${fieldKey}: ${String(aiJson.rationale)}`);
      }
    }

    const result = {
      jobId,
      aiSessionId: session.id,
      suggestedValues,
      confidence:
        confidenceList.length === 0
          ? 0
          : Number((confidenceList.reduce((acc, cur) => acc + cur, 0) / confidenceList.length).toFixed(2)),
      rationale: rationaleList.join("；") || "AI 已生成建议，请逐条确认后再保存。",
      warnings,
      blockedFieldKeys: blockedKeys,
      contextMeta: {
        mode,
        pdfPolicy,
        hasPdfFile: paperData.hasPdfFile,
        usedPdfText: pdfPolicy === "full_pdf" && Boolean(session.contextData?.pdfText),
        usedNoteContent: Boolean(session.contextData?.noteContent),
        rebuiltFromLatestPaper: shouldBuildSession,
      },
    };

    await run(
      "UPDATE ai_jobs SET status = ?, result_json = ?, finished_at = ?, warnings_json = ?, session_id = ? WHERE id = ?",
      ["done", JSON.stringify(result), now(), JSON.stringify(warnings), session.id, jobId]
    );

    return res.json(result);
  } catch (error) {
    if (jobId > 0) {
      await run(
        "UPDATE ai_jobs SET status = ?, finished_at = ?, error_json = ? WHERE id = ?",
        ["failed", now(), JSON.stringify({ message: error.message }), jobId]
      ).catch(() => {});
    }
    return res.status(500).json({ message: "AI分析失败", error: error.message });
  }
});

app.post("/api/ai/batch/analyze", async (req, res) => {
  try {
    cleanupAiSessions();
    const { paperIds = [], targetFieldKeys = [], mode: modeInput, pdfPolicy, consent } = req.body || {};
    if (!Array.isArray(paperIds) || paperIds.length === 0) {
      return res.status(400).json({ message: "paperIds 不能为空" });
    }

    const settings = await getAppSettings();
    if (!settings?.ai?.enabled) {
      return res.status(400).json({ message: "AI 功能未启用，请先在设置中开启" });
    }

    const mode = normalizeAiMode(modeInput);
    const requestedFields = sanitizeAiTargetFieldKeys(targetFieldKeys);
    if (requestedFields.length === 0) {
      return res.status(400).json({ message: "targetFieldKeys 至少包含 1 个字段" });
    }

    const { allowedKeys: fields, blockedKeys } = resolveAiFieldPlan(
      requestedFields,
      settings?.ai?.blockedFieldKeys || []
    );
    if (fields.length === 0) {
      return res.status(400).json({ message: "所选字段均被策略限制，当前不允许自动补全" });
    }

    const normalizedIds = paperIds
      .map((id) => Number(id))
      .filter((id, index, list) => Number.isInteger(id) && id > 0 && list.indexOf(id) === index)
      .slice(0, 100);

    if (normalizedIds.length === 0) {
      return res.status(400).json({ message: "未提供有效 paperIds" });
    }

    const existingRows = await all(
      `SELECT id FROM papers WHERE id IN (${normalizedIds.map(() => "?").join(",")})`,
      normalizedIds
    );
    const existingIdSet = new Set(existingRows.map((row) => Number(row.id)));
    const missingPaperIds = normalizedIds.filter((id) => !existingIdSet.has(id));
    if (missingPaperIds.length > 0) {
      return res.status(400).json({ message: "部分文献不存在", missingPaperIds });
    }

    const normalizedBatchPdfPolicy = normalizePdfPolicy(pdfPolicy || settings?.ai?.pdfPolicy);
    if (normalizedBatchPdfPolicy === "full_pdf" && !consent?.accepted) {
      return res.status(400).json({ message: "批量分析前需要确认全文发送" });
    }

    if (settings?.ai?.requirePdf) {
      const missingPdfRows = await all(
        `SELECT id FROM papers WHERE id IN (${normalizedIds.map(() => "?").join(",")}) AND (pdf_path IS NULL OR TRIM(pdf_path) = '')`,
        normalizedIds
      );
      if (missingPdfRows.length > 0) {
        return res.status(400).json({
          message: "当前策略要求先上传PDF，以下记录尚未绑定PDF",
          missingPdfPaperIds: missingPdfRows.map((row) => Number(row.id)),
        });
      }
    }

    const createdAt = now();
    const batch = await run(
      "INSERT INTO ai_jobs(paper_id, job_type, input_ref, status, result_json, created_at, job_scope, mode, target_field_keys_json, started_at, warnings_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      [
        null,
        "batch_analyze",
        `papers:${normalizedIds.join(",")}`,
        "queued",
        JSON.stringify({ total: normalizedIds.length, done: 0, failed: 0, items: [] }),
        createdAt,
        "batch",
        mode,
        JSON.stringify(fields),
        createdAt,
        JSON.stringify([]),
      ]
    );

    const batchJobId = batch.lastID;

    for (const paperId of normalizedIds) {
      await run(
        "INSERT INTO ai_job_items(job_id, paper_id, status, result_json, error_json, created_at, updated_at) VALUES(?,?,?,?,?,?,?)",
        [batchJobId, paperId, "queued", "{}", "", now(), now()]
      );
    }

    (async () => {
      let done = 0;
      let failed = 0;
      const summaryItems = [];

      await run("UPDATE ai_jobs SET status = ? WHERE id = ?", ["running", batchJobId]);

      const itemRows = await all("SELECT id, paper_id FROM ai_job_items WHERE job_id = ? ORDER BY id ASC", [batchJobId]);
      for (const item of itemRows) {
        try {
          await run("UPDATE ai_job_items SET status = ?, updated_at = ? WHERE id = ?", ["running", now(), item.id]);
          const singleResult = await (async () => {
            const paperData = await collectPaperDataForAi(item.paper_id, mode);
            if (settings?.ai?.requirePdf) {
              if (!paperData.hasPdfFile) {
                throw new Error("当前策略要求先上传PDF，才能执行AI生成");
              }
              if (normalizedBatchPdfPolicy === "full_pdf" && !paperData.usedPdfText) {
                throw new Error("未能读取可用PDF全文，请检查文件路径与大小限制");
              }
            }

            const localSuggested = {};
            for (const fieldKey of fields) {
              const aiJson = await callOpenAiCompatible({
                settings,
                messages: [
                  {
                    role: "system",
                    content: String(settings?.ai?.systemPrompt || "你是论文阅读助手。输出 JSON。"),
                  },
                  {
                    role: "user",
                    content: buildPromptForField({
                      paperData,
                      fieldKey,
                      mode,
                      template: settings?.ai?.fieldPromptTemplate,
                    }).slice(0, AI_MAX_PROMPT_CHARS),
                  },
                ],
              });
              const value = String(aiJson?.value || "").trim();
              if (value) localSuggested[fieldKey] = value;
            }
            return {
              paperId: item.paper_id,
              suggestedValues: localSuggested,
              blockedFieldKeys: blockedKeys,
              contextMeta: {
                mode,
                pdfPolicy: normalizedBatchPdfPolicy,
                hasPdfFile: paperData.hasPdfFile,
                usedPdfText: normalizedBatchPdfPolicy === "full_pdf" && paperData.usedPdfText,
                usedNoteContent: Boolean(paperData.noteContent),
              },
            };
          })();

          done += 1;
          summaryItems.push({ paperId: item.paper_id, status: "done", suggestedValues: singleResult.suggestedValues });
          await run(
            "UPDATE ai_job_items SET status = ?, result_json = ?, error_json = ?, updated_at = ? WHERE id = ?",
            ["done", JSON.stringify(singleResult), "", now(), item.id]
          );
        } catch (error) {
          failed += 1;
          summaryItems.push({ paperId: item.paper_id, status: "failed", error: error.message });
          await run(
            "UPDATE ai_job_items SET status = ?, error_json = ?, updated_at = ? WHERE id = ?",
            ["failed", JSON.stringify({ message: error.message }), now(), item.id]
          );
        }

        await run(
          "UPDATE ai_jobs SET result_json = ? WHERE id = ?",
          [JSON.stringify({ total: normalizedIds.length, done, failed, items: summaryItems }), batchJobId]
        );
      }

      await run(
        "UPDATE ai_jobs SET status = ?, finished_at = ?, result_json = ? WHERE id = ?",
        [failed > 0 ? "partial" : "done", now(), JSON.stringify({ total: normalizedIds.length, done, failed, items: summaryItems }), batchJobId]
      );
    })().catch(async (error) => {
      await run(
        "UPDATE ai_jobs SET status = ?, finished_at = ?, error_json = ? WHERE id = ?",
        ["failed", now(), JSON.stringify({ message: error.message }), batchJobId]
      ).catch(() => {});
    });

    return res.json({ batchJobId, status: "queued", total: normalizedIds.length, blockedFieldKeys: blockedKeys });
  } catch (error) {
    return res.status(500).json({ message: "批量AI分析失败", error: error.message });
  }
});

app.get("/api/ai/jobs/:id", async (req, res) => {
  try {
    const jobId = Number(req.params.id);
    if (!jobId) return res.status(400).json({ message: "任务ID非法" });

    const job = await get("SELECT * FROM ai_jobs WHERE id = ?", [jobId]);
    if (!job) return res.status(404).json({ message: "任务不存在" });

    const items = await all(
      "SELECT id, paper_id, status, result_json, error_json, created_at, updated_at FROM ai_job_items WHERE job_id = ? ORDER BY id ASC",
      [jobId]
    );

    return res.json({
      id: job.id,
      status: job.status,
      jobScope: job.job_scope,
      mode: job.mode,
      targetFieldKeys: safeParseJson(job.target_field_keys_json || "[]", []),
      startedAt: job.started_at || job.created_at,
      finishedAt: job.finished_at || "",
      result: safeParseJson(job.result_json || "{}", {}),
      error: safeParseJson(job.error_json || "{}", {}),
      items: items.map((item) => ({
        id: item.id,
        paperId: item.paper_id,
        status: item.status,
        result: safeParseJson(item.result_json || "{}", {}),
        error: safeParseJson(item.error_json || "{}", {}),
        createdAt: item.created_at,
        updatedAt: item.updated_at,
      })),
    });
  } catch (error) {
    return res.status(500).json({ message: "读取任务失败", error: error.message });
  }
});

app.post("/api/ai/session/reset", (req, res) => {
  const { aiSessionId } = req.body || {};
  if (!aiSessionId) {
    return res.status(400).json({ message: "aiSessionId 必填" });
  }
  aiSessions.delete(String(aiSessionId));
  return res.json({ ok: true });
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(FRONTEND_DIR, "index.html"));
});

const PORT = process.env.PORT || 3000;
const HOST = "127.0.0.1";

initDb()
  .then(() => {
    app.listen(PORT, HOST, () => {
      // eslint-disable-next-line no-console
      console.log(`文献阅读管理工具已启动: http://${HOST}:${PORT}`);
    });
  })
  .catch((error) => {
    // eslint-disable-next-line no-console
    console.error("数据库初始化失败", error);
    process.exit(1);
  });