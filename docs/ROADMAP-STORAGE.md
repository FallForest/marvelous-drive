# 存储能力路线�?
> 视角：只管「把东西存进去、找得到、拿得出来」。协同编辑、评论、ACL 不在本文范围�?> 每条都写成「缺口（现状）→ 方案 �?成本 �?验收」，现状一律能指到文件或路由�?
## 0. 现状盘点

| 能力 | 现在的样�?| 位置 |
| --- | --- | --- |
| 单文件上�?| `PUT /api/v1/uploads?name=&parentId=`，同名即覆盖并升版本 | `apps/server/src/routes/files.js` |
| 分片上传 | 8 MiB 分块 session，幂等重传、sha256 校验�?4h 过期 | `apps/server/src/routes/uploads.js` |
| 文件夹上�?| 先建目录骨架再传文件；空目录保留�?09 复用已有目录 | `apps/web/lib/folder-upload.js` |
| 内容存储 | sha256 内容寻址 + refcount，同字节只存一�?| `apps/server/src/storage/blobs.js` |
| 版本 | 每次覆盖/改名/移动�?+1，可回滚 | `apps/server/src/versions.js` |
| 下载 | Range/206、attachment、分享直�?| `apps/server/src/http.js` `sendFile` |
| 回收�?| 软删 + 级联恢复 + 彻底删除（释�?blob�?| `apps/server/src/nodes.js` |
| 分享 | 密码/有效�?下载次数上限 | `apps/server/src/routes/shares.js` |
| 预览 | 图片/PDF/音视�?文本/MD/**office** | `apps/web/lib/preview.js`、`office-preview.js` |
| 统计 | files/folders/trashed/bytes/starred/shares/uploads | `apps/server/src/routes/misc.js` |
| 配额 | **`quotaBytes` 恒为 `null`，不限制** | 同上 |

## P0 �?没有它就不像网盘

### P0-1 秒传（服务端已会�?sha256，客户端却每次全量上传）
- **缺口**：`upload.js` 每次起传前用 `crypto.subtle` 算完 sha256 仍然照传，`blobs` 里明明已有同 hash �?blob（`adoptBlob` 会直接复用文件），网络流量白费�?- **方案**：`PUT /uploads` 增加可选的 `?hash=` 查询�?`HEAD /api/v1/blobs/:sha256` 探测；已存在则直�?`createNode` 指向�?blob �?`retainBlob`，返�?`200 {node, deduplicated:true}`。客户端 >1 MiB 文件先探测，命中就跳过传输�?- **成本**：S（服务端 1 个路�?+ 客户�?20 行）
- **验收**：同一文件第二次上传，网络面板显示 0 字节 body、节�?`size` 正确、`blobs.refs` +1�?
### P0-2 同名冲突只有一种策�?- **缺口**：`upsertFile` 见到同名就覆盖升版本，用户拖一个同名文件进目录会静默替换掉旧文件�?- **方案**：`PUT /uploads` 与分�?`complete` 接受 `onConflict=overwrite|rename|skip`；`rename` 用现成的 `uniqueName()` 生成 `名字 (1).ext`；`skip` 返回 `200 {node: 已存在节�? skipped:true}`。前端上传前弹一次「覆�?/ 保留两个 / 跳过」并可记住选择�?- **成本**：S–M
- **验收**：三种策略各跑一次，节点数量与版本号符合预期；默认策略保持今天的覆盖行为不变�?
### P0-3 上传队列不持久，刷新即丢
- **缺口**：`queue.js` 状态只在内存，误关标签页后队列清空；分�?session 虽在服务端留 24h，但客户端没有恢复入口�?- **方案**：把「未完成任务」写�?`localStorage`（`{name,size,parentId,sessionId,lastChunk}`），启动时读回并展示「继续上传」；配合 `GET /uploads/sessions` 校验 session 仍在�?- **成本**：M
- **验收**�? MiB 文件传到一半刷新页面，队列恢复且从缺失块继续，最�?sha256 一致�?
### P0-4 没有全局限�?暂停
- **缺口**：只能逐条取消；一次拖�?200 个文件就�?200 个并�?`start()`（见 `uploadFiles` �?for 循环）�?- **方案**：队列加并发上限（默�?3）与「全部暂�?继续」；`createUploadTask` 已支�?`AbortController`，暂停即 abort 并把状态记�?`paused` 而不�?`canceled`�?- **成本**：S
- **验收**：拖 50 个文件，同时进行的传输始�?�?；暂停后服务端无新分块写入�?
## P1 �?日常会用

| # | 缺口 | 方案 | 成本 | 验收 |
| --- | --- | --- | --- | --- |
| P1-1 | 回收站没有保留期，永久占空间 | �?`trashRetentionDays`（默�?30），启动时清理过期项；接�?`DELETE /trash/expired` | S | �?`deleted_at` 改到 31 天前后，重启后条目消失且 blob 归零 |
| P1-2 | 下载整个文件夹要手动�?archive | `POST /nodes/:id/archive` 已有，前端加「下载文件夹」菜单项并直接下 zip | S | 右键文件�?�?下载，得到可解压�?zip |
| P1-3 | 列表只有图标没有缩略�?| 图片 <4 MiB �?`/files/:id/content?w=240` 生成缓存缩略图（复用 blob，按需生成�?| M | 图片在列表显�?32px 缩略图，首次加载 <100ms |
| P1-4 | 文本/代码预览无高�?| 前端�?`code` 类文件做轻量 tokenizer 着�?| S | `.js`/`.json`/`.py` 打开有颜�?|
| P1-5 | 批量操作缺失 | 多选后批量移动/删除/加星（后端已有单条接口，纯前端循环） | S | 选中 10 项一次删除，回收站出�?10 �?|
| P1-6 | 跨目录拖拽移动没�?| 行拖到侧栏文件夹�?`PUT /nodes/:id {parentId}` | M | 拖拽后节�?parentId 改变，目标目录出�?|
| P1-7 | 上传没有速度/剩余时间 | `upload.js` 已算 `task.speed`，队列行显示�?+ ETA | S | 队列显示 `1.2 MB/s · 剩余 8s` |

## P2 �?体系�?
| # | 缺口 | 方案 | 成本 |
| --- | --- | --- | --- |
| P2-1 | 没有配额 | 每用�?`quotaBytes`，上传前校验并返 `413 QUOTA_EXCEEDED`；stats 返回真实�?| M |
| P2-2 | 统计不分类型 | `storage/stats` 增加 `byKind: {image, video, document, archive, other}` | S |
| P2-3 | 没有校验和自�?| 定时任务�?`blobs` 重算 sha256，不一致标�?`corrupt` 并从版本历史修复 | L |
| P2-4 | 没有重复文件报告 | `SELECT hash, COUNT(*), SUM(size) FROM blobs` 出报告页，可批量删重�?| M |
| P2-5 | 没有审计日志 | `audit(user_id, action, node_id, ip, at)`，保�?90 �?| M |
| P2-6 | ~~多用户模型~~ **已做** | `workspaces` + `memberships`；成员可见性、共享文件夹命名空间、成员管理接�?| L |
| P2-7 | ~~存储后端~~ **已做** | `StorageBackend` 接口 + `S3Backend`（含手写 SigV4�?| L |
| P2-8 | ~~冷热分层~~ **已做** | `TieredBackend` + 校验后迁�?+ `mdrive tiers --demote` | L |
| P2-9 | ~~文件锁~~ **已做** | `locks.js`：建议性编辑锁�?5 分钟过期，同用户换窗口会转移并回�?| M |

## 明确不做

| 能力 | 理由 |
| --- | --- |
| 协同编辑、评论、ACL、CRDT | 那是文档编辑器的语义，不是存储的；Drive 只存字节 |
| 与外部文档服务的桥接 | 0.16.0 已移除：桥接需要保存对方的 token，还要把用户输入�?URL 变成出站请求。两者都是纯负债，�?Drive 不依赖它也能自洽 |
| Markdown 转换算法 | 只做原样存取；转换属于编辑器 |

## 已交付（0.3.0 实测�?
| �?| 状�?| 证据 |
| --- | --- | --- |
| P0-1 秒传 | **已做** | `GET /blobs/:sha256` + `POST /uploads/instant`；CLI `--on-conflict`；`apps/web/lib/upload.js` 客户端探测；测试 `dedup.test.js`（服务端 19 条）、`packages/cli/test/dedup.test.mjs`�? 条）、`apps/web/test/upload-instant.test.js` |
| P0-2 冲突策略 | **已做** | `onConflict=overwrite|rename|skip` 三个入口，`mdrive upload --on-conflict`；网页端 UI 仍只发默认�?|
| P0-4 并发上限 | **已做** | `createUploadScheduler`，并�?3，暂�?继续保留 session |
| P1-1 回收站保留期 | **已做** | `retention.js` + `DRIVE_TRASH_RETENTION_DAYS`，每小时与启动时清扫 |
| P1-2 下载整个文件�?| **已做** | 行菜单「下载为 ZIP�? `POST /nodes/archive` 多选打�?|
| P1-7 速度/剩余时间 | **已做** | 队列行显�?`1.2 MB/s · 剩余 8s` |
| P2-1 配额 | **已做** | `DRIVE_QUOTA_BYTES`，所有写入路径校验，`quota.test.js` 6 �?|
| P2-2 按类型统�?| **已做** | `stats.byKind` + 侧栏三色摘要 |
| P2-7 存储后端 | **已做** | `storage-backend.js`（put/get/stat/remove/link/readBlobBuffer�? `sendBlob()` 支持 Range�?*全部** blob 读取（预�?Office/PDF/索引/回收�?ZIP/分享/探测）都已走接缝，`seam.test.js` 静态守卫；`S3Backend`（手�?SigV4�? `DRIVE_STORAGE=s3`；`s3.test.js` 校验 AWS 文档�?canonical request，`s3-driver.test.js` 让整个服务跑�?S3 驱动�?|
| P2-6 多用�?| **已做** | `workspaces`/`memberships` + 幂等迁移；`getNode`/`findFileByName`/`uniqueName`/`childrenCount` 改为「拥有或�?workspace 可见」；成员接口；`workspaces.test.js` 10 �?|
| P2-9 编辑�?| **已做** | `GET/POST/DELETE /nodes/:id/lock`�?09 带持有者、force 接管写审计；预览抽屉自动持有；`locks.test.js` 9 �?+ `lock-check.mjs` 6 �?|
| P2-3 校验和自�?| **已做** | `GET /maintenance/blobs/verify`（按 limit 分片重算 sha256）；`quarantine` 移入 `data/quarantine/` 并删行；`mdrive verify [--fix]`；`checksum.test.js` 5 �?|
| 版本可下�?| **已做** | `GET /files/:id/versions/:versionId/content` + 预览抽屉 + CLI `versions`/`version download`/`version restore` |
| P1-3 图片缩略�?| **已做** | `GET /files/:id/thumbnail`（透传 + immutable 缓存�? 列表 32px 缩略�?+ 200 �?objectURL 缓存 |
| P1-4 代码高亮 | **已做** | `apps/web/lib/highlight.js`�?2 条测试；渲染前全量转�?|
| P1-5 批量操作 | **已做** | 选择栏「移动到…」，`planMoves()` 与拖拽共用一套规�?|
| P1-6 跨目录拖�?| **已做** | 行可拖，侧栏/面包屑可放；与「拖文件上传」按 dataTransfer 类型分流 |
| P2-4 重复文件报告 | **已做** | `GET /storage/duplicates` + 抽屉，「只保留第一个」走软删�?|
| P2-5 审计日志 | **已做** | `audit_log` �?+ `GET /audit` + 操作记录抽屉�?0 天保�?|
| P0-3 队列持久�?| **部分** | 只持久化「历史摘要」，不伪造可续传�?File；刷新后只显示只读历�?|

## 本轮已完成的切片

- **文件夹上�?*：工具栏菜单「上传文�?/ 上传文件夹」，拖放目录树，空目录保留，409 复用 —�?`apps/web/lib/folder-upload.js` + `scripts/folder-check.mjs`�? 项）�?- **Office 预览**：`.pptx`/`.docx`/`.xlsx` 服务端抽�?+ 抽屉渲染 —�?`apps/server/src/text/zip-read.js`、`apps/server/src/text/office.js`、`routes/office.js`、`apps/web/lib/office-preview.js`，`scripts/office-check.mjs` 对真�?deck 验证 7 项�?- **搜索框图标错�?*：`apps/web/lib/sidebar.js` �?input 缺少 `class="input"`，导�?`.search-field .input{padding-left:28px}` 从未生效 —�?已修，并补右内边距避开 `/` 提示�?
## 建议下一步（1�? 天）

1. P0-1 秒传（服务端 1 个探测路�?+ 客户端先探测）�?2. P0-2 冲突策略三选一，先把默认行为保持覆盖以免破坏现有测试�?3. P0-4 并发上限，顺手解决拖 200 个文件打爆浏览器的问题�