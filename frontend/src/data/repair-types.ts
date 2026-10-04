/**
 * 防火林带补植 / 防火隔离带维护共用域模型。
 *
 * 三个页面（补植列表 firebelt、隔离带维护面板 firebreak、归档台账 repair-archive）
 * 都走同一条取数路径 readRepairState()：先取林带/隔离带主表，再叠加验收记录、
 * 维护批次、归档台账。任何一处状态对不上，都以「验收记录」为准。
 */

import type { EntryRow } from './types'

/** 林带主表状态（与 modules.ts 中 firebelt 的状态集保持一致）。 */
export const BELT_STATUSES = ['完好', '有缺株', '需补植', '已退化'] as const
export type BeltStatus = (typeof BELT_STATUSES)[number]

/** 隔离带主表状态（与 modules.ts 中 firebreak 的状态集保持一致）。 */
export const BREAK_STATUSES = ['正常', '需割草', '需补植', '已荒废'] as const
export type BreakStatus = (typeof BREAK_STATUSES)[number]

/** 维护批次 / 验收记录 / 复查项的生命周期，只能向前推进。 */
export const BATCH_STATUSES = ['待验收', '已完成'] as const
export type BatchStatus = (typeof BATCH_STATUSES)[number]

export const ACCEPT_STATUSES = ['待验收', '已验收'] as const
export type AcceptStatus = (typeof ACCEPT_STATUSES)[number]

export const REVIEW_STATUSES = ['待复查', '已复查'] as const
export type ReviewStatus = (typeof REVIEW_STATUSES)[number]

/**
 * 补植验收记录：补植流程的权威来源。
 * 冲突时林带主表、隔离带面板、归档台账都以它为准。
 */
export type AcceptanceRecord = {
  id: number
  beltId: number
  batchId: number
  /** 验收前林带主表状态，便于审计；实际展示状态以本记录结论为准。 */
  beforeStatus: string
  /** 验收结论：已验收后林带即视为「完好」，缺株标记随之消失。 */
  status: AcceptStatus
  acceptedAt: string
  acceptedBy: string
}

/**
 * 隔离带维护批次：一次「安排维护 / 安排补植」生成一批，覆盖同林区需要处理的对象。
 */
export type MaintenanceBatch = {
  id: number
  batchNo: string
  forestArea: string
  /** 维护类型：割草（隔离带自身植被恢复）或补植（依托林带补植）。 */
  kind: '割草' | '补植'
  createdAt: string
  status: BatchStatus
  /** 补植类批次绑定的林带 id；割草类批次只动隔离带主表。 */
  beltIds: number[]
  /** 关联的隔离带 id。 */
  breakIds: number[]
  completedAt: string
}

/**
 * 归档台账条目：补植验收通过后落入历史。
 * originalPlantYear 固定记录林带「最初种植年份」，补植不改写历史。
 */
export type ArchiveEntry = {
  id: number
  beltId: number
  beltCode: string
  beltName: string
  forestArea: string
  originalPlantYear: string
  replantYear: string
  batchId: number
  acceptedAt: string
  acceptedBy: string
}

/** 随补植验收同步生成的巡护复查项（落在巡护任务清单里）。 */
export type PatrolReviewItem = {
  id: number
  beltId: number
  acceptanceId: number
  reviewNo: string
  area: string
  reviewer: string
  reviewDate: string
  note: string
  status: ReviewStatus
}

/** readRepairState 的一次完整快照，三个页面共用。 */
export type RepairState = {
  belts: EntryRow[]
  breaks: EntryRow[]
  acceptances: AcceptanceRecord[]
  batches: MaintenanceBatch[]
  archive: ArchiveEntry[]
  reviews: PatrolReviewItem[]
}

/** 验收动作返回结构：成功时带说明，失败时带可重试的林带 id 和原因。 */
export type AcceptResult = {
  ok: boolean
  message: string
  /** 失败时从哪条林带继续重试（尚未落验收记录的第一条）。 */
  resumeFromBeltId?: number
  acceptedBeltIds?: number[]
  blockedBeltIds?: number[]
  interrupted?: boolean
}
