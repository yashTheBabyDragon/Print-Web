# Stage 1: Build Vite + React + TypeScript bundle
FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

COPY . .
RUN npm run build

# Stage 2: Serve static bundle via Nginx and proxy /api -> backend:8000
FROM nginx:1.27-alpine

RUN printf '%s\n' \
    'limit_req_zone $binary_remote_addr zone=ggprint_auth:10m rate=30r/m;' \
    '' \
    'server {' \
    '    listen 80;' \
    '    server_name _;' \
    '    client_max_body_size 100M;' \
    '' \
    '    root /usr/share/nginx/html;' \
    '    index index.html;' \
    '' \
    '    add_header X-Content-Type-Options "nosniff" always;' \
    '    add_header X-Frame-Options "SAMEORIGIN" always;' \
    '    add_header Referrer-Policy "strict-origin-when-cross-origin" always;' \
    '    add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;' \
    '    add_header Content-Security-Policy "default-src '\''self'\''; script-src '\''self'\''; style-src '\''self'\'' '\''unsafe-inline'\'' https://fonts.googleapis.com; font-src '\''self'\'' https://fonts.gstatic.com data:; img-src '\''self'\'' data: blob:; connect-src '\''self'\''" always;' \
    '' \
    '    gzip on;' \
    '    gzip_types text/plain text/css application/json application/javascript application/octet-stream image/svg+xml model/stl;' \
    '' \
    '    location /api/auth/ {' \
    '        limit_req zone=ggprint_auth burst=20 nodelay;' \
    '        limit_req_status 429;' \
    '        proxy_pass http://backend:8000;' \
    '        proxy_http_version 1.1;' \
    '        proxy_set_header Host $host;' \
    '        proxy_set_header X-Real-IP $remote_addr;' \
    '        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;' \
    '        proxy_set_header X-Forwarded-Proto $scheme;' \
    '        proxy_read_timeout 60s;' \
    '        proxy_send_timeout 60s;' \
    '    }' \
    '' \
    '    location /api/ {' \
    '        proxy_pass http://backend:8000;' \
    '        proxy_http_version 1.1;' \
    '        proxy_set_header Host $host;' \
    '        proxy_set_header X-Real-IP $remote_addr;' \
    '        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;' \
    '        proxy_set_header X-Forwarded-Proto $scheme;' \
    '        proxy_read_timeout 300s;' \
    '        proxy_send_timeout 300s;' \
    '    }' \
    '' \
    '    location /assets/ {' \
    '        expires 30d;' \
    '        add_header Cache-Control "public, immutable";' \
    '        add_header X-Content-Type-Options "nosniff" always;' \
    '        add_header X-Frame-Options "SAMEORIGIN" always;' \
    '        add_header Referrer-Policy "strict-origin-when-cross-origin" always;' \
    '        add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;' \
    '        add_header Content-Security-Policy "default-src '\''self'\''; script-src '\''self'\''; style-src '\''self'\'' '\''unsafe-inline'\'' https://fonts.googleapis.com; font-src '\''self'\'' https://fonts.gstatic.com data:; img-src '\''self'\'' data: blob:; connect-src '\''self'\''" always;' \
    '    }' \
    '' \
    '    location / {' \
    '        try_files $uri $uri/ /index.html;' \
    '    }' \
    '}' \
    > /etc/nginx/conf.d/default.conf

COPY --from=builder /app/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- http://127.0.0.1:80/ >/dev/null 2>&1 || exit 1

CMD ["nginx", "-g", "daemon off;"]
