export const tracks = [
  ['熄灭', 'ximie'],
  ['true', 'true'],
  ['Stay with me', 'staywithme'],
  ['来自天堂的魔鬼', 'mogui'],
  ['A.I.N.Y 爱你', 'ainy'],
].map(([name, id]) => ({
  id,
  name,
  url: `https://cdn.jsdelivr.net/gh/hmt20061008-oss/music@main/${id}.mp3`,
}))

export function requestTrack(id: string, play = true) {
  if (!tracks.some((t) => t.id === id)) throw new Error('曲目不存在。')
  window.dispatchEvent(new CustomEvent('yanju-track', { detail: { id, play } }))
}
