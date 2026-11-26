# PS5 Web Play

[English](./README.md) · [繁體中文](./README.zh-TW.md) · [简体中文](./README.zh-CN.md)

PS5 Web Play 透過 NAS 上的 Docker 服務，將 PS5 畫面串流到瀏覽器。橋接層使用 [chiaki-ng](https://github.com/chiaki-ng/chiaki-ng)。此分支提供英文、繁體中文及簡體中文介面。

## 環境需求

在 PS5 的「設定 → 系統 → 遙控遊玩」啟用遙控遊玩。NAS 與 PS5 應位於同一區域網路。請使用支援 WebCodecs 的瀏覽器，透過 HTTPS（或 localhost）開啟網頁。

## 建置此分支

在儲存庫根目錄建置並標記映像檔，再用 Docker 啟動。上游映像檔不包含此分支的修改。

```bash
docker build -t ps5web:local .
docker run -d --name ps5web --network host --restart unless-stopped \
  -v "$PWD/data:/data" ps5web:local
docker logs ps5web
```

## 配對與遊玩

用 `docker logs ps5web` 查看初始密碼。登入後掃描 PS5（也可手動輸入 IP），選擇新增並配對。在 PS5 上開啟「設定 → 系統 → 遙控遊玩 → 連結裝置」，在網頁輸入八位數 PIN 與 Base64 格式的 PSN 帳戶 ID，再從主機清單開始串流。

## 畫質與安全

建議先使用 H.264。只有在瀏覽器和系統支援 HEVC 解碼時才嘗試 H.265。播放不穩時可改用 720p 並降低位元率。使用強密碼及 HTTPS，遠端存取建議透過 VPN。請妥善保護並備份掛載的 `data` 目錄，其中包含配對憑證。

## 發佈 Docker 映像檔

推送 `v*` 標籤或手動執行工作流程時，會建置並發佈 `linux/amd64` 和 `linux/arm64` 映像檔。請先設定儲存庫的 `DOCKERHUB_USERNAME` 與 `DOCKERHUB_TOKEN` 密碼資料。

## 授權

[AGPL-3.0-only](./LICENSE)
