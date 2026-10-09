import { db, type YanJuDatabase } from './storage'

export interface OperationLease {
  archiveId: string
  owner: string
  expiresAt: number
}
export interface ArchiveOperation {
  owner: string
  release: () => Promise<void>
}
const leaseDuration = 90_000
// Imported archive IDs are nonempty, so this key cannot collide with an archive lease.
const importLeaseId = ''
const importLockName = (name: string) => `yanju-import:${name}`
export const operationLockName = (name: string, archiveId: string) =>
  `yanju-session:${name}:${archiveId}`
const conflict = () => new Error('这个篇章正在另一个窗口操作，请等待完成后重试。')
const importConflict = () => new Error('另一个窗口正在导入存档，请等待完成后重试。')

/** A save slot copies a consistent view without stopping an active generation. */
export async function withSnapshotOperation<T>(
  action: () => Promise<T>,
  database = db,
): Promise<T> {
  const run = async () => {
    const lease = await database.operations.get(importLeaseId)
    if (lease && lease.expiresAt > Date.now()) throw importConflict()
    return action()
  }
  if (!navigator.locks?.request) return run()
  return navigator.locks.request(
    importLockName(database.name),
    { mode: 'shared', ifAvailable: true },
    (lock) => {
      if (!lock) throw importConflict()
      return run()
    },
  )
}

function maintainLease(
  archiveId: string,
  owner: string,
  database: YanJuDatabase,
): ArchiveOperation {
  const heartbeat = setInterval(() => {
    void database
      .transaction('rw', database.operations, async () => {
        const lease = await database.operations.get(archiveId)
        if (lease?.owner === owner)
          await database.operations.update(archiveId, { expiresAt: Date.now() + leaseDuration })
      })
      .catch(() => undefined)
  }, 20_000)
  return {
    owner,
    release: async () => {
      clearInterval(heartbeat)
      await database.transaction('rw', [...database.gameTables, database.operations], async () => {
        if ((await database.operations.get(archiveId))?.owner === owner)
          await database.operations.delete(archiveId)
      })
    },
  }
}

async function openLease(
  archiveId: string,
  database: YanJuDatabase,
  reclaim: boolean,
): Promise<ArchiveOperation> {
  const owner = crypto.randomUUID()
  // Reject immediately while an import writes archives, before queuing for its transaction.
  const importing = await database.operations.get(importLeaseId)
  if (importing && importing.expiresAt > Date.now()) throw importConflict()
  await database.transaction(
    'rw',
    [...database.gameTables, database.archives, database.operations],
    async () => {
      // An import can start between the fast check above and this atomic lease acquisition.
      const importing = await database.operations.get(importLeaseId)
      if (importing && importing.expiresAt > Date.now()) throw importConflict()
      if (!(await database.archives.get(archiveId))) throw new Error('存档不存在。')
      const existing = await database.operations.get(archiveId)
      if (!reclaim && existing && existing.expiresAt > Date.now()) throw conflict()
      await database.operations.put({ archiveId, owner, expiresAt: Date.now() + leaseDuration })
    },
  )
  return maintainLease(archiveId, owner, database)
}

async function openImportLease(database: YanJuDatabase): Promise<ArchiveOperation> {
  const owner = crypto.randomUUID()
  await database.transaction('rw', [...database.gameTables, database.operations], async () => {
    if ((await database.operations.toArray()).some((lease) => lease.expiresAt > Date.now()))
      throw new Error('另一个窗口正在操作存档，请等待完成后导入。')
    await database.operations.put({
      archiveId: importLeaseId,
      owner,
      expiresAt: Date.now() + leaseDuration,
    })
  })
  return maintainLease(importLeaseId, owner, database)
}

export async function withImportOperation<T>(action: () => Promise<T>, database = db): Promise<T> {
  const run = async () => {
    // Commit the marker before the import transaction, and remove it in a later transaction.
    // Archive operations queued behind the import therefore still see the marker and reject.
    const lease = await openImportLease(database)
    try {
      return await action()
    } finally {
      await lease.release()
    }
  }
  if (!navigator.locks?.request) return run()
  return navigator.locks.request(importLockName(database.name), { ifAvailable: true }, (lock) => {
    if (!lock) throw new Error('另一个窗口正在操作存档，请等待完成后导入。')
    return run()
  })
}

export async function acquireArchiveOperation(
  archiveId: string,
  database = db,
): Promise<ArchiveOperation> {
  if (!navigator.locks?.request) return openLease(archiveId, database, false)
  return new Promise<ArchiveOperation>((resolve, reject) => {
    let unlock!: () => void
    const held = new Promise<void>((release) => {
      unlock = release
    })
    const completed = navigator.locks.request(
      importLockName(database.name),
      { mode: 'shared', ifAvailable: true },
      async (lock) => {
        if (!lock) throw importConflict()
        await navigator.locks.request(
          operationLockName(database.name, archiveId),
          { ifAvailable: true },
          async (archiveLock) => {
            if (!archiveLock) throw conflict()
            const lease = await openLease(archiveId, database, true)
            resolve({
              owner: lease.owner,
              release: async () => {
                unlock()
                await completed
              },
            })
            try {
              await held
            } finally {
              await lease.release()
            }
          },
        )
      },
    )
    void completed.catch(reject)
  })
}

export async function withArchiveOperation<T>(
  archiveId: string,
  action: (operation: ArchiveOperation) => Promise<T>,
  database = db,
): Promise<T> {
  const operation = await acquireArchiveOperation(archiveId, database)
  try {
    return await action(operation)
  } finally {
    await operation.release()
  }
}

/** A second tab must not mark the first tab's in-flight checkpoints as interrupted. */
export async function activeArchiveOperations(database: YanJuDatabase): Promise<Set<string>> {
  const leases = await database.operations.toArray()
  if (navigator.locks?.query) {
    const state = await navigator.locks.query()
    const held = new Set(state.held?.map((lock) => lock.name))
    return new Set(
      leases
        .filter((lease) => held.has(operationLockName(database.name, lease.archiveId)))
        .map((lease) => lease.archiveId),
    )
  }
  return new Set(
    leases
      .filter((lease) => lease.archiveId !== importLeaseId && lease.expiresAt > Date.now())
      .map((lease) => lease.archiveId),
  )
}
