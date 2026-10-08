import { db, type YanJuDatabase } from './db'

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
export const operationLockName = (name: string, archiveId: string) =>
  `yanju-session:${name}:${archiveId}`
const conflict = () => new Error('这个篇章正在另一个窗口操作，请等待完成后重试。')

async function openLease(
  archiveId: string,
  database: YanJuDatabase,
  reclaim: boolean,
): Promise<ArchiveOperation> {
  const owner = crypto.randomUUID()
  await database.transaction('rw', database.archives, database.operations, async () => {
    if (!(await database.archives.get(archiveId))) throw new Error('存档不存在。')
    const existing = await database.operations.get(archiveId)
    if (!reclaim && existing && existing.expiresAt > Date.now()) throw conflict()
    await database.operations.put({ archiveId, owner, expiresAt: Date.now() + leaseDuration })
  })
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
      await database.transaction('rw', database.operations, async () => {
        if ((await database.operations.get(archiveId))?.owner === owner)
          await database.operations.delete(archiveId)
      })
    },
  }
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
      operationLockName(database.name, archiveId),
      { ifAvailable: true },
      async (lock) => {
        if (!lock) throw conflict()
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
    leases.filter((lease) => lease.expiresAt > Date.now()).map((lease) => lease.archiveId),
  )
}
