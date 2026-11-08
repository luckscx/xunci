#!/usr/bin/env bash
# 把「寻词蹭热度」部署到 Claw（SSH 别名 claw，见 ~/.ssh/config）
#
#   npm run deploy:claw                            # 默认域名 xunci.grissom.cn
#   DOMAIN=你的域名.grissom.cn npm run deploy:claw    # 换域名重跑即可
#
# 流程：本地构建 → rsync 到 /data/xunci → npm ci + 同步 BGE 模型缓存
#       → PM2 起服务 → Nginx 反代（含 /ws）→ Let's Encrypt 证书 → 自检
# 幂等：重复执行不会重建 data/（对局与配置）、不会重装依赖、不会重签证书。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SSH_HOST="${SSH_HOST:-claw}"
REMOTE_DIR="${REMOTE_DIR:-/data/xunci}"
DOMAIN="${DOMAIN:-xunci.grissom.cn}"
PORT=3110                        # 与 ecosystem.config.cjs 保持一致
APP=xunci
WEBROOT=/data/letsencrypt-webroot
CONF="/etc/nginx/conf.d/${DOMAIN}.conf"
CERT="/etc/letsencrypt/live/${DOMAIN}/fullchain.pem"
MODEL_CACHE="node_modules/@huggingface/transformers/.cache"

log() { printf '\n==> %s\n' "$*"; }
remote() { ssh -o BatchMode=yes "$SSH_HOST" "$*"; }

# bootstrap：签发证书前的 80 端口临时配置；final：80 跳转 + 443 反代
nginx_conf() {
  if [ "$1" = bootstrap ]; then
    cat <<'NGINX'
server {
    listen 80;
    server_name __DOMAIN__;

    location /.well-known/acme-challenge/ { root __WEBROOT__; }

    location / {
        proxy_pass http://127.0.0.1:__PORT__;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
NGINX
  else
    cat <<'NGINX'
server {
    listen 80;
    server_name __DOMAIN__;

    # 留给 certbot 续期（webroot 方式）
    location /.well-known/acme-challenge/ { root __WEBROOT__; }
    location / { return 301 https://$host$request_uri; }
}

server {
    listen 443 ssl;
    server_name __DOMAIN__;

    ssl_certificate /etc/letsencrypt/live/__DOMAIN__/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/__DOMAIN__/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    client_max_body_size 1m;

    # 公共房间广播走 WebSocket，超时放宽以保住长连接
    location /ws {
        proxy_pass http://127.0.0.1:__PORT__;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }

    location / {
        proxy_pass http://127.0.0.1:__PORT__;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        # 判官要调 LLM，读超时比普通接口宽松
        proxy_read_timeout 120s;
    }
}
NGINX
  fi | sed -e "s|__DOMAIN__|$DOMAIN|g" -e "s|__PORT__|$PORT|g" -e "s|__WEBROOT__|$WEBROOT|g"
}

# 先备份再写入，nginx -t 不通过就回滚，避免影响机器上其它站点
install_conf() {
  local backup="${CONF}.deploy-bak"
  remote "cp '$CONF' '$backup' 2>/dev/null || true"
  nginx_conf "$1" | ssh -o BatchMode=yes "$SSH_HOST" "cat > '$CONF'"
  if ! remote "nginx -t 2>&1"; then
    remote "if [ -f '$backup' ]; then mv '$backup' '$CONF'; else rm -f '$CONF'; fi; nginx -t && systemctl reload nginx" || true
    echo "Nginx 配置校验失败，已回滚到上一版配置" >&2
    exit 1
  fi
  remote "systemctl reload nginx"
}

log "1/7 检查连通性与工具"
command -v rsync >/dev/null || { echo "本机缺少 rsync" >&2; exit 1; }
remote "command -v nginx && command -v pm2 && command -v certbot && command -v node" >/dev/null
[ -f "$ROOT/.env" ] || echo "提示：本地没有 .env，远端「问一句」判官将不可用（猜词不受影响）"

log "2/7 本地构建 dist/"
(cd "$ROOT" && npm run build)

log "3/7 同步文件到 $SSH_HOST:$REMOTE_DIR"
remote "mkdir -p '$REMOTE_DIR/dist' '$REMOTE_DIR/server' '$REMOTE_DIR/data'"
rsync -az --delete "$ROOT/dist/" "$SSH_HOST:$REMOTE_DIR/dist/"
rsync -az --delete "$ROOT/server/" "$SSH_HOST:$REMOTE_DIR/server/"
rsync -az "$ROOT/package.json" "$ROOT/package-lock.json" "$ROOT/ecosystem.config.cjs" "$SSH_HOST:$REMOTE_DIR/"
if [ -f "$ROOT/.env" ]; then
  rsync -az "$ROOT/.env" "$SSH_HOST:$REMOTE_DIR/.env"
  remote "chmod 600 '$REMOTE_DIR/.env'"
fi

log "4/7 远端生产依赖与 BGE 模型缓存"
lock="$(md5sum "$ROOT/package-lock.json" | cut -d' ' -f1)"
if [ "$(remote "cat '$REMOTE_DIR/.npm-lock.md5' 2>/dev/null || true")" != "$lock" ]; then
  remote "cd '$REMOTE_DIR' && npm ci --omit=dev --no-audit --no-fund"
  remote "printf '%s' '$lock' > '$REMOTE_DIR/.npm-lock.md5'"
else
  echo "依赖未变化，跳过 npm ci"
fi
if [ -d "$ROOT/$MODEL_CACHE" ]; then
  remote "mkdir -p '$REMOTE_DIR/$MODEL_CACHE'"
  rsync -az "$ROOT/$MODEL_CACHE/" "$SSH_HOST:$REMOTE_DIR/$MODEL_CACHE/"
else
  echo "本地无模型缓存，远端首次启动会自行下载模型（约 90MB）"
fi

log "5/7 启动 PM2 服务 $APP"
if remote "pm2 describe '$APP' >/dev/null 2>&1"; then
  remote "pm2 restart '$APP'"
else
  remote "cd '$REMOTE_DIR' && pm2 start ecosystem.config.cjs --only '$APP'"
fi
remote "pm2 save" >/dev/null

log "6/7 配置 Nginx 反代 + HTTPS（$DOMAIN）"
if remote "test -f '$CERT'"; then
  echo "证书已存在，跳过签发"
  install_conf final
else
  echo "先放行 ACME 校验，再签发证书"
  install_conf bootstrap
  remote "certbot certonly --webroot -w '$WEBROOT' -d '$DOMAIN' --cert-name '$DOMAIN' --non-interactive --agree-tos --keep-until-expiring"
  install_conf final
fi

log "7/7 自检"
remote "for i in \$(seq 1 60); do curl -fsS 'http://127.0.0.1:$PORT/api/health' >/dev/null 2>&1 && break; sleep 2; done; curl -fsS 'http://127.0.0.1:$PORT/api/health'"
echo
curl -fsSI "https://$DOMAIN/"
curl -fsS "https://$DOMAIN/api/health"
echo
(cd "$ROOT" && node - "$DOMAIN" <<'NODE'
const WebSocket = require('ws')
const ws = new WebSocket(`wss://${process.argv[2]}/ws`)
const timer = setTimeout(() => { console.error('WebSocket 超时'); process.exit(1) }, 15000)
ws.on('error', (e) => { console.error('WebSocket 失败:', e.message); process.exit(1) })
ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', id: 'deploy-check', name: '部署自检' })))
ws.on('message', (raw) => {
  const m = JSON.parse(raw)
  if (m.type === 'state') {
    clearTimeout(timer)
    console.log(`WebSocket OK（model ready: ${m.ready}）`)
    ws.close()
    process.exit(0)
  }
})
NODE
)

log "部署完成：https://$DOMAIN/"
