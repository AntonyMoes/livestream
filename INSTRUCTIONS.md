# Low-Latency WebRTC Streaming Server

Minimal personal streaming service using MediaMTX + nginx + Docker Compose. WebRTC-only for ~1 second latency. No HLS, no frameworks.

**Architecture:** OBS (RTMP, AAC) → MediaMTX path `live` → FFmpeg (AAC→Opus) → path `live_webrtc` → WebRTC → Browser

## Requirements

- Docker & Docker Compose
- OBS Studio (or any RTMP source)

## How to Run

```bash
git clone <your-repo>
cd stream-service
docker compose up -d
```

Open **http://localhost:8080** in your browser.

## OBS Settings

**Required for WebRTC:** MediaMTX closes the stream if H264 has B-frames. You must set **B-frames to 0**.

1. **Settings → Stream**
   - Service: **Custom**
   - Server: `rtmp://YOUR_DOMAIN/live`
   - Stream Key: *(leave empty)*

2. **Settings → Output → Streaming**
   - Encoder: x264 or hardware encoder
   - **CBR** (constant bitrate)
   - **Keyframe interval: 1** (or 1 second)
   - **B-frames: 0** ← required (WebRTC does not support B-frames; stream will disconnect otherwise)

## Host Nginx Reverse Proxy (TLS)

For `stream.yourdomain.com` with TLS termination at the host:

```nginx
server {
    listen 443 ssl;
    server_name stream.yourdomain.com;

    ssl_certificate /path/to/fullchain.pem;
    ssl_certificate_key /path/to/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

## NAT / Public Deployment

When running on a VPS behind NAT:

1. **Set `webrtcICEHostNAT1To1IPs`** in `mediamtx.yml` with your server’s public IP or hostname so ICE candidates are correct:
   ```yaml
   webrtcICEHostNAT1To1IPs: [YOUR_PUBLIC_IP]
   ```

2. **Forward UDP 8189** on your router/firewall to the host running MediaMTX.
