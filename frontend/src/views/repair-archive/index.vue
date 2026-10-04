<template>
  <section class="page" data-module="repair-archive">
    <header class="page-head">
      <div>
        <h2>补植归档台账</h2>
        <p class="page-desc">
          台账只追加、不改写：每条记录保留林带最初种植年份，补植年份单列；与补植列表、隔离带面板共用同一取数路径，状态冲突以验收记录为准。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn ghost" type="button" @click="resetDomain">重置演示数据</button>
      </div>
    </header>

    <div class="stat-row">
      <article class="stat-card">
        <span class="stat-label">归档条目</span>
        <strong class="stat-value">{{ archiveViews.length }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">本年度补植</span>
        <strong class="stat-value">{{ yearCount }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">原种植年份保留率</span>
        <strong class="stat-value">{{ keepRate }}%</strong>
      </article>
    </div>

    <form class="filter-bar" @submit.prevent="reload">
      <label class="filter-item">
        <span>所属林区</span>
        <input v-model="filters.area" placeholder="按林区检索" />
      </label>
      <label class="filter-item">
        <span>林带关键字</span>
        <input v-model="filters.keyword" placeholder="编号 / 名称" />
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
        </tr>
      </thead>
      <tbody>
        <tr v-for="entry in archiveViews" :key="entry.id">
          <td>{{ entry.beltCode }}</td>
          <td>{{ entry.beltName }}</td>
          <td>{{ entry.forestArea }}</td>
          <td class="original-year">{{ entry.originalPlantYear || '—' }}</td>
          <td>{{ entry.replantYear }}</td>
          <td>{{ entry.acceptedAt }}</td>
          <td>{{ entry.acceptedBy }}</td>
          <td>
            <span v-if="entry.statusConflict" class="conflict-hint" title="台账缺行，已按验收记录补算展示">
              验收记录补算
            </span>
            <span v-else class="ok-text">已归档</span>
          </td>
        </tr>
        <tr v-if="!archiveViews.length">
          <td :colspan="columns.length" class="empty-state">
            暂无已验收的补植记录：没有可归档林带时此处保留空态，验收通过后会自动入账
          </td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ archiveViews.length }} 条归档；补植不会覆盖「原种植年份」列</span>
      <span v-if="message" :class="ok ? 'ok-text' : 'error-text'">{{ message }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { listArchiveViews, resetRepairDomain, type ArchiveView } from '@/data/repair-service'

const columns = ['林带编号', '林带名称', '所属林区', '原种植年份', '补植年份', '验收日期', '验收人', '归档状态']

const archiveViews = ref<ArchiveView[]>([])
const filters = ref({ area: '', keyword: '' })
const loadError = ref('')
const message = ref('')
const ok = ref(false)

const currentYear = String(new Date().getFullYear())
const yearCount = computed(() => archiveViews.value.filter((entry) => entry.replantYear === currentYear).length)
const keepRate = computed(() => {
  if (!archiveViews.value.length) {
    return 100
  }
  const kept = archiveViews.value.filter((entry) => entry.originalPlantYear.trim() !== '').length
  return Math.round((kept / archiveViews.value.length) * 100)
})

function reload() {
  loadError.value = ''
  try {
    archiveViews.value = listArchiveViews(filters.value)
  } catch (error) {
    loadError.value = error instanceof Error ? `台账读取失败：${error.message}` : '台账读取异常，可重试'
  }
}

function resetFilters() {
  filters.value = { area: '', keyword: '' }
  reload()
}

function resetDomain() {
  const result = resetRepairDomain()
  ok.value = result.ok
  message.value = result.message
  reload()
}

onMounted(reload)
</script>

<style scoped>
.original-year {
  font-weight: 600;
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
.conflict-hint {
  color: #b54708;
  font-size: 12px;
}
.ok-text {
  color: #067647;
  font-size: 12px;
}
</style>
