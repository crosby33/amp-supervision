import { afterEach, expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const roots: string[] = []
const root = () => { const path = realpathSync(mkdtempSync(join(tmpdir(), 'supervision portable Grüße '))); roots.push(path); return path }
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }) })
const bridgePath = resolve(import.meta.dir, '../src/supervision-mcp.ts')
const harnessPath = resolve(import.meta.dir, '../compat/supervision-acceptance.ts')
const id = 'T-11111111-2222-3333-4444-555555555555'

test.each([false, true])('real stdio startup works without credentials, with absolute journal override: %s', async (override) => {
	const home = root(), executable = join(home, 'fake amp'), calls = join(home, 'calls.jsonl')
	const journal = join(home, override ? 'shared journal' : '.local/state/amp-supervision')
	writeFileSync(executable, `#!${process.execPath}
import {appendFileSync} from 'node:fs';
appendFileSync(${JSON.stringify(calls)}, JSON.stringify({args:process.argv.slice(2),cwd:process.cwd()})+'\\n');
console.log(process.argv[2] === 'threads' ? '[]' : ${JSON.stringify(`https://ampcode.com/threads/${id}`)});
`, { mode: 0o700 })
	const client = new Client({ name: 'portable-test', version: '1' })
	const transport = new StdioClientTransport({ command: process.execPath, args: [bridgePath], env: {
		HOME: home, PATH: '/usr/bin:/bin', AMP_SUPERVISION_AMP_EXECUTABLE: executable,
		AMP_SUPERVISION_RUNNER_DIR: home, AMP_SUPERVISION_RUNNER_ID: 'fixture',
		...(override ? { AMP_SUPERVISION_STATE_DIR: journal } : {}),
	} })
	try {
		await client.connect(transport)
		expect((await client.listTools()).tools.map(t => t.name).sort()).toEqual(['amp_list', 'amp_read', 'amp_send', 'amp_spawn'])
		expect((await client.callTool({ name: 'amp_list', arguments: {} })).isError).not.toBeTrue()
		expect((await client.callTool({ name: 'amp_spawn', arguments: { prompt: 'Only a fake process runs', executor: 'runner' } })).structuredContent)
			.toMatchObject({ dispatch_status: 'accepted', runner_id: 'fixture', working_directory: home })
		const recorded = readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line))
		expect(recorded[0].args).toEqual(['threads', 'list', '--json', '--limit', '100', '--offset', '0'])
		expect(recorded[1].cwd).toBe(home)
		expect(recorded[1].args.slice(2)).toEqual(['--executor', 'runner:fixture', '--visibility', 'private'])
		expect(statSync(journal).mode & 0o777).toBe(0o700)
		expect(statSync(join(journal, 'requests.sqlite')).mode & 0o777).toBe(0o600)
	} finally { await client.close() }
})

test.each(['colour', 'account'])('acceptance with decision %s preserves mutation intent or refuses an unexpected question', async (decisionID) => {
	const home = root(), evidence = join(home, 'evidence'), executable = join(home, 'fake amp'), calls = join(home, 'calls.jsonl')
	const envelope = { status: 'blocked', summary: 'Choose colour', decisions_needed: [
		{ id: decisionID, question: 'Blue or green?', options: ['blue', 'green'], recommendation: 'blue', impact: 'Scratch only' },
	], changes: [], tests: [], next_action: 'Wait' }
	writeFileSync(executable, `#!${process.execPath}
import {appendFileSync,readFileSync,writeFileSync} from 'node:fs';
const args=process.argv.slice(2), home=${JSON.stringify(home)}, evidence=${JSON.stringify(evidence)};
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args)+'\\n');
if (args[0]==='-x') { writeFileSync(home+'/prompt', args[1]); console.log(${JSON.stringify(`https://ampcode.com/threads/${id}`)}); }
else if (args[1]==='export') console.log(JSON.stringify({id:${JSON.stringify(id)},meta:{lastKnownAgentState:{state:'idle',messageID:'final'}},messages:[
{role:'user',content:[{type:'text',text:readFileSync(home+'/prompt','utf8')}]},
{role:'assistant',protocolMessageID:'final',state:{type:'complete',stopReason:'end_turn'},content:[{type:'text',text:${JSON.stringify('```json\n' + JSON.stringify(envelope) + '\n```')}}]}]}));
else if (args[1]==='continue') {
  const events=readFileSync(evidence+'/events.jsonl','utf8');
  writeFileSync(home+'/intent-present', String(events.includes('send_attempt')));
  console.error('Simulated accepted send with lost response'); process.exit(1);
} else { process.exit(2); }
`, { mode: 0o700 })
	const env = { HOME: home, PATH: '/usr/bin:/bin', AMP_SUPERVISION_AMP_EXECUTABLE: executable,
		AMP_SUPERVISION_RUNNER_DIR: home, AMP_SUPERVISION_RUNNER_ID: 'fixture' }
	for (const action of ['--run-live', '--resume-before-decision']) {
		const child = Bun.spawn([process.execPath, harnessPath, action, evidence, 'runner'], { env, stdout: 'pipe', stderr: 'pipe' })
		const stderr = await new Response(child.stderr).text()
		expect(await child.exited).toBe(1)
		expect(stderr).toContain(decisionID === 'account' ? 'Unexpected decision'
			: action === '--run-live' ? 'acceptance may be unknown' : 'Decision dispatch already attempted')
	}
	if (decisionID === 'colour') expect(readFileSync(join(home, 'intent-present'), 'utf8')).toBe('true')
	else expect(readFileSync(join(evidence, 'events.jsonl'), 'utf8')).not.toContain('send_attempt')
	const commands: string[][] = readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line))
	expect(commands.filter(args => args[0] === '-x')).toHaveLength(1)
	expect(commands.filter(args => args[1] === 'continue')).toHaveLength(decisionID === 'colour' ? 1 : 0)
	expect(statSync(join(evidence, 'events.jsonl')).mode & 0o777).toBe(0o600)
})

test('relative executable override fails before creating the request journal', async () => {
	const home = root()
	const child = Bun.spawn([process.execPath, bridgePath], { env: {
		HOME: home, PATH: '/usr/bin:/bin', AMP_SUPERVISION_AMP_EXECUTABLE: './amp',
	}, stdout: 'pipe', stderr: 'pipe' })
	const stderr = await new Response(child.stderr).text()
	expect(await child.exited).toBe(1)
	expect(stderr).toContain('must be an absolute path')
	expect(() => statSync(join(home, '.local/state/amp-supervision'))).toThrow()
})

test.each(['journal', '.', ''])('relative or empty journal override %j fails before journal creation', async (directory) => {
	const home = root()
	const child = Bun.spawn([process.execPath, bridgePath], { cwd: home, env: {
		HOME: home, PATH: '/usr/bin:/bin', AMP_SUPERVISION_STATE_DIR: directory,
	}, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
	const stderr = await new Response(child.stderr).text()
	expect(await child.exited).toBe(1)
	expect(stderr).toContain('AMP_SUPERVISION_STATE_DIR must be an absolute path.')
	expect(() => statSync(join(home, 'journal'))).toThrow()
	expect(() => statSync(join(home, 'requests.sqlite'))).toThrow()
	expect(() => statSync(join(home, '.local/state/amp-supervision'))).toThrow()
})
