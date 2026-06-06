import { createElement } from 'react'

export type CloudReactSsrShellProps = {
  shellHtml: string
}

export function CloudReactSsrShell({ shellHtml }: CloudReactSsrShellProps) {
  return createElement('div', {
    'data-cloud-react-shell': 'ssr',
    suppressHydrationWarning: true,
    dangerouslySetInnerHTML: { __html: shellHtml },
  })
}
