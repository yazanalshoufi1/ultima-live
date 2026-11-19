import { DurableObject } from "cloudflare:workers";

const SESSION_COOKIE = "ultima_admin_session";
const SESSION_TTL = 12 * 60 * 60;

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers }
  });
}

function base64url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replaceAll("+", "-").replaceAll("/", "_");
}

function decodeBase64url(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

async function sign(value, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
}

function safeEqual(a, b) {
  const left = new TextEncoder().encode(String(a));
  const right = new TextEncoder().encode(String(b));
  let diff = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i++) diff |= (left[i % (left.length || 1)] || 0) ^ (right[i % (right.length || 1)] || 0);
  return diff === 0;
}

function getCookie(request, name) {
  const cookies = request.headers.get("Cookie") || "";
  for (const part of cookies.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return "";
}

async function hasAdminSession(request, env) {
  if (!env.ADMIN_SESSION_SECRET) return false;
  const token = getCookie(request, SESSION_COOKIE);
  if (!token) return false;
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  try {
    const payloadBytes = decodeBase64url(parts[0]);
    const payload = JSON.parse(new TextDecoder().decode(payloadBytes));
    if (payload.exp < Math.floor(Date.now() / 1000) || payload.sub !== env.ADMIN_USERNAME) return false;
    const expected = await sign(parts[0], env.ADMIN_SESSION_SECRET);
    const supplied = decodeBase64url(parts[1]);
    if (expected.length !== supplied.length) return false;
    return safeEqual(expected.join(","), supplied.join(","));
  } catch {
    return false;
  }
}

async function createSession(username, env) {
  const payload = base64url(new TextEncoder().encode(JSON.stringify({
    sub: username,
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL
  })));
  const signature = base64url(await sign(payload, env.ADMIN_SESSION_SECRET));
  return payload + "." + signature;
}

function cookieHeader(value, maxAge = SESSION_TTL) {
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

function sameOrigin(request, url) {
  return request.headers.get("Origin") === url.origin;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/admin/login" && request.method === "POST") {
      if (!sameOrigin(request, url)) return json({ error: "طلب غير مسموح" }, 403);
      if (!env.ADMIN_USERNAME || !env.ADMIN_PASSWORD || !env.ADMIN_SESSION_SECRET) {
        return json({ error: "إعداد بيانات الإدارة غير مكتمل على الخادم" }, 503);
      }
      let body;
      try { body = await request.json(); } catch { return json({ error: "بيانات الدخول غير صالحة" }, 400); }
      if (!safeEqual(body.username || "", env.ADMIN_USERNAME) || !safeEqual(body.password || "", env.ADMIN_PASSWORD)) {
        return json({ error: "اسم المستخدم أو كلمة المرور غير صحيح" }, 401);
      }
      const token = await createSession(env.ADMIN_USERNAME, env);
      return json({ ok: true }, 200, { "set-cookie": cookieHeader(token) });
    }

    if (url.pathname === "/admin/session" && request.method === "GET") {
      const authenticated = await hasAdminSession(request, env);
      return json({ authenticated }, authenticated ? 200 : 401);
    }

    if (url.pathname === "/admin/logout" && request.method === "POST") {
      if (!sameOrigin(request, url)) return json({ error: "طلب غير مسموح" }, 403);
      return json({ ok: true }, 200, { "set-cookie": cookieHeader("", 0) });
    }

    if (url.pathname === "/signal") {
      if (url.searchParams.get("portal") === "control" && !(await hasAdminSession(request, env))) {
        return new Response("Admin authentication required", { status: 401 });
      }
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return new Response("WebSocket upgrade required", { status: 426 });
      }
      const room = (url.searchParams.get("room") || "default").replace(/[^a-z0-9_-]/gi, "").slice(0, 40);
      if (!room) return new Response("Invalid room", { status: 400 });
      const id = env.ROOMS.idFromName(room);
      return env.ROOMS.get(id).fetch(request);
    }
    return env.ASSETS.fetch(request);
  }
};

export class Room extends DurableObject {
  async fetch(request) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.serializeAttachment({ id: crypto.randomUUID(), registered: false });
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws, message) {
    let data;
    try { data = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message)); }
    catch { return; }

    const current = ws.deserializeAttachment() || {};
    if (data.type === "register") {
      const identity = {
        id: current.id,
        registered: true,
        role: data.role === "viewer" ? "viewer" : "sender",
        camera: String(data.camera || "cam1").slice(0, 12)
      };
      ws.serializeAttachment(identity);

      for (const other of this.ctx.getWebSockets()) {
        if (other === ws) continue;
        const info = other.deserializeAttachment() || {};
        if (!info.registered) continue;
        ws.send(JSON.stringify({ type: "peer-joined", ...info }));
        other.send(JSON.stringify({ type: "peer-joined", ...identity }));
      }
      return;
    }

    if (!current.registered || typeof data.type !== "string") return;
    const outgoing = { ...data, from: current.id };
    delete outgoing.target;

    const sockets = this.ctx.getWebSockets();
    if (data.target) {
      const target = sockets.find(socket => (socket.deserializeAttachment() || {}).id === data.target);
      if (target) target.send(JSON.stringify(outgoing));
      return;
    }
    for (const socket of sockets) {
      if (socket !== ws) socket.send(JSON.stringify(outgoing));
    }
  }

  webSocketClose(ws) {
    const info = ws.deserializeAttachment() || {};
    if (!info.registered) return;
    const notice = JSON.stringify({ type: "peer-left", id: info.id });
    for (const socket of this.ctx.getWebSockets()) {
      if (socket !== ws) socket.send(notice);
    }
  }

  webSocketError(ws) {
    try { ws.close(1011, "WebSocket error"); } catch {}
  }
}