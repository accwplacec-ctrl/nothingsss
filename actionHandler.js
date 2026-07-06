'use strict'

/**
 * actionHandler.js
 * ------------------------------------------------------------
 * Nhan mot action JSON (do "bo nao" AI tren Colab tra ve) va
 * thuc thi hanh vi tuong ung bang mineflayer + pathfinder +
 * collectblock. Moi ham deu duoc boc try/catch de bot KHONG
 * BAO GIO crash vi mot lenh loi - toi da chi gui thong bao
 * loi qua chat.
 * ------------------------------------------------------------
 */

const { GoalNear, GoalFollow, GoalBlock, GoalXZ } = require('mineflayer-pathfinder').goals

// Bien luu "goal" hien tai de co the huy khi nhan action "stop"
// va luu interval cua "follow"/"escort" de co the dung dung cach.
const activeTasks = {
  followInterval: null,
  escortInterval: null,
}

// ===== Tien ich chung =====

function say(bot, message) {
  if (!message) return
  try {
    bot.chat(message.slice(0, 250)) // gioi han do dai tin nhan chat
  } catch (e) {
    console.log('❌ Loi khi chat:', e.message)
  }
}

function clearFollowTasks() {
  if (activeTasks.followInterval) {
    clearInterval(activeTasks.followInterval)
    activeTasks.followInterval = null
  }
  if (activeTasks.escortInterval) {
    clearInterval(activeTasks.escortInterval)
    activeTasks.escortInterval = null
  }
}

function findOwnerEntity(bot, ownerName) {
  const players = bot.players || {}
  const p = players[ownerName]
  return p && p.entity ? p.entity : null
}

// Tim vi tri khoi gan nhat theo ten (vd "stone", "oak_log")
function findNearestBlock(bot, blockName, maxDistance = 64) {
  const mcData = require('minecraft-data')(bot.version)
  const blockInfo = mcData.blocksByName[blockName]
  if (!blockInfo) return null
  return bot.findBlock({
    matching: blockInfo.id,
    maxDistance,
  })
}

// ===== Cac hanh dong =====

async function doMine(bot, params) {
  const { block, quantity = 1 } = params || {}
  if (!block) {
    say(bot, 'Bạn chưa nói rõ đào khối gì.')
    return
  }
  const mcData = require('minecraft-data')(bot.version)
  const blockInfo = mcData.blocksByName[block]
  if (!blockInfo) {
    say(bot, `Mình không biết khối "${block}" là gì.`)
    return
  }

  say(bot, `Đang tìm ${block} để đào (${quantity} khối)...`)

  const blocks = bot.findBlocks({
    matching: blockInfo.id,
    maxDistance: 64,
    count: Math.max(quantity * 3, quantity), // tim du de bu truong hop khong toi duoc
  })

  if (!blocks || blocks.length === 0) {
    say(bot, `Không tìm thấy ${block} gần đây.`)
    return
  }

  const targets = blocks
    .map((pos) => bot.blockAt(pos))
    .filter(Boolean)
    .slice(0, quantity)

  if (targets.length === 0) {
    say(bot, `Không tìm thấy ${block} có thể đào được gần đây.`)
    return
  }

  try {
    // collectBlock ho tro mang khoi, tu dong pathfind + dao + nhat
    await bot.collectBlock.collect(targets, { ignoreNoPath: false })
    say(bot, `Đã đào xong ${block}.`)
  } catch (e) {
    say(bot, `Gặp lỗi khi đào ${block}: ${e.message}`)
  }
}

async function doCollect(bot, params) {
  const { item, quantity = 1 } = params || {}
  if (!item) {
    say(bot, 'Bạn chưa nói rõ nhặt vật phẩm gì.')
    return
  }

  say(bot, `Đang tìm ${item} để nhặt...`)

  // Uu tien: item roi tren mat dat (Entity kieu 'object'/'item')
  const droppedEntities = Object.values(bot.entities).filter((e) => {
    return (
      e.name === 'item' &&
      e.metadata &&
      e.position &&
      bot.entity.position.distanceTo(e.position) <= 48
    )
  })

  if (droppedEntities.length > 0) {
    try {
      await bot.collectBlock.collect(
        droppedEntities.slice(0, quantity).map((e) => e),
        { ignoreNoPath: false }
      )
      say(bot, `Đã nhặt xong ${item}.`)
      return
    } catch (e) {
      // roi xuong thu tim theo khoi (vd nong san chin tren cay)
    }
  }

  // Neu khong phai item roi, thu coi day la khoi nong san (vd wheat, carrots)
  const block = findNearestBlock(bot, item, 48)
  if (block) {
    try {
      await bot.collectBlock.collect(block)
      say(bot, `Đã thu hoạch ${item}.`)
      return
    } catch (e) {
      say(bot, `Gặp lỗi khi thu hoạch ${item}: ${e.message}`)
      return
    }
  }

  say(bot, `Không tìm thấy ${item} gần đây để nhặt.`)
}

// Preset xay dung don gian, toa do tuong doi so voi vi tri bot dung
async function doBuild(bot, params) {
  const { structure, location = 'here' } = params || {}
  if (!structure) {
    say(bot, 'Bạn chưa mô tả muốn xây gì.')
    return
  }

  const base = bot.entity.position.floored()
  say(bot, `Đang chuẩn bị xây "${structure}" tại ${location}...`)

  // Kiem tra ton kho co block xay dung khong (mac dinh dung dat/cobblestone)
  const buildBlockNames = ['cobblestone', 'stone', 'dirt', 'oak_planks']
  const inventoryBlock = bot.inventory.items().find((i) => buildBlockNames.includes(i.name))

  if (!inventoryBlock) {
    say(bot, 'Mình không có đủ khối xây dựng trong túi đồ (cần cobblestone/stone/dirt/oak_planks).')
    return
  }

  try {
    await bot.equip(inventoryBlock, 'hand')
  } catch (e) {
    say(bot, `Không thể cầm khối để xây: ${e.message}`)
    return
  }

  const placements = getPresetOffsets(structure)
  if (placements.length === 0) {
    say(bot, `Mình chưa có preset cho "${structure}". Các preset hỗ trợ: tường (wall), nhà nhỏ (small_house), hàng rào (fence).`)
    return
  }

  let placed = 0
  for (const offset of placements) {
    const targetPos = base.offset(offset.x, offset.y, offset.z)
    const refBlock = bot.blockAt(targetPos.offset(0, -1, 0))
    if (!refBlock) continue
    try {
      // Di chuyen den gan vi tri truoc khi dat
      await bot.pathfinder.goto(new GoalNear(targetPos.x, targetPos.y, targetPos.z, 3))
      await bot.placeBlock(refBlock, { x: 0, y: 1, z: 0 })
      placed++
    } catch (e) {
      // Bo qua khoi loi (vd bi choan), tiep tuc khoi tiep theo
      continue
    }
  }

  say(bot, `Đã đặt ${placed}/${placements.length} khối cho "${structure}".`)
}

// Cac preset xay dung don gian (toa do tuong doi x, y, z)
function getPresetOffsets(structureRaw) {
  const structure = structureRaw.toLowerCase()

  if (/tường|wall/.test(structure)) {
    const offsets = []
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 3; y++) {
        offsets.push({ x, y, z: 0 })
      }
    }
    return offsets
  }

  if (/hàng rào|fence/.test(structure)) {
    const offsets = []
    for (let x = 0; x < 6; x++) offsets.push({ x, y: 0, z: 0 })
    return offsets
  }

  if (/nhà|house/.test(structure)) {
    const offsets = []
    const size = 4
    // Tuong quanh 4 canh, cao 3
    for (let y = 0; y < 3; y++) {
      for (let x = 0; x < size; x++) {
        offsets.push({ x, y, z: 0 })
        offsets.push({ x, y, z: size - 1 })
      }
      for (let z = 0; z < size; z++) {
        offsets.push({ x: 0, y, z })
        offsets.push({ x: size - 1, y, z })
      }
    }
    return offsets
  }

  return []
}

async function doFollow(bot, params, owner) {
  const { distance = 3 } = params || {}
  clearFollowTasks()

  const target = findOwnerEntity(bot, owner)
  if (!target) {
    say(bot, `Không tìm thấy ${owner} gần đây để đi theo.`)
    return
  }

  say(bot, `Đang đi theo ${owner}.`)
  bot.pathfinder.setGoal(new GoalFollow(target, distance), true)

  // Cap nhat lai target moi 2s de xu ly truong hop entity bi mat/tao lai
  activeTasks.followInterval = setInterval(() => {
    const t = findOwnerEntity(bot, owner)
    if (t) bot.pathfinder.setGoal(new GoalFollow(t, distance), true)
  }, 2000)
}

async function doEscort(bot, params, owner) {
  const { mode = 'guard' } = params || {}
  clearFollowTasks()

  const target = findOwnerEntity(bot, owner)
  if (!target) {
    say(bot, `Không tìm thấy ${owner} gần đây để hộ tống.`)
    return
  }

  say(bot, `Đang hộ tống ${owner} (chế độ: ${mode}).`)
  bot.pathfinder.setGoal(new GoalFollow(target, 2), true)

  let lastWarnAt = 0
  activeTasks.escortInterval = setInterval(() => {
    const t = findOwnerEntity(bot, owner)
    if (t) bot.pathfinder.setGoal(new GoalFollow(t, 2), true)

    // Chi canh bao qua chat khi phat hien mob thu dich gan chu, khong tu combat
    const hostileNearby = Object.values(bot.entities).find((e) => {
      return (
        e.type === 'hostile' &&
        t &&
        e.position &&
        t.position &&
        e.position.distanceTo(t.position) <= 8
      )
    })

    const now = Date.now()
    if (hostileNearby && now - lastWarnAt > 8000) {
      lastWarnAt = now
      say(bot, `⚠️ Cảnh báo: có ${hostileNearby.name || 'quái vật'} gần ${owner}!`)
    }
  }, 2000)
}

async function doGoto(bot, params) {
  const { x, y, z } = params || {}
  if ([x, y, z].some((v) => typeof v !== 'number')) {
    say(bot, 'Tọa độ x, y, z không hợp lệ.')
    return
  }
  say(bot, `Đang di chuyển đến (${x}, ${y}, ${z})...`)
  try {
    await bot.pathfinder.goto(new GoalNear(x, y, z, 1))
    say(bot, 'Đã đến nơi.')
  } catch (e) {
    say(bot, `Không thể đến (${x}, ${y}, ${z}): ${e.message}`)
  }
}

async function doGiveItem(bot, params, owner) {
  const { item, quantity = 1 } = params || {}
  if (!item) {
    say(bot, 'Bạn chưa nói rõ muốn nhận vật phẩm gì.')
    return
  }

  const target = findOwnerEntity(bot, owner)
  if (!target) {
    say(bot, `Không tìm thấy ${owner} gần đây để đưa đồ.`)
    return
  }

  const invItem = bot.inventory.items().find((i) => i.name === item)
  if (!invItem) {
    say(bot, `Mình không có ${item} trong túi đồ.`)
    return
  }

  try {
    await bot.pathfinder.goto(new GoalFollow(target, 2))
    const tossCount = Math.min(quantity, invItem.count)
    await bot.toss(invItem.type, null, tossCount)
    say(bot, `Đã đưa ${tossCount} ${item} cho ${owner}.`)
  } catch (e) {
    say(bot, `Không thể đưa ${item}: ${e.message}`)
  }
}

async function doStop(bot) {
  clearFollowTasks()
  try {
    bot.pathfinder.setGoal(null)
    bot.pathfinder.stop()
  } catch (e) {
    // bo qua
  }
  say(bot, 'Đã dừng mọi hành động.')
}

async function doCome(bot, params, owner) {
  const target = findOwnerEntity(bot, owner)
  if (!target) {
    say(bot, `Không tìm thấy ${owner} gần đây.`)
    return
  }
  say(bot, `Đang đến chỗ ${owner}...`)
  try {
    const p = target.position
    await bot.pathfinder.goto(new GoalNear(p.x, p.y, p.z, 2))
    say(bot, 'Đã đến nơi.')
  } catch (e) {
    say(bot, `Không thể đến chỗ ${owner}: ${e.message}`)
  }
}

async function doIgnore(bot, params) {
  const reason = (params && params.reason) || 'không rõ lý do'
  console.log(`🙈 Bỏ qua lệnh: ${reason}`)
}

async function doChatReply(bot, params) {
  const message = (params && params.message) || ''
  say(bot, message)
}

// ===== Ham dieu phoi chinh =====

/**
 * Thuc thi mot action JSON tu bo nao AI.
 * @param {object} bot - instance mineflayer (da load pathfinder/collectblock)
 * @param {object} actionMsg - { action, params, say, reasoning }
 * @param {string} owner - ten nguoi choi la chu bot
 */
async function executeAction(bot, actionMsg, owner) {
  if (!actionMsg || typeof actionMsg !== 'object') {
    console.log('❌ Action không hợp lệ (không phải object).')
    return
  }

  const { action, params, say: sayMsg, reasoning } = actionMsg

  if (reasoning) console.log(`🧠 Lý do: ${reasoning}`)
  if (sayMsg) say(bot, sayMsg)

  try {
    switch (action) {
      case 'mine':
        await doMine(bot, params)
        break
      case 'collect':
        await doCollect(bot, params)
        break
      case 'build':
        await doBuild(bot, params)
        break
      case 'follow':
        await doFollow(bot, params, owner)
        break
      case 'escort':
        await doEscort(bot, params, owner)
        break
      case 'goto':
        await doGoto(bot, params)
        break
      case 'give_item':
        await doGiveItem(bot, params, owner)
        break
      case 'stop':
        await doStop(bot)
        break
      case 'come':
        await doCome(bot, params, owner)
        break
      case 'ignore':
        await doIgnore(bot, params)
        break
      case 'chat_reply':
        await doChatReply(bot, params)
        break
      default:
        console.log(`❓ Action không xác định: ${action}`)
        say(bot, 'Mình không hiểu lệnh này.')
    }
  } catch (e) {
    // Bat moi loi khong luong truoc de bot KHONG BAO GIO crash
    console.log(`❌ Lỗi khi thực thi action "${action}":`, e.message)
    say(bot, `Gặp lỗi khi thực hiện lệnh: ${e.message}`)
  }
}

module.exports = { executeAction, clearFollowTasks }