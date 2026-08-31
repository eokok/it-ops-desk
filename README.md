# IT 运维工单后台管理系统 (OpsDesk)

一个类 ServiceNow 的 IT 运维工单管理平台，纯前端实现，开箱即用，数据存储在浏览器本地（localStorage）。

## 功能模块

- **数据看板 (Dashboard)**：工单总数、待处理、已解决、SLA 达标率等指标卡，状态分布 / 优先级 / 趋势 / 分类等多张图表。
- **事件管理 (Incident)**：工单的列表检索、筛选、排序、新建 / 编辑 / 删除；状态流转（新建 → 处理中 → 已解决 → 关闭）、P1–P4 优先级、SLA 时限、关联 CMDB。
- **配置管理 (CMDB)**：配置项 (CI) 的增删改查，支持服务器 / 网络设备 / 应用系统 / 数据库 / 人员等类型，自动统计每个 CI 关联工单数。
- **知识库 (KB)**：知识文章的分类、标签检索、关联 CI，可在工单中引用。
- **服务请求 (Request)**：权限申请、设备采购等，含审批流转。
- **变更管理 (Change)**：交换机 / 服务器升级变更，含风险等级、关联多个 CI、回滚方案与审批。
- **审批流转**：事件 / 请求 / 变更均支持提交审批 → 批准 / 驳回，并记录审批历史。
- **SLA 超时提醒**：按优先级计算时限，列表高亮超时项，看板汇总超时工单。
- **Excel 导出**：事件、CMDB、请求、变更列表均支持导出 `.xlsx`（本地 SheetJS）。
- **响应式布局**：桌面侧栏常驻，窄屏自动折叠为抽屉式菜单。

## 技术栈

- 纯前端：HTML / CSS / JavaScript（原生，无构建步骤）
- 图表：[Chart.js](https://www.chartjs.org/)（已本地化 `chart.umd.min.js`，无需联网）
- Excel 导出：[SheetJS (xlsx)](https://sheetjs.com/)（已本地化 `xlsx.full.min.js`）
- 持久化：浏览器 localStorage

## 运行方式

直接双击打开 `index.html` 即可，或启动一个静态服务器：

```bash
# 任选其一
python -m http.server 8080
# 然后浏览器访问 http://localhost:8080
```

## 文件结构

```
outputs/
├── index.html          # 页面入口与结构
├── styles.css          # 浅色企业主题、响应式样式
├── app.js              # 数据模型、持久化与全部交互逻辑
├── chart.umd.min.js    # 本地 Chart.js
└── xlsx.full.min.js    # 本地 SheetJS
```

## 说明

当前为纯前端单机版，无后端 / 登录 / 多用户。如需接入真实后端、数据库、审批角色权限或 SLA 自动通知（邮件 / 企微），可在此基础继续扩展。
