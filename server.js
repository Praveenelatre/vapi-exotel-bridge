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
  const qs = 'fmt=json&vapiSr=16000&frejunSr=8000&frejunFmt=pcm'
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

function readInt16LE(buf, i) {
  return buf.readInt16LE(i * 2)
}

function writeInt16LE(buf, i, v) {
  buf.writeInt16LE(v, i * 2)
}

function upsample8kTo16kLE(pcm8) {
  const frames = pcm8.length / 2
  const out = Buffer.alloc(frames * 4)
  for (let i = 0; i < frames; i++) {
    const a = readInt16LE(pcm8, i)
    const b = i + 1 < frames ? readInt16LE(pcm8, i + 1) : a
    writeInt16LE(out, i * 2, a)
    writeInt16LE(out, i * 2 + 1, (a + b) >> 1)
  }
  return out
}

function downsample16kTo8kLE(pcm16) {
  const frames = pcm16.length / 2
  const out = Buffer.alloc(Math.floor(frames / 2) * 2)
  let j = 0
  for (let i = 0; i + 1 < frames; i += 2) {
    const a = readInt16LE(pcm16, i)
    const b = readInt16LE(pcm16, i + 1)
    writeInt16LE(out, j++, (a + b) >> 1)
  }
  return out
}

function chunkBuffer(buf, size) {
  const chunks = []
  for (let i = 0; i < buf.length; i += size) chunks.push(buf.subarray(i, i + size))
  return chunks
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
        const pcm16 = mode.frejunSr === 8000 && mode.vapiSr === 16000 ? upsample8kTo16kLE(msg) : msg
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
          const pcm16 = mode.frejunSr === 8000 && mode.vapiSr === 16000 ? upsample8kTo16kLE(raw) : raw
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
        const pcm8 = mode.frejunSr === 8000 && mode.vapiSr === 16000 ? downsample16kTo8kLE(data) : data
        const chunks = chunkBuffer(pcm8, 320)
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
    const fmt = u.searchParams.get('fmt') === 'bin' ? 'bin' : 'json'
    const vapiSr = parseInt(u.searchParams.get('vapiSr') || '16000', 10)
    const frejunSr = parseInt(u.searchParams.get('frejunSr') || '8000', 10)
    const frejunFmt = u.searchParams.get('frejunFmt') || 'pcm'
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
