'use strict'

require('dotenv').config()

const readline = require('readline')
const mineflayer = require('mineflayer')
const { pathfinder, Movements } = require('mineflayer-pathfinder')
const collectBlockPlugin = require('mineflayer-collectblock').plugin
const toolPlugin = require('mineflayer-tool').plugin
const { WebSocketServer } = require('ws')
const { bin: cloudflaredBin } = require('cloudflared')
const { spawn } = require('child_process')

const { executeAction, clearFollowTasks } = require('./actionHandler')

// ===== Cau hinh (doc tu .env) =====
const CONFIG = {
  host: process.env.MC_HOST || 'localhost',
  port: parseInt(process.env.MC_PORT || '25565', 10),
  username: process.env.MC_USERNAME || 'AiBot',
  // MC_VERSION la bien moi truong nen luon la chuoi. Neu de trong hoac ghi "false"
  // (khong phan biet hoa/thuong) thi coi la false that (mineflayer se tu do version).
  version: (() => {
    const v = (process.env.MC_VERSION || '').trim()
    if (!v || v.toLowerCase() === 'false') return false
    return v
  })(),
  auth: process.env.MC_AUTH || 'offline',
  owner: process.env.OWNER_NAME || '',
  wsPort: parseInt(process.env.WS_PORT || '8765', 10),
  afkMinSec: parseInt(process.env.AFK_MIN_INTERVAL_SEC || '45', 10),
  afkMaxSec: parseInt(process.env.AFK_MAX_INTERVAL_SEC || '100', 10),
  // De trong USE_TUNNEL=false neu Wispbyte da cho public WS_PORT san (khong can cloudflared)
  useTunnel: (process.env.USE_TUNNEL || 'true').toLowerCase() !== 'false',
}

if (!CONFIG.owner) {
  console.log('⚠️ CẢNH BÁO: Chưa cấu hình OWNER_NAME trong .env — bot sẽ không nhận lệnh từ ai trong game.')
}

let bot = null
let wss = null
let reconnectAttempts = 0
let afkTimeout = null
let statusInterval = null
let shuttingDown = false
let tunnelProcess = null

// ===== WebSocket server: cau noi voi Colab =====

async function startWebSocketServer() {
  wss = new WebSocketServer({ port: CONFIG.wsPort })
  console.log(`🌐 WebSocket server đang lắng nghe tại cổng ${CONFIG.wsPort} (nội bộ container).`)

  wss.on('connection', (ws) => {
    console.log('🔗 Colab đã kết nối qua WebSocket.')

    ws.on('message', async (raw) => {
      let msg
      try {
        msg = JSON.parse(raw.toString())
      } catch (e) {
        console.log('❌ Nhận được JSON không hợp lệ từ Colab:', e.message)
        return
      }

      if (!bot) {
        console.log('⚠️ Nhận action nhưng bot chưa kết nối vào server Minecraft.')
        return
      }

      await executeAction(bot, msg, CONFIG.owner)
    })

    ws.on('close', () => console.log('🔌 Colab đã ngắt kết nối WebSocket.'))
    ws.on('error', (err) => console.log('❌ Lỗi WebSocket:', err.message))
  })

  // ---- Public hoa cong WS_PORT qua cloudflared quick tunnel ----
  // Khong can dang ky/authtoken, khong gioi han 1-session-nhu-ngrok-free.
  if (CONFIG.useTunnel) {
    startCloudflaredTunnel()
  } else {
    console.log('ℹ️ USE_TUNNEL=false — giả định WS_PORT đã được public sẵn qua allocation của host.')
  }
}

function startCloudflaredTunnel() {
  console.log('🚇 Đang mở cloudflared quick tunnel...')

  tunnelProcess = spawn(cloudflaredBin, ['tunnel', '--url', `http://localhost:${CONFIG.wsPort}`])

  let urlPrinted = false
  const urlRegex = /https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/

  const handleOutput = (data) => {
    const text = data.toString()

    if (!urlPrinted) {
      const match = text.match(urlRegex)
      if (match) {
        const wsUrl = match[0].replace(/^https:\/\//, 'wss://')
        console.log('='.repeat(60))
        console.log(`🌍 URL PUBLIC CHO COLAB (MINEFLAYER_WS_URL): ${wsUrl}`)
        console.log('='.repeat(60))
        urlPrinted = true
      }
    }
  }

  // cloudflared in URL ra stderr, khong phai stdout
  tunnelProcess.stdout.on('data', handleOutput)
  tunnelProcess.stderr.on('data', handleOutput)

  tunnelProcess.on('error', (err) => {
    console.log('❌ Không khởi động được cloudflared:', err.message)
    console.log('   -> Nếu Wispbyte đã cấp sẵn 1 port public khác cho WS_PORT, đặt USE_TUNNEL=false trong .env và dùng thẳng IP:port đó.')
  })

  tunnelProcess.on('exit', (code, signal) => {
    if (shuttingDown) return
    console.log(`⚠️ cloudflared tunnel đã thoát (code=${code}, signal=${signal}). Đang mở lại sau 5s...`)
    tunnelProcess = null
    setTimeout(startCloudflaredTunnel, 5000)
  })
}

// Gui du lieu (chat cua chu, trang thai bot...) toi tat ca client dang ket noi (Colab)
function broadcastToColab(payload) {
  if (!wss) return
  const data = JSON.stringify(payload)
  wss.clients.forEach((client) => {
    if (client.readyState === 1 /* OPEN */) {
      try {
        client.send(data)
      } catch (e) {
        console.log('❌ Lỗi gửi dữ liệu tới Colab:', e.message)
      }
    }
  })
}

// ===== Console chat: go truc tiep vao console cua host de bot noi chuyen trong game =====
// Vi du: go "say hi" roi Enter -> bot.chat("say hi") trong Minecraft.
// Cac panel dang Pterodactyl (Wispbyte) thuong forward text go vao console thang toi stdin
// cua tien trinh Node, nen chi can lang nghe process.stdin la du, khong can lenh dac biet gi them.
function startConsoleChat() {
  const rl = readline.createInterface({ input: process.stdin, terminal: false })
  console.log('⌨️  Console chat đã bật — gõ bất kỳ dòng nào rồi Enter để bot nói trong chat game.')

  rl.on('line', (line) => {
    const text = line.trim()
    if (!text) return

    if (!bot) {
      console.log('⚠️ Bot chưa kết nối vào server Minecraft, không gửi được.')
      return
    }

    try {
      bot.chat(text)
      console.log(`💬 (console) -> ${text}`)
    } catch (e) {
      console.log('❌ Lỗi gửi chat từ console:', e.message)
    }
  })
}

// ===== Anti-AFK: hanh vi ngau nhien don gian de tranh bi kick do AFK =====

function scheduleAfk() {
  if (afkTimeout) clearTimeout(afkTimeout)
  const min = CONFIG.afkMinSec * 1000
  const max = CONFIG.afkMaxSec * 1000
  const delay = min + Math.random() * Math.max(0, max - min)
  afkTimeout = setTimeout(() => {
    doAfkAction()
    scheduleAfk()
  }, delay)
}

function doAfkAction() {
  if (!bot) return
  try {
    const yaw = Math.random() * Math.PI * 2
    const pitch = (Math.random() * 40 - 20) * (Math.PI / 180)
    bot.look(yaw, pitch, false)

    if (Math.random() < 0.3) {
      bot.setControlState('jump', true)
      setTimeout(() => {
        try { bot.setControlState('jump', false) } catch (e) {}
      }, 300)
    }
  } catch (e) {
    // bo qua loi anti-afk, khong quan trong
  }
}

// ===== Gui trang thai bot dinh ky cho Colab (ngu canh cho AI) =====

function startStatusReporting() {
  if (statusInterval) clearInterval(statusInterval)
  statusInterval = setInterval(() => {
    if (!bot || !bot.entity) return
    const pos = bot.entity.position
    const inventory = bot.inventory.items().map((i) => ({ name: i.name, count: i.count }))

    broadcastToColab({
      type: 'bot_status',
      position: { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z) },
      health: bot.health,
      food: bot.food,
      inventory,
      timestamp: Date.now(),
    })
  }, 10000)
}

// ===== Ket noi vao server Minecraft =====

function connect() {
  bot = mineflayer.createBot({
    host: CONFIG.host,
    port: CONFIG.port,
    username: CONFIG.username,
    version: CONFIG.version,
    auth: CONFIG.auth,
    checkTimeoutInterval: 60000, // tang thoi gian cho keepalive, tranh timeout gia do mang lag
    viewDistance: 'tiny', // yeu cau server gui it chunk nhat co the (toi thieu giao thuc cho phep, khong the = 0)
  })

  bot.loadPlugin(pathfinder)
  bot.loadPlugin(collectBlockPlugin)
  bot.loadPlugin(toolPlugin)

  bot.once('spawn', () => {
    console.log('✅ Bot đã vào server.')
    reconnectAttempts = 0

    const mcData = require('minecraft-data')(bot.version)
    const movements = new Movements(bot, mcData)
    bot.pathfinder.setMovements(movements)

    scheduleAfk()
    startStatusReporting()
  })

  bot.on('chat', (username, message) => {
    if (username === bot.username) return
    console.log(`💬 <${username}> ${message}`)

    if (username !== CONFIG.owner) return

    broadcastToColab({
      type: 'game_chat',
      source: 'game_chat',
      username,
      message,
      timestamp: Date.now(),
    })
  })

  bot.on('kicked', (reason) => {
    console.log('👢 Bị kick khỏi server:', reason)
  })

  bot.on('error', (err) => {
    console.log('❌ Lỗi bot:', err && err.message ? err.message : err)
  })

  bot.on('end', (reason) => {
    console.log('🔌 Mất kết nối:', reason || '')
    if (afkTimeout) clearTimeout(afkTimeout)
    if (statusInterval) clearInterval(statusInterval)
    clearFollowTasks()
    bot = null
    if (!shuttingDown) scheduleReconnect()
  })
}

function scheduleReconnect() {
  const delay = Math.min(5000 * Math.pow(1.5, reconnectAttempts), 120000)
  reconnectAttempts++
  console.log(`⏳ Kết nối lại sau ${Math.round(delay / 1000)}s (lần ${reconnectAttempts})...`)
  setTimeout(connect, delay)
}

process.on('uncaughtException', (err) => console.log('🆘 uncaughtException:', err?.message || err))
process.on('unhandledRejection', (reason) => console.log('🆘 unhandledRejection:', reason))
process.on('SIGINT', () => {
  shuttingDown = true
  console.log('\n👋 Đang tắt bot...')
  if (bot) bot.end()
  if (tunnelProcess) tunnelProcess.kill()
  if (wss) wss.close()
  process.exit(0)
})

console.log('🚀 Đang khởi động Minecraft AI Bot...')
startWebSocketServer()
startConsoleChat()
connect()