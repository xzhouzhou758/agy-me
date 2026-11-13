#!/usr/bin/env bash
# agy-me 一键部署 / 升级脚本（引导式）
#   curl -fsSL https://raw.githubusercontent.com/xzhouzhou758/agy-me/main/deploy.sh | bash
# 需要：docker（带 compose 插件）。可重复运行：已装过会问你是只升级还是重新配置。
set -euo pipefail

REPO="xzhouzhou758/agy-me"
IMAGE="${AGY_IMAGE:-ghcr.io/$REPO:latest}"
CPA_IMAGE="${CPA_IMAGE:-eceasy/cli-proxy-api:v8.0.66}"
RAW="https://raw.githubusercontent.com/$REPO/main"

say()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mxx\033[0m %s\n' "$*" >&2; exit 1; }

# 交互一律读终端（脚本是管道进来的，stdin 不是键盘）
[ -r /dev/tty ] || die "找不到终端，请在交互式 shell 里运行"
ask() {  # ask 变量名 "问题" "默认值"
  local __v="$1" __q="$2" __d="${3-}" __a
  if [ -n "$__d" ]; then read -r -p "$__q [$__d]: " __a </dev/tty || true; __a="${__a:-$__d}"
  else read -r -p "$__q: " __a </dev/tty || true; fi
  printf -v "$__v" '%s' "$__a"
}
ask_secret() {  # ask_secret 变量名 "问题"
  local __v="$1" __a
  read -r -s -p "$2: " __a </dev/tty || true; echo >&2
  printf -v "$__v" '%s' "$__a"
}
yesno() {  # yesno "问题" 默认(y/n)
  local a d="$2"; read -r -p "$1 [$( [ "$d" = y ] && echo Y/n || echo y/N )]: " a </dev/tty || true
  a="${a:-$d}"; [[ "$a" =~ ^[Yy] ]]
}
rand_hex() { if command -v openssl >/dev/null; then openssl rand -hex "$1"; else head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; fi; }

# ---------- 检查环境 ----------
command -v docker >/dev/null || die "没装 docker。先装：curl -fsSL https://get.docker.com | sh"
docker compose version >/dev/null 2>&1 || die "docker 缺少 compose 插件（需要 docker compose v2）"
docker info >/dev/null 2>&1 || die "连不上 docker（没启动，或当前用户没权限；试试 sudo bash）"
command -v curl >/dev/null || die "需要 curl"

say "agy-me 部署向导"
ask DIR "安装目录" "/opt/agy-me"
mkdir -p "$DIR"; DIR="$(cd "$DIR" && pwd)"

public_host() {
  local h; h="$(hostname -I 2>/dev/null | awk '{print $1}')" || true
  echo "${h:-你的服务器IP}"
}
wait_up() {  # wait_up 端口 路径
  for _ in $(seq 1 30); do
    if curl -fsS -o /dev/null "http://127.0.0.1:$1$2/" 2>/dev/null; then return 0; fi
    sleep 1
  done
  return 1
}
show_url() {
  local port="$1" bp="$2" bind="$3" host
  [ "$bind" = "127.0.0.1" ] && host="127.0.0.1" || host="$(public_host)"
  echo
  say "完成！面板地址：http://$host:$port$bp/"
  [ "$bind" = "127.0.0.1" ] || warn "现在是 http 明文访问，登录密码会在网上裸奔，建议前面套 nginx / Caddy 上 https。"
}

update_managed_models() {
  # Compose's effective service list also accounts for override files.
  local services helper seed
  services="$(docker compose config --services)"
  if ! grep -qx cpa <<<"$services"; then
    say "此安装连接外部 CPA，只更新面板；模型映射由外部 CPA 管理。"
    return
  fi
  [ -f cpa/config.yaml ] || die "找不到本地 CPA 配置 cpa/config.yaml"
  mkdir -p cpa/catalog
  if [ ! -s cpa/catalog/models.json ]; then
    seed="$(mktemp cpa/catalog/.models.XXXXXX)"
    if ! curl -fsSL https://models.router-for.me/models.json -o "$seed"; then
      curl -fsSL https://raw.githubusercontent.com/router-for-me/models/main/models.json -o "$seed" || die "下载模型目录失败，未修改配置"
    fi
    docker run --rm -i --entrypoint node "$IMAGE" -e 'const fs=require("fs"); const d=JSON.parse(fs.readFileSync(0)); if(!Array.isArray(d.antigravity)||!d.antigravity.length)process.exit(1)' < "$seed" || die "模型目录校验失败"
    chmod 644 "$seed"; mv "$seed" cpa/catalog/models.json
  fi
  chown 1000:1000 cpa/catalog 2>/dev/null || sudo chown 1000:1000 cpa/catalog || die "无法设置模型目录权限"
  helper="$(mktemp)"
  curl -fsSL "$RAW/deploy/update-models.rb" -o "$helper" || die "下载模型更新程序失败"
  if command -v ruby >/dev/null; then
    ruby "$helper"
  else
    docker run --rm -i --network none -v "$PWD:/install" -w /install ruby:3.3-alpine ruby - < "$helper"
  fi
  rm -f "$helper"
  docker compose config -q
}

# ---------- 已有安装：升级 ----------
if [ -f "$DIR/docker-compose.yml" ] && [ -f "$DIR/.env" ]; then
  say "发现 $DIR 里已经装过了"
  if yesno "升级镜像并补齐模型配置（保留密钥和自定义映射）？" y; then
    cd "$DIR"
    docker compose pull
    update_managed_models
    if grep -qx cpa <<<"$(docker compose config --services)"; then
      docker compose up -d --force-recreate cpa
    fi
    docker compose up -d
    set -a; . ./.env; set +a
    wait_up "${AGY_PORT:-8321}" "${BASE_PATH:-}" || warn "30 秒内没起来，用 docker compose logs agy-me 看看"
    show_url "${AGY_PORT:-8321}" "${BASE_PATH:-}" "${AGY_BIND:-0.0.0.0}"
    exit 0
  fi
  ts="$(date +%Y%m%d-%H%M%S)"
  cp "$DIR/.env" "$DIR/.env.bak-$ts"; cp "$DIR/docker-compose.yml" "$DIR/docker-compose.yml.bak-$ts"
  say "旧配置已备份为 *.bak-$ts，继续重新配置（数据 data/ 不动）"
fi

# ---------- 问配置 ----------
ask NAME "实例名（容器名用它；同一台机器装第二套时换个名字，如 agy-pool）" "$(basename "$DIR")"
[[ "$NAME" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ ]] || die "实例名只能用字母、数字、_ . -"
for c in "$NAME" "$NAME-cpa"; do
  if docker ps -a --format '{{.Names}}' | grep -qx "$c" \
     && [ "$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$c" 2>/dev/null)" != "$DIR" ]; then
    die "已经有别的容器叫 $c 了，换个实例名"
  fi
done
ask PORT "面板端口" "8321"
[[ "$PORT" =~ ^[0-9]+$ ]] && [ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ] || die "端口不对"
ask BASE_PATH "访问路径前缀（面板挂在哪个子路径；填 / 表示直接挂根）" "/me"
BASE_PATH="${BASE_PATH%/}"; [ -z "$BASE_PATH" ] || BASE_PATH="/${BASE_PATH#/}"
if yesno "允许外网直接访问这个端口？（选 n 则只监听本机，自己用 nginx 反代）" y; then BIND="0.0.0.0"; else BIND="127.0.0.1"; fi

while :; do
  ask_secret PW1 "登录密码（至少 8 位）"
  [ "${#PW1}" -ge 8 ] || { warn "太短了"; continue; }
  ask_secret PW2 "再输一遍"
  [ "$PW1" = "$PW2" ] && break || warn "两次不一样"
done

say "CPA（CLIProxyAPI）怎么来？"
echo "  1) 一起装一个新的 CPA（推荐，全自动）"
echo "  2) 我已经有 CPA，填它的地址和管理密钥"
ask CPA_MODE "选择" "1"

CLIENT_KEY=""
if [ "$CPA_MODE" = "2" ]; then
  ask CPA_URL "CPA 地址（本机上的写 http://127.0.0.1:8318 即可）" "http://127.0.0.1:8318"
  ask_secret CPA_KEY "CPA 管理密钥（management.secret-key 的明文）"
  [ -n "$CPA_KEY" ] || die "管理密钥不能为空"
  EXTRA_HOSTS=0
  if [[ "$CPA_URL" =~ ^(https?://)(127\.0\.0\.1|localhost)(.*)$ ]]; then
    CPA_URL="${BASH_REMATCH[1]}host.docker.internal${BASH_REMATCH[3]}"; EXTRA_HOSTS=1
    warn "容器里访问不到宿主机的 127.0.0.1，已改成 $CPA_URL（CPA 需要监听 0.0.0.0 或 docker 网桥地址）"
  fi
else
  CPA_MODE=1; CPA_URL="http://cpa:8318"; EXTRA_HOSTS=0
  CPA_KEY="$(rand_hex 24)"; CLIENT_KEY="sk-$(rand_hex 20)"
  ask CPA_PORT "CPA 对宿主机开放的端口（酒馆等客户端调 /v1 用，监听地址同面板；填 0 不开放）" "8318"
  [[ "$CPA_PORT" =~ ^[0-9]+$ ]] && [ "$CPA_PORT" -le 65535 ] || die "端口不对"
  [ "$CPA_PORT" = "$PORT" ] && [ "$CPA_PORT" != 0 ] && die "CPA 端口不能和面板端口一样"
fi

# ---------- 生成文件 ----------
say "生成配置到 $DIR"
cd "$DIR"
mkdir -p data
chown 1000:1000 data 2>/dev/null || sudo chown 1000:1000 data 2>/dev/null || { warn "没法改 data 属主，改用宽松权限"; chmod 777 data; }

say "生成密码哈希"
HASH="$(printf '%s' "$PW1" | docker run --rm -i "$IMAGE" node --disable-warning=ExperimentalWarning src/passwd.ts)" \
  || die "拉镜像或生成哈希失败（镜像：$IMAGE）"
[[ "$HASH" == scrypt:* ]] || die "哈希生成异常：$HASH"
unset PW1 PW2

umask 077
cat > .env <<ENVEOF
# 由 deploy.sh 生成。改完执行：docker compose up -d
AGY_IMAGE=$IMAGE
AGY_NAME=$NAME
AGY_PORT=$PORT
AGY_BIND=$BIND
BASE_PATH=$BASE_PATH
APP_PASSWORD_HASH=$HASH
CPA_URL=$CPA_URL
CPA_MANAGEMENT_KEY=$CPA_KEY
USAGE_RETENTION_DAYS=30
QUOTA_REFRESH_MINUTES=15
ENVEOF
chmod 600 .env
umask 022

{
cat <<'YML'
# 由 deploy.sh 生成。数据在 ./data（面板）和 ./cpa（CPA）。
services:
YML
if [ "$CPA_MODE" = "1" ]; then
  mkdir -p cpa/auths cpa/logs
  if [ ! -f cpa/config.yaml ] || [ -n "$CLIENT_KEY" ]; then
    [ -f cpa/config.yaml ] && cp cpa/config.yaml "cpa/config.yaml.bak-$(date +%s)"
    curl -fsSL "$RAW/deploy/cpa-config.example.yaml" -o cpa/config.yaml.tmp || die "下载 CPA 配置模板失败"
    sed -e 's|^  host: "127.0.0.1".*|  host: "0.0.0.0"           # 只在 compose 内部网络可达，没有映射到宿主机|' \
        -e 's|^  allow-remote: false|  allow-remote: true       # agy-me 从另一个容器访问；端口没对外开放|' \
        -e "s|CHANGE-ME-same-as-CPA_MANAGEMENT_KEY|$CPA_KEY|" \
        -e "s|CHANGE-ME-client-key|$CLIENT_KEY|" cpa/config.yaml.tmp > cpa/config.yaml
    rm -f cpa/config.yaml.tmp; chmod 600 cpa/config.yaml
  fi
  cat <<YML
  cpa:
    image: $CPA_IMAGE
    container_name: $NAME-cpa
    volumes:
      - ./cpa/config.yaml:/CLIProxyAPI/config.yaml
      - ./cpa/auths:/root/.cli-proxy-api
      - ./cpa/logs:/CLIProxyAPI/logs
    mem_limit: 256m
    restart: unless-stopped
    logging:
      driver: json-file
      options: { max-size: "10m", max-file: "3" }
YML
  [ "$CPA_PORT" != 0 ] && printf '    ports:\n      - "%s:%s:8318"\n' "$BIND" "$CPA_PORT"
  echo
fi
cat <<YML
  agy-me:
    image: \${AGY_IMAGE}
    container_name: $NAME
    env_file: ./.env
    environment:
      HOST: 0.0.0.0
      PORT: "8321"
      DATA_DIR: /app/data
    ports:
      - "\${AGY_BIND}:\${AGY_PORT}:8321"
    volumes:
      - ./data:/app/data
    mem_limit: 128m
    restart: unless-stopped
    logging:
      driver: json-file
      options: { max-size: "10m", max-file: "3" }
YML
[ "$CPA_MODE" = "1" ] && printf '    depends_on: [cpa]\n'
[ "$EXTRA_HOSTS" = "1" ] && printf '    extra_hosts:\n      - "host.docker.internal:host-gateway"\n'
true
} > docker-compose.yml

# ---------- 启动 ----------
say "拉取镜像并启动"
docker compose pull
update_managed_models
docker compose up -d
wait_up "$PORT" "$BASE_PATH" || warn "30 秒内没起来，用 cd $DIR && docker compose logs 看看"
show_url "$PORT" "$BASE_PATH" "$BIND"
echo "  安装目录：$DIR（配置在 .env，升级重跑本脚本即可）"
if [ -n "$CLIENT_KEY" ]; then
  echo
  if [ "$CPA_PORT" != 0 ]; then
    [ "$BIND" = "127.0.0.1" ] && h=127.0.0.1 || h="$(public_host)"
    echo "  客户端 API 地址：http://$h:$CPA_PORT/v1"
  fi
  echo "  客户端 API Key（酒馆之类调用 CPA 用，只显示这一次，之后可在面板「API 密钥」页看/改）："
  echo "    $CLIENT_KEY"
  echo "  CPA 自带面板和账号登录：进面板后在账号页「添加账号」。"
fi
