# PS5 Web Play

[English](./README.md) · [繁體中文](./README.zh-TW.md) · [简体中文](./README.zh-CN.md)

PS5 Web Play streams your PS5 to a browser using a Docker service on your NAS. The bridge uses [chiaki-ng](https://github.com/chiaki-ng/chiaki-ng). This fork provides English, Traditional Chinese, and Simplified Chinese UI options.

## Requirements

Enable Remote Play on your PS5 under Settings → System → Remote Play. The NAS and PS5 should be on the same LAN. Use a browser with WebCodecs and access the app over HTTPS (or localhost).

## Build this fork

From the repository root, build and tag the image, then start it with Docker. An upstream image does not contain this fork’s changes.

```bash
docker build -t ps5web:local .
docker run -d --name ps5web --network host --restart unless-stopped \
  -v "$PWD/data:/data" ps5web:local
docker logs ps5web
```

## Pair and play

Check `docker logs ps5web` for the initial password. Sign in, scan for your PS5 (or enter its IP), and select Add and Pair. On the PS5, select Settings → System → Remote Play → Link Device and enter the eight-digit PIN in the web app along with your Base64 PSN Account ID. Start streaming from the console list.

## Video and security

Start with H.264. Try H.265 only on a browser and system with HEVC decoding support. If playback is unstable, try 720p and a lower bitrate. Use a strong password and HTTPS, preferably behind a VPN for remote access. Keep the mounted `data` directory private and back it up; it contains pairing credentials.

## Docker publishing

The Docker workflow builds and publishes `linux/amd64` and `linux/arm64` images on `v*` tags or manual runs. Set the `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` repository secrets first.

## License

[AGPL-3.0-only](./LICENSE)
