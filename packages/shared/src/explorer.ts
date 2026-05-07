// Contract between the main-process explorer handlers and the renderer's
// Explorer panel. Names mirror the SDK's FileNode / FileContent / File /
// Symbol shapes but normalized (camelCase, flattened ranges, stable arrays)
// so the renderer never touches SDK snake_case.

export interface FileNode {
  name: string
  path: string
  absolute: string
  type: 'file' | 'directory'
  ignored: boolean
}

export interface FileContent {
  type: 'text' | 'binary'
  content: string
  diff?: string | null
  patch?: string | null
  encoding?: string | null
}

export interface FileStatus {
  path: string
  added: number
  removed: number
  status: 'added' | 'deleted' | 'modified'
}

export interface ExplorerRangePos {
  line: number
  col: number
}

export interface ExplorerSymbol {
  name: string
  kind: number
  path: string
  range: {
    start: ExplorerRangePos
    end: ExplorerRangePos
  }
}

export interface TextMatch {
  path: string
  lineNumber: number
  lineText: string
  submatches: Array<{ text: string; start: number; end: number }>
}

export interface FindFilesOptions {
  query: string
  dirs?: boolean
  type?: 'file' | 'directory'
  limit?: number
}
