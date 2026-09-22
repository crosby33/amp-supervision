import { afterEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { ArchivedThread, captureBuild, SupervisionBridge } from '../src/supervision-mcp.ts'

const id = 'T-11111111-2222-3333-4444-555555555555'
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const databases: Database[] = []
function database() { const db = new Database(':memory:'); databases.push(db); return db }
const transcript = (prompt: string) => ({ id, meta: { lastKnownAgentState: { state: 'idle', messageID: 'final' } },
	messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] },
		{ role: 'assistant', protocolMessageID: 'final', state: { type: 'complete', stopReason: 'end_turn' }, content: [{ type: 'text', text: 'Finished' }] }] })
afterEach(() => { for (const db of databases.splice(0)) db.close() })

test('startup identity is stable, stale mutations reserve nothing, reads still reconcile', async () => {
	let source = 'original source', prompt = ''
	const build = captureBuild(() => source), db = database(), calls: string[][] = []
	const bridge = new SupervisionBridge(db, async args => {
		calls.push(args)
		if (args[1] === 'export') return JSON.stringify(transcript(prompt))
		if (args[1] === 'list') return '[]'
		prompt = args[1]!
		return `https://ampcode.com/threads/${id}`
	}, undefined, build)
	const spawned = await bridge.spawn('Implement here', 'no-project', 'orb')
	expect(spawned.build_id).toBe(hash('original source'))
	expect(spawned.applied_worker_policy_id).toBe(hash(prompt.split('\n\nTask from the external supervisor:\n')[0]!.split('\n').slice(1).join('\n')))
	const before = db.query('SELECT * FROM supervision_requests').all()
	source = 'replacement source'
	await expect(bridge.spawn('Duplicate', 'no-project', 'orb')).rejects.toThrow('source changed')
	await expect(bridge.send(id, 'Continue')).rejects.toThrow('source changed')
	expect(calls).toHaveLength(1)
	expect(db.query('SELECT * FROM supervision_requests').all()).toEqual(before)
	expect(await bridge.read(id)).toMatchObject({ settled: true, build_id: hash('original source'),
		dispatch_build_id: hash('original source'), applied_worker_policy_id: spawned.worker_policy_id })
	expect((await bridge.list()).pending_requests).toEqual([])
})

test('source loss refuses dispatch without leaking filesystem details', async () => {
	let missing = false, calls = 0
	const build = captureBuild(() => { if (missing) throw new Error('private path'); return 'source' })
	const db = database(), bridge = new SupervisionBridge(db, async () => { calls++; return '' }, undefined, build)
	missing = true
	await expect(bridge.spawn('Task', 'no-project', 'orb')).rejects.toThrow('Bridge source unavailable')
	expect(calls).toBe(0)
	expect(db.query('SELECT * FROM supervision_requests').all()).toEqual([])
})

test('source drift during send export restores exact previous provenance before dispatch', async () => {
	let source = 'first', prompt = '', drift = false
	const db = database(), calls: string[][] = []
	const bridge = new SupervisionBridge(db, async args => {
		calls.push(args)
		if (args[1] === 'export') { if (drift) source = 'second'; return JSON.stringify(transcript(prompt)) }
		prompt = args[1]!; return `https://ampcode.com/threads/${id}`
	}, undefined, captureBuild(() => source))
	await bridge.spawn('Implement', 'no-project', 'orb')
	await bridge.read(id)
	const previous = db.query('SELECT * FROM supervision_requests').all()
	drift = true
	await expect(bridge.send(id, 'Continue')).rejects.toThrow('source changed')
	expect(db.query('SELECT * FROM supervision_requests').all()).toEqual(previous)
	expect(calls.filter(args => args[1] === 'continue')).toEqual([])
})

test('legacy pending and orphan rows migrate with unknown provenance and retain correlation', async () => {
	const db = database()
	db.exec('CREATE TABLE supervision_requests (key TEXT PRIMARY KEY, thread TEXT UNIQUE, digest TEXT NOT NULL, pending INTEGER NOT NULL)')
	db.query('INSERT INTO supervision_requests VALUES (?, ?, ?, 1)').run('old', id, hash('old prompt'))
	db.query('INSERT INTO supervision_requests VALUES (?, NULL, ?, 1)').run('orphan', hash('orphan prompt'))
	const bridge = new SupervisionBridge(db, async () => JSON.stringify(transcript('old prompt')))
	new SupervisionBridge(db) // Idempotent migration; must not backfill identities.
	expect(await bridge.read(id)).toMatchObject({ settled: true, dispatch_build_id: null, applied_worker_policy_id: null })
	expect(db.query('SELECT pending, dispatch_build_id, applied_worker_policy_id FROM supervision_requests WHERE key = ?').get('orphan'))
		.toEqual({ pending: 1, dispatch_build_id: null, applied_worker_policy_id: null })
})

test('accepted continuation keeps JSON verbatim and does not claim a newly applied policy', async () => {
	let prompt = ''
	const db = database(), bridge = new SupervisionBridge(db, async args => {
		if (args[1] === 'export') return JSON.stringify(transcript(prompt))
		prompt = args[0] === 'threads' ? args[4]! : args[1]!
		return `https://ampcode.com/threads/${id}`
	})
	await bridge.spawn('Implement', 'no-project', 'orb'); await bridge.read(id)
	const decision = ' {"decision":"green","rationale":"test","constraints":[]}\n'
	const sent = await bridge.send(id, decision)
	if (!('request_id' in sent)) throw new Error('Expected accepted send')
	expect(prompt).toBe(`[supervision-request ${sent.request_id}]\n${decision}`)
	expect(sent.applied_worker_policy_id).toBeNull()
	expect(await bridge.read(id)).toMatchObject({ dispatch_build_id: bridge.build.build_id, applied_worker_policy_id: null })
})

test('ambiguous spawn retains original provenance across a new build and exact recovery', async () => {
	let prompt = ''
	const db = database(), firstBuild = captureBuild(() => 'first build')
	const first = new SupervisionBridge(db, async args => { prompt = args[1]!; throw new Error('unknown acceptance') }, undefined, firstBuild)
	await expect(first.spawn('Work', 'no-project', 'orb')).rejects.toThrow('unknown acceptance')
	const second = new SupervisionBridge(db, async args => args[1] === 'list' ? '[]' : JSON.stringify(transcript(prompt)), undefined, captureBuild(() => 'second build'))
	const pending = (await second.list()).pending_requests
	expect(pending).toHaveLength(1)
	expect(pending[0]).toMatchObject({ thread_id: null, dispatch_build_id: hash('first build'), applied_worker_policy_id: firstBuild.worker_policy_id })
	await expect(second.spawn('Duplicate', 'no-project', 'orb')).rejects.toThrow('unknown acceptance')
	expect(await second.read(id)).toMatchObject({ settled: true, pending_request: null,
		build_id: hash('second build'), dispatch_build_id: hash('first build'), applied_worker_policy_id: firstBuild.worker_policy_id })
})

test('archived continuation restores non-null spawn provenance', async () => {
	let prompt = ''
	const db = database(), bridge = new SupervisionBridge(db, async args => {
		if (args[1] === 'export') return JSON.stringify(transcript(prompt))
		if (args[1] === 'continue') throw new ArchivedThread()
		prompt = args[1]!; return `https://ampcode.com/threads/${id}`
	})
	await bridge.spawn('Work', 'no-project', 'orb'); await bridge.read(id)
	const before = db.query('SELECT * FROM supervision_requests').all()
	expect((await bridge.send(id, 'Continue')).dispatch_status).toBe('refused')
	expect(db.query('SELECT * FROM supervision_requests').all()).toEqual(before)
})

test('maintained skill guards worker role before supervisor instructions and exercises topology', () => {
	const skill = readFileSync(new URL('../skills/amp-supervision/SKILL.md', import.meta.url), 'utf8')
	expect(skill.indexOf('## Role guard')).toBeLessThan(skill.indexOf('## Tools'))
	expect(skill).toContain('Workers must not run this skill\'s Start')
	expect(skill).toContain('unless the human operator explicitly requests implementation delegation')
	expect(skill).toContain('amp_spawn(executor="runner"')
	expect(skill).toContain('amp_spawn(executor="orb", project=')
	const fixture = readFileSync(new URL('../skills/amp-supervision/references/acceptance-test.md', import.meta.url), 'utf8')
	expect(fixture).toContain("original worker's full tool history")
	expect(fixture).toContain('If you load amp-supervision, obey its worker-role guard')
})
