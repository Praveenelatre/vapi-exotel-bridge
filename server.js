import http from "http";
import crypto from "crypto";
import { WebSocketServer, WebSocket } from "ws";
import fetch from "node-fetch";

const VAPI_TOKEN = process.env.VAPI_API_KEY;
const ASSISTANT_ID = process.env.VAPI_ASSISTANT_ID;
const PORT = process.env.PORT || 8766;

const upstream = new Map();

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }

  if (req.method === "POST" && req.url === "/exotel/stream-endpoint") {
    try {
      const resp = await fetch("https://api.vapi.ai/call", {
        method: "POST",
        headers: {
          "authorization": `Bearer ${VAPI_TOKEN}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          assistantId: ASSISTANT_ID,
          transport: {
            provider: "vapi.websocket",
            audioFormat: { format: "pcm_s16le", container: "raw", sampleRate: 16000 }
          }
        })
      });

      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`Vapi call create failed: ${resp.status} ${text}`);
      }

      const data = await resp.json();
      const vapiUrl = data?.transport?.websocketCallUrl;
      if (!vapiUrl) throw new Error("No websocketCallUrl from Vapi");

      const token = crypto.randomBytes(16).toString("hex");
      upstream.set(token, { vapiUrl });

      const wssUrl = `wss://${req.headers.host}/ws/${token}`;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ url: wssUrl }));
    } catch (e) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ noServer: true });

wss.on("connection", async (exotelWs, request) => {
  const token = request.url.split("/").pop();
  const meta = upstream.get(token);
  if (!meta) {
    exotelWs.close();
    return;
  }

  const vapiWs = new WebSocket(meta.vapiUrl);

  exotelWs.on("message", (msg) => {
    try {
      const obj = JSON.parse(msg.toString());
      if (obj.event === "media") {
        const base64 = obj.media?.payload || "";
        const buf = Buffer.from(base64, "base64");
console.log("Exotel frame size:", buf.length);
        if (vapiWs.readyState === WebSocket.OPEN) vapiWs.send(buf);
      }
      if (obj.event === "stop") {
        if (vapiWs.readyState === WebSocket.OPEN) {
          vapiWs.send(JSON.stringify({ type: "hangup" }));
        }
      }
    } catch {}
  });

  exotelWs.on("close", () => {
    try { vapiWs.close(); } catch {}
    upstream.delete(token);
  });

  vapiWs.on("message", (data) => {
    if (Buffer.isBuffer(data)) {
      const payload = data.toString("base64");
      const frame = {
        event: "media",
        sequence_number: Date.now(),
        stream_sid: token,
        media: { chunk: 0, timestamp: 0, payload }
      };
      if (exotelWs.readyState === WebSocket.OPEN) {
        exotelWs.send(JSON.stringify(frame));
      }
    }
  });

  vapiWs.on("close", () => {
    try { exotelWs.close(); } catch {}
  });
});

server.on("upgrade", (req, socket, head) => {
  if (!req.url.startsWith("/ws/")) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

server.listen(PORT, () => {
  console.log("bridge listening on", PORT);
});

