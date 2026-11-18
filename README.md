# 授权行情研究源

该服务用于保留已获授权的来源材料及其收件证据。当前提供原始资料接收、FAST 结构化解码收件、字节摘要、来源元信息检查和收件查询。来源服务和样例均在本机运行；资料中的单位、账号及标识都是合成值。

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

## 结构化接收

结构化方式已开放：`POST /v1/intakes` 使用 `{"mode":"structured"}` 时，服务领取入口字节、来源清单与模板，按 `docs/来源格式.md` 约定范围解码 FAST 帧并保存 records、issues、coverage 与 evidence。字典上下文在帧之间延续；序号缺口或解码失败使解释依据失效，相关帧保留原文并标记 blocked，直到清单声明的重置帧恢复，不从输出数值猜测重置。模板或清单不可取得时形成 rejected 收件，原文仍保留。`npm test` 覆盖原始与结构化两种收件及缺口、重置、模板缺失场景。
