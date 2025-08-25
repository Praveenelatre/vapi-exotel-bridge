// test_exotel_client.js
// This script simulates Exotel:
// 1) POSTs your dynamic endpoint to get a wss URL
// 2) Connects via WebSocket
// 3) Receives bot audio frames and writes out.wav you can play

import fs from "fs";
import { WebSocket } from "ws";
import fetch from "node-fetch";

// Change this only if your domain is different
const DYNAMIC_URL = "https://bridge.rezevox.com/exotel/stream-endpoint";

// --- WAV writer helpers (16-bit PCM, 8 kHz, mono) ---
function writeWavHeader(fd, dataLength, sampleRate = 8000, numChannels = 1) {
  const bitsPerSample = 16;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const buffer = Buffer.alloc(44);

  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataLength, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16); // PCM chunk size
  buffer.writeUInt16LE(1, 20);  // PCM format
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataLength, 40);

  fs.writeSync(fd, buffer);
}

async function main() {
  console.log("Requesting dynamic WSS from", DYNAMIC_URL);
  const r = await fetch(DYNAMIC_URL, { method: "POST" });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Endpoint error ${r.status}: ${t}`);
  }
  const { url } = await r.json();
  if (!url || !url.startsWith("wss://")) {
    throw new Error("Did not receive a valid wss URL");
  }
  console.log("Got WSS:", url);

  // Prepare output file
  const outPath = "./out.wav";
  const tmpPath = "./out.raw";
  if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
  if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
  const rawFd = fs.openSync(tmpPath, "w");

  // Connect like Exotel would
  const ws = new WebSocket(url);

  let totalBytes = 0;
  let closed = false;

  ws.on("open", () => {
    console.log("WS open. Waiting for bot audio...");
    // Optional: send a minimal "start" event (bridge ignores it, safe to send)
    ws.send(JSON.stringify({ event: "start" }));
    // We’re not sending any mic audio yet. We just want to hear the bot.
  });

  ws.on("message", (data) => {
    // Bridge sends JSON frames: { event: "media", media: { payload: base64 } }
    try {
      const obj = JSON.parse(data.toString());
      if (obj.event === "media" && obj.media?.payload) {
        const pcm = Buffer.from(obj.media.payload, "base64");
        fs.writeSync(rawFd, pcm);
        totalBytes += pcm.length;
        if (totalBytes % (16000) === 0) {
          console.log(`Received ~${(totalBytes / 16000).toFixed(1)} sec of audio`);
        }
      }
    } catch {
      // ignore non-JSON
    }
  });

  ws.on("close", () => {
    if (closed) return;
    closed = true;
    fs.closeSync(rawFd);
    console.log("WS closed. Bytes:", totalBytes);

    // Write WAV header + raw to out.wav
    const raw = fs.readFileSync(tmpPath);
    const wavFd = fs.openSync(outPath, "w");
    writeWavHeader(wavFd, raw.length, 24000, 1);
    fs.writeSync(wavFd, raw);
    fs.closeSync(wavFd);
    console.log("Saved out.wav. You can play it with:  afplay out.wav");
  });

  // Stop after 12 seconds for the test
  setTimeout(() => {
    try { ws.close(); } catch {}
  }, 12000);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

