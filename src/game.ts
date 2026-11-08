export type Temp = { label: string; desc: string; hue: number }

export function tempOf(pct: number): Temp {
  if (pct >= 100) return { label: '蹭到了', desc: '就是这个词，一分不多', hue: 6 }
  if (pct >= 95) return { label: '烫到极限', desc: '就差一个字，换个说法', hue: 10 }
  if (pct >= 81) return { label: '烧起来了', desc: '答案就在这条线上', hue: 16 }
  if (pct >= 66) return { label: '很烫', desc: '顺着这个方向往里挖', hue: 28 }
  if (pct >= 51) return { label: '有点烫', desc: '方向对了，还差一层', hue: 42 }
  if (pct >= 36) return { label: '温热', desc: '蹭到边了', hue: 60 }
  if (pct >= 21) return { label: '微热', desc: '只是远亲', hue: 90 }
  if (pct > 8) return { label: '凉', desc: '热度还没传过来', hue: 150 }
  return { label: '没蹭到', desc: '一点边都不沾', hue: 205 }
}
