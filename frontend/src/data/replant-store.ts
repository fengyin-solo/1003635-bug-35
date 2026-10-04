/**
 * 补植业务域存储：维护批次、补植明细、验收记录、归档台账、巡护复查项。
 *
 * 与通用 entries 存储分切片保存，但提交走同一个事务：
 * 林带（firebelt/firebreak 行）、维护批次、归档台账三段任一写入失败，整组回滚到事务前快照。
 */

import { SEED_REPLANT_STATE } from './replant-seed'
import { allRows, replaceAllEntries } from './local-store'
import type { EntryRow } from './types'
import type { ReplantState } from './replant-types'

const REPLANT_KEY = 'forest-fire-patrol:replant'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readPersisted(): ReplantState | null {
  if (typeof window === 'undefined' || !window.localStorage) {
    return null
  }
  const raw = window.localStorage.getItem(REPLANT_KEY)
  if (!raw) {
    return null
  }
  try {
    return JSON.parse(raw) as ReplantState
  } catch {
    return null
  }
}

let cache: ReplantState | null = null

export function replantState(): ReplantState {
  if (cache === null) {
    cache = readPersisted() ?? clone(SEED_REPLANT_STATE)
  }
  return cache
}

function persist(state: ReplantState): void {
  cache = state
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(REPLANT_KEY, JSON.stringify(state))
  }
}

export function resetReplantState(): ReplantState {
  const fresh = clone(SEED_REPLANT_STATE)
  persist(fresh)
  return fresh
}

/** 事务提交失败：携带失败环节，调用方据此提示并保证快照已回退。 */
export class CommitError extends Error {
  constructor(public readonly stage: string, cause: unknown) {
    super(`补植流程在「${stage}」环节提交失败：${cause instanceof Error ? cause.message : String(cause)}`)
    this.name = 'CommitError'
  }
}

/**
 * 测试/故障演练用的注入点：让指定提交环节抛出，验证三段一起回退。
 * stage 为 '林带' | '维护批次' | '归档台账'；null 表示不注入。
 */
let commitFault: string | null = null
export function __setCommitFault(stage: string | null): void {
  commitFault = stage
}

/** 提交一个原子变更：拿到 entries 与业务域两份草稿，mutator 在草稿上改，返回业务结果。 */
export function runReplantTransaction<T>(
  mutator: (draft: { entries: Record<string, EntryRow[]>; replant: ReplantState }) => T,
): T {
  const baseEntries = allRows()
  const baseReplant = replantState()

  const entriesDraft = clone(baseEntries)
  const replantDraft = clone(baseReplant)

  let result: T
  try {
    result = mutator({ entries: entriesDraft, replant: replantDraft})
  } catch (error) {
    // 业务校验阶段抛出（如缺失林带）：什么都没落库，直接交回调用方处理。
    throw error
  }

  // 提交分三环节落盘：林带 → 维护批次（含验收/复查）→ 归档台账。任一失败整体回滚。
  const rollback = (failedStage: string, cause: unknown): never => {
    try {
      replaceAllEntries(baseEntries)
      persist(baseReplant)
    } catch (rollbackCause) {
      throw new CommitError(
        failedStage,
        new Error(
          `${cause instanceof Error ? cause.message : String(cause)}；回滚也失败：${
            rollbackCause instanceof Error ? rollbackCause.message : String(rollbackCause)
          }`,
        ),
      )
    }
    throw new CommitError(failedStage, cause)
  }

  try {
    if (commitFault === '林带') {
      throw new Error('模拟林带写入失败')
    }
    replaceAllEntries(entriesDraft)
  } catch (error) {
    rollback('林带', error)
  }

  try {
    if (commitFault === '维护批次') {
      throw new Error('模拟维护批次写入失败')
    }
    persist(replantDraft)
  } catch (error) {
    rollback('维护批次', error)
  }

  try {
    if (commitFault === '归档台账') {
      throw new Error('模拟归档台账写入失败')
    }
    // 归档行与批次/验收/复查同在业务域切片中，上一环节 persist 成功即代表台账随事务落库；
    // 这里只做内存一致性确认，避免同一事务里重复读写存储。
    if (cache === null || cache.archives.length !== replantDraft.archives.length) {
      throw new Error('归档台账未随事务生效')
    }
  } catch (error) {
    rollback('归档台账', error)
  }

  return result
}

/**
 * 只更新业务域切片（用于记录中断原因这类不允许联动林带的轻量写入）。
 * 仍走「先草稿后落盘」，避免半截状态。
 */
export function patchReplantState<T>(mutator: (state: ReplantState) => T): T {
  const base = replantState()
  const draft = clone(base)
  const result = mutator(draft)
  persist(draft)
  return result
}
