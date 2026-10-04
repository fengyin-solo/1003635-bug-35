/**
 * 补植业务域端到端测试（node 直跑，esbuild 打包后执行）。
 * 覆盖：三处状态错位修复、取数口径、历史年份、流程不可回退、
 * 并发幂等、缺失林带重试、三环节失败整体回退、巡护复查同步、空态/中断原因。
 */

// ---- 浏览器垫片：必须在导入被测模块前就位（顶层只读 window/localStorage）----
class MemoryStorage {
  private map = new Map<string, string>()
  private failOnKey: string | null = null
  /** 测试钩子：每次 setItem 时同步触发（用于模拟在途并发）。 */
  public onSet: ((key: string) => void) | null = null
  get length() {
    return this.map.size
  }
  setFailOnKey(key: string | null) {
    this.failOnKey = key
  }
  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null
  }
  setItem(key: string, value: string): void {
    if (key === this.failOnKey) {
      throw new Error(`存储写入失败（注入：${key}）`)
    }
    this.map.set(key, value)
    this.onSet?.(key)
  }
  removeItem(key: string): void {
    this.map.delete(key)
  }
  clear(): void {
    this.map.clear()
  }
}

const storage = new MemoryStorage()
;(globalThis as any).window = { localStorage: storage }
;(globalThis as any).localStorage = storage

import {
  SEED_REPLANT_STATE,
} from '../src/data/replant-seed'
import { __setCommitFault, resetReplantState, runReplantTransaction } from '../src/data/replant-store'
import {
  acceptReplantBatch,
  allowedRowActions,
  archiveLedger,
  arrangeReplant,
  completeRecheck,
  confirmRecovered,
  extractPlantYear,
  maintenancePanel,
  markDegraded,
  projectEntries,
  recheckList,
  replantQueue,
  runBeltAction,
} from '../src/data/replant-service'
import { listEntries, rowActionsFor, runAction } from '../src/api/local-service'
import { resetRows } from '../src/data/local-store'

let passed = 0
let failed = 0

function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function resetAll() {
  resetRows('firebelt')
  resetRows('firebreak')
  resetReplantState()
}

function beltStatus(source: 'firebelt' | 'firebreak', id: number): string {
  const row = projectEntries(source).find((item) => item.id === id)
  return String(row?.status)
}

function findBatch(id: number) {
  return maintenancePanel().find((item) => item.batchId === id)
}

function openBatch(source: 'firebelt' | 'firebreak', beltId: number) {
  return replantQueue().find((row) => row.source === source && row.beltId === beltId)
}

// 1. 种子投影：firebelt#2 行内是「有缺株」，但 2025 年已合格验收 → 取数以验收记录为准
function testProjectionWins() {
  resetAll()
  const row2 = projectEntries('firebelt').find((item) => item.id === 2)
  check('验收记录优先：firebelt#2 投影为完好', row2?.status === '完好', `实际：${row2?.status}`)
  check('确认补植后缺株标记消失：pending=false', row2?.pending === false)
  check('确认补植后缺株标记消失：abnormal=false', row2?.abnormal === false)
  check('投影行带 projected 标记', row2?.projected === true)
  const payload = listEntries('firebelt')
  const viaApi = payload.items.find((item) => item.id === 2)
  check('通用取数入口同样投影', viaApi?.status === '完好', `实际：${viaApi?.status}`)
}

// 2. 历史种植年份：安排时快照，验收与归档都不改林带行的种植年份
function testHistoryYearKept() {
  resetAll()
  const queueBefore = replantQueue().find((row) => row.source === 'firebreak' && row.beltId === 3)
  check('队列项携带原种植年份 2020', queueBefore?.originalPlantYear === '2020')
  const result = acceptReplantBatch(queueBefore!.batchId)
  check('firebreak#3 验收成功', result.ok, result.message)
  const archive = archiveLedger().find(
    (row) => row.source === 'firebreak' && row.beltId === 3,
  )
  check('台账保留原种植年份 2020', archive?.originalPlantYear === '2020')
  check('台账补植年份为验收年 2026', archive?.replantYear === 2026)
  const row3 = projectEntries('firebreak').find((item) => item.id === 3)
  check('隔离带建成日期（历史年份来源）未被改写', String(row3?.['建成日期']) === '2020-06-03')
  const fb1Archive = archiveLedger().find((row) => row.batchId === 6)
  check('2015 历史台账原种植年份仍为 2015', fb1Archive?.originalPlantYear === '2015')
}

// 3. 退化林带不能被重复安排；终态无任何前进动作
function testDegradedCannotReschedule() {
  resetAll()
  const degrade = markDegraded('firebelt', 1)
  check('完好林带允许标记退化', degrade.ok, degrade.message)
  check('退化后状态为已退化', beltStatus('firebelt', 1) === '已退化')
  const again = arrangeReplant('firebelt', 1)
  check('退化林带安排补植被拒', !again.ok && again.message.includes('终态'), again.message)
  const viaAction = runAction('firebelt', 1, '安排补植')
  check('通用动作入口同样拒绝', !viaAction.ok, viaAction.message)
  check('终态行无可执行动作', allowedRowActions('firebelt', '已退化').length === 0)
  check('行级白名单接口一致', rowActionsFor('firebelt', '已退化').length === 0)
  // 待验收补植中的林带也不允许标记退化（重置回种子：firebelt#3 在批次 BZ-2026-002 中）
  resetAll()
  const degrade3 = markDegraded('firebelt', 3)
  check('待验收补植林带禁止标记退化', !degrade3.ok, degrade3.message)
}

// 4. 流程不可反向推进
function testNoBackwardFlow() {
  resetAll()
  // 需补植不能再安排补植
  const dup = runBeltAction('firebelt', 3, '安排补植')
  check('需补植行重复安排被拒', !dup.ok, dup.message)
  // 非需割草不能确认恢复
  const recover = runBeltAction('firebreak', 1, '确认恢复')
  check('正常隔离带不能确认恢复（反向）', !recover.ok, recover.message)
  // 完好行没有确认补植入口
  const confirmHealthy = runBeltAction('firebelt', 1, '确认补植')
  check('完好林带无补植批次时确认补植被拒', !confirmHealthy.ok, confirmHealthy.message)
  // 正常流转前进：firebelt#2 投影完好且无待验收批次 → 安排补植 → 需补植 → 确认补植 → 完好
  const a = arrangeReplant('firebelt', 2)
  check('完好→安排补植通过', a.ok, a.message)
  check('安排后为需补植（新补植优先于历史验收）', beltStatus('firebelt', 2) === '需补植', beltStatus('firebelt', 2))
  const q = openBatch('firebelt', 2)!
  const c = acceptReplantBatch(q.batchId)
  check('需补植→确认补植（验收）通过', c.ok && c.accepted === 1, c.message)
  check('验收后回到完好', beltStatus('firebelt', 2) === '完好')
  check('验收后队列不再含该林带', !openBatch('firebelt', 2))
  // 割草维护：正常 → 需割草 → 正常，批次同步关闭
  const m = runBeltAction('firebreak', 1, '安排维护')
  check('隔离带安排割草通过', m.ok, m.message)
  check('隔离带变为需割草', beltStatus('firebreak', 1) === '需割草')
  const r = confirmRecovered(1)
  check('确认恢复通过', r.ok, r.message)
  check('恢复后为正常', beltStatus('firebreak', 1) === '正常')
}

// 5. 并发验收只落一次
function testConcurrentAcceptOnce() {
  resetAll()
  const batchId = 5 // seed：firebreak#3
  const before = archiveLedger().length

  // 已验收批次重复提交：幂等返回，计数为 0
  const firstOnce = acceptReplantBatch(batchId)
  check('首次验收成功', firstOnce.ok, firstOnce.message)
  check('首次验收恰好落 1 条验收/归档/复查', firstOnce.accepted === 1 && firstOnce.archived === 1 && firstOnce.rechecks === 1)
  const dup = acceptReplantBatch(batchId)
  check('重复验收幂等：ok 且 accepted=0', dup.ok && dup.accepted === 0, dup.message)
  check('重复验收幂等：archived/rechecks=0', dup.archived === 0 && dup.rechecks === 0)
  check('归档总数只增加 1', archiveLedger().length === before + 1)

  // 在途并发：第一次验收提交期间（in-flight 锁持有中）并发发起第二次，
  // 第二次必须被挡住且不落库；第一次正常成功。
  resetAll()
  type AcceptResult = ReturnType<typeof acceptReplantBatch>
  const concurrent: { value: AcceptResult | null } = { value: null }
  let nestedFired = false
  ;(storage as any).onSet = () => {
    if (!nestedFired) {
      nestedFired = true
      // 第一次仍在提交栈内：此时同批次并发调用
      concurrent.value = acceptReplantBatch(batchId)
    }
  }
  const first = acceptReplantBatch(batchId)
  ;(storage as any).onSet = null
  const nestedResult = concurrent.value
  check('在途并发嵌套调用确实触发', nestedFired)
  check('在途并发调用被拒绝', nestedFired && nestedResult !== null && !nestedResult.ok, nestedResult?.message ?? '未触发')
  check('在途并发提示只落一次', Boolean(nestedResult?.message.includes('只落一次')), nestedResult?.message)
  check('首次验收仍成功', first.ok && first.accepted === 1, first.message)
  check('在途并发未额外落库', archiveLedger().filter((r) => r.batchId === batchId).length === 1)
  // 事后再点一次仍是幂等口径
  const after = acceptReplantBatch(batchId)
  check('窗口结束后的重复提交幂等', after.ok && after.accepted === 0, after.message)
}

// 6. 缺失林带：预检不落库；恢复后从缺失林带重试成功
function testMissingBeltRetry() {
  resetAll()
  const batchId = 2 // seed：firebelt#3，种子自带一次中断原因
  // 先人为删掉 firebelt#3
  runReplantTransaction(({ entries }) => {
    entries.firebelt = entries.firebelt.filter((row) => Number(row.id) !== 3)
  })
  const fail = acceptReplantBatch(batchId)
  check('缺失林带验收失败', !fail.ok, fail.message)
  check('失败结果定位缺失林带', fail.missing?.source === 'firebelt' && fail.missing.beltId === 3)
  check('失败消息说明原因并提示从缺失林带重试', fail.message.includes('缺失') && fail.message.includes('重试'))
  check('失败时未生成复查项', !recheckList().some((row) => row.batchId === batchId))
  check('失败时未写归档', !archiveLedger().some((row) => row.batchId === batchId))
  check('失败批次仍在补植列表（可重试）', Boolean(openBatch('firebelt', 3)))
  check('中断原因写入批次', (findBatch(batchId)?.interruptedReason ?? '').length > 0)
  // 恢复缺失林带后重试
  runReplantTransaction(({ entries }) => {
    entries.firebelt.push({
      id: 3,
      status: '需补植',
      pending: true,
      abnormal: true,
      林带编号: 'FIRE-0003',
      林带名称: '防火林带样例3',
      所属林区: '防火林带样例3',
      树种组成: '防火林带样例3',
      林带长度: '防火林带样例3',
      林带宽度: '防火林带样例3',
      种植年份: '2020',
      林带状态: '防火林带样例3',
    })
  })
  const retry = acceptReplantBatch(batchId)
  check('恢复后从缺失林带重试成功', retry.ok, retry.message)
  check('重试后批次关闭', findBatch(batchId)?.status === '已验收')
  check('重试归档保留原种植年份 2020', archiveLedger().some(
    (row) => row.batchId === batchId && row.originalPlantYear === '2020',
  ))
}

// 7. 三环节任一失败整体回退
function testTransactionRollback() {
  const stages = ['林带', '维护批次', '归档台账'] as const
  for (const stage of stages) {
    resetAll()
    const batchId = 5
    const before = {
      ledger: archiveLedger().length,
      rechecks: recheckList().length,
      queue: replantQueue().length,
      beltStatus: beltStatus('firebreak', 3),
    }
    __setCommitFault(stage)
    const result = acceptReplantBatch(batchId)
    __setCommitFault(null)
    check(`[${stage}]失败时验收返回失败`, !result.ok, result.message)
    check(`[${stage}]失败消息包含环节与回退说明`, result.message.includes(stage))
    check(`[${stage}]归档回退`, archiveLedger().length === before.ledger)
    check(`[${stage}]复查项回退`, recheckList().length === before.rechecks)
    check(`[${stage}]林带状态回退`, beltStatus('firebreak', 3) === before.beltStatus)
    check(`[${stage}]批次保留可重试`, Boolean(openBatch('firebreak', 3)))
    // 立刻重试（无故障）应成功
    const retry = acceptReplantBatch(batchId)
    check(`[${stage}]故障排除后重试成功`, retry.ok, retry.message)
  }
}

// 8. 巡护复查项随验收同步生成，可完成
function testRecheckSync() {
  resetAll()
  const pendingBefore = recheckList().filter((row) => row.status === '待复查').length
  const q = openBatch('firebreak', 3)!
  const result = acceptReplantBatch(q.batchId)
  check('验收返回复查项计数=1', result.rechecks === 1)
  const after = recheckList().filter((row) => row.status === '待复查')
  check('巡护清单新增 1 条待复查', after.length === pendingBefore + 1)
  const item = after.find((row) => row.batchId === q.batchId)!
  check('复查项含林带编号与批次号', item.beltNo === 'FIRE-0003' && item.title.includes('BZ-2026'))
  const done = completeRecheck(item.id)
  check('完成复查通过', done.ok, done.message)
  const doneAgain = completeRecheck(item.id)
  check('重复完成被拒', !doneAgain.ok, doneAgain.message)
}

// 9. 空态：全部验收后补植列表为空
function testEmptyState() {
  resetAll()
  for (const row of replantQueue()) {
    acceptReplantBatch(row.batchId)
  }
  check('无可验收林带时补植列表为空', replantQueue().length === 0)
}

// 10. 隔离带维护面板：割草批次与补植批次同板可见
function testMaintenancePanel() {
  resetAll()
  const panel = maintenancePanel()
  check('面板含割草批次', panel.some((row) => row.type === 'mowing'))
  check('面板含补植批次', panel.some((row) => row.type === 'replant'))
  const mowing = panel.find((row) => row.type === 'mowing' && row.status === '待验收')
  check('割草批次关联隔离带编号', (mowing?.beltNos ?? []).includes('FIRE-0002'))
}

// 11. 补植做法自定义：默认人工穴植同龄壮苗，自定义值进快照
function testPractice() {
  resetAll()
  const result = arrangeReplant('firebelt', 1, '容器苗补植')
  check('自定义做法安排通过', result.ok, result.message)
  const q = openBatch('firebelt', 1)!
  check('队列保留自定义做法', q.practice === '容器苗补植')
  // 归档时做法保留
  acceptReplantBatch(q.batchId)
  check('归档保留做法', archiveLedger().some((row) => row.practice === '容器苗补植'))
  // 默认值
  resetAll()
  arrangeReplant('firebelt', 1)
  const q2 = openBatch('firebelt', 1)!
  check('缺省做法为人工穴植同龄壮苗', q2.practice === '人工穴植同龄壮苗')
}

// 12. 隔离带原种植年份从建成日期提取
function testYearExtract() {
  resetAll()
  const row = listEntries('firebreak').items.find((item) => item.id === 1)!
  check('建成日期提取年份 2015', extractPlantYear('firebreak', row) === '2015')
  const fb = listEntries('firebelt').items.find((item) => item.id === 1)!
  check('林带直接读种植年份 2015', extractPlantYear('firebelt', fb) === '2015')
}

// 13. 已荒废隔离带不能重复安排
function testFirebreakTerminal() {
  resetAll()
  // firebreak#3 在补植批次中：不能荒废；先验收再荒废验证终态
  const blocked = markDegraded('firebreak', 3)
  check('待验收补植隔离带禁止荒废', !blocked.ok, blocked.message)
  acceptReplantBatch(5)
  const mark = markDegraded('firebreak', 3)
  check('验收后允许荒废', mark.ok, mark.message)
  check('荒废后安排维护被拒', !runBeltAction('firebreak', 3, '安排维护').ok)
  check('荒废后安排补植被拒', !runBeltAction('firebreak', 3, '安排补植').ok)
}

const tests: [string, () => void][] = [
  ['取数口径：验收记录优先 + 缺株标记清除', testProjectionWins],
  ['历史：原种植年份保留', testHistoryYearKept],
  ['退化林带不可重复安排', testDegradedCannotReschedule],
  ['流程不可反向推进', testNoBackwardFlow],
  ['并发验收只落一次（幂等）', testConcurrentAcceptOnce],
  ['缺失林带失败与重试', testMissingBeltRetry],
  ['三环节失败整体回退', testTransactionRollback],
  ['巡护复查项同步生成', testRecheckSync],
  ['无可验收林带空态', testEmptyState],
  ['隔离带维护面板', testMaintenancePanel],
  ['补植做法快照', testPractice],
  ['原种植年份提取', testYearExtract],
  ['隔离带荒废终态', testFirebreakTerminal],
]

for (const [name, fn] of tests) {
  console.log(`\n# ${name}`)
  try {
    fn()
  } catch (error) {
    failed += 1
    console.error(`  ✗ 测试抛异常：${error instanceof Error ? error.stack : String(error)}`)
  }
}

console.log(`\n结果：${passed} 通过，${failed} 失败`)
if (failed > 0) {
  process.exit(1)
}
void SEED_REPLANT_STATE
