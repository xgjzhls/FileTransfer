/**
 * TS7's lib.dom.d.ts is missing the OPFS sync-access-handle API
 * (FileSystemSyncAccessHandle / createSyncAccessHandle) — WebKit-only surface
 * that Safari exposes on iOS/macOS. Runtime support exists (Safari 15.2+);
 * these declarations only fill the type gap.
 */
interface FileSystemSyncAccessHandle {
  read(buffer: ArrayBuffer | ArrayBufferView, options?: { at?: number }): number
  write(buffer: ArrayBuffer | ArrayBufferView, options?: { at?: number }): number
  truncate(size: number): void
  getSize(): number
  flush(): void
  close(): void
}

interface FileSystemFileHandle {
  createSyncAccessHandle(): Promise<FileSystemSyncAccessHandle>
}
