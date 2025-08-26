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
  return `${wsProto}://${host}/frejun`
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

function bridgeSockets(frejunWs, vapiWs) {
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
    console.log('bridge closed', { inCount, outCount })
  }

  sender = setInterval(() => {
    if (closed) return
    if (frejunWs.readyState !== WebSocket.OPEN) return
    const next = outQueue.shift()
    if (!next) return
    try {
      frejunWs.send(next, { binary: true })
      outCount++
    } catch {}
  }, 20)

  frejunWs.on('message', msg => {
    try {
      if (Buffer.isBuffer(msg)) {
        if (vapiWs.readyState === WebSocket.OPEN) {
          vapiWs.send(msg)
          inCount++
        }
        return
      }
      const s = msg.toString()
      try {
        const obj = JSON.parse(s)
        if (obj && obj.event === 'stop') safeClose()
      } catch {}
    } catch {}
  })

  vapiWs.on('message', data => {
    try {
      if (Buffer.isBuffer(data)) {
        const chunks = chunkBuffer(data, 320)
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
    console.log('upgrade frejun')
    wss.handleUpgrade(req, socket, head, async ws => {
      try {
        const vapiUrl = await openVapiSocket()
        const vws = new WebSocket(vapiUrl, { perMessageDeflate: false })
        vws.on('open', () => {
          console.log('vapi ws open')
          bridgeSockets(ws, vws)
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
