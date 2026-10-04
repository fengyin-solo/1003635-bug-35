<template>
  <section class="page" data-module="firebreak">
    <header class="page-head">
      <div>
        <h2>防火隔离带维护面板</h2>
        <p class="page-desc">
          与补植列表共用取数路径：隔离带状态随林带补植验收记录联动，缺口消除后自动恢复，荒废为终态；有在途补植批次时禁止荒废、禁止跳步确认。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="exportRows">导出隔离带清单</button>
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
        <span>隔离带关键字</span>
        <input v-model="filters.keyword" placeholder="编号 / 坐标" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <div v-if="loadError" class="inline-banner error">
      <span>{{ loadError }}</span>
      <button class="btn" type="button" @click="reload">重试读取</button>
    </div>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>实际状态</th>
          <th>在途批次</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="view in breakViews" :key="String(view.row.id)">
          <td v-for="column in columns" :key="column">{{ view.row[column] ?? '—' }}</td>
          <td>
            <span :class="{ 'status-fixed': view.statusConflict }">{{ view.effectiveStatus }}</span>
            <em v-if="view.statusConflict" class="conflict-hint">
              （主表残留「{{ view.rawStatus }}」，已按验收记录联动纠正）
            </em>
          </td>
          <td>
            <span v-if="view.openBatches.length" class="muted-text">
              {{ view.openBatches.map((batch) => `${batch.batchNo}(${batch.kind})`).join('、') }}
            </span>
            <span v-else>—</span>
          </td>
          <td class="row-actions">
            <button
              v-if="view.canArrangeMaintenance"
              class="link"
              type="button"
              @click="arrange(view.row.id)"
            >
              安排维护
            </button>
            <button
              v-if="view.canRecover"
              class="link"
              type="button"
              @click="recover(view.row.id)"
            >
              确认恢复
            </button>
            <button
              v-if="view.canAbandon"
              class="link danger"
              type="button"
              @click="abandon(view.row.id)"
            >
              标记荒废
            </button>
            <span v-if="!view.canArrangeMaintenance && !view.canRecover && !view.canAbandon" class="muted-text">
              无可用动作
            </span>
          </td>
        </tr>
        <tr v-if="!breakViews.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无防火隔离带数据</td>
        </tr>
      </tbody>
    </table>

    <section class="sub-panel">
      <header class="sub-head">
        <h3>维护批次一览（补植批次的验收在「防火林带补植管理」页逐林带完成）</h3>
      </header>
      <table v-if="batchViews.length" class="data-table">
        <thead>
          <tr>
            <th>批次编号</th>
            <th>林区</th>
            <th>类型</th>
            <th>建立日期</th>
            <th>状态</th>
            <th>完工日期</th>
            <th>覆盖对象</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="batch in batchViews" :key="batch.id">
            <td>{{ batch.batchNo }}</td>
            <td>{{ batch.forestArea }}</td>
            <td>{{ batch.kind }}</td>
            <td>{{ batch.createdAt }}</td>
            <td>{{ batch.status }}</td>
            <td>{{ batch.completedAt || '—' }}</td>
            <td class="muted-text">
              <template v-if="batch.kind === '补植'">
                林带 {{ batch.beltIds.join('、') }}（已验收 {{ batch.acceptedBeltIds.length }}/{{ batch.beltIds.length }}）
              </template>
              <template v-else>隔离带 {{ batch.breakIds.join('、') }}</template>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-else class="empty-state">当前没有维护批次</p>
    </section>

    <footer class="page-foot">
      <span>共 {{ breakViews.length }} 条隔离带；需补植的须等林带验收通过，流程不得反向推进</span>
      <span v-if="message" :class="ok ? 'ok-text' : 'error-text'">{{ message }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { downloadEntries } from '@/api/local-service'
import {
  arrangeMaintenance,
  confirmBreakRecovery,
  listBatchViews,
  listBreakViews,
  markBreakAbandoned,
  resetRepairDomain,
  type BreakView,
} from '@/data/repair-service'

const columns = ['隔离带编号', '所属林区', '起止坐标', '带宽米数', '建成日期', '最近维护日期', '植被恢复程度']
const statuses = ['正常', '需割草', '需补植', '已荒废']

const breakViews = ref<BreakView[]>([])
const batchViews = ref<ReturnType<typeof listBatchViews>>([])
const filters = ref({ area: '', keyword: '' })
const loadError = ref('')
const message = ref('')
const ok = ref(false)

const stats = computed(() => [
  { label: '隔离带条数', value: breakViews.value.length },
  { label: '需维护（割草/补植）', value: breakViews.value.filter((item) => ['需割草', '需补植'].includes(item.effectiveStatus)).length },
  { label: '荒废条数', value: breakViews.value.filter((item) => item.effectiveStatus === '已荒废').length },
])

const statusSummary = computed(() =>
  statuses.map((status) => ({
    status,
    count: breakViews.value.filter((view) => view.effectiveStatus === status).length,
  })),
)

function flash(result: { ok: boolean; message: string }) {
  ok.value = result.ok
  message.value = result.message
}

function reload() {
  loadError.value = ''
  try {
    breakViews.value = listBreakViews(filters.value)
    batchViews.value = listBatchViews()
  } catch (error) {
    loadError.value = error instanceof Error ? `取数失败：${error.message}` : '隔离带数据读取异常，可重试'
  }
}

function resetFilters() {
  filters.value = { area: '', keyword: '' }
  reload()
}

function exportRows() {
  downloadEntries('firebreak')
}

function resetDomain() {
  flash(resetRepairDomain())
  reload()
}

function arrange(id: number) {
  flash(arrangeMaintenance(id))
  reload()
}

function recover(id: number) {
  flash(confirmBreakRecovery(id))
  reload()
}

function abandon(id: number) {
  flash(markBreakAbandoned(id))
  reload()
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
.sub-head h3 {
  margin: 0 0 8px;
  font-size: 14px;
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
</style>
