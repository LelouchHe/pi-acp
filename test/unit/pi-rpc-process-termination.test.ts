import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'

function makeProcess(options: { exitsOnKill: boolean }): { proc: PiRpcProcess; signals: NodeJS.Signals[] } {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    killed: false,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null
  }) as EventEmitter & {
    stdin: PassThrough
    stdout: PassThrough
    stderr: PassThrough
    killed: boolean
    exitCode: number | null
    signalCode: NodeJS.Signals | null
    kill: (signal: NodeJS.Signals | number) => boolean
  }
  const signals: NodeJS.Signals[] = []
  child.kill = ((signal: NodeJS.Signals | number) => {
    signals.push(signal as NodeJS.Signals)
    child.killed = true
    if (signal === 'SIGKILL' && options.exitsOnKill) {
      queueMicrotask(() => {
        child.signalCode = 'SIGKILL'
        child.emit('exit', null, 'SIGKILL')
      })
    }
    return true
  }) as typeof child.kill

  const ProcessConstructor = PiRpcProcess as unknown as new (child: ChildProcessWithoutNullStreams) => PiRpcProcess
  return { proc: new ProcessConstructor(child as unknown as ChildProcessWithoutNullStreams), signals }
}

test('PiRpcProcess: terminateAndWait escalates from SIGTERM to SIGKILL and confirms exit', async () => {
  const { proc, signals } = makeProcess({ exitsOnKill: true })

  const stopped = await proc.terminateAndWait(5, 100)

  assert.equal(stopped, true)
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL'])
})

test('PiRpcProcess: terminateAndWait reports a child that outlives the kill timeout', async () => {
  const { proc, signals } = makeProcess({ exitsOnKill: false })

  const stopped = await proc.terminateAndWait(5, 5)

  assert.equal(stopped, false)
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL'])
})
