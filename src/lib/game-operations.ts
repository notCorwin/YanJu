const active = new Map<string, Set<() => Promise<void>>>()
export function registerGameOperation(archiveId: string, stop: () => Promise<void>) {
  const operations = active.get(archiveId) ?? new Set()
  operations.add(stop)
  active.set(archiveId, operations)
  return () => {
    operations.delete(stop)
    if (!operations.size) active.delete(archiveId)
  }
}
export async function stopGameOperations(archiveId: string) {
  await Promise.all([...(active.get(archiveId) ?? [])].map((stop) => stop()))
}
