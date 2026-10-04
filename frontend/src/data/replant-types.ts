/**
 * 防火林带 / 防火隔离带共用的补植业务域类型。
 *
 * 状态口径：补植列表、隔离带维护面板、归档台账都从同一份业务域数据取数，
 * 避免各自读各表导致「确认补植后缺株标记不消失 / 退化林带被重复安排 / 种植年份丢失」。
 */

import type { ActionResult, EntryRow } from './types'

/** 补植对象来源：防火林带或防火隔离带，二者共用一条取数与验收路径。 */
export type BeltSource = 'firebelt' | 'firebreak'

/** 维护批次类型：补植批次走补植列表→验收→归档；割草批次只在隔离带维护面板登记。 */
export type BatchType = 'replant' | 'mowing'

/** 批次流转方向不可回退：待验收 → 已验收（归档）/ 已中断（记录中断原因）。 */
export type MaintenanceBatchStatus = '待验收' | '已验收' | '已中断'

/** 验收结论：合格才会把林带恢复为完好并清掉缺株标记；不合格继续留在补植列表。 */
export type AcceptanceVerdict = '合格' | '不合格'

/** 复查项状态：验收合格后同步生成给巡护任务清单，等待现场复查。 */
export type RecheckStatus = '待复查' | '已完成'

/** 维护批次：一次「安排补植」生成一个批次，批次内是本次要补植的林带。 */
export type MaintenanceBatch = {
  id: number
  batchNo: string
  type: BatchType
  status: MaintenanceBatchStatus
  /** 批次里的林带在各自模块中的行编号，验收时按此回写。 */
  beltIds: number[]
  /** 安排时间（ISO），也是批次进入取数路径的时间。 */
  scheduledAt: string
  /** 验收时间（ISO）；中断时为中断时间。 */
  finishedAt: string
  /** 最近一次验收/重试失败的原因，用于「中断异常要说明原因」。 */
  interruptedReason: string
}

/** 补植批次与林带的关联明细，承载原种植年份快照（历史记录不被覆盖）。 */
export type ReplantItem = {
  batchId: number
  source: BeltSource
  beltId: number
  /** 林带/隔离带编号，取冗余快照，原行被删时台账仍可读。 */
  beltNo: string
  /** 安排补植那一刻的原种植年份，验收、归档都不再改写它。 */
  originalPlantYear: string
  /** 补植做法，安排时定下来；默认人工穴植同龄壮苗。 */
  practice: string
  scheduledAt: string
}

/** 验收记录：冲突时以验收记录为准（缺株标记、林带状态都按最新验收结论投影）。 */
export type AcceptanceRecord = {
  id: number
  batchId: number
  source: BeltSource
  beltId: number
  verdict: AcceptanceVerdict
  acceptedAt: string
  operator: string
  /** 补植年份：验收当年新增植株的年份，与原种植年份分开保存。 */
  replantYear: number
  note: string
}

/** 归档台账行：验收合格后落账，原种植年份与补植年份并列保留。 */
export type ArchiveEntry = {
  id: number
  batchId: number
  acceptanceId: number
  source: BeltSource
  beltId: number
  beltNo: string
  originalPlantYear: string
  replantYear: number
  practice: string
  archivedAt: string
}

/** 巡护复查项：验收合格后同步生成到巡护任务清单。 */
export type RecheckItem = {
  id: number
  batchId: number
  source: BeltSource
  beltId: number
  beltNo: string
  title: string
  dueAt: string
  createdAt: string
  status: RecheckStatus
  completedAt: string
}

/** 业务域持久化切片，整体随 entries 一起提交，保证跨模块同事务。 */
export type ReplantState = {
  seqBatch: number
  seqAcceptance: number
  seqArchive: number
  seqRecheck: number
  batches: MaintenanceBatch[]
  items: ReplantItem[]
  acceptances: AcceptanceRecord[]
  archives: ArchiveEntry[]
  rechecks: RecheckItem[]
}

/** 补植列表行：三端共用的取数结果。 */
export type ReplantQueueRow = {
  key: string
  source: BeltSource
  sourceLabel: string
  beltId: number
  beltNo: string
  batchId: number
  batchNo: string
  originalPlantYear: string
  practice: string
  scheduledAt: string
  interruptedReason: string
}

/** 隔离带维护面板行：补植 + 割草批次都在这里。 */
export type MaintenancePanelRow = {
  batchId: number
  batchNo: string
  type: BatchType
  typeLabel: string
  status: MaintenanceBatchStatus
  beltCount: number
  beltNos: string[]
  scheduledAt: string
  finishedAt: string
  interruptedReason: string
}

/** 投影后的林带行：取数路径以验收记录为准覆盖各模块表内的旧状态。 */
export type ProjectedEntry = EntryRow & {
  /** 最新验收结论投影出来的状态是否与原行不一致（true 即原先的错位被纠正）。 */
  projected: boolean
}

/** 补植批量验收结果：整批一个事务，任一林带失败整批回退。 */
export type BatchAcceptanceResult = ActionResult & {
  batchId?: number
  /** 本次实际落库的验收记录数；并发重复调用时为 0，保证只落一次。 */
  accepted: number
  archived: number
  rechecks: number
  /** 失败定位到具体缺失林带时给出，方便「从缺失林带重试」。 */
  missing?: { source: BeltSource; beltId: number }
}

/** 默认补植做法：安排补植时未指定则采用人工穴植同龄壮苗。 */
export const DEFAULT_REPLANT_PRACTICE = '人工穴植同龄壮苗'
