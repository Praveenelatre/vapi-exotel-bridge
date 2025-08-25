// simulate-exotel.js
import WebSocket from "ws";

const URL = process.argv[2];
if (!URL) {
  console.error("Usage: node simulate-exotel.js wss://bridge.rezevox.com/ws/<token>");
  process.exit(1);
}

// 20 ms of silence @ 8kHz 16-bit PCM = 320 bytes
const SILENCE_8K_20MS = Buffer.alloc(320);

const ws = new WebSocket(URL, { perMessageDeflate: false });

ws.on("open", () => {
  console.log("WS open, sending 20ms frames for 10s...");

  let seq = 1;
  const sendFrame = () => {
    const frame = {
      event: "media",
      sequence_number: seq++,
      stream_sid: "local-test",
      media: {
        chunk: 0,
        timestamp: Date.now(),
        payload: SILENCE_8K_20MS.toString("base64"),
      },
    };
    ws.send(JSON.stringify(frame));
  };

  sendFrame();
  const iv = setInterval(sendFrame, 20);
  setTimeout(() => { clearInterval(iv); console.log("Stopping after 10s"); ws.close(); }, 10000);
});

ws.on("message", (data) => {
  console.log("<- message len", data.length);
});

ws.on("close", (code, reason) => {
  console.log("WS close", code, Buffer.isBuffer(reason) ? reason.toString() : reason);
});

ws.on("error", (e) => console.log("WS error", e?.message || e));


