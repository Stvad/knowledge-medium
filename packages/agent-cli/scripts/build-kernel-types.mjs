import {spawn} from 'node:child_process'
import {createRequire} from 'node:module'
import fs from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath, pathToFileURL} from 'node:url'

const require = createRequire(import.meta.url)

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const packageDir = path.resolve(scriptDir, '..')
const repoRoot = path.resolve(packageDir, '../..')
const distDir = path.resolve(packageDir, 'dist')
const kernelTypesOutDir = path.resolve(distDir, 'kernel-types')
const tsBuildInfoPath = path.resolve(packageDir, 'node_modules/.tmp/kernel-types.tsbuildinfo')

const tscBin = require.resolve('typescript/bin/tsc')

const run = (command, args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      ...options,
    })
    child.on('error', reject)
    child.on('exit', code => {
      if (code === 0) resolve()
      else reject(new Error(`${command} ${args.join(' ')} exited with ${code ?? 'unknown status'}`))
    })
  })

await fs.rm(kernelTypesOutDir, {recursive: true, force: true})
await fs.mkdir(kernelTypesOutDir, {recursive: true})
await fs.mkdir(path.dirname(tsBuildInfoPath), {recursive: true})

await run(process.execPath, [
  tscBin,
  '-p',
  path.resolve(repoRoot, 'tsconfig.kernel-types.json'),
  '--emitDeclarationOnly',
  '--declaration',
  '--declarationMap',
  '--outDir',
  kernelTypesOutDir,
  '--noEmit',
  'false',
  '--tsBuildInfoFile',
  tsBuildInfoPath,
], {cwd: repoRoot})

const {kernelTypeAssetDeclarations} = await import(pathToFileURL(path.resolve(distDir, 'kernelDts.js')).href)
await fs.writeFile(
  path.resolve(kernelTypesOutDir, 'assets.d.ts'),
  kernelTypeAssetDeclarations,
  'utf8',
)
