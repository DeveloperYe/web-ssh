# web-ssh 部署镜像
# 只暴露一个 HTTP 端口（默认 3000），浏览器访问即可连 SSH
FROM node:22-alpine

WORKDIR /app

# 先装依赖，利用层缓存
COPY package*.json ./
RUN npm install --omit=dev

# 拷贝源码与前端静态资源
COPY server.js ./
COPY lib ./lib
COPY public ./public
COPY .env.example ./
# 私钥文件挂载点（可选）：docker run -v /host/id_rsa:/app/id_rsa:ro
VOLUME /app

# 需要对外暴露的端口（用 -p 映射到宿主机 80/443 也行）
EXPOSE 3000

# 通过环境变量配置端口 / 可选 Basic Auth
ENV PORT=3000
ENV HOST=0.0.0.0

CMD ["node", "server.js"]