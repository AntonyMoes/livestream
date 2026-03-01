(function () {
  const video = document.getElementById('video');
  const status = document.getElementById('status');
  const WHEP_URL = '/webrtc/live/whep';
  const RETRY_MS = 3000;

  function setStatus(text) { status.textContent = text; }

  function parseIceServers(linkHeader) {
    if (!linkHeader) return [{ urls: 'stun:stun.l.google.com:19302' }];
    const servers = [];
    linkHeader.split(', ').forEach(function (part) {
      const m = part.match(/^<(.+?)>; rel="ice-server"/i);
      if (m) servers.push({ urls: [m[1]] });
    });
    return servers.length ? servers : [{ urls: 'stun:stun.l.google.com:19302' }];
  }

  function connect() {
    setStatus('Connecting…');
    let pc = null;
    let sessionUrl = null;
    let queued = [];
    let offerData = { iceUfrag: '', icePwd: '', medias: [] };

    function parseOffer(sdp) {
      sdp.split('\r\n').forEach(function (line) {
        if (line.startsWith('m=')) offerData.medias.push(line.slice(2));
        else if (!offerData.iceUfrag && line.startsWith('a=ice-ufrag:')) offerData.iceUfrag = line.slice(12);
        else if (!offerData.icePwd && line.startsWith('a=ice-pwd:')) offerData.icePwd = line.slice(10);
      });
    }

    function sdpFragment(candidates) {
      let frag = 'a=ice-ufrag:' + offerData.iceUfrag + '\r\na=ice-pwd:' + offerData.icePwd + '\r\n';
      const byMid = {};
      candidates.forEach(function (c) {
        const mid = c.sdpMLineIndex;
        if (!byMid[mid]) byMid[mid] = [];
        byMid[mid].push(c);
      });
      Object.keys(byMid).forEach(function (mid) {
        frag += 'm=' + offerData.medias[mid] + '\r\na=mid:' + mid + '\r\n';
        byMid[mid].forEach(function (c) { frag += 'a=' + c.candidate + '\r\n'; });
      });
      return frag;
    }

    function fail(err) {
      if (pc) pc.close();
      setStatus('Stream Offline');
      setTimeout(connect, RETRY_MS);
    }

    fetch(WHEP_URL, { method: 'OPTIONS' })
      .then(function (r) { return parseIceServers(r.headers.get('Link')); })
      .then(function (iceServers) {
        pc = new RTCPeerConnection({ iceServers: iceServers });
        pc.addTransceiver('video', { direction: 'recvonly' });
        pc.addTransceiver('audio', { direction: 'recvonly' });
        pc.ontrack = function (e) {
          setStatus(video.muted ? 'Live (click unmute for audio)' : 'Live');
          video.srcObject = e.streams[0];
          video.play().catch(function () {});
        };
        pc.onconnectionstatechange = function () {
          if (pc.connectionState === 'closed') fail();
          if (pc.connectionState === 'failed') {
            setTimeout(function () {
              if (pc && pc.connectionState === 'failed') fail();
            }, 2000); // Brief delay; connection may recover
          }
        };
        pc.onicecandidate = function (e) {
          if (!e.candidate) return;
          if (sessionUrl) {
            fetch(sessionUrl, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/trickle-ice-sdpfrag', 'If-Match': '*' },
              body: sdpFragment([e.candidate])
            }).catch(function () {}); // Don't fail connection on PATCH errors; ICE may still work
          } else queued.push(e.candidate);
        };
        return pc.createOffer();
      })
      .then(function (offer) {
        parseOffer(offer.sdp);
        return pc.setLocalDescription(offer).then(function () { return offer.sdp; });
      })
      .then(function (sdp) {
        return fetch(WHEP_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/sdp' },
          body: sdp
        });
      })
      .then(function (res) {
        if (res.status === 404) throw new Error('stream not found');
        if (res.status !== 201) throw new Error('bad status ' + res.status);
        var loc = res.headers.get('Location');
        sessionUrl = loc.startsWith('/webrtc') ? new URL(loc, window.location.origin).href : new URL('/webrtc' + (loc.startsWith('/') ? loc : '/' + loc), window.location.origin).href;
        return res.text();
      })
      .then(function (answer) {
        return pc.setRemoteDescription({ type: 'answer', sdp: answer });
      })
      .then(function () {
        if (queued.length) {
          fetch(sessionUrl, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/trickle-ice-sdpfrag', 'If-Match': '*' },
            body: sdpFragment(queued)
          }).catch(function () {}); // Don't fail; ICE may still establish
        }
      })
      .catch(fail);
  }

  connect();
})();
