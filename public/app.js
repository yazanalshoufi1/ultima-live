const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
let mode = params.get("mode") === "view" ? "view" : "send";
let ws = null, localStream = null, peer = null, peerId = null;
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
$("startCamera").onclick = async () => {
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("افتح الموقع عبر HTTPS واستخدم Safari حديثاً");
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: { facingMode: "environment", width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30, max: 30 } }
    });
    $("localVideo").srcObject = localStream;
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
  if (params.get("obs") === "1") $("connectView").click();
} else {
  setMode("send");
}