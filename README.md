# @nestos/kanban

## 独立安装与开发

```sh
npm install @nestos/kanban @nestos/vfs-core
# 在本仓库开发
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm pack
```

根入口与 `/contracts` 入口不依赖 NestOS 服务；可选 `/ui` 入口使用原生 DOM，并通过宿主传入文案、图标及导航。按需引入 `@nestos/kanban/ui.css`。Node 或只使用领域功能的消费者无需导入 UI。

基于 VFS 的通用看板与工作协调库，核心依赖 `@nestos/vfs-core`，可选 UI 使用 `@nestos/ui-common`。提供唯一责任人、估算与在制额度、依赖、验收、归档、日志和决策，以及持久派发意图。库不调用模型、不创建 Session/Task、不安装后台调度器。包含可独立挂载的 DOM UI；执行、来源与资源活动通过可选端口接入。

```ts
import {SeqKanbanStore, createKanbanModule} from '@nestos/kanban';

const service = createKanbanModule({
    store: await SeqKanbanStore.open(authorizedFS, '/work'),
    actor: authenticatedPrincipal,
    authorize: authorizeOperation,
    verifyOutputs: verifyImmutableArtifacts,
    onCommitted: async (boardId, source) => publishPersistedEvents(boardId, source),
    log: logMetadata,
});
```

`actor`、授权及产物核验均来自可信宿主，不能从命令 JSON 中采信。`create` 传入 scope、members、职责和 policy；`execute` 传入稳定 operationId、expectedRevision 和强类型 command。并发冲突由调用方重新读取后决定，不能换 ID 盲目重试外部执行。

## 公共入口

| 入口 | 内容 |
| --- | --- |
| 根入口 | `createKanban` 分组 API；`createKanbanModule` 服务工厂与 `SeqKanbanStore` |
| `/contracts` | 无副作用 DTO、命令、事件与默认配置 |
| `/storage` | `SeqKanbanStore`、`ConditionalKanbanStore`、内容安装与传输端口 |
| `/execution` | `createKanbanExecutionBridge`；宿主提供 prepare/start/inspect |
| `/discovery` | `createKanbanDiscovery`；宿主提供来源、分析和授权 |
| `/activity` | `createKanbanActivityModule`；注入来源和外部引用 namespace |
| `/ui`、`/ui.css` | DOM 工作区、`mountKanban` 与独立样式 |

`createKanban(options)` 提供 `boards.create/get/list/overview`、`items.get/query`、`records.get/query`、`planning.get`、`references.resolve/suggest`、`execute`、`events`、`tick` 和 `quiesce/dispose`。execute 返回 `{boardId, operationId, revision}`；幂等重放时 revision 是当前返回快照的版本。需要 KanbanService（例如 UI、执行桥）时直接使用 `createKanbanModule`，二者共享同一实现与命令协议。

主体 ID、Session/Task/Message ID 及历史持久格式保留。独立 Agent 可以只提供自己的 ID；若提供执行身份，所有权继续按该身份隔离。NestOS 在适配边界继续要求真实 Session/Task，宿主始终负责实际权限核验。

## 独立 UI

```ts
import {mountKanban} from '@nestos/kanban/ui';
import '@nestos/kanban/ui.css';

const view = await mountKanban(container, {
    service,
    presentation: {
        text: (key, values) => translations(key, values),
        icons: {refreshView, more, close},
        log: logMetadata,
        referenceUrl: path => resourceUrl(path),
    },
    selected: path => saveNavigation(path),
    openSession: id => openResource(id),
});
await view.open({boardId: 'work'});
await view.dispose();
```

文案 key 不带 `kanban.` 前缀；图标为可信宿主提供的 SVG/HTML。主题通过 `--kanban-*` CSS 变量设置；NestOS 在适配样式中映射原有主题变量。所有呈现配置按实例注入，不存在全局语言、当前宿主或跨实例回调。UI 不导入 NestOS、common 或 vfs-ui。资源活动为可选能力；未接入时不显示执行筛选，也不安装活动轮询。接入时可见且没有未保存输入才轮询，销毁后停止；通知不会覆盖草稿。错误只展示安全错误码与宿主文案，不输出正文或完整请求。

来源发现仅通过内置 `apply-discovery` 提交受校验的变更与检查点，二者同事务保存。宿主不提供可变 reducer 扩展。来源可声明 system/project/collection scope；历史 projectId 仍兼容。库不提供内部 mechanisms 入口。消费者直接从 `/contracts` 导入 DTO 和 KanbanClient，不经过应用包转出。

执行桥不解释模型或业务。执行桥和来源扫描的 `tick()`（兼容 `scan()`）由宿主显式驱动；扫描 `quiesce/dispose` 拒绝新准入并排空已接纳操作。只有注入 subscribe 才接收唤醒。executionReference 将实际执行 ID 映射为宿主命名空间，不在核心写死 NestOS 引用。`ConditionalKanbanStore` 只要求 query/transaction 与可选正文资产端口，适配器负责授权连接及 unknown 写入核对，不在 Store 内盲重试。

## 版本化内容安装

`/contracts` 自包含定义 `KanbanContent`、`KanbanClient` 及领域 DTO。`/storage` 的 `installKanbanContent({store, actor, authorize, log, content, operationId})` 安装宿主提供的内容；显式授权 action=install-content，在同一事务保存工作项、记录、修改建议、归档、事件、回执与安装版本。安装内容不授予执行或审核权限。库不携带 NestOS 示例、文案或模板。

默认只补充新版本新增的身份，保留用户修改和删除。显式 fillMissing 可以恢复缺失项，已存在或已归档身份不会重新创建。missingReferences=detach 是明确选择的引用修复策略，默认仍按领域约束拒绝无效关系。inspectKanbanContent 返回安装版本与完整性，不向宿主泄露 reducer 状态。

## 验证

```bash
pnpm --filter @nestos/kanban typecheck
pnpm --filter @nestos/kanban test
pnpm --filter @nestos/kanban build
pnpm --filter @nestos/kanban example
```

[独立示例](examples/standalone.ts) 只使用 VFS 与假执行器，完成两节点依赖计划，显式自动验收后关闭；没有 NestOS Runtime、模型或网络调用。内存后端用于演示，生产需提供持久后端和实际授权。

## 计划与执行

管理主体以 `publish-plan` 发布 `kanban.plan/1`：每项指定 assignee、dependsOn、验收条件及输入/输出名称。决策可保存 `coordination.manager/executor`，关联计划只允许该管理主体发布；成员和宿主权限仍需独立检查。计划校验循环、悬空依赖及版本冲突后，原子创建工作项。

执行主体提交 `prepare-dispatch`，同一事务完成认领、估算、依赖产物固定和派发意图持久化。可选 execution 入口负责冻结请求和提交前日志，再通过宿主端口调用既有执行器。`observe-execution` 只接收原 dispatchId/fence 的真实观察；`unknown` 保留责任，禁止自动重派。成功首先进入 review；默认需要独立主体 `accept-execution`。显式 review=assignee 时可信成功可自动验收。只有依赖已验收且输出存在，后续任务才能进入 ready。

`workflow(boardId)` 返回计划、派发和 ready 摘要。核心只解锁已发布 DAG；动态分解和业务决策仍由管理主体提交下一版计划。修改任务定义需要新任务 ID，未结算执行阻止替换计划或转交责任。`completedPlans` 仅说明已封闭计划中的事项完成，不能替代业务目标验收。

## 文件协议

默认存储 `/kanban/boards.seq`，可注入目录或完全替换 KanbanStore。SeqFile 必须支持 transaction。键中身份使用 encodeURIComponent：

| 键 | 内容 |
| --- | --- |
| `index` | 看板 ID 列表 |
| `board/<boardId>` | layout=2 清单：板元数据、摘要索引、workflow、序列及状态 |
| `item/<boardId>/<itemId>` | 工作项正文或内容寻址引用 |
| `record/<boardId>/<recordId>` | 日志/决策正文或引用 |
| `archive/<boardId>/<itemId>` | 已关闭归档项与关闭事实 |
| `event/<boardId>/<16位序号>` | 不可变事件/outbox |
| `receipt/<boardId>/<operationId>` | 请求指纹，防止重复或异义提交 |

看板编号使用同文件的计数器与反向索引。计划及派发目前在 board 清单的 state.workflow 中，不另建伪数据库键。一个命令的所有控制记录在同一事务提交；回滚不发布其中任一变化。

正文超过 8 KiB 时先保存为同 SeqFile 的 `<sha256>.json` 资产并核验摘要/长度，再提交引用。失败可留下未引用资产，不会发布半个正文；自动垃圾回收和历史裁剪尚未启用。产物引用 `{name,ref,sha256,bytes}` 的权限与实际内容由宿主核验，引用字符串本身不授予文件访问。

VFS `seq:committed` 可用于唤醒宿主，但持久状态与定期补扫才是恢复依据。`content:finished` 在读取关闭时也会发出，不能当成任务完成。禁止直接改内部 JSON 或用普通文件复制覆盖活动数据库；外部 Agent 应调用授权命令接口。

## 生命周期与宿主边界

关闭顺序：停止事件/定时准入 → service.quiesce（拒新操作、等待已准入事务）→ 排空执行适配器 → 最后关闭 VFS。宿主重启后扫描持久派发、检查原执行身份并补投 outbox。SeqFile 不能与模型调用、远程服务或另一数据库组成单一事务，执行桥必须保留提交前日志和 unknown 状态。

NestOS 的默认目录、远程 HttpSeqClient、Session 来源读取、发布 Agent/Flow、Kernel 回执、系统 notify 与调度接线均位于 `backend/app-core/src/kanban/`。扫描状态机、批量提交、远程事务编码与执行恢复归独立库；UI 的 NestOS 包装位于 `ui/app-shell/src/kanban/`。应用入口只导出实际 NestOS 绑定，不代转出库 API，核心没有这些运行依赖。完整规范见 [Kanban 协调设计](https://github.com/nest-agentos/NestOS/blob/main/doc/design/kanban-coordination.md)。

会话活动入口 `executionSession(boardId, itemId)` 只读取当前执行摘要。显式传入 `{includeRelated: true}` 时，通过可选 `KanbanSessionSource.related` 合并宿主关联与已有执行绑定、参与者；返回的 `sessions` 按不透明 Session ID 去重，各自包含用途和 `executions` 执行记录。续办在同一 Session 下保留不同尝试，`current` 仅由正式执行绑定决定。UI 在展开「相关会话」时加载，支持刷新和宿主注入的原始资源链接；普通活动轮询不读取历史。资源属性由宿主提供，库不识别工作区、Git 或原生会话协议。

## Optional automation integration

Boards may store automation settings with opaque planner/executor references and trusted coordinator/worker principals. `configure-automation` changes configuration only; the host owns model calls and scheduling. Existing unassigned work may join a sealed plan with `expectedRevision`; adoption preserves its identity and manual dependencies. `edit-item` updates unplanned work while published definitions remain immutable. Execution bridges accept a dynamic `autoDispatch` predicate so pausing prevents new claims while existing admissions are still inspected. Optional client `automationCatalog` and `analysisStatus` ports supply the generic configuration UI and analysis details.

宿主已有工作区导航时，可直接构造 `KanbanWorkbench` 并省略 `sidebar`，通过 `createBoard()` 接入导航动作，通过 `committed` 刷新目录；`mountKanban` 的独立默认侧栏保持可用。父项详情提供子事项分页与新建入口，子项通过 `planning.parentId` 关联父项，执行依赖仍单独保存在 `planning.dependencies`。

Task 的持久 startAt、编辑租约、单一状态投影与文件协议见 [执行规范](https://github.com/nest-agentos/NestOS/blob/main/doc/design/kanban-task-execution.md)。`item().task` 和 query 的 `task` 为相同宿主事实的投影，`phase` 过滤在服务端执行。
