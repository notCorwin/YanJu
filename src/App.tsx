import { InitializationScreen } from '@/app/initialization-screen'
import { useStorageInitialization } from '@/app/use-storage-initialization'
import { Workspace } from '@/app/workspace'
import { Toaster } from '@/components/ui/sonner'

export default function App() {
  const { ready, failure } = useStorageInitialization()
  return (
    <>
      {ready ? <Workspace /> : <InitializationScreen failure={failure} />}
      <Toaster position="top-right" closeButton duration={6000} />
    </>
  )
}
