import { describe, expect, it } from 'vitest'
import { runCommand } from '@qqbot/sdk/testing'
import plugin, { type Config } from './index.js'

describe('demo plugin', () => {
  it('hello 用默认配置回复', async () => {
    expect((await runCommand(plugin, 'hello')).replies).toEqual(['你好，朋友'])
  })

  it('使用面板保存的配置', async () => {
    // Config 的三个字段都要给：mock 的 ctx.config 是完整的 Config，不是 Partial（少了字段 tsc 直接报错）
    const config: Config = { greeting: 'Hi', pointsPerSign: 10, utcOffset: 8 }
    const session = await runCommand(plugin, 'hello', 'Bob', { ctx: { config } })
    expect(session.replies).toEqual(['Hi，Bob'])
  })

  it('生成器逐条回复', async () => {
    expect((await runCommand(plugin, 'count', '2')).replies).toEqual(['1', '2'])
  })
})
