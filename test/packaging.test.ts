import { expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, lstatSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { unzipSync } from 'fflate'
import { buildSkill } from '../scripts/build-skill.ts'

const root = resolve(import.meta.dir, '..')

test('archive contains every skill resource byte-for-byte, plus its license and nothing else', () => {
	const source = resolve(root, 'skills/amp-supervision')
	const paths = readdirSync(source, { recursive: true }).map(String)
		.filter(path => lstatSync(resolve(source, path)).isFile()).sort()
	const archive = unzipSync(buildSkill())
	expect(Object.keys(archive).sort()).toEqual(['amp-supervision/LICENSE', ...paths.map(path => `amp-supervision/${path}`)].sort())
	for (const path of paths) expect(Buffer.from(archive[`amp-supervision/${path}`]!)).toEqual(readFileSync(resolve(source, path)))
	expect(Buffer.from(archive['amp-supervision/LICENSE']!)).toEqual(readFileSync(resolve(root, 'LICENSE')))
	// Adding a reference without packaging it, or silently omitting a linked reference, fails.
	for (const path of paths) {
		for (const match of readFileSync(resolve(source, path), 'utf8').matchAll(/\]\(([^)#]+)(?:#[^)]*)?\)/g)) {
			const link = match[1]!
			if (/^https?:/.test(link)) continue
			expect(lstatSync(resolve(source, dirname(path), link)).isFile()).toBeTrue()
		}
	}
})

test('candidate tree excludes personal paths, imported private identifiers, tokens and runtime evidence', () => {
	// Read tracked AND new files so this also protects a not-yet-committed extraction.
	const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean)
	const privateContent = /\/Users\/(?!example(?:\/|\b))[^/\s]+\/|https:\/\/github\.com\/hanscl\/|\b(?:LAB|INN|PRX)-\d+\b|\bT-01[0-9a-f-]{30,}\b|\bsgamp_[a-zA-Z0-9]{12,}|[a-zA-Z0-9._%+-]+@gmail\.com/
	for (const path of files) {
		expect(path).not.toMatch(/(?:^|\/)(?:requests\.sqlite|events\.jsonl|node_modules|\.env|\.amp-supervision)(?:$|[./])/)
		expect(lstatSync(resolve(root, path)).isSymbolicLink()).toBeFalse()
		expect(readFileSync(resolve(root, path), 'utf8'), path).not.toMatch(privateContent)
	}
})

test('setup JSON is parseable and launcher uses literal argv with valid POSIX syntax', () => {
	const setup = readFileSync(resolve(root, 'skills/amp-supervision/references/platform-setup.md'), 'utf8')
	const configs = [...setup.matchAll(/```json\n([\s\S]*?)\n```/g)].map(match => JSON.parse(match[1]!))
	expect(configs).toHaveLength(2)
	expect(configs[1].mcpServers['amp-supervision'].args).toEqual([
		'--distribution', 'Ubuntu', '--exec', '/bin/sh', '/home/example/.config/amp-supervision/launch.sh',
	])
	const launcher = setup.match(/```sh\n(#!\/bin\/sh[\s\S]*?)\n```/)![1]!
	expect(launcher).not.toContain('\r')
	execFileSync('/bin/sh', ['-n'], { input: launcher })
	expect(launcher).toContain('cd "$AMP_SUPERVISION_RUNNER_DIR"')
	expect(launcher).not.toContain('AMP_API_KEY=')
})
