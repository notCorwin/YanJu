import music from '@/content/music.json'

export const tracks = music.map((track) => ({
  ...track,
  id: new URL(track.url).pathname
    .split('/')
    .at(-1)!
    .replace(/\.mp3$/, ''),
}))

export function requestTrack(id: string, play = true) {
  if (!tracks.some((t) => t.id === id)) throw new Error('曲目不存在。')
  window.dispatchEvent(new CustomEvent('yanju-track', { detail: { id, play } }))
}
