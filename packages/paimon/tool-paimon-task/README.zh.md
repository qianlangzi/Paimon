---
description: "面向模型的 Paimon 任务控制：创建任务、读取任务状态、并基于已观测证据尝试完成任务。修改「模型能对任务做什么」时阅读本文。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-paimon-task

中文 | [English](README.md)

## 概述

面向模型的三个任务治理控制：

| 工具 | 作用 |
|---|---|
| `paimon_task_create` | 创建任务、绑定到调用方 agent、启动第 1 次尝试 |
| `paimon_task_status` | 报告状态、尝试次数、近期事件与完成条件 |
| `paimon_task_finish` | 用已观测证据检查完成条件，全部通过才关闭 |

## 本包划的那条线

**模型决定何时检查，不决定什么算数。**

`paimon_task_finish` 无法断言成功。它去问验证器，而验证器只读适配器从真实工具结果里观测到的证据。模型在 summary 里写"全都过了，信我"，拿到的是 `completed: false`——因为 summary 不是证据。

`paimon_task_finish` 也不会因为**检查太早**而让任务失败。它先探测（`TaskRuntime.checkCompletion`），条件不满足时保持运行打开，所以过早检查的 agent 可以继续干活，而不是误手关掉自己的任务。

## 完成模式

`paimon_task_create` 必须指定 `completion` 模式，因为没有规则的任务永远无法被验证：

- **`tests`**（默认）——需要一份通过的测试报告。只有当部署在 `@deepseek-ai/dsh-paimon-task-harness` 里声明了测试工具时才存在；未声明的运行器会让任务无法验证，这是诚实的结果，而不是盖个章。
- **`tool-success`**——只要求有某个工具调用成功过。为那些正确性无法机器校验的任务提供，且刻意不作为默认：它能证明的东西很少。

更丰富的策略语言是被有意否决的。让模型自己描述成功条件，等于把 PRD 4.3/CODE-006 明确不给它的权力交给它。

## 使用本包

```yaml
- name: '@deepseek-ai/dsh-paimon-task-harness'
  config:
    testTools: ['run_tests']
- name: '@deepseek-ai/dsh-tool-paimon-task'
```

模型随后看到：

```text
paimon_task_create { goal, workspace, deadline_ms?, completion? }
paimon_task_status {}
paimon_task_finish { summary }
```

`workspace` 是必填而不是有默认值。没有 workspace 的任务会拒绝所有涉及路径的调用，而悄悄用进程目录顶替，等于在调用方没说明的情况下放宽边界。

## 已知限制与延期工作

- **没有放弃路径。** 既无 deadline 又没成功完成的任务会一直停在 `RUNNING`。要关闭它需要在领域模型里加 `abandoned` 错误类型，这被推迟了；在此之前请传 `deadline_ms`。
- **没有任务列表与取消工具。** 只能触达调用方 agent 自己的任务。让模型侧能列出和取消会使其干扰其他会话，两者都等 UI 里程碑。
- **证据是进程内的。** 累积证据存在 `TaskBindings` 的内存里，重启即丢失，所以任务无法跨重启恢复——尽管它的状态机本来能表达这一点。
- **时间线里没有对话结构。** 事件只来自工具流水线，轮次与步骤边界尚未投影。
- **一个 agent 一个任务。** agent 已绑定时 `paimon_task_create` 会失败，因为重新绑定会让一个仍有活跃运行的任务成为孤儿。
