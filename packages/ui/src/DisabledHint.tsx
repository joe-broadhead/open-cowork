import { Icon } from './Icon.js'
import { Tooltip } from './Tooltip.js'

export function DisabledHint({
  id,
  reason,
}: {
  id: string
  reason: string
}) {
  return (
    <Tooltip content={reason} side="bottom" delay={0}>
      <span id={id} className="ui-disabled-reason">
        <Icon name="info" size={16} />
        <span>{reason}</span>
      </span>
    </Tooltip>
  )
}
