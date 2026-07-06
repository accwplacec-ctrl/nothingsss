const mineflayer = require('mineflayer')
const readline = require('readline')
const { exec } = require('child_process')
const pathfinderPkg = require('mineflayer-pathfinder')
const { Movements, goals } = pathfinderPkg

const HOST = 'rune.pikamc.vn'
const PORT = 25078
const USERNAME = 'lamthanh'
const PASSWORD = 'matkhau123'
const VERSION = '1.20.1'

const scriptStartTime = Date.now()
let bot = null
let connectedSince = null
let registered = false
let loggedIn = false

let reconnectAttempts = 0
let totalReconnects = 0
let reconnecting = false
let shuttingDown = false
let reconnectTimeoutId = null
let nextReconnectAt = null

let afkTimeout = null
let reportInterval = null
let autoShutdownTimeout = null
let idleHeartbeat = null

// ===== Wake-lock Termux =====
function acquireWakeLock() {
  exec('termux-wake-lock', (err) => {
    if (err) console.log('⚠️ Không gọi được termux-wake-lock — cần pkg install termux-api + app Termux:API.')
    else console.log('🔒 Đã giữ wake-lock.')
  })
}
function releaseWakeLock() {
  exec('termux-wake-unlock', () => {})
}

// ===== Tiện ích =====
function formatDuration(ms) {
  const min = Math.floor(ms / 60000)
  const h = Math.floor(min / 60)
  const m = min % 60
  return h > 0 ? `${h}h${m}m` : `${m}m`
}
function memUsageMB() {
  return (process.memoryUsage().rss / 1024 / 1024).toFixed(1)
}

// ===== Dọn bot cũ hoàn toàn =====
function destroyBot() {
  if (bot) {
    try { bot.removeAllListeners() } catch (e) {}
    try { bot.end() }               catch (e) {}
    bot = null
  }
}

// ===== Tự nghỉ theo giờ VN =====
function msUntilNextVNHour(targetHour) {
  const vnOffsetMs = 7 * 60 * 60 * 1000
  const now = new Date()
  const nowVN = new Date(now.getTime() + vnOffsetMs)
  const target = new Date(Date.UTC(
    nowVN.getUTCFullYear(), nowVN.getUTCMonth(), nowVN.getUTCDate(),
    targetHour, 0, 0
  ))
  if (nowVN.getTime() >= target.getTime()) target.setUTCDate(target.getUTCDate() + 1)
  return target.getTime() - nowVN.getTime()
}

function scheduleAutoShutdown(targetHour = 5) {
  if (autoShutdownTimeout) clearTimeout(autoShutdownTimeout)
  const delay = msUntilNextVNHour(targetHour)
  console.log(`🕐 Bot sẽ tự nghỉ sau ${(delay / 3600000).toFixed(2)} giờ (lúc ${targetHour}:00 VN)`)
  autoShutdownTimeout = setTimeout(() => goIdle(`Đã đến ${targetHour}:00 sáng VN`), delay)
}

// ===== Idle / Wake =====
function goIdle(reason) {
  shuttingDown = true
  connectedSince = null
  registered = false
  loggedIn = false
  console.log(`🌙 ${reason} → Ngắt kết nối, chuyển sang chế độ nghỉ.`)
  console.log('💤 Gõ "wake" để bật lại.')

  if (afkTimeout)          clearTimeout(afkTimeout)
  if (reportInterval)      clearInterval(reportInterval)
  if (autoShutdownTimeout) clearTimeout(autoShutdownTimeout)
  if (reconnectTimeoutId)  clearTimeout(reconnectTimeoutId)
  nextReconnectAt = null

  destroyBot()
  releaseWakeLock()

  if (idleHeartbeat) clearInterval(idleHeartbeat)
  idleHeartbeat = setInterval(() => {
    console.log(`💤 [${new Date().toLocaleTimeString()}] Đang nghỉ — gõ "wake" để bật lại.`)
  }, 1800000)
}

function wake() {
  if (!shuttingDown) { console.log('ℹ️ Bot đang hoạt động, không cần wake.'); return }
  console.log('🌞 Đang bật lại bot...')
  shuttingDown = false
  reconnectAttempts = 0
  if (idleHeartbeat) clearInterval(idleHeartbeat)
  acquireWakeLock()
  scheduleAutoShutdown(5)
  connect()
}

function forceReconnect() {
  if (shuttingDown) { console.log('⚠️ Bot đang nghỉ. Gõ "wake" trước.'); return }
  console.log('🔄 Buộc kết nối lại ngay...')
  if (reconnectTimeoutId) { clearTimeout(reconnectTimeoutId); reconnectTimeoutId = null }
  nextReconnectAt = null
  reconnecting = true
  destroyBot()
  reconnectAttempts = 0
  setTimeout(() => { reconnecting = false; connect() }, 1000)
}

// ===== Reconnect =====
function scheduleReconnect() {
  if (reconnecting || shuttingDown) return
  reconnecting = true
  if (afkTimeout)     clearTimeout(afkTimeout)
  if (reportInterval) clearInterval(reportInterval)

  const delay = Math.min(10000 * Math.pow(1.5, reconnectAttempts), 300000)
  reconnectAttempts++
  totalReconnects++
  nextReconnectAt = Date.now() + delay
  console.log(`⏳ Chờ ${Math.round(delay / 1000)}s rồi kết nối lại (lần ${reconnectAttempts})...`)

  reconnectTimeoutId = setTimeout(() => {
    nextReconnectAt = null
    reconnecting = false
    reconnectTimeoutId = null
    connect()
  }, delay)
}

// ===== Anti-AFK =====
function scheduleAfk() {
  if (afkTimeout) clearTimeout(afkTimeout)
  const delay = 45000 + Math.random() * 55000
  afkTimeout = setTimeout(() => {
    doAfkAction()
    scheduleAfk()
  }, delay)
}

function doAfkAction() {
  if (!bot || !loggedIn) return
  const yaw   = Math.random() * Math.PI * 2
  const pitch = (Math.random() * 40 - 20) * (Math.PI / 180)
  try { bot.look(yaw, pitch, false) } catch (e) {}

  if (Math.random() < 0.3) {
    try {
      bot.setControlState('jump', true)
      setTimeout(() => { try { bot.setControlState('jump', false) } catch(e){} }, 300)
    } catch (e) {}
  }

  try {
    bot.setControlState('forward', true)
    setTimeout(() => { try { bot.setControlState('forward', false) } catch(e){} }, 200 + Math.random() * 200)
  } catch (e) {}
}

// ===== Di chuyển & Đào (dùng pathfinder) =====
async function gotoCoords(x, y, z) {
  if (!bot) return console.log('⚠️ Bot chưa kết nối.')
  console.log(`🚶 Đang di chuyển tới ${x}, ${y}, ${z}...`)
  try {
    await bot.pathfinder.goto(new goals.GoalBlock(x, y, z))
    console.log('✅ Đã tới nơi.')
  } catch (e) {
    console.log('❌ Không tới được:', e.message)
  }
}

async function digNearest(blockName, count = 1) {
  if (!bot) return console.log('⚠️ Bot chưa kết nối.')
  let dug = 0
  for (let i = 0; i < count; i++) {
    const block = bot.findBlock({ matching: b => b && b.name === blockName, maxDistance: 32 })
    if (!block) { console.log(`❌ Không còn "${blockName}" gần đây.`); break }

    try {
      await bot.pathfinder.goto(new goals.GoalBreakBlock(block.position.x, block.position.y, block.position.z))
      await bot.dig(block)
      dug++
      console.log(`⛏️ [${dug}/${count}] Đã đào "${blockName}"`)
    } catch (e) {
      console.log('❌ Lỗi đào:', e.message)
      break
    }
  }
  console.log(`✅ Hoàn tất: đào được ${dug}/${count} khối "${blockName}"`)
}

async function followPlayer(username) {
  if (!bot) return console.log('⚠️ Bot chưa kết nối.')
  const target = bot.players[username]?.entity
  if (!target) return console.log(`❌ Không thấy người chơi "${username}" gần đây.`)
  bot.pathfinder.setGoal(new goals.GoalFollow(target, 2), true)
  console.log(`🏃 Đang theo "${username}"`)
}

function stopFollow() {
  if (!bot) return
  try { bot.pathfinder.setGoal(null) } catch (e) {}
  try { bot.clearControlStates() } catch (e) {}
  console.log('🛑 Đã dừng theo/di chuyển')
}

async function attackNearest(mobName) {
  if (!bot) return console.log('⚠️ Bot chưa kết nối.')
  const entity = Object.values(bot.entities).find(e =>
    e.name === mobName || (e.mobType && e.mobType.toLowerCase() === mobName.toLowerCase())
  )
  if (!entity) return console.log(`❌ Không thấy "${mobName}" gần đây.`)

  try {
    await bot.pathfinder.goto(new goals.GoalFollow(entity, 1))
    bot.attack(entity)
    console.log(`⚔️ Đã tấn công "${mobName}"`)
  } catch (e) {
    console.log('❌ Lỗi tấn công:', e.message)
  }
}

async function collectNearbyItems() {
  if (!bot) return console.log('⚠️ Bot chưa kết nối.')
  const items = Object.values(bot.entities).filter(e => e.name === 'item')
  if (items.length === 0) return console.log('ℹ️ Không có item nào gần đây.')

  console.log(`📦 Tìm thấy ${items.length} item, đang nhặt...`)
  for (const item of items) {
    try {
      await bot.pathfinder.goto(new goals.GoalBlock(
        Math.floor(item.position.x), Math.floor(item.position.y), Math.floor(item.position.z)
      ))
    } catch (e) { /* bỏ qua nếu không tới được */ }
  }
  console.log('✅ Đã đi nhặt xong (nếu tới kịp trước khi item mất/bị nhặt).')
}

// ===== CONNECT =====
function connect() {
  destroyBot()
  registered = false
  loggedIn = false
  connectedSince = null

  if (reportInterval) clearInterval(reportInterval)
  if (afkTimeout)     clearTimeout(afkTimeout)

  bot = mineflayer.createBot({
    host: HOST,
    port: PORT,
    username: USERNAME,
    version: VERSION,
    auth: 'offline',
    viewDistance: 5,
    checkTimeoutInterval: 30000,
    closeTimeout: 30000,
  })

  bot.loadPlugin(pathfinderPkg.pathfinder)

  let endHandled = false
  function handleDisconnect(reason) {
    if (endHandled) return
    endHandled = true
    connectedSince = null
    registered = false
    loggedIn = false
    if (afkTimeout)     clearTimeout(afkTimeout)
    if (reportInterval) clearInterval(reportInterval)
    if (!shuttingDown) scheduleReconnect()
  }

  bot.once('spawn', () => {
    try {
      const movements = new Movements(bot)
      bot.pathfinder.setMovements(movements)
    } catch (e) {
      console.log('⚠️ Không khởi tạo được pathfinder movements:', e.message)
    }
  })

  bot.on('spawn', () => {
    connectedSince = Date.now()
    reconnectAttempts = 0
    console.log('✅ Bot đã vào server')
    scheduleAfk()

    reportInterval = setInterval(() => {
      if (!bot) return
      const pos = bot.entity ? bot.entity.position : null
      const posStr = pos ? `${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)}` : '?'
      const chunkCount = Object.keys(bot.world.columns || {}).length
      console.log(`📊 [${new Date().toLocaleTimeString()}] RAM: ${memUsageMB()}MB | Online: ${formatDuration(Date.now() - connectedSince)} | Chunk: ${chunkCount} | Pos: ${posStr}`)
    }, 15000)
  })

  function handleMessage(text) {
    if (!text) return

    if (!registered && /register|đăng ký/i.test(text) && !/đã đăng ký/i.test(text)) {
      registered = true
      setTimeout(() => { try { bot.chat(`/register ${PASSWORD} ${PASSWORD}`) } catch(e){} }, 2500)
    }
    if (!loggedIn && /login|đăng nhập/i.test(text) && !/đã đăng nhập/i.test(text)) {
      loggedIn = true
      setTimeout(() => { try { bot.chat(`/login ${PASSWORD}`) } catch(e){} }, 2500)
    }
    if (/đăng nhập thành công/i.test(text)) { loggedIn = true; console.log('🔑 Đăng nhập thành công!') }
    if (/đăng ký thành công/i.test(text))   { registered = true; console.log('📝 Đăng ký thành công!') }
    if (/vui lòng.*discord|liên kết.*discord|link.*discord|discord.*để.*tiếp tục|bắt buộc.*discord/i.test(text)) {
      goIdle('Server yêu cầu link Discord, không thể tiếp tục')
    }
  }

  bot.on('chat', (username, message) => {
    if (username === USERNAME) return
    console.log(`💬 <${username}> ${message}`)
    handleMessage(message)
  })

  bot.on('message', (jsonMsg) => {
    const text = jsonMsg.toString()
    console.log(`💬 ${text}`)
    handleMessage(text)
  })

  bot.on('kicked', (reason) => {
    console.log('👢 Bị kick:', reason)
    if (/banned|ban|đã bị cấm/i.test(reason))          console.log('🚫 Bot có thể bị BAN!')
    if (/full|đầy server/i.test(reason))                console.log('🏠 Server đang đầy!')
    if (/afk|di chuyển|không hoạt động/i.test(reason)) console.log('🚶 Bị kick do AFK!')
    handleDisconnect('kicked')
  })

  bot.on('end',   (reason) => { console.log('🔌 Mất kết nối:', reason || ''); handleDisconnect('end') })
  bot.on('error', (err)    => { console.log('❌ Lỗi:', err?.message || err);  handleDisconnect('error') })
}

// ===== Console điều khiển =====
function showHelp() {
  console.log('───── 🛠️ LỆNH ĐIỀU KHIỂN ─────')
  console.log('help                 - danh sách lệnh')
  console.log('status               - trạng thái bot')
  console.log('say <tin nhắn>       - gửi chat')
  console.log('reconnect            - kết nối lại ngay')
  console.log('idle                 - cho bot nghỉ')
  console.log('wake                 - bật lại bot')
  console.log('jump                 - bot nhảy 1 lần')
  console.log('stop                 - dừng mọi di chuyển của bot')
  console.log('goto <x> <y> <z>     - di chuyển tới toạ độ')
  console.log('dig <block> [số]     - tự tìm & đào block (vd: dig stone 10)')
  console.log('follow <tên player>  - đi theo người chơi')
  console.log('stopfollow           - dừng theo người chơi')
  console.log('attack <tên mob>     - tấn công mob gần nhất')
  console.log('collect              - tự nhặt item gần đây')
  console.log('───────────────────────────────')
}

function showStatus() {
  console.log('───── 📋 TRẠNG THÁI BOT ─────')
  console.log(`🕐 Script chạy: ${formatDuration(Date.now() - scriptStartTime)}`)
  console.log(`💾 RAM: ${memUsageMB()} MB`)
  console.log(`🔁 Tổng reconnect: ${totalReconnects}`)
  if (shuttingDown) {
    console.log('💤 Đang NGHỈ. Gõ "wake" để bật lại.')
  } else if (bot && connectedSince) {
    const pos = bot.entity ? bot.entity.position : null
    console.log(`✅ Online: ${formatDuration(Date.now() - connectedSince)}`)
    console.log(`📍 Vị trí: ${pos ? `${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)}` : 'chưa rõ'}`)
    console.log(`📝 Registered: ${registered} | 🔑 LoggedIn: ${loggedIn}`)
  } else if (nextReconnectAt) {
    const s = Math.max(0, Math.round((nextReconnectAt - Date.now()) / 1000))
    console.log(`⏳ Chờ kết nối lại sau ${s}s (lần ${reconnectAttempts})`)
  } else {
    console.log('🔌 Đang kết nối...')
  }
  console.log('─────────────────────────────')
}

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const input = line.trim()
  if (!input) return
  const [cmd, ...rest] = input.split(' ')
  const arg = rest.join(' ')

  switch (cmd.toLowerCase()) {
    case 'help':   showHelp();   break
    case 'status': showStatus(); break
    case 'say':
    case 'chat':
      if (!arg) console.log('⚠️ Cú pháp: say <tin nhắn>')
      else if (shuttingDown || !bot) console.log('⚠️ Bot chưa kết nối hoặc đang nghỉ.')
      else { try { bot.chat(arg); console.log(`📤 Đã gửi: ${arg}`) } catch (e) { console.log('❌', e.message) } }
      break
    case 'reconnect': forceReconnect(); break
    case 'idle':
    case 'pause':
      if (shuttingDown) console.log('ℹ️ Bot đã ở chế độ nghỉ.')
      else goIdle('Lệnh "idle" từ console')
      break
    case 'wake':
    case 'resume': wake(); break
    case 'jump':
      if (!bot) { console.log('⚠️ Bot chưa kết nối.'); break }
      bot.setControlState('jump', true)
      setTimeout(() => { try { bot.setControlState('jump', false) } catch(e){} }, 400)
      console.log('🦘 Đã nhảy')
      break
    case 'stop':
      stopFollow()
      break
    case 'goto': {
      const [x, y, z] = arg.split(' ').map(Number)
      if ([x, y, z].some(isNaN)) { console.log('⚠️ Cú pháp: goto <x> <y> <z>'); break }
      gotoCoords(x, y, z)
      break
    }
    case 'dig': {
      const parts = arg.split(' ')
      const blockName = parts[0]
      const count = parseInt(parts[1]) || 1
      if (!blockName) { console.log('⚠️ Cú pháp: dig <tên block> [số lượng]'); break }
      digNearest(blockName, count)
      break
    }
    case 'follow':
      if (!arg) { console.log('⚠️ Cú pháp: follow <tên người chơi>'); break }
      followPlayer(arg)
      break
    case 'stopfollow':
      stopFollow()
      break
    case 'attack':
      if (!arg) { console.log('⚠️ Cú pháp: attack <tên mob>'); break }
      attackNearest(arg)
      break
    case 'collect':
      collectNearbyItems()
      break
    default: console.log(`❓ Không hiểu lệnh "${cmd}". Gõ "help".`)
  }
})

process.on('uncaughtException',  (err)    => console.log('🆘 uncaughtException:', err?.message || err))
process.on('unhandledRejection', (reason) => console.log('🆘 unhandledRejection:', reason))

console.log('🚀 AFK Bot khởi động (Mineflayer)...')
console.log('💡 Gõ "help" để xem lệnh.')
acquireWakeLock()
scheduleAutoShutdown(5)
connect()
