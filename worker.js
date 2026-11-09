import { DurableObject } from "cloudflare:workers";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/signal") {
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