# ULTIMA LIVE

Browser-based multi-camera contribution prototype for live production. Mobile devices send camera and microphone media using WebRTC; OBS receives each camera through a dedicated browser-source URL.

## Current prototype

- Mobile Safari camera sender with microphone.
- Room-based WebSocket signaling using a Cloudflare Durable Object.
- WebRTC peer-to-peer media path with a public STUN server.
- Independent camera IDs: cam1 through cam5.
- OBS receiver URL can be copied from the receiver view.

## Local development

Install a current Node.js LTS release, then:

```bash
npm install --save-dev wrangler
npx wrangler dev
```

## Cloudflare deployment

1. Create or select a Cloudflare Workers project.
2. From this repository, run `npx wrangler login`.
3. Deploy with `npx wrangler deploy`.
4. Open the generated `workers.dev` address.

The first deployment creates the SQLite-backed Durable Object namespace from the migration in `wrangler.toml`.

## Usage

- Sender: `https://YOUR-WORKER.workers.dev/?mode=send&room=royal-palace&camera=cam1`
- OBS receiver: `https://YOUR-WORKER.workers.dev/?mode=view&room=royal-palace&camera=cam1&obs=1`

Use the same room and camera ID on both devices. In OBS, add the receiver URL as a Browser Source. For each additional camera, use cam2, cam3, and so on.

## Important limitations

This is an early prototype, not a production-certified broadcast system. Media travels peer-to-peer and does not pass through Cloudflare. Connectivity depends on NAT/firewall conditions and available upload bandwidth. Only a STUN server is configured; some networks require a TURN relay. Test on the actual venue network before using it for a live event. 1080p is an ideal capture request, not a guaranteed delivered resolution.

## Project structure

- `public/index.html`: interface
- `public/app.js`: browser camera, WebRTC and OBS receiver logic
- `worker.js`: WebSocket signaling and room Durable Object
- `wrangler.toml`: Cloudflare Worker, assets and Durable Object configuration