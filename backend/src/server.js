const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const multer = require("multer");
const open = require("open");
const { parsePdfMetadata } = require("./pdf");
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
const DEFAULT_NOTES_DIR = path.join(PROJECT_ROOT, "notes");

if (!fs.existsSync(EXPORT_DIR)) {
  fs.mkdirSync(EXPORT_DIR, { recursive: true });
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
    const updated = await updateAppSettings({ notesDir });
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
    const parsed = await parsePdfMetadata(req.file.buffer);
    return res.json({
      metadata: parsed,
      source: "pdf_auto",
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
  try {
    const { paperId } = req.body || {};
    if (!paperId) {
      return res.status(400).json({ message: "paperId 必填" });
    }
    const paper = await get("SELECT * FROM papers WHERE id = ?", [paperId]);
    if (!paper) return res.status(404).json({ message: "文献不存在" });

    const result = {
      suggestedValues: {
        main_contribution: "[AI建议] 请补充该论文最核心的1-3点贡献",
        limitation: "[AI建议] 请评估实验场景覆盖面与泛化限制",
      },
      confidence: 0.42,
      rationale: "当前为预留接口的本地 mock 输出，后续可接真实模型。",
    };

    await run(
      "INSERT INTO ai_jobs(paper_id, job_type, input_ref, status, result_json, created_at) VALUES(?,?,?,?,?,?)",
      [paperId, "analyze_and_fill", "local_mock", "done", JSON.stringify(result), now()]
    );

    return res.json(result);
  } catch (error) {
    return res.status(500).json({ message: "AI分析失败", error: error.message });
  }
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