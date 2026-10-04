<template>
  <section class="sub-panel" data-testid="maintenance-panel">
    <header class="sub-head">
      <div>
        <h3>隔离带维护面板</h3>
        <p class="page-desc">
          补植与割草维护批次统一在此跟踪；维护批次与补植列表、归档台账共用同一份取数，状态不会错位。
        </p>
      </div>
      <button class="btn" type="button" @click="reload">刷新批次</button>
    </header>

    <table v-if="rows.length" class="data-table">
      <thead>
        <tr>
          <th>批次编号</th>
          <th>批次类型</th>
          <th>批次状态</th>
          <th>关联林带</th>
          <th>安排时间</th>
          <th>完成时间</th>
          <th>中断原因</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="row.batchId">
          <td>{{ row.batchNo }}</td>
          <td>{{ row.typeLabel }}</td>
          <td>
            <span :class="{ 'error-text': row.status === '已中断' }">{{ row.status }}</span>
          </td>
          <td>{{ row.beltNos.join('、') }}（{{ row.beltCount }} 条）</td>
          <td>{{ formatDate(row.scheduledAt) }}</td>
          <td>{{ row.finishedAt ? formatDate(row.finishedAt) : '—' }}</td>
          <td>{{ row.interruptedReason || '—' }}</td>
        </tr>
      </tbody>
    </table>
    <p v-else class="empty-state panel-empty">暂无维护批次</p>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'

import { maintenancePanel } from '@/data/replant-service'
import type { MaintenancePanelRow } from '@/data/replant-types'

const rows = ref<MaintenancePanelRow[]>([])

function formatDate(iso: string): string {
  return iso ? iso.slice(0, 10) : '—'
}

function reload() {
  rows.value = maintenancePanel()
}

onMounted(reload)
defineExpose({ reload })
</script>
