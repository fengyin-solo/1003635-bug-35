/**
 * 补植业务域服务：防火林带与防火隔离带共用的取数路径与流程编排。
 *
 * 取数（三处面板统一口径）：
 *   - 补植列表（replantQueue）：待验收补植批次里的林带；
 *   - 隔离带维护面板（maintenancePanel）：补植 + 割草批次；
 *   - 归档台账（archiveLedger）：验收合格落账的历史，原种植年份与补植年份并列。
 * 林带/隔离带列表行（projectEntries）以最新验收记录为准投影状态，
 * 因此「确认补植后缺株标记不消失」在同一条取数路径上被纠正。
 *
 * 流程（只许前进，不许回退）：
 *   完好/有缺株 ──安排补植──▶ 需补植（生成待验收批次）
 *   需补植     ──确认补植──▶ 完好（验收记录落库、批次验收、台账归档、巡护复查项同步）
 *   非终态     ──标记退化──▶ 已退化（终态；有待验收补植批次时禁止，避免重复安排）
 *   割草维护同理：需割草 ──确认恢复──▶ 正常，并在同一事务里关掉割草批次。
 */

import { listRows } from './local-store'
import {
  CommitError,
  patchReplantState,
  replantState,
  runReplantTransaction,
} from './replant-store'
import type {
  AcceptanceRecord,
  ArchiveEntry,
  BatchAcceptanceResult,
  BeltSource,
  MaintenanceBatch,
  MaintenancePanelRow,
  ProjectedEntry,
  RecheckItem,
  ReplantItem,
  ReplantQueueRow,
} from './replant-types'
import { DEFAULT_REPLANT_PRACTICE } from './replant-types'
import type { ActionResult, EntryRow } from './types'

const SOURCE_LABEL: Record<BeltSource, string> = {
  firebelt: '防火林带',
  firebreak: '防火隔离带',
}

const BELT_NO_FIELD: Record<BeltSource, string> = {
  firebelt: '林带编号',
  firebreak: '隔离带编号',
}

const BELT_YEAR_FIELD: Record<BeltSource, string> = {
  firebelt: '种植年份',
  firebreak: '建成日期',
}

const HEALTHY: Record<BeltSource, string> = { firebelt: '完好', firebreak: '正常' }
const NEED_MOWING = '需割草'
const NEED_REPLANT = '需补植'
const TERMINAL: Record<BeltSource, string> = { firebelt: '已退化', firebreak: '已荒废' }

/** 业务校验中断：事务内用它回传业务失败结果（区别于写入异常）。 */
class BusinessAbort<T extends ActionResult = ActionResult> extends Error {
  constructor(public readonly payload: T) {
    super(payload.message)
    this.name = 'BusinessAbort'
  }
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

function addDays(iso: string, days: number): string {
  const date = new Date(iso)
  date.setDate(date.getDate() + days)
  return date.toISOString()
}

/** 隔离带没有独立的「种植年份」字段，取建成日期的年份作为原种植年份。 */
export function extractPlantYear(source: BeltSource, row: EntryRow): string {
  if (source === 'firebelt') {
    return String(row[BELT_YEAR_FIELD[source]] ?? '').trim()
  }
  const builtAt = String(row[BELT_YEAR_FIELD[source]] ?? '').trim()
  const matched = /\d{4}/.exec(builtAt)
  return matched ? matched[0] : builtAt
}

function getBeltRow(source: BeltSource, beltId: number): EntryRow | undefined {
  return listRows(source).find((row) => Number(row.id) === beltId)
}

function requireBeltRow(source: BeltSource, beltId: number): EntryRow {
  const row = getBeltRow(source, beltId)
  if (!row) {
    throw new BusinessAbort({
      ok: false,
      message: `验收中断：${SOURCE_LABEL[source]}编号 ${beltId} 已缺失，请从该缺失林带重试`,
    })
  }
  return row
}

/**
 * 统一执行事务型动作：业务校验失败（BusinessAbort）转成失败结果，
 * 写入中断转成「已回退、可重试」的失败结果，保证对外接口不抛异常。
 */
function runGuarded(action: () => ActionResult): ActionResult {
  try {
    return action()
  } catch (error) {
    if (error instanceof BusinessAbort) {
      return error.payload
    }
    if (error instanceof CommitError) {
      return { ok: false, message: `${error.message}；数据已整体回退，可重试` }
    }
    return { ok: false, message: error instanceof Error ? error.message : '流程异常中断，数据未改动' }
  }
}

function latestAcceptanceFor(
  acceptances: AcceptanceRecord[],
  source: BeltSource,
  beltId: number,
): AcceptanceRecord | undefined {
  return acceptances
    .filter((item) => item.source === source && item.beltId === beltId && item.verdict === '合格')
    .sort((a, b) => (a.acceptedAt < b.acceptedAt ? 1 : -1))[0]
}

/**
 * 林带当前是否挂在一个未闭环的补植批次上（待验收或中断待重试都算）。
 * 未闭环就不能退化/荒废，也不能重复安排。
 */
function openReplantBatch(
  state: { batches: MaintenanceBatch[]; items: ReplantItem[] },
  source: BeltSource,
  beltId: number,
): MaintenanceBatch | undefined {
  return state.batches.find(
    (batch) =>
      batch.type === 'replant' &&
      batch.status !== '已验收' &&
      state.items.some(
        (item) => item.batchId === batch.id && item.source === source && item.beltId === beltId,
      ),
  )
}

function mowingBatchFor(
  state: { batches: MaintenanceBatch[] },
  beltId: number,
): MaintenanceBatch | undefined {
  return state.batches.find(
    (batch) => batch.type === 'mowing' && batch.status === '待验收' && batch.beltIds.includes(beltId),
  )
}

/* ------------------------------------------------------------------ */
/* 共用取数路径                                                         */
/* ------------------------------------------------------------------ */

/**
 * 林带/隔离带列表投影：行状态与最新合格验收冲突时，以验收记录为准。
 * 但验收只对「验收之后没有再次安排补植」的林带有校正力——
 * 验收后又进入新补植批次的，以当前需补植状态为准；终态（退化/荒废）同样不回翻。
 * 缺株标记（pending/abnormal）按投影后的状态重算——确认补植后缺株标记即消失。
 */
export function projectEntries(source: BeltSource): ProjectedEntry[] {
  const state = replantState()
  return listRows(source).map((row) => {
    const beltId = Number(row.id)
    const storedStatus = String(row.status)
    const acceptance = latestAcceptanceFor(state.acceptances, source, beltId)
    const lastSchedule = state.items
      .filter((item) => item.source === source && item.beltId === beltId)
      .map((item) => item.scheduledAt)
      .sort()
      .pop()
    const acceptanceFresh = acceptance && (!lastSchedule || acceptance.acceptedAt >= lastSchedule)
    const status =
      acceptanceFresh && storedStatus !== HEALTHY[source] && storedStatus !== TERMINAL[source] && storedStatus !== NEED_REPLANT
        ? HEALTHY[source]
        : storedStatus
    const projected = status !== storedStatus
    const healthy = status === HEALTHY[source]
    return {
      ...row,
      status,
      pending: !healthy && status !== TERMINAL[source],
      abnormal: status === NEED_REPLANT || (source === 'firebelt' && status === '有缺株'),
      projected,
    }
  })
}

/** 补植列表：只列待验收补植批次中的林带（林带与隔离带共用）。 */
export function replantQueue(): ReplantQueueRow[] {
  const state = replantState()
  const rows: ReplantQueueRow[] = []
  for (const batch of state.batches.filter(
    (item) => item.type === 'replant' && item.status !== '已验收',
  )) {
    for (const item of state.items.filter((entry) => entry.batchId === batch.id)) {
      rows.push({
        key: `${item.source}-${item.beltId}-${batch.id}`,
        source: item.source,
        sourceLabel: SOURCE_LABEL[item.source],
        beltId: item.beltId,
        beltNo: item.beltNo,
        batchId: batch.id,
        batchNo: batch.batchNo,
        originalPlantYear: item.originalPlantYear,
        practice: item.practice,
        scheduledAt: batch.scheduledAt,
        interruptedReason: batch.interruptedReason,
      })
    }
  }
  return rows.sort((a, b) => (a.scheduledAt < b.scheduledAt ? -1 : 1))
}

/** 隔离带维护面板：补植批次与割草批次统一呈现。 */
export function maintenancePanel(): MaintenancePanelRow[] {
  const state = replantState()
  return state.batches
    .map((batch) => {
      const items = state.items.filter((item) => item.batchId === batch.id)
      const beltNos = batch.beltIds.map((beltId) => {
        const source: BeltSource = items[0]?.source ?? 'firebreak'
        const item = items.find((entry) => entry.beltId === beltId)
        if (item) {
          return item.beltNo
        }
        const row = getBeltRow(source, beltId)
        return row ? String(row[BELT_NO_FIELD[source]] ?? beltId) : `缺失林带 ${beltId}`
      })
      return {
        batchId: batch.id,
        batchNo: batch.batchNo,
        type: batch.type,
        typeLabel: batch.type === 'replant' ? '补植' : '割草维护',
        status: batch.status,
        beltCount: batch.beltIds.length,
        beltNos,
        scheduledAt: batch.scheduledAt,
        finishedAt: batch.finishedAt,
        interruptedReason: batch.interruptedReason,
      }
    })
    .sort((a, b) => (a.scheduledAt < b.scheduledAt ? -1 : 1))
}

/** 归档台账：按落账时间倒序，原种植年份始终读明细快照，不会被后续流程覆盖。 */
export function archiveLedger(): ArchiveEntry[] {
  return replantState()
    .archives.map((entry) => ({ ...entry }))
    .sort((a, b) => (a.archivedAt < b.archivedAt ? 1 : -1))
}

/** 巡护复查项：验收合格后同步生成，巡护任务清单直接读这里。 */
export function recheckList(): RecheckItem[] {
  return replantState()
    .rechecks.map((item) => ({ ...item }))
    .sort((a, b) => {
      if (a.status !== b.status) {
        return a.status === '待复查' ? -1 : 1
      }
      return a.dueAt < b.dueAt ? -1 : 1
    })
}

/* ------------------------------------------------------------------ */
/* 流程动作：只许前进                                                   */
/* ------------------------------------------------------------------ */

function nextBatchNo(type: 'replant' | 'mowing', seq: number, now: Date): string {
  const prefix = type === 'replant' ? 'BZ' : 'WH'
  return `${prefix}-${now.getFullYear()}-${pad2(seq % 1000)}`
}

/**
 * 安排补植：生成待验收补植批次。
 * 已退化/已荒废是终态、待验收补植批次已存在时都拒绝——退化林带不能被重复安排。
 */
export function arrangeReplant(
  source: BeltSource,
  beltId: number,
  practice: string = DEFAULT_REPLANT_PRACTICE,
): ActionResult {
  return runGuarded(() => runReplantTransaction(({ entries, replant }) => {
    const rows = entries[source]
    const index = rows.findIndex((row) => Number(row.id) === beltId)
    if (index < 0) {
      throw new BusinessAbort({ ok: false, message: `没有找到编号为 ${beltId} 的${SOURCE_LABEL[source]}` })
    }
    const row = rows[index]
    const status = String(row.status)
    if (status === TERMINAL[source]) {
      throw new BusinessAbort({
        ok: false,
        message: `${SOURCE_LABEL[source]}${String(row[BELT_NO_FIELD[source]])}已是「${TERMINAL[source]}」终态，不能再安排补植`,
      })
    }
    const existing = openReplantBatch(replant, source, beltId)
    if (existing) {
      throw new BusinessAbort({
        ok: false,
        message: `${SOURCE_LABEL[source]}已在补植批次 ${existing.batchNo} 中等待验收，不能重复安排`,
      })
    }
    if (status === NEED_REPLANT) {
      // 行内是需补植但没有未闭环批次（如历史脏数据）：允许重新安排，把它接回正常流程。
      const now0 = new Date()
      const seq0 = replant.seqBatch + 1
      replant.seqBatch = seq0
      const repairBatch: MaintenanceBatch = {
        id: seq0,
        batchNo: nextBatchNo('replant', seq0, now0),
        type: 'replant',
        status: '待验收',
        beltIds: [beltId],
        scheduledAt: now0.toISOString(),
        finishedAt: '',
        interruptedReason: '',
      }
      replant.batches.push(repairBatch)
      replant.items.push({
        batchId: repairBatch.id,
        source,
        beltId,
        beltNo: String(row[BELT_NO_FIELD[source]] ?? beltId),
        originalPlantYear: extractPlantYear(source, row),
        practice: practice.trim() || DEFAULT_REPLANT_PRACTICE,
        scheduledAt: repairBatch.scheduledAt,
      })
      return { ok: true, message: `该${SOURCE_LABEL[source]}缺有效补植批次，已重新安排 ${repairBatch.batchNo}，等待验收` }
    }

    const now = new Date()
    const seq = replant.seqBatch + 1
    replant.seqBatch = seq
    const batch: MaintenanceBatch = {
      id: seq,
      batchNo: nextBatchNo('replant', seq, now),
      type: 'replant',
      status: '待验收',
      beltIds: [beltId],
      scheduledAt: now.toISOString(),
      finishedAt: '',
      interruptedReason: '',
    }
    const item: ReplantItem = {
      batchId: batch.id,
      source,
      beltId,
      beltNo: String(row[BELT_NO_FIELD[source]] ?? beltId),
      // 安排时就把原种植年份固定下来，之后任何流转都不改它。
      originalPlantYear: extractPlantYear(source, row),
      practice: practice.trim() || DEFAULT_REPLANT_PRACTICE,
      scheduledAt: batch.scheduledAt,
    }
    replant.batches.push(batch)
    replant.items.push(item)

    // 林带进入需补植：同事务前进一步，不允许从更后状态倒退回此。
    entries[source][index] = {
      ...row,
      status: NEED_REPLANT,
      pending: true,
      abnormal: true,
    }
    return { ok: true, message: `已安排补植批次 ${batch.batchNo}，等待验收` }
  }))
}

/** 安排割草维护（仅隔离带）：正常 → 需割草，生成割草批次。 */
export function arrangeMowing(beltId: number): ActionResult {
  return runGuarded(() => runReplantTransaction(({ entries, replant }) => {
    const rows = entries.firebreak
    const index = rows.findIndex((row) => Number(row.id) === beltId)
    if (index < 0) {
      throw new BusinessAbort({ ok: false, message: `没有找到编号为 ${beltId} 的防火隔离带` })
    }
    const row = rows[index]
    const status = String(row.status)
    if (status === '已荒废') {
      throw new BusinessAbort({ ok: false, message: '已荒废的隔离带不能再安排维护' })
    }
    if (status === NEED_MOWING) {
      throw new BusinessAbort({ ok: false, message: '该隔离带已在割草维护中，不能重复安排' })
    }
    if (openReplantBatch(replant, 'firebreak', beltId)) {
      throw new BusinessAbort({ ok: false, message: '该隔离带在补植批次中等待验收，请先完成补植验收' })
    }

    const now = new Date()
    const seq = replant.seqBatch + 1
    replant.seqBatch = seq
    replant.batches.push({
      id: seq,
      batchNo: nextBatchNo('mowing', seq, now),
      type: 'mowing',
      status: '待验收',
      beltIds: [beltId],
      scheduledAt: now.toISOString(),
      finishedAt: '',
      interruptedReason: '',
    })
    entries.firebreak[index] = { ...row, status: NEED_MOWING, pending: true, abnormal: false }
    return { ok: true, message: '已安排割草维护，等待确认恢复' }
  }))
}

/** 标记退化/荒废：终态动作。有待验收补植批次时拒绝，防止边退化边重复安排。 */
export function markDegraded(source: BeltSource, beltId: number): ActionResult {
  return runGuarded(() => runReplantTransaction(({ entries, replant }) => {
    const rows = entries[source]
    const index = rows.findIndex((row) => Number(row.id) === beltId)
    if (index < 0) {
      throw new BusinessAbort({ ok: false, message: `没有找到编号为 ${beltId} 的${SOURCE_LABEL[source]}` })
    }
    const row = rows[index]
    const status = String(row.status)
    if (status === TERMINAL[source]) {
      throw new BusinessAbort({ ok: false, message: `${SOURCE_LABEL[source]}已是「${TERMINAL[source]}」，无需重复标记` })
    }
    const openBatch = openReplantBatch(replant, source, beltId)
    if (openBatch) {
      throw new BusinessAbort({
        ok: false,
        message: `该${SOURCE_LABEL[source]}在补植批次 ${openBatch.batchNo} 中等待验收，不能标记为${TERMINAL[source]}`,
      })
    }
    entries[source][index] = { ...row, status: TERMINAL[source], pending: false, abnormal: true }
    return { ok: true, message: `${SOURCE_LABEL[source]}已标记为${TERMINAL[source]}` }
  }))
}

/** 确认恢复（仅隔离带）：需割草 → 正常，同一事务关掉割草批次，不经过补植台账。 */
export function confirmRecovered(beltId: number): ActionResult {
  return runGuarded(() => runReplantTransaction(({ entries, replant }) => {
    const rows = entries.firebreak
    const index = rows.findIndex((row) => Number(row.id) === beltId)
    if (index < 0) {
      throw new BusinessAbort({ ok: false, message: `没有找到编号为 ${beltId} 的防火隔离带` })
    }
    const row = rows[index]
    if (String(row.status) !== NEED_MOWING) {
      throw new BusinessAbort({ ok: false, message: `只有「需割草」的隔离带能确认恢复，当前为「${String(row.status)}」` })
    }
    const batch = mowingBatchFor(replant, beltId)
    const now = new Date().toISOString()
    if (batch) {
      batch.status = '已验收'
      batch.finishedAt = now
      batch.interruptedReason = ''
    }
    entries.firebreak[index] = { ...row, status: '正常', pending: false, abnormal: false }
    return { ok: true, message: '隔离带已确认恢复正常，割草维护批次同步关闭' }
  }))
}

/* ------------------------------------------------------------------ */
/* 补植验收：并发只落一次、失败从缺失林带重试、三段同事务回退            */
/* ------------------------------------------------------------------ */

/** 进行中的验收批次：同一批次并发验收只有一个真正执行，其余幂等返回。 */
const inFlight = new Set<number>()

function performAcceptance(batchId: number, now: Date): BatchAcceptanceResult {
  return runReplantTransaction(({ entries, replant }): BatchAcceptanceResult => {
    const batch = replant.batches.find((item) => item.id === batchId)
    if (!batch) {
      throw new BusinessAbort({ ok: false, message: `维护批次 ${batchId} 不存在` })
    }
    if (batch.type !== 'replant') {
      throw new BusinessAbort({ ok: false, message: `批次 ${batch.batchNo} 是割草维护批次，请在隔离带行上确认恢复` })
    }
    // 幂等：已验收批次再次（含并发晚到的）调用，直接返回原结果，不再落任何记录。
    if (batch.status === '已验收') {
      return {
        ok: true,
        batchId,
        accepted: 0,
        archived: 0,
        rechecks: 0,
        message: `批次 ${batch.batchNo} 已验收过，本次为重复提交，未重复落库`,
      }
    }

    const items = replant.items.filter((item) => item.batchId === batchId)
    if (items.length === 0) {
      throw new BusinessAbort({ ok: false, message: `批次 ${batch.batchNo} 下没有可验收的林带` })
    }

    // 提交前预检：先定位缺失林带，失败时调用方按此从缺失林带重试。预检不落任何数据。
    for (const item of items) {
      const row = entries[item.source]?.find((entry) => Number(entry.id) === item.beltId)
      if (!row) {
        throw new BusinessAbort({
          ok: false,
          batchId,
          accepted: 0,
          archived: 0,
          rechecks: 0,
          missing: { source: item.source, beltId: item.beltId },
          message: `验收中断：${SOURCE_LABEL[item.source]}编号 ${item.beltId}（${item.beltNo}）缺失，请从该缺失林带重试；本次未落任何记录`,
        })
      }
    }

    const stamp = now.toISOString()
    let accepted = 0
    let archived = 0
    let rechecks = 0

    for (const item of items) {
      const rows = entries[item.source]
      const index = rows.findIndex((entry) => Number(entry.id) === item.beltId)
      const row = rows[index]
      const status = String(row.status)
      if (status !== NEED_REPLANT) {
        throw new BusinessAbort({
          ok: false,
          batchId,
          accepted: 0,
          archived: 0,
          rechecks: 0,
          message: `${SOURCE_LABEL[item.source]}${item.beltNo} 当前为「${status}」，不是「需补植」，流程不能反向推进`,
        })
      }

      // 1) 验收记录（冲突时以它为准）；2) 林带恢复完好并清缺株标记；种植年份不动。
      replant.seqAcceptance += 1
      const acceptanceId = replant.seqAcceptance
      const acceptance: AcceptanceRecord = {
        id: acceptanceId,
        batchId,
        source: item.source,
        beltId: item.beltId,
        verdict: '合格',
        acceptedAt: stamp,
        operator: '值班管理员',
        replantYear: now.getFullYear(),
        note: '',
      }
      replant.acceptances.push(acceptance)
      rows[index] = {
        ...row,
        status: HEALTHY[item.source],
        pending: false,
        abnormal: false,
      }
      accepted += 1

      // 3) 归档台账：原种植年份取安排时的快照，补植年份取验收年。
      replant.seqArchive += 1
      const archive: ArchiveEntry = {
        id: replant.seqArchive,
        batchId,
        acceptanceId,
        source: item.source,
        beltId: item.beltId,
        beltNo: item.beltNo,
        originalPlantYear: item.originalPlantYear,
        replantYear: now.getFullYear(),
        practice: item.practice,
        archivedAt: stamp,
      }
      replant.archives.push(archive)
      archived += 1

      // 4) 巡护任务清单同步生成复查项（同一事务，失败一起回退）。
      replant.seqRecheck += 1
      const recheck: RecheckItem = {
        id: replant.seqRecheck,
        batchId,
        source: item.source,
        beltId: item.beltId,
        beltNo: item.beltNo,
        title: `补植复查：${SOURCE_LABEL[item.source]} ${item.beltNo}（批次 ${batch.batchNo}）`,
        dueAt: addDays(stamp, 14),
        createdAt: stamp,
        status: '待复查',
        completedAt: '',
      }
      replant.rechecks.push(recheck)
      rechecks += 1
    }

    batch.status = '已验收'
    batch.finishedAt = stamp
    batch.interruptedReason = ''

    return {
      ok: true,
      batchId,
      accepted,
      archived,
      rechecks,
      message: `批次 ${batch.batchNo} 验收通过：林带 ${accepted}、归档 ${archived}、复查项 ${rechecks}，缺株标记已清除`,
    }
  })
}

/**
 * 验收一个补植批次。并发调用同一批次时只落一次：
 * 进行中的并发调用直接幂等拒绝；已完成的重复调用返回首次结果口径。
 * 业务/写入失败时不在本函数吞错，由调用方把中断原因写回批次（可重试）。
 */
export function acceptReplantBatch(
  batchId: number,
  now: Date = new Date(),
): BatchAcceptanceResult {
  if (inFlight.has(batchId)) {
    const state = replantState()
    const batch = state.batches.find((item) => item.id === batchId)
    return {
      ok: false,
      batchId,
      accepted: 0,
      archived: 0,
      rechecks: 0,
      message: `批次 ${batch?.batchNo ?? batchId} 正在验收中，请勿重复提交（并发验收只落一次）`,
    }
  }
  inFlight.add(batchId)
  try {
    return performAcceptance(batchId, now)
  } catch (error) {
    if (error instanceof BusinessAbort) {
      const payload = error.payload as BatchAcceptanceResult
      return {
        ...payload,
        batchId: payload.batchId ?? batchId,
        accepted: payload.accepted ?? 0,
        archived: payload.archived ?? 0,
        rechecks: payload.rechecks ?? 0,
      }
    }
    // 写入中断：事务已整体回滚，把中断原因记到批次上，批次仍可重试。
    const reason = error instanceof CommitError ? error.message : `验收异常中断：${String(error)}`
    recordInterruption(batchId, reason)
    return {
      ok: false,
      batchId,
      accepted: 0,
      archived: 0,
      rechecks: 0,
      message: `${reason}；数据已回退，可重试`,
    }
  } finally {
    inFlight.delete(batchId)
  }
}

/** 中断原因落库：只动业务域切片，不触碰林带与台账（它们已在事务中回退）。 */
function recordInterruption(batchId: number, reason: string): void {
  try {
    patchReplantState((state) => {
      const batch = state.batches.find((item) => item.id === batchId)
      if (batch && batch.status !== '已验收') {
        batch.status = '已中断'
        batch.finishedAt = new Date().toISOString()
        batch.interruptedReason = reason
      }
    })
  } catch {
    // 记录中断原因本身失败时不掩盖原始错误，调用方消息里已带原因。
  }
}

/** 复查项完成：巡护任务清单侧的前进动作。 */
export function completeRecheck(recheckId: number): ActionResult {
  return runGuarded(() => runReplantTransaction(({ replant }) => {
    const item = replant.rechecks.find((entry) => entry.id === recheckId)
    if (!item) {
      throw new BusinessAbort({ ok: false, message: `没有找到编号为 ${recheckId} 的复查项` })
    }
    if (item.status === '已完成') {
      throw new BusinessAbort({ ok: false, message: '该复查项已完成，无需重复提交' })
    }
    item.status = '已完成'
    item.completedAt = new Date().toISOString()
    return { ok: true, message: '复查已完成' }
  }))
}

/* ------------------------------------------------------------------ */
/* 与通用动作入口对接                                                   */
/* ------------------------------------------------------------------ */

/**
 * 林带/隔离带行上的可执行动作：按投影后的当前状态给，杜绝反向流转入口。
 */
export function allowedRowActions(source: BeltSource, status: string): string[] {
  if (source === 'firebelt') {
    switch (status) {
      case '完好':
      case '有缺株':
        return ['安排补植', '标记退化']
      case NEED_REPLANT:
        return ['确认补植']
      case '已退化':
      default:
        return []
    }
  }
  switch (status) {
    case '正常':
      return ['安排维护', '安排补植', '标记荒废']
    case NEED_MOWING:
      return ['确认恢复', '标记荒废']
    case NEED_REPLANT:
      return ['确认补植']
    case '已荒废':
    default:
      return []
  }
}

/** 通用 runAction 的林带/隔离带分支入口。 */
export function runBeltAction(source: BeltSource, beltId: number, action: string): ActionResult {
  try {
    if (source === 'firebelt') {
      switch (action) {
        case '安排补植':
          return arrangeReplant('firebelt', beltId)
        case '确认补植': {
          const batch = replantState().batches.find(
            (entry) =>
              entry.type === 'replant' &&
              entry.status !== '已验收' &&
              replantState().items.some(
                (item) => item.batchId === entry.id && item.source === 'firebelt' && item.beltId === beltId,
              ),
          )
          if (!batch) {
            return { ok: false, message: '该林带没有待验收的补植批次，无法确认补植' }
          }
          return acceptReplantBatch(batch.id)
        }
        case '标记退化':
          return markDegraded('firebelt', beltId)
        default:
          return { ok: false, message: `防火林带没有登记「${action}」这个动作` }
      }
    }
    switch (action) {
      case '安排维护':
        return arrangeMowing(beltId)
      case '确认恢复':
        return confirmRecovered(beltId)
      case '安排补植':
        return arrangeReplant('firebreak', beltId)
      case '确认补植': {
        const state = replantState()
        const batch = state.batches.find(
          (entry) =>
            entry.type === 'replant' &&
            entry.status !== '已验收' &&
            state.items.some(
              (item) => item.batchId === entry.id && item.source === 'firebreak' && item.beltId === beltId,
            ),
        )
        if (!batch) {
          return { ok: false, message: '该隔离带没有待验收的补植批次，无法确认补植' }
        }
        return acceptReplantBatch(batch.id)
      }
      case '标记荒废':
        return markDegraded('firebreak', beltId)
      default:
        return { ok: false, message: `防火隔离带没有登记「${action}」这个动作` }
    }
  } catch (error) {
    if (error instanceof BusinessAbort) {
      return error.payload
    }
    return {
      ok: false,
      message: error instanceof Error ? error.message : '补植流程执行异常，数据未改动',
    }
  }
}
