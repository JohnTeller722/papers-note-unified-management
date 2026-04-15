async function request(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    ...options,
  });
  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("application/json") ? await response.json() : await response.text();

  if (!response.ok) {
    const message = typeof payload === "object" && payload?.message ? payload.message : `请求失败: ${response.status}`;
    throw new Error(message);
  }
  return payload;
}

export const api = {
  getTemplates() {
    return request("/api/templates");
  },
  createTemplate(body) {
    return request("/api/templates", { method: "POST", body: JSON.stringify(body) });
  },
  updateTemplate(id, body) {
    return request(`/api/templates/${id}`, { method: "PUT", body: JSON.stringify(body) });
  },
  deleteTemplate(id) {
    return request(`/api/templates/${id}`, { method: "DELETE" });
  },
  getEnums() {
    return request("/api/enums");
  },
  getSettings() {
    return request("/api/settings");
  },
  updateSettings(body) {
    return request("/api/settings", { method: "PUT", body: JSON.stringify(body) });
  },
  listPapers(params = {}) {
    const query = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null && String(v).trim() !== "") query.set(k, v);
    });
    return request(`/api/papers?${query.toString()}`);
  },
  getPaper(id) {
    return request(`/api/papers/${id}`);
  },
  createPaper(body) {
    return request("/api/papers", { method: "POST", body: JSON.stringify(body) });
  },
  createMd(body) {
    return request("/api/papers/create-md", { method: "POST", body: JSON.stringify(body) });
  },
  updatePaper(id, body) {
    return request(`/api/papers/${id}`, { method: "PUT", body: JSON.stringify(body) });
  },
  deletePaper(id) {
    return request(`/api/papers/${id}`, { method: "DELETE" });
  },
  upgradePaper(id) {
    return request(`/api/papers/${id}/upgrade`, { method: "POST" });
  },
  addEnumOption(groupKey, body) {
    return request(`/api/enums/${groupKey}/options`, { method: "POST", body: JSON.stringify(body) });
  },
  updateEnumOption(groupKey, optionId, body) {
    return request(`/api/enums/${groupKey}/options/${optionId}`, { method: "PUT", body: JSON.stringify(body) });
  },
  deleteEnumOption(groupKey, optionId) {
    return request(`/api/enums/${groupKey}/options/${optionId}`, { method: "DELETE" });
  },
  parsePdf(file) {
    const data = new FormData();
    data.append("pdf", file);
    return fetch("/api/pdf/parse", { method: "POST", body: data }).then(async (res) => {
      const payload = await res.json();
      if (!res.ok) throw new Error(payload?.message || "PDF解析失败");
      return payload;
    });
  },
  exportPapers(body) {
    return request("/api/export", { method: "POST", body: JSON.stringify(body) });
  },
  openMd(mdPath, paperMeta = {}) {
    return request("/api/papers/open-md", {
      method: "POST",
      body: JSON.stringify({ mdPath, title: paperMeta.title || "", year: paperMeta.year || "" }),
    });
  },
  aiSuggest(body) {
    const payload =
      typeof body === "number"
        ? { paperId: body, targetFieldKeys: ["main_contribution", "limitation"], mode: "combined" }
        : body;
    return request("/api/ai/analyze-and-fill", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },
  batchAnalyze(body) {
    return request("/api/ai/batch/analyze", { method: "POST", body: JSON.stringify(body) });
  },
  getAiJob(id) {
    return request(`/api/ai/jobs/${id}`);
  },
  resetAiSession(aiSessionId) {
    return request("/api/ai/session/reset", { method: "POST", body: JSON.stringify({ aiSessionId }) });
  },
};