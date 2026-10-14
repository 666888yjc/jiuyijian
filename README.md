# 就医笺 · 就诊交接单

[![CI](https://github.com/666888yjc/jiuyijian/actions/workflows/ci.yml/badge.svg)](https://github.com/666888yjc/jiuyijian/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-22.12%2B-brightgreen.svg)](https://nodejs.org)

给家里人去门诊用的东西：把散在各处的病历、化验单、处方、出院小结，整理成**患者自己能核对、医生看得懂**的一张交接单。手机或电脑浏览器打开就能用，可以离线，数据默认只留在你自己手上。

> **先说清楚它是什么、不是什么。**
> 这是一个家庭自用的小工具，**未经临床专业审核**。它只做信息整理与转写：**不诊断、不给用药建议、不建议改药或停药、不判断指标高低**。任何一条自动识别出来的内容都必须由你逐条确认后才会进入交接单；没确认的一律不进。看病请以医生意见为准，紧急情况请立即就医。

## 一分钟跑起来（数据不出你这台电脑）

需要 **Node.js 22.12+（22.x 系列；其他版本会被 preinstall 拦住，这是有意的）**：

```bash
npm ci                # 安装（lockfile 冻结）
npm run build         # 类型检查 + 构建，产物在 dist/
node dev/local-app/server.mjs
```

启动后屏幕上会给出一条局域网地址（例如 `http://192.168.x.x:4340/`）和一个口令；手机连**同一个 WiFi**，用浏览器打开那个地址、输口令，就能新建就诊任务、拍照上传、逐项核对、打印或导出交接单。任务数据与原件都写在这台电脑的一个目录里（默认 `C:\Users\<你>\jiuyijian-local`），不在仓库里，也不上传到任何云服务。

要自动识别，就把图片发往**你自己指定的**一个兼容端点（不配也能用，界面上会照实说明"识别服务暂时不可用，可手工录入"）：

```bash
export JYJ_LOCAL_MODEL_KEY='你的密钥'
node dev/local-app/server.mjs --ai-endpoint https://<你选的端点>/v1/chat/completions --model <模型名>
```

- 密钥只从环境变量读，不写命令行、不落盘、不打印。
- 端点要求 `https`（只有 `127.0.0.1`／`localhost` 例外，方便你自测）。
- 若那家要求自定义鉴权头，加 `--auth-style wb`。

## 验证（三条命令，都是三态退出码）

```bash
npm test              # 本地夹具 HTTP 冒烟（回归层 B，53 条）
npm run test:e2e      # 本机链路端到端自证（真进程/真 HTTP/真落盘，34 条）
npm run typecheck     # tsc --noEmit
```

退出码：0 全过｜1 有断言红｜2 前置不满足。**没有"部分绿"**——看到 2 先解决环境，不要当通过。

## 两条硬规矩（写进了判据层）

1. **识别结果一律停在「待确认」**：入单闸门只看人确认过没有；高风险字段（药名、剂量、过敏史）不可能被自动写进交接单。
2. **界面上不许说没做过的事**：某次识别到底通没通、原件到底存在哪儿、这一条能不能回溯到原件——句子由代码里唯一的一处事实推导；不知道就不断言。

## 目录

| 路径 | 是什么 |
| --- | --- |
| `src/` | 前端（Vite + React + TS 的离线优先 PWA） |
| `public/sw-v2.js` | 离线壳（只在 https 环境注册） |
| `functions/` | 云端函数实现（同一套业务逻辑的托管版本） |
| `components/ui/` `lib/` | 界面底座（shadcn 风格组件，仅保留 `src/` 实际引用的 11 个） |
| `dev/local-app/server.mjs` | 本机链路：一个端口同时发前端与接住这些请求 |
| `dev/backend-local/` | 本机链路用的查询引擎、对象存储、静态托管与兼容传输层 |
| `dev/api-fixture/` `dev/fake-llm/` `dev/fake-ocr/` | 本地回归用的夹具与假模型服务（只绑回环） |
| `scripts/` | 构建与测试入口 |

## 已知限制（如实说明）

- **Node 版本**：只在 22.12+（22.x）验证过；`engines` 上限 `<23`。
- **识别**：不配端点时只能手工录入（界面会照实说明）；云端函数版（`functions/`）的部署说明不在本仓。
- **PDF**：云端通道的 PDF 自动识别尚不可用（界面标注"开发中"）；本机链路可解析 PDF 文字层。
- **离线壳**：只在 https（或 localhost）环境注册 Service Worker；`http://` 局域网地址下没有离线能力。
- **判据层不在本仓**：完整的历史验证记录（上千条静态断言、门禁体系）刻意没有随本仓公开；本仓提供的是可独立运行的冒烟与端到端自证。
- **打印**：交接单导出走浏览器打印对话框，各平台表现略有差异。

## 关于"能公开到什么程度"

这个仓库是**清洗过的干净导出**，不含运行日志、真实病历、凭据、平台内部标识或某台机器的绝对路径；导出前后各跑一次内容扫描，命中即拒绝导出。仓库里那条完整的历史（含踩过的坑与验证记录）没有公开。

## 参与贡献

见 [.github/CONTRIBUTING.md](.github/CONTRIBUTING.md)。医疗安全/免责表述问题有独立的 issue 通道；隐私与安全问题请按 [.github/SECURITY.md](.github/SECURITY.md) 私密报告，不要开公开 issue。

## 许可

Apache License 2.0，见 `LICENSE`。欢迎使用与改作，但请把"未经临床专业审核、不提供诊断或用药建议"这句话一起带走。
