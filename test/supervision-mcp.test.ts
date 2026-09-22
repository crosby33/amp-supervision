import { afterEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { AmpNotStarted, ArchivedThread, SupervisionBridge, blockedEnvelope, createSupervisionServer, inspectExport, runAmp } from '../src/supervision-mcp.ts'

const id = 'T-11111111-2222-3333-4444-555555555555'
const url = `https://ampcode.com/threads/${id}`
const envelope = { status: 'blocked', summary: 'Choose fixture colour', decisions_needed: [
	{ id: 'colour', question: 'Blue or green?', options: ['blue', 'green'], recommendation: 'blue', impact: 'Fixture only' },
], changes: [], tests: ['No writes yet'], next_action: 'Wait' }
const block = `\`\`\`json\n${JSON.stringify(envelope)}\n\`\`\``
const decision = JSON.stringify({ decision: 'colour: green', rationale: 'Exercise non-default choice', constraints: ['Scratch only'] })
const user = (text: string) => ({ role: 'user', content: [{ type: 'text', text }] })
const final = (text = block) => ({ role: 'assistant', protocolMessageID: 'M-final', state: { type: 'complete', stopReason: 'end_turn' }, content: [{ type: 'text', text }] })
const transcript = (prompt = 'Choose', response = block) => ({ id, meta: { lastKnownAgentState: { state: 'idle', messageID: 'M-final' } }, messages: [user(prompt), final(response)] })
const roots: string[] = []
const databases: Database[] = []
function database(path = ':memory:') { const db = new Database(path); databases.push(db); return db }
function directory() { const path = mkdtempSync(join(tmpdir(), 'supervision-test-')); roots.push(path); return path }
afterEach(() => { for (const db of databases.splice(0)) db.close(); for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }) })

test('waiting requires final fenced schema, current message identity and idle state', () => {
	expect(inspectExport(transcript(), id)).toMatchObject({ waiting_on_decision: true, envelope, settled: true })
	for (const value of [JSON.stringify(envelope), `Explanation\n${block}`, '```json\n{\n```',
		`\`\`\`json\n${JSON.stringify({ ...envelope, status: 'needs_decision' })}\n\`\`\``,
		`\`\`\`json\n${JSON.stringify({ ...envelope, decisions_needed: [] })}\n\`\`\``,
		`\`\`\`json\n${JSON.stringify({ ...envelope, decisions_needed: [envelope.decisions_needed[0], envelope.decisions_needed[0]] })}\n\`\`\``]) {
		expect(inspectExport(transcript('Choose', value), id).waiting_on_decision).toBeFalse()
	}
	for (const state of ['working', 'running_tools', 'unknown']) {
		const data = transcript(); data.meta.lastKnownAgentState.state = state
		expect(inspectExport(data, id).waiting_on_decision).toBeFalse()
	}
	const mismatched = transcript(); mismatched.meta.lastKnownAgentState.messageID = 'M-old'
	expect(inspectExport(mismatched, id).waiting_on_decision).toBeFalse()
	const newer = transcript(); newer.messages.push(user('New request'))
	expect(inspectExport(newer, id).waiting_on_decision).toBeFalse()
	const tool = { ...transcript(), messages: [user('Choose'), { ...final(), state: { type: 'complete', stopReason: 'tool_use' } }] }
	expect(inspectExport(tool, id).waiting_on_decision).toBeFalse()
	expect(() => inspectExport({ ...transcript(), id: 'T-aaaaaaaa-2222-3333-4444-555555555555' }, id)).toThrow('identity')
})

test('user-role tool results neither hide the real request nor acknowledge a pending request', () => {
	const request = { key: 'fixture', digest: createHash('sha256').update('Choose').digest('hex'), pending: 1 }
	// Tool-result shape after file reads; it must not be mistaken for a user request.
	const toolResult = { role: 'user', content: [{ type: 'tool_result', run: { result: 'Choose' } }] }
	const data = { ...transcript(), messages: [user('Choose'), toolResult, final()] }
	expect(inspectExport(data, id, request)).toMatchObject({ waiting_on_decision: true, pending_request: null })
	const stale = { ...data, messages: [user('Old question'), toolResult, final()] }
	expect(inspectExport(stale, id, request)).toMatchObject({ waiting_on_decision: false, pending_request: 'fixture' })
	const quoted = { ...data, messages: [user('Old question'), { role: 'user', content: [
		{ type: 'text', text: 'Choose' }, { type: 'tool_result', run: { result: 'Choose' } },
	] }, final()] }
	expect(inspectExport(quoted, id, request).waiting_on_decision).toBeFalse()
})

test('spawn/send argv, stale reads, concurrent sends and restart preserve outstanding request', async () => {
	const calls: string[][] = []
	let current = transcript()
	let sent = ''
	const run = async (args: string[]) => {
		calls.push(args)
		if (args[0] === '-ox') { current = transcript(args[1]); return url }
		if (args[1] === 'export') return JSON.stringify(current)
		if (args[1] === 'continue') { sent = args[4]!; return url }
		return '[]'
	}
	const path = join(directory(), 'requests.sqlite')
	const bridge = new SupervisionBridge(database(path), run)
	await bridge.spawn('Choose $(touch /tmp/never)\n--project evil/repo', 'owner/repo', 'orb')
	expect(calls[0]?.slice(2)).toEqual(['--visibility', 'private', '--project', 'owner/repo'])
	expect(calls[0]).not.toContain('--stream-json')
	expect((await bridge.read(id)).waiting_on_decision).toBeTrue()
	const results = await Promise.allSettled([bridge.send(id, decision), bridge.send(id, decision)])
	expect(results.map(r => r.status)).toEqual(['fulfilled', 'rejected'])
	expect(calls.filter(c => c[1] === 'continue')).toHaveLength(1)
	expect(calls.find(c => c[1] === 'continue')?.slice(0, 4)).toEqual(['threads', 'continue', id, '-ox'])
	const restarted = new SupervisionBridge(database(path), run)
	expect((await restarted.read(id)).waiting_on_decision).toBeFalse()
	await expect(restarted.send(id, decision)).rejects.toThrow('outstanding')
	current = transcript(sent, 'Completed green')
	expect(await restarted.read(id)).toMatchObject({ waiting_on_decision: false, settled: true, pending_request: null, last_message: 'Completed green' })
	expect((await restarted.list()).pending_requests).toEqual([])
})

test('new workers receive role instructions; caller text and continuation JSON stay verbatim', async () => {
	const task = '  Implement "Grüße"\n--project literal\n\t'
	for (const executor of ['runner', 'orb'] as const) {
		let dispatched = ''
		let current = transcript()
		const bridge = new SupervisionBridge(database(), async args => {
			if (args[1] === 'export') return JSON.stringify(current)
			dispatched = args[0] === 'threads' ? args[4]! : args[1]!
			current = transcript(dispatched)
			return url
		}, { id: 'mac-dev', directory: directory() })
		const spawned = await bridge.spawn(task, executor === 'orb' ? 'no-project' : undefined, executor)
		expect(dispatched.startsWith(`[supervision-request ${spawned.request_id}]\nYou are the implementation worker`)).toBeTrue()
		expect(dispatched.split('\n\nTask from the external supervisor:\n')).toHaveLength(2)
		expect(dispatched.split('\n\nTask from the external supervisor:\n')[1]).toBe(task)
		expect(dispatched).toContain('Do not create, continue, dispatch, or supervise another implementation thread')
		expect(dispatched).toContain('Worker role: supervised-implementation-worker-v3')
		expect(dispatched).toContain('unless the human operator explicitly requests implementation delegation for this specific task')
		expect(dispatched).toContain('report blocking decisions and completion in this original thread')
		expect(dispatched).toContain('The amp-supervision skill describes the external supervisor role; do not adopt that role.')
		expect(dispatched).toContain('Ordinary bounded waits for your own tools, tests, and required PR-review checks remain allowed.')
		expect(dispatched).toContain('request an explicit environment handoff instead of selecting another runner or Orb')
		expect(dispatched).toContain('Before resuming dependent work, append one line to docs/decisions.md')
		expect(dispatched).toContain('date, current task/thread, decision IDs, selections, rationale and constraints')
		expect(dispatched).toContain('If any decision is unanswered, ambiguous or outside that authority, stop and ask again')
		expect(dispatched).toContain('do not duplicate an already recorded decision')
		expect(dispatched).toContain('a supervisor response alone does not grant it')
		expect(dispatched).toContain('No issue tracker is required')
		const example = dispatched.match(/```json\n([^]*?)\n```/)![1]!
		expect(blockedEnvelope.parse(JSON.parse(example)).status).toBe('blocked')
		expect(bridge.db.query('SELECT digest FROM supervision_requests').get()).toEqual({ digest: createHash('sha256').update(dispatched).digest('hex') })
		await bridge.read(id)
		const formattedDecision = ` \n${JSON.stringify(JSON.parse(decision), null, 2)}\n`
		const sent = await bridge.send(id, formattedDecision)
		if (!('request_id' in sent)) throw new Error('Expected accepted continuation')
		expect(dispatched).toBe(`[supervision-request ${sent.request_id}]\n${formattedDecision}`)
		expect(bridge.db.query('SELECT digest FROM supervision_requests').get()).toEqual({ digest: createHash('sha256').update(dispatched).digest('hex') })
	}
})

test('ambiguous spawn recovery after restart requires the entire augmented prompt', async () => {
	const path = join(directory(), 'requests.sqlite')
	let dispatched = ''
	let exported = ''
	let attempts = 0
	const run = async (args: string[]) => {
		if (args[0] === '-ox') { attempts++; dispatched = args[1]!; throw new Error('lost URL') }
		return JSON.stringify(transcript(exported))
	}
	const bridge = new SupervisionBridge(database(path), run)
	await expect(bridge.spawn('Choose', 'no-project', 'orb')).rejects.toThrow('lost URL')
	const restarted = new SupervisionBridge(database(path), run)
	for (const mismatch of [dispatched.split('\n')[0] + '\nChoose', dispatched.replace('not the supervisor', 'also the supervisor')]) {
		exported = mismatch
		await restarted.read(id)
		expect(restarted.db.query('SELECT thread, pending FROM supervision_requests').get()).toEqual({ thread: null, pending: 1 })
		await expect(restarted.spawn('Again', 'no-project', 'orb')).rejects.toThrow('unknown acceptance')
	}
	exported = dispatched
	expect((await restarted.read(id)).waiting_on_decision).toBeTrue()
	expect(restarted.db.query('SELECT thread, pending FROM supervision_requests').get()).toEqual({ thread: id, pending: 0 })
	expect(attempts).toBe(1)
})

test('ambiguous spawn cannot duplicate and can recover by exact exported prompt', async () => {
	let prompt = ''
	const bridge = new SupervisionBridge(database(), async args => {
		if (args[0] === '-ox') { prompt = args[1]!; throw new Error('lost URL') }
		return JSON.stringify(transcript(prompt))
	})
	await expect(bridge.spawn('Choose', 'no-project', 'orb')).rejects.toThrow('lost URL')
	await expect(bridge.spawn('Choose again', 'no-project', 'orb')).rejects.toThrow('unknown acceptance')
	expect((await bridge.read(id)).waiting_on_decision).toBeTrue()
	expect(bridge.db.query('SELECT thread, pending FROM supervision_requests').get()).toEqual({ thread: id, pending: 0 })
})

test('runner dispatch uses only the configured ID and directory, and never falls back to an Orb', async () => {
	const root = realpathSync(directory())
	const calls: { args: string[]; cwd: string | undefined }[] = []
	let fail = true
	const bridge = new SupervisionBridge(database(), async (args, cwd) => {
		calls.push({ args, cwd })
		if (fail) throw new Error('offline or acceptance unknown')
		return url
	}, { id: 'mac-dev', directory: root })
	await expect(bridge.spawn('test', 'no-project', 'runner')).rejects.toThrow('omit project')
	expect(calls).toHaveLength(0)
	await expect(bridge.spawn('test', undefined, 'runner')).rejects.toThrow('acceptance unknown')
	await expect(bridge.spawn('retry', undefined, 'runner')).rejects.toThrow('unknown acceptance')
	expect(calls).toHaveLength(1)
	expect(calls[0]?.cwd).toBe(root)
	expect(calls[0]?.args[0]).toBe('-x')
	expect(calls[0]?.args.slice(2)).toEqual(['--executor', 'runner:mac-dev', '--visibility', 'private'])
	expect(calls[0]?.args).not.toContain('-ox')
	// A separate clean journal tests a confirmed dispatch, not a retry of the ambiguous request.
	fail = false
	const fresh = new SupervisionBridge(database(), bridge.run, bridge.runner)
	expect(await fresh.spawn('test', undefined, 'runner')).toMatchObject({
		executor: 'runner', runner_id: 'mac-dev', working_directory: root, thread_id: id, dispatch_status: 'accepted',
	})
	const orb = new SupervisionBridge(database(), bridge.run, bridge.runner)
	expect(await orb.spawn('test', 'no-project', 'orb')).toMatchObject({ executor: 'orb', runner_id: null, working_directory: null })
	expect(calls.at(-1)?.cwd).toBeUndefined()
	expect(calls.at(-1)?.args.slice(2)).toEqual(['--visibility', 'private'])
})

test('spawn forwards each optional mode for both executors and preserves omission', async () => {
	const root = realpathSync(directory())
	for (const executor of ['orb', 'runner'] as const) {
		for (const mode of [undefined, 'low', 'medium', 'high', 'ultra'] as const) {
			const calls: { args: string[]; cwd: string | undefined }[] = []
			const bridge = new SupervisionBridge(database(), async (args, cwd) => { calls.push({ args, cwd }); return url },
				{ id: 'mac-dev', directory: root })
			const result = await bridge.spawn('Choose', executor === 'orb' ? 'owner/repo' : undefined, executor, mode)
			expect(result.requested_mode).toBe(mode ?? null)
			expect(calls).toHaveLength(1)
			expect(calls[0]?.cwd).toBe(executor === 'runner' ? root : undefined)
			expect(calls[0]?.args[0]).toBe(executor === 'runner' ? '-x' : '-ox')
			expect(calls[0]?.args.slice(2)).toEqual([
				...(executor === 'runner' ? ['--executor', 'runner:mac-dev'] : []), '--visibility', 'private',
				...(executor === 'orb' ? ['--project', 'owner/repo'] : []), ...(mode ? ['--mode', mode] : []),
			])
		}
	}
})

test('invalid modes fail before dispatch or journal reservation for direct and MCP callers', async () => {
	let calls = 0
	const bridge = new SupervisionBridge(database(), async () => { calls++; return url })
	const server = createSupervisionServer(bridge)
	const client = new Client({ name: 'test', version: '1' })
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
	await server.connect(serverTransport); await client.connect(clientTransport)
	try {
		for (const mode of ['', 'custom-mode', '--executor runner:other', null]) {
			// @ts-expect-error Exercise untyped direct callers as well as MCP validation.
			await expect(bridge.spawn('Choose', 'no-project', 'orb', mode)).rejects.toThrow()
			expect((await client.callTool({ name: 'amp_spawn', arguments: { prompt: 'Choose', executor: 'orb', project: 'no-project', mode } })).isError).toBeTrue()
		}
		expect(calls).toBe(0)
		expect(bridge.db.query('SELECT * FROM supervision_requests').all()).toEqual([])
		const spawn = (await client.listTools()).tools.find(t => t.name === 'amp_spawn')!
		expect(spawn.inputSchema.properties?.mode).toMatchObject({ enum: ['low', 'medium', 'high', 'ultra'] })
		expect(spawn.inputSchema.required).not.toContain('mode')
	} finally { await client.close(); await server.close() }
})

test('MCP spawn forwards high mode to the configured runner', async () => {
	const calls: string[][] = []
	const bridge = new SupervisionBridge(database(), async args => { calls.push(args); return url }, { id: 'mac-dev', directory: directory() })
	const server = createSupervisionServer(bridge)
	const client = new Client({ name: 'test', version: '1' })
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
	await server.connect(serverTransport); await client.connect(clientTransport)
	try {
		const description = (await client.listTools()).tools.find(t => t.name === 'amp_spawn')!.description!
		expect(description).toContain(bridge.build.build_id)
		expect(description).toContain(bridge.build.worker_policy_id)
		expect((await client.callTool({ name: 'amp_spawn', arguments: { prompt: 'Choose', executor: 'runner', mode: 'high' } })).structuredContent)
			.toMatchObject({ requested_mode: 'high', executor: 'runner', dispatch_status: 'accepted',
				build_id: bridge.build.build_id, applied_worker_policy_id: bridge.build.worker_policy_id })
		expect(calls).toHaveLength(1)
		expect(calls[0]?.slice(2)).toEqual(['--executor', 'runner:mac-dev', '--visibility', 'private', '--mode', 'high'])
	} finally { await client.close(); await server.close() }
})

test('missing or invalid runner configuration fails before a mutation reservation', async () => {
	let called = false
	const bridge = new SupervisionBridge(database(), async () => { called = true; return url })
	await expect(bridge.spawn('test', undefined, 'runner')).rejects.toThrow('not configured')
	await expect(bridge.spawn('test', undefined, 'orb')).rejects.toThrow()
	// @ts-expect-error Untyped direct callers must also explicitly choose a target.
	await expect(bridge.spawn('test', 'no-project')).rejects.toThrow()
	expect(called).toBeFalse()
	expect(bridge.db.query('SELECT * FROM supervision_requests').all()).toEqual([])
	const root = directory()
	const file = join(root, 'file'); writeFileSync(file, '')
	for (const config of [{ id: '--orb', directory: root }, { id: 'mac', directory: 'relative' }, { id: 'mac', directory: file }])
		expect(() => new SupervisionBridge(database(), bridge.run, config)).toThrow()
})

test('definite process-start failures release spawn and restore send reservations', async () => {
	const root = directory()
	const denied = join(root, 'not-executable')
	writeFileSync(denied, '#!/bin/sh\nexit 0', { mode: 0o600 })
	for (const executable of [join(root, 'missing'), denied]) {
		const bridge = new SupervisionBridge(database(), args => args[1] === 'export'
			? Promise.resolve(JSON.stringify(transcript())) : runAmp(args, executable))
		for (let attempt = 0; attempt < 2; attempt++) {
			await expect(bridge.spawn('Choose', 'no-project', 'orb')).rejects.toBeInstanceOf(AmpNotStarted)
			expect(bridge.db.query('SELECT * FROM supervision_requests').all()).toEqual([])
			await expect(bridge.send(id, decision)).rejects.toBeInstanceOf(AmpNotStarted)
			expect(bridge.db.query('SELECT * FROM supervision_requests').all()).toEqual([])
		}
		bridge.db.query('INSERT INTO supervision_requests (key, thread, digest, pending) VALUES (?, ?, ?, 0)')
			.run('previous', id, createHash('sha256').update('Choose').digest('hex'))
		const previous = bridge.db.query('SELECT * FROM supervision_requests').get()
		await expect(bridge.send(id, decision)).rejects.toBeInstanceOf(AmpNotStarted)
		expect(bridge.db.query('SELECT * FROM supervision_requests').get()).toEqual(previous)
		const repaired = new SupervisionBridge(bridge.db, async args => args[1] === 'export' ? JSON.stringify(transcript()) : url)
		expect((await repaired.send(id, decision)).dispatch_status).toBe('accepted')
	}
})

test('acceptance resume rejects empty logs before connecting or dispatching', async () => {
	const root = directory()
	for (const contents of ['', ' \n\t\n']) {
		writeFileSync(join(root, 'events.jsonl'), contents)
		const child = Bun.spawn([process.execPath, 'compat/supervision-acceptance.ts', '--resume-before-decision', root],
			{ stdout: 'pipe', stderr: 'pipe', env: { HOME: root, PATH: '/usr/bin:/bin' } })
		const stderr = await new Response(child.stderr).text()
		expect(await child.exited).toBe(1)
		expect(stderr).toContain('No recorded spawn to resume')
		expect(stderr).not.toContain('JSON Parse error')
	}
})

test('acceptance resume rejects missing metadata, mismatched executors and lost send responses before connecting', async () => {
	const root = directory()
	const spawned = { event: 'spawn', data: { thread_id: id, executor: 'runner', working_directory: root, runner_id: 'fixture' } }
	const fixture = { event: 'fixture', data: { scratch: join(root, 'scratch') } }
	for (const [events, args, expected] of [
		[[spawned], [], 'Missing recorded fixture'],
		[[fixture, spawned], ['orb'], 'Executor does not match recorded spawn'],
		[[fixture, spawned], [], 'Runner configuration changed'],
		[[fixture, { event: 'spawn', data: { thread_id: id, executor: 'runner' } }], [], 'Invalid input: expected string, received undefined'],
		[[fixture, { event: 'spawn', data: { thread_id: id, executor: 'runner', working_directory: 'relative' } }], [], 'Expected absolute path'],
		[[fixture, spawned, { event: 'send_attempt', data: { thread_id: id } }], [], 'Decision dispatch already attempted'],
		[[{ event: 'spawn_attempt' }], [], 'No recorded spawn to resume'],
	] as const) {
		writeFileSync(join(root, 'events.jsonl'), events.map(event => JSON.stringify(event)).join('\n') + '\n')
		const child = Bun.spawn([process.execPath, 'compat/supervision-acceptance.ts', '--resume-before-decision', root, ...args],
			{ stdout: 'pipe', stderr: 'pipe', env: { HOME: root, PATH: '/usr/bin:/bin' } })
		const stderr = await new Response(child.stderr).text()
		expect(await child.exited).toBe(1)
		expect(stderr).toContain(expected)
	}
})

test('invalid decisions and running threads never dispatch; archived refusal returns only recovery command', async () => {
	let continued = 0
	let current = transcript()
	const bridge = new SupervisionBridge(database(), async args => {
		if (args[1] === 'export') return JSON.stringify(current)
		continued++; throw new ArchivedThread()
	})
	await expect(bridge.send(id, 'yes')).rejects.toThrow()
	await expect(bridge.send(id, JSON.stringify({ decision: 'green' }))).rejects.toThrow()
	current.meta.lastKnownAgentState.state = 'working'
	await expect(bridge.send(id, decision)).rejects.toThrow('cannot steer')
	expect(continued).toBe(0)
	current = transcript()
	expect(await bridge.send(id, decision)).toEqual({ thread_id: id, dispatch_status: 'refused', reason: 'archived', unarchive_command: `amp threads archive ${id} --unarchive` })
	expect(bridge.db.query('SELECT * FROM supervision_requests').all()).toEqual([])
})

test('ambiguous continuation and mismatched URL stay pending, never auto-resend', async () => {
	for (const output of [null, 'https://ampcode.com/threads/T-aaaaaaaa-2222-3333-4444-555555555555', 'not a URL']) {
		let attempts = 0
		const bridge = new SupervisionBridge(database(), async args => {
			if (args[1] === 'export') return JSON.stringify(transcript())
			attempts++
			if (output === null) throw new Error('timeout')
			return output
		})
		await expect(bridge.send(id, decision)).rejects.toThrow()
		await expect(bridge.send(id, decision)).rejects.toThrow('outstanding')
		expect((await bridge.read(id)).waiting_on_decision).toBeFalse()
		expect(attempts).toBe(1)
	}
})

test('invalid IDs and project flags never invoke CLI; discovery passes pagination explicitly', async () => {
	const calls: string[][] = []
	const bridge = new SupervisionBridge(database(), async args => { calls.push(args); return JSON.stringify([{ id }]) })
	await expect(bridge.read('--help')).rejects.toThrow()
	await expect(bridge.send(`${id};echo x`, decision)).rejects.toThrow()
	await expect(bridge.spawn('test', '--project evil/repo', 'orb')).rejects.toThrow()
	expect(calls).toHaveLength(0)
	expect((await bridge.list(1, 23, true)).next_offset).toBe(24)
	expect(calls[0]).toEqual(['threads', 'list', '--json', '--limit', '1', '--offset', '23', '--include-archived'])
})

test('MCP SDK tools list/call returns structured results and protocol errors', async () => {
	const bridge = new SupervisionBridge(database(), async () => JSON.stringify(transcript()))
	const server = createSupervisionServer(bridge)
	const client = new Client({ name: 'test', version: '1' })
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
	await server.connect(serverTransport); await client.connect(clientTransport)
	try {
		expect((await client.listTools()).tools.map(t => t.name).sort()).toEqual(['amp_list', 'amp_read', 'amp_send', 'amp_spawn'])
		expect((await client.callTool({ name: 'amp_read', arguments: { thread_id: id } })).structuredContent).toMatchObject({ waiting_on_decision: true, envelope })
		expect((await client.callTool({ name: 'amp_read', arguments: { thread_id: '--help' } })).isError).toBeTrue()
		// Legacy callers must choose an execution location, not silently get cloud files.
		expect((await client.callTool({ name: 'amp_spawn', arguments: { prompt: 'test', project: 'no-project' } })).isError).toBeTrue()
		expect(bridge.db.query('SELECT * FROM supervision_requests').all()).toEqual([])
	} finally { await client.close(); await server.close() }
})

test('process boundary preserves literal arguments, redacts failure output and enforces timeout', async () => {
	const path = join(directory(), 'amp Grüße with spaces')
	writeFileSync(path, `#!${process.execPath}
if (process.argv[2] === 'cwd') { console.log(process.cwd()); process.exit(0) }
if (process.argv[2] === 'fail') { console.error('PRIVATE_PROMPT_AND_TOKEN'); process.exit(1) }
if (process.argv[2] === 'sleep') { process.on('SIGTERM', () => {}); await Bun.sleep(60000) }
if (process.argv[2] === 'overflow') { await Bun.write(Bun.stdout, Buffer.alloc(17 * 1024 * 1024, 120)); await Bun.sleep(60000) }
console.log(JSON.stringify(process.argv.slice(2)))`, { mode: 0o700 })
	const input = ['$(touch /tmp/not-executed)', 'Grüße\n"quoted"; --help']
	expect(JSON.parse(await runAmp(input, path))).toEqual(input)
	const cwd = realpathSync(directory())
	expect((await runAmp(['cwd'], path, 120_000, cwd)).trim()).toBe(cwd)
	expect((await runAmp(['cwd'], path)).trim()).toBe(realpathSync(tmpdir()))
	await expect(runAmp(['fail'], path)).rejects.toThrow('acceptance may be unknown')
	const failure = await runAmp(['fail'], path).catch(error => error.message)
	expect(failure).not.toContain('PRIVATE_PROMPT_AND_TOKEN')
	await expect(runAmp(['overflow'], path)).rejects.toThrow('acceptance may be unknown')
	await expect(runAmp(['sleep'], path, 100)).rejects.toThrow('timed out')
})
