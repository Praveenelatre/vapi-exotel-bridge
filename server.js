require('dotenv').config()
const express = require('express')
const { WebSocketServer } = require('ws')
const http = require('http')

const app = express()
app.use(express.json())

app.get('/health', (req, res) => {
  res.json({ ok: true })
})

app.get('/ws-entry', (req, res) => {
  const proto = req.headers['x-forwarded-proto'] || 'http'
  const host = req.headers['x-forwarded-host'] || req.headers.host
  const wsProto = proto === 'https' ? 'wss' : 'ws'
  const url = `${wsProto}://${host}/voicebot`
  res.json({ url })
})

const server = http.createServer(app)
const wss = new WebSocketServer({ noServer: true })

server.on('upgrade', (req, socket, head) => {
  if (req.url && req.url.startsWith('/voicebot')) {
    wss.handleUpgrade(req, socket, head, ws => {
      ws.on('message', () => {})
      ws.on('close', () => {})
    })
  } else {
    socket.destroy()
  }
})

const PORT = process.env.PORT || 3000
server.listen(PORT, () => {
  console.log(`listening on ${PORT}`)
})
