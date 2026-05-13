declare module '@journeyapps/wa-sqlite/src/examples/OPFSCoopSyncVFS.js' {
  import * as VFS from '@journeyapps/wa-sqlite/src/VFS.js'

  export class OPFSCoopSyncVFS extends VFS.Base {
    static create(name: string, module: unknown): Promise<OPFSCoopSyncVFS>
  }
}
