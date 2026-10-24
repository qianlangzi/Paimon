---
description: "Paimon 任务治理层：任务与运行的生命周期、有限重试、截止时间协调与基于证据的完成验证。扩展 Paimon 自有领域规则（而非 harness 本身）时阅读本文。"
kind: "package-reference"
---

# @deepseek-ai/dsh-paimon-task-runtime

中文 | [English](README.md)

## 概述

DSH 已经拥有 Agent Loop、工具执行流水线、审批 seam、沙箱和仅追加的会话日志。它没有的是**任务**：一个跨越多轮、以可验证的终态结束、并且可以有限次重试的用户目标。

本包只提供这一层，别的一概不碰。它**全文不导入 DSH 或 Cordis**，这是刻意的：领域规则必须能在不启动 harness 的情况下测试，也不能不小心依赖 harness 内部实现。

## 为什么需要它

对上游源码的审计发现：仓库里根本没有任务生命周期——在全部 `packages/*/src` 中检索 `TaskStatus`、`interface Task`、`taskId`，零命中。harness 用 `Session -> Turn -> Step` 组织工作，这对"对话"是正确的形状，对"目标"则不是：

- Turn 无法表达"这个目标在四次尝试后仍未完成"。
- Step 无法区分**本次运行失败**和**任务失败**。
- 没有任何东西判定工作是否真的完成，只有模型这么说。

因此以下四件事属于 Paimon 而不属于 harness：任务状态机、带重试预算的运行记录、任务级截止时间协调、以及基于证据的完成验证。

## 使用本包

```ts
import {
  TaskRuntime,
  testReportRule,
  type Evidence,
} from '@deepseek-ai/dsh-paimon-task-runtime'

const runtime = new TaskRuntime({ knownSecrets: [process.env.API_KEY ?? ''] })

const task = runtime.createTask({
  goal: '让失败的测试通过',
  workspace: '/repo/project',
  deadlineMs: 10 * 60_000,
  rules: [testReportRule({ id: 'tests', description: '单元测试通过' })],
})

runtime.startRun(task.id)

// 每个有副作用的调用都必须先过闸。
const gate = runtime.gateToolCall(task.id, { toolId: 'bash', path: '/repo/project/src/a.ts' })
if (gate.kind !== 'allow') return

const evidence: Evidence[] = [
  { id: 'e1', kind: 'test-report', ref: 'suite:unit', passed: true, detail: '42 passed' },
]

const outcome = runtime.completeRun(task.id, evidence, '测试通过')
if (outcome.kind === 'succeeded') {
  // 任务已 SUCCEEDED，验证报告挂在 finalResult 上。
}
```

### 生命周期

```text
PENDING -> RUNNING -> WAITING_APPROVAL -> RUNNING
                  \-> SUCCEEDED | FAILED | CANCELLED | TIMED_OUT
```

每个终态的转换列表都为空，因此 `SUCCEEDED -> RUNNING`、`CANCELLED -> RUNNING`、`TIMED_OUT -> SUCCEEDED` 是**结构上不可能**，而不只是"不推荐"。

### 重试

只要重试预算还在，失败的**运行**不会让**任务**失败。任务保持 `RUNNING`，下一次 `startRun` 追加第 `n + 1` 次尝试；上一次运行永久保留其终态。只有预算耗尽时任务才进入 `FAILED`，因此任何任务都不需要为了表达"重试"而被复活。

`decideRetry` 按固定顺序判断：先取消，再截止时间，再失败类别，最后尝试预算。取消优先于一切——"拒绝不能通过重试绕过"由此由结构保证，而不是靠约定。

### 取消

`requestCancel` 只记录意图，不改其他任何状态。`acknowledgeCancel` 是唯一会把状态改为 `CANCELLED` 的方法。把两者分开，才能让调用方诚实地区分"已请求取消"与"执行尚未停止"。

### 验证

`ResultValidator` 拒绝把 `model-claim` 当作证据。模型声明在任何规则运行之前就被过滤掉，因此只靠"模型说它能跑"支撑的任务会报告 `not-checked`，永远不会是 `passed`。没有配置任何规则的任务永远无法通过验证。

### 脱敏

每个被记录的事件都会经过 `redactRecord`。名字像凭证的字段会被替换，调用方提供的 `knownSecrets` 会从自由文本中擦除。遍历有深度上限且能处理环，因为脱敏跑在日志路径上，绝不能成为任务失败的原因。

## 已知限制与延期工作

- **仅词法的工作目录边界。** `checkWithinWorkspace` 规范化并比较路径段，看不到 `workspace/link` 指向 `/etc` 的情况。需要该保证的调用方必须先对两侧路径做 `fs.realpath`。此处明确写出，而不是默默暗示。
- **仅内存持久化。** `MemoryTaskStore` 不持久。`TaskStore` 是后续 SQLite 或 JSONL 适配器要实现的端口。
- **尚无 harness 适配器。** 目前没有任何代码把 `tools/pre-execute` 接到 `gateToolCall`、把 `session/event` 接到 `TaskEvent`。该适配器是下一个里程碑；在它出现之前本包保持与 harness 无关。
- **单个活跃运行。** 运行时假定每个任务同一时刻只有一个运行。并行尝试需要 PRD 尚未定义的调度规则。
- **无跨进程协调。** 截止时间在被询问时才求值，不由定时器驱动。从不调用 `enforceDeadline` 或 `gateToolCall` 的调用方会看到过期状态。
- **不符合上游发布门禁。** 本包为 `private: true` 且不声明上游仓库地址，因此 `pnpm run constraints` 会对它报警。它是存在于 fork 树中的 Paimon 代码，不是上游发布成员。
