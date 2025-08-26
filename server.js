require('dotenv').config()
const express = require('express')
const axios = require('axios')
const { WebSocketServer, WebSocket } = require('ws')
const http = require('http')
const crypto = require('crypto')

const VAPI_KEY = process.env.VAPI_API_KEY
const VAPI_ASSISTANT_ID = process.env.VAPI_ASSISTANT_ID
const FREJUN_WEBHOOK_SECRET = process.env.FREJUN_WEBHOOK_SECRET || ''

const app = express()
app.use(express.json({ limit: '2mb' }))

app.get('/', (req, res) => {
  res.json({ ok: true, endpoints: ['/health', '/ws-entry (GET|POST)', '/frejun (WS)', '/frejun/webhook'] })
})

app.get('/health', (req, res) => {
  res.json({ ok: true })
})

function wsUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || 'http'
  const host = req.headers['x-forwarded-host'] || req.headers.host
  const wsProto = proto === 'https' ? 'wss' : 'ws'
  const qs = 'fmt=bin&vapiSr=16000&frejunSr=8000&frejunFmt=pcm'
  return `${wsProto}://${host}/frejun?${qs}`
}

function wsEntryHandler(req, res) {
  const url = wsUrl(req)
  res.type('application/json').status(200).send(JSON.stringify({
    action: "Stream",
    ws_url: url,
    chunk_size: 1000
  }))
}

app.get('/ws-entry', wsEntryHandler)
app.post('/ws-entry', wsEntryHandler)

app.post('/frejun/webhook', (req, res) => {
  try {
    const sig = req.headers['frejun-signature']
    if (FREJUN_WEBHOOK_SECRET && sig) {
      const hmac = crypto.createHmac('sha256', FREJUN_WEBHOOK_SECRET)
      const body = JSON.stringify(req.body)
      const digest = hmac.update(body).digest('hex')
      if (digest !== sig) return res.status(401).json({ ok: false })
    }
    console.log('frejun webhook', JSON.stringify(req.body))
    res.json({ ok: true })
  } catch {
    res.status(200).json({ ok: true })
  }
})

const server = http.createServer(app)
const wss = new WebSocketServer({ noServer: true })

function openVapiSocket() {
  return axios.post(
    'https://api.vapi.ai/call',
    {
      assistantId: VAPI_ASSISTANT_ID,
      transport: { provider: 'vapi.websocket' }
    },
    { headers: { Authorization: `Bearer ${VAPI_KEY}`, 'Content-Type': 'application/json' } }
  ).then(r => r.data.transport.websocketCallUrl)
}

function chunkBuffer(buf, size) {
  const chunks = []
  for (let i = 0; i < buf.length; i += size) chunks.push(buf.subarray(i, i + size))
  return chunks
}

function toInt16(buf) {
  return new Int16Array(buf.buffer, buf.byteOffset, buf.length / 2)
}

function fromInt16(arr) {
  return Buffer.from(new Uint8Array(new Uint8Array(arr.buffer, arr.byteOffset, arr.length * 2)))
}

function upsample8kTo16k(pcm8) {
  const s8 = toInt16(pcm8)
  const out = new Int16Array(s8.length * 2)
  let j = 0
  for (let i = 0; i < s8.length; i++) {
    const a = s8[i]
    const b = i + 1 < s8.length ? s8[i + 1] : a
    out[j++] = a
    out[j++] = (a + b) >> 1
  }
  return fromInt16(out)
}

function downsample16kTo8k(pcm16) {
  const s16 = toInt16(pcm16)
  const out = new Int16Array(Math.floor(s16.length / 2))
  let j = 0
  for (let i = 0; i + 1 < s16.length; i += 2) {
    out[j++] = (s16[i] + s16[i + 1]) >> 1
  }
  return fromInt16(out)
}

function linearToMuLawSample(sample) {
  const BIAS = 0x84
  const CLIP = 32635
  let s = sample
  if (s > CLIP) s = CLIP
  if (s < -CLIP) s = -CLIP
  let sign = (s < 0) ? 0x80 : 0x00
  if (s < 0) s = -s
  s = s + BIAS
  let exponent = 7
  for (let expMask = 0x4000; (s & expMask) === 0 && exponent > 0; expMask >>= 1) exponent--
  let mantissa = (s >> (exponent + 3)) & 0x0F
  let mu = ~(sign | (exponent << 4) | mantissa) & 0xFF
  return mu
}

function muLawToLinearSample(mu) {
  mu = ~mu & 0xFF
  const sign = mu & 0x80
  let exponent = (mu >> 4) & 0x07
  let mantissa = mu & 0x0F
  let s = ((mantissa << 3) + 0x84) << (exponent + 3)
  s = s - 0x84
  return sign ? -s : s
}

function pcm16ToMulaw(pcm16) {
  const s16 = toInt16(pcm16)
  const out = Buffer.allocUnsafe(s16.length)
  for (let i = 0; i < s16.length; i++) out[i] = linearToMuLawSample(s16[i])
  return out
}

function mulawToPcm16(mu) {
  const out = new Int16Array(mu.length)
  for (let i = 0; i < mu.length; i++) out[i] = muLawToLinearSample(mu[i])
  return fromInt16(out)
}

function bridgeSockets(frejunWs, vapiWs, mode) {
  let closed = false
  let inCount = 0
  let outCount = 0
  const outQueue = []
  let sender = null

  function safeClose() {
    if (closed) return
    closed = true
    try { frejunWs.close() } catch {}
    try { vapiWs.close() } catch {}
    if (sender) clearInterval(sender)
    console.log('bridge closed', { inCount, outCount, mode })
  }

  sender = setInterval(() => {
    if (closed) return
    if (frejunWs.readyState !== WebSocket.OPEN) return
    const next = outQueue.shift()
    if (!next) return
    try {
      if (mode.fmt === 'json') {
        const payload = next.toString('base64')
        const out = { event: 'media', media: { payload } }
        frejunWs.send(JSON.stringify(out))
      } else {
        frejunWs.send(next, { binary: true })
      }
      outCount++
    } catch {}
  }, 20)

  frejunWs.on('message', msg => {
    try {
      if (Buffer.isBuffer(msg)) {
        const pcm8 = mode.frejunFmt === 'mulaw' ? mulawToPcm16(msg) : msg
        const pcm16 = mode.frejunSr === 8000 && mode.vapiSr === 16000 ? upsample8kTo16k(pcm8) : pcm8
        if (vapiWs.readyState === WebSocket.OPEN) {
          vapiWs.send(pcm16)
          inCount++
        }
        return
      }
      const s = msg.toString()
      try {
        const obj = JSON.parse(s)
        if (obj && obj.event === 'media' && obj.media && obj.media.payload) {
          const raw = Buffer.from(obj.media.payload, 'base64')
          const pcm8 = mode.frejunFmt === 'mulaw' ? mulawToPcm16(raw) : raw
          const pcm16 = mode.frejunSr === 8000 && mode.vapiSr === 16000 ? upsample8kTo16k(pcm8) : pcm8
          if (vapiWs.readyState === WebSocket.OPEN) {
            vapiWs.send(pcm16)
            inCount++
          }
        }
        if (obj && obj.event === 'stop') safeClose()
      } catch {}
    } catch {}
  })

  vapiWs.on('message', data => {
    try {
      if (Buffer.isBuffer(data)) {
        const pcm8 = mode.frejunSr === 8000 && mode.vapiSr === 16000 ? downsample16kTo8k(data) : data
        const outBuf = mode.frejunFmt === 'mulaw' ? pcm16ToMulaw(pcm8) : pcm8
        const frame = mode.frejunFmt === 'mulaw' ? 160 : 320
        const chunks = chunkBuffer(outBuf, frame)
        for (const c of chunks) outQueue.push(c)
      }
    } catch {}
  })

  frejunWs.on('close', () => safeClose())
  vapiWs.on('close', () => safeClose())
  frejunWs.on('error', () => safeClose())
  vapiWs.on('error', () => safeClose())
}

server.on('upgrade', async (req, socket, head) => {
  if (req.url && req.url.startsWith('/frejun')) {
    const u = new URL(req.url, 'http://x')
    const fmt = u.searchParams.get('fmt') === 'json' ? 'json' : 'bin'
    const vapiSr = parseInt(u.searchParams.get('vapiSr') || '16000', 10)
    const frejunSr = parseInt(u.searchParams.get('frejunSr') || '8000', 10)
    const frejunFmt = u.searchParams.get('frejunFmt') || 'mulaw'
    const mode = { fmt, vapiSr, frejunSr, frejunFmt }
    console.log('upgrade frejun', mode)
    wss.handleUpgrade(req, socket, head, async ws => {
      try {
        const vapiUrl = await openVapiSocket()
        const vws = new WebSocket(vapiUrl, { perMessageDeflate: false })
        vws.on('open', () => {
          console.log('vapi ws open', mode)
          bridgeSockets(ws, vws, mode)
        })
        vws.on('error', () => { try { ws.close() } catch {} })
      } catch {
        try { ws.close() } catch {}
      }
    })
  } else {
    socket.destroy()
  }
})

const PORT = process.env.PORT || 3000
server.listen(PORT, () => {
  console.log(`listening on ${PORT}`)
})
