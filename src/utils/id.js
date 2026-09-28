let seq = 0

/** 生成带前缀的唯一 id（本地优先，后续可由服务端 id 覆盖） */
export function uid(prefix = 'id') {
  seq += 1
  const rand = Math.random().toString(36).slice(2, 8)
  return `${prefix}_${Date.now().toString(36)}${seq.toString(36)}${rand}`
}

export function now() {
  return Date.now()
}
