import { useCallback, useState } from 'react'
import { loadHistory, saveHistory } from './chat-input-utils'

export function usePromptHistory() {
  const [historyIndex, setHistoryIndex] = useState(-1)
  const [savedCurrent, setSavedCurrent] = useState('')

  const recordPrompt = useCallback((text: string) => {
    if (text) {
      const history = loadHistory()
      const filtered = history.filter((entry) => entry !== text)
      saveHistory([text, ...filtered])
    }
    setHistoryIndex(-1)
    setSavedCurrent('')
  }, [])

  const navigate = useCallback(
    (direction: 'up' | 'down', input: string, textarea: HTMLTextAreaElement | null) => {
      if (!textarea) return { handled: false, value: input }

      const isAtStart = textarea.selectionStart === 0 && textarea.selectionEnd === 0
      const isAtEnd = textarea.selectionStart === input.length

      if (direction === 'up') {
        if (!isAtStart) return { handled: false, value: input }
        const history = loadHistory()
        if (history.length === 0) return { handled: false, value: input }
        if (historyIndex === -1) setSavedCurrent(input)
        const newIndex = Math.min(historyIndex + 1, history.length - 1)
        setHistoryIndex(newIndex)
        return { handled: true, value: history[newIndex] }
      }

      if (!isAtEnd || historyIndex < 0) {
        return { handled: false, value: input }
      }
      const newIndex = historyIndex - 1
      setHistoryIndex(newIndex)
      return {
        handled: true,
        value: newIndex < 0 ? savedCurrent : loadHistory()[newIndex],
      }
    },
    [historyIndex, savedCurrent],
  )

  return {
    recordPrompt,
    navigate,
  }
}
