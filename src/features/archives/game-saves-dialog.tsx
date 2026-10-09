import { useEffect, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardFooter,
  CardContent,
} from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Field, FieldLabel, FieldGroup } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Empty, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { db } from '@/lib/storage'
import {
  forkGame,
  navigateGame,
  loadGameSave,
  loadGameBranch,
  saveGame,
  updateGameContext,
  deleteGameBranch,
  deleteGameSlot,
} from '@/lib/game-history'
import { exportGame, type SharePackage } from '@/lib/game-share'
import { storyContentSchema } from '@/lib/game-history-schema'
import { downloadJson, saveFileName } from '@/lib/download'
import { formatDate } from '@/lib/format-date'
import { friendlyError } from '@/lib/provider'
import type { Notify } from '@/lib/notify'
import type { HistoryNode, StoryContent } from '@/lib/types'
import { defaultStoryContent } from '@/lib/game-content'
import { stopGameOperations } from '@/lib/game-operations'

export function GameSavesDialog({
  open,
  onClose,
  archiveId,
  onRestore,
  notify,
}: {
  open: boolean
  onClose: () => void
  archiveId: string
  onRestore: () => void
  notify: Notify
}) {
  const archive = useLiveQuery(() => db.archives.get(archiveId), [archiveId])
  const session = useLiveQuery(() => db.sessions.get(archiveId), [archiveId])
  const branches =
    useLiveQuery(
      () => db.branches.where('archiveId').equals(archiveId).sortBy('createdAt'),
      [archiveId],
    ) ?? []
  const nodes =
    useLiveQuery(() => db.nodes.where('archiveId').equals(archiveId).toArray(), [archiveId]) ?? []
  const slots =
    useLiveQuery(
      () => db.slots.where('archiveId').equals(archiveId).sortBy('createdAt'),
      [archiveId],
    ) ?? []
  const personas = useLiveQuery(() => db.personas.toArray()) ?? []
  const [pending, setPending] = useState(false)
  const [name, setName] = useState('新的存档')
  const [mode, setMode] = useState<SharePackage['mode']>('progress')
  const [scope, setScope] = useState<SharePackage['scope']>('route')
  const [contentDraft, setContentDraft] = useState<StoryContent | null>(null)
  const [personaId, setPersonaId] = useState('current')
  const [worldDraft, setWorldDraft] = useState<string | null>(null)
  const [entitiesDraft, setEntitiesDraft] = useState<string | null>(null)
  useEffect(() => {
    setContentDraft(null)
    setWorldDraft(null)
    setEntitiesDraft(null)
    setPersonaId('current')
  }, [archiveId, archive?.navigationEpoch])
  const content = contentDraft ?? archive?.content ?? defaultStoryContent()
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const path: HistoryNode[] = []
  let cursor = session && byId.get(session.nodeId)
  while (cursor) {
    path.unshift(cursor)
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined
  }
  const run = async (action: () => Promise<unknown>, text: string, restore = false) => {
    if (pending) return
    setPending(true)
    try {
      await action()
      if (restore) onRestore()
      notify(text)
    } catch (error) {
      notify(friendlyError(error), true)
    } finally {
      setPending(false)
    }
  }
  const quick = slots.find((s) => s.kind === 'quick')
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!value && !pending) onClose()
      }}
    >
      <DialogContent size="wide" className="editor-height overflow-hidden">
        <DialogHeader>
          <DialogTitle>存档与路线</DialogTitle>
          <DialogDescription>
            {archive?.name} · 自动保存进度，可随时读档、回退或从节点开辟新路线。
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={pending}
            onClick={() =>
              void run(() => saveGame(archiveId, '快速存档', 'quick'), '快速存档已保存。')
            }
          >
            快速存档
          </Button>
          <Button
            variant="outline"
            disabled={pending || !quick}
            onClick={() =>
              quick && void run(() => loadGameSave(archiveId, quick.id), '快速存档已载入。', true)
            }
          >
            快速读档
          </Button>
          {session && (
            <Badge variant="secondary">
              {branches.find((b) => b.id === session.branchId)?.name} · {path.length} 个剧情节点
            </Badge>
          )}
        </div>
        <Tabs defaultValue="slots" className="flex min-h-0 flex-1 flex-col">
          <TabsList className="flex-wrap">
            <TabsTrigger value="slots">存档位</TabsTrigger>
            <TabsTrigger value="routes">路线</TabsTrigger>
            <TabsTrigger value="history">回退历史</TabsTrigger>
            <TabsTrigger value="settings">篇章设定</TabsTrigger>
            <TabsTrigger value="share">分享</TabsTrigger>
          </TabsList>
          <TabsContent value="slots" className="min-h-0 overflow-y-auto">
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="save-slot-name">存档位名称</FieldLabel>
                <Input
                  id="save-slot-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </Field>
              <Button
                disabled={pending}
                onClick={() => void run(() => saveGame(archiveId, name), '存档位已保存。')}
              >
                保存到新存档位
              </Button>
            </FieldGroup>
            <div className="mt-4 flex flex-col gap-3">
              {[...slots]
                .reverse()
                .filter((s) => s.kind !== 'auto' || s.branchId === session?.branchId)
                .map((slot) => (
                  <Card key={slot.id} size="sm">
                    <CardHeader>
                      <CardTitle>{slot.name}</CardTitle>
                      <CardDescription>
                        {slot.kind === 'auto'
                          ? '自动存档'
                          : slot.kind === 'quick'
                            ? '快速存档'
                            : '手动存档'}{' '}
                        · {formatDate(slot.createdAt)}
                      </CardDescription>
                    </CardHeader>
                    <CardFooter className="flex-wrap gap-2">
                      <Button
                        disabled={pending}
                        onClick={() =>
                          void run(() => loadGameSave(archiveId, slot.id), '存档已载入。', true)
                        }
                      >
                        读取存档
                      </Button>
                      {slot.kind === 'manual' && (
                        <Button
                          variant="outline"
                          disabled={pending}
                          onClick={() =>
                            void run(
                              () => saveGame(archiveId, slot.name, 'manual', slot.id),
                              '存档位已覆盖。',
                            )
                          }
                        >
                          覆盖
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        disabled={pending}
                        onClick={() =>
                          void run(() => deleteGameSlot(archiveId, slot.id), '存档位已删除。')
                        }
                      >
                        删除存档位
                      </Button>
                    </CardFooter>
                  </Card>
                ))}
            </div>
          </TabsContent>
          <TabsContent value="routes" className="min-h-0 overflow-y-auto">
            <div className="flex flex-col gap-3">
              <Button
                disabled={pending}
                onClick={() => void run(() => forkGame(archiveId), '新路线已建立。', true)}
              >
                从当前进度创建路线
              </Button>
              {branches.map((branch) => (
                <Card key={branch.id} size="sm">
                  <CardHeader>
                    <CardTitle>
                      {branch.name}
                      {branch.id === session?.branchId && ' · 当前路线'}
                    </CardTitle>
                    <CardDescription>
                      {branch.forkNodeId
                        ? `分叉起点：${byId.get(branch.forkNodeId)?.label ?? '历史节点'}`
                        : '原始开局'}{' '}
                      · {formatDate(branch.createdAt)}
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <Field>
                      <FieldLabel htmlFor={`route-${branch.id}`}>路线名称</FieldLabel>
                      <Input
                        id={`route-${branch.id}`}
                        defaultValue={branch.name}
                        onBlur={(event) => {
                          const value = event.target.value.trim()
                          if (value && value !== branch.name)
                            void run(
                              () => db.branches.update(branch.id, { name: value }),
                              '路线名称已更新。',
                            )
                        }}
                      />
                    </Field>
                  </CardContent>
                  <CardFooter className="flex-wrap gap-2">
                    <Button
                      disabled={pending}
                      onClick={() =>
                        void run(
                          () => loadGameBranch(archiveId, branch.id),
                          '路线最新进度已载入。',
                          true,
                        )
                      }
                    >
                      载入路线
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={pending || branch.id === session?.branchId}
                      onClick={() =>
                        void run(
                          () => deleteGameBranch(archiveId, branch.id),
                          '路线已删除，手动存档继续保留。',
                        )
                      }
                    >
                      删除路线
                    </Button>
                  </CardFooter>
                </Card>
              ))}
            </div>
          </TabsContent>
          <TabsContent value="history" className="min-h-0 overflow-y-auto">
            <div className="flex flex-col gap-3">
              {[...path].reverse().map((node, index) => (
                <Card key={node.id} size="sm">
                  <CardHeader>
                    <CardTitle>
                      {node.label} · 节点 {path.length - index}
                      {node.id === session?.nodeId && ' · 当前'}
                    </CardTitle>
                    <CardDescription>
                      {formatDate(node.createdAt)}
                      {node.id === session?.startNodeId && ' · 分享开局'}
                    </CardDescription>
                  </CardHeader>
                  <CardFooter className="flex-wrap gap-2">
                    <Button
                      variant="outline"
                      disabled={pending || node.id === session?.nodeId}
                      onClick={() =>
                        void run(
                          () => navigateGame(archiveId, node.id, session?.branchId),
                          '已回退，原路线后续进度保留。',
                          true,
                        )
                      }
                    >
                      回退到此处
                    </Button>
                    <Button
                      disabled={pending}
                      onClick={() =>
                        void run(() => forkGame(archiveId, node.id), '已从此节点创建新路线。', true)
                      }
                    >
                      从此处分支
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={pending}
                      onClick={() =>
                        void run(
                          () => db.sessions.update(archiveId, { startNodeId: node.id }),
                          '分享开局已更新。',
                        )
                      }
                    >
                      设为分享开局
                    </Button>
                  </CardFooter>
                </Card>
              ))}
            </div>
          </TabsContent>
          <TabsContent value="settings" className="min-h-0 overflow-y-auto">
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="game-persona">篇章人设</FieldLabel>
                <Select value={personaId} onValueChange={setPersonaId}>
                  <SelectTrigger id="game-persona">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="current">
                        {archive?.persona?.name ?? archive?.userName ?? '当前人设'}
                      </SelectItem>
                      {personas.map((p) => (
                        <SelectItem key={p.id} value={p.id}>
                          {p.name}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
              {(
                [
                  ['character', '角色设定'],
                  ['rules', '叙事规则'],
                  ['style', '文风'],
                  ['opening', '开场内容'],
                  ['background', '背景图片地址或数据'],
                ] as const
              ).map(([key, label]) => (
                <Field key={key}>
                  <FieldLabel htmlFor={`game-${key}`}>{label}</FieldLabel>
                  <Textarea
                    id={`game-${key}`}
                    value={content[key]}
                    onChange={(event) => setContentDraft({ ...content, [key]: event.target.value })}
                  />
                </Field>
              ))}
              <Field>
                <FieldLabel htmlFor="game-world">世界资料 JSON</FieldLabel>
                <Textarea
                  id="game-world"
                  value={worldDraft ?? JSON.stringify(content.world, null, 2)}
                  onChange={(event) => setWorldDraft(event.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="game-entities">初始人物与地点 JSON</FieldLabel>
                <Textarea
                  id="game-entities"
                  value={entitiesDraft ?? JSON.stringify(content.entities, null, 2)}
                  onChange={(event) => setEntitiesDraft(event.target.value)}
                />
              </Field>
              <Button
                disabled={pending}
                onClick={() =>
                  void run(
                    async () => {
                      const parsed = storyContentSchema.parse({
                        ...content,
                        world: worldDraft === null ? content.world : JSON.parse(worldDraft),
                        entities:
                          entitiesDraft === null ? content.entities : JSON.parse(entitiesDraft),
                      })
                      await stopGameOperations(archiveId)
                      await updateGameContext(
                        archiveId,
                        parsed,
                        personaId === 'current'
                          ? archive?.persona
                          : personas.find((p) => p.id === personaId),
                      )
                      setContentDraft(null)
                      setWorldDraft(null)
                      setEntitiesDraft(null)
                    },
                    '篇章设定已保存，可从历史恢复。',
                    true,
                  )
                }
              >
                保存篇章设定
              </Button>
            </FieldGroup>
          </TabsContent>
          <TabsContent value="share" className="min-h-0 overflow-y-auto">
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="share-mode">分享起点</FieldLabel>
                <Select
                  value={mode}
                  onValueChange={(value) => setMode(value as SharePackage['mode'])}
                >
                  <SelectTrigger id="share-mode">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="progress">分享当前进度</SelectItem>
                      <SelectItem value="start">分享开局</SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
              {mode === 'progress' && (
                <Field>
                  <FieldLabel htmlFor="share-scope">分享范围</FieldLabel>
                  <Select
                    value={scope}
                    onValueChange={(value) => setScope(value as SharePackage['scope'])}
                  >
                    <SelectTrigger id="share-scope">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value="route">当前路线及历史</SelectItem>
                        <SelectItem value="game">整个篇章、全部路线与存档位</SelectItem>
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>
              )}
              <p className="text-sm text-muted-foreground">
                朋友导入后获得独立篇章，使用自己的模型渠道继续玩。
              </p>
              <Button
                disabled={pending}
                onClick={() =>
                  void run(async () => {
                    downloadJson(
                      await exportGame(archiveId, mode, scope),
                      saveFileName(
                        `${archive?.name ?? '篇章'}-${mode === 'start' ? '开局' : '进度'}`,
                      ),
                    )
                  }, '剧情分享文件已导出。')
                }
              >
                导出分享文件
              </Button>
            </FieldGroup>
          </TabsContent>
        </Tabs>
        {!archive && (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>请选择篇章</EmptyTitle>
            </EmptyHeader>
          </Empty>
        )}
      </DialogContent>
    </Dialog>
  )
}
