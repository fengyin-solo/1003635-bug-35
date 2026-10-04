<template>
  <section class="page" data-module="firebelt">
    <header class="page-head">
      <div>
        <h2>防火林带管理</h2>
        <p class="page-desc">维护防火林带，围绕林带编号、林带名称、所属林区、树种组成做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记防火林带</button>
        <button class="btn" type="button" @click="exportRows">导出防火林带清单</button>
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
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>
            {{ row.status }}
            <span v-if="isProjected(row)" class="projected-tag" title="以最新验收记录为准投影">验收校正</span>
          </td>
          <td class="row-actions">
            <button
              v-for="action in availableActions(row)"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
            <span v-if="!availableActions(row).length" class="muted-text">无可用动作</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无防火林带数据，可先登记防火林带</td>
        </tr>
      </tbody>
    </table>

    <ReplantQueuePanel ref="queuePanel" class="page-spacer" @changed="reload" />

    <footer class="page-foot">
      <span>共 {{ total }} 条防火林带记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  rowActionsFor,
  runAction as applyAction,
} from '@/api/local-service'
import ReplantQueuePanel from '@/components/ReplantQueuePanel.vue'
import type { ProjectedEntry } from '@/data/replant-types'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('firebelt')
const columns = ["林带编号", "林带名称", "所属林区", "树种组成", "林带长度", "林带宽度", "种植年份", "林带状态"]
const statuses = ["完好", "有缺株", "需补植", "已退化"]
const stats = [{"label": "林带总数", "value": 0}, {"label": "完好条数", "value": 0}, {"label": "缺株条数", "value": 0}]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const queuePanel = ref<InstanceType<typeof ReplantQueuePanel> | null>(null)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function availableActions(row: EntryRow): string[] {
  return rowActionsFor(meta.key, String(row.status))
}

function isProjected(row: EntryRow): boolean {
  return Boolean((row as ProjectedEntry).projected)
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '防火林带登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    queuePanel.value?.reload()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '防火林带列表读取失败'
  }
}

onMounted(reload)
</script>
