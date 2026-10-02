<script setup>
/**
 * 数据备份弹层（S8-1）
 * ------------------------------------------------------------
 * 「我的 → 数据备份」。两个动作：
 *
 *   - **导出**：把当前分区的账目打包成 JSON 文件下载到本机。
 *     纯读操作，**不设登录门禁** —— 数据本来就在用户自己的设备上。
 *   - **导入**：选一份之前导出的文件，**先预览**，然后二选一：
 *       · **恢复到此备份**（主路径）—— 以备份为准完整还原：写入备份里的数据、
 *         找回本机已删除的账单、清除本机多出的数据。不可逆，所以带二次确认。
 *       · **仅合并** —— 只新增 / 覆盖，绝不删本机已有数据。保守路径。
 *     两种都是批量写操作，所以**先过登录门禁**（见 `useLoginGate`）。
 *
 * ## 为什么「恢复」要单独存在，而不是把合并规则放宽
 *
 * 「导出 → 删错一笔 → 导回来」是备份最朴素的用法。但本项目的删除是**软删**
 * （留墓碑 + `updatedAt` 抬到删除时刻），墓碑必然比备份里的时间戳新，于是
 * 合并口径下一律判「本地更新」而跳过 —— 用户看到的「导入不成功」是设计使然，
 * 不是故障。放宽合并规则会同时破坏「旧备份不覆盖新数据」。
 * 所以改成把两种诉求拆成两个显式按钮：安全的那条保持默认，恢复作为
 * **用户自己按下的**危险动作。裁决过程见 `core/backup.js` 决定 ②。
 *
 * ## 为什么导出也要走数据层而不是「从 store 里凑」
 *
 * store 里只有**当前月份 / 当前账期**那一片切片。导出要的是全量，
 * 只能问数据层要（`core/backup.js` 负责格式与合并规则，适配器负责读写）。
 *
 * ## 预览里的数字为什么按「恢复口径」显示
 *
 * 用户按下的是「恢复」，就该拿恢复的结果给他看：写回多少条、清除多少条、
 * 其中多少条是本机删过又找回来的。合并口径的数字不跟它混在一张表里 ——
 * 混着显示会让人以为「清除」是必然发生的。
 */
import { computed, ref, watch } from 'vue'
import { exportBackup, previewImport, applyImport, backupFileName } from '@/api'
import { useAccountStore } from '@/stores/account.js'
import { useBillStore } from '@/stores/bill.js'
import { useCategoryStore } from '@/stores/category.js'
import { useToast } from '@/composables/useToast.js'
import { requireLogin } from '@/composables/useLoginGate.js'
import { formatFullTimeCN } from '@/utils/date.js'
import BottomSheet from '@/components/BottomSheet.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
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

/** 「恢复」的二次确认弹层（不可逆操作，必须由用户明确按下） */
const restoreAsk = ref(false)

/** 恢复口径：以备份为准完整还原（主路径） */
const restoreCounts = computed(
  () => preview.value?.restore?.counts || { create: 0, update: 0, skip: 0, remove: 0, revive: 0 }
)
/** 合并口径：只新增 / 覆盖 */
const mergeCounts = computed(() => preview.value?.plan?.counts || { create: 0, update: 0, skip: 0 })

/** 会写回本机的条数（新增 + 覆盖 + 复活，对用户来说都是「恢复」） */
const writeCount = computed(() => restoreCounts.value.create + restoreCounts.value.update)
const removeCount = computed(() => restoreCounts.value.remove)
const reviveCount = computed(() => restoreCounts.value.revive)
const mergeWorkCount = computed(() => mergeCounts.value.create + mergeCounts.value.update)

/**
 * 两个按钮的「无事可做」判据不同：
 *   - 恢复无事可做 = 写入 0 且清除 0；
 *   - 合并无事可做 = 新增 0 且覆盖 0（它本来就不清除，所以不看清除数）。
 */
const noRestoreWork = computed(() => writeCount.value === 0 && removeCount.value === 0)
const noMergeWork = computed(() => mergeWorkCount.value === 0)

/** 备份是谁在什么时候导出的 —— 恢复确认框里最重要的两句话 */
const ownerText = computed(() => {
  const label = preview.value?.backup?.account?.label || ''
  if (!label) return '本机'
  return label === account.label ? `本账号 ${label}` : `账号 ${label}`
})
const exportedText = computed(() => formatFullTimeCN(preview.value?.backup?.exportedAt))

/**
 * 二次确认的正文。用户要判断的是「这一刻之后我记的账值不值得丢」，
 * 所以必须给出**精确到秒的时刻**与**具体条数**，不能只说「可能会丢失数据」。
 */
const restoreMessage = computed(() => {
  const effect = []
  if (writeCount.value) effect.push(`写回备份里的 ${writeCount.value} 条`)
  if (reviveCount.value) effect.push(`其中 ${reviveCount.value} 条是本机已删除的账单，会一并找回`)
  if (removeCount.value) effect.push(`清除本机多出的 ${removeCount.value} 条`)

  return [
    `这是${ownerText.value}在 ${exportedText.value || '未知时刻'} 导出的旧数据。`,
    `恢复会清除这个时刻之后更新的数据${effect.length ? `：${effect.join('，')}` : ''}。`,
    '此操作不可撤销，是否继续？'
  ].join('\n')
})

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
  restoreAsk.value = false
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

/** 两种模式写完后要做的事一模一样：刷新切片 + 收尾 + 提示同步状态 */
async function runImport(mode) {
  busy.value = true
  try {
    const result = await applyImport({ mode, data: preview.value.backup.data })

    // 两份切片都要刷：首页用 month/bills/summary，账单页与统计页用 period*
    await Promise.all([
      billStore.refresh(),
      billStore.refreshPeriod(),
      categoryStore.ensureLoaded(true)
    ])

    const parts = []
    if (result.created) parts.push(`新增 ${result.created}`)
    if (result.updated) parts.push(`${mode === 'restore' ? '恢复' : '更新'} ${result.updated}`)
    if (result.removed) parts.push(`清除 ${result.removed}`)
    const tail = parts.length ? '' : '（没有变化）'
    toast.success(`${mode === 'restore' ? '已恢复' : '导入完成'}：${parts.join('、')}${tail}`)

    if (account.signedIn !== true) {
      // 没登录 ⇒ 数据只在本地，说清楚，免得用户以为已经云备份了
      toast.show('数据已存到本机；登录后会自动同步到云端')
    }

    preview.value = null
    pickedName.value = ''
    await refreshStats()
  } catch (e) {
    toast.show(`${mode === 'restore' ? '恢复' : '导入'}失败：${e?.message || e}`)
  } finally {
    busy.value = false
  }
}

/**
 * **恢复**（主路径，不可逆）：先弹二次确认，把「这是哪一刻的旧数据、会动什么」
 * 说清楚，用户确认后才执行。确认走 `ConfirmDialog` 的 confirm 事件。
 */
function askRestore() {
  if (!preview.value || busy.value) return
  if (noRestoreWork.value) {
    toast.show('本机数据已经与这份备份一致，无需恢复')
    return
  }
  restoreAsk.value = true
}

function doRestore() {
  if (!preview.value || busy.value) return
  runImport('restore')
}

/** **仅合并**（保守路径）：只新增 / 覆盖，不删本机任何数据 */
function doMerge() {
  if (!preview.value || busy.value) return
  if (noMergeWork.value) {
    toast.show('这份备份的内容本机已经有了，没有需要合并的')
    return
  }
  runImport('merge')
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
          选择之前导出的备份文件，先看看会恢复哪些内容，再决定要不要导入。
        </div>

        <div v-else class="preview">
          <p class="preview-file">{{ pickedName }}</p>
          <p class="preview-when">{{ ownerText }} · {{ exportedText }} 导出</p>
          <ul class="preview-list">
            <li>
              <em>恢复</em>
              <span class="strong">{{ writeCount }} 条</span>
            </li>
            <li>
              <em>清除</em>
              <span :class="{ danger: removeCount > 0 }">{{ removeCount }} 条</span>
            </li>
          </ul>
          <p v-if="reviveCount" class="note tight">
            其中 {{ reviveCount }} 条是本机已删除的账单，会一并找回。
          </p>
          <p v-if="removeCount" class="note tight">
            「清除」= 本机有、这份备份里没有的记录，恢复后会从账上消失。
          </p>
          <p v-if="noRestoreWork" class="note tight">本机数据已经与这份备份一致，无需恢复。</p>
          <p v-if="invalidText" class="warn">{{ invalidText }}</p>
        </div>

        <div class="actions">
          <button class="ghost" type="button" :disabled="busy" @click="pickFile">选择备份文件</button>
          <button
            v-if="preview"
            class="primary"
            type="button"
            :disabled="busy || noRestoreWork"
            @click="askRestore"
          >
            恢复到此备份
          </button>
        </div>

        <button v-if="preview && !noMergeWork" class="link" type="button" :disabled="busy" @click="doMerge">
          仅合并：只新增和更新，不删除本机任何数据
        </button>
      </section>
    </div>

    <ConfirmDialog
      v-model="restoreAsk"
      title="恢复到此备份？"
      :message="restoreMessage"
      confirm-text="恢复"
      cancel-text="取消"
      danger
      :mask-closable="false"
      @confirm="doRestore"
    />
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

.danger {
  color: var(--danger);
}

/** 次级入口（「仅合并」）：不做成按钮，避免与主按钮抢注意力 */
.link {
  width: 100%;
  margin-top: 12px;
  padding: 6px 0;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--ink-3);
  text-decoration: underline;
  text-underline-offset: 3px;
}

.link:disabled {
  opacity: 0.45;
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

.preview-when {
  margin-top: 4px;
  font-size: 12px;
  color: var(--ink-3);
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
