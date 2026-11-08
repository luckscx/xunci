const ADJ = ['路过的', '好奇的', '刚睡醒的', '摸鱼的', '慢半拍的', '偷偷卷的', '爱凑热闹的', '不爱说话的', '迷路的', '打瞌睡的']
const ANIMAL = ['橘猫', '水獭', '小熊猫', '刺猬', '企鹅', '柴犬', '仓鼠', '章鱼', '浣熊', '羊驼']
const pick = (arr: string[]) => arr[Math.floor(Math.random() * arr.length)]

export function randomName(): string {
  return `${pick(ADJ)}${pick(ANIMAL)}`
}
