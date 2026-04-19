import { spawn } from 'node:child_process'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

function resolveExecutable(command) {
  return process.platform === 'win32' ? `${command}.cmd` : command
}

const branding = {
  APP_PRODUCT_NAME: process.env.APP_PRODUCT_NAME || 'Open Cowork',
  APP_ID: process.env.APP_ID || 'com.opencowork.desktop',
  APP_ARTIFACT_PREFIX: process.env.APP_ARTIFACT_PREFIX || 'Open-Cowork',
}

function createBuilderConfig() {
  const sourcePath = join(process.cwd(), 'electron-builder.yml')
  const generatedPath = join(process.cwd(), '.electron-builder.generated.yml')
  let config = readFileSync(sourcePath, 'utf8')
  for (const [key, value] of Object.entries(branding)) {
    config = config.replaceAll(`\${env.${key}}`, value)
  }
  writeFileSync(generatedPath, config)
  return generatedPath
}

function runStep(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(resolveExecutable(command), args, {
      cwd: process.cwd(),
      stdio: 'inherit',
      env: {
        ...process.env,
        ...branding,
      },
    })

    child.on('error', reject)
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolve()
        return
      }
      reject(new Error(`${command} ${args.join(' ')} failed with ${signal ? `signal ${signal}` : `exit code ${code}`}`))
    })
  })
}

const builderArgs = process.argv.slice(2)
const builderConfigPath = createBuilderConfig()

try {
  await runStep('pnpm', ['build'])
  await runStep('pnpm', ['build:electron'])
  await runStep('pnpm', ['--dir', '../..', 'build:mcps'])
  await runStep('electron-builder', ['--config', builderConfigPath, ...builderArgs])
} finally {
  rmSync(builderConfigPath, { force: true })
}
