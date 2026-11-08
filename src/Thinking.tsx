/** 思考中的遮罩：只在「慢请求」时出现（>300ms），铺满全屏把其他操作挡住 */
export default function Thinking({ show, label = '思考中' }: { show: boolean; label?: string }) {
  if (!show) return null
  return (
    <div className="thinking" role="status" aria-live="polite" aria-busy="true">
      <div className="thinking-card">
        <i className="thinking-ring" aria-hidden />
        <span>{label}…</span>
      </div>
    </div>
  )
}
