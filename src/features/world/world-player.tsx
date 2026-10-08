import { IconButton, Prose } from '@/components/shared'
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import commands from '@/content/commands.json'
import world from '@/content/world.json'
import { tracks } from '@/lib/media'
import type { Notify } from '@/lib/notify'
import {
  Copy,
  LoaderCircle,
  Music2,
  Pause,
  Play,
  Repeat,
  SkipBack,
  SkipForward,
} from 'lucide-react'
import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { flushSync } from 'react-dom'

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
  const playAttempt = useRef(0)
  const focusAfterInsert = useRef(false)
  const [index, setIndex] = useState(0)
  const [tab, setTab] = useState('world')
  const [volume, setVolume] = useState(1)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [playing, setPlaying] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [duration, setDuration] = useState(0)
  const [repeatOne, setRepeatOne] = useState(false)
  useEffect(() => {
    const element = audio.current
    return () => {
      playAttempt.current += 1
      element?.pause()
    }
  }, [])
  const pause = () => {
    playAttempt.current += 1
    audio.current?.pause()
    if (loading && !duration && audio.current) {
      audio.current.removeAttribute('src')
      audio.current.load()
    }
    setPlaying(false)
    setLoading(false)
  }
  const play = async (source = tracks[index].url) => {
    const element = audio.current
    if (!element) return
    if (element.getAttribute('src') !== source) element.src = source
    const attempt = ++playAttempt.current
    let timeout: ReturnType<typeof setTimeout> | undefined
    setError('')
    setLoading(true)
    try {
      await Promise.race([
        element.play(),
        new Promise<void>((_, reject) => {
          timeout = setTimeout(() => {
            reject(new Error('音乐加载时间较长，请重试或切换曲目。'))
            if (attempt === playAttempt.current) element.pause()
          }, 20000)
        }),
      ])
    } catch (error) {
      if (
        attempt === playAttempt.current &&
        !(error instanceof DOMException && error.name === 'AbortError')
      )
        setError(
          error instanceof Error && error.message.startsWith('音乐加载时间较长')
            ? error.message
            : '音乐暂时无法播放，可以重试或切换曲目。',
        )
    } finally {
      clearTimeout(timeout)
      if (attempt === playAttempt.current) setLoading(false)
    }
  }
  const receiveTrack = useEffectEvent((detail: { id: string; play: boolean }) => {
    const next = tracks.findIndex((track) => track.id === detail.id)
    if (next < 0) return
    setIndex(next)
    setElapsed(0)
    if (audio.current) {
      audio.current.src = tracks[next].url
      if (detail.play) void play(tracks[next].url)
    }
  })
  useEffect(() => {
    const listener = (event: Event) =>
      receiveTrack((event as CustomEvent<{ id: string; play: boolean }>).detail)
    window.addEventListener('yanju-track', listener)
    return () => window.removeEventListener('yanju-track', listener)
  }, [])
  const switchTrack = (next: number) => {
    const value = (next + tracks.length) % tracks.length
    // Commit the media source before playing, within the activation gesture.
    flushSync(() => {
      setIndex(value)
      setElapsed(0)
      setDuration(0)
      setPlaying(false)
      setError('')
    })
    void play(tracks[value].url)
  }
  return (
    <>
      <audio
        ref={audio}
        src={tracks[index].url}
        preload="none"
        onTimeUpdate={() => setElapsed(audio.current?.currentTime ?? 0)}
        onLoadedMetadata={() =>
          setDuration(Number.isFinite(audio.current?.duration) ? audio.current!.duration : 0)
        }
        onPlay={() => setPlaying(true)}
        onPlaying={() => {
          setPlaying(true)
          setLoading(false)
          setError('')
        }}
        onWaiting={() => {
          if (!audio.current?.paused) setLoading(true)
        }}
        onPause={() => {
          setPlaying(false)
          setLoading(false)
        }}
        onEnded={() => {
          if (repeatOne && audio.current) {
            audio.current.currentTime = 0
            void play()
          } else switchTrack(index + 1)
        }}
        onError={() => {
          setPlaying(false)
          setLoading(false)
          setDuration(0)
          setError('音乐资源加载失败，可以重试、切换曲目或检查网络。')
        }}
      />
      <Sheet open={open} onOpenChange={(v) => !v && onClose()}>
        <SheetContent
          className="w-full overflow-hidden sm:panel-width safe-bottom"
          onCloseAutoFocus={(event) => {
            if (focusAfterInsert.current) {
              event.preventDefault()
              focusAfterInsert.current = false
              document.getElementById('chat-input')?.focus()
            }
          }}
        >
          <SheetHeader>
            <SheetTitle>世界与音乐</SheetTitle>
            <SheetDescription>背景资料、常用指令和此刻的配乐。</SheetDescription>
          </SheetHeader>
          <Tabs value={tab} onValueChange={setTab} className="min-h-0 flex-1 px-4 pb-4">
            <TabsList className="w-full shrink-0">
              <TabsTrigger value="world">世界</TabsTrigger>
              <TabsTrigger value="commands">指令</TabsTrigger>
              <TabsTrigger value="music">音乐</TabsTrigger>
            </TabsList>
            <TabsContent value="world" className="min-h-0 overflow-y-auto overscroll-contain">
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
            <TabsContent
              value="commands"
              className="flex min-h-0 flex-col gap-3 overflow-y-auto overscroll-contain"
            >
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
                          focusAfterInsert.current = true
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
            <TabsContent
              value="music"
              className="flex min-h-0 flex-col gap-4 overflow-y-auto overscroll-contain"
            >
              {error && (
                <Alert variant="destructive">
                  <AlertTitle>暂时无法播放</AlertTitle>
                  <AlertDescription className="flex flex-col gap-2">
                    <p>{error}</p>
                    <Button
                      variant="outline"
                      onClick={() => {
                        if (audio.current) {
                          audio.current.load()
                          void play()
                        }
                      }}
                    >
                      重试播放
                    </Button>
                  </AlertDescription>
                </Alert>
              )}
              <Card>
                <CardHeader>
                  <Music2 className="size-8 text-primary" />
                  <CardTitle>{tracks[index].name}</CardTitle>
                  <p role="status" className="text-sm text-muted-foreground">
                    {loading ? '正在加载音乐…' : playing ? '正在播放' : '已暂停'} ·{' '}
                    {repeatOne ? '单曲循环' : '列表循环'}
                  </p>
                </CardHeader>
                <CardContent className="flex flex-col gap-4">
                  <div className="flex justify-center gap-3">
                    <IconButton label="上一曲" onClick={() => switchTrack(index - 1)}>
                      <SkipBack />
                    </IconButton>
                    <IconButton
                      label={loading ? '取消加载音乐' : playing ? '暂停音乐' : '播放音乐'}
                      variant="secondary"
                      onClick={() => (loading || playing ? pause() : void play())}
                    >
                      {loading ? (
                        <LoaderCircle className="animate-spin" />
                      ) : playing ? (
                        <Pause />
                      ) : (
                        <Play />
                      )}
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
                    disabled={!duration}
                    aria-valuetext={time(elapsed) + ' / ' + time(duration)}
                    onChange={(e) => {
                      const t = Number(e.target.value)
                      if (audio.current) audio.current.currentTime = t
                      setElapsed(t)
                    }}
                  />
                  <p className="flex justify-between text-xs font-mono tabular-nums text-muted-foreground">
                    <span>{time(elapsed)}</span>
                    <span>{time(duration)}</span>
                  </p>
                  <div className="flex items-center justify-between">
                    <label htmlFor="music-volume" className="text-sm">
                      音量
                    </label>
                    <span className="text-sm tabular-nums text-muted-foreground">
                      {Math.round(volume * 100)}%
                    </span>
                  </div>
                  <Input
                    id="music-volume"
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={volume}
                    aria-valuetext={Math.round(volume * 100) + '%'}
                    onChange={(e) => {
                      const next = Number(e.target.value)
                      setVolume(next)
                      if (audio.current) audio.current.volume = next
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
                    aria-current={i === index ? 'true' : undefined}
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
