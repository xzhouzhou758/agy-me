# agy-me

自用 [CLIProxyAPI（CPA）](https://github.com/router-for-me/CLIProxyAPI) 的网页管理面板：账号管理、额度查询、请求日志、用量统计，403 封号自动停用与探测恢复。单用户，一个密码登录，Node 24 直接跑 TypeScript，运行时零依赖，内存 ~50MB。

功能细节见 [docs/功能说明.md](docs/功能说明.md)。

## 一键部署

服务器上装好 docker（带 compose），执行：

```sh
curl -fsSL https://raw.githubusercontent.com/xzhouzhou758/agy-me/main/deploy.sh | bash
```

脚本会一步步问你：安装目录、端口、访问路径前缀（默认 `/me`）、登录密码、CPA 是顺带装一个新的还是接你已有的。然后自动生成 `.env` 和 `docker-compose.yml`、拉镜像、启动，最后打印访问地址。

**升级**：同一条命令再跑一次，选「只升级镜像」即可，配置和数据都不动。

镜像：`ghcr.io/xzhouzhou758/agy-me`（`latest`、版本号，amd64 / arm64）。

## 手动部署

```yaml
# docker-compose.yml
services:
  agy-me:
    image: ghcr.io/xzhouzhou758/agy-me:latest
    container_name: agy-me
    env_file: .env
    environment:
      HOST: 0.0.0.0
    ports:
      - "8321:8321"
    volumes:
      - ./data:/app/data     # 容器内用户是 uid 1000：mkdir data && chown 1000:1000 data
    restart: unless-stopped
```

生成密码哈希，填进 `.env`：

```sh
printf '你的密码' | docker run --rm -i ghcr.io/xzhouzhou758/agy-me node src/passwd.ts
```

```sh
# .env
APP_PASSWORD_HASH=scrypt:...
CPA_URL=http://你的CPA:8318
CPA_MANAGEMENT_KEY=CPA 的管理密钥明文
BASE_PATH=/me
```

`docker compose up -d`，打开 `http://服务器:8321/me/`。CPA 的配置模板（含用量队列开关）见 [deploy/cpa-config.example.yaml](deploy/cpa-config.example.yaml)，agy-me 靠 CPA 的 `usage-statistics-enabled` 队列记请求日志。

> 公网请在前面套 nginx / Caddy 上 https。远程浏览器页需要宿主机跑 `ops/browserd.py`，一般用不到，不配就自动隐藏。

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `APP_PASSWORD_HASH` | — | 登录密码的 scrypt 哈希（必填，或用明文 `APP_PASSWORD` 仅限调试）。设置页改过密码后以 `data/state.json` 里的为准 |
| `APP_PASSWORD_RESET` | 空 | `1`＝启动时丢掉设置页改的密码，回到 env 里的；用完删掉 |
| `CPA_URL` | `http://127.0.0.1:8318` | CPA 地址 |
| `CPA_MANAGEMENT_KEY` | — | **必填**，CPA 管理密钥明文 |
| `HOST` / `PORT` | `127.0.0.1` / `8321` | 监听地址（容器里要设 `0.0.0.0`） |
| `BASE_PATH` | 空 | 访问路径前缀，如 `/me` |
| `DATA_DIR` | `./data`（镜像里 `/app/data`） | 数据目录 |
| `USAGE_RETENTION_DAYS` | `30` | 请求记录保留天数 |
| `USAGE_POLL_MS` | `5000` | 取 CPA 用量队列的间隔 |
| `QUOTA_REFRESH_MINUTES` | `15` | 后台刷新额度间隔，0 关闭（设置页可改） |
| `QUOTA_CONCURRENCY` | `4` | 同时查几个号 |
| `AUTO_DISABLE_SWEEP_MS` / `AUTO_DISABLE_PROBE_SECONDS` / `AUTO_DISABLE_IDLE_SECONDS` | `30000` / `1800` / `3600` | 403 自动停用的巡检、探测、闲置判定，一般不用动 |
| `QUOTA_BASE_URLS` / `QUOTA_USER_AGENT` | Google 三个地址 / Antigravity UA | 一般不用动 |
| `COOKIE_SECURE` | 自动 | 自动＝经 https 才带 Secure；`1` / `0` 强制 |
| `TRUST_PROXY` | `1` | 信任反代的 `X-Real-IP` / `X-Forwarded-*`（登录限速按 IP） |
| `SESSION_DAYS` | `30` | 登录有效期 |
| `MAX_BODY_MB` | `20` | 请求体上限 |
| `BROWSERD_URL` / `BROWSERD_TOKEN` / `BROWSER_UPSTREAM` / `BROWSER_IDLE_MINUTES` | 见 `ops/` | 远程浏览器（可选），Token 为空就隐藏该页 |

## 本地开发

```sh
npm install
npm run dev     # mock CPA + 假数据，http://127.0.0.1:8321/me/ ，密码 agyme-dev
npm test
```
