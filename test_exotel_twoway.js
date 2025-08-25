// test_exotel_twoway.js
// Simulates Exotel fully: fetch dynamic WSS, connect, SEND caller audio frames,
// and also CAPTURE bot audio into out.wav (16 kHz, s16le, mono).

import fs from "fs";
import { WebSocket } from "ws";
import fetch from "node-fetch";

const DYNAMIC_URL = "https://bridge.rezevox.com/exotel/stream-endpoint";

// Generate 16 kHz s16le mono tone (440 Hz) for N seconds
function genToneSeconds(seconds = 3, sampleRate = 16000, freq = 440) {
  const totalSamples = seconds * sampleRate;
  const buf = Buffer.alloc(totalSamples * 2); // 16-bit
  for (let i = 0; i < totalSamples; i++) {
    const t = i / sampleRate;
    const s = Math.sin(2 * Math.PI * freq * t);
    const val = Math.max(-1, Math.min(1, s)) * 32767;
    buf.writeInt16LE(val | 0, i * 2);
  }
  return buf;
}

// Split raw PCM into 20 ms frames at 16 kHz (320 samples -> 640 bytes)
function* frames20ms(raw, sampleRate = 16000) {
  const samplesPerFrame = Math.round(sampleRate * 0.02); // 320
  const bytesPerFrame = samplesPerFrame * 2;             // 640
  for (let off = 0; off + bytesPerFrame <= raw.length; off += bytesPerFrame) {
    yield raw.subarray(off, off + bytesPerFrame);
  }
}

// WAV writer for 16k mono
function writeWav(path, rawBuf, sampleRate = 16000) {
  const numChannels = 1, bitsPerSample = 16;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + rawBuf.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(rawBuf.length, 40);
  fs.writeFileSync(path, Buffer.concat([header, rawBuf]));
}

async function main() {
  console.log("Requesting WSS...");
  const r = await fetch(DYNAMIC_URL, { method: "POST" });
  if (!r.ok) throw new Error(await r.text());
  const { url } = await r.json();
  if (!url?.startsWith("wss://")) throw new Error("No wss URL");
  console.log("WSS:", url);

  const ws = new WebSocket(url);

  // collect bot audio coming back
  const botChunks = [];
  ws.on("message", (data) => {
    try {
      const obj = JSON.parse(data.toString());
      if (obj.event === "media" && obj.media?.payload) {
        botChunks.push(Buffer.from(obj.media.payload, "base64"));
      }
    } catch { /* ignore */ }
  });

  ws.on("open", async () => {
    console.log("WS open. Sending caller audio for ~3s…");
    // send a start event (optional)
    ws.send(JSON.stringify({ event: "start" }));

    // generate a 3s 440Hz tone as the caller's voice
    const raw = genToneSeconds(3, 16000, 440);

    // stream it in 20ms frames at ~50 fps
    const it = frames20ms(raw, 16000);
    const sendNext = () => {
      const frame = it.next();
      if (frame.done) {
        // give bot 3 more seconds to talk back, then close
        setTimeout(() => ws.close(), 3000);
        return;
      }
      const payload = frame.value.toString("base64");
      const json = {
        event: "media",
        sequence_number: Date.now(),
        stream_sid: "local-test",
        media: { chunk: 0, timestamp: 0, payload }
      };
      ws.send(JSON.stringify(json));
      setTimeout(sendNext, 20);
    };
    sendNext();
  });

  ws.on("close", () => {
    const botRaw = Buffer.concat(botChunks);
    console.log("Closed. Bot bytes:", botRaw.length);
    writeWav("out.wav", botRaw, 16000);
    console.log("Saved out.wav. Play it with:  afplay out.wav");
  });
}

main().catch((e) => { console.error(e); process.exit(1); });

