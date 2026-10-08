import { InitializationScreen } from '@/app/initialization-screen'
import { useStorageInitialization } from '@/app/use-storage-initialization'
import { Workspace } from '@/app/workspace'
import { RecoveryBoundary } from '@/components/recovery-boundary'

export default function App() {
  const { ready, failure, restore } = useStorageInitialization()
  if (!ready || failure) return <InitializationScreen failure={failure} restore={restore} />
  return (
    <RecoveryBoundary title="界面暂时无法显示">
      <Workspace />
    </RecoveryBoundary>
  )
}
