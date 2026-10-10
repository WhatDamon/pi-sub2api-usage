# pi-sub2api-usage

在 Pi 的 footer 里常驻显示当前 sub2api 站点的余额与今日实付消耗。**只读**、零配置、零定时器。

## 与 `pi-sub2api` 的区别

`pi-sub2api` 类扩展的核心是**注册 provider 与模型发现**：启动时拉 `/v1/models`、判断 wire protocol、写 `auth.json`。余额展示只是它们的副产品。

这个扩展只做余额这一件事，因此完全不碰流量路径——不注册 provider、不拉模型列表、不改任何推理请求。

## 安装

试用（不写入配置）：

```bash
pi --extension ./src/index.ts
```

作为本地包声明：把这个目录加进 Pi 的扩展列表，或用 `pi install` 指向它。包清单里已声明 `pi.extensions`。

## 用法

- **footer**：`sub2 $1.8849 · 今 $0.1312` —— 可用余额与今日**实付**消耗。
- **`/sub2-usage`**：输出完整明细（余额、今日、累计、近 3 日、按模型），金额主显实付，原价在括号里。

footer 的状态读法：

| 显示 | 含义 |
| --- | --- |
| `sub2 $1.8849 · 今 $0.1312` | 正常 |
| `sub2 ~$1.8849 · 今 $0.1312` | 刷新失败，`~` 表示显示的是上次成功值 |
| `sub2 !` | API Key 无效或已过期 |
| `sub2 ?` | 请求失败且没有可用的旧值 |
| （空） | 当前模型不是 sub2api 站点 |

## 一条重要的语义

**余额按用户共享，用量按 API Key。**

同一个 sub2api 站点上，如果配置了多个 Key 指向同一账号，它们会返回**完全相同**的余额，但各自的 `usage` / `model_stats` 是分开统计的。所以看到「另一把 Key 余额一样但消耗是 0」不是故障。

正是因为这个，钱包形态下详情页的余额行会标注「多 Key 共享」。

## 前提与要求

- **需要在 Pi 自己的配置里已经配好 sub2api 站点**（`models.json` 里的 provider，凭证可解析）。扩展不读 CC Switch / Claude Code / Codex 的配置文件。
- Node ≥ 22.19。
- 站点需提供 `GET {base}/v1/usage`（接口带 Bearer API Key 认证）。老版本 sub2api 若没有这个端点，会被静默判为「非 sub2api 站点」。

## 刷新时机

`session_start`、每轮 agent 结束（`agent_settled`）、切换模型（`model_select`）、以及手动执行 `/sub2-usage`。

没有定时器、没有后台轮询——每次会话的正常请求数是「1 + 轮数」，每次超时 5 秒。所有请求都是 fire-and-forget，不会阻塞对话。

## 安全

- 凭证只从 Pi 自身配置读取，只发送到该配置项声明的 `baseUrl`。
- API Key 只放在 `Authorization` 请求头，绝不进 URL。
- 任何日志与错误信息只出现 provider 名与 Key 的 sha256 前 8 位指纹，**绝不输出完整 Key**。
- 不落盘、不写回任何配置文件。

## 开发

```bash
npm test          # vitest，全部离线
npm run typecheck # tsc --noEmit
```
