import type { ForumReply } from './schemas'
import type { LegacyContent } from './types'

/** Parse old markup as inert data. Its styles and scripts never enter the live document. */
export function convertLegacy(raw: string): LegacyContent {
  const doc = new DOMParser().parseFromString(raw, 'text/html')
  doc.querySelectorAll('script,style,iframe,object,embed').forEach((el) => el.remove())
  const txt = (el: Element | null | undefined) => el?.textContent?.trim() ?? ''
  const forum = doc.querySelector('zf')
  if (forum) {
    const answers: ForumReply['answers'] = Array.from(forum.querySelectorAll('r')).map((el, i) => {
      const parts = txt(el).split('|')
      return {
        id: parts[0] || String(i),
        author: parts[1] || '匿名',
        time: parts[2] || '',
        content: parts[3] || '',
        likes: Number(parts[4]) || 0,
        replyTo: '',
      }
    })
    return {
      body: '',
      panels: [],
      forum: {
        post: {
          id: 'legacy-post',
          title: txt(forum.querySelector('g5')),
          author: '匿名',
          time: txt(forum.querySelector('g6')),
          content: txt(forum.querySelector('g7')),
          tags: [],
          views: 0,
          followers: 0,
        },
        answers,
      },
    }
  }
  const header = doc.querySelector('.censy-lux-header')
  const vals = header?.querySelectorAll('.censy-meta-val')
  const scene = header
    ? {
        time: txt(vals?.[0]),
        location: txt(vals?.[1]),
        characters: txt(vals?.[2]),
        quoteZh: txt(header.querySelector('.censy-quote-main')),
        quoteEn: txt(header.querySelector('.censy-eng-italic')),
        source: txt(header.querySelector('.censy-source-tag')),
      }
    : undefined
  header?.remove()
  const panels: LegacyContent['panels'] = []
  doc.querySelectorAll('.lux_wrap > details').forEach((panel) => {
    const title = txt(panel.querySelector('.lux_lab')) || txt(panel.querySelector('summary'))
    // The abandoned short/mid/long memory protocol remains in rawContent for export only.
    if (!/ARCHIVE|Memoria|归档/i.test(title)) {
      const sections = Array.from(panel.querySelectorAll('.lux_sec')).map((sec) => ({
        heading: txt(sec.querySelector('.lux_h')),
        text: Array.from(sec.querySelectorAll('.lux_ph,.lux_note,.wx_thread'))
          .map(txt)
          .join('\n\n'),
      }))
      panels.push({
        title,
        sections: sections.length
          ? sections
          : [{ heading: '', text: txt(panel.querySelector('.lux_body')) }],
      })
    }
  })
  doc.querySelectorAll('.lux_wrap').forEach((el) => el.remove())
  doc.querySelectorAll('br').forEach((el) => el.replaceWith('\n'))
  doc.querySelectorAll('p,div').forEach((el) => el.append('\n\n'))
  return { body: doc.body.textContent?.trim() ?? raw, scene, panels }
}
