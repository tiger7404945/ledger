<script setup>
/**
 * 数据备份弹层（S8-1）
 * ------------------------------------------------------------
 * 「我的 → 数据备份」。两个动作：
 *
 *   - **导出**：把当前分区的账目打包成 JSON 文件下载到本机。
 *     纯读操作，**不设登录门禁** —— 数据本来就在用户自己的设备上。
 *   - **导入**：选一份之前导出的文件，**先预览再确认**，按 id 增量合并。
 *     批量写操作，所以**先过登录门禁**（见 `useLoginGate`）。
 *
 * ## 为什么导出也要走数据层而不是「从 store 里凑」
 *
 * store 里只有**当前月份 / 当前账期**那一片切片。导出要的是全量，
 * 只能问数据层要（`core/backup.js` 负责格式与合并规则，适配器负责读写）。
 *
 * ## 预览里为什么要有「跳过」
 *
 * 跳过 = 本地那份更新或一样新。它的作用不只是交代数字 —— 它正是
 * **幂等性的可视化**：同一份文件导第二次，会看到「新增 0、更新 0、跳过 187」，
 * 用户一眼就明白「没重复导入」。（这条性质由 `backup-test` 断言）
 */
import { computed, ref, watch } from 'vue'
import { exportBackup, previewImport, applyImport, backupFileName } from '@/api'
import { useAccountStore } from '@/stores/account.js'
import { useBillStore } from '@/stores/bill.js'
import { useCategoryStore } from '@/stores/category.js'
import { useToast } from '@/composables/useToast.js'
import { requireLogin } from '@/composables/useLoginGate.js'
import BottomSheet from '@/components/BottomSheet.vue'
import IconBase from '@/components/icons/IconBase.vue'

const props = defineProps({
  modelValue: { type: Boolean, default: false }
})
const emit = defineEmits(['update:modelValue'])

const account = useAccountStore()
const billStore = useBillStore()
const categoryStore = useCategoryStore()
const toast = useToast()

const busy = ref(false)
/** 当前分区可导出的条数（打开时读一次真值） */
const stats = ref({ bills: 0, categories: 0, ledgers: 0 })
/** 已解析的导入预览；null = 还没选文件 */
const preview = ref(null)
const pickedName = ref('')
const fileInput = ref(null)

const open = computed({
  get: () => props.modelValue,
  set: (value) => emit('update:modelValue', value)
})

const previewCounts = computed(() => preview.value?.plan?.counts || { create: 0, update: 0, skip: 0 })
const nothingToImport = computed(() => previewCounts.value.create === 0 && previewCounts.value.update === 0)

/** 文件里被跳过的坏数据（缺 id / 金额非法 / 日期非法…）说明，没有就返回空串 */
const invalidText = computed(() => {
  const bad = preview.value?.invalid
  if (!bad) return ''
  const total = Object.values(bad).reduce((a, b) => a + b, 0)
  return total ? `文件里有 ${total} 条数据无法识别，已跳过。` : ''
})

/** 每次打开都回到干净态：上一次的文件预览不该留着 */
watch(open, async (value) => {
  if (!value) return
  preview.value = null
  pickedName.value = ''
  await refreshStats()
})

async function refreshStats() {
  try {
    const backup = await exportBackup()
    stats.value = backup.counts
  } catch (e) {
    stats.value = { bills: 0, categories: 0, ledgers: 0 }
  }
}

/* ---------------- 导出 ---------------- */

/** 触发浏览器下载。用 Blob + a[download]，不依赖任何第三方库 */
function downloadText(name, text) {
  const blob = new Blob([text], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  a.remove()
  /**
   * ⚠️ 不能立刻 revoke：部分浏览器（含移动端）此时才开始读 blob，
   * 撤早了会得到一个 0 字节的文件。延后一拍最稳。
   */
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

async function doExport() {
  if (busy.value) return
  busy.value = true
  try {
    const backup = await exportBackup({
      account: { label: account.label, signedIn: account.signedIn }
    })
    if (!backup.counts.bills) {
      toast.show('还没有账单可以导出')
      return
    }
    downloadText(backupFileName(), JSON.stringify(backup, null, 2))
    toast.success(`已导出 ${backup.counts.bills} 条账单`)
  } catch (e) {
    toast.show(`导出失败：${e?.message || e}`)
  } finally {
    busy.value = false
  }
}

/* ---------------- 导入 ---------------- */

function pickFile() {
  if (busy.value) return

  /**
   * 导入要写本地库、还要入队推上云，属于写操作 ⇒ 先过门禁。
   * 门禁弹的是全局登录层，登录成功后**不会**自动接着选文件
   * （浏览器要求 file 选择必须由用户手势触发），所以这里只提示，
   * 让用户登录完再点一次 —— 比「静默不响应」清楚。
   */
  if (!requireLogin('导入备份')) return
  fileInput.value?.click()
}

async function onFileChange(event) {
  const file = event.target.files?.[0]
  // 清掉 value：同一个文件连续选两次也要能再次触发 change
  event.target.value = ''
  if (!file) return

  busy.value = true
  try {
    const text = await file.text()
    const result = await previewImport(text)
    if (!result.ok) {
      preview.value = null
      toast.show(result.error)
      return
    }
    pickedName.value = file.name
    preview.value = result
  } catch (e) {
    preview.value = null
    toast.show(`读取失败：${e?.message || e}`)
  } finally {
    busy.value = false
  }
}

async function confirmImport() {
  if (!preview.value || busy.value) return
  if (nothingToImport.value) {
    toast.show('这份备份与当前数据一致，无需导入')
    return
  }

  busy.value = true
  try {
    const result = await applyImport(preview.value.plan)
    // 两份切片都要刷：首页用 month/bills/summary，账单页与统计页用 period*
    await Promise.all([
      billStore.refresh(),
      billStore.refreshPeriod(),
      categoryStore.ensureLoaded(true)
    ])

    const parts = []
    if (result.created) parts.push(`新增 ${result.created}`)
    if (result.updated) parts.push(`更新 ${result.updated}`)
    const tail = result.created || result.updated ? '' : '（都被跳过了）'
    toast.success(`导入完成：${parts.join('、') || '没有变化'}${tail}`)

    if (!cloudSignedInForPush()) {
      // 没登录 ⇒ 数据只在本地，说清楚，免得用户以为已经云备份了
      toast.show('数据已存到本机；登录后会自动同步到云端')
    }
    preview.value = null
    pickedName.value = ''
    await refreshStats()
  } catch (e) {
    toast.show(`导入失败：${e?.message || e}`)
  } finally {
    busy.value = false
  }
}

/** 导入完成后是否需要提醒「还没同步」 */
function cloudSignedInForPush() {
  return account.signedIn === true
}
</script>

<template>
  <BottomSheet v-model="open">
    <div class="sheet-body">
      <header class="head">
        <span class="title">数据备份</span>
        <button class="close" type="button" @click="open = false">
          <IconBase name="close" :size="16" :stroke-width="1.9" />
        </button>
      </header>

      <p class="lead">
        导出成一个 JSON 文件保存在本机，换设备或清空浏览器后可以再导入回来。备份文件不经过任何服务器。
      </p>

      <section class="block">
        <div class="block-head">
          <span class="block-title">导出备份</span>
          <span class="muted">{{ stats.bills }} 条账单 · {{ stats.categories }} 个分类</span>
        </div>
        <button class="primary" type="button" :disabled="busy" @click="doExport">
          <IconBase name="arrowDown" :size="15" :stroke-width="1.9" />
          导出为 JSON 文件
        </button>
      </section>

      <section class="block">
        <div class="block-head">
          <span class="block-title">从备份恢复</span>
          <span class="muted">按账单 id 合并</span>
        </div>

        <input
          ref="fileInput"
          class="file"
          type="file"
          accept=".json,application/json"
          @change="onFileChange"
        />

        <div v-if="!preview" class="note">
          选择之前导出的备份文件，先看看会合并哪些内容，再决定要不要导入。已有的数据不会被删除。
        </div>

        <div v-else class="preview">
          <p class="preview-file">{{ pickedName }}</p>
          <ul class="preview-list">
            <li>
              <em>新增</em>
              <span class="strong">{{ previewCounts.create }} 条</span>
            </li>
            <li>
              <em>更新</em>
              <span>{{ previewCounts.update }} 条</span>
            </li>
            <li>
              <em>跳过</em>
              <span class="muted">{{ previewCounts.skip }} 条</span>
            </li>
          </ul>
          <p v-if="nothingToImport" class="note tight">这份备份的内容本机已经有了，导入不会产生重复。</p>
          <p v-if="invalidText" class="warn">{{ invalidText }}</p>
        </div>

        <div class="actions">
          <button class="ghost" type="button" :disabled="busy" @click="pickFile">选择备份文件</button>
          <button
            v-if="preview"
            class="primary"
            type="button"
            :disabled="busy || nothingToImport"
            @click="confirmImport"
          >
            确认导入
          </button>
        </div>
      </section>
    </div>
  </BottomSheet>
</template>

<style scoped>
.sheet-body {
  padding: 16px 16px calc(18px + env(safe-area-inset-bottom, 0px));
  overflow-y: auto;
}

.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.title {
  font-size: 16px;
  font-weight: 600;
}

.close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  background: var(--surface-3);
  color: var(--ink-3);
}

.lead {
  margin-top: 10px;
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--ink-3);
}

.block {
  margin-top: 18px;
}

.block-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 10px;
}

.block-title {
  font-size: 14px;
  font-weight: 500;
}

.muted {
  color: var(--ink-3);
  font-size: 12px;
}

.file {
  display: none;
}

.note {
  padding: 10px 12px;
  border-radius: 12px;
  background: var(--surface-3);
  color: var(--ink-3);
  font-size: 12.5px;
  line-height: 1.6;
}

.note.tight {
  margin-top: 8px;
}

.warn {
  margin-top: 8px;
  color: var(--danger);
  font-size: 12.5px;
}

.preview {
  padding: 12px;
  border-radius: 12px;
  background: var(--surface-3);
}

.preview-file {
  font-size: 12.5px;
  color: var(--ink-2);
  word-break: break-all;
}

.preview-list {
  margin-top: 8px;
}

.preview-list li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 5px 0;
  font-size: 13px;
}

.preview-list em {
  font-style: normal;
  color: var(--ink-3);
}

.strong {
  font-weight: 600;
  color: var(--brand-ink);
}

.actions {
  display: flex;
  gap: 8px;
  margin-top: 12px;
}

.primary,
.ghost {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 42px;
  border-radius: var(--r-pill);
  font-size: 14px;
  font-weight: 500;
}

.primary {
  background: var(--brand);
  color: #fff;
}

.ghost {
  background: var(--surface-3);
  color: var(--ink-2);
}

.primary:disabled,
.ghost:disabled {
  opacity: 0.45;
}
</style>
