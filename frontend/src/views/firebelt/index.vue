<template>
  <section class="page" data-module="firebelt">
    <header class="page-head">
      <div>
        <h2>防火林带补植管理</h2>
        <p class="page-desc">
          补植列表、隔离带维护面板、归档台账共用一条取数路径：主表与验收记录冲突时以验收记录为准，历史归档保留原种植年份。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="exportRows">导出补植清单</button>
        <button class="btn ghost" type="button" @click="resetDomain">重置演示数据</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label class="filter-item">
        <span>所属林区</span>
        <input v-model="filters.area" placeholder="按林区检索" />
      </label>
      <label class="filter-item">
        <span>林带关键字</span>
        <input v-model="filters.keyword" placeholder="编号 / 名称 / 树种" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <!-- 没有可验收林带时的空态：保留提示，操作失败可直接点重试。 -->
    <div v-if="loadError" class="inline-banner error">
      <span>{{ loadError }}</span>
      <button class="btn" type="button" @click="reload">重试读取</button>
    </div>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>实际状态</th>
          <th>验收依据</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="view in beltViews" :key="String(view.row.id)">
          <td v-for="column in columns" :key="column">{{ view.row[column] ?? '—' }}</td>
          <td>
            <span :class="{ 'status-fixed': view.statusConflict }">{{ view.effectiveStatus }}</span>
            <em v-if="view.statusConflict" class="conflict-hint" title="主表状态与验收记录冲突，已按验收记录纠正">
              （主表残留「{{ view.rawStatus }}」，以验收记录为准）
            </em>
          </td>
          <td>
            <template v-if="view.acceptance">
              {{ view.acceptance.status }} · {{ view.acceptance.acceptedAt }}
            </template>
            <template v-else>—</template>
          </td>
          <td class="row-actions">
            <button
              v-if="view.canArrange"
              class="link"
              type="button"
              :disabled="busy"
              @click="arrange(view.row.id)"
            >
              安排补植
            </button>
            <button
              v-if="view.canAccept"
              class="link"
              type="button"
              :disabled="busy"
              @click="acceptOne(view.row.id)"
            >
              确认补植
            </button>
            <button
              v-if="view.canDegrade"
              class="link danger"
              type="button"
              :disabled="busy"
              @click="degrade(view.row.id)"
            >
              标记退化
            </button>
            <span v-if="!view.canArrange && !view.canAccept && !view.canDegrade" class="muted-text">无可用动作</span>
          </td>
        </tr>
        <tr v-if="!beltViews.length">
          <td :colspan="columns.length + 3" class="empty-state">
            暂无可补植 / 可验收的防火林带，所有林带均已验收或已退化
          </td>
        </tr>
      </tbody>
    </table>

    <section class="sub-panel">
      <header class="sub-head">
        <h3>隔离带维护批次（补植批次在此逐林带验收）</h3>
        <label class="fault-picker">
          演示故障注入：
          <select v-model="faultMode">
            <option value="none">不注入</option>
            <option value="accept">验收记录环节失败</option>
            <option value="archive">归档台账环节失败</option>
            <option value="storage">整库持久化失败</option>
          </select>
        </label>
      </header>
      <table v-if="batchViews.length" class="data-table">
        <thead>
          <tr>
            <th>批次编号</th>
            <th>林区</th>
            <th>类型</th>
            <th>建立日期</th>
            <th>批次状态</th>
            <th>林带进度</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="batch in batchViews" :key="batch.id">
            <td>{{ batch.batchNo }}</td>
            <td>{{ batch.forestArea }}</td>
            <td>{{ batch.kind }}</td>
            <td>{{ batch.createdAt }}</td>
            <td>{{ batch.status }}</td>
            <td>
              已验收 {{ batch.acceptedBeltIds.length }} / {{ batch.beltIds.length }}
              <span v-if="batch.waitingBeltIds.length" class="muted-text">
                （待验收林带 id：{{ batch.waitingBeltIds.join('、') }}）
              </span>
            </td>
            <td class="row-actions">
              <button
                v-if="batch.kind === '补植' && batch.status === '待验收'"
                class="link"
                type="button"
                :disabled="busy"
                @click="acceptTheBatch(batch.id)"
              >
                整批验收
              </button>
              <span v-else class="muted-text">已收口</span>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-else class="empty-state">当前没有在途或历史维护批次</p>
    </section>

    <footer class="page-foot">
      <span>共 {{ beltViews.length }} 条林带；操作仅沿 完好→有缺株→需补植→（验收回完好） 推进，退化与已验收均不可重复安排</span>
      <span v-if="actionMessage" :class="actionOk ? 'ok-text' : 'error-text'">{{ actionMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { downloadEntries } from '@/api/local-service'
import {
  acceptBatch,
  acceptReplant,
  arrangeReplant,
  listBeltViews,
  listBatchViews,
  markBeltDegraded,
  resetRepairDomain,
  type BeltView,
  type FaultSpec,
} from '@/data/repair-service'

const columns = ['林带编号', '林带名称', '所属林区', '树种组成', '林带长度', '林带宽度', '种植年份']
const statuses = ['完好', '有缺株', '需补植', '已退化']

const beltViews = ref<BeltView[]>([])
const batchViews = ref<ReturnType<typeof listBatchViews>>([])
const filters = ref({ area: '', keyword: '' })
const loadError = ref('')
const actionMessage = ref('')
const actionOk = ref(false)
const busy = ref(false)
const faultMode = ref<'none' | 'accept' | 'archive' | 'storage'>('none')

const stats = computed(() => [
  { label: '林带总数', value: beltViews.value.length },
  { label: '完好条数（按验收口径）', value: beltViews.value.filter((item) => item.effectiveStatus === '完好').length },
  { label: '缺株 / 待补植', value: beltViews.value.filter((item) => ['有缺株', '需补植'].includes(item.effectiveStatus)).length },
  { label: '已退化', value: beltViews.value.filter((item) => item.effectiveStatus === '已退化').length },
])

const statusSummary = computed(() =>
  statuses.map((status) => ({
    status,
    count: beltViews.value.filter((view) => view.effectiveStatus === status).length,
  })),
)

function currentFault(): FaultSpec | undefined {
  return faultMode.value === 'none' ? undefined : { stage: faultMode.value }
}

function flash(ok: boolean, message: string) {
  actionOk.value = ok
  actionMessage.value = message
}

function reload() {
  loadError.value = ''
  try {
    beltViews.value = listBeltViews(filters.value)
    batchViews.value = listBatchViews()
  } catch (error) {
    // 中断异常必须说明原因，并保留可重试入口。
    loadError.value = error instanceof Error ? `取数失败：${error.message}` : '取数失败：本地数据读取异常，请重试'
  }
}

function resetFilters() {
  filters.value = { area: '', keyword: '' }
  reload()
}

function exportRows() {
  downloadEntries('firebelt')
}

function resetDomain() {
  const result = resetRepairDomain()
  flash(result.ok, result.message)
  reload()
}

function arrange(id: number) {
  const result = arrangeReplant(id)
  flash(result.ok, result.message)
  reload()
}

function degrade(id: number) {
  const result = markBeltDegraded(id)
  flash(result.ok, result.message)
  reload()
}

async function acceptOne(id: number) {
  busy.value = true
  actionMessage.value = ''
  try {
    const result = await acceptReplant(id, { fault: currentFault() })
    flash(result.ok, result.message)
    if (result.ok || faultMode.value !== 'none') {
      // 故障注入每次只模拟一次，验完恢复成正常态以便立刻重试成功。
      if (result.ok) {
        faultMode.value = 'none'
      }
    }
    reload()
  } catch (error) {
    flash(false, `验收中断：${error instanceof Error ? error.message : '未知异常'}，数据已整体回退，可重试`)
  } finally {
    busy.value = false
  }
}

async function acceptTheBatch(batchId: number) {
  busy.value = true
  actionMessage.value = ''
  try {
    const result = await acceptBatch(batchId, { fault: currentFault() })
    flash(result.ok, result.ok ? result.message : `${result.message}（可点整批验收从缺失林带重试）`)
    if (result.ok) {
      faultMode.value = 'none'
    }
    reload()
  } catch (error) {
    flash(false, `批次验收中断：${error instanceof Error ? error.message : '未知异常'}，已落库的验收保留，其余可重试`)
  } finally {
    busy.value = false
  }
}

onMounted(reload)
</script>

<style scoped>
.sub-panel {
  margin-top: 18px;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
}
.sub-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}
.sub-head h3 {
  margin: 0;
  font-size: 14px;
}
.fault-picker {
  font-size: 12px;
  color: var(--muted);
}
.inline-banner {
  display: flex;
  justify-content: space-between;
  align-items: center;
  border-radius: 6px;
  padding: 8px 12px;
  margin-bottom: 10px;
  font-size: 13px;
}
.inline-banner.error {
  background: #fef3f2;
  border: 1px solid #fecdca;
  color: #b42318;
}
.status-fixed {
  font-weight: 600;
}
.conflict-hint {
  color: #b54708;
  font-size: 12px;
  font-style: normal;
}
.muted-text {
  color: var(--muted);
  font-size: 12px;
}
.link.danger {
  color: #b42318;
}
.ok-text {
  color: #067647;
}
button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
