import { downloadJson, saveFileName } from '@/lib/download'
import { exportSave } from '@/lib/storage'
import { Component, type ReactNode } from 'react'
import { Button } from './ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from './ui/card'

export class RecoveryBoundary extends Component<
  {
    children: ReactNode
    resetKey?: unknown
    title?: string
  },
  { failed: boolean; exportError: string }
> {
  state = { failed: false, exportError: '' }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  componentDidUpdate(previous: Readonly<typeof this.props>) {
    if (previous.resetKey !== this.props.resetKey && this.state.failed)
      this.setState({ failed: false, exportError: '' })
  }
  private download = async () => {
    try {
      downloadJson(await exportSave(), saveFileName('宴雎-恢复资料'))
    } catch (error) {
      this.setState({ exportError: error instanceof Error ? error.message : String(error) })
    }
  }
  render() {
    if (!this.state.failed) return this.props.children
    return (
      <Card role="alert">
        <CardHeader>
          <CardTitle>{this.props.title ?? '这部分内容暂时无法显示'}</CardTitle>
          <CardDescription>
            原始记录仍保存在浏览器中。可以重试显示、编辑修复，或先导出资料。
          </CardDescription>
        </CardHeader>
        <CardContent>
          {this.state.exportError && <p className="text-destructive">{this.state.exportError}</p>}
        </CardContent>
        <CardFooter className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => this.setState({ failed: false })}>
            重试显示
          </Button>
          <Button variant="outline" onClick={() => void this.download()}>
            导出当前资料
          </Button>
        </CardFooter>
      </Card>
    )
  }
}
