const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const {
  TEMPLATE_KINDS,
  ENUM_GROUPS,
  DEFAULT_ENUM_OPTIONS,
  BASE_TEMPLATE_FIELDS,
  DEEP_EXTENDED_FIELDS,
} = require("./constants");

const DB_DIR = path.join(__dirname, "../data");
const DB_PATH = path.join(DB_DIR, "litnotes.db");

if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

const db = new DatabaseSync(DB_PATH);

const DEFAULT_AI_SYSTEM_PROMPT =
  "你是严谨的论文阅读助手。只基于提供的论文信息作答，证据不足时返回空值，不要编造。输出必须是 JSON 对象。";

const DEFAULT_AI_FIELD_PROMPT_TEMPLATE = [
  "请基于以下上下文，为目标字段生成建议值。",
  "目标字段: {{field_key}}",
  "分析模式: {{mode}}",
  "论文元数据(JSON): {{paper_json}}",
  "笔记摘录: {{note_content}}",
  "PDF全文摘录: {{pdf_excerpt}}",
  "若证据不足，请返回空字符串。",
  "仅返回 JSON: {\"value\":\"\",\"confidence\":0.0,\"rationale\":\"\"}",
].join("\n");

const DEFAULT_AI_BLOCKED_FIELD_KEYS = ["relation_type", "category"];

db.exec("PRAGMA foreign_keys = ON");

function run(sql, params = []) {
  try {
    const stmt = db.prepare(sql);
    const result = stmt.run(...params);
    return Promise.resolve({
      lastID: Number(result?.lastInsertRowid || 0),
      changes: Number(result?.changes || 0),
    });
  } catch (error) {
    return Promise.reject(error);
  }
}

function get(sql, params = []) {
  try {
    const stmt = db.prepare(sql);
    const row = stmt.get(...params);
    return Promise.resolve(row);
  } catch (error) {
    return Promise.reject(error);
  }
}

function all(sql, params = []) {
  try {
    const stmt = db.prepare(sql);
    const rows = stmt.all(...params);
    return Promise.resolve(rows);
  } catch (error) {
    return Promise.reject(error);
  }
}

async function migrateTemplateDefsIfNeeded() {
  const tableDef = await get("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'template_defs'");
  const ddl = String(tableDef?.sql || "").toLowerCase();

  const hasOldUniqueKind = ddl.includes("kind text not null unique");
  const hasNewUniqueKindName = ddl.includes("unique(kind, name)");
  if (!hasOldUniqueKind && hasNewUniqueKindName) {
    return;
  }

  await run("PRAGMA foreign_keys = OFF");
  await run(`
    CREATE TABLE IF NOT EXISTS template_defs_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      base_template_id INTEGER,
      schema_json TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      is_active INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL,
      UNIQUE(kind, name),
      FOREIGN KEY(base_template_id) REFERENCES template_defs_new(id)
    )
  `);

  await run(`
    INSERT INTO template_defs_new(id, name, kind, base_template_id, schema_json, version, is_active, updated_at)
    SELECT id, name, kind, base_template_id, schema_json, version, is_active, updated_at
    FROM template_defs
  `);

  await run("DROP TABLE template_defs");
  await run("ALTER TABLE template_defs_new RENAME TO template_defs");
  await run("PRAGMA foreign_keys = ON");
}

async function initSchema() {
  await run(`
    CREATE TABLE IF NOT EXISTS template_defs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      base_template_id INTEGER,
      schema_json TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      is_active INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL,
      UNIQUE(kind, name),
      FOREIGN KEY(base_template_id) REFERENCES template_defs(id)
    )
  `);

  await migrateTemplateDefsIfNeeded();

  await run(`
    CREATE TABLE IF NOT EXISTS template_fields (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      template_id INTEGER NOT NULL,
      field_key TEXT NOT NULL,
      label TEXT NOT NULL,
      field_type TEXT NOT NULL,
      required INTEGER NOT NULL DEFAULT 0,
      order_no INTEGER NOT NULL,
      is_builtin INTEGER NOT NULL DEFAULT 1,
      is_active INTEGER NOT NULL DEFAULT 1,
      UNIQUE(template_id, field_key),
      FOREIGN KEY(template_id) REFERENCES template_defs(id) ON DELETE CASCADE
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS enum_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_key TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      is_system INTEGER NOT NULL DEFAULT 1
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS enum_options (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id INTEGER NOT NULL,
      value TEXT NOT NULL,
      label TEXT NOT NULL,
      order_no INTEGER NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      UNIQUE(group_id, value),
      FOREIGN KEY(group_id) REFERENCES enum_groups(id) ON DELETE CASCADE
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS papers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      stage TEXT NOT NULL,
      template_id INTEGER,
      title TEXT NOT NULL,
      year TEXT,
      venue TEXT,
      authors TEXT,
      link TEXT,
      pdf_path TEXT,
      md_path TEXT,
      priority TEXT,
      category TEXT,
      relation_type TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(template_id) REFERENCES template_defs(id)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS paper_field_values (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      paper_id INTEGER NOT NULL,
      field_key TEXT NOT NULL,
      value_text TEXT,
      value_json TEXT,
      source TEXT NOT NULL DEFAULT 'manual',
      updated_at TEXT NOT NULL,
      UNIQUE(paper_id, field_key),
      FOREIGN KEY(paper_id) REFERENCES papers(id) ON DELETE CASCADE
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS paper_transitions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      paper_id INTEGER NOT NULL,
      from_stage TEXT NOT NULL,
      to_stage TEXT NOT NULL,
      operator TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(paper_id) REFERENCES papers(id) ON DELETE CASCADE
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS exports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filter_json TEXT,
      selected_ids_json TEXT,
      file_path TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS ai_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      paper_id INTEGER,
      job_type TEXT,
      input_ref TEXT,
      status TEXT NOT NULL,
      result_json TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(paper_id) REFERENCES papers(id) ON DELETE SET NULL
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS ai_job_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL,
      paper_id INTEGER,
      status TEXT NOT NULL,
      result_json TEXT,
      error_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(job_id) REFERENCES ai_jobs(id) ON DELETE CASCADE,
      FOREIGN KEY(paper_id) REFERENCES papers(id) ON DELETE SET NULL
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS app_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      notes_dir TEXT,
      updated_at TEXT NOT NULL
    )
  `);

  await run("INSERT OR IGNORE INTO app_settings(id, notes_dir, updated_at) VALUES(1, '', ?)", [now()]);

  const tableInfo = await all("PRAGMA table_info(papers)");
  const hasTemplateId = tableInfo.some((col) => col.name === "template_id");
  if (!hasTemplateId) {
    await run("ALTER TABLE papers ADD COLUMN template_id INTEGER");
  }

  async function ensureColumn(tableName, columnName, definitionSql) {
    const cols = await all(`PRAGMA table_info(${tableName})`);
    const exists = cols.some((col) => col.name === columnName);
    if (!exists) {
      await run(`ALTER TABLE ${tableName} ADD COLUMN ${definitionSql}`);
    }
  }

  await ensureColumn("app_settings", "ai_enabled", "ai_enabled INTEGER NOT NULL DEFAULT 0");
  await ensureColumn("app_settings", "ai_provider", "ai_provider TEXT NOT NULL DEFAULT 'openai_compatible'");
  await ensureColumn("app_settings", "ai_base_url", "ai_base_url TEXT NOT NULL DEFAULT 'https://api.openai.com/v1'");
  await ensureColumn("app_settings", "ai_model", "ai_model TEXT NOT NULL DEFAULT 'gpt-4.1-mini'");
  await ensureColumn("app_settings", "ai_timeout_ms", "ai_timeout_ms INTEGER NOT NULL DEFAULT 30000");
  await ensureColumn("app_settings", "ai_pdf_policy", "ai_pdf_policy TEXT NOT NULL DEFAULT 'full_pdf'");
  await ensureColumn(
    "app_settings",
    "ai_system_prompt",
    `ai_system_prompt TEXT NOT NULL DEFAULT '${DEFAULT_AI_SYSTEM_PROMPT.replace(/'/g, "''")}'`
  );
  await ensureColumn(
    "app_settings",
    "ai_field_prompt_template",
    `ai_field_prompt_template TEXT NOT NULL DEFAULT '${DEFAULT_AI_FIELD_PROMPT_TEMPLATE.replace(/'/g, "''")}'`
  );
  await ensureColumn(
    "app_settings",
    "ai_blocked_field_keys_json",
    `ai_blocked_field_keys_json TEXT NOT NULL DEFAULT '${JSON.stringify(DEFAULT_AI_BLOCKED_FIELD_KEYS).replace(/'/g, "''")}'`
  );
  await ensureColumn("app_settings", "ai_require_pdf", "ai_require_pdf INTEGER NOT NULL DEFAULT 1");

  await ensureColumn("ai_jobs", "job_scope", "job_scope TEXT NOT NULL DEFAULT 'single'");
  await ensureColumn("ai_jobs", "mode", "mode TEXT");
  await ensureColumn("ai_jobs", "target_field_keys_json", "target_field_keys_json TEXT");
  await ensureColumn("ai_jobs", "started_at", "started_at TEXT");
  await ensureColumn("ai_jobs", "finished_at", "finished_at TEXT");
  await ensureColumn("ai_jobs", "error_json", "error_json TEXT");
  await ensureColumn("ai_jobs", "session_id", "session_id TEXT");
  await ensureColumn("ai_jobs", "warnings_json", "warnings_json TEXT");
}


function slugify(input) {
  return String(input || "")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "template";
}

function now() {
  return new Date().toISOString();
}

async function upsertTemplate(kind, name, baseTemplateId = null) {
  const existing = await get("SELECT * FROM template_defs WHERE kind = ? AND name = ?", [kind, name]);
  if (existing) {
    await run(
      "UPDATE template_defs SET base_template_id = ?, updated_at = ? WHERE id = ?",
      [baseTemplateId, now(), existing.id]
    );
    return { ...existing, base_template_id: baseTemplateId };
  }
  const result = await run(
    "INSERT INTO template_defs(name, kind, base_template_id, schema_json, updated_at) VALUES(?, ?, ?, ?, ?)",
    [name, kind, baseTemplateId, "{}", now()]
  );
  return get("SELECT * FROM template_defs WHERE id = ?", [result.lastID]);
}

async function seedTemplates() {
  const rough = await upsertTemplate(TEMPLATE_KINDS.ROUGH, "粗读模板-默认", null);
  const deep = await upsertTemplate(TEMPLATE_KINDS.DEEP, "精读模板-默认", rough.id);

  const roughFieldCount = await get("SELECT COUNT(*) as cnt FROM template_fields WHERE template_id = ?", [rough.id]);
  if (!roughFieldCount || roughFieldCount.cnt === 0) {
    for (let idx = 0; idx < BASE_TEMPLATE_FIELDS.length; idx += 1) {
      const field = BASE_TEMPLATE_FIELDS[idx];
      await run(
        "INSERT INTO template_fields(template_id, field_key, label, field_type, required, order_no, is_builtin, is_active) VALUES(?, ?, ?, ?, ?, ?, 1, 1)",
        [rough.id, field.key, field.label, field.type, field.required, idx + 1]
      );
    }
  }

  const deepFieldCount = await get("SELECT COUNT(*) as cnt FROM template_fields WHERE template_id = ?", [deep.id]);
  if (!deepFieldCount || deepFieldCount.cnt === 0) {
    for (let idx = 0; idx < DEEP_EXTENDED_FIELDS.length; idx += 1) {
      const field = DEEP_EXTENDED_FIELDS[idx];
      await run(
        "INSERT INTO template_fields(template_id, field_key, label, field_type, required, order_no, is_builtin, is_active) VALUES(?, ?, ?, ?, ?, ?, 1, 1)",
        [deep.id, field.key, field.label, field.type, field.required, idx + 1]
      );
    }
  }
}

async function seedEnums() {
  const groupNames = {
    [ENUM_GROUPS.CATEGORY]: "相关工作类别",
    [ENUM_GROUPS.PRIORITY]: "精读优先级",
    [ENUM_GROUPS.RELATION]: "和我的关系",
  };

  for (const [groupKey, options] of Object.entries(DEFAULT_ENUM_OPTIONS)) {
    let group = await get("SELECT * FROM enum_groups WHERE group_key = ?", [groupKey]);
    if (!group) {
      const result = await run(
        "INSERT INTO enum_groups(group_key, name, is_system) VALUES(?, ?, 1)",
        [groupKey, groupNames[groupKey] || groupKey]
      );
      group = await get("SELECT * FROM enum_groups WHERE id = ?", [result.lastID]);
    }

    const cnt = await get("SELECT COUNT(*) as cnt FROM enum_options WHERE group_id = ?", [group.id]);
    if (!cnt || cnt.cnt === 0) {
      for (let i = 0; i < options.length; i += 1) {
        const value = options[i];
        await run(
          "INSERT INTO enum_options(group_id, value, label, order_no, is_active) VALUES(?, ?, ?, ?, 1)",
          [group.id, value, value, i + 1]
        );
      }
    }
  }
}

async function initDb() {
  await initSchema();
  await seedTemplates();
  await seedEnums();
}

function normalizeTemplateWithFields(template, fields) {
  return {
    ...template,
    fields: fields.map((f, idx) => ({
      id: f.id,
      key: f.field_key,
      label: f.label,
      type: f.field_type,
      required: Boolean(f.required),
      orderNo: idx + 1,
      isBuiltin: Boolean(f.is_builtin),
      isActive: Boolean(f.is_active),
    })),
  };
}

async function getTemplateById(templateId) {
  const template = await get("SELECT * FROM template_defs WHERE id = ?", [templateId]);
  if (!template) return null;

  const fields = [];
  if (template.base_template_id) {
    const baseFields = await all(
      "SELECT * FROM template_fields WHERE template_id = ? AND is_active = 1 ORDER BY order_no ASC",
      [template.base_template_id]
    );
    fields.push(...baseFields);
  }

  const ownFields = await all(
    "SELECT * FROM template_fields WHERE template_id = ? AND is_active = 1 ORDER BY order_no ASC",
    [template.id]
  );
  fields.push(...ownFields);
  return normalizeTemplateWithFields(template, fields);
}

async function getTemplateByKind(kind) {
  const template = await get("SELECT * FROM template_defs WHERE kind = ? AND is_active = 1 ORDER BY id ASC LIMIT 1", [kind]);
  if (!template) return null;
  return getTemplateById(template.id);
}

async function listTemplates() {
  const templates = await all("SELECT * FROM template_defs WHERE is_active = 1 ORDER BY kind ASC, id ASC");
  const out = [];
  for (const template of templates) {
    const fullTemplate = await getTemplateById(template.id);
    if (fullTemplate) out.push(fullTemplate);
  }
  return out;
}

async function createTemplate({ kind, name, baseTemplateId = null, fields = [] }) {
  const cleanedName = String(name || "").trim();
  if (!cleanedName) throw new Error("模板名称不能为空");
  if (!Object.values(TEMPLATE_KINDS).includes(kind)) throw new Error("模板类型非法");

  const result = await run(
    "INSERT INTO template_defs(name, kind, base_template_id, schema_json, updated_at) VALUES(?, ?, ?, ?, ?)",
    [cleanedName, kind, baseTemplateId || null, "{}", now()]
  );

  const templateId = result.lastID;
  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i];
    const key = field.key || slugify(field.label || `field-${i + 1}`);
    await run(
      "INSERT INTO template_fields(template_id, field_key, label, field_type, required, order_no, is_builtin, is_active) VALUES(?, ?, ?, ?, ?, ?, 0, 1)",
      [templateId, key, field.label || key, field.type || "text", Number(Boolean(field.required)), i + 1]
    );
  }

  return getTemplateById(templateId);
}

async function replaceTemplateFields(templateId, fields = []) {
  await run("DELETE FROM template_fields WHERE template_id = ?", [templateId]);
  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i];
    const key = field.key || slugify(field.label || `field-${i + 1}`);
    await run(
      "INSERT INTO template_fields(template_id, field_key, label, field_type, required, order_no, is_builtin, is_active) VALUES(?, ?, ?, ?, ?, ?, ?, 1)",
      [templateId, key, field.label || key, field.type || "text", Number(Boolean(field.required)), i + 1, Number(Boolean(field.isBuiltin))]
    );
  }
}

async function updateTemplate(templateId, payload = {}) {
  const existing = await get("SELECT * FROM template_defs WHERE id = ?", [templateId]);
  if (!existing) throw new Error("模板不存在");

  await run(
    "UPDATE template_defs SET name = ?, kind = ?, base_template_id = ?, updated_at = ? WHERE id = ?",
    [
      payload.name ? String(payload.name).trim() : existing.name,
      payload.kind || existing.kind,
      payload.baseTemplateId === undefined ? existing.base_template_id : payload.baseTemplateId,
      now(),
      templateId,
    ]
  );

  if (Array.isArray(payload.fields)) {
    await replaceTemplateFields(templateId, payload.fields);
  }

  return getTemplateById(templateId);
}

async function deleteTemplate(templateId) {
  await run("UPDATE template_defs SET is_active = 0, updated_at = ? WHERE id = ?", [now(), templateId]);
}

async function getAppSettings() {
  const row = await get("SELECT * FROM app_settings WHERE id = 1");
  let blockedFieldKeys = [];
  try {
    const parsed = JSON.parse(row?.ai_blocked_field_keys_json || JSON.stringify(DEFAULT_AI_BLOCKED_FIELD_KEYS));
    if (Array.isArray(parsed)) {
      blockedFieldKeys = parsed.map((item) => String(item || "").trim()).filter(Boolean);
    }
  } catch (_err) {
    blockedFieldKeys = [...DEFAULT_AI_BLOCKED_FIELD_KEYS];
  }

  return {
    id: 1,
    notesDir: row?.notes_dir || "",
    ai: {
      enabled: Boolean(row?.ai_enabled),
      provider: row?.ai_provider || "openai_compatible",
      baseUrl: row?.ai_base_url || "https://api.openai.com/v1",
      model: row?.ai_model || "gpt-4.1-mini",
      timeoutMs: Number(row?.ai_timeout_ms || 30000),
      pdfPolicy: row?.ai_pdf_policy || "full_pdf",
      systemPrompt: row?.ai_system_prompt || DEFAULT_AI_SYSTEM_PROMPT,
      fieldPromptTemplate: row?.ai_field_prompt_template || DEFAULT_AI_FIELD_PROMPT_TEMPLATE,
      blockedFieldKeys,
      requirePdf: row?.ai_require_pdf === undefined ? true : Boolean(row?.ai_require_pdf),
    },
    updatedAt: row?.updated_at || now(),
  };
}

async function updateAppSettings(payload = {}) {
  const current = await getAppSettings();
  const notesDir = payload.notesDir === undefined ? current.notesDir : String(payload.notesDir || "").trim();
  const nextAi = {
    enabled:
      payload.ai?.enabled === undefined
        ? current.ai.enabled
        : Boolean(payload.ai.enabled),
    provider: payload.ai?.provider ? String(payload.ai.provider).trim() : current.ai.provider,
    baseUrl: payload.ai?.baseUrl ? String(payload.ai.baseUrl).trim() : current.ai.baseUrl,
    model: payload.ai?.model ? String(payload.ai.model).trim() : current.ai.model,
    timeoutMs:
      payload.ai?.timeoutMs === undefined
        ? current.ai.timeoutMs
        : Math.max(3000, Number(payload.ai.timeoutMs) || current.ai.timeoutMs),
    pdfPolicy: payload.ai?.pdfPolicy ? String(payload.ai.pdfPolicy).trim() : current.ai.pdfPolicy,
    systemPrompt:
      payload.ai?.systemPrompt === undefined
        ? current.ai.systemPrompt
        : String(payload.ai.systemPrompt || "").trim() || DEFAULT_AI_SYSTEM_PROMPT,
    fieldPromptTemplate:
      payload.ai?.fieldPromptTemplate === undefined
        ? current.ai.fieldPromptTemplate
        : String(payload.ai.fieldPromptTemplate || "").trim() || DEFAULT_AI_FIELD_PROMPT_TEMPLATE,
    blockedFieldKeys:
      payload.ai?.blockedFieldKeys === undefined
        ? current.ai.blockedFieldKeys
        : Array.isArray(payload.ai.blockedFieldKeys)
          ? payload.ai.blockedFieldKeys.map((item) => String(item || "").trim()).filter(Boolean)
          : current.ai.blockedFieldKeys,
    requirePdf:
      payload.ai?.requirePdf === undefined
        ? current.ai.requirePdf
        : Boolean(payload.ai.requirePdf),
  };
  await run(
    "UPDATE app_settings SET notes_dir = ?, ai_enabled = ?, ai_provider = ?, ai_base_url = ?, ai_model = ?, ai_timeout_ms = ?, ai_pdf_policy = ?, ai_system_prompt = ?, ai_field_prompt_template = ?, ai_blocked_field_keys_json = ?, ai_require_pdf = ?, updated_at = ? WHERE id = 1",
    [
      notesDir,
      Number(nextAi.enabled),
      nextAi.provider || "openai_compatible",
      nextAi.baseUrl || "https://api.openai.com/v1",
      nextAi.model || "gpt-4.1-mini",
      nextAi.timeoutMs,
      nextAi.pdfPolicy || "full_pdf",
      nextAi.systemPrompt,
      nextAi.fieldPromptTemplate,
      JSON.stringify(nextAi.blockedFieldKeys || DEFAULT_AI_BLOCKED_FIELD_KEYS),
      Number(Boolean(nextAi.requirePdf)),
      now(),
    ]
  );
  return getAppSettings();
}

async function getEnumGroupsWithOptions() {
  const groups = await all("SELECT * FROM enum_groups ORDER BY id ASC");
  const result = {};
  for (const group of groups) {
    const options = await all(
      "SELECT id, value, label, order_no as orderNo, is_active as isActive FROM enum_options WHERE group_id = ? ORDER BY order_no ASC, id ASC",
      [group.id]
    );
    result[group.group_key] = {
      id: group.id,
      groupKey: group.group_key,
      name: group.name,
      isSystem: Boolean(group.is_system),
      options: options.map((o) => ({ ...o, isActive: Boolean(o.isActive) })),
    };
  }
  return result;
}

module.exports = {
  db,
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
  DB_PATH,
};