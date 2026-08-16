/**
 * 原生导出桥工厂：把 folder-export 插件 facade 适配为 nativeExport 泵的
 * 最小接口（Home 与 SpikePage 探针共用，避免两处重复适配）。
 */
import { FolderExport } from 'folder-export'
import type { NativeExportBridge } from '../transfer/nativeExport'

export function createNativeExportBridge(): NativeExportBridge {
  return {
    mkdir: (o) => FolderExport.mkdir(o),
    writeChunk: (o) => FolderExport.writeChunk(o),
    writeTemp: (o) => FolderExport.writeTemp(o),
    abort: () => FolderExport.abort(),
  }
}
