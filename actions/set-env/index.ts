/* eslint-disable camelcase */
import * as core from '@actions/core'
import {getInput} from '@actions/core'
import * as github from '@actions/github'
// eslint-disable-next-line node/no-unpublished-import
import {run} from './lib/actions.js'
// see https://github.com/actions/toolkit for more GitHub actions libraries
import {fileURLToPath} from 'url'
import * as process from 'node:process'

const context = github.context

export const action = () => run(async () => {
  const inputs = getAllInputs()

  Object.entries(inputs).forEach(([name, value]) => {
    core.info(`Export variable '${name}'`)
    core.exportVariable(name, value)
  })
})

function getAllInputs(): Record<string, string> {
  return Object.fromEntries(Object.entries(process.env)
      .filter(([name]) => name.startsWith("INPUT_"))
      .map(([name, value]) => [name.replace('INPUT_', ''), value ?? '']));
}

// --- main ---

// Execute the action, if running as the main module
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  action()
}
