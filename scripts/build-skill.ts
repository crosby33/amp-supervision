import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { zipSync } from 'fflate'

// Explicit package contents: never zip the checkout, private evidence or installed dependencies.
const files = [
	'SKILL.md',
	'references/platform-setup.md',
	'references/protocol.md',
	'references/task-template.md',
	'references/acceptance-test.md',
]

export function buildSkill(): Uint8Array {
	const entries: Record<string, Uint8Array> = {}
	for (const file of files) entries[`amp-supervision/${file}`] = readFileSync(resolve(import.meta.dir, '../skills/amp-supervision', file))
	entries['amp-supervision/LICENSE'] = readFileSync(resolve(import.meta.dir, '../LICENSE'))
	return zipSync(entries, { level: 9, mtime: new Date(1980, 0, 1) })
}

if (import.meta.main) {
	const directory = resolve(import.meta.dir, '../dist')
	mkdirSync(directory, { recursive: true })
	writeFileSync(resolve(directory, 'amp-supervision.skill'), buildSkill())
	console.log('Built dist/amp-supervision.skill from maintained source and references.')
}
