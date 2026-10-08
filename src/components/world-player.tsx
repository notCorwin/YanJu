import { useRef, useState } from 'react'
import world from '@/content/world.json'
import commands from '@/content/commands.json'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from './ui/sheet'
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs'
import { Accordion, AccordionItem, AccordionTrigger, AccordionContent } from './ui/accordion'
import { Card, CardHeader, CardTitle, CardContent } from './ui/card'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { IconButton, Prose } from './shared'
import type { Notify } from './managers'
import { Pause, Play, SkipBack, SkipForward, Copy, Repeat, Music2 } from 'lucide-react'

const tracks = [
  ['熄灭', 'ximie'],
  ['true', 'true'],
  ['Stay with me', 'staywithme'],
  ['来自天堂的魔鬼', 'mogui'],
  ['A.I.N.Y 爱你', 'ainy'],
].map(([name, file]) => ({
  name,
  url: `https://cdn.jsdelivr.net/gh/hmt20061008-oss/music@main/${file}.mp3`,
}))
const time = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

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
  const audio = useRef<HTMLAudioElement>(null)
  const [index, setIndex] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [duration, setDuration] = useState(0)
  const [repeatOne, setRepeatOne] = useState(false)
  const play = async () => {
    try {
      await audio.current?.play()
    } catch {
      notify('音乐暂时无法播放，请检查网络后重试。', true)
    }
  }
  const switchTrack = (next: number) => {
    const value = (next + tracks.length) % tracks.length
    setIndex(value)
    setElapsed(0)
    if (audio.current) {
      audio.current.src = tracks[value].url
      void play()
    }
  }
  return (
    <>
      <audio
        ref={audio}
        src={tracks[0].url}
        preload="none"
        onTimeUpdate={() => setElapsed(audio.current?.currentTime ?? 0)}
        onLoadedMetadata={() =>
          setDuration(Number.isFinite(audio.current?.duration) ? audio.current!.duration : 0)
        }
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          if (repeatOne && audio.current) {
            audio.current.currentTime = 0
            void play()
          } else switchTrack(index + 1)
        }}
        onError={() => {
          setPlaying(false)
          notify('音乐资源加载失败，可切换曲目或稍后重试。', true)
        }}
      />
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
              <Accordion type="multiple" defaultValue={['0']}>
                {world.map((item, i) => (
                  <AccordionItem key={i} value={String(i)}>
                    <AccordionTrigger>{item.label}</AccordionTrigger>
                    <AccordionContent>
                      <Prose text={item.text} />
                    </AccordionContent>
                  </AccordionItem>
                ))}
              </Accordion>
            </TabsContent>
            <TabsContent value="commands" className="flex flex-col gap-3">
              {commands.map((c, i) => (
                <Card key={i} size="sm">
                  <CardHeader>
                    <CardTitle>{c.name}</CardTitle>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-3">
                    <Prose text={c.text} />
                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant="outline"
                        onClick={() => {
                          onInsert(c.text)
                          onClose()
                        }}
                      >
                        填入聊天
                      </Button>
                      <IconButton
                        label={`复制${c.name}`}
                        onClick={() =>
                          void navigator.clipboard.writeText(c.text).then(
                            () => notify('指令已复制。'),
                            () => notify('复制失败，可以使用「填入聊天」。', true),
                          )
                        }
                      >
                        <Copy />
                      </IconButton>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </TabsContent>
            <TabsContent value="music" className="flex flex-col gap-4">
              <Card>
                <CardHeader>
                  <Music2 className="size-8 text-primary" />
                  <CardTitle>{tracks[index].name}</CardTitle>
                </CardHeader>
                <CardContent className="flex flex-col gap-4">
                  <div className="flex justify-center gap-3">
                    <IconButton label="上一曲" onClick={() => switchTrack(index - 1)}>
                      <SkipBack />
                    </IconButton>
                    <IconButton
                      label={playing ? '暂停音乐' : '播放音乐'}
                      variant="secondary"
                      onClick={() => (playing ? audio.current?.pause() : void play())}
                    >
                      {playing ? <Pause /> : <Play />}
                    </IconButton>
                    <IconButton label="下一曲" onClick={() => switchTrack(index + 1)}>
                      <SkipForward />
                    </IconButton>
                    <IconButton
                      label={repeatOne ? '切换到列表循环' : '切换到单曲循环'}
                      variant={repeatOne ? 'secondary' : 'ghost'}
                      onClick={() => setRepeatOne((v) => !v)}
                    >
                      <Repeat />
                    </IconButton>
                  </div>
                  <label className="sr-only" htmlFor="music-progress">
                    播放进度
                  </label>
                  <Input
                    id="music-progress"
                    type="range"
                    min={0}
                    max={duration || 1}
                    step={0.1}
                    value={elapsed}
                    onChange={(e) => {
                      const t = Number(e.target.value)
                      if (audio.current) audio.current.currentTime = t
                      setElapsed(t)
                    }}
                  />
                  <p className="flex justify-between text-xs font-mono text-muted-foreground">
                    <span>{time(elapsed)}</span>
                    <span>{time(duration)}</span>
                  </p>
                  <label htmlFor="music-volume" className="text-sm">
                    音量
                  </label>
                  <Input
                    id="music-volume"
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    defaultValue={1}
                    onChange={(e) => {
                      if (audio.current) audio.current.volume = Number(e.target.value)
                    }}
                  />
                </CardContent>
              </Card>
              <div className="flex flex-col gap-2" aria-label="播放列表">
                {tracks.map((track, i) => (
                  <Button
                    key={track.name}
                    variant={i === index ? 'secondary' : 'ghost'}
                    className="justify-start"
                    onClick={() => switchTrack(i)}
                  >
                    {i === index && playing && <Music2 />}
                    {track.name}
                  </Button>
                ))}
              </div>
            </TabsContent>
          </Tabs>
        </SheetContent>
      </Sheet>
    </>
  )
}
