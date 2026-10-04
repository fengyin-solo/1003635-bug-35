<template>
  <section class="sub-panel" data-testid="replant-queue-panel">
    <header class="sub-head">
      <div>
        <h3>补植列表（林带与隔离带共用）</h3>
        <p class="page-desc">只列待验收的补植批次；验收合格后缺株标记清除、批次关闭、台账归档并同步巡护复查项。</p>
      </div>
      <button class="btn" type="button" :disabled="busy" @click="reload">刷新列表</button>
    </header>

    <table v-if="rows.length" class="data-table">
      <thead>
        <tr>
          <th>补植批次</th>
          <th>来源</th>
          <th>林带编号</th>
          <th>原种植年份</th>
          <th>补植做法</th>
          <th>安排时间</th>
          <th>批次状态</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="row.key">
          <td>{{ row.batchNo }}</td>
          <td>{{ row.sourceLabel }}</td>
          <td>{{ row.beltNo }}</td>
          <td>{{ row.originalPlantYear || '—' }}</td>
          <td>{{ row.practice }}</td>
          <td>{{ formatDate(row.scheduledAt) }}</td>
          <td>
            <span>待验收</span>
            <p v-if="row.interruptedReason" class="error-text interrupt-reason">
              上次中断：{{ row.interruptedReason }}
            </p>
          </td>
          <td class="row-actions">
            <button class="link" type="button" :disabled="busy" @click="accept(row)">
              {{ row.interruptedReason ? '从缺失林带重试' : '确认验收' }}
            </button>
          </td>
        </tr>
      </tbody>
    </table>
    <p v-else class="empty-state panel-empty">暂无可验收林带，补植列表为空</p>

    <footer class="page-foot">
      <span v-if="lastMessage" :class="lastOk ? 'success-text' : 'error-text'">{{ lastMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'

import { acceptReplantBatch, replantQueue } from '@/data/replant-service'
import type { ReplantQueueRow } from '@/data/replant-types'

const emit = defineEmits<{ (event: 'changed'): void }>()

const rows = ref<ReplantQueueRow[]>([])
const busy = ref(false)
const lastMessage = ref('')
const lastOk = ref(true)

function formatDate(iso: string): string {
  if (!iso) {
    return '—'
  }
  return iso.slice(0, 10)
}

function reload() {
  rows.value = replantQueue()
}

function accept(row: ReplantQueueRow) {
  busy.value = true
  lastMessage.value = ''
  try {
    const result = acceptReplantBatch(row.batchId)
    lastOk.value = result.ok
    lastMessage.value = result.ok
      ? result.message
      : `${result.message}${result.missing ? `（缺失：${result.missing.source} #${result.missing.beltId}）` : ''}`
    if (result.ok) {
      reload()
      emit('changed')
    } else {
      // 失败可重试：刷新行以展示最新中断原因，按钮保留在原位。
      reload()
    }
  } catch (error) {
    lastOk.value = false
    lastMessage.value = error instanceof Error ? error.message : '验收异常中断，数据未改动，可重试'
    reload()
  } finally {
    busy.value = false
  }
}

onMounted(reload)
defineExpose({ reload })
</script>
