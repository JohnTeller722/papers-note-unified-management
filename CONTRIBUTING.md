# Contributing Guide

感谢你为“文献阅读管理工具”贡献代码。

本文档说明：如何提 Issue、如何提交改动、以及本项目建议遵守的最小协作规范。

## 1. 开始之前

- 先阅读：
  - `README.md`
  - `docs/系统功能现状.md`
  - `docs/系统组件与业务流程说明.md`
  - `docs/代码维护指南.md`
- 本项目当前定位：本地单机 Web 应用（Node.js + Express + SQLite + 原生前端）。

## 2. 本地开发

### 2.1 环境要求

- Node.js 24+
- npm 10+
- Windows / macOS / Linux（以本地运行为主）

### 2.2 启动

```bash
npm install
npm run dev
```

访问：`http://127.0.0.1:3000`

## 3. 分支与提交建议

- 推荐从 `main` 拉新分支开发，例如：
  - `feat/template-field-order`
  - `fix/open-md-error`
  - `docs/maintenance-update`

- 提交信息建议（简洁英文前缀 + 中文描述也可）：
  - `feat: ...` 新功能
  - `fix: ...` bug 修复
  - `docs: ...` 文档改动
  - `refactor: ...` 重构
  - `chore: ...` 杂项维护

## 4. 改动范围原则

- 优先做“与需求直接相关”的最小改动。
- 不要把无关重构和功能改动混在同一个 PR。
- 涉及数据结构变更时，必须同步更新：
  - `backend/src/db.js`
  - 对应 API（`backend/src/server.js`）
  - 前端调用（`frontend/src/api/client.js`）
  - 前端页面逻辑（`frontend/src/main.js`）

## 5. 提交前自检（最小清单）

至少手工验证以下路径：

1. 新建文献并保存（弹窗 + 清空表单）
2. 记录中心筛选
3. 打开 MD（含不存在文件自动创建）
4. 导出 Excel
5. 夜间模式下关键控件可读性

如果你的改动涉及模板/枚举/PDF，请额外验证相关路径。

## 6. Issue 与 PR 规范

### 6.1 Issue

- 请优先使用仓库内置模板（Bug / Feature Request）。
- 复现步骤尽量可执行、可复测。

### 6.2 Pull Request

建议 PR 描述至少包含：

- 变更摘要（做了什么）
- 变更动机（为什么）
- 测试方式（怎么验证）
- 影响范围（是否涉及 DB/API/UI）

## 7. 文件与数据约定

- 请勿提交本地运行数据：
  - `backend/data/litnotes.db`
  - `backend/data/exports/`
  - `notes/`
  - `.claude/`
- 遵循现有 `.gitignore`。

## 8. 文档同步

以下场景请同步更新文档：

- 新增/移除功能：更新 `docs/系统功能现状.md`
- 组件关系或流程变化：更新 `docs/系统组件与业务流程说明.md`
- 功能代码映射变化：更新 `docs/代码维护指南.md`

## 9. 安全与边界

- 本项目默认本地使用，但仍应避免引入明显安全风险：
  - 不信任外部输入时注意校验
  - 文件路径操作保持白名单约束（如 MD 扩展名）
- 不要在仓库提交密钥、令牌、账号密码等敏感信息。