import electron from 'electron'
import type { BrowserWindow, MessageBoxOptions } from 'electron'

export type NativeConfirmationOptions = {
  title: string
  message: string
  detail?: string
  confirmLabel: string
}

const electronDialog = (electron as { dialog?: typeof import('electron').dialog }).dialog

function dialogOptions(options: NativeConfirmationOptions): MessageBoxOptions {
  return {
    type: 'warning',
    buttons: ['Cancel', options.confirmLabel],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: options.title,
    message: options.message,
    detail: options.detail,
  }
}

export async function showNativeConfirmation(
  window: BrowserWindow | null,
  options: NativeConfirmationOptions,
) {
  if (!electronDialog?.showMessageBox) return false
  const boxOptions = dialogOptions(options)
  const result = window && !window.isDestroyed()
    ? await electronDialog.showMessageBox(window, boxOptions)
    : await electronDialog.showMessageBox(boxOptions)
  return result.response === 1
}
