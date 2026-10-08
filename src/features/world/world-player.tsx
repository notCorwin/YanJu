import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import type { Notify } from '@/lib/types'
import { CommandsTab } from './commands-tab'
import { MusicTab } from './music-tab'
import { useAudioPlayer } from './use-audio-player'
import { WorldTab } from './world-tab'

export function WorldPlayer({
  open,
  onClose,
  notify,
  onInsert,
}: {
  open: boolean
  onClose: () => void
  notify: Notify
  onInsert: (text: string) => void
}) {
  const player = useAudioPlayer(notify)
  return (
    <>
      <audio {...player.audioProps} />
      <Sheet open={open} onOpenChange={(v) => !v && onClose()}>
        <SheetContent className="w-full overflow-y-auto sm:panel-width">
          <SheetHeader>
            <SheetTitle>世界与音乐</SheetTitle>
            <SheetDescription>背景资料、常用指令和此刻的配乐。</SheetDescription>
          </SheetHeader>
          <Tabs defaultValue="world" className="px-4">
            <TabsList className="w-full">
              <TabsTrigger value="world">世界</TabsTrigger>
              <TabsTrigger value="commands">指令</TabsTrigger>
              <TabsTrigger value="music">音乐</TabsTrigger>
            </TabsList>
            <TabsContent value="world">
              <WorldTab />
            </TabsContent>
            <TabsContent value="commands">
              <CommandsTab
                notify={notify}
                onInsert={(text) => {
                  onInsert(text)
                  onClose()
                }}
              />
            </TabsContent>
            <TabsContent value="music">
              <MusicTab player={player} />
            </TabsContent>
          </Tabs>
        </SheetContent>
      </Sheet>
    </>
  )
}
