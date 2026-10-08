import tracks from '@/content/music.json'
import type { Notify } from '@/lib/types'
import { useRef, useState } from 'react'

export function useAudioPlayer(notify: Notify) {
  const audio = useRef<HTMLAudioElement>(null)
  const [index, setIndex] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [duration, setDuration] = useState(0)
  const [repeatOne, setRepeatOne] = useState(false)
  const [volume, updateVolume] = useState(1)
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
    setDuration(0)
    if (audio.current) {
      audio.current.src = tracks[value].url
      void play()
    }
  }
  const seek = (value: number) => {
    if (audio.current) audio.current.currentTime = value
    setElapsed(value)
  }
  const setVolume = (value: number) => {
    if (audio.current) audio.current.volume = value
    updateVolume(value)
  }
  return {
    track: tracks[index],
    tracks,
    index,
    playing,
    elapsed,
    duration,
    repeatOne,
    volume,
    play,
    pause: () => audio.current?.pause(),
    switchTrack,
    seek,
    setVolume,
    setRepeatOne,
    audioProps: {
      ref: audio,
      src: tracks[0].url,
      preload: 'none' as const,
      onTimeUpdate: () => setElapsed(audio.current?.currentTime ?? 0),
      onLoadedMetadata: () =>
        setDuration(Number.isFinite(audio.current?.duration) ? audio.current!.duration : 0),
      onPlay: () => setPlaying(true),
      onPause: () => setPlaying(false),
      onEnded: () => {
        if (repeatOne) {
          seek(0)
          void play()
        } else switchTrack(index + 1)
      },
      onError: () => {
        setPlaying(false)
        notify('音乐资源加载失败，可切换曲目或稍后重试。', true)
      },
    },
  }
}

export type AudioPlayer = ReturnType<typeof useAudioPlayer>
