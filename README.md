# 授权行情研究源

该服务用于保留已获授权的来源材料及其收件证据。当前提供原始资料接收、字节摘要、来源元信息检查和收件查询，并已开放结构化收件：按项目约定的 FAST 1.1 模板范围把来源报文还原为可核对记录，不做交易或行情预测。来源服务和样例均在本机运行；资料中的单位、账号及标识都是合成值。

## 环境与运行

使用 Node.js 22.23.4。依赖通过 package-lock.json 锁定。准备环境时执行 `npm ci --ignore-scripts --no-audit --no-fund`，之后运行、构建、测试和演示均不下载资源。

```sh
npm run build
npm test
npm run demo
npm start
```

`npm start` 输出本次监听地址；服务绑定回环地址，来源网关与接收端在同一进程内使用独立端口。`DATA_DIR` 指定收件目录，默认 `./var`；`SCENARIO` 选择 fixtures/scenarios.json 中的来源场景。`npm run demo` 从临时空目录启动、实际领取来源字节、查询收件并退出，不回放旧日志。 `PORT` 可指定接收服务端口；未设置时仍自动选择空闲端口。

## 容器

```sh
docker build -t fast-feed-intake:local .
docker run --rm --network none fast-feed-intake:local npm test
docker run --rm --network none fast-feed-intake:local npm run demo
```

镜像构建准备阶段完成依赖安装，运行不需要公网服务。接口约定见 `docs/接入约定.md`，来源格式范围见 `docs/来源格式.md`。`src/source-metadata.mjs` 只识别文件元信息，不代表已提取结构化记录。文件收件与完整业务覆盖是不同状态。

## 结构化收件

`POST /v1/intakes` 传 `{"mode":"structured"}` 即按 FAST 1.1 解码。接收端先取得并留存原文、模板与 manifest 三份证据（以 SHA-256 寻址），再依据模板的字段操作符、可选值和 presence map 解释每一帧，记录保留 `templateId`/`templateName` 与字典作用域上下文。

字典不是每条消息独立的：`global`/`template`/`type` 作用域及显式 key 跨消息沿用，来源声明的显式重置（manifest 的 `resets`）会清空字典。检测到源流序号缺口后，依赖字典状态的消息停止发布，对应帧只保留原文并标记 `blocked`，直到合法的显式重置恢复解释依据；接收端不会沿用陈旧值拼凑连续行情。无法按承诺范围解释的模板扩展保留原文并报告，不假装完整解析。

每条记录携带 `session`、`sequence`、`offset`、`length`、`rawDigest` 与 `rawHex`，原始报文与解码记录可相互定位；`recordId` 由会话、序号、偏移和摘要派生，相同字节在不同会话中身份不同，且不依赖数组下标。收件 `state` 为 `complete`/`partial`/`rejected`，仍有未知缺口时不会写 `complete`。
