const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
let mode = params.get("mode") === "view" ? "view" : "send";
const isObs = params.get("obs") === "1";
document.body.classList.toggle("obs-mode", isObs);
let ws = null, localStream = null, peer = null, peerId = null, videoTrack = null, audioEnabled = true, zoomMin = 1, zoomMax = 1;
const rtcConfig = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

$("room").value = params.get("room") || "royal-palace";
$("camera").value = params.get("camera") || "cam1";

function status(message) { $("status").textContent = message; }
function setMode(next) {
  mode = next;
  $("sendPanel").classList.toggle("hidden", mode !== "send");
  $("viewPanel").classList.toggle("hidden", mode !== "view");
  $("sendTab").classList.toggle("active", mode === "send");
  $("viewTab").classList.toggle("active", mode === "view");
  const url = new URL(location.href);
  url.searchParams.set("mode", mode);
  history.replaceState({}, "", url);
}
$("sendTab").onclick = () => setMode("send");
$("viewTab").onclick = () => setMode("view");

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
      if (msg.type === "peer-joined") {
        if (mode === "view" && msg.role === "sender" && msg.camera === cameraName()) {
          peerId = msg.id;
          send({ type: "ready", target: msg.id });
        }
      } else if (msg.type === "ready" && mode === "send" && localStream) {
        peerId = msg.from;
        await makeOffer(msg.from);
      } else if (msg.type === "offer" && mode === "view") {
        peerId = msg.from;
        await acceptOffer(msg.description, msg.from);
      } else if (msg.type === "answer" && mode === "send" && peer && msg.from === peerId) {
        await peer.setRemoteDescription(msg.description);
        status("تم إنشاء اتصال الفيديو");
      } else if (msg.type === "ice" && msg.from === peerId && peer && msg.candidate) {
        await peer.addIceCandidate(msg.candidate);
      } else if (msg.type === "peer-left" && msg.id === peerId) {
        closePeer();
        status("انقطع الطرف الآخر. بانتظار إعادة الاتصال...");
      }
    } catch (error) {
      status("تعذر إنشاء الاتصال: " + error.message);
    }
  };
  ws.onclose = () => status("انقطع اتصال غرفة الإشارة. أعد المحاولة.");
  ws.onerror = () => status("تعذر الوصول إلى خادم الإشارة.");
}
function makePeer(targetId) {
  closePeer();
  peer = new RTCPeerConnection(rtcConfig);
  localStream.getTracks().forEach(track => peer.addTrack(track, localStream));
  peer.onicecandidate = event => {
    if (event.candidate) send({ type: "ice", target: targetId, candidate: event.candidate });
  };
  peer.onconnectionstatechange = () => status("حالة الفيديو: " + peer.connectionState);
  return peer;
}
async function makeOffer(targetId) {
  const pc = makePeer(targetId);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  send({ type: "offer", target: targetId, description: pc.localDescription });
  status("أرسلنا طلب الفيديو إلى جهاز الاستقبال...");
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
  await peer.setRemoteDescription(description);
  const answer = await peer.createAnswer();
  await peer.setLocalDescription(answer);
  send({ type: "answer", target: senderId, description: peer.localDescription });
}
function closePeer() {
  if (peer) { peer.ontrack = null; peer.close(); peer = null; }
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
      video: { facingMode: "environment", width: { exact: 1280 }, height: { exact: 720 }, aspectRatio: { ideal: 16 / 9 }, frameRate: { ideal: 30, max: 30 } }
    });
    videoTrack = localStream.getVideoTracks()[0] || null;\n    audioEnabled = true;\n    $("audioToggle").textContent = "إيقاف الصوت";\n    $("audioToggle").classList.remove("muted-audio");\n    setupCameraControls();\n    try { if (screen.orientation?.lock) await screen.orientation.lock("landscape"); } catch {}\n    $("localVideo").srcObject = localStream;
    $("localVideo").classList.remove("hidden");
    connectSignal("sender");
    status("الكاميرا تعمل. بانتظار جهاز الاستقبال...");
  } catch (error) {
    status("لم نتمكن من تشغيل الكاميرا: " + error.message);
  }
};
$("stopCamera").onclick = () => {
  if (localStream) localStream.getTracks().forEach(track => track.stop());
  localStream = null;
  closePeer();
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
} else {
  setMode("send");
}