const ExcelJS = require("exceljs");

function getExportHeaders(viewMode = "deep") {
  const roughHeaders = [
    "ID",
    "阅读阶段",
    "论文题目",
    "年份",
    "会议/期刊",
    "作者",
    "链接",
    "任务/问题",
    "方法",
    "主要贡献",
    "局限性",
    "和我的关系",
    "相关工作类别",
    "精读优先级",
    "MD路径",
    "更新时间",
  ];

  const deepExtra = [
    "序号",
    "检索来源",
    "命中关键词",
    "方法关键词",
    "数据集/实验场景",
    "核心方法一句话",
    "对比方法/基线",
    "结果亮点",
    "是否值得精读",
    "GitHub/代码",
    "我的备注",
  ];

  return viewMode === "rough" ? roughHeaders : [...roughHeaders, ...deepExtra];
}

function rowFromPaper(paper, viewMode = "deep") {
  const fv = paper.fieldValues || {};
  const base = [
    paper.id,
    paper.stage === "deep" ? "精读" : "粗读",
    paper.title || "",
    paper.year || "",
    paper.venue || "",
    paper.authors || "",
    paper.link || "",
    fv.task || "",
    fv.method || "",
    fv.main_contribution || "",
    fv.limitation || "",
    paper.relationType || fv.relation_type || "",
    paper.category || fv.category || "",
    paper.priority || fv.priority || fv.worth_deep_read || "",
    paper.mdPath || "",
    paper.updatedAt || "",
  ];

  if (viewMode === "rough") return base;

  return [
    ...base,
    fv.index_no || "",
    fv.search_source || "",
    fv.query_keywords || "",
    fv.method_keywords || "",
    fv.dataset_scene || "",
    fv.core_method_one_line || "",
    fv.baselines || "",
    fv.highlights || "",
    fv.worth_deep_read || "",
    fv.github_code || "",
    fv.note || "",
  ];
}

async function buildExcelBuffer(papers, viewMode = "deep") {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("papers");
  const headers = getExportHeaders(viewMode);
  sheet.addRow(headers);

  papers.forEach((paper) => {
    sheet.addRow(rowFromPaper(paper, viewMode));
  });

  sheet.getRow(1).font = { bold: true };
  sheet.columns.forEach((column) => {
    column.width = Math.min(40, Math.max(12, (column.header || "").length + 4));
  });

  return workbook.xlsx.writeBuffer();
}

module.exports = {
  buildExcelBuffer,
};