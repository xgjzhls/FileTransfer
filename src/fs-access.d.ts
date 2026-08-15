/**
 * TS7's lib.dom.d.ts is missing the File System Access API picker surface
 * (showDirectoryPicker / showOpenFilePicker) — Chrome-only APIs used for
 * folder sending (SPEC §6.3: 桌面 Chrome 用 File System Access 选文件夹).
 * FileSystemDirectoryHandle / FileSystemFileHandle / FileSystemHandle base
 * types already exist (used by OPFS storage); only the picker entry points
 * are missing.
 */
interface Window {
  showDirectoryPicker(options?: {
    id?: string
    mode?: 'read' | 'readwrite'
    startIn?: 'desktop' | 'documents' | 'downloads' | 'music' | 'pictures' | 'videos'
  }): Promise<FileSystemDirectoryHandle>
}
