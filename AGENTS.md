# @nestos/kanban

独立、平台中立的看板领域与协调模块。运行依赖仅允许可选 peer @nestos/vfs-core；DOM 界面和 CSS 位于独立 @nestos/kanban-ui，不依赖 ui-common 或应用包。

- contracts 为无 I/O 的公开 DTO 与纯函数，包含 KanbanClient、状态投影和引用编解码。应用从公开入口导入，不代转出库 API。
- module 负责准入、授权、诊断及关停；reducer 不进行 I/O。SeqFile 事务原子提交状态、依赖、派发意图、事件和幂等回执。
- runtime 普通入口只导出 createKanbanRuntime 与数据契约，实例不暴露 store、journal、fs 或 serviceFor。integration 只供受信任宿主自定义装配，不透传为远程工具能力。
- 执行适配器接收意图、持久句柄和正式回执，不引入 Session、Flow、Kernel、Agent SDK、全局事件或 NestOS 目录约定。
- prepare 不提交外部执行，提交前冻结绑定与身份；unknown 不释放责任、不自动重派。只有正式未启动回执允许重试原请求。
- 执行成功与验收通过分开；产物必须核对归属、摘要和字节数。sealed 计划不能通过普通命令绕过派发与验收。
- 控制意图与对应正式回执分开。不支持控制须保留具体错误，不得宣称已取消。父子计划、决策和删除协调由库负责。
- delete-board 保留墓碑、原状态、资源关联和事件；拒绝未结算执行。来源删除和资源清理由宿主复验权限与实际生命周期。
- scan 对获授权的删除墓碑只重试 onCommitted，不重放协调命令；示例安装不能复活墓碑。
- 健康执行观察不追加事件，不推进事项 revision/updatedAt；错误变化和恢复仍保留审计。心跳/读取时间不能证明执行完成。
- 日志记录稳定操作身份、阶段、结果和安全错误分类，不记录正文、完整参数或凭据。工作日志投影与领域状态分开。
- src/utils/random.ts 提供兼容 UUID，覆盖原生 randomUUID 缺失和抛错。具体业务通过外部 Tool/Flow 和预设接入。

验证：pnpm typecheck、pnpm test、pnpm build。普通接入与恢复验收见 tests/public-runtime.test.ts；前台与远程客户端验收由 kanban-ui 自己维护。
