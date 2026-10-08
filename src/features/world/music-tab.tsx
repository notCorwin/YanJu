import { IconButton } from '@/components/shared'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Music2, Pause, Play, Repeat, SkipBack, SkipForward } from 'lucide-react'

import type { AudioPlayer } from './use-audio-player'

const time = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
export function MusicTab({ player }: { player: AudioPlayer }) {
  const {
    track,
    tracks,
    index,
    playing,
    elapsed,
    duration,
    repeatOne,
    volume,
    play,
    pause,
    switchTrack,
    seek,
    setVolume,
    setRepeatOne,
  } = player
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <Music2 className="size-8 text-primary" />
          <CardTitle>{track.name}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex justify-center gap-3">
            <IconButton label="上一曲" onClick={() => switchTrack(index - 1)}>
              <SkipBack data-icon="inline-start" />
            </IconButton>
            <IconButton
              label={playing ? '暂停音乐' : '播放音乐'}
              variant="secondary"
              onClick={() => (playing ? pause() : void play())}
            >
              {playing ? <Pause data-icon="inline-start" /> : <Play data-icon="inline-start" />}
            </IconButton>
            <IconButton label="下一曲" onClick={() => switchTrack(index + 1)}>
              <SkipForward data-icon="inline-start" />
            </IconButton>
            <IconButton
              label={repeatOne ? '切换到列表循环' : '切换到单曲循环'}
              variant={repeatOne ? 'secondary' : 'ghost'}
              onClick={() => setRepeatOne((v) => !v)}
            >
              <Repeat data-icon="inline-start" />
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
            onChange={(e) => seek(Number(e.target.value))}
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
            value={volume}
            onChange={(e) => setVolume(Number(e.target.value))}
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
            {i === index && playing && <Music2 data-icon="inline-start" />}
            {track.name}
          </Button>
        ))}
      </div>
    </div>
  )
}
