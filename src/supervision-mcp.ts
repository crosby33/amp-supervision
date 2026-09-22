#!/usr/bin/env bun
// Standalone, operator-invoked supervision. No Devloop controller or coordinator authority.
import { Database } from 'bun:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const text = z.string().trim().min(1)
const threadID = z.string().regex(/^T-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i)
export const blockedEnvelope = z.strictObject({
	status: z.literal('blocked'), summary: text,
	decisions_needed: z.array(z.strictObject({
		id: text, question: text, options: z.array(text).min(2), recommendation: text, impact: text,
	})).min(1).refine(items => new Set(items.map(item => item.id)).size === items.length, 'Duplicate decision IDs'),
	changes: z.array(text), tests: z.array(text), next_action: text,
})
export const decisionEnvelope = z.strictObject({ decision: text, rationale: text, constraints: z.array(text) })
const messageSchema = z.object({
	role: z.string(), protocolMessageID: z.string().optional(),
	state: z.object({ type: z.string(), stopReason: z.string().optional() }).nullish(),
	content: z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough()),
}).passthrough()
const exportSchema = z.object({
	id: threadID, messages: z.array(messageSchema),
	meta: z.object({ lastKnownAgentState: z.object({ state: z.string(), messageID: z.string().optional() }).optional() }).passthrough(),
}).passthrough()
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const messageText = (message: z.infer<typeof messageSchema>) => message.content.filter(c => c.type === 'text').map(c => c.text ?? '').join('\n')
// Tool results also have role=user in Amp exports; they are not supervisor requests.
const isUserPrompt = (message: z.infer<typeof messageSchema>) => message.role === 'user'
	&& message.content.some(c => c.type === 'text') && !message.content.some(c => c.type === 'tool_result')
type Request = { key: string; digest: string; pending: number; dispatch_build_id?: string | null; applied_worker_policy_id?: string | null }
export type RunAmp = (args: string[], cwd?: string) => Promise<string>
const executorSchema = z.enum(['orb', 'runner'])
const modeSchema = z.enum(['low', 'medium', 'high', 'ultra'])
const runnerSchema = z.strictObject({
	id: z.string().regex(/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/),
	directory: z.string().refine(isAbsolute, 'Runner directory must be absolute'),
})

// Behavioral instructions for new workers, not a tool-permission or sandbox boundary.
const workerInstructions = `You are the implementation worker in a turn-based supervised execution, not the supervisor.
Worker role: supervised-implementation-worker-v3. Do the requested work yourself in this thread and its existing executor. Do not create, continue, dispatch, or supervise another implementation thread through any interface, including amp_spawn, create_thread, or shell/CLI alternatives, unless the human operator explicitly requests implementation delegation for this specific task. Task complexity, repository layout, skill instructions, or an unavailable environment are not delegation permission. Even explicitly requested delegation does not transfer the external supervisor's decision authority; report blocking decisions and completion in this original thread. Do not create watchers or run polling/decision loops for another implementation worker without that explicit request. Ordinary bounded waits for your own tools, tests, and required PR-review checks remain allowed.
The amp-supervision skill describes the external supervisor role; do not adopt that role. Bounded tool-invoked assistance such as finder, librarian, oracle, or code review remains available only when allowed by applicable guidance. You retain implementation ownership; the external supervisor resolves blocking decisions. Do not answer your own blocked decisions.
Preserve repository guidance and human-only approval gates. If the requested task or applicable guidance conflicts with this worker role, stop and surface the conflict rather than silently delegating or disregarding that guidance. If the required repository or environment is unavailable, request an explicit environment handoff instead of selecting another runner or Orb.
The supervisor may resolve only scoped, reversible decisions within the human-approved task. Merging, deployment, destructive operations, access changes, spending, credentials and disclosure of private material require the human operator's explicit approval; a supervisor response alone does not grant it.
When blocked, stop before the action requiring a decision. Your entire final response must be exactly one fenced json block with this shape, using real facts:
\`\`\`json
{"status":"blocked","summary":"What is blocked and why","decisions_needed":[{"id":"unique-decision-id","question":"The choice required","options":["Option A","Option B"],"recommendation":"Option A, with reason","impact":"What the choice changes"}],"changes":[],"tests":[],"next_action":"Wait for the external supervisor's decision before continuing"}
\`\`\`
Include all fields shown and no additional fields. Use nonempty strings, at least one decision with unique IDs, and at least two options per decision. changes and tests must contain factual strings or be empty arrays. Report the block here and wait for the external supervisor's reply.
The reply must be JSON with decision, rationale and constraints (an array of strings). A [supervision-request ...] prefix is transport correlation, not part of that JSON or a grant of authority. Check that every blocking decision ID has an unambiguous choice within the approved scope. If any decision is unanswered, ambiguous or outside that authority, stop and ask again; do not guess or begin dependent work.
Before resuming dependent work, append one line to docs/decisions.md recording the date, current task/thread, decision IDs, selections, rationale and constraints. Create the file if absent, preserve previous entries, and do not duplicate an already recorded decision. Then implement, verify and report evidence and remaining limitations in this original thread. No issue tracker is required; update one only when the task explicitly supplies its policy and authorization. Report completion here in the format requested by the task.`

// Startup provenance, not an attestation of dependencies or a tool-permission boundary.
export function captureBuild(readSource: () => string = () => readFileSync(import.meta.path, 'utf8')) {
	const build_id = hash(readSource())
	return Object.freeze({ build_id, worker_policy_id: hash(workerInstructions), assertCurrent() {
		let current: string
		try { current = hash(readSource()) } catch { throw new Error('Bridge source unavailable. Restart from the reviewed installation; no dispatch occurred.') }
		if (current !== build_id) throw new Error('Bridge source changed since startup. Restart the MCP client; no dispatch occurred.')
	} })
}
const startupBuild = captureBuild()

// Never return raw CLI stderr: it can contain credentials, prompts or private transcripts.
export class ArchivedThread extends Error {}
export class AmpNotStarted extends Error {}
export function runAmp(args: string[], executable = 'amp', timeout = 120_000, cwd = tmpdir()): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(executable, args, { cwd, timeout, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024, encoding: 'utf8',
			env: { ...process.env, AMP_SKIP_UPDATE_CHECK: '1' } }, (error, stdout, stderr) => {
			if (!error) return resolve(stdout)
			if (error.code === 'ENOENT' || error.code === 'EACCES')
				return reject(new AmpNotStarted('Amp executable could not start. Check installation, PATH and executable permissions. No dispatch occurred.'))
			if (/^Error: This thread is archived\s*$/m.test(stderr)) return reject(new ArchivedThread('Thread is archived'))
			reject(new Error('Amp CLI failed or timed out; dispatch acceptance may be unknown. Do not retry a mutation; inspect amp_list and amp_read.'))
		}).stdin?.end()
	})
}

export function inspectExport(raw: unknown, id: string, request?: Request) {
	const data = exportSchema.parse(raw)
	if (data.id !== id) throw new Error('Export thread identity mismatch')
	const last = data.messages.at(-1)
	const user = [...data.messages].reverse().find(isUserPrompt)
	const state = data.meta.lastKnownAgentState
	const final = last?.role === 'assistant' && last.state?.type === 'complete' && last.state.stopReason === 'end_turn'
	// State and message identities must agree. Unknown future export shapes never mean waiting.
	const settled = Boolean(final && user && state?.state === 'idle' && last.protocolMessageID && state.messageID === last.protocolMessageID
		&& (!request || hash(messageText(user)) === request.digest))
	const lastMessage = last ? messageText(last) : null
	let envelope: z.infer<typeof blockedEnvelope> | undefined
	const fenced = settled && lastMessage?.trim().match(/^```json\s*\n([\s\S]*?)\n```$/)
	if (fenced) {
		try { envelope = blockedEnvelope.parse(JSON.parse(fenced[1]!)) } catch { /* malformed is not waiting */ }
	}
	return {
		last_message: lastMessage, agent_state: state?.state ?? 'unknown',
		message_id: last?.protocolMessageID ?? null, waiting_on_decision: Boolean(envelope),
		settled, pending_request: request && !settled ? request.key : null,
		...(envelope ? { envelope } : {}),
	}
}

export class SupervisionBridge {
	readonly runner: z.infer<typeof runnerSchema> | undefined
	constructor(readonly db: Database, readonly run: RunAmp = (args, cwd) => runAmp(args, 'amp', 120_000, cwd), runner?: z.infer<typeof runnerSchema>, readonly build = startupBuild) {
		if (runner) {
			runnerSchema.parse(runner)
			const directory = realpathSync(runner.directory)
			if (!statSync(directory).isDirectory()) throw new Error('Runner directory is not a directory')
			this.runner = { ...runner, directory }
		}
		db.exec(`PRAGMA busy_timeout = 5000;
			CREATE TABLE IF NOT EXISTS supervision_requests (
				key TEXT PRIMARY KEY, thread TEXT UNIQUE, digest TEXT NOT NULL, pending INTEGER NOT NULL
			)`)
		db.transaction(() => {
			const columns = new Set(db.query<{ name: string }, []>('PRAGMA table_info(supervision_requests)').all().map(c => c.name))
			for (const column of ['dispatch_build_id', 'applied_worker_policy_id']) {
				if (!columns.has(column)) db.exec(`ALTER TABLE supervision_requests ADD COLUMN ${column} TEXT`)
			}
		}).immediate()
	}
	private request(id: string): Request | undefined {
		return this.db.query<Request, [string]>('SELECT key, digest, pending, dispatch_build_id, applied_worker_policy_id FROM supervision_requests WHERE thread = ?').get(id) ?? undefined
	}
	private async snapshot(id: string, request?: Request) {
		return inspectExport(JSON.parse(await this.run(['threads', 'export', id])), id, request)
	}
	async read(id: string) {
		threadID.parse(id)
		const data = exportSchema.parse(JSON.parse(await this.run(['threads', 'export', id])))
		if (data.id !== id) throw new Error('Export thread identity mismatch')
		// Recover a spawn whose URL was lost without creating a second thread.
		const user = [...data.messages].reverse().find(isUserPrompt)
		if (user && !this.request(id)) this.db.query('UPDATE supervision_requests SET thread = ? WHERE thread IS NULL AND digest = ?')
			.run(id, hash(messageText(user)))
		const request = this.request(id)
		const result = inspectExport(data, id, request)
		if (request && result.settled) this.db.query('UPDATE supervision_requests SET pending = 0 WHERE key = ?').run(request.key)
		return { ...result, build_id: this.build.build_id, worker_policy_id: this.build.worker_policy_id,
			dispatch_build_id: request?.dispatch_build_id ?? null, applied_worker_policy_id: request?.applied_worker_policy_id ?? null }
	}
	async list(limit = 100, offset = 0, includeArchived = false) {
		z.number().int().min(1).max(500).parse(limit)
		z.number().int().min(0).parse(offset)
		const threads = z.array(z.object({ id: threadID }).passthrough()).parse(JSON.parse(await this.run([
			'threads', 'list', '--json', '--limit', String(limit), '--offset', String(offset), ...(includeArchived ? ['--include-archived'] : []),
		])))
		return { threads, next_offset: threads.length === limit ? offset + limit : null,
			build_id: this.build.build_id, worker_policy_id: this.build.worker_policy_id,
			pending_requests: this.db.query('SELECT key AS request_id, thread AS thread_id, dispatch_build_id, applied_worker_policy_id FROM supervision_requests WHERE pending = 1').all() }
	}
	private wire(message: string) {
		const key = randomUUID()
		const prompt = `[supervision-request ${key}]\n${message}`
		return { key, prompt, digest: hash(prompt), pending: 1 }
	}
	private result(output: string, expectedID?: string) {
		const match = output.trim().match(/^https:\/\/ampcode\.com\/threads\/(T-[0-9a-f-]+)$/i)
		const id = threadID.parse(match?.[1])
		if (expectedID && expectedID !== id) throw new Error('Dispatch returned a different thread; acceptance unknown. Do not retry.')
		return { thread_id: id, url: `https://ampcode.com/threads/${id}`, dispatch_status: 'accepted' }
	}
	async spawn(prompt: string, project: string | undefined, executor: 'orb' | 'runner', mode?: z.infer<typeof modeSchema>) {
		this.build.assertCurrent()
		z.string().min(1).max(100_000).parse(prompt)
		executorSchema.parse(executor)
		modeSchema.optional().parse(mode)
		const modeArgs = mode === undefined ? [] : ['--mode', mode]
		if (executor === 'orb') z.string().regex(/^(?:no-project|[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+)$/).parse(project)
		else {
			if (!this.runner) throw new Error('Runner execution is not configured. No dispatch occurred.')
			if (project !== undefined) throw new Error('Runner execution uses its configured directory; omit project.')
		}
		const runner = executor === 'runner' ? this.runner! : undefined
		const request = this.wire(`${workerInstructions}\n\nTask from the external supervisor:\n${prompt}`)
		this.db.transaction(() => {
			if (this.db.query('SELECT key FROM supervision_requests WHERE thread IS NULL').get())
				throw new Error('A spawn has unknown acceptance. Find its thread with amp_list and reconcile with amp_read before spawning again.')
			this.db.query('INSERT INTO supervision_requests (key, digest, pending, dispatch_build_id, applied_worker_policy_id) VALUES (?, ?, 1, ?, ?)')
				.run(request.key, request.digest, this.build.build_id, this.build.worker_policy_id)
		}).immediate()
		// Both remote executors return immediately without streaming or auto-archiving.
		// Never combine -ox (forces an Orb) with a runner target.
		let output: string
		try {
			output = runner
				? await this.run(['-x', request.prompt, '--executor', `runner:${runner.id}`, '--visibility', 'private', ...modeArgs], runner.directory)
				: await this.run(['-ox', request.prompt, '--visibility', 'private', ...(project === 'no-project' ? [] : ['--project', project!]), ...modeArgs])
		} catch (error) {
			if (error instanceof AmpNotStarted) this.db.query('DELETE FROM supervision_requests WHERE key = ?').run(request.key)
			throw error
		}
		const result = this.result(output)
		this.db.query('UPDATE supervision_requests SET thread = ? WHERE key = ?').run(result.thread_id, request.key)
		return { ...result, request_id: request.key, executor, runner_id: runner?.id ?? null, working_directory: runner?.directory ?? null, requested_mode: mode ?? null,
			build_id: this.build.build_id, worker_policy_id: this.build.worker_policy_id,
			dispatch_build_id: this.build.build_id, applied_worker_policy_id: this.build.worker_policy_id }
	}
	async send(id: string, message: string) {
		this.build.assertCurrent()
		threadID.parse(id)
		z.string().min(1).max(100_000).parse(message)
		const request = this.wire(message)
		// Reserve before any await. SQLite also serializes competing local MCP processes.
		const previous = this.db.transaction(() => {
			const previous = this.request(id)
			if (previous?.pending) throw new Error('A request is still outstanding. Read its response before sending; never blindly retry.')
			this.db.query(`INSERT INTO supervision_requests (key, thread, digest, pending, dispatch_build_id, applied_worker_policy_id) VALUES (?, ?, ?, 1, ?, NULL)
				ON CONFLICT(thread) DO UPDATE SET key=excluded.key, digest=excluded.digest, pending=1,
				dispatch_build_id=excluded.dispatch_build_id, applied_worker_policy_id=NULL`).run(request.key, id, request.digest, this.build.build_id)
			return previous
		}).immediate()
		const restore = () => this.db.transaction(() => {
			this.db.query('DELETE FROM supervision_requests WHERE key = ?').run(request.key)
			if (previous) this.db.query('INSERT INTO supervision_requests (key, thread, digest, pending, dispatch_build_id, applied_worker_policy_id) VALUES (?, ?, ?, ?, ?, ?)')
				.run(previous.key, id, previous.digest, previous.pending, previous.dispatch_build_id ?? null, previous.applied_worker_policy_id ?? null)
		}).immediate()
		try {
			const before = await this.snapshot(id, previous)
			if (!before.settled) throw new Error('Thread is not observed idle with a current final response. This bridge cannot steer a running turn.')
			if (before.waiting_on_decision) decisionEnvelope.parse(JSON.parse(message))
			this.build.assertCurrent() // Export awaited: source may have changed before dispatch.
		} catch (error) { restore(); throw error }
		try {
			// The CLI is the authoritative archived-thread guard, including archive races.
			return { ...this.result(await this.run(['threads', 'continue', id, '-ox', request.prompt]), id), request_id: request.key,
				build_id: this.build.build_id, worker_policy_id: this.build.worker_policy_id,
				dispatch_build_id: this.build.build_id, applied_worker_policy_id: null }
		} catch (error) {
			if (error instanceof AmpNotStarted) { restore(); throw error }
			if (error instanceof ArchivedThread) {
				restore()
				return { thread_id: id, dispatch_status: 'refused', reason: 'archived', unarchive_command: `amp threads archive ${id} --unarchive` }
			}
			throw error // Keep pending even across restart; failure does not prove non-delivery.
		}
	}
}

export function createSupervisionServer(bridge: SupervisionBridge) {
	const server = new McpServer({ name: 'amp-supervision', version: '0.1.0' })
	const reply = async (call: () => Promise<object>) => {
		try {
			const result = await call()
			return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: result as Record<string, unknown> }
		} catch (error) {
			// Zod errors can include input values; expose neither them nor child output.
			const message = error instanceof z.ZodError || error instanceof SyntaxError ? 'Invalid input or unsupported CLI output schema.'
				: error instanceof Error ? error.message : 'Supervision operation failed.'
			return { isError: true, content: [{ type: 'text' as const, text: message }] }
		}
	}
	server.registerTool('amp_spawn', {
		description: `Start a private implementation worker, not another supervisor. Build: ${bridge.build.build_id}; worker policy: ${bridge.build.worker_policy_id}. For orb, supply project namespace/name or no-project; paths stay in the cloud. For runner, omit project. ${bridge.runner ? `Configured runner: ${bridge.runner.id}, directory: ${bridge.runner.directory}. Runs with the runner account permissions, not a filesystem sandbox.` : 'Runner execution is not configured.'} Accepted is not completed. Never retry an ambiguous dispatch.`,
		inputSchema: { prompt: z.string().min(1).max(100_000), executor: executorSchema, project: text.optional(),
			mode: modeSchema.optional().describe('Optional built-in agent mode. Omit to preserve the CLI default. requested_mode echoes the request, not observed execution.') },
	}, ({ prompt, project, executor, mode }) => reply(() => bridge.spawn(prompt, project, executor, mode)))
	server.registerTool('amp_send', {
		description: 'Send to an observed idle thread. For a blocked envelope, message must be JSON {decision,rationale,constraints:[]}. No steering, cancellation or automatic unarchive.',
		inputSchema: { thread_id: threadID, message: z.string().min(1).max(100_000) },
	}, ({ thread_id, message }) => reply(() => bridge.send(thread_id, message)))
	server.registerTool('amp_read', {
		description: 'Read a thread snapshot. Waiting requires a current, completed fenced blocked envelope. Snapshot is not proof that no external send is queued.',
		inputSchema: { thread_id: threadID },
	}, ({ thread_id }) => reply(() => bridge.read(thread_id)))
	server.registerTool('amp_list', {
		description: 'Discover threads (paginated) and local outstanding requests; list has no reliable agent status.',
		inputSchema: { limit: z.number().int().min(1).max(500).default(100), offset: z.number().int().min(0).default(0), include_archived: z.boolean().default(false) },
	}, ({ limit, offset, include_archived }) => reply(() => bridge.list(limit, offset, include_archived)))
	return server
}

if (import.meta.main) {
	if (process.platform === 'win32') throw new Error('Native Windows is not supported. Run the bridge and Amp inside WSL2.')
	if (process.env.AMP_API_KEY && !process.env.AMP_API_KEY.startsWith('sgamp_')) throw new Error('AMP_API_KEY must be an Amp settings access token (sgamp_).')
	const executable = process.env.AMP_SUPERVISION_AMP_EXECUTABLE ?? 'amp'
	if (executable !== 'amp' && !isAbsolute(executable)) throw new Error('AMP_SUPERVISION_AMP_EXECUTABLE must be an absolute path.')
	process.umask(0o077)
	const directory = process.env.AMP_SUPERVISION_STATE_DIR ?? join(homedir(), '.local/state/amp-supervision')
	mkdirSync(directory, { recursive: true, mode: 0o700 })
	const path = join(directory, 'requests.sqlite')
	const db = new Database(path)
	chmodSync(path, 0o600)
	const { AMP_SUPERVISION_RUNNER_ID: id, AMP_SUPERVISION_RUNNER_DIR: runnerDirectory } = process.env
	const runner = id !== undefined || runnerDirectory !== undefined ? runnerSchema.parse({ id, directory: runnerDirectory }) : undefined
	await createSupervisionServer(new SupervisionBridge(db, (args, cwd) => runAmp(args, executable, 120_000, cwd), runner)).connect(new StdioServerTransport())
}
