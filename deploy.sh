#!/usr/bin/env bash
# agy-me 一键部署 / 平滑升级脚本（引导式，兼容全量更新与增量扩展后端）
#   全新部署 / 交互升级：
#     curl -fsSL https://raw.githubusercontent.com/xzhouzhou758/agy-me/main/deploy.sh | bash
#   老用户全自动无缝升级（保留现有密码、密钥与全部数据）：
#     curl -fsSL https://raw.githubusercontent.com/xzhouzhou758/agy-me/main/deploy.sh | bash -s -- --upgrade
set -euo pipefail

REPO="xzhouzhou758/agy-me"
IMAGE="${AGY_IMAGE:-ghcr.io/$REPO:latest}"
CPA_IMAGE="${CPA_IMAGE:-eceasy/cli-proxy-api:v8.0.74}"
AGM_IMAGE="${AGM_IMAGE:-lbjlaq/antigravity-manager:latest}"
AIS2_IMAGE="${AIS2_IMAGE:-ghcr.io/mag1cfall/aistudio2api:latest}"
RAW="https://raw.githubusercontent.com/$REPO/main"

say()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mxx\033[0m %s\n' "$*" >&2; exit 1; }

AUTO_UPGRADE=0
ARG_DIR=""
while [ $# -gt 0 ]; do
  case "$1" in
    --upgrade|-u) AUTO_UPGRADE=1; shift ;;
    --dir|-d) ARG_DIR="${2:-}"; [ -n "$ARG_DIR" ] || die "--dir 需要目录参数"; shift 2 ;;
    *) die "未知参数：$1（支持 --upgrade / --dir <路径>）" ;;
  esac
done

ask() {
  local __v="$1" __q="$2" __d="${3-}" __a
  if [ -n "$__d" ]; then read -r -p "$__q [$__d]: " __a </dev/tty || true; __a="${__a:-$__d}"
  else read -r -p "$__q: " __a </dev/tty || true; fi
  printf -v "$__v" '%s' "$__a"
}
ask_secret() {
  local __v="$1" __a
  read -r -s -p "$2: " __a </dev/tty || true; echo >&2
  printf -v "$__v" '%s' "$__a"
}
yesno() {
  local a d="$2"; read -r -p "$1 [$( [ "$d" = y ] && echo Y/n || echo y/N )]: " a </dev/tty || true
  a="${a:-$d}"; [[ "$a" =~ ^[Yy] ]]
}
rand_hex() { if command -v openssl >/dev/null; then openssl rand -hex "$1"; else head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; fi; }
rewrite_local_for_container() {
  local url="$1"
  if [[ "$url" =~ ^(https?://)(127\.0\.0\.1|localhost)(.*)$ ]]; then
    EXTRA_HOSTS=1
    printf '%shost.docker.internal%s' "${BASH_REMATCH[1]}" "${BASH_REMATCH[3]}"
    return 0
  fi
  printf '%s' "$url"
  return 1
}

# ---------- 检查环境 ----------
command -v docker >/dev/null || die "没装 docker。先装：curl -fsSL https://get.docker.com | sh"
docker compose version >/dev/null 2>&1 || die "docker 缺少 compose 插件（需要 docker compose v2）"
docker info >/dev/null 2>&1 || die "连不上 docker（没启动，或当前用户没权限；试试 sudo bash）"
command -v curl >/dev/null || die "需要 curl"
command -v awk >/dev/null || die "需要 awk"

if [ "$AUTO_UPGRADE" = "0" ]; then
  [ -r /dev/tty ] || die "找不到交互终端，自动化升级请加参数：--upgrade"
fi

say "agy-me 部署与升级向导"
if [ -n "$ARG_DIR" ]; then
  DIR="$ARG_DIR"
elif [ "$AUTO_UPGRADE" = "1" ]; then
  DIR="/opt/agy-me"
else
  ask DIR "安装目录" "/opt/agy-me"
fi
mkdir -p "$DIR"; DIR="$(cd "$DIR" && pwd)"

public_host() {
  local h; h="$(hostname -I 2>/dev/null | awk '{print $1}')" || true
  echo "${h:-你的服务器IP}"
}
wait_up() {
  local port="$1" bp="$2"
  for _ in $(seq 1 30); do
    if curl -fsS -o /dev/null "http://127.0.0.1:$port$bp/healthz" 2>/dev/null \
       || curl -fsS -o /dev/null "http://127.0.0.1:$port$bp/" 2>/dev/null; then
      return 0
    fi
    sleep 1
  done
  return 1
}
show_done_urls() {
  local port="$1" bp="$2" bind="$3" cpa_port="${4:-0}" host
  [ "$bind" = "127.0.0.1" ] && host="127.0.0.1" || host="$(public_host)"
  echo
  say "完成！面板地址：http://$host:$port$bp/"
  echo "  统一客户端 API 地址（支持在面板一键切换后端，密钥不变）："
  echo "    OpenAI / Responses : http://$host:$port$bp/v1"
  echo "    Claude / Gemini    : http://$host:$port$bp"
  if [ "${AIS2_MODE_VAL:-0}" != "0" ]; then
    echo "    AI Studio 专用入口 : http://$host:$port$bp/ais2/v1（或主入口模型名加 ais2/ 前缀）"
  fi
  if [ "$cpa_port" != "0" ] && [ -n "$cpa_port" ]; then
    echo "  旧版 CPA 直连地址仍继续兼容：http://$host:$cpa_port/v1"
  fi
  [ "$bind" = "127.0.0.1" ] || warn "当前为 http 明文访问，建议前置 nginx / Caddy 开启 https（需关闭 proxy_buffering）。"
}

ensure_catalog() {
  mkdir -p "$DIR/cpa/catalog"
  chown -R 1000:1000 "$DIR/cpa/catalog" 2>/dev/null || sudo -n chown -R 1000:1000 "$DIR/cpa/catalog" 2>/dev/null || chmod -R 777 "$DIR/cpa/catalog"
  if [ ! -s "$DIR/cpa/catalog/models.json" ]; then
    curl -fsSL --max-time 10 "https://models.router-for.me/models.json" -o "$DIR/cpa/catalog/models.json.tmp" 2>/dev/null \
      || curl -fsSL --max-time 10 "https://raw.githubusercontent.com/router-for-me/models/refs/heads/main/models.json" -o "$DIR/cpa/catalog/models.json.tmp" 2>/dev/null \
      || true
    if [ -s "$DIR/cpa/catalog/models.json.tmp" ]; then
      mv "$DIR/cpa/catalog/models.json.tmp" "$DIR/cpa/catalog/models.json"
      chmod 644 "$DIR/cpa/catalog/models.json"
    else
      rm -f "$DIR/cpa/catalog/models.json.tmp"
    fi
  fi
}

valid_ais2_mmdb() {
  local f="$1" sz
  [ -f "$f" ] || return 1
  sz="$(wc -c < "$f" 2>/dev/null | tr -d '[:space:]' || echo 0)"
  [ "${sz:-0}" -ge 1048576 ] || return 1
  { tail -c 131072 "$f" 2>/dev/null || true; } | { LC_ALL=C tr -cd '\40-\176' 2>/dev/null || true; } | grep -q 'MaxMind.com'
}

ensure_ais2_geoip() {
  local gdir="$DIR/data/aistudio2api/runtime/geoip"
  local v4="$gdir/geoip-aio-ipv4.mmdb"
  local v6="$gdir/geoip-aio-ipv6.mmdb"
  local tmp="$gdir/geoip-aio-ipv4.mmdb.tmp"
  mkdir -p "$gdir"

  if ! valid_ais2_mmdb "$v4"; then
    rm -f "$tmp" "$tmp.gz"
    local ok=0 u
    for u in \
      "https://github.com/P3TERX/GeoLite.mmdb/releases/latest/download/GeoLite2-City.mmdb" \
      "https://github.com/PrxyHunter/GeoLite2/releases/latest/download/GeoLite2-City.mmdb"; do
      if curl -fsSL --connect-timeout 10 --max-time 120 "$u" -o "$tmp" 2>/dev/null && valid_ais2_mmdb "$tmp"; then
        ok=1
        break
      fi
      rm -f "$tmp"
    done
    if [ "$ok" = "0" ] && { command -v gzip >/dev/null 2>&1 || command -v gunzip >/dev/null 2>&1; }; then
      if curl -fsSL --connect-timeout 10 --max-time 120 "https://cdn.jsdelivr.net/npm/geolite2-city/GeoLite2-City.mmdb.gz" -o "$tmp.gz" 2>/dev/null; then
        if command -v gzip >/dev/null 2>&1; then
          gzip -dc "$tmp.gz" > "$tmp" 2>/dev/null || rm -f "$tmp"
        else
          gunzip -c "$tmp.gz" > "$tmp" 2>/dev/null || rm -f "$tmp"
        fi
        rm -f "$tmp.gz"
        if valid_ais2_mmdb "$tmp"; then
          ok=1
        else
          rm -f "$tmp"
        fi
      else
        rm -f "$tmp.gz"
      fi
    fi
    if [ "$ok" = "1" ]; then
      chmod 644 "$tmp" && mv "$tmp" "$v4"
      ln -f "$v4" "$v6" 2>/dev/null || cp -f "$v4" "$v6"
      say "已预置 AIStudio2API 离线 GeoIP 库（geoip-aio-ipv4/ipv6.mmdb）"
    else
      rm -f "$tmp" "$tmp.gz"
      warn "未能预下载 AIStudio2API 离线 GeoIP 库，导入账号时将由面板自动补齐或启用免 GeoIP 兜底"
    fi
  fi

  if valid_ais2_mmdb "$v4" && ! valid_ais2_mmdb "$v6"; then
    ln -f "$v4" "$v6" 2>/dev/null || cp -f "$v4" "$v6"
  fi

  chown -R 1000:1000 "$DIR/data/aistudio2api/runtime" 2>/dev/null \
    || sudo -n chown -R 1000:1000 "$DIR/data/aistudio2api/runtime" 2>/dev/null \
    || chmod 777 "$DIR/data/aistudio2api/runtime/geoip" 2>/dev/null || true
}

# 原地更新 cpa/config.yaml：绝不用 sed -i（会换 inode 导致单文件挂载的 CPA 容器内读不到更新）
upgrade_cpa_config_inplace() {
  local cfg="$DIR/cpa/config.yaml" ts="$1"
  [ -f "$cfg" ] || return 0
  cp "$cfg" "$cfg.bak-$ts"
  local has_catalog_file=0
  [ -s "$DIR/cpa/catalog/models.json" ] && has_catalog_file=1
  awk -v add_cat="$has_catalog_file" '
    BEGIN {
      seen_keepalive=0; has_models=0; has_ka_sec=0; has_ver=0
    }
    {
      lines[++n]=$0
      if ($0 ~ /send-keepalive-before-ft:/) seen_keepalive=1
      if ($0 ~ /^models:/) has_models=1
      if ($0 ~ /^[[:space:]]+keepalive-seconds:/) has_ka_sec=1
      if ($0 ~ /^config-version:/) has_ver=1
    }
    END {
      for (i=1; i<=n; i++) {
        print lines[i]
        if (add_cat==1 && has_models==0 && has_ver==1 && lines[i] ~ /^config-version:/) {
          print "models:"
          print "  catalog: /CLIProxyAPI/catalog/models.json"
        }
        if (seen_keepalive==0 && has_ka_sec==1 && lines[i] ~ /^[[:space:]]+keepalive-seconds:/) {
          match(lines[i], /^[[:space:]]*/)
          ind = substr(lines[i], 1, RLENGTH)
          print ind "send-keepalive-before-ft: true"
        }
      }
    }
  ' "$cfg" > "$cfg.tmp" && cat "$cfg.tmp" > "$cfg" && rm -f "$cfg.tmp"
  say "已原地升级 cpa/config.yaml（保留原密钥与文件 inode，已确保开启 send-keepalive-before-ft）"
}

# 原地升级旧 docker-compose.yml（调高内存、升 CPA 镜像、挂载 cpa/catalog）
upgrade_compose_inplace() {
  local yml="$DIR/docker-compose.yml"
  local has_cpa=0 has_cpa_cat=0 has_app_cat=0
  grep -qE '^[[:space:]]+cpa:' "$yml" && has_cpa=1
  grep -q '/CLIProxyAPI/catalog' "$yml" && has_cpa_cat=1
  grep -q '/app/catalog' "$yml" && has_app_cat=1

  if [ "$has_cpa" = "1" ]; then
    ensure_catalog
  fi

  awk -v cpa_img="$CPA_IMAGE" -v add_cpa_cat="$((has_cpa==1 && has_cpa_cat==0))" -v add_app_cat="$((has_cpa==1 && has_app_cat==0))" '
    {
      line = $0
      if (line ~ /eceasy\/cli-proxy-api:/) {
        sub(/eceasy\/cli-proxy-api:[^"[:space:]]+/, cpa_img, line)
      }
      if (line ~ /^[[:space:]]+mem_limit:[[:space:]]*128m/) {
        sub(/128m/, "256m", line)
      }
      print line
      if (add_cpa_cat==1 && line ~ /\.\/cpa\/logs:\/CLIProxyAPI\/logs/) {
        match(line, /^[[:space:]]*/)
        ind = substr(line, 1, RLENGTH)
        print ind "- ./cpa/catalog:/CLIProxyAPI/catalog:ro"
      }
      if (add_app_cat==1 && line ~ /\.\/data:\/app\/data/) {
        match(line, /^[[:space:]]*/)
        ind = substr(line, 1, RLENGTH)
        print ind "- ./cpa/catalog:/app/catalog"
      }
    }
  ' "$yml" > "$yml.tmp" && mv "$yml.tmp" "$yml"
}

ask_agm_backend() {
  local def="${1:-0}"
  say "是否启用 Antigravity-Manager（AGM）作为可选 AGY 后端？"
  echo "  0) 暂不启用（以后随时可再跑脚本加上）"
  echo "  1) 一起装内置 AGM 容器（自动生成 API Key 和管理密码）"
  echo "  2) 连接我已有的 AGM（例如宿主机 8889 端口）"
  ask AGM_MODE "选择" "$def"
  AGM_KEY=""; AGM_ADMIN=""; AGM_PORT="${AGM_PORT:-0}"
  if [ "$AGM_MODE" = "1" ]; then
    AGM_URL="http://agm:8045"
    AGM_KEY="sk-agm-$(rand_hex 16)"
    AGM_ADMIN="$(rand_hex 12)"
    ask AGM_PORT "AGM 对宿主机开放的端口（填 0 则仅内部访问，推荐 0 或 8319）" "0"
    [[ "$AGM_PORT" =~ ^[0-9]+$ ]] && [ "$AGM_PORT" -le 65535 ] || die "端口不对"
  elif [ "$AGM_MODE" = "2" ]; then
    ask AGM_URL "AGM 地址（本机 8889 写 http://127.0.0.1:8889）" "${AGM_URL:-http://127.0.0.1:8889}"
    ask_secret AGM_KEY "AGM API Key（代理调用用）"
    [ -n "$AGM_KEY" ] || die "AGM API Key 不能为空"
    ask_secret AGM_ADMIN "AGM 管理密码（admin_password，留空则同 API Key）"
    AGM_ADMIN="${AGM_ADMIN:-$AGM_KEY}"
    local rewritten
    if rewritten="$(rewrite_local_for_container "$AGM_URL")"; then
      AGM_URL="$rewritten"
      warn "容器内已将 AGM 地址转为 $AGM_URL（宿主机 AGM 需监听 0.0.0.0 或 Docker 网桥可达）"
    fi
  else
    AGM_MODE=0; AGM_URL=""
  fi
}

ask_ais2_backend() {
  local def="${1:-0}"
  say "是否启用纯自用 AI Studio（AIStudio2API，无分流）？"
  echo "  0) 暂不启用"
  echo "  1) 一起装内置 AIStudio2API 容器（自动生成密钥）"
  echo "  2) 连接我已有的 AIStudio2API"
  ask AIS2_MODE_CHOICE "选择" "$def"
  AIS2_MODE_VAL=0; AIS2_URL=""; AIS2_KEY=""; AIS2_ADMIN_USER="admin"; AIS2_ADMIN_PASS=""; AIS2_TENANT="exclusive"
  if [ "$AIS2_MODE_CHOICE" = "1" ]; then
    AIS2_MODE_VAL=1
    AIS2_URL="http://aistudio2:18803"
    AIS2_KEY="sk-ais2-$(rand_hex 20)"
    AIS2_ADMIN_USER="admin"
    AIS2_ADMIN_PASS="$(rand_hex 12)"
    AIS2_TENANT="exclusive"
  elif [ "$AIS2_MODE_CHOICE" = "2" ]; then
    AIS2_MODE_VAL=2
    ask AIS2_URL "AIStudio2API 地址（本机写 http://127.0.0.1:18803）" "http://127.0.0.1:18803"
    ask_secret AIS2_KEY "AIStudio2API 调用密钥（PROXY_API_KEY）"
    [ -n "$AIS2_KEY" ] || die "AIStudio2API 密钥不能为空"
    ask AIS2_ADMIN_USER "管理员用户名" "admin"
    ask_secret AIS2_ADMIN_PASS "管理员密码"
    [ -n "$AIS2_ADMIN_PASS" ] || die "管理员密码不能为空"
    if yesno "这个 AIStudio2API 是否和别的系统（如小锅饭）共用？" n; then
      AIS2_TENANT="shared"
    else
      AIS2_TENANT="exclusive"
    fi
    local rewritten
    if rewritten="$(rewrite_local_for_container "$AIS2_URL")"; then
      AIS2_URL="$rewritten"
      warn "容器内已将 AIStudio2API 地址转为 $AIS2_URL"
    fi
  fi
}

write_env_and_compose() {
  cd "$DIR"
  mkdir -p data
  chown 1000:1000 data 2>/dev/null || sudo -n chown 1000:1000 data 2>/dev/null || { warn "没法改 data 属主，改用宽松权限"; chmod 777 data; }

  umask 077
  {
    echo "# 由 deploy.sh 生成。改完执行：docker compose up -d"
    echo "AGY_IMAGE=$IMAGE"
    echo "AGY_NAME=$NAME"
    echo "AGY_PORT=$PORT"
    echo "AGY_BIND=$BIND"
    echo "BASE_PATH=$BASE_PATH"
    if [ -n "${HASH:-}" ]; then echo "APP_PASSWORD_HASH=$HASH"; fi
    if [ -n "${PLAIN_PW:-}" ]; then echo "APP_PASSWORD=$PLAIN_PW"; fi
    if [ "$CPA_MODE" != "0" ]; then
      echo "CPA_URL=$CPA_URL"
      echo "CPA_MANAGEMENT_KEY=$CPA_KEY"
    fi
    if [ "$AGM_MODE" != "0" ]; then
      echo "AGM_URL=$AGM_URL"
      echo "AGM_API_KEY=$AGM_KEY"
      echo "AGM_ADMIN_PASSWORD=$AGM_ADMIN"
    fi
    if [ "$AIS2_MODE_VAL" != "0" ]; then
      echo "AISTUDIO2_URL=$AIS2_URL"
      echo "AISTUDIO2_KEY=$AIS2_KEY"
      echo "AISTUDIO2_ADMIN_USER=$AIS2_ADMIN_USER"
      echo "AISTUDIO2_ADMIN_PASSWORD=$AIS2_ADMIN_PASS"
      echo "AISTUDIO2_MODE=$AIS2_TENANT"
      echo "AISTUDIO2_RECHECK_MINUTES=60"
    fi
    echo "USAGE_RETENTION_DAYS=${USAGE_RETENTION_DAYS:-30}"
    echo "QUOTA_REFRESH_MINUTES=${QUOTA_REFRESH_MINUTES:-15}"
    echo "MAX_BODY_MB=${MAX_BODY_MB:-20}"
    echo "UPSTREAM_TIMEOUT_MS=${UPSTREAM_TIMEOUT_MS:-300000}"
  } > "$ENV_BASENAME"
  chmod 600 "$ENV_BASENAME"
  umask 022

  local deps=()
  {
    cat <<'YML'
# 由 deploy.sh 生成。数据在 ./data（面板），可选 ./cpa、./agm、./data/aistudio2api。
services:
YML
    if [ "$CPA_MODE" = "1" ]; then
      deps+=("cpa")
      mkdir -p cpa/auths cpa/logs
      ensure_catalog
      if [ ! -f cpa/config.yaml ] || [ -n "${CLIENT_KEY:-}" ]; then
        [ -f cpa/config.yaml ] && cp cpa/config.yaml "cpa/config.yaml.bak-$(date +%s)"
        curl -fsSL "$RAW/deploy/cpa-config.example.yaml" -o cpa/config.yaml.tmp || die "下载 CPA 配置模板失败"
        sed -e 's|^  host: "127.0.0.1".*|  host: "0.0.0.0"           # compose 内部可达|' \
            -e 's|^  allow-remote: false|  allow-remote: true       # agy-me 从同网络容器访问|' \
            -e "s|CHANGE-ME-same-as-CPA_MANAGEMENT_KEY|$CPA_KEY|" \
            -e "s|CHANGE-ME-client-key|${CLIENT_KEY:-sk-client-default-key}|" cpa/config.yaml.tmp > cpa/config.yaml.new
        if [ -f cpa/config.yaml ]; then
          cat cpa/config.yaml.new > cpa/config.yaml && rm -f cpa/config.yaml.new
        else
          mv cpa/config.yaml.new cpa/config.yaml
        fi
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
      - ./cpa/catalog:/CLIProxyAPI/catalog:ro
    mem_limit: 256m
    restart: unless-stopped
    logging:
      driver: json-file
      options: { max-size: "10m", max-file: "3" }
YML
      [ "${CPA_PORT:-0}" != "0" ] && printf '    ports:\n      - "%s:%s:8318"\n' "$BIND" "$CPA_PORT"
      echo
    fi

    if [ "$AGM_MODE" = "1" ]; then
      deps+=("agm")
      mkdir -p agm
      cat <<YML
  agm:
    image: $AGM_IMAGE
    container_name: $NAME-agm
    environment:
      PORT: "8045"
      API_KEY: "\${AGM_API_KEY}"
      WEB_PASSWORD: "\${AGM_ADMIN_PASSWORD}"
    volumes:
      - ./agm:/root/.antigravity_tools
    mem_limit: 256m
    restart: unless-stopped
    logging:
      driver: json-file
      options: { max-size: "10m", max-file: "3" }
YML
      [ "${AGM_PORT:-0}" != "0" ] && printf '    ports:\n      - "%s:%s:8045"\n' "$BIND" "$AGM_PORT"
      echo
    fi

    if [ "$AIS2_MODE_VAL" = "1" ]; then
      deps+=("aistudio2")
      mkdir -p data/aistudio2api
      umask 077
      cat > data/aistudio2api/.env <<AISEOF
LISTEN_ADDR=0.0.0.0:18803
PROXY_API_KEY=$AIS2_KEY
ADMIN_AUTH_ENABLED=true
ADMIN_USERNAME=$AIS2_ADMIN_USER
ADMIN_PASSWORD=$AIS2_ADMIN_PASS
AUTO_START=true
WAA_BACKEND=spidermonkey
WARM_WORKER_LIMIT=2
MAX_ACTIVE_WORKERS=6
AISEOF
      umask 022
      cat <<YML
  aistudio2:
    image: $AIS2_IMAGE
    container_name: $NAME-aistudio2
    init: true
    environment:
      TZ: Asia/Shanghai
      LISTEN_ADDR: 0.0.0.0:18803
      PROXY_API_KEY: "\${AISTUDIO2_KEY}"
      ADMIN_AUTH_ENABLED: "true"
      ADMIN_USERNAME: "\${AISTUDIO2_ADMIN_USER}"
      ADMIN_PASSWORD: "\${AISTUDIO2_ADMIN_PASSWORD}"
      AUTO_START: "true"
      WAA_BACKEND: spidermonkey
      WARM_WORKER_LIMIT: "2"
      MAX_ACTIVE_WORKERS: "6"
    volumes:
      - ./data/aistudio2api:/data
    mem_limit: 512m
    restart: unless-stopped
    logging:
      driver: json-file
      options: { max-size: "10m", max-file: "3" }

YML
    fi

    cat <<YML
  agy-me:
    image: \${AGY_IMAGE}
    container_name: $NAME
    env_file: ./$ENV_BASENAME
    environment:
      HOST: 0.0.0.0
      PORT: "8321"
      DATA_DIR: /app/data
    ports:
      - "\${AGY_BIND}:\${AGY_PORT}:8321"
    volumes:
      - ./data:/app/data
YML
    [ "$CPA_MODE" = "1" ] && printf '      - ./cpa/catalog:/app/catalog\n'
    cat <<'YML'
    mem_limit: 256m
    restart: unless-stopped
    logging:
      driver: json-file
      options: { max-size: "10m", max-file: "3" }
YML
    if [ "${#deps[@]}" -gt 0 ]; then
      printf '    depends_on: [%s]\n' "$(IFS=,; echo "${deps[*]}")"
    fi
    if [ "${EXTRA_HOSTS:-0}" = "1" ]; then
      printf '    extra_hosts:\n      - "host.docker.internal:host-gateway"\n'
    fi
    true
  } > docker-compose.yml
  if [ "$AIS2_MODE_VAL" = "1" ]; then
    ensure_ais2_geoip
  fi
}

# ---------- 检测已有安装 ----------
ENV_BASENAME=""
if [ -f "$DIR/.env" ]; then ENV_BASENAME=".env"
elif [ -f "$DIR/agy-me.env" ]; then ENV_BASENAME="agy-me.env"
fi

if [ -f "$DIR/docker-compose.yml" ] && [ -n "$ENV_BASENAME" ]; then
  say "发现 $DIR 里已经装过了（配置文件：$ENV_BASENAME）"
  UPGRADE_CHOICE="1"
  if [ "$AUTO_UPGRADE" = "0" ]; then
    echo "  1) 无缝升级（保留密码、密钥与全部数据，自动升级镜像与配置）[默认]"
    echo "  2) 升级并增配后端（免重配密码与 CPA，加装 AGM 或 AI Studio）"
    echo "  3) 全新重配向导（保留 data/，重设全部选项）"
    ask UPGRADE_CHOICE "选择" "1"
  fi

  ts="$(date +%Y%m%d-%H%M%S)"
  cp "$DIR/$ENV_BASENAME" "$DIR/$ENV_BASENAME.bak-$ts"
  cp "$DIR/docker-compose.yml" "$DIR/docker-compose.yml.bak-$ts"
  say "旧配置已备份为 *.bak-$ts（data/ 数据完好保留）"

  if [ "$UPGRADE_CHOICE" = "1" ]; then
    cd "$DIR"
    set -a; . "./$ENV_BASENAME"; set +a
    # 确保老 .env 的 AGY_IMAGE 指向最新官方镜像（除非用户用了完全不同的镜像名）
    if grep -qE '^AGY_IMAGE=' "$ENV_BASENAME"; then
      if [ -z "${AGY_IMAGE:-}" ] || [[ "${AGY_IMAGE:-}" == ghcr.io/xzhouzhou758/agy-me:* ]]; then
        awk -v img="$IMAGE" '{ if ($0 ~ /^AGY_IMAGE=/) print "AGY_IMAGE=" img; else print $0 }' "$ENV_BASENAME" > "$ENV_BASENAME.tmp" && mv "$ENV_BASENAME.tmp" "$ENV_BASENAME" && chmod 600 "$ENV_BASENAME"
      fi
    fi
    upgrade_compose_inplace "$ts"
    if grep -qE '^[[:space:]]+aistudio2:' docker-compose.yml; then
      ensure_ais2_geoip
    fi
    if command -v ruby >/dev/null 2>&1; then
      helper="$(mktemp)"
      if curl -fsSL --max-time 10 "$RAW/deploy/update-models.rb" -o "$helper" 2>/dev/null; then
        ruby "$helper" || true
      fi
      rm -f "$helper"
    fi
    upgrade_cpa_config_inplace "$ts"
    say "拉取最新镜像并重建启动"
    docker compose pull
    if grep -qE '^[[:space:]]+cpa:' docker-compose.yml; then
      docker compose up -d --force-recreate cpa
    fi
    docker compose up -d --remove-orphans
    [ -n "${AISTUDIO2_KEY:-}" ] && AIS2_MODE_VAL=1 || AIS2_MODE_VAL=0
    cpa_port_now="$(sed -nE 's/.*:([0-9]+):8318.*/\1/p' docker-compose.yml | head -n1 || true)"
    wait_up "${AGY_PORT:-8321}" "${BASE_PATH:-}" || warn "30 秒内没起来，用 cd $DIR && docker compose logs agy-me 看看"
    show_done_urls "${AGY_PORT:-8321}" "${BASE_PATH:-}" "${AGY_BIND:-127.0.0.1}" "${cpa_port_now:-0}"
    exit 0
  elif [ "$UPGRADE_CHOICE" = "2" ]; then
    cd "$DIR"
    set -a; . "./$ENV_BASENAME"; set +a
    NAME="${AGY_NAME:-$(basename "$DIR")}"
    PORT="${AGY_PORT:-8321}"
    BIND="${AGY_BIND:-0.0.0.0}"
    BASE_PATH="${BASE_PATH:-/me}"
    HASH="${APP_PASSWORD_HASH:-}"
    PLAIN_PW="${APP_PASSWORD:-}"
    EXTRA_HOSTS=0
    grep -q 'host.docker.internal:host-gateway' docker-compose.yml && EXTRA_HOSTS=1

    CPA_KEY="${CPA_MANAGEMENT_KEY:-}"
    CPA_URL="${CPA_URL:-}"
    CPA_PORT=0
    if grep -qE '^[[:space:]]+cpa:' docker-compose.yml; then
      CPA_MODE=1
      CPA_PORT="$(sed -nE 's/.*:([0-9]+):8318.*/\1/p' docker-compose.yml | head -n1 || echo 0)"
      CPA_PORT="${CPA_PORT:-0}"
      upgrade_cpa_config_inplace "$ts"
    elif [ -n "$CPA_KEY" ] && [ -n "$CPA_URL" ]; then
      CPA_MODE=2
    else
      CPA_MODE=0
    fi

    ask_agm_backend "$([ -n "${AGM_URL:-}" ] && echo 2 || echo 0)"
    ask_ais2_backend "$([ -n "${AISTUDIO2_KEY:-}" ] && echo 2 || echo 0)"
    [ "$CPA_MODE" = "0" ] && [ "$AGM_MODE" = "0" ] && [ "$AIS2_MODE_VAL" = "0" ] && die "至少需要启用一个后端"

    CLIENT_KEY=""
    write_env_and_compose
    say "拉取镜像并重启应用"
    docker compose pull
    docker compose up -d --remove-orphans
    wait_up "$PORT" "$BASE_PATH" || warn "30 秒内没起来，用 cd $DIR && docker compose logs agy-me 看看"
    show_done_urls "$PORT" "$BASE_PATH" "$BIND" "${CPA_PORT:-0}"
    exit 0
  fi
fi

# ---------- 全新部署 / 完整重配 ----------
ENV_BASENAME=".env"
ask NAME "实例名（容器名用它；同一台机器装第二套时换个名字）" "$(basename "$DIR")"
[[ "$NAME" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ ]] || die "实例名只能用字母、数字、_ . -"
for c in "$NAME" "$NAME-cpa" "$NAME-agm" "$NAME-aistudio2"; do
  if docker ps -a --format '{{.Names}}' | grep -qx "$c" \
     && [ "$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$c" 2>/dev/null)" != "$DIR" ]; then
    die "已经有别的容器叫 $c 了，换个实例名"
  fi
done
ask PORT "面板与统一网关端口" "8321"
[[ "$PORT" =~ ^[0-9]+$ ]] && [ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ] || die "端口不对"
ask BASE_PATH "访问路径前缀（填 / 表示直接挂根）" "/me"
BASE_PATH="${BASE_PATH%/}"; [ -z "$BASE_PATH" ] || BASE_PATH="/${BASE_PATH#/}"
if yesno "允许外网直接访问这个端口？（选 n 则只监听本机，自己用 nginx 反代）" y; then BIND="0.0.0.0"; else BIND="127.0.0.1"; fi

while :; do
  ask_secret PW1 "登录密码（至少 8 位）"
  [ "${#PW1}" -ge 8 ] || { warn "太短了"; continue; }
  ask_secret PW2 "再输一遍"
  [ "$PW1" = "$PW2" ] && break || warn "两次不一样"
done

EXTRA_HOSTS=0
while :; do
  say "CPA（CLIProxyAPI）怎么来？"
  echo "  1) 一起装一个新的 CPA（推荐，全自动）"
  echo "  2) 我已经有 CPA，填它的地址和管理密钥"
  echo "  0) 不装 CPA（仅用 AGM 或 AI Studio）"
  ask CPA_MODE "选择" "1"

  CLIENT_KEY=""; CPA_KEY=""; CPA_URL=""; CPA_PORT=0
  if [ "$CPA_MODE" = "2" ]; then
    ask CPA_URL "CPA 地址（本机上的写 http://127.0.0.1:8318 即可）" "http://127.0.0.1:8318"
    ask_secret CPA_KEY "CPA 管理密钥（management.secret-key 明文）"
    [ -n "$CPA_KEY" ] || die "管理密钥不能为空"
    local_rw=""
    if local_rw="$(rewrite_local_for_container "$CPA_URL")"; then
      CPA_URL="$local_rw"
      warn "容器内已改成 $CPA_URL（CPA 需要监听 0.0.0.0 或 Docker 网桥地址）"
    fi
  elif [ "$CPA_MODE" = "1" ]; then
    CPA_MODE=1; CPA_URL="http://cpa:8318"
    CPA_KEY="$(rand_hex 24)"; CLIENT_KEY="sk-$(rand_hex 20)"
    ask CPA_PORT "CPA 对宿主机开放的端口（兼容直接连 CPA 用；填 0 不开放）" "8318"
    [[ "$CPA_PORT" =~ ^[0-9]+$ ]] && [ "$CPA_PORT" -le 65535 ] || die "端口不对"
    [ "$CPA_PORT" = "$PORT" ] && [ "$CPA_PORT" != 0 ] && die "CPA 端口不能和面板端口一样"
  else
    CPA_MODE=0
  fi

  ask_agm_backend "0"
  ask_ais2_backend "0"
  if [ "$CPA_MODE" != "0" ] || [ "$AGM_MODE" != "0" ] || [ "$AIS2_MODE_VAL" != "0" ]; then
    break
  fi
  warn "CPA、AGM、AI Studio 至少需要启用其中一项，请重新选择"
done

say "生成密码哈希"
HASH="$(printf '%s' "$PW1" | docker run --rm -i "$IMAGE" node --disable-warning=ExperimentalWarning src/passwd.ts)" \
  || die "拉镜像或生成哈希失败（镜像：$IMAGE）"
[[ "$HASH" == scrypt:* ]] || die "哈希生成异常：$HASH"
unset PW1 PW2

say "生成配置到 $DIR"
write_env_and_compose

say "拉取镜像并启动"
docker compose pull
docker compose up -d --remove-orphans
wait_up "$PORT" "$BASE_PATH" || warn "30 秒内没起来，用 cd $DIR && docker compose logs 看看"
show_done_urls "$PORT" "$BASE_PATH" "$BIND" "${CPA_PORT:-0}"
echo "  安装目录：$DIR（之后升级重跑同一条命令选 1 即可）"
if [ -n "$CLIENT_KEY" ]; then
  echo
  echo "  初始客户端 API Key（之后可在面板「API 密钥」页查看或新建）："
  echo "    $CLIENT_KEY"
fi
