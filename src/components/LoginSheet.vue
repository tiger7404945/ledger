<script setup>
/**
 * 全局手机号登录弹层（S7-4）
 * ------------------------------------------------------------
 * 从 `MineView.vue` 里迁出来，**只保留登录模式**（原来的「匿名转正」分支
 * 随 S7 一起删除）。它是全局单例，挂在 `App.vue` 上，被下面三处共用：
 *
 *   - 「我的」页的「登录 / 注册」按钮；
 *   - 写操作门禁（`useLoginGate`）：未登录去记一笔 / 改分类；
 *   - 路由守卫：未登录直接进 `/record` 或 `/category*`。
 *
 * 状态的唯一来源是 `useLoginSheet.js`（模块级单例），第三处调用时把
 * 「登录成功后要做什么」登记进去，登录完由这里接着执行。
 */
import { computed, ref, watch } from 'vue'
import { useAccountStore } from '@/stores/account.js'
import { useToast } from '@/composables/useToast.js'
import { useLoginSheet } from '@/composables/useLoginSheet.js'
import IconBase from '@/components/icons/IconBase.vue'

const account = useAccountStore()
const toast = useToast()
const { state: sheet, close: closeSheet, resolve: resolveSheet } = useLoginSheet()

const formPhone = ref('')
const formCode = ref('')
const codeSent = ref(false)
const countdown = ref(0)
/**
 * 发码返回的 `{ verification_id, is_user }`。
 * ⚠️ 登录时必须带回去 —— 它是服务端用来配对「这条验证码属于哪次请求」的凭据，
 *    丢了 `signInWithSms` 内部的 verify() 会因 verification_id 为空而失败。
 */
const verificationInfo = ref(null)
let countdownTimer = null

const canSubmit = computed(
  () => /^1[3-9]\d{9}$/.test(formPhone.value) && formCode.value.length >= 4 && !account.busy
)

const hint = computed(() => sheet.reason || '登录后可在多台设备之间同步账目。')

function stopCountdown() {
  if (countdownTimer) {
    clearInterval(countdownTimer)
    countdownTimer = null
  }
  countdown.value = 0
}

function resetForm() {
  formPhone.value = ''
  formCode.value = ''
  codeSent.value = false
  verificationInfo.value = null
  stopCountdown()
}

/** 每次打开都是一张干净的表单（上一次的手机号/验证码不该留着） */
watch(
  () => sheet.open,
  (open) => {
    if (!open) return
    resetForm()
    account.error = null
  }
)

function handleClose() {
  closeSheet()
  stopCountdown()
  account.error = null
}

async function sendCode() {
  if (!/^1[3-9]\d{9}$/.test(formPhone.value)) {
    toast.show('请输入正确的手机号')
    return
  }
  try {
    const res = await account.sendCode(formPhone.value)
    verificationInfo.value = res?.verificationInfo || null
    codeSent.value = true
    countdown.value = 60
    stopCountdown()
    countdownTimer = setInterval(() => {
      countdown.value -= 1
      if (countdown.value <= 0) stopCountdown()
    }, 1000)
    toast.success('验证码已发送')
  } catch (e) {
    toast.show(`发送失败：${e?.message || e}`)
  }
}

async function submit() {
  if (!canSubmit.value) return
  try {
    await account.signInWithPhone({
      phone: formPhone.value,
      code: formCode.value,
      verificationInfo: verificationInfo.value
    })
    toast.success('登录成功')
    stopCountdown()
    // 关弹层 + 执行门禁登记的那件事（如果有）。
    // 数据刷新由 account store 的 runIdentityChange 统一负责（它会作废各
    // store 的已加载标记并同步一轮），这里不用再补。
    await resolveSheet()
  } catch (e) {
    toast.show(`登录失败：${e?.message || e}`)
  }
}
</script>

<template>
  <Teleport to="body">
    <div v-if="sheet.open" class="sheet-mask" @click.self="handleClose">
      <div class="sheet">
        <header class="sheet-head">
          <span class="sheet-title">手机号登录</span>
          <button class="sheet-close" type="button" @click="handleClose">
            <IconBase name="close" :size="17" />
          </button>
        </header>
        <p class="sheet-desc">{{ hint }}</p>

        <label class="field">
          <span class="field-label">手机号</span>
          <input
            v-model.trim="formPhone"
            class="field-input"
            type="tel"
            inputmode="numeric"
            maxlength="11"
            placeholder="请输入 11 位手机号"
          />
        </label>

        <label class="field">
          <span class="field-label">验证码</span>
          <span class="field-code">
            <input
              v-model.trim="formCode"
              class="field-input"
              type="text"
              inputmode="numeric"
              maxlength="6"
              placeholder="6 位验证码"
            />
            <button
              class="code-btn"
              type="button"
              :disabled="countdown > 0 || !/^1[3-9]\d{9}$/.test(formPhone)"
              @click="sendCode"
            >
              {{ countdown > 0 ? `${countdown}s` : codeSent ? '重新发送' : '获取验证码' }}
            </button>
          </span>
        </label>

        <p v-if="account.error" class="sheet-error">{{ account.error }}</p>

        <button class="submit" type="button" :disabled="!canSubmit" @click="submit">
          {{ account.busy ? '处理中…' : '登录' }}
        </button>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.sheet-mask {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  background: rgba(0, 0, 0, 0.35);
}

.sheet {
  width: min(var(--frame-w), 100%);
  padding: 18px 20px calc(20px + var(--safe-b));
  border-radius: 18px 18px 0 0;
  background: var(--surface-raised, #fff);
}

.sheet-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.sheet-title {
  font-size: 16px;
  font-weight: 600;
}

.sheet-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  color: var(--ink-3);
}

.sheet-desc {
  margin-top: 6px;
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--ink-3);
}

.field {
  display: block;
  margin-top: 14px;
}

.field-label {
  display: block;
  margin-bottom: 6px;
  font-size: 12.5px;
  color: var(--ink-3);
}

.field-input {
  width: 100%;
  height: 44px;
  padding: 0 14px;
  border-radius: var(--r-md);
  background: var(--surface-3);
  font-size: 15px;
  color: var(--ink);
}

.field-code {
  display: flex;
  align-items: center;
  gap: 8px;
}

.field-code .field-input {
  flex: 1;
}

.code-btn {
  flex: none;
  height: 44px;
  padding: 0 14px;
  border-radius: var(--r-md);
  background: var(--brand-soft);
  color: var(--brand-ink);
  font-size: 13px;
}

.code-btn:disabled {
  opacity: 0.45;
}

.sheet-error {
  margin-top: 10px;
  font-size: 12.5px;
  color: #d94a3d;
}

.submit {
  width: 100%;
  height: 46px;
  margin-top: 18px;
  border-radius: var(--r-pill);
  background: var(--brand);
  color: #fff;
  font-size: 15px;
  font-weight: 500;
}

.submit:disabled {
  opacity: 0.45;
}
</style>
