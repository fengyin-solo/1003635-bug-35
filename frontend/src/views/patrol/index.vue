<template>
  <section class="page" data-module="patrol">
    <header class="page-head">
      <div>
        <h2>巡护任务管理</h2>
        <p class="page-desc">维护巡护任务，围绕任务编号、巡护区域、巡护路线、巡护员做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记巡护任务</button>
        <button class="btn" type="button" @click="exportRows">导出巡护任务清单</button>
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
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无巡护任务数据，可先登记巡护任务</td>
        </tr>
      </tbody>
    </table>

    <section class="review-panel">
      <header class="review-head">
        <h3>补植复查项</h3>
        <span class="review-tip">由林带补植验收自动同步生成，一条验收对应一条复查</span>
      </header>
      <table v-if="reviews.length" class="data-table">
        <thead>
          <tr>
            <th>复查编号</th>
            <th>关联林区</th>
            <th>复查内容</th>
            <th>巡护员</th>
            <th>计划复查日</th>
            <th>复查状态</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in reviews" :key="item.id">
            <td>{{ item.reviewNo }}</td>
            <td>{{ item.area }}</td>
            <td>{{ item.note }}</td>
            <td>{{ item.reviewer }}</td>
            <td>{{ item.reviewDate }}</td>
            <td>{{ item.status }}</td>
            <td class="row-actions">
              <button
                v-if="item.status === '待复查'"
                class="link"
                type="button"
                @click="finishReview(item.id)"
              >
                登记复查结果
              </button>
              <span v-else class="muted-text">已完成</span>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-else class="empty-state">暂无补植复查项：林带补植验收通过后会自动生成</p>
    </section>

    <footer class="page-foot">
      <span>共 {{ total }} 条巡护任务记录</span>
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
  runAction as applyAction,
} from '@/api/local-service'
import {
  completeReview,
  patrolReviewRows,
} from '@/data/repair-service'
import type { PatrolReviewItem } from '@/data/repair-types'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('patrol')
const columns = ["任务编号", "巡护区域", "巡护路线", "巡护员", "巡护日期", "巡护时段", "发现火情数", "任务状态"]
const actions = ["开始巡护", "确认完成", "取消任务"]
const statuses = ["待执行", "执行中", "已完成", "已取消"]
const stats = [{"label": "今日任务数", "value": 0}, {"label": "已完成任务", "value": 0}, {"label": "巡护覆盖率", "value": 0}]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const reviews = ref<PatrolReviewItem[]>([])
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '巡护任务登记入口尚未接入审批流'
}

function finishReview(id: number) {
  const result = completeReview(id)
  errorMessage.value = result.ok ? '' : result.message
  reload()
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
    // 补植验收同步生成的复查项：别的模块只负责读取与登记结果。
    reviews.value = patrolReviewRows()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '巡护任务列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.review-panel {
  margin-top: 18px;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
}
.review-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 8px;
}
.review-head h3 {
  margin: 0;
  font-size: 14px;
}
.review-tip {
  color: var(--muted);
  font-size: 12px;
}
.muted-text {
  color: var(--muted);
  font-size: 12px;
}
</style>
