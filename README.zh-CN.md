# PS5 Web Play

[English](./README.md) · [繁體中文](./README.zh-TW.md) · [简体中文](./README.zh-CN.md)

PS5 Web Play 通过 NAS 上的 Docker 服务，将 PS5 画面串流到浏览器。桥接层使用 [chiaki-ng](https://github.com/chiaki-ng/chiaki-ng)。此分支提供英文、繁体中文和简体中文界面。

## 环境要求

在 PS5 的「设置 → 系统 → 远程游玩」启用远程游玩。NAS 和 PS5 应位于同一局域网。请使用支持 WebCodecs 的浏览器，通过 HTTPS（或 localhost）访问。

## 构建此分支

在仓库根目录构建并标记镜像，再用 Docker 启动。上游镜像不包含此分支的修改。

```bash
docker build -t ps5web:local .
docker run -d --name ps5web --network host --restart unless-stopped \
  -v "$PWD/data:/data" ps5web:local
docker logs ps5web
```

## 配对与游玩

用 `docker logs ps5web` 查看初始密码。登录后扫描 PS5（也可手动输入 IP），选择添加并配对。在 PS5 上打开「设置 → 系统 → 远程游玩 → 关联设备」，在网页中输入八位 PIN 和 Base64 格式的 PSN Account ID，再从主机列表开始串流。

## 画质与安全

建议先用 H.264。只有浏览器和系统支持 HEVC 解码时才尝试 H.265。播放不稳定时可改用 720p 并降低码率。使用强密码和 HTTPS，远程访问建议通过 VPN。请保护并备份挂载的 `data` 目录，其中包含配对凭据。

## 发布 Docker 镜像

推送 `v*` 标签或手动运行工作流时，将构建并发布 `linux/amd64` 和 `linux/arm64` 镜像。请先设置仓库的 `DOCKERHUB_USERNAME` 和 `DOCKERHUB_TOKEN` secrets。

## 许可

[AGPL-3.0-only](./LICENSE)
