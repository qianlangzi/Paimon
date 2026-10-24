---
description: "Paimon 任务适配器：把任务绑定到 agent，并将工具流水线、审批 seam 与取消操作路由到任务治理层。连接 Paimon 与 harness 时阅读本文。"
kind: "package-reference"
---

# @deepseek-ai/dsh-paimon-task-harness

中文 | [English](README.md)

## 概述

`@deepseek-ai/dsh-paimon-task-runtime` 拥有任务状态机、重试预算、截止时间和证据验证，对 harness 一无所知。本包是另一半：把它接到 harness **既有的**扩展点上，而不是替换任何一个。

| Harness 扩展点 | 变成 |
|---|---|
| `tools/pre-execute` waterfall | `TaskBindings.gate` → `PreToolDecision` |
| `ctx.approval` seam | `TaskBindings.resolveApproval` |
| `tools/result` 观测 | `TaskBindings.recordToolOutcome` → 证据 |
| `agent.cancel` / `agent.whenIdle` | 取消的请求与确认 |

两套决策词汇几乎同构——`allow`、`deny`、`ask`、`cancel`——所以适配器很薄，而不是一个平行的策略引擎。

## 唯一重要的安全属性

**未绑定任务的 agent 绝不受影响。** 没有绑定任务时，每个路由方法都返回 `undefined`，监听器原样委托下去。如果适配器给每个会话都偷偷造一个任务，就会改变从未要求此功能的用户的行为。

这条由四个专门的测试覆盖（`bindings: an unmanaged agent is never touched`）。

## 使用本包

```ts
// 插件把自己注册为 ctx.paimonTasks。
const task = ctx.paimonTasks.bind(agent, {
  goal: '让失败的测试通过',
  workspace: '/repo/project',
  deadlineMs: 10 * 60_000,
  rules: [testReportRule({ id: 'tests', description: '单元测试通过' })],
})

ctx.paimonTasks.runtime.startRun(task.id)

// 此后该 agent 的每次工具调用都会过闸。工作完成时：
const evidence = ctx.paimonTasks.bindings.evidenceOf(agent)
ctx.paimonTasks.runtime.completeRun(task.id, evidence, '测试通过')

// 停止：记录请求、取消轮次，并且只在 agent 真正空闲后才确认。
await ctx.paimonTasks.cancel(agent)
```

### 配置

```yaml
- name: '@deepseek-ai/dsh-paimon-task-harness'
  config:
    approvalTools: ['bash']      # 需要人工决定的工具
    testTools: ['run_tests']     # 成功即代表测试通过的工具
    pathArgumentKeys: ['path', 'file_path']
    deadlineMs: 600000
    knownSecrets: []
```

每个字段的默认值都取最不意外的那个：`approvalTools` 为空，因此适配器绝不会为 harness 本来会静默执行的工具开始弹窗。

### 审批是委托，不是重写

适配器自己调用 `ctx.approval.request()`，而不是返回 `{kind:'ask'}` 让流水线去问。这多一跳，但只有这样任务才能停在 `WAITING_APPROVAL`——PRD 4.4/SEC-003 要求待决定状态是一个**任务状态**，而不是流水线里一次不可见的暂停。

任何投递失败（包括在未打开的轮次外提问）都按拒绝处理。问不出来的审批不等于批准。

## 开发备注

**Service 的实例状态必须用 TypeScript `private`，不能用 `#private`。** Cordis 会把 `Service` 包在 `Proxy` 里，而 ECMAScript 私有字段无法穿过它读取——proxy 的 receiver 不是声明该字段的实例。首次集成运行就报 `Cannot read private member #x from an object whose class did not declare it`；`ApprovalService` 用 TypeScript `private` 正是同一原因。Cordis 对象图之外的普通类（`TaskRuntime`、`TaskBindings`）不受影响，继续用 `#`。

**`tests/pipeline.spec.ts` 是接线证明。** 它挂载真实的 `ToolRuntime`、`NativeToolExecutor` 和 `ApprovalService`，再通过 `executeToolFixture` 驱动调用，所以跑的是**随发行版交付的那条** `tools/pre-execute` waterfall。单元测试证明适配器自洽；这一条证明它接上了。

## 已知限制与延期工作

- **任务创建是程序化的。** 目前没有面向模型的工具，也没有 UI 来创建任务；调用方必须在代码里调 `bind()`。`paimon_task_create` 工具是下一个里程碑。
- **尚未映射 `session/event`。** 证据只来自 `tools/result`。轮次与步骤边界还没有投影到任务时间线，所以任务历史能看到工具调用，看不到对话结构。
- **路径边界是词法的且范围窄。** 只有当声明的参数键里放着路径时才生效。命令里内嵌路径的 shell 工具不在覆盖范围内，符号链接也不解析。两点都明确写出而非暗示。
- **测试证据需要声明。** `testTools` 指定哪些工具的成功算作测试通过报告。适配器不会从任意输出里解析报告，因此未声明的测试运行器只产出 `tool-result` 证据，任何测试规则都不会接受它。
- **证据只存在内存里。** `TaskBindings` 用 `Map` 按任务累积证据，进程重启即丢失。持久化证据需要存储适配器里程碑。
- **依赖审批 seam。** 插件同时注入 `tools` 与 `approval`，因此缺少 `user-approval` 的部署不会激活它——这是可见的失败，而不是静默降级。
- **一个 agent 一个任务。** 重复绑定会被拒绝而不是替换第一个任务，因为替换会让一个仍有活跃运行的任务成为孤儿。
