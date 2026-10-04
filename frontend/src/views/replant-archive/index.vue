<template>
  <section class="page" data-module="replant-archive">
    <header class="page-head">
      <div>
        <h2>补植归档台账</h2>
        <p class="page-desc">
          验收合格的补植记录在此归档；原种植年份取安排补植时的快照长期保留，补植年份单列，二者互不覆盖。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="reload">刷新台账</button>
        <button class="btn" type="button" @click="exportCsv">导出台账 CSV</button>
      </div>
    </header>

    <div class="stat-row">
      <article class="stat-card">
        <span class="stat-label">归档笔数</span>
        <strong class="stat-value">{{ rows.length }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">涉及林带</span>
        <strong class="stat-value">{{ beltCount }}</strong>
      </article>
    </div>

    <table v-if="rows.length" class="data-table">
      <thead>
        <tr>
          <th>台账编号</th>
          <th>补植批次</th>
          <th>来源</th>
          <th>林带编号</th>
          <th>原种植年份</th>
          <th>补植年份</th>
          <th>补植做法</th>
          <th>验收记录号</th>
          <th>归档时间</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="row.id">
          <td>{{ row.id }}</td>
          <td>{{ batchNoOf(row.batchId) }}</td>
          <td>{{ row.source === 'firebelt' ? '防火林带' : '防火隔离带' }}</td>
          <td>{{ row.beltNo }}</td>
          <td>{{ row.originalPlantYear || '—' }}</td>
          <td>{{ row.replantYear }}</td>
          <td>{{ row.practice }}</td>
          <td>{{ row.acceptanceId }}</td>
          <td>{{ formatDate(row.archivedAt) }}</td>
        </tr>
      </tbody>
    </table>
    <p v-else class="empty-state">暂无已验收归档的补植记录</p>

    <footer class="page-foot">
      <span>共 {{ rows.length }} 笔归档；台账随验收事务落库，验收失败时不会产生半截台账</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { archiveLedger, maintenancePanel } from '@/data/replant-service'
import type { ArchiveEntry } from '@/data/replant-types'

const rows = ref<ArchiveEntry[]>([])
const batches = ref(maintenancePanel())

const beltCount = computed(() => new Set(rows.value.map((row) => `${row.source}-${row.beltId}`)).size)

function batchNoOf(batchId: number): string {
  return batches.value.find((batch) => batch.batchId === batchId)?.batchNo ?? `批次 ${batchId}`
}

function formatDate(iso: string): string {
  return iso ? iso.slice(0, 10) : '—'
}

function reload() {
  rows.value = archiveLedger()
  batches.value = maintenancePanel()
}

function exportCsv() {
  const header = ['台账编号', '补植批次', '来源', '林带编号', '原种植年份', '补植年份', '补植做法', '验收记录号', '归档时间']
  const lines = [header.join(',')]
  for (const row of rows.value) {
    lines.push(
      [
        row.id,
        batchNoOf(row.batchId),
        row.source === 'firebelt' ? '防火林带' : '防火隔离带',
        row.beltNo,
        row.originalPlantYear,
        row.replantYear,
        row.practice,
        row.acceptanceId,
        formatDate(row.archivedAt),
      ].join(','),
    )
  }
  const blob = new Blob([`﻿${lines.join('\n')}`], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = '补植归档台账.csv'
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

onMounted(reload)
</script>
