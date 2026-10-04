<template>
  <section class="sub-panel" data-testid="recheck-panel">
    <header class="sub-head">
      <div>
        <h3>补植复查项（随验收同步生成）</h3>
        <p class="page-desc">补植验收合格的林带在此生成复查任务，验收与复查项在同一事务内落库，任一失败一起回退。</p>
      </div>
      <button class="btn" type="button" @click="reload">刷新复查项</button>
    </header>

    <table v-if="rows.length" class="data-table">
      <thead>
        <tr>
          <th>复查内容</th>
          <th>来源</th>
          <th>林带编号</th>
          <th>复查期限</th>
          <th>状态</th>
          <th>完成时间</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="row.id">
          <td>{{ row.title }}</td>
          <td>{{ row.source === 'firebelt' ? '防火林带' : '防火隔离带' }}</td>
          <td>{{ row.beltNo }}</td>
          <td>{{ formatDate(row.dueAt) }}</td>
          <td>{{ row.status }}</td>
          <td>{{ row.completedAt ? formatDate(row.completedAt) : '—' }}</td>
          <td class="row-actions">
            <button
              v-if="row.status === '待复查'"
              class="link"
              type="button"
              @click="finish(row.id)"
            >
              完成复查
            </button>
            <span v-else class="muted-text">已闭环</span>
          </td>
        </tr>
      </tbody>
    </table>
    <p v-else class="empty-state panel-empty">暂无补植复查项</p>

    <footer class="page-foot">
      <span v-if="message" :class="ok ? 'success-text' : 'error-text'">{{ message }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'

import { completeRecheck, recheckList } from '@/data/replant-service'
import type { RecheckItem } from '@/data/replant-types'

const rows = ref<RecheckItem[]>([])
const message = ref('')
const ok = ref(true)

function formatDate(iso: string): string {
  return iso ? iso.slice(0, 10) : '—'
}

function reload() {
  rows.value = recheckList()
}

function finish(id: number) {
  message.value = ''
  const result = completeRecheck(id)
  ok.value = result.ok
  message.value = result.message
  if (result.ok) {
    reload()
  }
}

onMounted(reload)
defineExpose({ reload })
</script>
