import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from 'node:test'
import { NativeWriteActivity } from '../src/native-write-activity.ts'

it('records a failed call without persisting its proposed diff', (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pi-agy-activity-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const pending = new NativeWriteActivity()
  const name = 'edit_file'
  const path = join(root, 'demo.txt')
  const reported = { kind: 'edit', toolName: name, serverName: `non-pi:${name}`, nativeWritePath: path }
  const update = { sessionUpdate: 'tool_call_update', toolCallId: 'edit-1' }
  assert.equal(pending.observe({
    ...update, status: 'pending', content: [{ type: 'diff', path, oldText: 'a', newText: 'b' }],
  }, reported, root), undefined)
  assert.deepEqual(pending.observe({ ...update, status: 'failed' }, reported, root), {
    toolCallId: 'edit-1', name, status: 'failed', path,
  })
})

it('omits oversized or off-target diffs without losing the tool record', (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pi-agy-activity-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const activity = new NativeWriteActivity()
  const name = 'write_file'
  const path = join(root, 'demo.txt')
  const reported = { kind: 'edit', toolName: name, serverName: `non-pi:${name}`, nativeWritePath: path }
  const terminal = { sessionUpdate: 'tool_call_update', status: 'completed' }
  assert.equal(activity.observe({
    ...terminal, toolCallId: 'write-1', content: [{ type: 'diff', path, newText: 'a'.repeat(48_001) }],
  }, reported, root)?.diffOmitted, true)
  assert.deepEqual(activity.observe({
    ...terminal, toolCallId: 'write-2', content: [{ type: 'diff', path: join(root, 'other.txt'), newText: 'secret' }],
  }, reported, root), { toolCallId: 'write-2', name, status: 'completed', path })
})
