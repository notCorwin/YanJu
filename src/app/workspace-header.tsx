import { IconButton } from '@/components/shared'
import type { Archive } from '@/lib/types'
import {
  BookOpen,
  FolderOpen,
  Home,
  Settings2,
  SlidersHorizontal,
  VenetianMask,
} from 'lucide-react'

import type { WorkspaceDialog } from './types'

export function WorkspaceHeader({
  busy,
  chatting,
  archive,
  onHome,
  onOpenDialog,
}: {
  busy: boolean
  chatting: boolean
  archive?: Archive
  onHome: () => void
  onOpenDialog: (value: WorkspaceDialog) => void
}) {
  return (
    <header className="surface relative z-10 flex shrink-0 flex-wrap items-center justify-between gap-2 border-b-(length:--border-width) px-3 py-2 sm:px-6">
      <div className="flex min-w-0 items-center gap-3">
        <IconButton label="返回首页" onClick={onHome} disabled={busy}>
          <Home data-icon="inline-start" />
        </IconButton>
        <div className="min-w-0">
          <h1 className="text-lg text-primary">
            盐焗
            <span className="ml-2 font-serif text-sm italic text-muted-foreground">YanJu</span>
          </h1>
          <p className="truncate text-xs text-muted-foreground">
            {chatting ? archive?.name || '存档未找到' : 'Abyss & Desire'}
          </p>
        </div>
      </div>
      <nav className="flex items-center gap-1" aria-label="应用操作">
        <IconButton label="渠道管理" onClick={() => onOpenDialog('channels')}>
          <SlidersHorizontal data-icon="inline-start" />
        </IconButton>
        <IconButton label="人设管理" onClick={() => onOpenDialog('personas')}>
          <VenetianMask data-icon="inline-start" />
        </IconButton>
        <IconButton label="存档管理" onClick={() => onOpenDialog('archives')}>
          <FolderOpen data-icon="inline-start" />
        </IconButton>
        <IconButton label="外观设置" onClick={() => onOpenDialog('appearance')}>
          <Settings2 data-icon="inline-start" />
        </IconButton>
        {!chatting && (
          <IconButton label="世界与音乐" onClick={() => onOpenDialog('world')}>
            <BookOpen data-icon="inline-start" />
          </IconButton>
        )}
      </nav>
    </header>
  )
}
