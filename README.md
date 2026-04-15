# 文献阅读管理工具

基于你确认的方案实现的本地 Web MVP：支持粗读/精读模板（继承关系）、PDF 本地元数据解析、记录检索筛选、下拉选项可维护、批量导出 Excel、MD 路径直开、AI 建议接口预留。

## 功能概览

- 粗读/精读模板
  - 精读为粗读扩展，支持同一条记录 `rough -> deep` 升级。
- 录入页
  - 可拖入 PDF 自动提取题目/作者/年份（仅本地解析）。
  - 手工填写字段，保存入 SQLite。
- 记录中心
  - 关键词 + 阶段 + 优先级 + 类别 + 关系筛选。
  - 勾选导出或按筛选结果导出 `.xlsx`。
  - 支持编辑、删除、升级精读、打开 MD。
- 设置页
  - 下拉选项（类别/优先级/关系）新增、编辑、删除、启停。
- 主题
  - 日夜模式切换并本地记忆。
- AI 预留
  - `POST /api/ai/analyze-and-fill` 目前为本地 mock 输出。

## 技术栈

- 后端：Node.js + Express + SQLite
- 前端：原生 HTML/CSS/JS（无构建工具）
- 导出：ExcelJS
- PDF 解析：pdf-parse（本地）

## 目录结构

- `backend/src/server.js`：主服务与 API
- `backend/src/db.js`：SQLite 初始化与数据访问
- `backend/src/pdf.js`：PDF 元数据解析
- `backend/src/exporter.js`：Excel 导出
- `frontend/index.html`：页面骨架
- `frontend/src/main.js`：前端交互逻辑
- `frontend/src/styles.css`：样式与主题
- `frontend/src/api/client.js`：API 调用
- `frontend/src/theme/index.js`：主题管理

## 启动方式

1. 安装依赖：

```bash
npm install
```

2. 启动服务：

```bash
npm run dev
```

3. 打开浏览器访问：

- `http://localhost:3000`

## 数据与导出

- SQLite 数据库：`backend/data/litnotes.db`
- 导出目录：`backend/data/exports/`

## 说明

- MD 打开功能依赖本机默认程序和路径有效性。
- PDF 自动识别受文档格式影响，失败时可手工补全。
- 当前实现为单用户本地场景，后续可扩展为多用户与云同步。