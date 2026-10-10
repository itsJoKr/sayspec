#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('claude 2.1.269'); process.exit(0); }
if (args[0] === 'auth') { console.log('{"loggedIn":true}'); process.exit(0); }
const match = args[0]?.match(/Read (sessions\/[^/]+)\/\.claude\/skills\/fix-managed-web-test\/SKILL\.md/);
if (!match || args.includes('--safe-mode')) process.exit(11);
const directory = match[1];
const relativePath = 'tests/ready.spec.ts';
const base = readFileSync(path.join(directory, 'base', relativePath), 'utf8');
const patched = base.replace("name: 'Old'", "name: 'Ready'");
if (patched === base) process.exit(12);
writeFileSync(path.join(directory, 'proposal.json'), JSON.stringify({ rationale: 'Update the heading selector to match the observed Ready heading.', changes: [{ relativePath, text: patched }] }));
console.log('DETERMINISTIC_MANAGED_TEST_PROPOSAL_STAGED');
setTimeout(() => process.exit(0), 4000);
