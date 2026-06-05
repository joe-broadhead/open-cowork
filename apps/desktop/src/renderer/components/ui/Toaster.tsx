import { Toaster as SharedToaster } from '@open-cowork/ui'
import { useSessionStore } from '../../stores/session'

export {
  toast,
  type ToastAction,
  type ToastOptions,
  type ToastSourceError,
  type ToastTone,
} from '@open-cowork/ui'

export function Toaster() {
  const globalErrors = useSessionStore((state) => state.globalErrors)
  const dismissGlobalError = useSessionStore((state) => state.dismissGlobalError)

  return (
    <SharedToaster
      errors={globalErrors}
      onDismissError={dismissGlobalError}
    />
  )
}
