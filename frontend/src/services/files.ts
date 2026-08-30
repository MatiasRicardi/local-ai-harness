export interface AttachedDocument {
  fileId: string
  originalFilename: string
  size: number
  type: string
  text: string
  characterCount: number
  warnings: string[]
  pageCount?: number
}

export interface FileUploadResponse {
  success: true
  fileId: string
  originalFilename: string
  size: number
  type: string
  extraction: {
    text: string
    characterCount: number
    warnings: string[]
    pageCount?: number
  }
}

export interface FileUploadError {
  success: false
  error: string
}

const API_BASE = import.meta.env.VITE_API_URL ?? "http://127.0.0.1:3000"

export function isSupportedExtension(filename: string): boolean {
  const ext = filename.slice(filename.lastIndexOf(".")).toLowerCase()
  return [".txt", ".md", ".pdf"].includes(ext)
}

export async function uploadDocument(
  file: File,
): Promise<AttachedDocument> {
  const formData = new FormData()
  formData.append("file", file)

  const response = await fetch(`${API_BASE}/api/files`, {
    method: "POST",
    body: formData,
  })

  if (!response.ok) {
    const body = await response.json().catch(() => ({}))
    const message = (body as { error?: string }).error ?? "Upload failed."
    throw new Error(message)
  }

  const data = (await response.json()) as FileUploadResponse

  return {
    fileId: data.fileId,
    originalFilename: data.originalFilename,
    size: data.size,
    type: data.type,
    text: data.extraction.text,
    characterCount: data.extraction.characterCount,
    warnings: data.extraction.warnings ?? [],
    pageCount: data.extraction.pageCount,
  }
}
