import { api } from "./api/client.js";
import { initTheme, toggleTheme } from "./theme/index.js";

const FIELD_TYPES = ["text", "textarea", "enum:related_category", "enum:reading_priority", "enum:relation_type"];

const BASE_ENTRY_FIELDS = [
  ["title", "论文题目", "text", true],
  ["year", "年份", "text", false],
  ["venue", "会议/期刊", "text", false],
  ["authors", "作者", "text", false],
  ["link", "链接", "text", false],
  ["pdfPath", "PDF路径", "text", false],
  ["mdPath", "MD路径", "text", false],
];

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

const state = {
  templatesPayload: null,
  templatesById: new Map(),
  enums: {},
  settings: {
    notesDir: "",
    ai: {
      enabled: false,
      provider: "openai_compatible",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4.1-mini",
      timeoutMs: 30000,
      pdfPolicy: "full_pdf",
      systemPrompt: DEFAULT_AI_SYSTEM_PROMPT,
      fieldPromptTemplate: DEFAULT_AI_FIELD_PROMPT_TEMPLATE,
      blockedFieldKeys: [...DEFAULT_AI_BLOCKED_FIELD_KEYS],
      requirePdf: true,
    },
  },
  aiSession: {
    id: "",
    paperId: null,
    updatedAt: 0,
  },
  papers: [],
  selectedIds: new Set(),
  currentStage: "rough",
  currentTemplateId: null,
  editingPaperId: null,
  autoCreateMd: true,
  filters: {
    keyword: "",
    stage: "",
    priority: "",
    category: "",
    relationType: "",
  },
};

const app = {
  homeEl: document.getElementById("home"),
  entryEl: document.getElementById("entry"),
  libraryEl: document.getElementById("library"),
  settingsEl: document.getElementById("settings"),
  tabEls: document.querySelectorAll(".tab"),
  themeBtn: document.getElementById("themeToggle"),
};

function escapeHtml(str = "") {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function enumOptions(groupKey) {
  return state.enums[groupKey]?.options?.filter((item) => item.isActive) || [];
}

function showModal({ title, text, type = "success" }) {
  const old = document.getElementById("globalModal");
  if (old) old.remove();

  const wrap = document.createElement("div");
  wrap.id = "globalModal";
  wrap.className = "modal-backdrop";
  wrap.innerHTML = `
    <div class="modal">
      <h3>${escapeHtml(title)}</h3>
      <div class="muted">${escapeHtml(text)}</div>
      <div class="row" style="margin-top: 14px; justify-content:flex-end;">
        <button class="btn ${type === "success" ? "success" : "primary"}" id="modalOkBtn">我知道了</button>
      </div>
    </div>
  `;

  document.body.appendChild(wrap);
  const close = () => wrap.remove();
  wrap.querySelector("#modalOkBtn").onclick = close;
  wrap.onclick = (e) => {
    if (e.target === wrap) close();
  };
}

function askConfirm({ title, text, confirmText = "确认", cancelText = "取消", type = "primary" }) {
  return new Promise((resolve) => {
    const old = document.getElementById("globalModal");
    if (old) old.remove();

    const wrap = document.createElement("div");
    wrap.id = "globalModal";
    wrap.className = "modal-backdrop";
    wrap.innerHTML = `
      <div class="modal">
        <h3>${escapeHtml(title)}</h3>
        <div class="muted">${escapeHtml(text)}</div>
        <div class="row" style="margin-top: 14px; justify-content:flex-end;">
          <button class="btn" id="modalCancelBtn">${escapeHtml(cancelText)}</button>
          <button class="btn ${escapeHtml(type)}" id="modalConfirmBtn">${escapeHtml(confirmText)}</button>
        </div>
      </div>
    `;

    const close = (accepted) => {
      wrap.remove();
      resolve(Boolean(accepted));
    };

    document.body.appendChild(wrap);
    wrap.querySelector("#modalCancelBtn").onclick = () => close(false);
    wrap.querySelector("#modalConfirmBtn").onclick = () => close(true);
    wrap.onclick = (e) => {
      if (e.target === wrap) close(false);
    };
  });
}

function currentStageTemplates() {
  if (!state.templatesPayload) return [];
  return state.currentStage === "deep" ? state.templatesPayload.deepTemplates : state.templatesPayload.roughTemplates;
}

function currentTemplate() {
  return state.templatesById.get(Number(state.currentTemplateId)) || null;
}

function ensureTemplateSelected() {
  const list = currentStageTemplates();
  if (list.length === 0) {
    state.currentTemplateId = null;
    return;
  }
  if (!list.some((item) => Number(item.id) === Number(state.currentTemplateId))) {
    state.currentTemplateId = list[0].id;
  }
}

function buildFieldInput(field, value = "") {
  const v = escapeHtml(value || "");
  if (field.type.startsWith("enum:")) {
    const groupKey = field.type.split(":")[1];
    const options = enumOptions(groupKey)
      .map((op) => `<option value="${escapeHtml(op.value)}" ${op.value === value ? "selected" : ""}>${escapeHtml(op.label)}</option>`)
      .join("");
    return `<select data-field-key="${field.key}"><option value="">请选择</option>${options}</select>`;
  }
  if (field.type === "textarea") {
    return `<textarea data-field-key="${field.key}" placeholder="${escapeHtml(field.label)}">${v}</textarea>`;
  }
  return `<input data-field-key="${field.key}" value="${v}" placeholder="${escapeHtml(field.label)}" />`;
}

function collectAiTargetFieldKeys() {
  const template = currentTemplate();
  const blockedSet = new Set(state.settings.ai?.blockedFieldKeys || []);
  return (template?.fields || []).map((field) => field.key).filter((key) => key && !blockedSet.has(key));
}

function isAiBlockedField(fieldKey) {
  const blockedSet = new Set(state.settings.ai?.blockedFieldKeys || []);
  return blockedSet.has(String(fieldKey || "").trim());
}

function resetAiSessionLocal() {
  state.aiSession = { id: "", paperId: null, updatedAt: 0 };
}

async function ensureAiFullPdfConsentIfNeeded(paperId) {
  const sameSession = state.aiSession.id && Number(state.aiSession.paperId) === Number(paperId);
  if (sameSession) return true;
  const accepted = await askConfirm({
    title: "确认发送全文给 AI",
    text: "你将把该论文全文发送给第三方 AI 服务。系统不会自动保存字段，请逐条确认后再保存。",
    confirmText: "同意并继续",
    cancelText: "取消",
    type: "primary",
  });
  return accepted;
}

function normalizeAiSourceLabel(result) {
  if (result?.warnings?.length) return `AI建议（含警告：${result.warnings.join("；")}）`;
  return "AI建议";
}

async function runFieldAiSuggest({ paperId, fieldKey }) {
  if (!paperId) throw new Error("请先保存记录后再调用 AI 建议");
  if (!state.settings.ai?.enabled) throw new Error("请先到设置页启用 AI");
  if (isAiBlockedField(fieldKey)) throw new Error("该字段已被策略设为人工填写，不支持自动补全");

  const paper = getPaperById(Number(paperId));
  if (state.settings.ai?.requirePdf && !paper?.pdfPath) {
    throw new Error("当前策略要求先上传/绑定PDF，才能执行AI生成");
  }

  const consentOk = await ensureAiFullPdfConsentIfNeeded(paperId);
  if (!consentOk) throw new Error("已取消 AI 分析");

  const result = await api.aiSuggest({
    paperId,
    targetFieldKeys: [fieldKey],
    mode: "combined",
    pdfPolicy: state.settings.ai?.pdfPolicy || "full_pdf",
    consent: { accepted: true },
    aiSessionId:
      state.aiSession.id && Number(state.aiSession.paperId) === Number(paperId)
        ? state.aiSession.id
        : "",
  });

  if (result?.aiSessionId) {
    state.aiSession = { id: result.aiSessionId, paperId: Number(paperId), updatedAt: Date.now() };
  }

  return result;
}

async function applyFieldSuggestionWithConfirm({ fieldKey, suggestedValue }) {
  const input = app.entryEl.querySelector(`[data-field-key="${fieldKey}"]`);
  if (!input) throw new Error(`字段不存在: ${fieldKey}`);

  const accepted = await askConfirm({
    title: `应用字段建议：${fieldKey}`,
    text: `建议值：${suggestedValue || "(空)"}`,
    confirmText: "应用",
    cancelText: "跳过",
    type: "success",
  });
  if (!accepted) return false;

  input.value = suggestedValue || "";
  return true;
}

async function runBatchAnalyzeSelected(messageEl) {
  const ids = [...state.selectedIds];
  if (ids.length === 0) throw new Error("请先在记录中心勾选记录");
  if (!state.settings.ai?.enabled) throw new Error("请先到设置页启用 AI");

  const accepted = await askConfirm({
    title: "确认批量 AI 分析",
    text: `即将对 ${ids.length} 条记录发送全文进行分析，完成后你可逐条确认是否写回。`,
    confirmText: "开始分析",
    cancelText: "取消",
  });
  if (!accepted) throw new Error("已取消批量分析");

  if (state.settings.ai?.requirePdf) {
    const missingPdfIds = ids.filter((id) => {
      const paper = getPaperById(id);
      return !paper?.pdfPath;
    });
    if (missingPdfIds.length > 0) {
      throw new Error(`当前策略要求先绑定PDF。缺失PDF记录ID: ${missingPdfIds.join(", ")}`);
    }
  }

  messageEl.textContent = "批量分析任务创建中...";
  const targetFieldKeys = collectAiTargetFieldKeys();
  const created = await api.batchAnalyze({
    paperIds: ids,
    targetFieldKeys,
    mode: "combined",
    pdfPolicy: state.settings.ai?.pdfPolicy || "full_pdf",
    consent: { accepted: true },
  });

  const batchJobId = created.batchJobId;
  if (!batchJobId) throw new Error("批量任务创建失败");

  let retries = 0;
  while (retries < 120) {
    // eslint-disable-next-line no-await-in-loop
    const job = await api.getAiJob(batchJobId);
    const total = Number(job?.result?.total || ids.length);
    const done = Number(job?.result?.done || 0);
    const failed = Number(job?.result?.failed || 0);
    messageEl.textContent = `批量分析中：${done}/${total}，失败 ${failed}`;

    if (["done", "partial", "failed"].includes(job.status)) {
      const doneItems = (job.items || []).filter((item) => item.status === "done");
      for (const item of doneItems) {
        const paper = getPaperById(item.paperId);
        const suggestedValues = item.result?.suggestedValues || {};
        if (!paper || Object.keys(suggestedValues).length === 0) continue;

        const applyAccepted = await askConfirm({
          title: `应用建议到 #${paper.id}`,
          text: `${paper.title || "未命名"}：是否应用本条 AI 建议？`,
          confirmText: "应用",
          cancelText: "跳过",
          type: "success",
        });
        if (!applyAccepted) continue;

        // eslint-disable-next-line no-await-in-loop
        await api.updatePaper(paper.id, {
          fieldValues: {
            ...(paper.fieldValues || {}),
            ...suggestedValues,
          },
          source: "ai_applied",
        });
      }

      await refreshPapers();
      messageEl.textContent = `批量分析完成：成功 ${doneItems.length} 条，失败 ${failed} 条`;
      return;
    }

    retries += 1;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 1200));
  }

  throw new Error("批量分析超时，请稍后在记录中心重试");
}

function setActiveTab(tabName) {
  app.tabEls.forEach((t) => t.classList.toggle("active", t.dataset.tab === tabName));
  ["home", "entry", "library", "settings"].forEach((name) => {
    document.getElementById(name).classList.toggle("active", name === tabName);
  });
}

function renderTabs() {
  app.tabEls.forEach((tab) => {
    tab.onclick = () => {
      const selected = tab.dataset.tab;
      setActiveTab(selected);
      if (selected === "home") renderHome();
      if (selected === "entry") renderEntry();
      if (selected === "library") renderLibrary();
      if (selected === "settings") renderSettings();
    };
  });
}

function collectEntryPayload() {
  const payload = {
    stage: state.currentStage,
    templateId: state.currentTemplateId ? Number(state.currentTemplateId) : null,
    autoCreateMd: Boolean(state.autoCreateMd),
    fieldValues: {},
    source: state.aiSession.id ? "ai_suggested" : "manual",
  };

  BASE_ENTRY_FIELDS.forEach(([key]) => {
    const input = app.entryEl.querySelector(`[data-entry-key="${key}"]`);
    payload[key] = input ? input.value.trim() : "";
  });

  const template = currentTemplate();
  (template?.fields || []).forEach((field) => {
    const input = app.entryEl.querySelector(`[data-field-key="${field.key}"]`);
    payload.fieldValues[field.key] = input ? input.value.trim() : "";
  });

  payload.priority = payload.fieldValues.priority || payload.fieldValues.worth_deep_read || "";
  payload.category = payload.fieldValues.category || "";
  payload.relationType = payload.fieldValues.relation_type || "";
  return payload;
}

function fillEntryForm(paper) {
  if (!paper) return;
  if (state.aiSession.id && Number(state.aiSession.paperId) !== Number(paper.id)) {
    resetAiSessionLocal();
  }
  state.currentStage = paper.stage || "rough";
  state.currentTemplateId = paper.templateId || state.currentTemplateId;
  renderEntry();

  BASE_ENTRY_FIELDS.forEach(([key]) => {
    const input = app.entryEl.querySelector(`[data-entry-key="${key}"]`);
    if (input) input.value = paper[key] || "";
  });

  const template = currentTemplate();
  (template?.fields || []).forEach((field) => {
    const input = app.entryEl.querySelector(`[data-field-key="${field.key}"]`);
    if (input) input.value = paper.fieldValues?.[field.key] || "";
  });
}

function resetEntryAfterSave() {
  state.editingPaperId = null;
  state.autoCreateMd = true;
  resetAiSessionLocal();
  renderEntry();
}

function renderEntry() {
  ensureTemplateSelected();
  const templates = currentStageTemplates();
  const template = currentTemplate();

  const baseSurvey = BASE_ENTRY_FIELDS
    .map(
      ([key, label, , required]) => `
      <div class="survey-item ${required ? "required" : ""}">
        <label>${escapeHtml(label)}</label>
        <input data-entry-key="${key}" placeholder="请填写${escapeHtml(label)}" />
      </div>
    `
    )
    .join("");

  const dynamicSurvey = (template?.fields || [])
    .map((field) => {
      const blocked = isAiBlockedField(field.key);
      return `
      <div class="survey-item ${field.required ? "required" : ""}">
        <div class="row-between" style="margin-bottom:6px;">
          <label style="margin:0;">${escapeHtml(field.label)}</label>
          <button class="btn small" data-ai-field="${escapeHtml(field.key)}" ${blocked ? "disabled" : ""}>${blocked ? "人工填写" : "AI生成"}</button>
        </div>
        ${buildFieldInput(field, "")}
      </div>
    `;
    })
    .join("");

  app.entryEl.innerHTML = `
    <div class="card">
      <div class="row-between">
        <div>
          <div class="card-title">文献录入</div>
          <div class="muted">保存后将弹窗提示并自动清空表单</div>
        </div>
        ${
          state.editingPaperId
            ? `<div class="row"><span class="badge">正在编辑记录 #${state.editingPaperId}</span><button class="btn small" id="exitEditModeBtn">退出编辑</button></div>`
            : `<span class="muted">新建记录</span>`
        }
      </div>

      <div class="row" style="margin-top:10px;">
        <div class="radio-pill">
          <label><input type="radio" name="stage" value="rough" ${state.currentStage === "rough" ? "checked" : ""}/>粗读</label>
          <label><input type="radio" name="stage" value="deep" ${state.currentStage === "deep" ? "checked" : ""}/>精读</label>
        </div>

        <select id="templateSelect" style="min-width:240px;">
          ${templates
            .map(
              (t) => `<option value="${t.id}" ${Number(t.id) === Number(state.currentTemplateId) ? "selected" : ""}>${escapeHtml(t.name)}</option>`
            )
            .join("")}
        </select>

        <label style="display:flex;align-items:center;gap:6px;margin:0;">
          <input type="checkbox" id="autoCreateMd" ${state.autoCreateMd ? "checked" : ""} style="width:auto;" />
          自动创建MD笔记
        </label>

        <button class="btn" id="createMdNowBtn">立即创建MD并填入路径</button>
      </div>
    </div>

    <div class="card">
      <div class="drop-zone" id="pdfDropZone">
        拖入 PDF 自动读取元数据（仅本地解析），或
        <input type="file" id="pdfInput" accept="application/pdf" />
      </div>
      <div class="muted" style="margin-top:8px;">当前AI策略：${state.settings.ai?.requirePdf ? "必须先绑定PDF才允许生成" : "允许无PDF生成（仅基于元数据/笔记）"}</div>
      <div class="message" id="pdfMessage"></div>
    </div>

    <div class="card">
      <div class="survey">
        ${baseSurvey}
        ${dynamicSurvey || `<div class="muted">当前模板暂无字段，请去设置页新增模板字段。</div>`}
      </div>

      <div class="row" style="margin-top: 14px;">
        <button class="btn primary" id="savePaperBtn">保存记录</button>
        <button class="btn" id="clearEntryBtn">清空表单</button>
        <button class="btn" id="mockAiBtn">AI补全空字段</button>
        <button class="btn" id="resetAiSessionBtn">重置AI会话</button>
      </div>
      <div class="message" id="entryMessage"></div>
    </div>
  `;

  app.entryEl.querySelectorAll("input[name=stage]").forEach((radio) => {
    radio.onchange = () => {
      state.currentStage = radio.value;
      ensureTemplateSelected();
      resetAiSessionLocal();
      renderEntry();
    };
  });

  const templateSelect = app.entryEl.querySelector("#templateSelect");
  if (templateSelect) {
    templateSelect.onchange = () => {
      state.currentTemplateId = Number(templateSelect.value);
      resetAiSessionLocal();
      renderEntry();
    };
  }

  const autoMd = app.entryEl.querySelector("#autoCreateMd");
  if (autoMd) {
    autoMd.onchange = () => {
      state.autoCreateMd = autoMd.checked;
    };
  }

  app.entryEl.querySelector("#createMdNowBtn").onclick = async () => {
    try {
      const title = app.entryEl.querySelector('[data-entry-key="title"]')?.value || "未命名论文";
      const year = app.entryEl.querySelector('[data-entry-key="year"]')?.value || "";
      const result = await api.createMd({ title, year });
      const mdInput = app.entryEl.querySelector('[data-entry-key="mdPath"]');
      if (mdInput) mdInput.value = result.mdPath || "";
      showModal({ title: "MD已创建", text: "已自动创建本地笔记文件，并填入路径。" });
    } catch (error) {
      showModal({ title: "创建失败", text: error.message, type: "error" });
    }
  };

  bindPdfParse();

  app.entryEl.querySelector("#savePaperBtn").onclick = async () => {
    try {
      const payload = collectEntryPayload();
      if (!payload.title) throw new Error("论文题目必填");
      if (state.settings.ai?.requirePdf && !payload.pdfPath) {
        throw new Error("当前策略要求先上传PDF并保存路径后，才能进行AI生成");
      }
      let savedPaperId = null;
      if (state.editingPaperId) {
        const updated = await api.updatePaper(state.editingPaperId, payload);
        savedPaperId = updated?.id || state.editingPaperId;
      } else {
        const created = await api.createPaper(payload);
        savedPaperId = created?.id || null;
      }
      await refreshPapers();
      showModal({ title: "保存成功", text: "记录已保存，并已自动清空当前表单。" });
      resetEntryAfterSave();
    } catch (error) {
      showModal({ title: "保存失败", text: error.message, type: "error" });
    }
  };

  app.entryEl.querySelector("#clearEntryBtn").onclick = () => {
    state.editingPaperId = null;
    resetAiSessionLocal();
    renderEntry();
  };

  const exitEditBtn = app.entryEl.querySelector("#exitEditModeBtn");
  if (exitEditBtn) {
    exitEditBtn.onclick = () => {
      state.editingPaperId = null;
      resetAiSessionLocal();
      renderEntry();
    };
  };

  app.entryEl.querySelectorAll("[data-ai-field]").forEach((btn) => {
    btn.onclick = async () => {
      const fieldKey = btn.dataset.aiField;
      try {
        btn.disabled = true;
        btn.textContent = "生成中...";
        const result = await runFieldAiSuggest({ paperId: state.editingPaperId, fieldKey });
        const suggestedValue = result.suggestedValues?.[fieldKey] || "";
        if (!suggestedValue) throw new Error("当前字段未返回可用建议");
        const applied = await applyFieldSuggestionWithConfirm({ fieldKey, suggestedValue });
        if (!applied) {
          showModal({ title: "已跳过", text: "你已选择不应用该字段建议。", type: "primary" });
          return;
        }
        const contextText = result?.contextMeta
          ? `上下文：PDF文件=${result.contextMeta.hasPdfFile ? "有" : "无"}，已用PDF全文=${result.contextMeta.usedPdfText ? "是" : "否"}，已用笔记=${result.contextMeta.usedNoteContent ? "是" : "否"}`
          : "";
        showModal({
          title: "字段建议已应用",
          text: `${normalizeAiSourceLabel(result)}，请手动保存后生效。${contextText ? `\n${contextText}` : ""}`,
        });
      } catch (error) {
        showModal({ title: "AI建议失败", text: error.message, type: "error" });
      } finally {
        btn.disabled = false;
        btn.textContent = "AI生成";
      }
    };
  });

  app.entryEl.querySelector("#mockAiBtn").onclick = async () => {
    try {
      if (!state.editingPaperId) throw new Error("请先保存记录后再调用AI建议");
      const paper = getPaperById(Number(state.editingPaperId));
      if (state.settings.ai?.requirePdf && !paper?.pdfPath) {
        throw new Error("当前策略要求先上传/绑定PDF，才能执行AI补全");
      }
      const targetFieldKeys = collectAiTargetFieldKeys();
      if (targetFieldKeys.length === 0) throw new Error("当前模板没有可分析字段（可能已被设为人工填写）");
      const consentAccepted = await ensureAiFullPdfConsentIfNeeded(state.editingPaperId);
      if (!consentAccepted) throw new Error("已取消 AI 分析");
      const result = await api.aiSuggest({
        paperId: state.editingPaperId,
        targetFieldKeys,
        mode: "combined",
        pdfPolicy: state.settings.ai?.pdfPolicy || "full_pdf",
        consent: { accepted: true },
        aiSessionId:
          state.aiSession.id && Number(state.aiSession.paperId) === Number(state.editingPaperId)
            ? state.aiSession.id
            : "",
      });
      if (result?.aiSessionId) {
        state.aiSession = { id: result.aiSessionId, paperId: Number(state.editingPaperId), updatedAt: Date.now() };
      }
      let changed = 0;
      Object.entries(result.suggestedValues || {}).forEach(([key, value]) => {
        const input = app.entryEl.querySelector(`[data-field-key="${key}"]`);
        if (input && !input.value.trim()) {
          input.value = value;
          changed += 1;
        }
      });
      showModal({
        title: "AI建议已填入",
        text: changed > 0 ? `已填入 ${changed} 个空字段，仍需你手动点击保存。` : "没有可填入的空字段。",
      });
    } catch (error) {
      showModal({ title: "AI建议失败", text: error.message, type: "error" });
    }
  };

  app.entryEl.querySelector("#resetAiSessionBtn").onclick = async () => {
    try {
      if (state.aiSession.id) {
        await api.resetAiSession(state.aiSession.id);
      }
      resetAiSessionLocal();
      showModal({ title: "会话已重置", text: "下次 AI 生成将重新确认并建立上下文。", type: "primary" });
    } catch (error) {
      showModal({ title: "重置失败", text: error.message, type: "error" });
    }
  };
}

function bindPdfParse() {
  const drop = app.entryEl.querySelector("#pdfDropZone");
  const input = app.entryEl.querySelector("#pdfInput");
  const msgEl = app.entryEl.querySelector("#pdfMessage");

  async function parse(file) {
    try {
      msgEl.textContent = "正在解析 PDF...";
      const result = await api.parsePdf(file);
      const meta = result.metadata || {};

      const titleInput = app.entryEl.querySelector('[data-entry-key="title"]');
      const yearInput = app.entryEl.querySelector('[data-entry-key="year"]');
      const authorsInput = app.entryEl.querySelector('[data-entry-key="authors"]');
      const linkInput = app.entryEl.querySelector('[data-entry-key="link"]');
      const pdfPathInput = app.entryEl.querySelector('[data-entry-key="pdfPath"]');

      if (titleInput && !titleInput.value.trim()) titleInput.value = meta.title || "";
      if (yearInput && !yearInput.value.trim()) yearInput.value = meta.year || "";
      if (authorsInput && !authorsInput.value.trim()) authorsInput.value = meta.authors || "";
      if (linkInput && !linkInput.value.trim() && meta.doi) linkInput.value = `https://doi.org/${meta.doi}`;
      if (pdfPathInput && result?.pdfPath) pdfPathInput.value = result.pdfPath;

      if (state.editingPaperId && result?.pdfPath) {
        await api.updatePaper(state.editingPaperId, { pdfPath: result.pdfPath });
        await refreshPapers();
      }

      if (state.aiSession.id) {
        try {
          await api.resetAiSession(state.aiSession.id);
        } catch (_err) {
          // ignore network reset errors and still clear local session
        }
      }
      resetAiSessionLocal();

      msgEl.textContent = `解析完成：${meta.title || "未识别标题"}（已绑定PDF路径，并重置AI会话）`;
    } catch (error) {
      msgEl.textContent = `解析失败：${error.message}`;
    }
  }

  input.onchange = () => {
    const file = input.files?.[0];
    if (file) parse(file);
  };

  ["dragenter", "dragover"].forEach((evt) => {
    drop.addEventListener(evt, (e) => {
      e.preventDefault();
      drop.classList.add("dragging");
    });
  });
  ["dragleave", "drop"].forEach((evt) => {
    drop.addEventListener(evt, (e) => {
      e.preventDefault();
      drop.classList.remove("dragging");
    });
  });
  drop.addEventListener("drop", (e) => {
    const file = e.dataTransfer?.files?.[0];
    if (file && file.type === "application/pdf") parse(file);
  });
}

function getPaperById(id) {
  return state.papers.find((paper) => paper.id === id);
}

function formatDateTime(isoText) {
  if (!isoText) return "";
  const date = new Date(isoText);
  if (Number.isNaN(date.getTime())) return isoText;
  return date.toLocaleString("zh-CN", { hour12: false });
}

function paperPriority(paper) {
  return paper.priority || paper.fieldValues?.priority || paper.fieldValues?.worth_deep_read || "";
}

function getRecentPapers(limit = 5) {
  return state.papers.slice(0, limit);
}

function getDeepCandidates(limit = 5) {
  const highPriority = ["A 必读", "B 可读"];
  return state.papers
    .filter((paper) => paper.stage === "rough")
    .filter((paper) => {
      const priority = paperPriority(paper);
      if (!priority) return false;
      return highPriority.some((token) => priority.includes(token));
    })
    .slice(0, limit);
}

function jumpToEditPaper(id) {
  const paper = getPaperById(id);
  if (!paper) return;
  state.editingPaperId = id;
  setActiveTab("entry");
  fillEntryForm(paper);
}

async function exportByIds(ids, messageEl) {
  const targetEl = messageEl || null;
  try {
    if (!Array.isArray(ids) || ids.length === 0) throw new Error("暂无可导出的记录");
    const result = await api.exportPapers({ selectedIds: ids, viewMode: "deep" });
    window.open(result.downloadUrl, "_blank");
    if (targetEl) targetEl.textContent = "导出成功";
  } catch (error) {
    if (targetEl) targetEl.textContent = `导出失败：${error.message}`;
    else throw error;
  }
}

async function exportByFilters(messageEl) {
  const targetEl = messageEl || null;
  try {
    const result = await api.exportPapers({ selectedIds: [], viewMode: "deep", filters: state.filters });
    window.open(result.downloadUrl, "_blank");
    if (targetEl) targetEl.textContent = "导出成功";
  } catch (error) {
    if (targetEl) targetEl.textContent = `导出失败：${error.message}`;
    else throw error;
  }
}

function renderHome() {
  const recentPapers = getRecentPapers(5);
  const candidatePapers = getDeepCandidates(5);
  const totalCount = state.papers.length;
  const deepCount = state.papers.filter((paper) => paper.stage === "deep").length;
  const roughCount = totalCount - deepCount;
  const gaugeMax = Math.max(20, Math.ceil(totalCount / 10) * 10);
  const gaugePercent = Math.max(0, Math.min(100, Math.round((totalCount / gaugeMax) * 100)));
  const gaugeDeg = Math.round((gaugePercent / 100) * 180 - 90);

  app.homeEl.innerHTML = `
    <div class="card dashboard-card gauge-card">
      <div class="row-between">
        <div>
          <div class="card-title">论文数量仪表盘</div>
          <div class="muted">总量进度（参考上限 ${gaugeMax}）</div>
        </div>
        <span class="badge">总计 ${totalCount} 篇</span>
      </div>

      <div class="gauge-wrap">
        <div class="gauge" style="--gauge-progress:${gaugePercent}; --gauge-needle-deg:${gaugeDeg}deg;">
          <div class="gauge-center">
            <div class="gauge-value">${totalCount}</div>
            <div class="muted">Papers</div>
          </div>
          <div class="gauge-needle"></div>
        </div>

        <div class="gauge-stats">
          <div class="gauge-stat">
            <div class="muted">粗读</div>
            <strong>${roughCount}</strong>
          </div>
          <div class="gauge-stat">
            <div class="muted">精读</div>
            <strong>${deepCount}</strong>
          </div>
          <div class="gauge-stat">
            <div class="muted">候选率</div>
            <strong>${totalCount === 0 ? "0%" : `${Math.round((candidatePapers.length / totalCount) * 100)}%`}</strong>
          </div>
        </div>
      </div>
    </div>

    <div class="dashboard-grid">
      <div class="card dashboard-card">
        <div class="row-between">
          <div>
            <div class="card-title">最近阅读</div>
            <div class="muted">按最近更新时间展示前 5 条</div>
          </div>
          <button class="btn small" id="homeToLibraryRecentBtn">查看全部</button>
        </div>

        <div class="dashboard-list" style="margin-top:10px;">
          ${
            recentPapers.length === 0
              ? `<div class="muted">暂无记录</div>`
              : recentPapers
                  .map(
                    (paper) => `
                    <div class="dashboard-item">
                      <div>
                        <div class="dashboard-item-title">${escapeHtml(paper.title || "未命名")}</div>
                        <div class="muted">${paper.stage === "deep" ? "精读" : "粗读"} · ${escapeHtml(paperPriority(paper)) || "无优先级"} · ${escapeHtml(formatDateTime(paper.updatedAt))}</div>
                      </div>
                      <button class="btn small" data-home-action="edit" data-id="${paper.id}">编辑</button>
                    </div>
                  `
                  )
                  .join("")
          }
        </div>
      </div>

      <div class="card dashboard-card">
        <div class="row-between">
          <div>
            <div class="card-title">精读候选</div>
            <div class="muted">粗读阶段且优先级为 A/B 的记录</div>
          </div>
          <button class="btn small" id="homeToLibraryCandidateBtn">查看全部</button>
        </div>

        <div class="dashboard-list" style="margin-top:10px;">
          ${
            candidatePapers.length === 0
              ? `<div class="muted">暂无候选记录</div>`
              : candidatePapers
                  .map(
                    (paper) => `
                    <div class="dashboard-item">
                      <div>
                        <div class="dashboard-item-title">${escapeHtml(paper.title || "未命名")}</div>
                        <div class="muted">${escapeHtml(paperPriority(paper)) || "无优先级"} · ${escapeHtml(paper.relationType || paper.fieldValues?.relation_type || "未设置关系")}</div>
                      </div>
                      <div class="row">
                        <button class="btn small" data-home-action="edit" data-id="${paper.id}">编辑</button>
                        <button class="btn small success" data-home-action="upgrade" data-id="${paper.id}">升级精读</button>
                      </div>
                    </div>
                  `
                  )
                  .join("")
          }
        </div>
      </div>
    </div>

    <div class="card dashboard-card">
      <div class="card-title">导出快捷入口</div>
      <div class="muted">一键导出最近阅读、精读候选或当前筛选结果</div>
      <div class="row" style="margin-top:12px;">
        <button class="btn primary" id="exportRecentBtn">导出最近阅读</button>
        <button class="btn" id="exportCandidatesBtn">导出精读候选</button>
        <button class="btn" id="exportFilteredBtn">导出当前筛选结果</button>
      </div>
      <div class="message" id="homeExportMessage"></div>
    </div>
  `;

  app.homeEl.querySelector("#homeToLibraryRecentBtn").onclick = () => {
    setActiveTab("library");
    renderLibrary();
  };

  app.homeEl.querySelector("#homeToLibraryCandidateBtn").onclick = () => {
    setActiveTab("library");
    renderLibrary();
  };

  app.homeEl.querySelectorAll('[data-home-action="edit"]').forEach((btn) => {
    btn.onclick = () => {
      const id = Number(btn.dataset.id);
      jumpToEditPaper(id);
    };
  });

  app.homeEl.querySelectorAll('[data-home-action="upgrade"]').forEach((btn) => {
    btn.onclick = async () => {
      const id = Number(btn.dataset.id);
      try {
        const updated = await api.upgradePaper(id);
        if (updated?.templateId) state.currentTemplateId = updated.templateId;
        await refreshPapers();
        renderHome();
      } catch (error) {
        showModal({ title: "升级失败", text: error.message, type: "error" });
      }
    };
  });

  const homeMessageEl = app.homeEl.querySelector("#homeExportMessage");

  app.homeEl.querySelector("#exportRecentBtn").onclick = async () => {
    await exportByIds(recentPapers.map((paper) => paper.id), homeMessageEl);
  };

  app.homeEl.querySelector("#exportCandidatesBtn").onclick = async () => {
    await exportByIds(candidatePapers.map((paper) => paper.id), homeMessageEl);
  };

  app.homeEl.querySelector("#exportFilteredBtn").onclick = async () => {
    await exportByFilters(homeMessageEl);
  };
}

async function refreshPapers() {
  const list = await api.listPapers(state.filters);
  state.papers = list.items || [];
  renderLibrary();
}

function renderLibrary() {
  const priorityOptions = enumOptions("reading_priority");
  const categoryOptions = enumOptions("related_category");
  const relationOptions = enumOptions("relation_type");

  app.libraryEl.innerHTML = `
    <div class="card">
      <div class="row-between">
        <strong>记录中心</strong>
        <span class="muted">共 ${state.papers.length} 条</span>
      </div>
      <div class="grid-3" style="margin-top: 10px;">
        <div>
          <label>关键词</label>
          <input id="filterKeyword" value="${escapeHtml(state.filters.keyword)}" placeholder="标题/作者/会议" />
        </div>
        <div>
          <label>阅读阶段</label>
          <select id="filterStage">
            <option value="">全部</option>
            <option value="rough" ${state.filters.stage === "rough" ? "selected" : ""}>粗读</option>
            <option value="deep" ${state.filters.stage === "deep" ? "selected" : ""}>精读</option>
          </select>
        </div>
        <div>
          <label>精读优先级</label>
          <select id="filterPriority">
            <option value="">全部</option>
            ${priorityOptions.map((o) => `<option value="${escapeHtml(o.value)}" ${state.filters.priority === o.value ? "selected" : ""}>${escapeHtml(o.label)}</option>`).join("")}
          </select>
        </div>
        <div>
          <label>类别</label>
          <select id="filterCategory">
            <option value="">全部</option>
            ${categoryOptions.map((o) => `<option value="${escapeHtml(o.value)}" ${state.filters.category === o.value ? "selected" : ""}>${escapeHtml(o.label)}</option>`).join("")}
          </select>
        </div>
        <div>
          <label>和我的关系</label>
          <select id="filterRelationType">
            <option value="">全部</option>
            ${relationOptions.map((o) => `<option value="${escapeHtml(o.value)}" ${state.filters.relationType === o.value ? "selected" : ""}>${escapeHtml(o.label)}</option>`).join("")}
          </select>
        </div>
      </div>
      <div class="row" style="margin-top: 12px;">
        <button class="btn" id="applyFiltersBtn">应用筛选</button>
        <button class="btn" id="resetFiltersBtn">重置筛选</button>
        <button class="btn" id="selectAllBtn">全选</button>
        <button class="btn" id="clearSelectBtn">清空选择</button>
        <button class="btn primary" id="exportSelectedBtn">导出所选</button>
        <button class="btn" id="exportAllBtn">导出筛选结果</button>
        <button class="btn" id="aiBatchAnalyzeBtn">AI分析所选</button>
      </div>
      <div class="message" id="libraryMessage"></div>
    </div>

    <div class="card table-wrap">
      <table>
        <thead>
          <tr>
            <th></th>
            <th>ID</th>
            <th>阶段</th>
            <th>模板</th>
            <th>题目</th>
            <th>年份</th>
            <th>优先级</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          ${state.papers
            .map((paper) => {
              const templateName = state.templatesById.get(Number(paper.templateId))?.name || "默认模板";
              return `
              <tr>
                <td><input type="checkbox" data-paper-select="${paper.id}" ${state.selectedIds.has(paper.id) ? "checked" : ""}></td>
                <td>${paper.id}</td>
                <td><span class="badge">${paper.stage === "deep" ? "精读" : "粗读"}</span></td>
                <td>${escapeHtml(templateName)}</td>
                <td title="${escapeHtml(paper.title)}">${escapeHtml((paper.title || "").slice(0, 36))}</td>
                <td>${escapeHtml(paper.year || "")}</td>
                <td>${escapeHtml(paper.priority || paper.fieldValues?.priority || "")}</td>
                <td>
                  <div class="row">
                    <button class="btn small" data-action="edit" data-id="${paper.id}">编辑</button>
                    <button class="btn small" data-action="upgrade" data-id="${paper.id}">升级精读</button>
                    <button class="btn small" data-action="open-md" data-id="${paper.id}">打开MD</button>
                    <button class="btn small danger" data-action="delete" data-id="${paper.id}">删除</button>
                  </div>
                </td>
              </tr>
            `;
            })
            .join("")}
        </tbody>
      </table>
    </div>
  `;

  app.libraryEl.querySelector("#applyFiltersBtn").onclick = async () => {
    state.filters.keyword = app.libraryEl.querySelector("#filterKeyword").value.trim();
    state.filters.stage = app.libraryEl.querySelector("#filterStage").value;
    state.filters.priority = app.libraryEl.querySelector("#filterPriority").value;
    state.filters.category = app.libraryEl.querySelector("#filterCategory").value;
    state.filters.relationType = app.libraryEl.querySelector("#filterRelationType").value;
    await refreshPapers();
  };

  app.libraryEl.querySelector("#resetFiltersBtn").onclick = async () => {
    state.filters = { keyword: "", stage: "", priority: "", category: "", relationType: "" };
    await refreshPapers();
  };

  app.libraryEl.querySelector("#selectAllBtn").onclick = () => {
    state.papers.forEach((paper) => state.selectedIds.add(paper.id));
    renderLibrary();
  };

  app.libraryEl.querySelector("#clearSelectBtn").onclick = () => {
    state.selectedIds.clear();
    renderLibrary();
  };

  app.libraryEl.querySelector("#exportSelectedBtn").onclick = async () => {
    await exportByIds([...state.selectedIds], app.libraryEl.querySelector("#libraryMessage"));
  };

  app.libraryEl.querySelector("#exportAllBtn").onclick = async () => {
    await exportByFilters(app.libraryEl.querySelector("#libraryMessage"));
  };

  app.libraryEl.querySelector("#aiBatchAnalyzeBtn").onclick = async () => {
    try {
      await runBatchAnalyzeSelected(app.libraryEl.querySelector("#libraryMessage"));
    } catch (error) {
      app.libraryEl.querySelector("#libraryMessage").textContent = `批量AI失败：${error.message}`;
    }
  };

  app.libraryEl.querySelectorAll("[data-paper-select]").forEach((el) => {
    el.onchange = () => {
      const id = Number(el.dataset.paperSelect);
      if (el.checked) state.selectedIds.add(id);
      else state.selectedIds.delete(id);
    };
  });

  app.libraryEl.querySelectorAll("button[data-action]").forEach((btn) => {
    btn.onclick = async () => {
      const id = Number(btn.dataset.id);
      const action = btn.dataset.action;

      if (action === "edit") {
        jumpToEditPaper(id);
        return;
      }

      if (action === "upgrade") {
        try {
          const updated = await api.upgradePaper(id);
          if (updated?.templateId) state.currentTemplateId = updated.templateId;
          await refreshPapers();
        } catch (error) {
          app.libraryEl.querySelector("#libraryMessage").textContent = `升级失败：${error.message}`;
        }
        return;
      }

      if (action === "open-md") {
        try {
          const paper = getPaperById(id);
          if (!paper?.mdPath) throw new Error("该记录未绑定MD路径");
          await api.openMd(paper.mdPath, { title: paper.title, year: paper.year });
        } catch (error) {
          app.libraryEl.querySelector("#libraryMessage").textContent = `打开失败：${error.message}`;
        }
        return;
      }

      if (action === "delete") {
        if (!window.confirm("确认删除该记录？")) return;
        try {
          await api.deletePaper(id);
          state.selectedIds.delete(id);
          await refreshPapers();
        } catch (error) {
          app.libraryEl.querySelector("#libraryMessage").textContent = `删除失败：${error.message}`;
        }
      }
    };
  });
}

function emptyFieldRow(index) {
  return `
    <div class="template-field-row" data-template-field-row="${index}">
      <input placeholder="字段名（如：创新点）" data-k="label" />
      <select data-k="type">
        ${FIELD_TYPES.map((t) => `<option value="${t}">${t}</option>`).join("")}
      </select>
      <label style="display:flex;align-items:center;gap:6px;margin:0;"><input type="checkbox" data-k="required" style="width:auto;"/>必填</label>
      <button class="btn small danger" data-action="remove-row">删除</button>
    </div>
  `;
}

function renderSettings() {
  const groups = Object.values(state.enums);
  const roughTemplates = state.templatesPayload?.roughTemplates || [];
  const deepTemplates = state.templatesPayload?.deepTemplates || [];

  app.settingsEl.innerHTML = `
    <div class="card">
      <div class="card-title">模板设计器（支持多套粗读/精读模板）</div>
      <div class="grid-3">
        <div>
          <label>模板阶段</label>
          <select id="newTemplateKind">
            <option value="rough">粗读</option>
            <option value="deep">精读</option>
          </select>
        </div>
        <div>
          <label>模板名称</label>
          <input id="newTemplateName" placeholder="例如：粗读-视觉方向" />
        </div>
        <div>
          <label>基于粗读模板（仅精读可选）</label>
          <select id="newTemplateBase">
            <option value="">无</option>
            ${roughTemplates.map((t) => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join("")}
          </select>
        </div>
      </div>

      <div style="margin-top:10px;">
        <div class="row-between">
          <strong>字段列表</strong>
          <button class="btn" id="addTemplateFieldBtn">新增字段</button>
        </div>
        <div id="newTemplateFields"></div>
      </div>

      <div class="row" style="margin-top: 12px;">
        <button class="btn primary" id="createTemplateBtn">创建模板</button>
      </div>
    </div>

    <div class="card">
      <div class="card-title">模板管理</div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>ID</th><th>名称</th><th>阶段</th><th>字段数</th><th>操作</th></tr></thead>
          <tbody>
            ${[...roughTemplates, ...deepTemplates]
              .map(
                (t) => `
              <tr data-template-id="${t.id}">
                <td>${t.id}</td>
                <td><input data-edit-name value="${escapeHtml(t.name)}" /></td>
                <td>${t.kind === "deep" ? "精读" : "粗读"}</td>
                <td>${t.fields?.length || 0}</td>
                <td>
                  <div class="row">
                    <button class="btn small" data-action="save-template">保存名称</button>
                    <button class="btn small danger" data-action="delete-template">删除</button>
                  </div>
                </td>
              </tr>
            `
              )
              .join("")}
          </tbody>
        </table>
      </div>
    </div>

    <div class="card">
      <div class="card-title">笔记目录设置</div>
      <div class="grid-2">
        <div>
          <label>MD自动创建目录</label>
          <input id="notesDirInput" value="${escapeHtml(state.settings.notesDir || "")}" placeholder="例如 D:/notes/papers" />
        </div>
      </div>
      <div class="row" style="margin-top:10px;">
        <button class="btn primary" id="saveNotesDirBtn">保存目录</button>
      </div>
    </div>

    <div class="card">
      <div class="card-title">AI 设置（API Key / Base URL 走 .env）</div>
      <div class="grid-3">
        <div>
          <label>启用AI</label>
          <select id="aiEnabledSelect">
            <option value="0" ${state.settings.ai?.enabled ? "" : "selected"}>关闭</option>
            <option value="1" ${state.settings.ai?.enabled ? "selected" : ""}>开启</option>
          </select>
        </div>
        <div>
          <label>Provider</label>
          <input id="aiProviderInput" value="${escapeHtml(state.settings.ai?.provider || "openai_compatible")}" />
        </div>
        <div>
          <label>模型</label>
          <input id="aiModelInput" value="${escapeHtml(state.settings.ai?.model || "gpt-4.1-mini")}" />
        </div>
        <div>
          <label>超时（毫秒）</label>
          <input id="aiTimeoutInput" value="${escapeHtml(String(state.settings.ai?.timeoutMs || 30000))}" />
        </div>
        <div>
          <label>PDF策略</label>
          <select id="aiPdfPolicySelect">
            <option value="full_pdf" ${(state.settings.ai?.pdfPolicy || "full_pdf") === "full_pdf" ? "selected" : ""}>full_pdf</option>
            <option value="metadata_only" ${(state.settings.ai?.pdfPolicy || "full_pdf") === "metadata_only" ? "selected" : ""}>metadata_only</option>
          </select>
        </div>
        <div>
          <label>无PDF禁止生成</label>
          <select id="aiRequirePdfSelect">
            <option value="1" ${state.settings.ai?.requirePdf === false ? "" : "selected"}>是</option>
            <option value="0" ${state.settings.ai?.requirePdf === false ? "selected" : ""}>否</option>
          </select>
        </div>
      </div>
      <div style="margin-top:10px;">
        <label>禁止自动补全字段（英文key，逗号分隔）</label>
        <input id="aiBlockedFieldKeysInput" value="${escapeHtml((state.settings.ai?.blockedFieldKeys || []).join(", "))}" placeholder="relation_type, category" />
      </div>
      <div style="margin-top:10px;">
        <label>系统提示词（可编辑）</label>
        <textarea id="aiSystemPromptInput" style="min-height:120px;">${escapeHtml(state.settings.ai?.systemPrompt || DEFAULT_AI_SYSTEM_PROMPT)}</textarea>
      </div>
      <div style="margin-top:10px;">
        <label>字段提示词模板（可编辑）</label>
        <textarea id="aiFieldPromptTemplateInput" style="min-height:180px;">${escapeHtml(state.settings.ai?.fieldPromptTemplate || DEFAULT_AI_FIELD_PROMPT_TEMPLATE)}</textarea>
      </div>
      <div class="muted" style="margin-top:8px;">支持占位符：{{field_key}} {{mode}} {{paper_json}} {{note_content}} {{pdf_excerpt}}。Base URL 以 .env 的 AI_BASE_URL 为准。</div>
      <div class="row" style="margin-top:10px;">
        <button class="btn" id="resetAiPromptsBtn">恢复默认提示词</button>
        <button class="btn primary" id="saveAiSettingsBtn">保存AI设置</button>
      </div>
    </div>

    <div class="card">
      <div class="card-title">下拉选项管理</div>
      <div class="message">支持新增/编辑/删除，删除后不影响历史记录文本。</div>
    </div>

    ${groups
      .map(
        (group) => `
      <div class="card" data-group-key="${group.groupKey}">
        <div class="row-between">
          <strong>${escapeHtml(group.name)}</strong>
          <span class="muted">${escapeHtml(group.groupKey)}</span>
        </div>
        <div class="row" style="margin-top: 10px;">
          <input placeholder="value" data-new-value style="max-width: 220px;" />
          <input placeholder="label" data-new-label style="max-width: 220px;" />
          <button class="btn" data-action="add-option">新增选项</button>
        </div>
        <div class="table-wrap" style="margin-top: 10px;">
          <table>
            <thead>
              <tr>
                <th>ID</th><th>value</th><th>label</th><th>启用</th><th>操作</th>
              </tr>
            </thead>
            <tbody>
              ${group.options
                .map(
                  (op) => `
                <tr data-option-id="${op.id}">
                  <td>${op.id}</td>
                  <td><input data-edit="value" value="${escapeHtml(op.value)}" /></td>
                  <td><input data-edit="label" value="${escapeHtml(op.label)}" /></td>
                  <td><input type="checkbox" data-edit="active" ${op.isActive ? "checked" : ""} /></td>
                  <td>
                    <button class="btn small" data-action="save-option">保存</button>
                    <button class="btn small danger" data-action="delete-option">删除</button>
                  </td>
                </tr>
              `
                )
                .join("")}
            </tbody>
          </table>
        </div>
      </div>
    `
      )
      .join("")}
  `;

  const fieldContainer = app.settingsEl.querySelector("#newTemplateFields");
  if (fieldContainer) {
    fieldContainer.innerHTML = `${emptyFieldRow(0)}${emptyFieldRow(1)}`;
  }

  app.settingsEl.querySelector("#addTemplateFieldBtn").onclick = () => {
    const rows = fieldContainer.querySelectorAll("[data-template-field-row]").length;
    fieldContainer.insertAdjacentHTML("beforeend", emptyFieldRow(rows));
    bindFieldRowRemove();
  };

  bindFieldRowRemove();

  app.settingsEl.querySelector("#createTemplateBtn").onclick = async () => {
    try {
      const kind = app.settingsEl.querySelector("#newTemplateKind").value;
      const name = app.settingsEl.querySelector("#newTemplateName").value.trim();
      const baseTemplateId = Number(app.settingsEl.querySelector("#newTemplateBase").value || 0) || null;
      if (!name) throw new Error("模板名称不能为空");

      const fields = [...fieldContainer.querySelectorAll("[data-template-field-row]")]
        .map((row) => ({
          label: row.querySelector('[data-k="label"]').value.trim(),
          type: row.querySelector('[data-k="type"]').value,
          required: row.querySelector('[data-k="required"]').checked,
        }))
        .filter((f) => f.label);

      await api.createTemplate({ kind, name, baseTemplateId: kind === "deep" ? baseTemplateId : null, fields });
      await refreshTemplates();
      renderSettings();
      renderEntry();
      showModal({ title: "模板创建成功", text: "你可以在录入页切换新模板使用。" });
    } catch (error) {
      showModal({ title: "创建失败", text: error.message, type: "error" });
    }
  };

  app.settingsEl.querySelectorAll("tr[data-template-id]").forEach((tr) => {
    const templateId = Number(tr.dataset.templateId);
    tr.querySelector('[data-action="save-template"]').onclick = async () => {
      try {
        const name = tr.querySelector("[data-edit-name]").value.trim();
        if (!name) throw new Error("模板名称不能为空");
        const old = state.templatesById.get(templateId);
        await api.updateTemplate(templateId, { name, kind: old?.kind, baseTemplateId: old?.base_template_id });
        await refreshTemplates();
        renderSettings();
        renderEntry();
      } catch (error) {
        showModal({ title: "保存失败", text: error.message, type: "error" });
      }
    };

    tr.querySelector('[data-action="delete-template"]').onclick = async () => {
      if (!window.confirm("确认删除该模板？")) return;
      try {
        await api.deleteTemplate(templateId);
        await refreshTemplates();
        renderSettings();
        renderEntry();
      } catch (error) {
        showModal({ title: "删除失败", text: error.message, type: "error" });
      }
    };
  });

  app.settingsEl.querySelector("#saveNotesDirBtn").onclick = async () => {
    try {
      const notesDir = app.settingsEl.querySelector("#notesDirInput").value.trim();
      state.settings = await api.updateSettings({ notesDir });
      showModal({ title: "设置已保存", text: "MD 自动创建目录已更新。" });
    } catch (error) {
      showModal({ title: "保存失败", text: error.message, type: "error" });
    }
  };

  app.settingsEl.querySelector("#resetAiPromptsBtn").onclick = () => {
    const systemEl = app.settingsEl.querySelector("#aiSystemPromptInput");
    const fieldEl = app.settingsEl.querySelector("#aiFieldPromptTemplateInput");
    if (systemEl) systemEl.value = DEFAULT_AI_SYSTEM_PROMPT;
    if (fieldEl) fieldEl.value = DEFAULT_AI_FIELD_PROMPT_TEMPLATE;
  };

  app.settingsEl.querySelector("#saveAiSettingsBtn").onclick = async () => {
    try {
      const blockedFieldKeys = app.settingsEl
        .querySelector("#aiBlockedFieldKeysInput")
        .value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);

      const ai = {
        enabled: app.settingsEl.querySelector("#aiEnabledSelect").value === "1",
        provider: app.settingsEl.querySelector("#aiProviderInput").value.trim() || "openai_compatible",
        model: app.settingsEl.querySelector("#aiModelInput").value.trim() || "gpt-4.1-mini",
        timeoutMs: Number(app.settingsEl.querySelector("#aiTimeoutInput").value || 30000),
        pdfPolicy: app.settingsEl.querySelector("#aiPdfPolicySelect").value || "full_pdf",
        requirePdf: app.settingsEl.querySelector("#aiRequirePdfSelect").value === "1",
        blockedFieldKeys,
        systemPrompt: app.settingsEl.querySelector("#aiSystemPromptInput").value.trim() || DEFAULT_AI_SYSTEM_PROMPT,
        fieldPromptTemplate:
          app.settingsEl.querySelector("#aiFieldPromptTemplateInput").value.trim() || DEFAULT_AI_FIELD_PROMPT_TEMPLATE,
      };
      const notesDir = app.settingsEl.querySelector("#notesDirInput").value.trim();
      state.settings = await api.updateSettings({ notesDir, ai });
      showModal({ title: "AI设置已保存", text: "AI 配置已更新。提示词与约束策略已生效。" });
      renderEntry();
    } catch (error) {
      showModal({ title: "保存失败", text: error.message, type: "error" });
    }
  };

  app.settingsEl.querySelectorAll("[data-group-key]").forEach((groupCard) => {
    const groupKey = groupCard.dataset.groupKey;
    groupCard.querySelector('[data-action="add-option"]').onclick = async () => {
      const value = groupCard.querySelector("[data-new-value]").value.trim();
      const label = groupCard.querySelector("[data-new-label]").value.trim();
      if (!value || !label) return;
      await api.addEnumOption(groupKey, { value, label });
      await refreshEnums();
      renderSettings();
      renderEntry();
    };

    groupCard.querySelectorAll("tr[data-option-id]").forEach((tr) => {
      const optionId = Number(tr.dataset.optionId);
      tr.querySelector('[data-action="save-option"]').onclick = async () => {
        const value = tr.querySelector('[data-edit="value"]').value.trim();
        const label = tr.querySelector('[data-edit="label"]').value.trim();
        const isActive = tr.querySelector('[data-edit="active"]').checked;
        await api.updateEnumOption(groupKey, optionId, { value, label, isActive });
        await refreshEnums();
        renderSettings();
        renderEntry();
      };

      tr.querySelector('[data-action="delete-option"]').onclick = async () => {
        if (!window.confirm("确认删除该选项？")) return;
        await api.deleteEnumOption(groupKey, optionId);
        await refreshEnums();
        renderSettings();
        renderEntry();
      };
    });
  });
}

function bindFieldRowRemove() {
  app.settingsEl.querySelectorAll('[data-action="remove-row"]').forEach((btn) => {
    btn.onclick = () => {
      const row = btn.closest("[data-template-field-row]");
      if (row) row.remove();
    };
  });
}

async function refreshEnums() {
  state.enums = await api.getEnums();
}

async function refreshTemplates() {
  state.templatesPayload = await api.getTemplates();
  state.templatesById.clear();
  [...(state.templatesPayload.roughTemplates || []), ...(state.templatesPayload.deepTemplates || [])].forEach((item) => {
    state.templatesById.set(Number(item.id), item);
  });
  ensureTemplateSelected();
}

async function refreshSettings() {
  state.settings = await api.getSettings();
}

async function bootstrap() {
  initTheme();
  app.themeBtn.onclick = () => toggleTheme();

  renderTabs();

  await refreshTemplates();
  await refreshEnums();
  await refreshSettings();
  await refreshPapers();

  setActiveTab("home");
  renderHome();
}

bootstrap().catch((error) => {
  document.body.innerHTML = `<pre style="padding:16px;color:#dc2626;">启动失败：${escapeHtml(error.message)}</pre>`;
});