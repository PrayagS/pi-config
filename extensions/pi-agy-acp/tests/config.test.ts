import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from 'node:test'
import {
  parsePreferenceValue,
  readPreferences,
  SETTINGS_FILE,
  writePreferences,
} from '../src/config.ts'

function fixture(t: { after: (cleanup: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), 'pi-agy-config-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return { path: join(root, 'config', SETTINGS_FILE), state: join(root, 'state') }
}

it('persists all preferences in a single file independent of the state directory', (t) => {
  const { path, state } = fixture(t)
  assert.deepEqual(readPreferences(path, state), {
    command: '', home: '', quotaDisplay: 'used', debug: false, nativeWrites: false,
  })
  const settings = {
    command: join(state, 'path with spaces', 'agy'),
    home: state,
    quotaDisplay: 'remaining' as const,
    debug: true,
    nativeWrites: true,
  }
  assert.deepEqual(writePreferences(path, state, settings), settings)
  assert.deepEqual(readPreferences(path, state), settings)

  writeFileSync(path, JSON.stringify({ ...settings, futureSetting: ['keep'] }))
  const newState = join(state, 'other')
  assert.deepEqual(writePreferences(path, state, { home: newState, debug: undefined }), {
    ...settings, home: newState, debug: false,
  })
  const saved = JSON.parse(readFileSync(path, 'utf8'))
  assert.deepEqual(saved.futureSetting, ['keep'])
  assert.equal(saved.home, newState)
  assert.equal('debug' in saved, false)
})

it('carries over native writes and quota preferences from the default legacy file', (t) => {
  const { path, state } = fixture(t)
  mkdirSync(state, { recursive: true })
  const legacy = join(state, 'settings.json')
  const original = JSON.stringify({ nativeWrites: true, quotaDisplay: 'remaining' })
  writeFileSync(legacy, original)
  assert.equal(readPreferences(path, state).nativeWrites, true)
  assert.equal(readPreferences(path, state).quotaDisplay, 'remaining')
  writePreferences(path, state, { debug: true })
  assert.equal(readFileSync(legacy, 'utf8'), original)
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), {
    nativeWrites: true, quotaDisplay: 'remaining', debug: true,
  })
  writePreferences(path, state, { nativeWrites: undefined })
  assert.equal(readPreferences(path, state).nativeWrites, false)
})

it('fails closed on an invalid config and never overwrites it', (t) => {
  const { path, state } = fixture(t)
  writePreferences(path, state, {})
  for (const contents of ['{"nativeWrites":', 'null', '[true]']) {
    writeFileSync(path, contents)
    assert.equal(readPreferences(path, state).nativeWrites, false)
    assert.throws(() => writePreferences(path, state, { nativeWrites: true }))
    assert.equal(readFileSync(path, 'utf8'), contents)
  }
  writeFileSync(path, JSON.stringify({ nativeWrites: 'true', debug: 1, command: 'relative' }))
  assert.equal(readPreferences(path, state).nativeWrites, false)
  assert.equal(readPreferences(path, state).debug, false)
  assert.equal(readPreferences(path, state).command, '')
})

it('validates slash command values and accepts paths with spaces', (t) => {
  const { state } = fixture(t)
  const path = join(state, 'bin with spaces', 'agy')
  assert.equal(parsePreferenceValue('command', path), path)
  assert.equal(parsePreferenceValue('home', 'default'), undefined)
  assert.equal(parsePreferenceValue('debug', 'on'), true)
  assert.equal(parsePreferenceValue('nativeWrites', 'off'), false)
  assert.equal(parsePreferenceValue('quotaDisplay', 'remaining'), 'remaining')
  assert.throws(() => parsePreferenceValue('command', 'relative/agy'))
  assert.throws(() => parsePreferenceValue('quotaDisplay', 'unused'))
  assert.throws(() => parsePreferenceValue('debug', 'yes'))
})
