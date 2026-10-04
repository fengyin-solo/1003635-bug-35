/**
 * 补植业务域测试运行器：用 esbuild 把 TS 测试打成单文件 ESM，再以 data: URL 执行。
 * 不引入测试框架：node scripts/run-replant-tests.mjs
 */
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const entry = path.join(here, '..', 'tests', 'replant.test.ts')

const result = await build({
  entryPoints: [entry],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
  logLevel: 'silent',
})

const code = result.outputFiles[0].text
const dataUrl = 'data:text/javascript;base64,' + Buffer.from(code, 'utf8').toString('base64')
await import(dataUrl)

void pathToFileURL
