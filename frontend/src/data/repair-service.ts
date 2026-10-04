/**
 * 林带补植 / 隔离带维护共用服务。
 *
 * 取数路径只有一条：readRepairState() 从同一份本地快照取林带主表、隔离带主表、
 * 验收记录、维护批次、归档台账、巡护复查项，再由 effective* 系列函数叠加权威结论：
 *   - 林带/隔离带/归档三处状态冲突时，一律以验收记录为准；
 *   - 已验收林带按「完好」展示，缺株标记随之消失；
 *   - 归档台账保留最初种植年份，补植不改写历史。
 *
 * 写入路径也只有一条：在 snapshot() 副本上改，改完 commit() 一次性落库；
 * 林带、维护批次、归档任一环节抛错都不 commit，整笔回退。
 */

import { commit, repairCollections, resetRepairStore, saveRows, snapshot } from './local-store'
import { SEED_ROWS } from './seed'
import type {
  AcceptanceRecord,
  AcceptResult,
  ArchiveEntry,
  BatchStatus,
  MaintenanceBatch,
  PatrolReviewItem,
  RepairState,
} from './repair-types'
import type { EntryRow } from './types'

const BELT_KEY = 'firebelt'
const BREAK_KEY = 'firebreak'
const PATROL_KEY = 'patrol'

const BELT_RANK: Record<string, number> = { 完好: 0, 有缺株: 1, 需补植: 2, 已退化: 3 }
const BREAK_RANK: Record<string, number> = { 正常: 0, 需割草: 1, 需补植: 2, 已荒废: 3 }

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export type SimpleResult = { ok: boolean; message: string }

/** 故障注入：演示并发/中断/回退/重试时用，正常操作不传。 */
export type FaultSpec = {
  /** accept：验收记录环节；archive：归档台账环节；storage：整库持久化环节。 */
  stage: 'accept' | 'archive' | 'storage'
  /** 批次验收时，在第几条「尚未验收」的林带上失败（从 1 起，默认 1）。 */
  beltOrdinal?: number
}

export type BeltView = {
  row: EntryRow
  rawStatus: string
  /** 叠加验收记录后的实际状态。 */
  effectiveStatus: string
  /** 权威验收记录（有则一切展示以它为准）。 */
  acceptance: AcceptanceRecord | undefined
  /** 所在的在途补植批次。 */
  openBatch: MaintenanceBatch | undefined
  /** 主表状态与验收结论冲突（缺株标记残留的脏数据会命中）。 */
  statusConflict: boolean
  hasMissingPlant: boolean
  canArrange: boolean
  canAccept: boolean
  canDegrade: boolean
}

export type BreakView = {
  row: EntryRow
  rawStatus: string
  effectiveStatus: string
  statusConflict: boolean
  openBatches: MaintenanceBatch[]
  canArrangeMaintenance: boolean
  canRecover: boolean
  canAbandon: boolean
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

function nextId(items: { id: number }[]): number {
  return items.reduce((max, item) => Math.max(max, item.id), 0) + 1
}

function beltArea(belt: EntryRow): string {
  return String(belt['所属林区'] ?? '')
}

function beltCode(belt: EntryRow): string {
  return String(belt['林带编号'] ?? '')
}

function breakArea(brk: EntryRow): string {
  return String(brk['所属林区'] ?? '')
}

/** 林带最新的一条验收记录（按验收时间、id 取最新）。 */
export function latestAcceptance(state: RepairState, beltId: number): AcceptanceRecord | undefined {
  return state.acceptances
    .filter((item) => item.beltId === beltId)
    .sort((a, b) => (a.acceptedAt === b.acceptedAt ? b.id - a.id : a.acceptedAt < b.acceptedAt ? 1 : -1))[0]
}

/**
 * 共用取数路径的核心：林带实际状态。
 * 主表与验收记录冲突时，以验收记录为准——已验收即「完好」，缺株标记消失。
 */
export function effectiveBeltStatus(state: RepairState, beltId: number): string {
  const accepted = latestAcceptance(state, beltId)
  if (accepted?.status === '已验收') {
    return '完好'
  }
  return String(state.belts.find((item) => item.id === beltId)?.status ?? '完好')
}

function openReplantBatches(state: RepairState): MaintenanceBatch[] {
  return state.batches.filter((batch) => batch.kind === '补植' && batch.status === '待验收')
}

/**
 * 隔离带实际状态：已荒废是终态；林带缺口是否还存在以「林带叠加验收后的状态」为准。
 * 主表滞后（写着需补植但缺口已随补植验收消除）时，按验收结论回到正常/需割草。
 */
export function effectiveBreakStatus(state: RepairState, breakId: number): string {
  const brk = state.breaks.find((item) => item.id === breakId)
  if (!brk) {
    return '正常'
  }
  const raw = String(brk.status)
  if (raw === '已荒废') {
    return raw
  }
  const area = breakArea(brk)
  const areaBelts = state.belts.filter((belt) => beltArea(belt) === area)
  const stillNeedsReplant = areaBelts.some((belt) => effectiveBeltStatus(state, belt.id) === '需补植')
  if (stillNeedsReplant) {
    return '需补植'
  }
  if (raw === '需补植') {
    // 主表残留：缺口已通过验收消除，按维护批次的验收结论展示为需割草，继续走日常维护。
    return '需割草'
  }
  return raw
}

/** 三个页面共用的唯一取数入口。 */
export function readRepairState(): RepairState {
  const store = snapshot()
  return {
    belts: store.rows[BELT_KEY] ?? [],
    breaks: store.rows[BREAK_KEY] ?? [],
    acceptances: store.repair.repairAcceptances,
    batches: store.repair.repairBatches,
    archive: store.repair.repairArchive,
    reviews: store.repair.patrolReviews,
  }
}

/** 补植列表的行视图：标记可执行动作，退化/已验收的林带不允许再安排。 */
export function listBeltViews(filters: { area?: string; keyword?: string } = {}): BeltView[] {
  const state = readRepairState()
  const openBatches = openReplantBatches(state)
  const area = filters.area?.trim() ?? ''
  const keyword = filters.keyword?.trim() ?? ''
  return state.belts
    .filter((belt) => (area ? beltArea(belt).includes(area) : true))
    .filter((belt) =>
      keyword
        ? [belt['林带编号'], belt['林带名称'], belt['树种组成']].some((value) => String(value ?? '').includes(keyword))
        : true,
    )
    .map((belt) => {
      const acceptance = latestAcceptance(state, belt.id)
      const effectiveStatus = effectiveBeltStatus(state, belt.id)
      const openBatch = openBatches.find((batch) => batch.beltIds.includes(belt.id))
      const accepted = acceptance?.status === '已验收'
      return {
        row: belt,
        rawStatus: String(belt.status),
        effectiveStatus,
        acceptance,
        openBatch,
        statusConflict: String(belt.status) !== effectiveStatus,
        hasMissingPlant: effectiveStatus === '有缺株',
        // 已退化是终态、已验收以验收记录为准，都不能再安排补植；已在在途批次里的不重复安排。
        canArrange:
          !accepted &&
          effectiveStatus !== '已退化' &&
          effectiveStatus !== '完好' &&
          !openBatch,
        canAccept: effectiveStatus === '需补植' || !!openBatch,
        canDegrade: !accepted && effectiveStatus !== '已退化',
      }
    })
}

/** 隔离带维护面板的行视图。 */
export function listBreakViews(filters: { area?: string; keyword?: string } = {}): BreakView[] {
  const state = readRepairState()
  const openBatches = openReplantBatches(state)
  const area = filters.area?.trim() ?? ''
  const keyword = filters.keyword?.trim() ?? ''
  return state.breaks
    .filter((brk) => (area ? breakArea(brk).includes(area) : true))
    .filter((brk) =>
      keyword
        ? [brk['隔离带编号'], brk['起止坐标']].some((value) => String(value ?? '').includes(keyword))
        : true,
    )
    .map((brk) => {
      const effectiveStatus = effectiveBreakStatus(state, brk.id)
      const areaBatches = openBatches.filter((batch) =>
        batch.breakIds.includes(brk.id),
      )
      const areaBelts = state.belts.filter((belt) => beltArea(belt) === breakArea(brk))
      const tiedOpenBatch = openBatches.find((batch) =>
        areaBelts.some((belt) => batch.beltIds.includes(belt.id)),
      )
      return {
        row: brk,
        rawStatus: String(brk.status),
        effectiveStatus,
        statusConflict: String(brk.status) !== effectiveStatus,
        openBatches: tiedOpenBatch ? [tiedOpenBatch, ...areaBatches.filter((b) => b.id !== tiedOpenBatch.id)] : areaBatches,
        canArrangeMaintenance: effectiveStatus === '正常',
        canRecover: effectiveStatus === '需割草',
        canAbandon: effectiveStatus !== '已荒废' && !tiedOpenBatch,
      }
    })
}

/** 归档台账行：固定以归档表自身为准；老数据缺行时按验收记录兜底补算，原种植年份仍取林带主表。 */
export type ArchiveView = ArchiveEntry & { statusConflict: boolean }

export function listArchiveViews(filters: { area?: string; keyword?: string } = {}): ArchiveView[] {
  const state = readRepairState()
  const stored = new Map(state.archive.map((entry) => [entry.beltId, entry]))
  const derived: ArchiveView[] = state.acceptances
    .filter((item) => item.status === '已验收')
    .map((acceptance) => {
      const belt = state.belts.find((item) => item.id === acceptance.beltId)
      const storedEntry = stored.get(acceptance.beltId)
      const base: ArchiveEntry = storedEntry ?? {
        id: acceptance.id,
        beltId: belt?.id ?? acceptance.beltId,
        beltCode: belt ? beltCode(belt) : `BELT-${acceptance.beltId}`,
        beltName: belt ? String(belt['林带名称'] ?? '') : '',
        forestArea: belt ? beltArea(belt) : '',
        // 历史记录保留原种植年份：补植从不改写林带主表的「种植年份」。
        originalPlantYear: belt ? String(belt['种植年份'] ?? '') : '',
        replantYear: acceptance.acceptedAt.slice(0, 4),
        batchId: acceptance.batchId,
        acceptedAt: acceptance.acceptedAt,
        acceptedBy: acceptance.acceptedBy,
      }
      return { ...base, statusConflict: !storedEntry }
    })
  const area = filters.area?.trim() ?? ''
  const keyword = filters.keyword?.trim() ?? ''
  return derived
    .filter((entry) => (area ? entry.forestArea.includes(area) : true))
    .filter((entry) =>
      keyword
        ? [entry.beltCode, entry.beltName].some((value) => String(value ?? '').includes(keyword))
        : true,
    )
    .sort((a, b) => (a.acceptedAt === b.acceptedAt ? b.id - a.id : a.acceptedAt < b.acceptedAt ? 1 : -1))
}

export function listBatchViews(): (MaintenanceBatch & { acceptedBeltIds: number[]; waitingBeltIds: number[] })[] {
  const state = readRepairState()
  return state.batches
    .slice()
    .sort((a, b) => b.id - a.id)
    .map((batch) => ({
      ...batch,
      acceptedBeltIds: batch.beltIds.filter((beltId) =>
        state.acceptances.some((item) => item.beltId === beltId && item.status === '已验收'),
      ),
      waitingBeltIds: batch.beltIds.filter(
        (beltId) => !state.acceptances.some((item) => item.beltId === beltId && item.status === '已验收'),
      ),
    }))
}

export function listReviewViews(): PatrolReviewItem[] {
  return repairCollections().patrolReviews.slice().sort((a, b) => b.id - a.id)
}

// ---------------------------------------------------------------------------
// 写入：全部在快照副本上改，最后一次 commit 原子落库
// ---------------------------------------------------------------------------

type Store = ReturnType<typeof snapshot>

function findBelt(store: Store, beltId: number): EntryRow {
  const belt = store.rows[BELT_KEY]?.find((item) => item.id === beltId)
  if (!belt) {
    throw new Error(`缺失林带：编号 ${beltId} 的林带在补植列表中不存在，请刷新后从缺失林带重试`)
  }
  return belt
}

type RowPatch = Record<string, string | number | boolean>

function patchBelt(store: Store, belt: EntryRow, patch: RowPatch): void {
  const rows = store.rows[BELT_KEY] ?? []
  const index = rows.findIndex((item) => item.id === belt.id)
  rows[index] = { ...rows[index], ...patch }
  store.rows[BELT_KEY] = rows
}

function patchBreakByArea(store: Store, area: string, patch: RowPatch): void {
  const rows = store.rows[BREAK_KEY] ?? []
  store.rows[BREAK_KEY] = rows.map((brk) =>
    breakArea(brk) === area ? { ...brk, ...patch } : brk,
  )
}

function assertForward(current: string, next: string, rank: Record<string, number>, label: string): void {
  if (current === next) {
    throw new Error(`${label}已经是「${next}」，不用重复操作`)
  }
  if ((rank[current] ?? -1) > (rank[next] ?? Number.MAX_SAFE_INTEGER)) {
    throw new Error(`修复流程不能反向推进：${label}不能从「${current}」退回「${next}」`)
  }
}

/**
 * 安排补植：有缺株 → 需补植，并挂到同林区在途补植批次（没有就新开一批）。
 * 已退化（终态）、已验收、已在在途批次的林带一律拒绝，避免重复安排。
 */
export function arrangeReplant(beltId: number): SimpleResult {
  const store = snapshot()
  const belt = findBelt(store, beltId)
  const state: RepairState = {
    belts: store.rows[BELT_KEY] ?? [],
    breaks: store.rows[BREAK_KEY] ?? [],
    acceptances: store.repair.repairAcceptances,
    batches: store.repair.repairBatches,
    archive: store.repair.repairArchive,
    reviews: store.repair.patrolReviews,
  }
  const current = effectiveBeltStatus(state, belt.id)
  if (latestAcceptance(state, belt.id)?.status === '已验收') {
    return { ok: false, message: `${beltCode(belt)} 已有验收通过记录，以验收记录为准，不能重复安排补植` }
  }
  if (current === '已退化') {
    return { ok: false, message: `${beltCode(belt)} 已退化，属终态，不能再安排补植，请先更新林带本底调查` }
  }
  const openBatch = state.batches
    .filter((batch) => batch.kind === '补植' && batch.status === '待验收')
    .find((batch) => batch.forestArea === beltArea(belt))
  if (openBatch?.beltIds.includes(belt.id)) {
    return { ok: false, message: `${beltCode(belt)} 已在维护批次 ${openBatch.batchNo} 中，不能重复安排` }
  }
  const areaBreak = (store.rows[BREAK_KEY] ?? []).find((brk) => breakArea(brk) === beltArea(belt))
  if (areaBreak && String(areaBreak.status) === '已荒废') {
    return { ok: false, message: `${beltArea(belt)} 隔离带已荒废，无法安排补植，请先恢复隔离带` }
  }
  try {
    if (current !== '需补植') {
      assertForward(current, '需补植', BELT_RANK, `${beltCode(belt)}`)
    }
    let batch: MaintenanceBatch
    if (openBatch) {
      batch = { ...openBatch, beltIds: [...openBatch.beltIds, belt.id] }
      store.repair.repairBatches = store.repair.repairBatches.map((item) =>
        item.id === batch.id ? batch : item,
      )
    } else {
      const id = nextId(store.repair.repairBatches)
      batch = {
        id,
        batchNo: `MAINT-${new Date().getFullYear()}-${String(id).padStart(3, '0')}`,
        forestArea: beltArea(belt),
        kind: '补植',
        createdAt: today(),
        status: '待验收',
        beltIds: [belt.id],
        breakIds: areaBreak ? [areaBreak.id] : [],
        completedAt: '',
      }
      store.repair.repairBatches = [...store.repair.repairBatches, batch]
    }
    patchBelt(store, belt, { status: '需补植', pending: true, abnormal: false, 林带状态: '需补植' })
    if (areaBreak && String(areaBreak.status) !== '需补植') {
      assertForward(String(areaBreak.status), '需补植', BREAK_RANK, `${beltArea(belt)}隔离带`)
      patchBreakByArea(store, beltArea(belt), {
        status: '需补植',
        pending: true,
        abnormal: false,
        维护状态: '需补植',
      })
    }
    commit(store)
    return { ok: true, message: `${beltCode(belt)} 已安排补植，挂入维护批次 ${batch.batchNo}，等待验收` }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '安排补植失败，数据未改动' }
  }
}

/** 标记退化：终态操作。已验收的林带不能退化（流程不得反向）。 */
export function markBeltDegraded(beltId: number): SimpleResult {
  const store = snapshot()
  const belt = findBelt(store, beltId)
  const state: RepairState = {
    belts: store.rows[BELT_KEY] ?? [],
    breaks: store.rows[BREAK_KEY] ?? [],
    acceptances: store.repair.repairAcceptances,
    batches: store.repair.repairBatches,
    archive: store.repair.repairArchive,
    reviews: store.repair.patrolReviews,
  }
  if (latestAcceptance(state, belt.id)?.status === '已验收') {
    return { ok: false, message: `${beltCode(belt)} 已验收通过，以验收记录为准，不能再标记退化` }
  }
  const current = effectiveBeltStatus(state, belt.id)
  if (current === '已退化') {
    return { ok: false, message: `${beltCode(belt)} 已是退化林带，不能重复标记` }
  }
  try {
    // 从在途补植批次中摘除该林带；批次被摘空则整批撤销（尚未验收，不进历史）。
    const openBatches = store.repair.repairBatches.filter(
      (batch) => batch.kind === '补植' && batch.status === '待验收' && batch.beltIds.includes(belt.id),
    )
    for (const batch of openBatches) {
      const remaining = batch.beltIds.filter((id) => id !== belt.id)
      if (remaining.length === 0) {
        store.repair.repairBatches = store.repair.repairBatches.filter((item) => item.id !== batch.id)
      } else {
        store.repair.repairBatches = store.repair.repairBatches.map((item) =>
          item.id === batch.id ? { ...item, beltIds: remaining } : item,
        )
      }
    }
    patchBelt(store, belt, { status: '已退化', pending: false, abnormal: true, 林带状态: '已退化' })
    commit(store)
    return { ok: true, message: `${beltCode(belt)} 已标记为退化林带，已从在途补植批次中摘除` }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '标记退化失败，数据未改动' }
  }
}

// ---------------------------------------------------------------------------
// 隔离带维护面板动作
// ---------------------------------------------------------------------------

/** 安排维护（割草）：正常 → 需割草，开一个割草批次。其他状态拒绝，保证不反向、不重复。 */
export function arrangeMaintenance(breakId: number): SimpleResult {
  const store = snapshot()
  const rows = store.rows[BREAK_KEY] ?? []
  const brk = rows.find((item) => item.id === breakId)
  if (!brk) {
    return { ok: false, message: `没有找到编号为 ${breakId} 的隔离带` }
  }
  const state: RepairState = {
    belts: store.rows[BELT_KEY] ?? [],
    breaks: rows,
    acceptances: store.repair.repairAcceptances,
    batches: store.repair.repairBatches,
    archive: store.repair.repairArchive,
    reviews: store.repair.patrolReviews,
  }
  const current = effectiveBreakStatus(state, brk.id)
  if (current === '已荒废') {
    return { ok: false, message: `${brk['隔离带编号']} 已荒废，须先走重建流程，不能安排日常维护` }
  }
  if (current === '需补植') {
    return { ok: false, message: `${brk['隔离带编号']} 存在林带缺口，请在补植列表中走补植验收流程` }
  }
  if (current === '需割草') {
    return { ok: false, message: `${brk['隔离带编号']} 已安排维护，不能重复安排` }
  }
  try {
    const id = nextId(store.repair.repairBatches)
    const batch: MaintenanceBatch = {
      id,
      batchNo: `MAINT-${new Date().getFullYear()}-${String(id).padStart(3, '0')}`,
      forestArea: breakArea(brk),
      kind: '割草',
      createdAt: today(),
      status: '待验收',
      beltIds: [],
      breakIds: [brk.id],
      completedAt: '',
    }
    store.repair.repairBatches = [...store.repair.repairBatches, batch]
    store.rows[BREAK_KEY] = rows.map((item) =>
      item.id === brk.id
        ? { ...item, status: '需割草', pending: true, abnormal: false, 维护状态: '需割草' }
        : item,
    )
    commit(store)
    return { ok: true, message: `${brk['隔离带编号']} 已安排割草维护，批次 ${batch.batchNo} 等待完工确认` }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '安排维护失败，数据未改动' }
  }
}

/** 确认恢复：需割草 → 正常，关闭在途割草批次。需补植的必须等补植验收，不能在此跳步。 */
export function confirmBreakRecovery(breakId: number): SimpleResult {
  const store = snapshot()
  const rows = store.rows[BREAK_KEY] ?? []
  const brk = rows.find((item) => item.id === breakId)
  if (!brk) {
    return { ok: false, message: `没有找到编号为 ${breakId} 的隔离带` }
  }
  const state: RepairState = {
    belts: store.rows[BELT_KEY] ?? [],
    breaks: rows,
    acceptances: store.repair.repairAcceptances,
    batches: store.repair.repairBatches,
    archive: store.repair.repairArchive,
    reviews: store.repair.patrolReviews,
  }
  const current = effectiveBreakStatus(state, brk.id)
  if (current === '需补植') {
    return { ok: false, message: `${brk['隔离带编号']} 仍有林带缺口，须先完成补植验收，不能直接确认恢复` }
  }
  if (current === '正常') {
    return { ok: false, message: `${brk['隔离带编号']} 已是正常状态，不用重复确认` }
  }
  if (current === '已荒废') {
    return { ok: false, message: `${brk['隔离带编号']} 已荒废，确认恢复不适用` }
  }
  try {
    store.repair.repairBatches = store.repair.repairBatches.map((batch) =>
      batch.kind === '割草' && batch.status === '待验收' && batch.breakIds.includes(brk.id)
        ? { ...batch, status: '已完成' as BatchStatus, completedAt: today() }
        : batch,
    )
    store.rows[BREAK_KEY] = rows.map((item) =>
      item.id === brk.id
        ? {
            ...item,
            status: '正常',
            pending: false,
            abnormal: false,
            最近维护日期: today(),
            维护状态: '正常',
          }
        : item,
    )
    commit(store)
    return { ok: true, message: `${brk['隔离带编号']} 割草维护已完工，恢复为正常` }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '确认恢复失败，数据未改动' }
  }
}

/** 标记荒废：有在途补植批次的拒绝，避免批次悬空。 */
export function markBreakAbandoned(breakId: number): SimpleResult {
  const store = snapshot()
  const rows = store.rows[BREAK_KEY] ?? []
  const brk = rows.find((item) => item.id === breakId)
  if (!brk) {
    return { ok: false, message: `没有找到编号为 ${breakId} 的隔离带` }
  }
  const state: RepairState = {
    belts: store.rows[BELT_KEY] ?? [],
    breaks: rows,
    acceptances: store.repair.repairAcceptances,
    batches: store.repair.repairBatches,
    archive: store.repair.repairArchive,
    reviews: store.repair.patrolReviews,
  }
  const current = effectiveBreakStatus(state, brk.id)
  if (current === '已荒废') {
    return { ok: false, message: `${brk['隔离带编号']} 已荒废，不能重复标记` }
  }
  const tied = state.batches.some(
    (batch) =>
      batch.kind === '补植' &&
      batch.status === '待验收' &&
      (state.belts
        .filter((belt) => beltArea(belt) === breakArea(brk))
        .some((belt) => batch.beltIds.includes(belt.id))),
  )
  if (tied) {
    return { ok: false, message: `${brk['隔离带编号']} 所在林区有在途补植批次，先完成或摘除林带后再标记荒废` }
  }
  try {
    store.rows[BREAK_KEY] = rows.map((item) =>
      item.id === brk.id
        ? { ...item, status: '已荒废', pending: false, abnormal: true, 维护状态: '已荒废' }
        : item,
    )
    commit(store)
    return { ok: true, message: `${brk['隔离带编号']} 已标记荒废` }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '标记荒废失败，数据未改动' }
  }
}

// ---------------------------------------------------------------------------
// 补植验收：只允许向前、并发只落一次、失败整笔回退、批次可从缺失林带重试
// ---------------------------------------------------------------------------

const inFlight = new Set<string>()

function makeReview(store: Store, belt: EntryRow, acceptanceId: number): PatrolReviewItem {
  const id = nextId(store.repair.patrolReviews)
  const seq = store.repair.patrolReviews.length + 1
  return {
    id,
    beltId: belt.id,
    acceptanceId,
    reviewNo: `REV-${new Date().getFullYear()}-${String(seq).padStart(4, '0')}`,
    area: beltArea(belt),
    reviewer: '待派巡护员',
    reviewDate: today(),
    note: `${beltCode(belt)} 补植后成活率复查`,
    status: '待复查',
  }
}

/**
 * 在快照副本上准备一条林带的验收事务（林带、验收记录、批次、归档、复查项五件事），
 * 不做任何持久化。返回时由调用方决定 commit 还是丢弃（丢弃即整笔回退）。
 */
function prepareBeltAcceptance(store: Store, beltId: number): {
  belt: EntryRow
  acceptance: AcceptanceRecord
  batch: MaintenanceBatch
} {
  const belt = findBelt(store, beltId)
  const stateBefore: RepairState = {
    belts: store.rows[BELT_KEY] ?? [],
    breaks: store.rows[BREAK_KEY] ?? [],
    acceptances: store.repair.repairAcceptances,
    batches: store.repair.repairBatches,
    archive: store.repair.repairArchive,
    reviews: store.repair.patrolReviews,
  }
  if (latestAcceptance(stateBefore, belt.id)?.status === '已验收') {
    throw new Error(`${beltCode(belt)} 已验收通过，验收记录只落一次，请勿重复提交`)
  }
  const rawStatus = String(belt.status)
  if (rawStatus === '已退化') {
    throw new Error(`${beltCode(belt)} 已退化，不能验收补植`)
  }
  if (rawStatus === '完好') {
    throw new Error(`${beltCode(belt)} 当前为完好，无需补植验收，流程不能反向推进`)
  }

  // 找到所在在途补植批次；单条验收且没有批次时，自动开一条单林带批次。
  let batch = store.repair.repairBatches.find(
    (item) => item.kind === '补植' && item.status === '待验收' && item.beltIds.includes(belt.id),
  )
  if (!batch) {
    const areaBreak = (store.rows[BREAK_KEY] ?? []).find((brk) => breakArea(brk) === beltArea(belt))
    const id = nextId(store.repair.repairBatches)
    batch = {
      id,
      batchNo: `MAINT-${new Date().getFullYear()}-${String(id).padStart(3, '0')}`,
      forestArea: beltArea(belt),
      kind: '补植',
      createdAt: today(),
      status: '待验收',
      beltIds: [belt.id],
      breakIds: areaBreak ? [areaBreak.id] : [],
      completedAt: '',
    }
    store.repair.repairBatches = [...store.repair.repairBatches, batch]
  }

  // 1) 林带主表：缺株标记消失，状态回到完好。
  patchBelt(store, belt, { status: '完好', pending: false, abnormal: false, 林带状态: '完好' })

  // 2) 验收记录（权威）。
  const acceptance: AcceptanceRecord = {
    id: nextId(store.repair.repairAcceptances),
    beltId: belt.id,
    batchId: batch.id,
    beforeStatus: rawStatus,
    status: '已验收',
    acceptedAt: today(),
    acceptedBy: '值班管理员',
  }
  store.repair.repairAcceptances = [...store.repair.repairAcceptances, acceptance]

  return { belt, acceptance, batch }
}

/** 归档 + 复查项 + 批次收口（隔离带恢复）拆成独立步骤，便于在任一环节注入中断。 */
function prepareArchive(store: Store, belt: EntryRow, acceptance: AcceptanceRecord): void {
  if (store.repair.repairArchive.some((entry) => entry.beltId === belt.id)) {
    return // 幂等：重试时不重复归档
  }
  const entry: ArchiveEntry = {
    id: nextId(store.repair.repairArchive),
    beltId: belt.id,
    beltCode: beltCode(belt),
    beltName: String(belt['林带名称'] ?? ''),
    forestArea: beltArea(belt),
    // 历史记录保留原种植年份：验收归档只追加，不改写林带主表的「种植年份」。
    originalPlantYear: String(belt['种植年份'] ?? ''),
    replantYear: acceptance.acceptedAt.slice(0, 4),
    batchId: acceptance.batchId,
    acceptedAt: acceptance.acceptedAt,
    acceptedBy: acceptance.acceptedBy,
  }
  store.repair.repairArchive = [...store.repair.repairArchive, entry]
}

function prepareReview(store: Store, belt: EntryRow, acceptance: AcceptanceRecord): void {
  if (store.repair.patrolReviews.some((item) => item.acceptanceId === acceptance.id)) {
    return
  }
  store.repair.patrolReviews = [...store.repair.patrolReviews, makeReview(store, belt, acceptance.id)]
}

/** 批次收口：批次内林带全部验收后关闭批次，并把关联隔离带恢复正常。 */
function prepareBatchSettlement(store: Store): void {
  const acceptedBeltIds = new Set(
    store.repair.repairAcceptances.filter((item) => item.status === '已验收').map((item) => item.beltId),
  )
  for (const batch of store.repair.repairBatches) {
    if (batch.kind !== '补植' || batch.status !== '待验收') {
      continue
    }
    const waiting = batch.beltIds.filter((beltId) => !acceptedBeltIds.has(beltId))
    if (waiting.length > 0) {
      continue
    }
    store.repair.repairBatches = store.repair.repairBatches.map((item) =>
      item.id === batch.id ? { ...item, status: '已完成' as BatchStatus, completedAt: today() } : item,
    )
    // 关联隔离带恢复正常（最近维护日期同步更新）。
    store.rows[BREAK_KEY] = (store.rows[BREAK_KEY] ?? []).map((brk) =>
      batch.breakIds.includes(brk.id) && BREAK_RANK[String(brk.status)] <= BREAK_RANK['需补植']
        ? {
            ...brk,
            status: '正常',
            pending: false,
            abnormal: false,
            最近维护日期: today(),
            维护状态: '正常',
          }
        : brk,
    )
  }
}

function commitOrThrowStorage(store: Store, fault: FaultSpec | undefined, beltCodeValue: string): void {
  if (fault?.stage === 'storage') {
    throw new Error(
      `${beltCodeValue} 验收持久化失败：本地存储写入被拒绝（模拟），林带、维护批次、归档台账已整体回退`,
    )
  }
  try {
    commit(store)
  } catch (error) {
    throw new Error(
      `${beltCodeValue} 验收落库中断：${error instanceof Error ? error.message : '本地存储写入失败'}；林带、维护批次、归档台账未做任何改动，可直接重试`,
    )
  }
}

/** 单条林带「确认补植」。并发重复提交只落一次；任一环节失败整笔回退。 */
export async function acceptReplant(
  beltId: number,
  options: { fault?: FaultSpec } = {},
): Promise<AcceptResult> {
  const lockKey = `belt:${beltId}`
  if (inFlight.has(lockKey)) {
    return {
      ok: false,
      message: '该林带正在验收中，并发提交已拦截：验收记录只会落一次，请勿重复点击',
      interrupted: false,
    }
  }
  inFlight.add(lockKey)
  try {
    // 先取一次最新状态做幂等判定（另一个并发请求可能已落库）。
    const fresh = readRepairState()
    const belt = fresh.belts.find((item) => item.id === beltId)
    if (!belt) {
      return { ok: false, message: `缺失林带：编号 ${beltId} 不存在，请从补植列表重新选择`, interrupted: true }
    }
    if (latestAcceptance(fresh, beltId)?.status === '已验收') {
      return { ok: false, message: `${beltCode(belt)} 已验收通过，验收记录只落一次` }
    }
    await sleep(180) // 放大并发窗口：重复点击会被上面的在途锁拦住。
    const store = snapshot()
    try {
      const prepared = prepareBeltAcceptance(store, beltId)
      if (options.fault?.stage === 'accept') {
        throw new Error(
          `${beltCode(prepared.belt)} 验收记录写入中断（模拟故障），林带、维护批次、归档均未改动，请重试`,
        )
      }
      prepareArchive(store, prepared.belt, prepared.acceptance)
      if (options.fault?.stage === 'archive') {
        throw new Error(
          `${beltCode(prepared.belt)} 归档台账写入中断（模拟故障），本笔验收已整体回退，请从该林带重试`,
        )
      }
      prepareReview(store, prepared.belt, prepared.acceptance)
      prepareBatchSettlement(store)
      commitOrThrowStorage(store, options.fault, beltCode(prepared.belt))
      return {
        ok: true,
        message: `${beltCode(prepared.belt)} 补植验收通过：缺株标记已清除，归档保留原种植年份 ${prepared.belt['种植年份']}，巡护复查项已同步生成`,
        acceptedBeltIds: [beltId],
      }
    } catch (error) {
      // 未 commit，快照副本直接丢弃——林带、批次、归档、复查项一起回退。
      return {
        ok: false,
        message: error instanceof Error ? error.message : '验收中断，数据已整体回退，可重试',
        resumeFromBeltId: beltId,
        interrupted: true,
      }
    }
  } finally {
    inFlight.delete(lockKey)
  }
}

/**
 * 批次验收：逐林带落库，已验收的自动跳过（幂等恢复点）。
 * 任一林带失败：该林带整笔回退，前面已成功的保留，返回缺失林带 id，可直接重试。
 */
export async function acceptBatch(
  batchId: number,
  options: { fault?: FaultSpec } = {},
): Promise<AcceptResult> {
  const lockKey = `batch:${batchId}`
  if (inFlight.has(lockKey)) {
    return {
      ok: false,
      message: '该维护批次正在验收中，并发提交已拦截：验收记录只会落一次',
      interrupted: false,
    }
  }
  inFlight.add(lockKey)
  try {
    const accepted: number[] = []
    const blocked: number[] = []
    let ordinal = 0
    // 每轮重新读状态：失败重试时已落库的林带天然跳过，即「从缺失林带继续」。
    for (;;) {
      const state = readRepairState()
      const batch = state.batches.find((item) => item.id === batchId)
      if (!batch) {
        return { ok: false, message: `维护批次 ${batchId} 不存在，请刷新后重试`, interrupted: true }
      }
      if (batch.status === '已完成') {
        return {
          ok: accepted.length > 0,
          message:
            accepted.length > 0
              ? `批次 ${batch.batchNo} 剩余林带此前已验收，批次已完成`
              : `批次 ${batch.batchNo} 已完成，验收记录只落一次`,
          acceptedBeltIds: accepted,
        }
      }
      const target = batch.beltIds.find((beltId) => {
        const belt = state.belts.find((item) => item.id === beltId)
        if (!belt) {
          return false
        }
        if (latestAcceptance(state, beltId)?.status === '已验收') {
          return false
        }
        return true
      })
      if (target === undefined) {
        break // 全部有验收结论（成功或已在此前各轮处理）
      }
      const targetBelt = state.belts.find((item) => item.id === target)!
      if (effectiveBeltStatus(state, targetBelt.id) === '已退化') {
        blocked.push(target)
        // 退化林带不接受验收；从批次中摘除，避免永远卡住，批次仍按其余林带收口。
        const store = snapshot()
        store.repair.repairBatches = store.repair.repairBatches.map((item) =>
          item.id === batchId
            ? { ...item, beltIds: item.beltIds.filter((id) => id !== target) }
            : item,
        )
        commit(store)
        continue
      }
      ordinal += 1
      const fault =
        options.fault && (options.fault.beltOrdinal ?? 1) === ordinal ? options.fault : undefined
      const result = await acceptReplant(target, { fault })
      if (!result.ok) {
        return {
          ok: false,
          message: `批次验收在 ${beltCode(targetBelt)} 处中断：${result.message}`,
          resumeFromBeltId: target,
          acceptedBeltIds: accepted,
          blockedBeltIds: blocked,
          interrupted: true,
        }
      }
      accepted.push(target)
    }

    // 再读一次：若还有退化被摘除的残留空批次，prepareBatchSettlement 已在每条验收时收口。
    const finalState = readRepairState()
    const finalBatch = finalState.batches.find((item) => item.id === batchId)
    if (blocked.length > 0 && finalBatch && finalBatch.status !== '已完成') {
      const codes = blocked
        .map((id) => {
          const belt = finalState.belts.find((item) => item.id === id)
          return belt ? beltCode(belt) : `编号${id}`
        })
        .join('、')
      return {
        ok: accepted.length > 0,
        message: `已验收 ${accepted.length} 条；退化林带 ${codes} 不能验收并已从批次摘除，处理退化林带后重新收口批次`,
        acceptedBeltIds: accepted,
        blockedBeltIds: blocked,
      }
    }
    return {
      ok: true,
      message: `维护批次 ${finalBatch?.batchNo ?? batchId} 全部验收通过，隔离带已恢复正常，归档与巡护复查项已同步`,
      acceptedBeltIds: accepted,
      blockedBeltIds: blocked,
    }
  } finally {
    inFlight.delete(lockKey)
  }
}

/** 巡护任务清单同步展示的复查项（别的模块读取）。 */
export function patrolReviewRows(): PatrolReviewItem[] {
  return listReviewViews()
}

/** 巡护员完成一条复查项（复查流程独立，同样只允许 待复查 → 已复查）。 */
export function completeReview(reviewId: number): SimpleResult {
  const store = snapshot()
  const item = store.repair.patrolReviews.find((review) => review.id === reviewId)
  if (!item) {
    return { ok: false, message: `复查项 ${reviewId} 不存在` }
  }
  if (item.status === '已复查') {
    return { ok: false, message: `${item.reviewNo} 已复查，不能重复提交` }
  }
  store.repair.patrolReviews = store.repair.patrolReviews.map((review) =>
    review.id === reviewId ? { ...review, status: '已复查' } : review,
  )
  commit(store)
  return { ok: true, message: `${item.reviewNo} 复查结果已登记` }
}

/** 演示用：林带、隔离带、补植四表一起回到种子数据。 */
export function resetRepairDomain(): SimpleResult {
  try {
    resetRepairStore()
    // 巡护主表若被通用页面改动过，一并回到种子，保证复查项联动演示可重复。
    saveRows(PATROL_KEY, JSON.parse(JSON.stringify(SEED_ROWS[PATROL_KEY] ?? [])))
    return { ok: true, message: '林带、隔离带、维护批次、验收与归档台账已重置为演示数据' }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '重置失败' }
  }
}
