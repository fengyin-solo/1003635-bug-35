import { REPAIR_SEED, SEED_ROWS } from './seed'
import type { AcceptanceRecord, ArchiveEntry, MaintenanceBatch, PatrolReviewItem } from './repair-types'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'forest-fire-patrol:entries'
// 补植域四张结构化表与通用主表共用一个存储 key，保证一次写入原子生效。
const STORE_VERSION = 2

export type RepairCollections = {
  repairAcceptances: AcceptanceRecord[]
  repairBatches: MaintenanceBatch[]
  repairArchive: ArchiveEntry[]
  patrolReviews: PatrolReviewItem[]
}

export type DataStore = {
  version: number
  rows: Record<string, EntryRow[]>
  repair: RepairCollections
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function buildFallback(): DataStore {
  return {
    version: STORE_VERSION,
    rows: clone(SEED_ROWS),
    repair: clone(REPAIR_SEED),
  }
}

// 兼容旧版本：localStorage 里若是裸的 Record<string, EntryRow[]>，读出来补上新表。
function normalize(parsed: unknown): DataStore | null {
  if (!parsed || typeof parsed !== 'object') {
    return null
  }
  const candidate = parsed as Partial<DataStore>
  if (candidate.rows && candidate.repair) {
    return {
      version: STORE_VERSION,
      rows: candidate.rows as Record<string, EntryRow[]>,
      repair: { ...clone(REPAIR_SEED), ...(candidate.repair as Partial<RepairCollections>) },
    }
  }
  // 旧版扁平结构：整包当作 rows。
  const fallback = buildFallback()
  return { ...fallback, rows: clone({ ...fallback.rows, ...(parsed as Record<string, EntryRow[]>) }) }
}

function readStorage(): DataStore {
  const fallback = buildFallback()
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    return normalize(JSON.parse(raw)) ?? fallback
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: DataStore | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache.rows
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const store = snapshot()
  store.rows[key] = rows
  commit(store)
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

/** 读整库快照（深拷贝，调用方在副本上改，改完用 commit 一次性落库）。 */
export function snapshot(): DataStore {
  if (cache === null) {
    cache = readStorage()
  }
  return clone(cache)
}

/**
 * 原子提交：一次 localStorage.setItem 落整库。
 * 写入抛错（配额、存储被禁等）时内存缓存不动，等同于整笔回退。
 */
export function commit(next: DataStore): void {
  const payload = JSON.stringify(next)
  if (typeof window !== 'undefined' && window.localStorage) {
    // 先序列化、再写：序列化失败不会触碰任何状态。
    window.localStorage.setItem(STORAGE_KEY, payload)
  }
  // 持久化成功后才换内存缓存，保证林带、维护批次、归档看到的是同一版本。
  cache = next
}

/** 补植域四张表的实时数据。 */
export function repairCollections(): RepairCollections {
  if (cache === null) {
    cache = readStorage()
  }
  return cache.repair
}

/** 林带、隔离带、补植域整体重置回种子数据，便于反复演示。 */
export function resetRepairStore(): DataStore {
  const fallback = buildFallback()
  commit(fallback)
  return fallback
}

export function storageKey(): string {
  return STORAGE_KEY
}
