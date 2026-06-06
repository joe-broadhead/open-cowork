import type { AppAPI } from '@open-cowork/shared'
import { asRecord } from './react-workbench-controller.ts'

async function fileAsBase64(file: File) {
  const buffer = await file.arrayBuffer()
  let binary = ''
  const bytes = new Uint8Array(buffer)
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.slice(offset, offset + chunkSize))
  }
  return btoa(binary)
}

export async function cloudProjectSourceFromForm(api: AppAPI, form: HTMLFormElement, formData: FormData) {
  const repositoryUrl = String(formData.get('repositoryUrl') || '').trim()
  if (repositoryUrl) {
    return {
      kind: 'git',
      repositoryUrl,
      ref: String(formData.get('ref') || '').trim() || null,
      subdirectory: String(formData.get('subdirectory') || '').trim() || null,
      credentialRef: String(formData.get('credentialRef') || '').trim() || null,
    }
  }

  const fileInput = form.querySelector<HTMLInputElement>('input[name="snapshotFiles"]')
  const files = fileInput?.files ? Array.from(fileInput.files).slice(0, 250) : []
  if (!files.length) return null

  let byteCount = 0
  const uploadedFiles = []
  for (const file of files) {
    byteCount += file.size || 0
    uploadedFiles.push({
      path: file.webkitRelativePath || file.name,
      dataBase64: await fileAsBase64(file),
      byteCount: file.size || 0,
      mode: null,
    })
  }

  const uploaded = asRecord(await api.projectSources.uploadSnapshot({
    title: String(formData.get('snapshotTitle') || '').trim() || 'Browser upload',
    files: uploadedFiles,
    fileCount: uploadedFiles.length,
    byteCount,
  }))
  return uploaded.projectSource || null
}

export async function assertCloudProjectSourceAllowed(api: AppAPI, projectSource: unknown) {
  if (!projectSource) return
  const verdict = asRecord(await api.projectSources.validate({ projectSource }))
  if (verdict.allowed === false) {
    throw new Error(String(verdict.reason || 'Project source is blocked by policy.'))
  }
}
