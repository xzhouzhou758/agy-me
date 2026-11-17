# agy-me

自用多后端 AI 网关与网页管理面板，把 **[CLIProxyAPI（CPA）](https://github.com/router-for-me/CLIProxyAPI)**、**[Antigravity-Manager（AGM）](https://github.com/lbjlaq/Antigravity-Manager)** 和纯自用 **[AIStudio2API](https://github.com/Mag1cFall/AIStudio2API)** 统一收口到一个入口和一个控制台。单用户密码登录，Node 24 直接运行 TypeScript，运行时零依赖，轻巧省内存。

功能细节见 [docs/功能说明.md](docs/功能说明.md)。

## 核心能力

- **AGY 双后端一键秒切**：网页内一键切换主入口 `/v1` 走 **CPA** 或 **Antigravity-Manager**，客户端无需改地址和密钥；支持为单个 API 密钥单独指定固定后端。
- **双边凭证互通与原生面板**：CPA ↔ Antigravity-Manager 一键双向同步 / 导入 OAuth 凭证；在面板内安全代理打开 `/cpa/` 与 `/agm/` 原生后台，真实密钥不落浏览器。
- **纯自用 AI Studio**：独立管理自己的 Google AI Studio Cookie 凭证，零分流、零共享，可通过专属 `/ais2/v1` 或主入口 `ais2/模型名` 前缀直达调用。
- **额度、日志与防封号**：四族额度圆环、403/401 自动停用与探测恢复、按额度自动排除模型、统一请求日志（按 `CPA / AGM / AI Studio` 筛选）与 Token 统计、内置远程 Chrome。

## 一键部署（新用户）

服务器上装好 Docker（带 Compose v2 插件），执行：

```sh
curl -fsSL https://raw.githubusercontent.com/xzhouzhou758/agy-me/main/deploy.sh | bash
```

向导会依次引导你选择：安装目录、面板端口、路径前缀（默认 `/me`）、登录密码，以及按需勾选内置或外连的 **CPA**、**Antigravity-Manager**、**AI Studio** 后端（至少启用一个即可），全自动生成配置并启动。

## 已有老用户如何更新

**老用户无需卸载、不会丢失账号、密码或 API 密钥**，直接重新运行同一条脚本即可：

```sh
# 方式 A：交互升级（重跑同一命令，直接回车选 1）
curl -fsSL https://raw.githubusercontent.com/xzhouzhou758/agy-me/main/deploy.sh | bash

# 方式 B：全自动无缝升级（不交互，直接保留全部配置和数据升级镜像）
curl -fsSL https://raw.githubusercontent.com/xzhouzhou758/agy-me/main/deploy.sh | bash -s -- --upgrade
```

脚本检测到已有安装后提供 3 个选项：
1. **无缝升级（默认推荐）**：自动备份 `.env`、`docker-compose.yml` 和 `cpa/config.yaml`，拉取新版镜像，把旧版内存上限从 `128m` 升级到 `256m`、自动挂载模型目录并原地补齐 `send-keepalive-before-ft: true`（保持 `cpa/config.yaml` inode 和原密钥不变）。
2. **升级并增配后端**：免重输密码和 CPA 配置，直接增量开启 **Antigravity-Manager** 或 **AI Studio** 容器（或连接你机器上已跑起来的实例）。
3. **全新重配向导**：保留 `data/` 账号与日志数据，重新配置所有选项。

> **客户端接入小提示**：升级后，你以前填在酒馆 / Luker 里的 `:8318/v1` 地址**依然继续可用**；如果想使用网页上的 **CPA ↔ AGM 切换开关** 或 **`ais2/` 模型直连**，只需把客户端 API 地址改为 `http://服务器:8321/me/v1`（密钥还是原来的）。如果前面有 Nginx / OpenResty 反代，记得把 `/me/v1` 也转到 `8321` 并关闭 `proxy_buffering`。

镜像：`ghcr.io/xzhouzhou758/agy-me`（`latest`、版本号，支持 `amd64` / `arm64`）。

## 手动部署

```sh
git clone https://github.com/xzhouzhou758/agy-me.git /opt/agy-me
cd /opt/agy-me
cp deploy/agy-me.env.example agy-me.env && chmod 600 agy-me.env
cp deploy/docker-compose.yml docker-compose.yml
```

1. 生成登录密码哈希填入 `agy-me.env` 的 `APP_PASSWORD_HASH`：
   ```sh
   printf '你的密码' | docker run --rm -i ghcr.io/xzhouzhou758/agy-me:latest node src/passwd.ts
   ```
2. 根据要用的后端填写 `CPA_URL`/`CPA_MANAGEMENT_KEY`、`AGM_URL`/`AGM_API_KEY`/`AGM_ADMIN_PASSWORD` 或 `AISTUDIO2_URL`/`AISTUDIO2_KEY`；如需一并拉起可选内置容器，带上对应 profile 启动：
   ```sh
   docker compose --profile agm --profile aistudio2 up -d
   ```

更多部署示例与 Nginx 反代说明见 [deploy/](deploy/) 与 [docs/功能说明.md](docs/功能说明.md)。

## 环境变量速查

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `APP_PASSWORD_HASH` | — | 登录密码 scrypt 哈希（必填，设置页修改后以 `state.json` 为准） |
| `APP_PASSWORD_RESET` | 空 | `1`＝启动时重置回 env 密码（用完删掉） |
| `CPA_URL` / `CPA_MANAGEMENT_KEY` | `http://127.0.0.1:8318` / 空 | CPA 管理地址与密钥（与 AGM / AI Studio 至少启用一项） |
| `AGM_URL` / `AGM_API_KEY` / `AGM_ADMIN_PASSWORD` | 空 | Antigravity-Manager 地址、代理 Key 与管理密码 |
| `AISTUDIO2_URL` / `AISTUDIO2_KEY` | `http://127.0.0.1:18803` / 空 | AIStudio2API 地址与调用 Key（空则关闭 AI Studio 页） |
| `AISTUDIO2_ADMIN_USER` / `AISTUDIO2_ADMIN_PASSWORD` | `admin` / 空 | AIStudio2API 管理员账密 |
| `AISTUDIO2_MODE` | `exclusive` | `exclusive`（单机独占自动认领）\| `shared`（与它站共用引擎时严格隔离） |
| `AISTUDIO2_RECHECK_MINUTES` | `60` | AI Studio 账号定时巡检周期（分钟，0 关闭） |
| `HOST` / `PORT` / `BASE_PATH` | `127.0.0.1` / `8321` / 空 | 监听地址、端口与路径前缀（容器内设为 `0.0.0.0`） |
| `DATA_DIR` | `./data` | 数据持久化目录（含 `state.json`、`client-keys.json`、`usage.sqlite`、`aistudio2.sqlite`） |
| `MAX_BODY_MB` / `UPSTREAM_TIMEOUT_MS` | `20` / `300000` | 单次请求体上限与上游超时时间 |
| `USAGE_RETENTION_DAYS` / `QUOTA_REFRESH_MINUTES` | `30` / `15` | 日志保留天数与额度后台刷新周期 |

## 本地开发

```sh
npm install
npm run check   # TypeScript 严格类型检查
npm test        # 全量单元与多后端集成测试
npm run dev     # 本地 mock CPA 预览（http://127.0.0.1:8321/me/ ，密码 agyme-dev）
```
