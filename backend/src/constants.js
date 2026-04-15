const TEMPLATE_KINDS = {
  ROUGH: "rough",
  DEEP: "deep",
};

const ENUM_GROUPS = {
  CATEGORY: "related_category",
  PRIORITY: "reading_priority",
  RELATION: "relation_type",
};

const DEFAULT_ENUM_OPTIONS = {
  [ENUM_GROUPS.CATEGORY]: [
    "同任务不同方法",
    "同方法不同任务",
    "同约束问题",
    "survey",
    "benchmark",
    "直接竞争工作",
  ],
  [ENUM_GROUPS.PRIORITY]: ["A 必读", "B 可读", "C 略读", "D 丢弃"],
  [ENUM_GROUPS.RELATION]: [
    "baseline",
    "方法借鉴",
    "动机支撑",
    "novelty 风险",
    "related work 引用",
    "可忽略",
  ],
};

const BASE_TEMPLATE_FIELDS = [
  { key: "task", label: "任务/问题", type: "textarea", required: 1 },
  { key: "method", label: "方法", type: "textarea", required: 0 },
  { key: "main_contribution", label: "主要贡献", type: "textarea", required: 0 },
  { key: "limitation", label: "局限性", type: "textarea", required: 0 },
  { key: "relation_type", label: "和我的关系", type: "enum:relation_type", required: 0 },
  { key: "category", label: "相关工作类别", type: "enum:related_category", required: 0 },
  { key: "priority", label: "精读优先级", type: "enum:reading_priority", required: 0 },
];

const DEEP_EXTENDED_FIELDS = [
  { key: "index_no", label: "序号", type: "text", required: 0 },
  { key: "search_source", label: "检索来源", type: "text", required: 0 },
  { key: "query_keywords", label: "命中关键词", type: "text", required: 0 },
  { key: "method_keywords", label: "方法关键词", type: "text", required: 0 },
  { key: "dataset_scene", label: "数据集/实验场景", type: "text", required: 0 },
  { key: "core_method_one_line", label: "核心方法一句话", type: "textarea", required: 0 },
  { key: "baselines", label: "对比方法/基线", type: "textarea", required: 0 },
  { key: "highlights", label: "结果亮点", type: "textarea", required: 0 },
  { key: "worth_deep_read", label: "是否值得精读", type: "enum:reading_priority", required: 0 },
  { key: "github_code", label: "GitHub/代码", type: "text", required: 0 },
  { key: "note", label: "我的备注", type: "textarea", required: 0 },
];

module.exports = {
  TEMPLATE_KINDS,
  ENUM_GROUPS,
  DEFAULT_ENUM_OPTIONS,
  BASE_TEMPLATE_FIELDS,
  DEEP_EXTENDED_FIELDS,
};