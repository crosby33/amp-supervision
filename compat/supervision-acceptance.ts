// Explicit live acceptance only; never part of bun test. Creates one private remote-executor thread.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { mkdirSync, readFileSync, appendFileSync, existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { resolve, join, isAbsolute } from 'node:path'
import { z } from 'zod'
import { blockedEnvelope } from '../src/supervision-mcp.ts'

const resume = process.argv[2] === '--resume-before-decision'
if ((!resume && process.argv[2] !== '--run-live') || !process.argv[3] || process.argv.length > 5) {
	throw new Error('Usage: bun compat/supervision-acceptance.ts --run-live|--resume-before-decision /path/to/new-private-evidence-directory [orb|runner]')
}
process.umask(0o077)
const directory = resolve(process.argv[3])
if (!resume) mkdirSync(directory, { mode: 0o700 }) // Never overwrite unresolved dispatch evidence.
const prior = resume ? readFileSync(join(directory, 'events.jsonl'), 'utf8').split('\n').filter(line => line.trim()).map(line => JSON.parse(line)) : []
if (prior.some(event => event.event === 'send_attempt' || event.event === 'send')) throw new Error('Decision dispatch already attempted; inspect the existing thread and journal instead of resending.')
if (resume && !prior.some(event => event.event === 'spawn' && event.data?.thread_id)) throw new Error('No recorded spawn to resume')
const recordedSpawn = prior.find(event => event.event === 'spawn')?.data
const executor = z.enum(['orb', 'runner']).parse(resume ? recordedSpawn.executor : process.argv[4] ?? 'runner')
if (resume && process.argv[4] !== undefined && process.argv[4] !== executor) throw new Error('Executor does not match recorded spawn')
const recordedFixture = prior.find(event => event.event === 'fixture')?.data
if (resume && !recordedFixture) throw new Error('Missing recorded fixture; do not guess its location')
const absolutePath = z.string().refine(isAbsolute, 'Expected absolute path')
const runnerDirectory = executor === 'runner'
	? absolutePath.parse(resume ? recordedSpawn.working_directory : process.env.AMP_SUPERVISION_RUNNER_DIR) : undefined
const scratch = resume ? absolutePath.parse(recordedFixture.scratch)
	: join(runnerDirectory ?? '/tmp', `supervision-scratch-${randomUUID()}`)
if (executor === 'runner' && !resume && existsSync(scratch)) throw new Error('Scratch directory already exists; do not overwrite it')
if (resume && executor === 'runner' && (process.env.AMP_SUPERVISION_RUNNER_DIR !== runnerDirectory
	|| process.env.AMP_SUPERVISION_RUNNER_ID !== recordedSpawn.runner_id)) throw new Error('Runner configuration changed; inspect the original thread before resuming')
const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
const transport = new StdioClientTransport({ command: process.execPath, args: [resolve(import.meta.dir, '../src/supervision-mcp.ts')],
	env: { ...env, AMP_SUPERVISION_STATE_DIR: directory }, stderr: 'inherit' })
const client = new Client({ name: 'supervision-acceptance', version: '1' })
const record = (event: string, data: unknown) => {
	const line = JSON.stringify({ at: new Date().toISOString(), event, data })
	appendFileSync(join(directory, 'events.jsonl'), line + '\n', { mode: 0o600, flush: true }); console.log(event)
}
async function call(name: string, args: Record<string, unknown>) {
	const started = Date.now()
	const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 150_000 })
	if (name === 'amp_read') record('read_timing', { milliseconds: Date.now() - started })
	if (result.isError) throw new Error(JSON.stringify(result.content))
	return z.record(z.string(), z.unknown()).parse(result.structuredContent)
}
async function wait(id: string, waiting: boolean) {
	const deadline = Date.now() + 5 * 60_000
	while (Date.now() < deadline) {
		const result = await call('amp_read', { thread_id: id })
		if (result.settled && result.waiting_on_decision === waiting) { record('read', result); return result }
		await Bun.sleep(5_000)
	}
	throw new Error('Bounded wait expired; inspect retained journal and thread. Do not repeat spawn/send.')
}
try {
	await client.connect(transport)
	record('tools', (await client.listTools()).tools.map(tool => tool.name))
	const prompt = `This is an explicitly authorized scratch acceptance probe, not product work.
Do this work yourself, without delegation or other threads. Do not push, open a PR, archive, deploy,
or contact external services (including Linear); this disposable scratch probe has no tracking issue.
Create a scratch git repo at ${JSON.stringify(scratch)} and a README.md there. Do not inspect or modify any other repository.
Then stop and ask for decision ID colour, with options blue and green, recommendation blue,
using exactly your injected worker contract's blocked envelope.
Do not write choice.txt until the supervisor replies. Once a decision arrives, append the required
single ADR line to docs/decisions.md BEFORE writing choice.txt with the selected colour and newline.
Read both files back and verify them. Finish with only JSON {"status":"completed","choice":"<colour>",
"adr":"<exact ADR line>","marker":"SUPERVISION_COMPLETE"}. Leave the files for independent inspection.`
	if (!resume) { record('fixture', { scratch }); record('spawn_attempt', { executor }) }
	const spawned = resume ? prior.find(event => event.event === 'spawn')?.data : await call('amp_spawn', {
		prompt, executor, ...(executor === 'orb' ? { project: 'no-project' } : {}),
	})
	if (!spawned?.thread_id) throw new Error('No recorded spawn to resume')
	if (!resume) record('spawn', spawned)
	const id = spawned.thread_id as string
	const blocked = await wait(id, true)
	const choices = blockedEnvelope.parse(blocked.envelope).decisions_needed
	if (choices.length !== 1 || choices[0]!.id !== 'colour' || choices[0]!.options.length !== 2
		|| !choices[0]!.options.includes('blue') || !choices[0]!.options.includes('green'))
		throw new Error('Unexpected decision; stop for human inspection rather than answering a different question')
	record('send_attempt', { thread_id: id }) // Persist intent BEFORE the side effect, including across timeouts/crashes.
	record('send', await call('amp_send', { thread_id: id, message: JSON.stringify({
		decision: 'colour: green', rationale: 'Exercise the non-recommended branch', constraints: [`Only modify ${scratch}; no external writes`],
	}) }))
	const result = await wait(id, false)
	const final = JSON.parse(result.last_message as string)
	if (final.status !== 'completed' || final.choice !== 'green' || final.marker !== 'SUPERVISION_COMPLETE' || !final.adr?.includes('green'))
		throw new Error('Unexpected completed result; inspect evidence')
	if (executor === 'runner') {
		if (readFileSync(join(scratch, 'choice.txt'), 'utf8') !== 'green\n'
			|| readFileSync(join(scratch, 'docs/decisions.md'), 'utf8') !== final.adr + '\n') throw new Error('Local files do not match completed response')
		record('local_files_verified', { directory: scratch })
	}
	record('protocol_complete', { thread_id: id, url: spawned.url, independent_file_and_full_history_inspection_required: true })
} finally { await client.close() }
