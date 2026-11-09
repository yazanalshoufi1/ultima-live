const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const portal = params.get("portal") === "control" ? "control" : params.get("portal") === "sender" ? "sender" : "legacy";
let mode = portal === "control" ? "multi" : params.get("mode") === "view" ? "view" : params.get("mode") === "multi" ? "multi" : "send";
document.body.classList.toggle("sender-portal", portal === "sender");
document.body.classList.toggle("control-portal", portal === "control");
const isObs = params.get("obs") === "1";
document.body.classList.toggle("obs-mode", isObs);
document.body.classList.toggle("multiview-mode", mode === "multi");
let ws = null, localStream = null, peer = null, peerId = null, videoTrack = null, audioEnabled = true, zoomMin = 1, zoomMax = 1;
const senderPeers = new Map();
const senderIceQueue = new Map();
let viewerIceQueue = [];
const multiPeers = new Map();
const multiPending = new Map();
const multiIceQueue = new Map();
const multiCameras = ["cam1", "cam2", "cam3", "cam4", "cam5"];
const rtcConfig = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

$("room").value = params.get("room") || "royal-palace";
$("camera").value = params.get("camera") || "cam1";
if (portal === "sender") { $("room").value = params.get("room") || "royal-palace"; $("camera").value = params.get("camera") || "cam1"; }

function status(message) { $("status").textContent = message; }
function setMode(next) {
  mode = next;
  $("sendPanel").classList.toggle("hidden", mode !== "send");
  $("viewPanel").classList.toggle("hidden", mode !== "view");
  $("multiPanel").classList.toggle("hidden", mode !== "multi");
  $("sendTab").classList.toggle("active", mode === "send");
  $("viewTab").classList.toggle("active", mode === "view");
  $("multiTab").classList.toggle("active", mode === "multi");
  document.body.classList.toggle("multiview-mode", mode === "multi");
  const url = new URL(location.href);
  url.searchParams.set("mode", mode);
  history.replaceState({}, "", url);
}
$("sendTab").onclick = () => setMode("send");
$("viewTab").onclick = () => setMode("view");
$("multiTab").onclick = () => setMode("multi");

function roomName() {
  return $("room").value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 40) || "royal-palace";
}
function cameraName() { return $("camera").value; }
function send(data) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}
function connectSignal(role) {
  if (ws && ws.readyState <= WebSocket.OPEN) ws.close();
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${scheme}//${location.host}/signal?room=${encodeURIComponent(roomName())}`);
  ws.onopen = () => {
    send({ type: "register", role, camera: cameraName() });
    status("متصل بغرفة " + roomName() + "، بانتظار الطرف الآخر...");
  };
  ws.onmessage = async (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    try {
      if (mode === "multi") {
        await handleMultiMessage(msg);
        return;
      }
      if (msg.type === "peer-joined") {
        if (mode === "view" && msg.role === "sender" && msg.camera === cameraName()) {
          peerId = msg.id;
          send({ type: "ready", target: msg.id });
        }
      } else if (msg.type === "ready" && mode === "send" && localStream) {
        await makeOffer(msg.from);
      } else if (msg.type === "offer" && mode === "view") {
        peerId = msg.from;
        await acceptOffer(msg.description, msg.from);
      } else if (msg.type === "answer" && mode === "send" && senderPeers.has(msg.from)) {
        const pc = senderPeers.get(msg.from);
        await pc.setRemoteDescription(msg.description);
        const queued = senderIceQueue.get(msg.from) || [];
        for (const candidate of queued) await pc.addIceCandidate(candidate);
        senderIceQueue.delete(msg.from);
        status("تم إنشاء اتصال الفيديو");
      } else if (msg.type === "ice" && msg.candidate) {
        if (mode === "send" && senderPeers.has(msg.from)) {
          const pc = senderPeers.get(msg.from);
          if (pc.remoteDescription) await pc.addIceCandidate(msg.candidate);
          else {
            const queue = senderIceQueue.get(msg.from) || [];
            queue.push(msg.candidate);
            senderIceQueue.set(msg.from, queue);
          }
        } else if (mode === "view" && msg.from === peerId && peer) {
          if (peer.remoteDescription) await peer.addIceCandidate(msg.candidate);
          else viewerIceQueue.push(msg.candidate);
        }
      } else if (msg.type === "peer-left") {
        if (mode === "send" && senderPeers.has(msg.id)) {
          closeSenderPeer(msg.id);
        } else if (mode === "view" && msg.id === peerId) {
          closePeer();
          status("انقطع الطرف الآخر. بانتظار إعادة الاتصال...");
        }
      }
    } catch (error) {
      status("تعذر إنشاء الاتصال: " + error.message);
    }
  };
  ws.onclose = () => status("انقطع اتصال غرفة الإشارة. أعد المحاولة.");
  ws.onerror = () => status("تعذر الوصول إلى خادم الإشارة.");
}
function setMultiCameraState(camera, message, state = "waiting") {
  const tile = $("tile-" + camera);
  if (!tile) return;
  tile.dataset.state = state;
  $("tile-status-" + camera).textContent = message;
}
function clearMultiPeer(id) {
  const pc = multiPeers.get(id);
  const camera = multiPending.get(id);
  if (pc) {
    pc.ontrack = null;
    pc.close();
    multiPeers.delete(id);
  }
  if (camera) {
    const stillConnected = [...multiPending.entries()].some(([otherId, otherCamera]) =>
      otherCamera === camera && otherId !== id && multiPeers.has(otherId)
    );
    if (!stillConnected) {
      const video = $("video-" + camera);
      if (video) video.srcObject = null;
      setMultiCameraState(camera, "بانتظار الكاميرا", "waiting");
    }
  }
  multiPending.delete(id);
  multiIceQueue.delete(id);
}
function closeAllMultiPeers() {
  for (const id of [...multiPeers.keys()]) clearMultiPeer(id);
  multiPending.clear();
  multiIceQueue.clear();
  for (const camera of multiCameras) {
    const video = $("video-" + camera);
    if (video) video.srcObject = null;
    setMultiCameraState(camera, "بانتظار الكاميرا", "waiting");
  }
}
async function handleMultiMessage(msg) {
  if (msg.type === "peer-joined" && msg.role === "sender" && multiCameras.includes(msg.camera)) {
    multiPending.set(msg.id, msg.camera);
    setMultiCameraState(msg.camera, "جارٍ الاتصال...", "connecting");
    send({ type: "ready", target: msg.id });
    return;
  }
  if (msg.type === "offer") {
    const camera = multiPending.get(msg.from);
    if (!camera) return;
    const old = multiPeers.get(msg.from);
    if (old) { old.close(); multiPeers.delete(msg.from); }
    const pc = new RTCPeerConnection(rtcConfig);
    multiPeers.set(msg.from, pc);
    pc.ontrack = event => {
      const video = $("video-" + camera);
      if (video) {
        video.srcObject = event.streams[0];
        video.play().catch(() => {});
      }
      setMultiCameraState(camera, "متصلة", "connected");
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected") {
        setMultiCameraState(camera, "متصلة", "connected");
      } else if (pc.connectionState === "failed" || pc.connectionState === "disconnected" || pc.connectionState === "closed") {
        setMultiCameraState(camera, "الاتصال غير مستقر", "connecting");
      }
    };
    pc.onicecandidate = event => {
      if (event.candidate) send({ type: "ice", target: msg.from, candidate: event.candidate });
    };
    await pc.setRemoteDescription(msg.description);
    const queued = multiIceQueue.get(msg.from) || [];
    for (const candidate of queued) await pc.addIceCandidate(candidate);
    multiIceQueue.delete(msg.from);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    send({ type: "answer", target: msg.from, description: pc.localDescription });
    return;
  }
  if (msg.type === "ice" && msg.candidate) {
    const pc = multiPeers.get(msg.from);
    if (pc && pc.remoteDescription) {
      await pc.addIceCandidate(msg.candidate);
    } else {
      const queue = multiIceQueue.get(msg.from) || [];
      queue.push(msg.candidate);
      multiIceQueue.set(msg.from, queue);
    }
    return;
  }
  if (msg.type === "peer-left") {
    clearMultiPeer(msg.id);
  }
}
function connectMultiView() {
  closeAllMultiPeers();
  connectSignal("viewer");
}
function disconnectMultiView() {
  if (ws) { ws.close(); ws = null; }
  closeAllMultiPeers();
  status("تم إيقاف شاشة المراقبة");
}
$("connectMulti").onclick = connectMultiView;
$("disconnectMulti").onclick = disconnectMultiView;
$("copyControlLink").onclick = async () => {
  const url = new URL(location.href);
  url.search = "";
  url.searchParams.set("portal", "control");
  url.searchParams.set("room", roomName());
  url.searchParams.set("mode", "multi");
  try {
    await navigator.clipboard.writeText(url.toString());
    status("تم نسخ رابط واجهة الإدارة");
  } catch {
    status(url.toString());
  }
};
$("copySenderLink").onclick = async () => {
  const url = new URL(location.href);
  url.search = "";
  url.searchParams.set("portal", "sender");
  url.searchParams.set("mode", "send");
  url.searchParams.set("room", roomName());
  url.searchParams.set("camera", cameraName());
  try {
    await navigator.clipboard.writeText(url.toString());
    status("تم إنشاء ونسخ رابط المصوّر لهذه الكاميرا");
  } catch {
    status(url.toString());
  }
};
$("copyMultiUrl").onclick = async () => {
  const url = new URL(location.href);
  url.search = "";
  url.searchParams.set("portal", "control");
  url.searchParams.set("mode", "multi");
  url.searchParams.set("room", roomName());
  url.searchParams.set("obs", "1");
  try {
    await navigator.clipboard.writeText(url.toString());
    status("تم نسخ رابط شاشة المراقبة لـ OBS");
  } catch {
    status(url.toString());
  }
};

function makePeer(targetId) {
  closeSenderPeer(targetId);
  const pc = new RTCPeerConnection(rtcConfig);
  senderPeers.set(targetId, pc);
  senderIceQueue.delete(targetId);
  localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
  pc.onicecandidate = event => {
    if (event.candidate) send({ type: "ice", target: targetId, candidate: event.candidate });
  };
  pc.onconnectionstatechange = () => status("حالة الفيديو: " + pc.connectionState);
  return pc;
}
async function makeOffer(targetId) {
  const pc = makePeer(targetId);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  send({ type: "offer", target: targetId, description: pc.localDescription });
  status("أرسلنا طلب الفيديو إلى جهاز الاستقبال...");
}
function closeSenderPeer(targetId) {
  const pc = senderPeers.get(targetId);
  if (pc) {
    pc.onicecandidate = null;
    pc.close();
    senderPeers.delete(targetId);
  }
  senderIceQueue.delete(targetId);
}
function closeAllSenderPeers() {
  for (const id of [...senderPeers.keys()]) closeSenderPeer(id);
}
async function acceptOffer(description, senderId) {
  closePeer();
  peer = new RTCPeerConnection(rtcConfig);
  peer.ontrack = event => {
    $("remoteVideo").srcObject = event.streams[0];
    status("وصلت الكاميرا بنجاح");
  };
  peer.onicecandidate = event => {
    if (event.candidate) send({ type: "ice", target: senderId, candidate: event.candidate });
  };
  peer.onconnectionstatechange = () => status("حالة الفيديو: " + peer.connectionState);
  viewerIceQueue = [];
  await peer.setRemoteDescription(description);
  for (const candidate of viewerIceQueue) await peer.addIceCandidate(candidate);
  viewerIceQueue = [];
  const answer = await peer.createAnswer();
  await peer.setLocalDescription(answer);
  send({ type: "answer", target: senderId, description: peer.localDescription });
}
function closePeer() {
  if (peer) { peer.ontrack = null; peer.close(); peer = null; }
  viewerIceQueue = [];
}
function setupCameraControls() {
  const caps = videoTrack?.getCapabilities?.() || {};
  const zoom = $("zoomControl");
  const value = $("zoomValue");
  if (caps.zoom && Number.isFinite(caps.zoom.max) && caps.zoom.max > (caps.zoom.min || 1)) {
    zoomMin = caps.zoom.min || 1;
    zoomMax = caps.zoom.max;
    zoom.min = zoomMin;
    zoom.max = zoomMax;
    zoom.step = caps.zoom.step || 0.1;
    zoom.value = Math.max(zoomMin, Math.min(zoomMax, caps.zoom.min || 1));
    zoom.disabled = false;
    value.textContent = Number(zoom.value).toFixed(1) + "×";
  } else {
    zoom.min = 1; zoom.max = 1; zoom.value = 1; zoom.disabled = true;
    value.textContent = "غير مدعوم";
  }
  $("cameraTools").classList.remove("hidden");
}
$("zoomControl").oninput = async () => {
  if (!videoTrack || $("zoomControl").disabled) return;
  const zoom = Number($("zoomControl").value);
  $("zoomValue").textContent = zoom.toFixed(1) + "×";
  try { await videoTrack.applyConstraints({ advanced: [{ zoom }] }); }
  catch (error) { status("هذا مستوى الزوم غير مدعوم: " + error.message); }
};
$("audioToggle").onclick = () => {
  if (!localStream) return;
  audioEnabled = !audioEnabled;
  localStream.getAudioTracks().forEach(track => { track.enabled = audioEnabled; });
  $("audioToggle").textContent = audioEnabled ? "إيقاف الصوت" : "تشغيل الصوت";
  $("audioToggle").classList.toggle("muted-audio", !audioEnabled);
  status(audioEnabled ? "الصوت يعمل وسيصل إلى OBS" : "تم كتم الصوت المرسل إلى OBS");
};

$("startCamera").onclick = async () => {
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("افتح الموقع عبر HTTPS واستخدم Safari حديثاً");
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 }, aspectRatio: { ideal: 16 / 9 }, frameRate: { ideal: 30, max: 30 } }
    });
    videoTrack = localStream.getVideoTracks()[0] || null;
    audioEnabled = true;
    $("audioToggle").textContent = "إيقاف الصوت";
    $("audioToggle").classList.remove("muted-audio");
    setupCameraControls();
    try { if (screen.orientation?.lock) await screen.orientation.lock("landscape"); } catch {}
    $("localVideo").srcObject = localStream;
    $("localVideo").classList.remove("hidden");
    connectSignal("sender");
    status("الكاميرا تعمل. بانتظار جهاز الاستقبال...");
  } catch (error) {
    if (localStream) localStream.getTracks().forEach(track => track.stop());
    localStream = null;
    videoTrack = null;
    status("لم نتمكن من تشغيل الكاميرا: " + error.message);
  }
};
$("stopCamera").onclick = () => {
  if (localStream) localStream.getTracks().forEach(track => track.stop());
  localStream = null;
  closePeer();
  closeAllSenderPeers();
  if (ws) ws.close();
  $("localVideo").srcObject = null;
  $("localVideo").classList.add("hidden");
  status("تم إيقاف الكاميرا");
};
$("connectView").onclick = () => {
  $("remoteVideo").srcObject = null;
  connectSignal("viewer");
};
$("copyUrl").onclick = async () => {
  const url = new URL(location.href);
  url.search = "";
  url.searchParams.set("mode", "view");
  url.searchParams.set("room", roomName());
  url.searchParams.set("camera", cameraName());
  url.searchParams.set("obs", "1");
  try {
    await navigator.clipboard.writeText(url.toString());
    status("تم نسخ رابط OBS");
  } catch {
    status(url.toString());
  }
};

if (mode === "view") {
  setMode("view");
  if (isObs) $("connectView").click();
} else if (mode === "multi") {
  setMode("multi");
  if (isObs) connectMultiView();
} else {
  setMode("send");
}