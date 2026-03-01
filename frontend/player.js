/**
 * Minimal WHEP WebRTC player for MediaMTX
 * Sends ALL ICE candidates (whip-whep only sends index 0, which can cause one-frame freeze)
 */
const WHEP_URL = "/webrtc/live/whep";
const STUN_SERVER = "stun:stun.l.google.com:19302";
const RETRY_MS = 3000;

const video = document.getElementById("video");
const statusEl = document.getElementById("status");
const debugEl = document.getElementById("debug");

const debug = {
  log: (msg, data) => {
    const line = document.createElement("div");
    line.textContent = data !== undefined ? `${msg}: ${JSON.stringify(data)}` : msg;
    line.className = "debug-line";
    if (debugEl) {
      debugEl.appendChild(line);
      debugEl.scrollTo(0, debugEl.scrollHeight);
    }
    console.log("[WHEP]", msg, data);
  },
  set: (key, value) => {
    const el = document.getElementById(`debug-${key}`);
    if (el) el.textContent = String(value);
  },
};

function setStatus(text) {
  statusEl.textContent = text;
}

function buildTrickleFragment(offerSdp, candidates, includeEndOfCandidates = false) {
  const lines = offerSdp.split("\r\n");
  let iceUfrag = "";
  let icePwd = "";
  const mids = [];

  for (const line of lines) {
    if (line.startsWith("a=mid:")) mids.push(line.slice(6));
    else if (!iceUfrag && line.startsWith("a=ice-ufrag:")) iceUfrag = line.slice(12);
    else if (!icePwd && line.startsWith("a=ice-pwd:")) icePwd = line.slice(10);
  }

  let frag = `a=ice-ufrag:${iceUfrag}\r\na=ice-pwd:${icePwd}\r\n`;

  const byMid = {};
  for (const c of candidates) {
    const mid = c.sdpMid ?? mids[c.sdpMLineIndex] ?? String(c.sdpMLineIndex);
    if (!byMid[mid]) byMid[mid] = [];
    byMid[mid].push(c);
  }

  for (const mid of Object.keys(byMid).sort()) {
    frag += `a=mid:${mid}\r\n`;
    for (const c of byMid[mid]) frag += `a=${c.candidate}\r\n`;
  }
  if (includeEndOfCandidates) frag += "a=end-of-candidates\r\n";
  return frag;
}

async function connect() {
  setStatus("Connecting…");
  debug.log("connect", { url: new URL(WHEP_URL, location.origin).href });

  const pc = new RTCPeerConnection({
    iceServers: [{ urls: STUN_SERVER }],
    bundlePolicy: "max-bundle",
  });

  pc.addTransceiver("video", { direction: "recvonly" });
  pc.addTransceiver("audio", { direction: "recvonly" });

  let sessionUrl = null;
  const queuedCandidates = [];
  let offerSdp = null;
  let iceGatheringComplete = false;

  pc.ontrack = (e) => {
    debug.log("ontrack", { kind: e.track.kind, id: e.track.id });
    setStatus(video.muted ? "Live (click unmute for audio)" : "Live");
    video.srcObject = e.streams[0];
    video.play().catch((err) => debug.log("video.play error", err.message));
  };

  video.onerror = () => debug.log("video error", { error: video.error?.message, code: video.error?.code });
  video.onstalled = () => debug.log("video stalled");
  video.onwaiting = () => debug.log("video waiting");

  pc.onconnectionstatechange = () => {
    debug.set("connState", pc.connectionState);
    debug.log("connectionState", pc.connectionState);
    if (pc.connectionState === "closed") {
      setStatus("Stream Offline");
      setTimeout(connect, RETRY_MS);
    } else if (pc.connectionState === "failed") {
      setTimeout(() => {
        if (pc.connectionState === "failed") {
          debug.log("connection failed, reconnecting");
          setStatus("Stream Offline");
          pc.close();
          setTimeout(connect, RETRY_MS);
        }
      }, 2000);
    }
  };

  pc.oniceconnectionstatechange = () => {
    debug.set("iceState", pc.iceConnectionState);
    debug.log("iceConnectionState", pc.iceConnectionState);
  };

  pc.onicegatheringstatechange = () => {
    debug.set("gatherState", pc.iceGatheringState);
    debug.log("iceGatheringState", pc.iceGatheringState);
    if (pc.iceGatheringState === "complete") iceGatheringComplete = true;
  };

  debug.set("connState", pc.connectionState);
  debug.set("iceState", pc.iceConnectionState);
  debug.set("gatherState", pc.iceGatheringState);

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      queuedCandidates.push(e.candidate);
      debug.log("ice candidate", {
        mid: e.candidate.sdpMid,
        idx: e.candidate.sdpMLineIndex,
        type: e.candidate.type,
      });
      if (sessionUrl) {
        sendTrickle(sessionUrl, offerSdp, [e.candidate], false).catch((err) =>
          debug.log("trickle PATCH error", err.message)
        );
      }
    } else {
      debug.log("ice gathering complete", { total: queuedCandidates.length });
    }
  };

  async function sendTrickle(url, sdp, candidates, endOfCandidates = false) {
    const body = buildTrickleFragment(sdp, candidates, endOfCandidates);
    const res = await fetch(url, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/trickle-ice-sdpfrag",
        "If-Match": "*",
      },
      body,
    });
    debug.log("trickle PATCH", { status: res.status, url });
    if (!res.ok && res.status !== 204) {
      throw new Error(`PATCH ${res.status}`);
    }
  }

  try {
    const offer = await pc.createOffer();
    offerSdp = offer.sdp;
    await pc.setLocalDescription(offer);

    debug.log("POST offer", { sdpLen: offer.sdp.length });

    const res = await fetch(new URL(WHEP_URL, location.origin).href, {
      method: "POST",
      headers: { "Content-Type": "application/sdp" },
      body: offer.sdp,
    });

    if (res.status === 404) throw new Error("stream not found");
    if (res.status !== 201) throw new Error(`POST ${res.status}`);

    const loc = res.headers.get("Location");
    if (loc.startsWith("http://") || loc.startsWith("https://")) {
      sessionUrl = loc;
    } else if (loc.startsWith("/webrtc")) {
      sessionUrl = new URL(loc, location.origin).href;
    } else {
      sessionUrl = new URL("/webrtc" + (loc.startsWith("/") ? loc : "/" + loc), location.origin).href;
    }

    debug.log("session URL", sessionUrl);

    const answerSdp = await res.text();
    await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });

    if (queuedCandidates.length > 0) {
      await sendTrickle(sessionUrl, offerSdp, queuedCandidates, false);
    }

    await new Promise((resolve) => {
      if (pc.iceGatheringState === "complete") return resolve();
      const check = () => {
        if (pc.iceGatheringState === "complete") resolve();
        else setTimeout(check, 100);
      };
      setTimeout(check, 100);
    });

    const finalCandidates = [...queuedCandidates];
    if (finalCandidates.length > 0) {
      await sendTrickle(sessionUrl, offerSdp, finalCandidates, true);
    }

    startStatsLoop(pc);
  } catch (err) {
    debug.log("connect error", err.message);
    setStatus("Stream Offline");
    pc.close();
    setTimeout(connect, RETRY_MS);
  }
}

function startStatsLoop(pc) {
  let lastBytes = 0;
  const loop = async () => {
    if (pc.connectionState === "closed") return;
    try {
      const stats = await pc.getStats();
      let bytesReceived = 0;
      let packetsReceived = 0;
      let packetsLost = 0;
      stats.forEach((report) => {
        if (report.bytesReceived !== undefined) bytesReceived += report.bytesReceived;
        if (report.packetsReceived !== undefined) packetsReceived += report.packetsReceived;
        if (report.packetsLost !== undefined) packetsLost += report.packetsLost;
      });
      const delta = bytesReceived - lastBytes;
      lastBytes = bytesReceived;
      debug.set("stats", `↓${(bytesReceived / 1024).toFixed(0)}KB | ${packetsReceived} pkts | -${packetsLost} lost`);
      if (video) debug.set("video", `readyState=${video.readyState} networkState=${video.networkState}`);
    } catch (e) {}
    setTimeout(loop, 2000);
  };
  loop();
}

connect();
