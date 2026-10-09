import character from '@/content/character.txt?raw'
import rules from '@/content/narrative-rules.txt?raw'
import style from '@/content/style.txt?raw'
import opening from '@/content/opening.txt?raw'
import world from '@/content/world.json'
import type { StoryContent } from './types'

const seeds: [string, 'character' | 'location' | 'organization', string, string][] = [
  ['character-yanju', 'character', '宴雎', '宴氏董事长'],
  ['character-user', 'character', '沈辞玉', '独立个体，由用户主导言行'],
  ['character-shendu', 'character', '沈渡', '宴雎的人'],
  ['character-father', 'character', '宴父', '荣誉主席'],
  ['character-mother', 'character', '宴母', '宴雎的母亲'],
  ['character-grandfather', 'character', '祖父', '第三代掌舵'],
  ['character-gao', 'character', '高劭良', '政策研究机构，与你有关联'],
  ['location-manor', 'location', '城外庄园', '现居'],
  ['location-old-house', 'location', '老城厢祖宅', '祖宅禁区'],
  ['location-hotel', 'location', '外滩老酒店', '主要场景'],
  ['location-finance', 'location', '江东岸金融区', '主要场景'],
  ['location-tea', 'location', '老城厢茶馆园林', '主要场景'],
  ['location-retreat', 'location', '近郊隐庐', '主要场景'],
  ['organization-yan', 'organization', '宴氏', '宴雎掌管的集团'],
]

export function defaultStoryContent(background = ''): StoryContent {
  return {
    character,
    rules,
    style,
    opening,
    world: structuredClone(world),
    background,
    entities: seeds.map(([id, kind, name, description]) => ({ id, kind, name, description })),
  }
}
