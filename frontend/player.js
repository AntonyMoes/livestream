import { WHEPClient } from "https://cdn.jsdelivr.net/npm/whip-whep@1.2.0/whep.js";

const WHEP_URL = "/webrtc/live/whep";
const STUN_SERVER = "stun:stun.l.google.com:19302";
const RETRY_MS = 3000;

const video = document.getElementById("video");
const statusEl = document.getElementById("status");

function setStatus(text) {
  statusEl.textContent = text;
}

async function connect() {
  setStatus("Connecting…");

  const pc = new RTCPeerConnection({
    iceServers: [{ urls: STUN_SERVER }],
    bundlePolicy: "max-bundle",
  });

  pc.addTransceiver("video", { direction: "recvonly" });
  pc.addTransceiver("audio", { direction: "recvonly" });

  pc.ontrack = (e) => {
    setStatus(video.muted ? "Live (click unmute for audio)" : "Live");
    video.srcObject = e.streams[0];
    video.play().catch(() => {});
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "closed") {
      setStatus("Stream Offline");
      setTimeout(connect, RETRY_MS);
    } else if (pc.connectionState === "failed") {
      setTimeout(() => {
        if (pc.connectionState === "failed") {
          setStatus("Stream Offline");
          pc.close();
          setTimeout(connect, RETRY_MS);
        }
      }, 2000);
    }
  };

  try {
    const whep = new WHEPClient();
    await whep.view(pc, new URL(WHEP_URL, location.origin).href, null);
  } catch (err) {
    setStatus("Stream Offline");
    pc.close();
    setTimeout(connect, RETRY_MS);
  }
}

connect();
